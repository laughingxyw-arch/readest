import { describe, expect, it } from 'vitest';
import { getTTSFailure } from '@/services/tts/ttsErrors';
import { MiMoAPIError } from '@/services/tts/mimo';

describe('read aloud failure details', () => {
  it.each([401, 403, 429, 400, 503])('keeps HTTP %s and upstream details', (status) => {
    const failure = getTTSFailure(new MiMoAPIError(status, 'upstream request rejected'));
    expect(failure.detail).toContain(String(status));
    expect(failure.detail).toContain('upstream request rejected');
    expect(failure.message).not.toBe('Read aloud failed. See the details below.');
  });

  it('does not claim that an authentication failure proves key expiration', () => {
    expect(getTTSFailure(new MiMoAPIError(401, 'Unauthorized')).message).toContain('API key');
    expect(getTTSFailure(new MiMoAPIError(401, 'Unauthorized')).message).not.toContain('expired');
  });

  it('distinguishes generation timeout, network failure and audio playback failure', () => {
    expect(
      getTTSFailure(new Error('MiMo speech generation timed out. Please try again.')).message,
    ).toContain('timed out');
    expect(getTTSFailure(new TypeError('Failed to fetch')).message).toContain('network');
    expect(
      getTTSFailure(new Error('MiMo audio is not progressing. Please start reading again.'))
        .message,
    ).toContain('audio');
  });

  it('redacts saved keys and bearer credentials before displaying bounded details', () => {
    const failure = getTTSFailure(
      new Error('secret-local sk-other-secret Bearer abc.def\n' + 'x'.repeat(2000)),
      'secret-local',
    );
    expect(failure.detail).not.toContain('secret-local');
    expect(failure.detail).not.toContain('sk-other-secret');
    expect(failure.detail).not.toContain('abc.def');
    expect(failure.detail.length).toBeLessThanOrEqual(1000);
  });

  it('handles missing error details without inventing a cause', () => {
    expect(getTTSFailure(undefined)).toEqual({
      message: 'Read aloud failed. See the details below.',
      detail: '',
    });
  });
});
