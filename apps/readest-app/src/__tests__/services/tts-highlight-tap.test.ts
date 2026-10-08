import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Overlayer } from 'foliate-js/overlayer.js';
import * as CFI from 'foliate-js/epubcfi.js';
import { TTSController } from '@/services/tts/TTSController';
import type { FoliateView } from '@/types/view';

const rect = new DOMRect(20, 30, 100, 18);
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
beforeEach(() =>
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [rect],
  }),
);
afterEach(() => {
  vi.restoreAllMocks();
  if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
});

async function setup() {
  const doc = new DOMParser().parseFromString('<p>正在朗读的文字。</p>', 'text/html');
  const overlayer = new Overlayer(doc);
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
  controller.updateHighlightOptions({ style: 'highlight', color: '#ffff00' });
  controller.setHighlightGranularity('sentence');
  await controller.initViewTTS(0);
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('p')!);
  vi.spyOn(view.tts!, 'getLastRange').mockReturnValue(range);
  vi.spyOn(controller.ttsClient, 'pause').mockResolvedValue(true);
  vi.spyOn(controller.ttsClient, 'resume').mockResolvedValue(true);
  controller.state = 'playing';
  controller.reapplyCurrentHighlight();
  return { controller, doc, overlayer, range };
}

describe('current TTS highlight tap', () => {
  it('hits only the current document and painted line, while playing or paused', async () => {
    const { controller, doc } = await setup();
    expect(controller.isHighlightAt(doc, 40, 35)).toBe(true);
    expect(controller.isHighlightAt(doc, 15, 35)).toBe(false);
    expect(controller.isHighlightAt(doc, 40, 60)).toBe(false);
    expect(controller.isHighlightAt(document, 40, 35)).toBe(false);
    await controller.pause();
    expect(controller.isHighlightAt(doc, 40, 35)).toBe(true);
    controller.state = 'stopped';
    expect(controller.isHighlightAt(doc, 40, 35)).toBe(false);
  });

  it('keeps paused geometry and dims its color, then restores the configured color', async () => {
    const { controller, overlayer } = await setup();
    expect(overlayer.element.querySelector('g[fill]')?.getAttribute('fill')).toBe('#ffff00');
    await controller.pause();
    expect(
      (overlayer.element as SVGElement).querySelector<SVGElement>('[data-tts-highlight]')?.style
        .filter,
    ).toBe('brightness(0.55)');
    await controller.resume();
    expect(
      (overlayer.element as SVGElement).querySelector<SVGElement>('[data-tts-highlight]')?.style
        .filter,
    ).toBe('');
    expect(overlayer.element.querySelector('g[fill]')?.getAttribute('fill')).toBe('#ffff00');
  });

  it('gives annotations priority even when TTS was drawn last', async () => {
    const { controller, doc, overlayer, range } = await setup();
    overlayer.add('epubcfi(annotation)', range, Overlayer.highlight, { color: 'red' });
    controller.reapplyCurrentHighlight();
    expect(controller.isHighlightAt(doc, 40, 35)).toBe(false);
    expect(overlayer.hitTest({ x: 40, y: 35 }, (key: string) => key !== 'tts-highlight')[0]).toBe(
      'epubcfi(annotation)',
    );
  });
});
