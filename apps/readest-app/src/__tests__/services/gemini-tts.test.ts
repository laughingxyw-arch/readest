import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGeminiBatches,
  decodeGeminiAudio,
  getGeminiConfig,
  setGeminiConfig,
  GeminiSpeechService,
  GeminiAudioCache,
  getGeminiUsage,
  grantGeminiReserveRequest,
  getGeminiDurationScale,
  recordGeminiDurationScale,
} from '@/services/tts/gemini';

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

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Gemini long-form TTS', () => {
  it('plays a legacy cached recording immediately while another recording is still generating', async () => {
    const { md5 } = await import('js-md5');
    const config = { ...getGeminiConfig(), apiKey: 'legacy-key' };
    const text = 'Previously generated text';
    const key = md5(
      JSON.stringify([
        config.model,
        config.voice,
        'Read naturally at a normal audiobook pace. Use the language of the supplied text.',
        text,
      ]),
    );
    const cached = { blob: new Blob(['cached']), duration: 480 };
    const cache = {
      get: vi.fn(async (lookup: string) => (lookup === key ? cached : null)),
      put: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
    } as unknown as GeminiAudioCache;
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const service = new GeminiSpeechService(fetcher, cache);
    const pending = service.generate('New recording', config);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await expect(service.generate(text, config)).resolves.toBe(cached);
    expect(getGeminiUsage(config)).toBe(1);
    const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
    finish(
      new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] })),
    );
    await pending;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps two requests reserved until the reader explicitly releases one', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
      const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
      const fetcher = vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] }),
            ),
        );
      const service = new GeminiSpeechService(fetcher, null);
      const config = { ...getGeminiConfig(), apiKey: 'quota-key' };
      for (let i = 0; i < 8; i++) {
        await service.generate(`Recording ${i}`, config);
        vi.setSystemTime(Date.now() + 61000);
      }
      await expect(service.generate('Reserve recording', config)).rejects.toThrow(/reserve/);
      expect(getGeminiUsage(config)).toBe(8);
      expect(grantGeminiReserveRequest(config)).toBe(true);
      await expect(service.generate('Reserve recording', config)).resolves.toHaveProperty(
        'duration',
        1,
      );
      await expect(service.generate('Last reserve recording', config)).rejects.toThrow(/reserve/);
      expect(grantGeminiReserveRequest(config)).toBe(true);
      vi.setSystemTime(Date.now() + 61000);
      await service.generate('Last reserve recording', config);
      expect(grantGeminiReserveRequest(config)).toBe(false);
      expect(getGeminiUsage(config)).toBe(10);
      expect(fetcher).toHaveBeenCalledTimes(10);
      await expect(service.generate('Last reserve recording', config)).resolves.toHaveProperty(
        'duration',
        1,
      );
      expect(fetcher).toHaveBeenCalledTimes(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let lookahead use the last regular request or a reserve request', async () => {
    const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] }),
          ),
      );
    const service = new GeminiSpeechService(fetcher, null);
    const config = { ...getGeminiConfig(), apiKey: 'preload-key', dailyLimit: 4 };
    await service.generate('First', config);
    await expect(service.generate('Next', config, { preload: true })).rejects.toThrow(/budget/);
    await service.generate('Next', config);
    grantGeminiReserveRequest(config);
    await expect(service.generate('Reserve', config, { preload: true })).rejects.toThrow(/budget/);
    expect(getGeminiUsage(config)).toBe(2);
    await service.generate('Reserve', config);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('learns actual narration duration independently for each voice and language', () => {
    const config = getGeminiConfig();
    recordGeminiDurationScale(config, 'zh', 400, 200);
    expect(getGeminiDurationScale(config, 'zh')).toBe(2);
    expect(getGeminiDurationScale({ ...config, voice: 'Charon' }, 'zh')).toBe(1);
    expect(getGeminiDurationScale(config, 'en')).toBe(1);
    const sentences = Array.from({ length: 50 }, () => ({ text: '山'.repeat(90), lang: 'zh' }));
    const batches = buildGeminiBatches(sentences, 8, getGeminiDurationScale(config, 'zh'));
    expect(batches.flatMap((batch) => batch.sentences)).toEqual(sentences);
    expect(batches[0]!.sentences).toHaveLength(12);
  });

  it('groups Chinese sentences into long requests without losing text', () => {
    const sentences = Array.from({ length: 100 }, (_, i) => ({
      text: `${i}。${'山'.repeat(60)}`,
      lang: 'zh',
    }));
    const batches = buildGeminiBatches(sentences, 8);
    expect(batches.length).toBeLessThanOrEqual(4);
    expect(batches.flatMap((b) => b.sentences)).toEqual(sentences);
    expect(batches.every((b) => b.estimatedSeconds <= 480 + 20)).toBe(true);
  });
  it('handles English and empty sections without an excessive number of calls', () => {
    expect(buildGeminiBatches([], 8)).toEqual([]);
    const sentences = Array.from({ length: 100 }, () => ({
      text: 'This is a sentence with several words.',
      lang: 'en',
    }));
    expect(buildGeminiBatches(sentences, 8)).toHaveLength(1);
  });
  it('defaults to the tested model, Algenib, and free-tier limits', () => {
    expect(getGeminiConfig()).toMatchObject({
      enabled: false,
      model: 'gemini-3.8-flash-tts',
      voice: 'Algenib',
      dailyLimit: 10,
      batchMinutes: 8,
    });
    setGeminiConfig({ ...getGeminiConfig(), apiKey: 'test-key', enabled: true });
    expect(getGeminiConfig().apiKey).toBe('test-key');
  });
  it('extracts audio from the actual Interactions steps response', () => {
    const bytes = wav(2);
    const data = btoa(String.fromCharCode(...bytes.subarray(0, 44))) + '';
    // The complete base64 avoids spreading a long array onto the stack.
    const encoded = btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join(''));
    const result = decodeGeminiAudio({
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'audio', mime_type: 'audio/wav', data: encoded }],
        },
      ],
    });
    expect(result.duration).toBe(2);
    expect(result.blob.size).toBe(bytes.length);
    expect(data).toBeTruthy();
  });
  it('rejects absent audio and malformed WAV instead of caching it', () => {
    expect(() => decodeGeminiAudio({ status: 'completed', steps: [] })).toThrow();
    expect(() =>
      decodeGeminiAudio({ output_audio: { mime_type: 'audio/wav', data: btoa('invalid') } }),
    ).toThrow();
  });
  it('deduplicates concurrent requests and sends the key only in the header', async () => {
    setGeminiConfig({ ...getGeminiConfig(), apiKey: 'test-key', enabled: true });
    const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] }), {
        status: 200,
      }),
    );
    const service = new GeminiSpeechService(fetcher, null);
    const config = getGeminiConfig();
    const [a, b] = await Promise.all([
      service.generate('你好', config),
      service.generate('你好', config),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a.duration).toBe(b.duration);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    );
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ 'x-goog-api-key': 'test-key' });
    expect(request.body).not.toContain('test-key');
  });
  it('does not automatically retry authentication or quota failures', async () => {
    setGeminiConfig({ ...getGeminiConfig(), apiKey: 'failure-key', enabled: true });
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('{"error":{"message":"quota exhausted"}}', { status: 429 }));
    const service = new GeminiSpeechService(fetcher, null);
    await expect(service.generate('测试', getGeminiConfig())).rejects.toThrow(/429/);
    await expect(service.generate('测试', getGeminiConfig())).rejects.toThrow(/429/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    service.retryFailedRequests();
    await expect(service.generate('测试', getGeminiConfig())).rejects.toThrow(/429/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not send a queued request after its reading session is abandoned', async () => {
    let finish!: (response: Response) => void;
    const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
    const response = () =>
      new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] }));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementation(async () => response());
    const service = new GeminiSpeechService(fetcher, null);
    const config = { ...getGeminiConfig(), apiKey: 'queued-key' };
    const first = service.generate('First', config);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const controller = new AbortController();
    const next = service.generate('Next', config, { preload: true, signal: controller.signal });
    const rejected = expect(next).rejects.toThrow(/Aborted/);
    controller.abort();
    finish(response());
    await first;
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getGeminiUsage(config)).toBe(1);
    await service.generate('Next', config);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps in-flight deduplication when cached recordings are cleared', async () => {
    let finish!: (response: Response) => void;
    const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const service = new GeminiSpeechService(fetcher, null);
    const config = { ...getGeminiConfig(), apiKey: 'clear-key' };
    const first = service.generate('Same recording', config);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await service.clearCache();
    const second = service.generate('Same recording', config);
    finish(
      new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] })),
    );
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(getGeminiUsage(config)).toBe(1);
  });
  it('allows a corrected key after an authentication failure', async () => {
    const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] })),
      );
    const service = new GeminiSpeechService(fetcher, null);
    await expect(
      service.generate('测试', { ...getGeminiConfig(), apiKey: 'wrong-key' }),
    ).rejects.toThrow(/403/);
    await expect(
      service.generate('测试', { ...getGeminiConfig(), apiKey: 'corrected-key' }),
    ).resolves.toHaveProperty('duration', 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('serves cached recordings after the local daily budget is exhausted', async () => {
    const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] })),
      );
    const service = new GeminiSpeechService(fetcher, null);
    const config = { ...getGeminiConfig(), apiKey: 'test-key', dailyLimit: 1 };
    await service.generate('第一次', config);
    await expect(service.generate('另一段', config)).rejects.toThrow(/daily/);
    await expect(service.generate('第一次', config)).resolves.toHaveProperty('duration', 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('releases a budget rejection after the Pacific daily reset', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-06T19:00:00Z'));
      const encoded = btoa(Array.from(wav(), (n) => String.fromCharCode(n)).join(''));
      const fetcher = vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ steps: [{ content: [{ type: 'audio', data: encoded }] }] }),
            ),
        );
      const service = new GeminiSpeechService(fetcher, null);
      const config = { ...getGeminiConfig(), apiKey: 'test-key', dailyLimit: 1 };
      await service.generate('First recording', config);
      await expect(service.generate('Next recording', config)).rejects.toThrow(/daily/);
      vi.setSystemTime(new Date('2026-10-07T19:00:00Z'));
      await expect(service.generate('Next recording', config)).resolves.toHaveProperty(
        'duration',
        1,
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
