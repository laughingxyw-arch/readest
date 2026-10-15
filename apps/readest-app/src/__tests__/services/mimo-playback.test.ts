import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiMoTTSClient } from '@/services/tts/MiMoTTSClient';
import type { TTSController } from '@/services/tts/TTSController';
import { mimoSpeech, getMiMoConfig, setMiMoConfig, MiMoAPIError } from '@/services/tts/mimo';

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
  setMiMoConfig({ ...getMiMoConfig(), enabled: true, apiKey: 'test-key' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MiMo recording playback', () => {
  it('reports an unexpected request abort as a failure while the user is still waiting', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockRejectedValue(
      new DOMException('Transport aborted', 'AbortError'),
    );
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('unexpected-abort', [{ text: '测试。', lang: 'zh' }]);
    const first = client
      .speak('<speak><mark name="a"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(first).rejects.toThrow('MiMo speech request was interrupted');
  });

  it('reports an unexpected audio startup abort without hiding it as a user cancellation', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    vi.spyOn(MockAudio.prototype, 'play').mockRejectedValue(
      new DOMException('Unexpected interruption', 'AbortError'),
    );
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('audio-abort', [{ text: '测试。', lang: 'zh' }]);
    const first = client
      .speak('<speak><mark name="a"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(first).rejects.toThrow('MiMo audio playback was interrupted');
  });
  it('does not report a late generation failure after playback is cancelled', async () => {
    let rejectGeneration!: (error: Error) => void;
    vi.spyOn(mimoSpeech, 'generate').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectGeneration = reject;
        }),
    );
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('cancelled', [{ text: '测试。', lang: 'zh' }]);
    const signal = new AbortController();
    const first = client
      .speak('<speak><mark name="a"/>测试。</speak>', signal.signal)
      [Symbol.asyncIterator]()
      .next();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    signal.abort();
    await client.stop();
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    rejectGeneration(new Error('MiMo TTS (401): Unauthorized'));
    await rejected;
  });
  it('leaves Android audio focus with the WebView media element', () => {
    expect(new MiMoTTSClient().getCapabilities()).toMatchObject({ ownsAudioFocus: false });
  });

  it('reports a loaded recording whose playback clock stops without an error', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter-stalled', [{ text: '测试。', lang: 'zh' }]);
    const playback = client
      .speak('<speak><mark name="a"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const end = playback.next();
    const outcome = end.then(
      () => 'finished',
      (error) => (error as Error).message,
    );
    await vi.advanceTimersByTimeAsync(11000);
    expect(await Promise.race([outcome, Promise.resolve('still waiting')])).toMatch(
      /not progressing/,
    );
    expect(MockAudio.instances[0]!.paused).toBe(true);
    await client.shutdown();
  });

  it('reports audio that keeps moving much slower than the requested rate', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 60 });
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('slow-clock', [{ text: '测试。', lang: 'zh' }]);
    const playback = client
      .speak('<speak><mark name="a"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const outcome = playback.next().then(
      () => 'finished',
      (error) => (error as Error).message,
    );
    for (let i = 0; i < 11; i++) {
      MockAudio.instances[0]!.currentTime += 0.02;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(await Promise.race([outcome, Promise.resolve('still waiting')])).toMatch(
      /not progressing/,
    );
    expect(MockAudio.instances[0]!.paused).toBe(true);
    await client.shutdown();
  });

  it('accepts healthy slow-rate playback and resets the window for seeking and rate changes', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 60 });
    const client = new MiMoTTSClient();
    await client.init();
    await client.setRate(0.5);
    client.prepareSection('healthy-clock', [{ text: '测试。', lang: 'zh' }]);
    const signal = new AbortController();
    const playback = client
      .speak('<speak><mark name="a"/>测试。</speak>', signal.signal)
      [Symbol.asyncIterator]();
    await playback.next();
    let outcome = 'waiting';
    const end = playback.next().then(
      () => {
        outcome = 'finished';
      },
      () => {
        outcome = 'failed';
      },
    );
    const audio = MockAudio.instances[0]!;
    for (let i = 0; i < 12; i++) {
      audio.currentTime += 0.5;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(outcome).toBe('waiting');
    await vi.advanceTimersByTimeAsync(8000);
    audio.currentTime = 30;
    audio.dispatchEvent(new Event('seeking'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(outcome).toBe('waiting');
    await client.setRate(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(outcome).toBe('waiting');
    for (let i = 0; i < 12; i++) {
      audio.currentTime += 2;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(outcome).toBe('waiting');
    signal.abort();
    await end;
    await client.shutdown();
  });

  it('bounds a play promise that never resolves without reporting a media error', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    vi.spyOn(MockAudio.prototype, 'play').mockImplementation(function (this: MockAudio) {
      this.paused = false;
      return new Promise<void>(() => {});
    });
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter-pending', [{ text: '测试。', lang: 'zh' }]);
    const playback = client
      .speak('<speak><mark name="a"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    const outcome = playback.next().then(
      () => 'finished',
      (error) => (error as Error).message,
    );
    await vi.advanceTimersByTimeAsync(11000);
    expect(await Promise.race([outcome, Promise.resolve('still waiting')])).toMatch(
      /did not start/,
    );
    expect(MockAudio.instances[0]!.paused).toBe(true);
    await client.shutdown();
  });

  it('does not treat a user pause as a stuck audio clock', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter-paused', [{ text: '测试。', lang: 'zh' }]);
    const playback = client
      .speak('<speak><mark name="a"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const end = playback.next();
    const outcome = end.then(
      () => 'finished',
      (error) => (error as Error).message,
    );
    await client.pause();
    await vi.advanceTimersByTimeAsync(20000);
    expect(await Promise.race([outcome, Promise.resolve('still waiting')])).toBe('still waiting');
    await client.resume();
    MockAudio.instances[0]!.currentTime = 1;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await Promise.race([outcome, Promise.resolve('still waiting')])).toBe('still waiting');
    await client.stop();
    await vi.advanceTimersByTimeAsync(60);
    await end;
    await client.shutdown();
  });

  it('allows pause and resume while the first play promise is pending', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    let rejectPlay!: (reason: unknown) => void;
    const play = vi.spyOn(MockAudio.prototype, 'play').mockImplementationOnce(function (
      this: MockAudio,
    ) {
      this.paused = false;
      return new Promise<void>((_, reject) => {
        rejectPlay = reject;
      });
    });
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter-pausing', [{ text: '测试。', lang: 'zh' }]);
    const playback = client
      .speak('<speak><mark name="a"/>测试。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    const first = playback.next();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await client.pause();
    rejectPlay(new DOMException('Play interrupted by pause', 'AbortError'));
    expect((await first).value?.code).toBe('boundary');
    await client.resume();
    expect(play).toHaveBeenCalledTimes(2);
    await client.shutdown();
    await playback.return?.();
  });

  it('uses the book position to distinguish identical sentences when starting from a selection', async () => {
    const cached = { blob: new Blob(['test']), duration: 10 };
    vi.spyOn(mimoSpeech, 'getCached').mockResolvedValue(cached);
    const generate = vi.spyOn(mimoSpeech, 'generate').mockResolvedValue(cached);
    const controller = {
      getSpokenSentence: () => ({ cfi: 'second' }),
      dispatchSpeakMark: vi.fn(),
    } as unknown as TTSController;
    const client = new MiMoTTSClient(controller);
    await client.init();
    client.prepareSection('chapter-1', [
      { text: '相同的句子。', lang: 'zh', cfi: 'first' },
      { text: '相同的句子。', lang: 'zh', cfi: 'second' },
    ]);
    const playback = client
      .speak('<speak><mark name="0"/>相同的句子。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    expect(MockAudio.instances[0]!.currentTime).toBe(0);
    expect(generate).toHaveBeenCalledWith('相同的句子。', expect.anything(), expect.anything());
    await client.shutdown();
    await playback.return?.();
  });

  it('waits for Resume before sending a request that has not started yet', async () => {
    const sent = vi.fn();
    vi.spyOn(mimoSpeech, 'generate').mockImplementation(async (_text, _config, options) => {
      await options?.beforeRequest?.();
      sent();
      return { blob: new Blob(['test']), duration: 10 };
    });
    const client = new MiMoTTSClient();
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

  it('plays separate recordings across chapters without reading either chapter twice', async () => {
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 10 });
    const client = new MiMoTTSClient();
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
    expect(generate.mock.calls[0]![0]).toBe('第一句话。');
    const end = first.next();
    MockAudio.instances[0]!.ended = true;
    await vi.advanceTimersByTimeAsync(60);
    await end;
    await client.stop(true);
    expect(client.activateSection('chapter-2')).toBe(true);
    const second = client
      .speak('<speak><mark name="0"/>第二句话。</speak>', signal)
      [Symbol.asyncIterator]();
    await second.next();
    expect(generate.mock.calls.at(-1)![0]).toBe('第二句话。');
    expect(MockAudio.instances).toHaveLength(2);
    expect(MockAudio.instances[1]!.currentTime).toBe(0);
    await client.shutdown();
    await second.return?.();
  });

  it('does not restart completed audio while a throttled text cursor catches up', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const client = new MiMoTTSClient();
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
    expect((await next).value?.code).toBe('end');
    expect(player.currentTime).toBe(10);
    expect(player.ended).toBe(true);
    expect((await playback.next()).done).toBe(true);
    await client.shutdown();
  });

  it('does not advance a segment when its estimated sentence midpoint is passed', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 10 });
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [
      { text: '第一句话。', lang: 'zh' },
      { text: '第二句话。', lang: 'zh' },
    ]);
    const playback = client
      .speak('<speak><mark name="a"/>第一句话。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const end = playback.next();
    const done = vi.fn();
    void end.then(done);
    const player = MockAudio.instances[0]!;
    player.currentTime = 5.9;
    await vi.advanceTimersByTimeAsync(60);
    expect(done).not.toHaveBeenCalled();
    expect(player.currentTime).toBe(5.9);
    player.ended = true;
    await vi.advanceTimersByTimeAsync(60);
    expect((await end).value?.code).toBe('end');
    await client.shutdown();
  });

  it('restarts a cached segment only after an explicit navigation request', async () => {
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 10 });
    const client = new MiMoTTSClient();
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

  it('uses a suffix cache key instead of an approximate seek when starting inside a recording', async () => {
    vi.spyOn(mimoSpeech, 'getCached').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 10 });
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [
      { text: '第一句话。', lang: 'zh' },
      { text: '第二句话。', lang: 'zh' },
    ]);
    const playback = client
      .speak('<speak><mark name="second"/>第二句话。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    expect((await playback.next()).value?.mark).toBe('second');
    expect(generate).toHaveBeenCalledWith('第二句话。', expect.anything(), expect.anything());
    expect(MockAudio.instances[0]!.currentTime).toBe(0);
    await client.shutdown();
    await playback.return?.();
  });

  it('starts an uncached long batch at the chosen sentence and preserves its text after reopening', async () => {
    vi.spyOn(mimoSpeech, 'getCached').mockResolvedValue(null);
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 600 });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const ssml = `<speak><mark name="start"/>${sentences[10]!.text}</speak>`;
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter-long', sentences);
    const playback = client.speak(ssml, new AbortController().signal)[Symbol.asyncIterator]();
    await playback.next();
    const generatedText = generate.mock.calls[0]![0];
    expect(generatedText.startsWith(sentences[10]!.text)).toBe(true);
    expect(generatedText.split('\n').length).toBeGreaterThan(0);
    expect(generatedText.split('\n').length).toBeLessThanOrEqual(2);
    expect(MockAudio.instances[0]!.currentTime).toBe(0);
    await client.shutdown();
    await playback.return?.();
    // Learning a slower narration pace must not repartition cached audio.
    const reopened = new MiMoTTSClient();
    await reopened.init();
    reopened.prepareSection('chapter-long', sentences);
    const replay = reopened.speak(ssml, new AbortController().signal)[Symbol.asyncIterator]();
    await replay.next();
    expect(generate.mock.calls[1]![0]).toBe(generatedText);
    await reopened.shutdown();
    await replay.return?.();
  });

  it.each([
    [1, 3],
    [2, 6],
  ])('buffers ninety playable seconds at rate %s without loading future players', async (rate, requests) => {
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new MiMoTTSClient();
    await client.init();
    await client.setRate(rate);
    client.prepareSection('buffer-duration', sentences);
    const playback = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(requests);
    expect(generate.mock.calls.slice(1).every((call) => call[2]?.preload)).toBe(true);
    expect(MockAudio.instances).toHaveLength(1);
    await client.shutdown();
    await playback.return?.();
  });

  it('does not refill until the playable buffer drops below its low watermark', async () => {
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('buffer-refill', sentences);
    const playback = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const end = playback.next();
    await vi.advanceTimersByTimeAsync(60);
    expect(generate).toHaveBeenCalledTimes(3);
    MockAudio.instances[0]!.currentTime = 10;
    await vi.advanceTimersByTimeAsync(60);
    expect(generate).toHaveBeenCalledTimes(3);
    MockAudio.instances[0]!.currentTime = 25;
    await vi.advanceTimersByTimeAsync(60);
    expect(generate).toHaveBeenCalledTimes(4);
    await client.shutdown();
    await vi.advanceTimersByTimeAsync(60);
    await end;
  });

  it('raises the playable target to three minutes after slow generation', async () => {
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockImplementation(async (_text, _config, options) => {
        options?.onGenerated?.(60000);
        return { blob: new Blob(['test']), duration: 30 };
      });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('slow-generation-buffer', sentences);
    const playback = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    for (let i = 0; i < 150; i++) await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(6);
    await client.shutdown();
    await playback.return?.();
  });

  it('finishes only the in-flight recording after Pause without requesting more', async () => {
    let finish!: (audio: { blob: Blob; duration: number }) => void;
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockImplementation(async (_text, _config, options) => {
        if (options?.preload)
          return new Promise((resolve) => {
            finish = resolve;
          });
        return { blob: new Blob(['test']), duration: 30 };
      });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('pause-buffer', sentences);
    const playback = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(2);
    await client.pause();
    finish({ blob: new Blob(['test']), duration: 30 });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(MockAudio.instances[0]!.paused).toBe(true);
    await client.shutdown();
    await playback.return?.();
  });

  it('reuses the prepared next segment after normal playback handover', async () => {
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('handover-buffer', sentences);
    const signal = new AbortController().signal;
    const first = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, signal)
      [Symbol.asyncIterator]();
    await first.next();
    const end = first.next();
    await vi.advanceTimersByTimeAsync(60);
    const nextText = generate.mock.calls[1]![0];
    MockAudio.instances[0]!.ended = true;
    await vi.advanceTimersByTimeAsync(60);
    await end;
    await client.stop(true);
    const second = client
      .speak(`<speak><mark name="b"/>${nextText.split('\n')[0]}</speak>`, signal)
      [Symbol.asyncIterator]();
    await second.next();
    expect(generate.mock.calls.filter((call) => call[0] === nextText)).toHaveLength(1);
    expect(generate.mock.calls.filter((call) => !call[2]?.preload)).toHaveLength(1);
    expect(MockAudio.instances).toHaveLength(2);
    await client.shutdown();
    await second.return?.();
  });

  it('counts slow in-flight generation carried across a normal playback handover', async () => {
    let finish!: () => void;
    let requests = 0;
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockImplementation(async (_text, _config, options) => {
        if (++requests === 2)
          await new Promise<void>((resolve) => {
            finish = () => {
              options?.onGenerated?.(60000);
              resolve();
            };
          });
        return { blob: new Blob(['test']), duration: 30 };
      });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('slow-handover-buffer', sentences);
    const signal = new AbortController().signal;
    const first = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, signal)
      [Symbol.asyncIterator]();
    await first.next();
    const end = first.next();
    await vi.advanceTimersByTimeAsync(60);
    const nextText = generate.mock.calls[1]![0];
    MockAudio.instances[0]!.ended = true;
    await vi.advanceTimersByTimeAsync(60);
    await end;
    await client.stop(true);
    const second = client
      .speak(`<speak><mark name="b"/>${nextText.split('\n')[0]}</speak>`, signal)
      [Symbol.asyncIterator]();
    const boundary = second.next();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    finish();
    await boundary;
    const secondEnd = second.next();
    await vi.advanceTimersByTimeAsync(60);
    expect(generate).toHaveBeenCalledTimes(7);
    await client.shutdown();
    await vi.advanceTimersByTimeAsync(60);
    await secondEnd;
  });

  it('backs off a failed prefetch instead of retrying every playback tick', async () => {
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockImplementation(async (_text, _config, options) => {
        if (options?.preload) throw new MiMoAPIError(429, 'rate limit');
        return { blob: new Blob(['test']), duration: 30 };
      });
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('retry-buffer', sentences);
    const playback = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const end = playback.next();
    await vi.advanceTimersByTimeAsync(1000);
    expect(generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(generate).toHaveBeenCalledTimes(3);
    await client.shutdown();
    await vi.advanceTimersByTimeAsync(60);
    await end;
  });

  it('does not keep probing the cache when the audio memory budget is full', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({
      blob: new Blob([new Uint8Array(32 * 1024 * 1024)]),
      duration: 30,
    });
    const cached = vi.spyOn(mimoSpeech, 'getCached').mockResolvedValue(null);
    const sentences = Array.from({ length: 80 }, (_, i) => ({
      text: `${i}：${'山'.repeat(90)}。`,
      lang: 'zh',
    }));
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('memory-buffer', sentences);
    const playback = client
      .speak(`<speak><mark name="a"/>${sentences[0]!.text}</speak>`, new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    const reads = cached.mock.calls.length;
    const end = playback.next();
    await vi.advanceTimersByTimeAsync(500);
    expect(cached).toHaveBeenCalledTimes(reads);
    await client.shutdown();
    await vi.advanceTimersByTimeAsync(60);
    await end;
  });

  it('does not prefetch across a chapter boundary when chapter-end stopping is enabled', async () => {
    const generate = vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const client = new MiMoTTSClient({
      stopAtChapterEnd: true,
      getSpokenSentence: () => null,
    } as unknown as TTSController);
    await client.init();
    client.prepareSection(
      'first',
      [{ text: '第一章。', lang: 'zh' }],
      [{ id: 'second', sentences: [{ text: '第二章。', lang: 'zh' }] }],
    );
    const playback = client
      .speak('<speak><mark name="a"/>第一章。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await playback.next();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(1);
    await client.shutdown();
    await playback.return?.();
  });

  it('does not request a short fallback when prepared chapter text cannot be matched', async () => {
    const generate = vi.spyOn(mimoSpeech, 'generate');
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter-1', [{ text: '原文。', lang: 'zh' }]);
    const playback = client
      .speak('<speak><mark name="a"/>不匹配。</speak>', new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(playback.next()).rejects.toThrow(/No MiMo request/);
    expect(generate).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('keeps playback paused when generation finishes after Pause is pressed', async () => {
    let finish!: (audio: { blob: Blob; duration: number }) => void;
    vi.spyOn(mimoSpeech, 'generate').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = new MiMoTTSClient();
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
    const generate = vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const client = new MiMoTTSClient();
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
      expect.objectContaining({ voice: '茉莉' }),
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
    expect(player.currentTime).toBe(5);
    expect(generate).toHaveBeenCalledOnce();
    player.currentTime = 10;
    player.ended = true;
    await vi.advanceTimersByTimeAsync(60);
    expect((await end).value?.code).toBe('end');
    await client.shutdown();
  });

  it('preloads without starting playback and stops an active recording', async () => {
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({
      blob: new Blob(['test']),
      duration: 10,
    });
    const client = new MiMoTTSClient();
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
