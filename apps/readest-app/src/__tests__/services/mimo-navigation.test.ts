import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTSController } from '@/services/tts/TTSController';
import { MiMoTTSClient } from '@/services/tts/MiMoTTSClient';
import { getMiMoConfig, mimoSpeech, setMiMoConfig } from '@/services/tts/mimo';
import type { FoliateView } from '@/types/view';
import * as CFI from 'foliate-js/epubcfi.js';

beforeEach(() => {
  localStorage.clear();
  setMiMoConfig({ ...getMiMoConfig(), enabled: true, apiKey: 'test-key' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function makeController() {
  const doc = new DOMParser().parseFromString(
    '<html lang="zh"><body><p>第一句。第二句。</p><p>第三句。</p></body></html>',
    'text/html',
  );
  const add = vi.fn();
  const view = {
    book: { sections: [{ id: '0', createDocument: async () => doc }] },
    language: { isCJK: true },
    renderer: {
      primaryIndex: 0,
      sideProp: 'width',
      start: 100,
      end: 200,
      getContents: () => [{ index: 0, doc, overlayer: { add, remove: vi.fn() } }],
    },
    getCFI: (_index: number, range: Range) => CFI.fromRange(range),
    resolveCFI: (cfi: string) => ({
      anchor: (target: Document) => CFI.toRange(target, CFI.parse(cfi)),
    }),
  } as unknown as FoliateView;
  const controller = new TTSController(null, view);
  controller.ttsClient = controller.ttsMiMoClient;
  await controller.ttsMiMoClient.init();
  await controller.initViewTTS(0);
  view.tts!.start();
  controller.dispatchSpeakMark({ name: '0', text: '第一句。', language: 'zh', offset: 0 });
  const start = doc.createRange();
  start.selectNodeContents(doc.querySelectorAll('p')[0]!);
  const end = doc.createRange();
  end.selectNodeContents(doc.querySelectorAll('p')[1]!);
  return {
    doc,
    view,
    controller,
    add,
    segment: { startCFI: CFI.fromRange(start), endCFI: CFI.fromRange(end) },
  };
}

describe('MiMo additional QA regressions', () => {
  it('keeps the resumed playback task cancellable when the previous task finishes', async () => {
    class AudioMock extends EventTarget {
      static instances: AudioMock[] = [];
      readyState = 1;
      duration = 30;
      currentTime = 5;
      paused = true;
      ended = false;
      constructor() {
        super();
        AudioMock.instances.push(this);
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
    vi.stubGlobal('Audio', AudioMock);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL() {
          return 'blob:test';
        }
        static override revokeObjectURL() {}
      },
    );
    vi.spyOn(mimoSpeech, 'getCached').mockResolvedValue(null);
    vi.spyOn(mimoSpeech, 'generate').mockResolvedValue({ blob: new Blob(['test']), duration: 30 });
    const { controller, view, add } = await makeController();
    try {
      await controller.speak(view.tts!.start()!);
      await vi.waitFor(() => expect(AudioMock.instances[0]?.paused).toBe(false));
      await controller.pause();
      await controller.start();
      await vi.waitFor(() => expect(AudioMock.instances[0]!.paused).toBe(false));
      await controller.pause();
      await controller.forward(true);
      expect((add.mock.calls.at(-1)![1] as Range).toString()).toBe('第二句。');
    } finally {
      await controller.shutdown();
    }
  }, 15000);

  it('keeps the old recording silent while a paused sentence jump generates new audio', async () => {
    class AudioMock extends EventTarget {
      static instances: AudioMock[] = [];
      readyState = 1;
      duration = 30;
      currentTime = 5;
      paused = true;
      ended = false;
      constructor() {
        super();
        AudioMock.instances.push(this);
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
    vi.stubGlobal('Audio', AudioMock);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL() {
          return 'blob:test';
        }
        static override revokeObjectURL() {}
      },
    );
    vi.spyOn(mimoSpeech, 'getCached').mockResolvedValue(null);
    let finish!: () => void;
    const audio = { blob: new Blob(['test']), duration: 30 };
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValueOnce(audio)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(audio);
          }),
      );
    const { controller, view, add } = await makeController();
    try {
      await controller.speak(view.tts!.start()!);
      await vi.waitFor(() => expect(AudioMock.instances[0]?.paused).toBe(false));
      await controller.pause();
      await controller.forward(true);
      await controller.start();
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      expect(AudioMock.instances[0]!.paused).toBe(true);
      expect(generate.mock.calls[1]![0]).toBe('第二句。\n第三句。');
      finish();
      await vi.waitFor(() => expect(AudioMock.instances[1]?.paused).toBe(false));
      expect((add.mock.calls.at(-1)![1] as Range).toString()).toBe('第二句。第三句。');
    } finally {
      finish?.();
      await controller.shutdown();
    }
  });

  it('shows a sentence preview after paused manual navigation', async () => {
    const { controller, add } = await makeController();
    try {
      controller.state = 'paused';
      add.mockClear();
      await controller.forward(true);
      expect(add).toHaveBeenCalled();
      expect((add.mock.calls.at(-1)![1] as Range).toString()).toBe('第二句。');
    } finally {
      await controller.shutdown();
    }
  });

  it('waits for the audio segment before drawing a playing highlight', async () => {
    const { controller, add } = await makeController();
    try {
      add.mockClear();
      controller.state = 'playing';
      controller.dispatchSpeakMark({ name: '0', text: '第一句。', language: 'zh', offset: 0 });
      expect(add).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
    }
  });

  it('reports the same complete range that is visibly highlighted', async () => {
    const { doc, controller, segment } = await makeController();
    try {
      controller.dispatchSpeakSegment(segment);
      const cfi = controller.getCurrentPlaybackCfi()!;
      expect(CFI.toRange(doc, CFI.parse(cfi)).toString()).toBe('第一句。第二句。第三句。');
    } finally {
      await controller.shutdown();
    }
  });

  it('recognizes the visible tail of a segment after manually turning a page', async () => {
    const { controller, segment } = await makeController();
    const rect = (x: number) => ({ x, width: 20 });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: function (this: Range) {
        return [rect(this.toString().includes('第三句') ? 120 : 0)] as unknown as DOMRectList;
      },
    });
    try {
      controller.dispatchSpeakSegment(segment);
      expect(controller.isSoundingSentenceOnScreen()).toBe(true);
    } finally {
      await controller.shutdown();
      Reflect.deleteProperty(Range.prototype, 'getClientRects');
    }
  });

  it('does not synthesize unselected chapter text during selection-only playback', async () => {
    vi.useFakeTimers();
    class AudioMock extends EventTarget {
      readyState = 1;
      duration = 10;
      currentTime = 0;
      paused = true;
      ended = false;
      async play() {
        this.paused = false;
      }
      pause() {
        this.paused = true;
      }
      load() {}
      removeAttribute() {}
    }
    vi.stubGlobal('Audio', AudioMock);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL() {
          return 'blob:test';
        }
        static override revokeObjectURL() {}
      },
    );
    vi.spyOn(mimoSpeech, 'getCached').mockResolvedValue(null);
    const generate = vi
      .spyOn(mimoSpeech, 'generate')
      .mockResolvedValue({ blob: new Blob(['test']), duration: 10 });
    const client = new MiMoTTSClient();
    await client.init();
    client.prepareSection('chapter', [{ text: '未选中的章节正文。', lang: 'zh', cfi: 'a' }]);
    const abort = new AbortController();
    const playback = client
      .speak('<speak><mark name="0"/>选区文字。</speak>', abort.signal, false, true)
      [Symbol.asyncIterator]();
    await playback.next();
    const end = playback.next();
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(generate.mock.calls.map(([text]) => text)).toEqual(['选区文字。']);
    } finally {
      abort.abort();
      await end;
      await client.shutdown();
    }
  });
});
