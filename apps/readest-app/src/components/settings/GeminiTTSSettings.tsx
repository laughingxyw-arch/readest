import { useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  BoxedList,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitchRow,
  Tips,
} from './primitives';
import {
  GEMINI_VOICES,
  geminiSpeech,
  getGeminiConfig,
  getGeminiUsage,
  getGeminiRegularLimit,
  getGeminiReserveAvailable,
  grantGeminiReserveRequest,
  GEMINI_USAGE_EVENT,
  setGeminiConfig,
} from '@/services/tts/gemini';
import { TTSUtils } from '@/services/tts/TTSUtils';

export default function GeminiTTSSettings() {
  const _ = useTranslation();
  const [config, setConfig] = useState(getGeminiConfig);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState(() => ({
    used: getGeminiUsage(config),
    available: getGeminiReserveAvailable(config),
  }));
  const { used, available } = budget;
  useEffect(() => {
    const refresh = () =>
      setBudget({ used: getGeminiUsage(config), available: getGeminiReserveAvailable(config) });
    refresh();
    window.addEventListener(GEMINI_USAGE_EVENT, refresh);
    return () => window.removeEventListener(GEMINI_USAGE_EVENT, refresh);
  }, [config]);
  const update = (changes: Partial<typeof config>) => {
    setConfig({ ...config, ...changes });
    setStatus('');
  };
  const save = () => {
    try {
      if (config.enabled && !config.apiKey.trim()) {
        setStatus(_('Enter your Gemini API key first.'));
        return;
      }
      setGeminiConfig({ ...config, apiKey: config.apiKey.trim() });
      setConfig(getGeminiConfig());
      if (config.enabled) {
        TTSUtils.setPreferredClient('gemini-tts');
        TTSUtils.setPreferredVoice('gemini-tts', 'zh', `gemini:${config.voice}`);
        TTSUtils.setPreferredVoice('gemini-tts', 'en', `gemini:${config.voice}`);
      } else if (TTSUtils.getPreferredClient() === 'gemini-tts')
        TTSUtils.setPreferredClient('edge-tts');
      setStatus(_('Saved. Reopen your book to apply the speech settings.'));
    } catch {
      setStatus(_('Could not save the settings on this device.'));
    }
  };
  const clearCache = async () => {
    setBusy(true);
    try {
      await geminiSpeech.clearCache();
      setStatus(_('Gemini audio cache cleared.'));
    } catch {
      setStatus(_('Could not clear the Gemini audio cache.'));
    } finally {
      setBusy(false);
    }
  };
  const useReserve = () => {
    if (grantGeminiReserveRequest(config)) {
      geminiSpeech.retryFailedRequests();
      setStatus(_('One reserve request enabled. Start reading again to use it.'));
    }
  };
  return (
    <div className='space-y-3'>
      <BoxedList title='Gemini TTS' data-setting-id='settings.tts.gemini'>
        <SettingsSwitchRow
          label={_('Enable Gemini TTS')}
          checked={config.enabled}
          onChange={() => update({ enabled: !config.enabled })}
        />
        <SettingsRow label='API Key' asLabel>
          <SettingsInput
            aria-label='Gemini API Key'
            type='password'
            autoComplete='off'
            spellCheck={false}
            value={config.apiKey}
            placeholder={_('Your API key')}
            onChange={(e) => update({ apiKey: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow label={_('Model')}>
          <SettingsSelect
            ariaLabel={_('Gemini model')}
            value={config.model}
            onChange={(e) => update({ model: e.target.value as typeof config.model })}
            options={[
              { value: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS' },
              { value: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash-Lite TTS' },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={_('Voice')}>
          <SettingsSelect
            ariaLabel={_('Gemini voice')}
            value={config.voice}
            onChange={(e) => update({ voice: e.target.value })}
            options={GEMINI_VOICES.map((voice) => ({ value: voice, label: voice }))}
          />
        </SettingsRow>
        <SettingsRow label={_('Audio per request')}>
          <SettingsSelect
            ariaLabel={_('Audio per request')}
            value={String(config.batchMinutes)}
            onChange={(e) => update({ batchMinutes: Number(e.target.value) })}
            options={[2, 4, 6, 8, 9].map((minutes) => ({
              value: String(minutes),
              label: `${minutes} ${_('minutes')} (${_('estimated')})`,
            }))}
          />
        </SettingsRow>
        <SettingsRow
          label={_('Local daily request budget')}
          description={`${used} / ${config.dailyLimit} ${_('requests used on this device')}`}
        >
          <SettingsInput
            aria-label={_('Local daily request budget')}
            type='number'
            min={1}
            max={10000}
            value={config.dailyLimit}
            onChange={(e) => update({ dailyLimit: Number(e.target.value) || 10 })}
          />
        </SettingsRow>
        <SettingsRow
          label={_('Reserve requests')}
          description={_('{{regular}} regular requests and {{reserve}} reserve requests per day.', {
            regular: getGeminiRegularLimit(config),
            reserve: config.dailyLimit - getGeminiRegularLimit(config),
          })}
        >
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            disabled={used < getGeminiRegularLimit(config) || available === 0}
            onClick={useReserve}
          >
            {_('Use one reserve request')}
          </button>
        </SettingsRow>
        <SettingsRow
          label={_('Failed speech requests')}
          description={_('Failed requests are not retried automatically.')}
        >
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            onClick={() => {
              geminiSpeech.retryFailedRequests();
              setStatus(_('Retry enabled. Start reading again.'));
            }}
          >
            {_('Allow retry')}
          </button>
        </SettingsRow>
        <SettingsRow label={_('Save speech settings')}>
          <button type='button' className='btn btn-contrast btn-sm' onClick={save}>
            {_('Save')}
          </button>
        </SettingsRow>
        <SettingsRow label={_('Gemini audio cache')} description={_('Up to 500 MB on this device')}>
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            disabled={busy}
            onClick={clearCache}
          >
            {_('Clear')}
          </button>
        </SettingsRow>
      </BoxedList>
      {status && (
        <p role='status' className='px-4 text-sm'>
          {status}
        </p>
      )}
      <Tips title='Gemini TTS'>
        <li>
          {_(
            'Lookahead prepares at most one recording near the end of playback. It never uses reserve requests.',
          )}
        </li>
        <li>
          {_(
            'Batch length adapts to measured narration speed. Cached recordings keep their original text and can be replayed without new requests.',
          )}
        </li>
        <li>
          {_(
            'Your key stays on this device. Book text is sent directly to Google for speech generation.',
          )}
        </li>
        <li>
          {_(
            'Long recordings are cached for replay. Short chapters and navigation can use additional requests.',
          )}
        </li>
        <li>
          {_(
            'Reading position is estimated; exact text highlighting and lyrics are unavailable for Gemini.',
          )}
        </li>
        <li>
          {_(
            'The local budget resets at midnight Pacific time. AI Studio tracks the actual project quota.',
          )}
        </li>
      </Tips>
    </div>
  );
}
