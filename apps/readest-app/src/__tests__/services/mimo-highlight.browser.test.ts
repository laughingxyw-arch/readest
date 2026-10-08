import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/services/constants';
import { TTSController } from '@/services/tts/TTSController';
import { getMiMoConfig, setMiMoConfig } from '@/services/tts/mimo';
import type { FoliateView } from '@/types/view';
import { Overlayer } from 'foliate-js/overlayer.js';
import * as CFI from 'foliate-js/epubcfi.js';

// Edge is not used here; avoid its environment/constants import cycle.
vi.mock('@/services/tts/EdgeTTSClient', () => ({
  DEFAULT_SENTENCE_GAP_SEC: 0.15,
  EdgeTTSClient: class {
    initialized = false;
  },
}));

afterEach(() => {
  localStorage.removeItem('readest-mimo-tts');
});

describe('MiMo segment visibility in Chromium', () => {
  it('keeps the segment visible when only its second page is on screen', async () => {
    setMiMoConfig({ ...getMiMoConfig(), enabled: true, apiKey: 'test-key' });
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:200px;height:160px;border:0';
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.documentElement.innerHTML =
      '<head><style>body{margin:0;display:flex;width:400px}p{margin:0;flex:0 0 200px}</style></head><body><p>第一句。第二句。</p><p>第三句。</p></body>';
    doc.documentElement.lang = 'zh';
    const add = vi.fn();
    const view = {
      book: { sections: [{ id: '0', createDocument: async () => doc }] },
      language: { isCJK: true },
      renderer: {
        primaryIndex: 0,
        sideProp: 'width',
        start: 200,
        end: 400,
        getContents: () => [{ index: 0, doc, overlayer: { add, remove: vi.fn() } }],
      },
      getCFI: (_index: number, range: Range) => CFI.fromRange(range),
      resolveCFI: (cfi: string) => ({
        anchor: (target: Document) => CFI.toRange(target, CFI.parse(cfi)),
      }),
    } as unknown as FoliateView;
    const controller = new TTSController(null, view);
    try {
      controller.ttsClient = controller.ttsMiMoClient;
      await controller.ttsMiMoClient.init();
      await controller.initViewTTS(0);
      view.tts!.start();
      controller.dispatchSpeakMark({ name: '0', text: '第一句。', language: 'zh', offset: 0 });
      const first = doc.createRange();
      first.selectNodeContents(doc.querySelectorAll('p')[0]!);
      const last = doc.createRange();
      last.selectNodeContents(doc.querySelectorAll('p')[1]!);
      expect(first.getBoundingClientRect().right).toBeLessThanOrEqual(200);
      expect(last.getBoundingClientRect().left).toBeGreaterThanOrEqual(200);
      controller.dispatchSpeakSegment({
        startCFI: CFI.fromRange(first),
        endCFI: CFI.fromRange(last),
      });
      expect(controller.isSoundingSentenceOnScreen()).toBe(true);
      const current = CFI.toRange(doc, CFI.parse(controller.getCurrentPlaybackCfi()!));
      expect(current.toString()).toBe('第一句。第二句。第三句。');
      add.mockClear();
      controller.reapplyCurrentHighlight();
      expect((add.mock.calls.at(-1)![1] as Range).toString()).toBe(current.toString());
    } finally {
      await controller.shutdown();
      frame.remove();
    }
  });
});

it('keeps paused MiMo line hit targets and annotation priority in a real iframe', async () => {
  setMiMoConfig({ ...getMiMoConfig(), enabled: true, apiKey: 'test-key' });
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:220px;height:200px;border:0;margin:30px';
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.documentElement.innerHTML =
    '<head><style>body{margin:10px;font:18px sans-serif}p{width:160px;margin:0 0 30px}</style></head><body><p>这是一段正在朗读的文字，跨越几行来检查点击范围。</p><p>下一段文字。</p></body>';
  const overlayer = new Overlayer(doc);
  doc.body.append(overlayer.element);
  const view = {
    book: { sections: [{ id: '0', createDocument: async () => doc }] },
    language: { isCJK: true },
    renderer: { primaryIndex: 0, getContents: () => [{ index: 0, doc, overlayer }] },
    getCFI: (_index: number, range: Range) => CFI.fromRange(range),
    resolveCFI: (cfi: string) => ({
      anchor: (target: Document) => CFI.toRange(target, CFI.parse(cfi)),
    }),
  } as unknown as FoliateView;
  const controller = new TTSController(null, view);
  try {
    controller.ttsClient = controller.ttsMiMoClient;
    await controller.ttsMiMoClient.init();
    await controller.initViewTTS(0);
    controller.updateHighlightOptions({ style: 'highlight', color: '#ffff00' });
    view.tts!.start();
    controller.dispatchSpeakMark({ name: '0', text: '这是一段', language: 'zh', offset: 0 });
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector('p')!);
    controller.state = 'playing';
    controller.dispatchSpeakSegment({
      startCFI: CFI.fromRange(range),
      endCFI: CFI.fromRange(range),
    });
    const line = range.getClientRects()[0]!;
    const x = line.left + 5;
    const y = line.top + 5;
    expect(controller.isHighlightAt(doc, x, y)).toBe(true);
    expect(controller.isHighlightAt(doc, 210, y)).toBe(false);
    expect(controller.isHighlightAt(doc, x, range.getBoundingClientRect().bottom + 10)).toBe(false);
    await controller.pause();
    expect(controller.isHighlightAt(doc, x, y)).toBe(true);
    expect(getComputedStyle(overlayer.element.querySelector('[data-tts-highlight]')!).filter).toBe(
      'brightness(0.55)',
    );
    await controller.resume();
    expect(getComputedStyle(overlayer.element.querySelector('[data-tts-highlight]')!).filter).toBe(
      'none',
    );
    overlayer.add('epubcfi(annotation)', range, Overlayer.highlight, { color: 'red' });
    controller.reapplyCurrentHighlight();
    expect(controller.isHighlightAt(doc, x, y)).toBe(false);
    expect(overlayer.hitTest({ x, y }, (key: string) => key !== 'tts-highlight')[0]).toBe(
      'epubcfi(annotation)',
    );
  } finally {
    await controller.shutdown();
    frame.remove();
  }
});
