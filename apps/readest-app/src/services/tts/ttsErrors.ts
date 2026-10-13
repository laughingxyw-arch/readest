import { stubTranslation as _ } from '@/utils/misc';
import { getMiMoConfig, MiMoAPIError } from './mimo';

export interface TTSFailure {
  message: string;
  detail: string;
}

export function getTTSFailure(error: unknown, apiKey = getMiMoConfig().apiKey): TTSFailure {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // Never display saved credentials, even if a transport echoes them in an error.
  const detail = (apiKey ? raw.split(apiKey).join('[redacted]') : raw)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]')
    .slice(0, 1000);
  let message = _('Read aloud failed. See the details below.');
  if (error instanceof MiMoAPIError) {
    if (error.status === 401 || error.status === 403)
      message = _(
        'MiMo denied access. Check your API key and account permissions in Settings → TTS.',
      );
    else if (error.status === 429)
      message = _(
        'MiMo rejected the request due to a rate or quota limit. Check your account quota or try again later.',
      );
    else if (error.status >= 500) message = _('MiMo service failed. Please try again later.');
    else message = _('MiMo rejected the speech request. See the server details below.');
  } else if (/timed out|timeout/i.test(raw)) {
    message = _('The speech request timed out. Check your network and try again.');
  } else if (/speech request was interrupted/i.test(raw)) {
    message = _('The speech request was interrupted. Please try again.');
  } else if (
    /failed to fetch|fetch failed|load failed|error sending request|network|connection|dns|offline/i.test(
      raw,
    )
  ) {
    message = _('Could not reach the speech service. Check your network and try again.');
  } else if (
    /audio|WAV|NotAllowedError/i.test(raw) ||
    (error instanceof Error && error.name === 'NotAllowedError')
  ) {
    message = _('The generated audio could not be played. Please start reading again.');
  } else if (/API key/i.test(raw)) {
    message = _('Check your MiMo API key and enable MiMo TTS in Settings → TTS.');
  }
  return { message, detail };
}
