import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiTTSClient } from '@/services/tts/GeminiTTSClient';
import type { TTSController } from '@/services/tts/TTSController';
import { geminiSpeech, getGeminiConfig, setGeminiConfig } from '@/services/tts/gemini';

class MockAudio extends EventTarget {
  static instances: MockAudio[] = [];
  currentTime = 0;
  duration = 10;
  readyState = 1;
  ended = false;
  paused = true;
  playbackRate = 1;
  preload = '';
  src = '';
  constructor() {
    super();
    MockAudio.instances.push(this);
  }
  async play() {
    if (this.ended) {
      this.currentTime = 0;
      this.ended = false;
    }
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute() {}
}

beforeEach(() => {
  localStorage.clear();
  MockAudio.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('Audio', MockAudio);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() });
  setGeminiConfig({ ...getGeminiConfig(), enabled: true, apiKey: 'test-key' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Gemini recording playback', () => {
  it('reuses an old per-chapter recording after upgrading to cross-chapter batches', async () => {
    const cached = { blob: new Blob(['old']), duration: 10 };
    vi.spyOn(geminiSpeech, 'getCached').mockImplementation(async (text) =>
      text === '第一句话。' ? cached : null,
    );
    const generate = vi.spyOn(geminiSpeech, 'generate');
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection(
      'chapter-1',
      [{ text: '第一句话。', lang: 'zh' }],
      [{ id: 'chapter-2', sentences: [{ text: '第二句话。', lang: 'zh' }] }],
    );
    const playback = client
      .speak('<speak><mark name="0"/>第一句话。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    expect(generate).not.toHaveBeenCalled();
    expect(MockAudio.instances).toHaveLength(1);
    await client.shutdown();
    await playback.return?.();
  });

  it('uses the book position to distinguish identical sentences when starting from a selection', async () => {
    const cached = { blob: new Blob(['test']), duration: 10 };
    vi.spyOn(geminiSpeech, 'getCached').mockResolvedValue(cached);
    const generate = vi.spyOn(geminiSpeech, 'generate');
    const controller = {
      getSpokenSentence: () => ({ cfi: 'second' }),
      dispatchSpeakMark: vi.fn(),
    } as unknown as TTSController;
    const client = new GeminiTTSClient(controller);
    await client.init();
    client.prepareSection('chapter-1', [
      { text: '相同的句子。', lang: 'zh', cfi: 'first' },
      { text: '相同的句子。', lang: 'zh', cfi: 'second' },
    ]);
    const playback = client
      .speak('<speak><mark name="0"/>相同的句子。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    expect(MockAudio.instances[0]!.currentTime).toBeCloseTo(5);
    expect(generate).not.toHaveBeenCalled();
    await client.shutdown();
    await playback.return?.();
  });

  it('waits for Resume before sending a request that has not started yet', async () => {
    const sent = vi.fn();
    vi.spyOn(geminiSpeech, 'generate').mockImplementation(async (_text, _config, options) => {
      await options?.beforeRequest?.();
      sent();
      return { blob: new Blob(['test']), duration: 10 };
    });
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [{ text: '测试。', lang: 'zh' }]);
    await client.pause();
    const playback = client
      .speak('<speak><mark name="0"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    const first = playback.next();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(sent).not.toHaveBeenCalled();
    expect(MockAudio.instances).toHaveLength(0);
    await client.resume();
    await first;
    expect(sent).toHaveBeenCalledOnce();
    await client.shutdown();
    await playback.return?.();
  });

  it('keeps the same recording rolling across short chapter boundaries', async () => {
    const generate = vi
      .spyOn(geminiSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 10 });
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection(
      'chapter-1',
      [{ text: '第一句话。', lang: 'zh' }],
      [{ id: 'chapter-2', sentences: [{ text: '第二句话。', lang: 'zh' }] }],
    );
    const signal = new AbortController().signal;
    const first = client
      .speak('<speak><mark name="0"/>第一句话。</speak>', signal)
      [Symbol.asyncIterator]();
    await first.next();
    expect(generate.mock.calls[0]![0]).toBe('第一句话。\n第二句话。');
    const end = first.next();
    const player = MockAudio.instances[0]!;
    player.currentTime = 5.9;
    await vi.advanceTimersByTimeAsync(60);
    await end;
    await client.stop(true);
    expect(client.activateSection('chapter-2')).toBe(true);
    const second = client
      .speak('<speak><mark name="0"/>第二句话。</speak>', signal)
      [Symbol.asyncIterator]();
    await second.next();
    expect(generate).toHaveBeenCalledOnce();
    expect(MockAudio.instances).toHaveLength(1);
    expect(player.currentTime).toBe(5.9);
    await client.shutdown();
    await second.return?.();
  });

  it('does not restart completed audio while a throttled text cursor catches up', async () => {
    vi.spyOn(geminiSpeech, 'generate').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [
      { text: '第一句话。', lang: 'zh' },
      { text: '第二句话。', lang: 'zh' },
    ]);
    const playback = client
      .speak(
        '<speak><mark name="a"/>第一句话。<mark name="b"/>第二句话。</speak>',
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();
    await playback.next();
    const next = playback.next();
    const player = MockAudio.instances[0]!;
    player.currentTime = 10;
    player.ended = true;
    player.paused = true;
    await vi.advanceTimersByTimeAsync(60);
    expect((await next).value?.mark).toBe('b');
    expect(player.currentTime).toBe(10);
    expect(player.ended).toBe(true);
    expect((await playback.next()).value?.code).toBe('end');
    await client.shutdown();
  });

  it('does not rewind or pause the recording when paragraph handover is delayed', async () => {
    vi.spyOn(geminiSpeech, 'generate').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [
      { text: '第一句话。', lang: 'zh' },
      { text: '第二句话。', lang: 'zh' },
    ]);
    const signal = new AbortController().signal;
    const first = client
      .speak('<speak><mark name="a"/>第一句话。</speak>', signal)
      [Symbol.asyncIterator]();
    await first.next();
    const end = first.next();
    const player = MockAudio.instances[0]!;
    player.currentTime = 5.9;
    await vi.advanceTimersByTimeAsync(60);
    await end;
    expect(player.paused).toBe(false);
    await client.stop(true);
    expect(player.paused).toBe(false);
    const second = client
      .speak('<speak><mark name="b"/>第二句话。</speak>', signal)
      [Symbol.asyncIterator]();
    await second.next();
    expect(player.currentTime).toBe(5.9);
    await client.shutdown();
    await second.return?.();
  });

  it('only seeks back to an estimated sentence boundary after an explicit navigation request', async () => {
    const generate = vi
      .spyOn(geminiSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 10 });
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [{ text: '测试。', lang: 'zh' }]);
    const signal = new AbortController().signal;
    const first = client
      .speak('<speak><mark name="a"/>测试。</speak>', signal)
      [Symbol.asyncIterator]();
    await first.next();
    MockAudio.instances[0]!.currentTime = 4;
    await client.stop(true);
    await first.return?.();
    client.setNextChunkPosition(0);
    const replay = client
      .speak('<speak><mark name="a"/>测试。</speak>', signal)
      [Symbol.asyncIterator]();
    await replay.next();
    expect(MockAudio.instances[0]!.currentTime).toBe(0);
    expect(generate).toHaveBeenCalledOnce();
    await client.shutdown();
    await replay.return?.();
  });

  it('reuses an existing full recording when continuous reading starts at a later sentence', async () => {
    vi.spyOn(geminiSpeech, 'getCached').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const generate = vi.spyOn(geminiSpeech, 'generate');
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [
      { text: '第一句话。', lang: 'zh' },
      { text: '第二句话。', lang: 'zh' },
    ]);
    const playback = client
      .speak('<speak><mark name="second"/>第二句话。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    expect((await playback.next()).value?.mark).toBe('second');
    expect(generate).not.toHaveBeenCalled();
    expect(MockAudio.instances[0]!.currentTime).toBeCloseTo(5);
    await client.shutdown();
    await playback.return?.();
  });

  it('starts an uncached long batch at the chosen sentence and preserves its text after reopening', async () => {
    vi.spyOn(geminiSpeech, 'getCached').mockResolvedValue(null);
    const generate = vi
      .spyOn(geminiSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 600 });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const ssml = `<speak><mark name="start"/>${sentences[10]!.text}</speak>`;
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-long', sentences);
    const playback = client.speak(ssml, new AbortController().signal)[Symbol.asyncIterator]();
    await playback.next();
    const generatedText = generate.mock.calls[0]![0];
    expect(generatedText.startsWith(sentences[10]!.text)).toBe(true);
    expect(generatedText.split('\n').length).toBeGreaterThan(20);
    expect(MockAudio.instances[0]!.currentTime).toBe(0);
    await client.shutdown();
    await playback.return?.();
    // Learning a slower narration pace must not repartition cached audio.
    const reopened = new GeminiTTSClient();
    await reopened.init();
    reopened.prepareSection('chapter-long', sentences);
    const replay = reopened.speak(ssml, new AbortController().signal)[Symbol.asyncIterator]();
    await replay.next();
    expect(generate.mock.calls[1]![0]).toBe(generatedText);
    await reopened.shutdown();
    await replay.return?.();
  });

  it('only prepares one next batch near the audible end and does not load it into the player', async () => {
    const generate = vi
      .spyOn(geminiSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 480 });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-lookahead', sentences);
    const playback = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const end = playback.next();
    await vi.advanceTimersByTimeAsync(60);
    expect(generate).toHaveBeenCalledTimes(1);
    const player = MockAudio.instances[0]!;
    player.currentTime = 430;
    await vi.advanceTimersByTimeAsync(60);
    await end;
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![2]).toMatchObject({ preload: true });
    expect(MockAudio.instances).toHaveLength(1);
    expect(player.currentTime).toBe(430);
    await client.shutdown();
  });

  it('does not request a short fallback when prepared chapter text cannot be matched', async () => {
    const generate = vi.spyOn(geminiSpeech, 'generate');
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [{ text: '原文。', lang: 'zh' }]);
    const playback = client
      .speak('<speak><mark name="a"/>不匹配。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(playback.next()).rejects.toThrow(/No Gemini request/);
    expect(generate).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('keeps playback paused when generation finishes after Pause is pressed', async () => {
    let finish!: (audio: { blob: Blob; duration: number }) => void;
    vi.spyOn(geminiSpeech, 'generate').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [{ text: '测试。', lang: 'zh' }]);
    const playback = client
      .speak('<speak><mark name="a"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    const first = playback.next();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await client.pause();
    finish({ blob: new Blob(['test']), duration: 10 });
    await first;
    expect(MockAudio.instances[0]!.paused).toBe(true);
    await client.resume();
    expect(MockAudio.instances[0]!.paused).toBe(false);
    await client.shutdown();
    await playback.return?.();
  });

  it('keeps one long recording across paragraphs and supports pause and rate changes', async () => {
    const generate = vi.spyOn(geminiSpeech, 'generate').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [
      { text: '第一句话。', lang: 'zh' },
      { text: '第二句话。', lang: 'zh' },
    ]);
    const signal = new AbortController().signal;
    const first = client
      .speak('<speak><mark name="a"/>第一句话。</speak>', signal)
      [Symbol.asyncIterator]();
    expect((await first.next()).value?.code).toBe('boundary');
    expect(generate).toHaveBeenCalledWith(
      '第一句话。\n第二句话。',
      expect.objectContaining({ voice: 'Algenib' }),
      expect.anything(),
    );
    const player = MockAudio.instances[0]!;
    await client.pause();
    expect(player.paused).toBe(true);
    await client.setRate(1.5);
    await client.resume();
    expect(player.paused).toBe(false);
    expect(player.playbackRate).toBe(1.5);
    const end = first.next();
    player.currentTime = 5;
    await vi.advanceTimersByTimeAsync(60);
    expect((await end).value?.code).toBe('end');
    const second = client
      .speak('<speak><mark name="b"/>第二句话。</speak>', signal)
      [Symbol.asyncIterator]();
    expect((await second.next()).value?.mark).toBe('b');
    expect(MockAudio.instances).toHaveLength(1);
    expect(player.currentTime).toBe(5);
    const secondEnd = second.next();
    player.currentTime = 10;
    await vi.advanceTimersByTimeAsync(60);
    expect((await secondEnd).value?.code).toBe('end');
    await client.shutdown();
  });

  it('preloads without starting playback and stops an active recording', async () => {
    vi.spyOn(geminiSpeech, 'generate').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const client = new GeminiTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [{ text: '测试。', lang: 'zh' }]);
    const ssml = '<speak><mark name="a"/>测试。</speak>';
    const signal = new AbortController().signal;
    for await (const _ of client.speak(ssml, signal, true)) {
      /* consume preload */
    }
    expect(MockAudio.instances).toHaveLength(0);
    const playback = client.speak(ssml, signal)[Symbol.asyncIterator]();
    await playback.next();
    const pending = playback.next();
    await client.stop();
    await vi.advanceTimersByTimeAsync(60);
    expect((await pending).done).toBe(true);
    expect(MockAudio.instances[0]!.paused).toBe(true);
    await client.shutdown();
  });
});
