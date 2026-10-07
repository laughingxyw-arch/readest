import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiMoTTSClient } from '@/services/tts/MiMoTTSClient';
import { buildMiMoBatches, getMiMoConfig, mimoSpeech, setMiMoConfig } from '@/services/tts/mimo';

class SegmentAudio extends EventTarget {
  static player: SegmentAudio;
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
    SegmentAudio.player = this;
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
  vi.useFakeTimers();
  vi.stubGlobal('Audio', SegmentAudio);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() });
  setMiMoConfig({ ...getMiMoConfig(), enabled: true, apiKey: 'test-key' });
  vi.spyOn(mimoSpeech, 'getCached').mockResolvedValue(null);
  vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 10 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MiMo audio segment boundaries', () => {
  it('retains the transition when Pause coincides with the end of the recording', async () => {
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter', [{ text: '第一句。', lang: 'zh', cfi: 'a' }]);
    const playback = client
      .speak('<speak><mark name="0"/>第一句。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const end = playback.next();
    const done = vi.fn();
    void end.then(done);
    await client.pause();
    SegmentAudio.player.ended = true;
    SegmentAudio.player.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled();
    await client.resume();
    expect((await end).value?.code).toBe('end');
    await client.shutdown();
  });

  it('starts exactly at a new sentence even after a segment has already begun', async () => {
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter', [
      { text: '第一句。', lang: 'zh', cfi: 'a' },
      { text: '第二句。', lang: 'zh', cfi: 'b' },
    ]);
    const signal = new AbortController().signal;
    const first = client
      .speak('<speak><mark name="0"/>第一句。</speak>', signal)
      [Symbol.asyncIterator]();
    await first.next();
    await client.stop(true);
    await first.return?.();
    const next = client
      .speak('<speak><mark name="1"/>第二句。</speak>', signal)
      [Symbol.asyncIterator]();
    expect((await next.next()).value?.segment?.startCFI).toBe('b');
    expect(mimoSpeech.generate).toHaveBeenLastCalledWith(
      '第二句。',
      expect.anything(),
      expect.anything(),
    );
    expect(SegmentAudio.player.currentTime).toBe(0);
    await client.shutdown();
    await next.return?.();
  });

  it('keeps the existing selection-only keyboard command limited to its exact text', async () => {
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter', [
      { text: '第一句。', lang: 'zh', cfi: 'a' },
      { text: '第二句。', lang: 'zh', cfi: 'b' },
    ]);
    const playback = client
      .speak(
        '<speak><mark name="0"/>选中的几个字</speak>',
        new AbortController().signal,
        false,
        true,
      )
      [Symbol.asyncIterator]();
    expect((await playback.next()).value?.segment).toBeUndefined();
    expect(mimoSpeech.generate).toHaveBeenCalledWith(
      '选中的几个字',
      expect.anything(),
      expect.anything(),
    );
    await client.shutdown();
    await playback.return?.();
  });

  it('highlights the complete recording and advances only on real audio completion', async () => {
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter', [
      { text: '第一句。', lang: 'zh', cfi: 'a' },
      { text: '第二句。', lang: 'zh', cfi: 'b' },
    ]);
    const playback = client
      .speak('<speak><mark name="0"/>第一句。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    expect((await playback.next()).value).toMatchObject({
      code: 'boundary',
      segment: { startCFI: 'a', endCFI: 'b' },
    });
    const end = playback.next();
    const finished = vi.fn();
    void end.then(finished);
    SegmentAudio.player.currentTime = 9.99;
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).not.toHaveBeenCalled();
    SegmentAudio.player.ended = true;
    SegmentAudio.player.dispatchEvent(new Event('ended'));
    expect((await end).value?.code).toBe('end');
    expect(mimoSpeech.generate).toHaveBeenCalledWith(
      '第一句。\n第二句。',
      expect.anything(),
      expect.anything(),
    );
    await client.shutdown();
  });

  it('keeps chapter boundaries separate even when both chapters are short', () => {
    const batches = buildMiMoBatches(
      [
        { text: '第一章。', lang: 'zh', section: 'one' },
        { text: '第二章。', lang: 'zh', section: 'two' },
      ],
      0.5,
    );
    expect(batches).toHaveLength(2);
  });

  it('prefers a natural paragraph boundary after reaching half the target length', () => {
    const sentences = [
      { text: '甲'.repeat(80) + '。', lang: 'zh', paragraph: 'one' },
      { text: '乙'.repeat(30) + '。', lang: 'zh', paragraph: 'two' },
    ];
    expect(buildMiMoBatches(sentences, 0.5).map((b) => b.sentences)).toEqual([
      [sentences[0]],
      [sentences[1]],
    ]);
  });
});
