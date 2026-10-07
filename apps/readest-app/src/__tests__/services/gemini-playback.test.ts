import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiTTSClient } from '@/services/tts/GeminiTTSClient';
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
  it('generates the full prepared batch when continuous reading starts at a later sentence', async () => {
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
    const playback = client
      .speak('<speak><mark name="second"/>第二句话。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    expect((await playback.next()).value?.mark).toBe('second');
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith('第一句话。\n第二句话。', expect.anything());
    expect(MockAudio.instances[0]!.currentTime).toBeCloseTo(5);
    await client.shutdown();
    await playback.return?.();
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
