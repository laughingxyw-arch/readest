import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTSController } from '@/services/tts/TTSController';
import { getMiMoConfig, setMiMoConfig } from '@/services/tts/mimo';
import type { FoliateView } from '@/types/view';

beforeEach(() => {
  localStorage.clear();
  setMiMoConfig({ ...getMiMoConfig(), enabled: true, apiKey: 'test-key' });
});
afterEach(() => vi.restoreAllMocks());

describe('MiMo chapter preparation with real text iterators', () => {
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
