import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import {
  buildMiMoBatches,
  decodeMiMoAudio,
  getMiMoConfig,
  setMiMoConfig,
  MiMoSpeechService,
  MiMoAudioCache,
  getMiMoDurationScale,
  recordMiMoDurationScale,
} from '@/services/tts/mimo';
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
const wav = (seconds = 1) => {
  const bytes = new Uint8Array(44 + seconds * 48000);
  const v = new DataView(bytes.buffer);
  const tag = (s: string, offset: number) =>
    [...s].forEach((c, i) => (bytes[offset + i] = c.charCodeAt(0)));
  tag('RIFF', 0);
  v.setUint32(4, bytes.length - 8, true);
  tag('WAVE', 8);
  tag('fmt ', 12);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true);
  v.setUint32(28, 48000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag('data', 36);
  v.setUint32(40, bytes.length - 44, true);
  return bytes;
};
const encoded = (seconds = 1) =>
  btoa(Array.from(wav(seconds), (n) => String.fromCharCode(n)).join(''));
const payload = () => ({
  choices: [{ message: { audio: { data: encoded() } } }],
  usage: { prompt_tokens: 233, completion_tokens: 190 },
});
const success = () => new Response(JSON.stringify(payload()));
const config = () => ({ ...getMiMoConfig(), enabled: true, apiKey: 'test-key' });
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(nativeFetch).mockReset();
});
afterEach(() => vi.useRealTimers());
describe('MiMo speech generation', () => {
  it('uses MiMo defaults without reusing a stored Google API key', () => {
    localStorage.setItem(
      'readest-gemini-tts',
      JSON.stringify({ enabled: true, apiKey: 'google-key' }),
    );
    expect(getMiMoConfig()).toMatchObject({
      enabled: false,
      apiKey: '',
      model: 'mimo-v2.5-tts',
      voice: '茉莉',
      batchMinutes: 0.5,
    });
  });
  it('decodes the exact MiMo chat completion audio envelope', () => {
    const audio = decodeMiMoAudio(payload());
    expect(audio.duration).toBe(1);
    expect(audio.blob.type).toBe('audio/wav');
    expect(audio.blob.size).toBe(48044);
    expect(() => decodeMiMoAudio({ choices: [{ message: { content: 'no audio' } }] })).toThrow(
      /no audio/,
    );
    expect(() =>
      decodeMiMoAudio({ choices: [{ message: { audio: { data: btoa('bad') } } }] }),
    ).toThrow(/invalid WAV/);
  });
  it('rejects a truncated WAV rather than caching corrupt audio', () => {
    const bytes = wav().subarray(0, 100);
    expect(() =>
      decodeMiMoAudio({
        choices: [
          {
            message: {
              audio: { data: btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join('')) },
            },
          },
        ],
      }),
    ).toThrow(/truncated/);
  });
  it('sends the locally verified request contract through native HTTP on Android', async () => {
    vi.mocked(nativeFetch).mockResolvedValue(success());
    const service = new MiMoSpeechService(undefined, null);
    await service.generate('测试：一二三四五六七八九十。', config());
    expect(nativeFetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(nativeFetch).mock.calls[0]!;
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model: 'mimo-v2.5-tts',
      audio: { voice: '茉莉', format: 'wav' },
      stream: false,
    });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: '测试：一二三四五六七八九十。',
    });
    expect(body.messages[0].role).toBe('user');
    expect(init?.body).not.toContain('test-key');
    expect(body).not.toHaveProperty('input');
    expect(body).not.toHaveProperty('generation_config');
  });
  it('deduplicates concurrent playback and lookahead and replays cached audio', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
    const service = new MiMoSpeechService(fetcher, null);
    const first = service.generate('相同文本', config());
    const second = service.generate('相同文本', config(), { preload: true });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    finish(success());
    expect(await second).toBe(await first);
    await service.generate('相同文本', config());
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('has no ten-request daily budget or three-per-minute throttle', async () => {
    const fetcher = vi.fn().mockImplementation(async () => success());
    const service = new MiMoSpeechService(fetcher, null);
    for (let i = 0; i < 12; i++) await service.generate(`文本${i}`, config());
    expect(fetcher).toHaveBeenCalledTimes(12);
  });
  it.each([
    400, 401, 403, 429, 500,
  ])('shows the upstream reason for HTTP %s, redacts keys, and permits a fresh user retry', async (status) => {
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ error: { message: 'Invalid parameter: test-key sk-secret-other' } }),
            { status },
          ),
      );
    const service = new MiMoSpeechService(fetcher, null);
    const first = service.generate('错误文本', config());
    await expect(first).rejects.toThrow(
      `MiMo TTS (${status}): Invalid parameter: [redacted] [redacted]`,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(service.generate('错误文本', config())).rejects.toThrow('Invalid parameter');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps status information when the error response is not JSON', async () => {
    const service = new MiMoSpeechService(
      vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 })),
      null,
    );
    await expect(service.generate('测试', config())).rejects.toThrow(/MiMo TTS \(502\)/);
  });
  it('cancels queued requests when reading stops without cancelling an already sent recording', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
    const service = new MiMoSpeechService(fetcher, null);
    const first = service.generate('第一段', config());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const abort = new AbortController();
    const second = service.generate('第二段', config(), { signal: abort.signal });
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    finish(success());
    await first;
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
    await service.generate('第一段', config());
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses a bounded native HTTP timeout and unlocks subsequent user retries', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const service = new MiMoSpeechService(fetcher, null);
    const pending = service.generate('等待', config());
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(180001);
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses disk cache before waiting for a different pending recording', async () => {
    const cache = { get: vi.fn(async () => null), put: vi.fn() } as unknown as MiMoAudioCache;
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
    const service = new MiMoSpeechService(fetcher, cache);
    void service.generate('正在生成', config());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    vi.mocked(cache.get).mockResolvedValue({ blob: new Blob(['cached']), duration: 5 });
    expect((await service.generate('已缓存', config())).duration).toBe(5);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('retains request deduplication while clearing the recording cache', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
    const service = new MiMoSpeechService(fetcher, null);
    const first = service.generate('测试', config());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await service.clearCache();
    const second = service.generate('测试', config());
    finish(success());
    await first;
    await second;
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('keeps batching near thirty seconds and adapts to measured voice pace', () => {
    const sentences = Array.from({ length: 20 }, () => ({ text: '山'.repeat(45), lang: 'zh' }));
    expect(buildMiMoBatches(sentences, 0.5)[0]!.sentences).toHaveLength(3);
    recordMiMoDurationScale(config(), 'zh', 60, 30);
    expect(getMiMoDurationScale(config(), 'zh')).toBe(2);
    expect(buildMiMoBatches(sentences, 0.5, 2)[0]!.sentences).toHaveLength(1);
    expect(getMiMoDurationScale({ ...config(), voice: '冰糖' }, 'zh')).toBe(1);
    expect(getMiMoDurationScale(config(), 'en')).toBe(1);
  });
  it('clamps batch duration to supported short ranges and sanitizes pasted punctuation', () => {
    setMiMoConfig({ ...config(), apiKey: ' test-key。 ', batchMinutes: 20 });
    expect(getMiMoConfig()).toMatchObject({ apiKey: 'test-key', batchMinutes: 2 });
  });
});
