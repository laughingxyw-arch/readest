import { useCallback, useEffect, useRef, useState } from 'react';
import { getMiMoConfig, mimoSpeech, type MiMoAudio } from '@/services/tts/mimo';

export const MIMO_VOICE_SAMPLE = '你好，欢迎使用 Readest，让每一次阅读都带给你新的发现。';

export function useMiMoVoicePreview(active: boolean) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);

  const release = useCallback(() => {
    request.current?.abort();
    request.current = null;
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute('src');
      audio.current.load();
      audio.current = null;
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  }, []);

  const stop = useCallback(() => {
    release();
    setStatus('idle');
    setError(null);
  }, [release]);

  useEffect(() => {
    if (!active) stop();
    return release;
  }, [active, release, stop]);

  const play = useCallback(
    async (voice: string, beforePlay: (signal: AbortSignal) => Promise<void>) => {
      stop();
      const current = new AbortController();
      request.current = current;
      setStatus('loading');
      try {
        await beforePlay(current.signal);
        if (current.signal.aborted) return;
        const config = { ...getMiMoConfig(), voice };
        const options = { signal: current.signal };
        let generated: MiMoAudio;
        try {
          generated = await mimoSpeech.generate(MIMO_VOICE_SAMPLE, config, options);
        } catch (cause) {
          // A→B→A can share A's still-pending, cancelled queue entry. Retry
          // once after that entry settles, only for the current selection.
          if (
            current.signal.aborted ||
            !(cause instanceof Error || cause instanceof DOMException) ||
            cause.name !== 'AbortError'
          )
            throw cause;
          generated = await mimoSpeech.generate(MIMO_VOICE_SAMPLE, config, options);
        }
        if (current.signal.aborted) return;
        const player = new Audio();
        audio.current = player;
        url.current = URL.createObjectURL(generated.blob);
        player.src = url.current;
        player.addEventListener(
          'ended',
          () => {
            if (request.current === current) stop();
          },
          { once: true },
        );
        player.addEventListener(
          'error',
          () => {
            if (request.current !== current) return;
            release();
            setStatus('idle');
            setError('Could not play voice preview. Please try again.');
          },
          { once: true },
        );
        await player.play();
        if (!current.signal.aborted) setStatus('playing');
      } catch (cause) {
        if (current.signal.aborted) return;
        release();
        setStatus('idle');
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not play voice preview. Please try again.',
        );
      }
    },
    [release, stop],
  );

  return { play, stop, status, error };
}
