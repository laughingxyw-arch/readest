import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  BoxedList,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitchRow,
  Tips,
} from './primitives';
import { MIMO_VOICES, mimoSpeech, getMiMoConfig, setMiMoConfig } from '@/services/tts/mimo';
import { TTSUtils } from '@/services/tts/TTSUtils';

export default function MiMoTTSSettings() {
  const _ = useTranslation();
  const [config, setConfig] = useState(getMiMoConfig);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (changes: Partial<typeof config>) => {
    setConfig({ ...config, ...changes });
    setStatus('');
  };
  const save = () => {
    try {
      if (config.enabled && !config.apiKey.trim()) {
        setStatus(_('Enter your MiMo API key first.'));
        return;
      }
      setMiMoConfig(config);
      const saved = getMiMoConfig();
      setConfig(saved);
      if (saved.enabled) {
        TTSUtils.setPreferredClient('mimo-tts');
        TTSUtils.setPreferredVoice('mimo-tts', 'zh', `mimo:${saved.voice}`);
        TTSUtils.setPreferredVoice('mimo-tts', 'en', `mimo:${saved.voice}`);
      } else if (TTSUtils.getPreferredClient() === 'mimo-tts') {
        TTSUtils.setPreferredClient('edge-tts');
      }
      setStatus(_('Saved. Reopen your book to apply the speech settings.'));
    } catch {
      setStatus(_('Could not save the settings on this device.'));
    }
  };
  const clearCache = async () => {
    setBusy(true);
    try {
      await mimoSpeech.clearCache();
      setStatus(_('MiMo audio cache cleared.'));
    } catch {
      setStatus(_('Could not clear the MiMo audio cache.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className='space-y-3'>
      <BoxedList title='MiMo TTS' data-setting-id='settings.tts.mimo'>
        <SettingsSwitchRow
          label={_('Enable MiMo TTS')}
          checked={config.enabled}
          onChange={() => update({ enabled: !config.enabled })}
        />
        <SettingsRow label='API Key' asLabel>
          <SettingsInput
            aria-label='MiMo API Key'
            type='password'
            autoComplete='off'
            spellCheck={false}
            value={config.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow label={_('Model')}>
          <span>MiMo V2.5 TTS</span>
        </SettingsRow>
        <SettingsRow label={_('Voice')}>
          <SettingsSelect
            ariaLabel={_('MiMo voice')}
            value={config.voice}
            options={MIMO_VOICES.map((voice) => ({ value: voice, label: voice }))}
            onChange={(event) => update({ voice: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label={_('Speech batch length')}
          description={_(
            'Shorter batches start sooner. Actual audio duration varies with narration speed.',
          )}
        >
          <SettingsSelect
            ariaLabel={_('Speech batch length')}
            value={String(config.batchMinutes)}
            options={[0.25, 0.5, 1, 2].map((value) => ({
              value: String(value),
              label: `${value * 60} ${_('seconds')}`,
            }))}
            onChange={(event) => update({ batchMinutes: Number(event.target.value) })}
          />
        </SettingsRow>
        <SettingsRow label={_('Save speech settings')}>
          <button type='button' className='btn btn-contrast btn-sm' onClick={save}>
            {_('Save')}
          </button>
        </SettingsRow>
        <SettingsRow label={_('MiMo audio cache')} description={_('Up to 500 MB on this device')}>
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
      <Tips title='MiMo TTS'>
        <li>
          {_(
            'Your key stays on this device. Book text is sent directly to Xiaomi MiMo for speech generation.',
          )}
        </li>
        <li>
          {_(
            'MiMo reading has no local daily request budget. Service pricing and limits follow your MiMo account.',
          )}
        </li>
        <li>
          {_(
            'Playback prepares one recording ahead. Cached audio can be replayed without generating it again.',
          )}
        </li>
        <li>
          {_(
            'Reading position is estimated; exact text highlighting and lyrics are unavailable for MiMo.',
          )}
        </li>
      </Tips>
    </div>
  );
}
