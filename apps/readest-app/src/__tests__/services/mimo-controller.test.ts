import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTSController } from '@/services/tts/TTSController';
import { getMiMoConfig, setMiMoConfig } from '@/services/tts/mimo';
import type { FoliateView } from '@/types/view';
import * as CFI from 'foliate-js/epubcfi.js';

beforeEach(() => {
  localStorage.clear();
  setMiMoConfig({ ...getMiMoConfig(), enabled: true, apiKey: 'test-key' });
});
afterEach(() => vi.restoreAllMocks());

describe('MiMo chapter preparation with real text iterators', () => {
  it('draws the complete segment and resumes at the next CFI without replaying merged paragraphs', async () => {
    const doc = new DOMParser().parseFromString(
      '<html lang="zh"><body><p>第一句。第二句。</p><p>第三句。</p><p>' +
        '山'.repeat(140) +
        '。</p></body></html>',
      'text/html',
    );
    const add = vi.fn();
    const view = {
      book: { sections: [{ id: '0', createDocument: async () => doc }] },
      language: { isCJK: true },
      renderer: {
        primaryIndex: 0,
        getContents: () => [{ index: 0, doc, overlayer: { add, remove: vi.fn() } }],
      },
      getCFI: (_index: number, range: Range) => CFI.fromRange(range),
      resolveCFI: (cfi: string) => ({
        anchor: (target: Document) => CFI.toRange(target, CFI.parse(cfi)),
      }),
    } as unknown as FoliateView;
    const controller = new TTSController(null, view);
    controller.bookKey = 'bookhash-segments';
    controller.ttsClient = controller.ttsMiMoClient;
    await controller.ttsMiMoClient.init();
    const sent: string[] = [];
    let finish!: () => void;
    let begin!: () => void;
    vi.spyOn(controller.ttsMiMoClient, 'speak').mockImplementation(async function* (ssml, signal) {
      sent.push(ssml);
      const paragraphs = doc.querySelectorAll('p');
      const start = doc.createRange();
      start.selectNodeContents(paragraphs[0]!);
      const end = doc.createRange();
      end.selectNodeContents(paragraphs[1]!);
      const next = doc.createRange();
      next.selectNodeContents(paragraphs[2]!);
      if (sent.length === 1) {
        await new Promise<void>((resolve) => {
          begin = resolve;
        });
        yield {
          code: 'boundary',
          mark: '0',
          segment: {
            startCFI: CFI.fromRange(start),
            endCFI: CFI.fromRange(end),
            nextCFI: CFI.fromRange(next),
          },
        };
        await new Promise<void>((resolve) => {
          finish = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (!signal.aborted) yield { code: 'end' };
      } else {
        yield {
          code: 'boundary',
          mark: '0',
          segment: { startCFI: CFI.fromRange(next), endCFI: CFI.fromRange(next) },
        };
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
    });
    await controller.initViewTTS(0);
    void controller.speak(view.tts!.start()!);
    await vi.waitFor(() => expect(begin).toBeTypeOf('function'));
    await controller.pause();
    begin();
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
    expect((add.mock.calls.at(-1)![1] as Range).toString()).toBe('第一句。第二句。第三句。');
    expect(controller.state).toBe('paused');
    controller.reapplyCurrentHighlight();
    expect((add.mock.calls.at(-1)![1] as Range).toString()).toBe('第一句。第二句。第三句。');
    await controller.resume();
    finish();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toContain('山'.repeat(140));
    expect(sent[1]).not.toContain('第三句');
    expect((add.mock.calls.at(-1)![1] as Range).toString()).toBe('山'.repeat(140) + '。');
    await controller.shutdown();
  });

  it('combines short chapters and reuses the same preparation window when reopened in the next chapter', async () => {
    const docs = ['First chapter.', 'Second chapter.', 'Third chapter.'].map((text) =>
      new DOMParser().parseFromString(
        `<html lang="en"><body><p>${text}</p></body></html>`,
        'text/html',
      ),
    );
    const sections = docs.map((doc, index) => ({
      id: String(index),
      createDocument: vi.fn(async () => doc),
    }));
    const makeController = async (index: number) => {
      const view = {
        book: { sections },
        language: { isCJK: false },
        renderer: {
          primaryIndex: index,
          getContents: () => [{ index, doc: docs[index], overlayer: { remove: vi.fn() } }],
        },
        getCFI: () => 'cfi',
      } as unknown as FoliateView;
      const controller = new TTSController(null, view);
      controller.bookKey = 'bookhash-window';
      controller.ttsClient = controller.ttsMiMoClient;
      await controller.ttsMiMoClient.init();
      const prepare = vi.spyOn(controller.ttsMiMoClient, 'prepareSection');
      vi.spyOn(controller.ttsMiMoClient, 'speak').mockImplementation(async function* () {
        yield { code: 'boundary', mark: '0' };
      });
      await controller.initViewTTS(index);
      await controller.speak(view.tts!.start()!);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      return { controller, prepare };
    };
    const first = await makeController(0);
    expect(first.prepare).toHaveBeenCalledOnce();
    const [id, sentences, following] = first.prepare.mock.calls[0]!;
    expect(id).toContain('bookhash:0:');
    expect(sentences.map((sentence) => sentence.text).join('')).toContain('First chapter.');
    expect(
      following!
        .flatMap((section) => section.sentences)
        .map((sentence) => sentence.text)
        .join(''),
    ).toContain('Second chapter.');
    await first.controller.shutdown();
    const reopened = await makeController(1);
    expect(reopened.prepare.mock.calls[0]).toEqual(first.prepare.mock.calls[0]);
    expect(reopened.controller.ttsMiMoClient.activateSection('bookhash:1:::false')).toBe(true);
    await reopened.controller.shutdown();
  });
});
