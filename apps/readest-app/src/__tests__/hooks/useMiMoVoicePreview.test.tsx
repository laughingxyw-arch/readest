import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMiMoVoicePreview } from '@/app/reader/components/tts/useMiMoVoicePreview';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@/services/tts/mimo', () => ({
  getMiMoConfig: () => ({
    enabled: true,
    apiKey: 'test-key',
    model: 'mimo-v2.5-tts',
    voice: '茉莉',
    batchMinutes: 0.5,
  }),
  mimoSpeech: { generate },
}));

class TestAudio extends EventTarget {
  static players: TestAudio[] = [];
  src = '';
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  constructor() {
    super();
    TestAudio.players.push(this);
  }
}
const revoke = vi.fn();
beforeEach(() => {
  TestAudio.players = [];
  generate.mockReset().mockResolvedValue({ blob: new Blob(['wav']), duration: 3 });
  vi.stubGlobal('Audio', TestAudio);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL() {
        return 'blob:preview';
      }
      static override revokeObjectURL = revoke;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('pauses reading before generating the selected voice and reports playback state', async () => {
  const { result } = renderHook(() => useMiMoVoicePreview(true));
  const pauseReading = vi.fn(async () => {
    expect(generate).not.toHaveBeenCalled();
  });
  await act(() => result.current.play('Mia', pauseReading));
  expect(pauseReading).toHaveBeenCalledOnce();
  expect(generate).toHaveBeenCalledWith(
    '你好，欢迎使用 Readest，让每一次阅读都带给你新的发现。',
    expect.objectContaining({ voice: 'Mia' }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(TestAudio.players[0]!.play).toHaveBeenCalledOnce();
  expect(result.current.status).toBe('playing');
  act(() => TestAudio.players[0]!.dispatchEvent(new Event('ended')));
  expect(result.current.status).toBe('idle');
  expect(revoke).toHaveBeenCalledWith('blob:preview');
});

it('does not play a stale response after a newer voice is selected', async () => {
  let resolveOld!: (value: { blob: Blob; duration: number }) => void;
  generate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const { result } = renderHook(() => useMiMoVoicePreview(true));
  let old!: Promise<void>;
  act(() => {
    old = result.current.play('茉莉', async () => {});
  });
  await act(async () => {
    await Promise.resolve();
  });
  const oldSignal = generate.mock.calls[0]![2].signal as AbortSignal;
  await act(() => result.current.play('Mia', async () => {}));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => {
    resolveOld({ blob: new Blob(['old']), duration: 3 });
    await old;
  });
  expect(TestAudio.players).toHaveLength(1);
  expect(result.current.status).toBe('playing');
});

it('stops the prior sample on switching and releases audio on closing', async () => {
  const { result, rerender } = renderHook(({ active }) => useMiMoVoicePreview(active), {
    initialProps: { active: true },
  });
  await act(() => result.current.play('茉莉', async () => {}));
  await act(() => result.current.play('Mia', async () => {}));
  expect(TestAudio.players[0]!.pause).toHaveBeenCalled();
  rerender({ active: false });
  expect(TestAudio.players[1]!.pause).toHaveBeenCalled();
  expect(result.current.status).toBe('idle');
});

it('ignores pending audio after closing and permits retry after failure', async () => {
  generate.mockRejectedValueOnce(new Error('MiMo unavailable'));
  const { result } = renderHook(() => useMiMoVoicePreview(true));
  await act(() => result.current.play('Mia', async () => {}));
  expect(result.current.error).toBe('MiMo unavailable');
  expect(result.current.status).toBe('idle');
  await act(() => result.current.play('Mia', async () => {}));
  expect(result.current.error).toBeNull();
  expect(result.current.status).toBe('playing');
});

it('cancels a generation when unmounted before its response', async () => {
  let resolve!: (value: { blob: Blob; duration: number }) => void;
  generate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { result, unmount } = renderHook(() => useMiMoVoicePreview(true));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.play('Mia', async () => {});
  });
  await act(async () => {
    await Promise.resolve();
  });
  unmount();
  await act(async () => {
    resolve({ blob: new Blob(['late']), duration: 3 });
    await pending;
  });
  expect(TestAudio.players).toHaveLength(0);
});

it('retries when rapid selection reuses an aborted queued request for the same voice', async () => {
  generate.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
  const { result } = renderHook(() => useMiMoVoicePreview(true));
  await act(() => result.current.play('Mia', async () => {}));
  expect(generate).toHaveBeenCalledTimes(2);
  expect(result.current.error).toBeNull();
  expect(result.current.status).toBe('playing');
});
