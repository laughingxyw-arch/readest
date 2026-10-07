import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MiMoTTSSettings from '@/components/settings/MiMoTTSSettings';
import { getMiMoConfig, mimoSpeech } from '@/services/tts/mimo';
import { TTSUtils } from '@/services/tts/TTSUtils';
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
afterEach(cleanup);
describe('MiMo speech settings', () => {
  it('requires a key before enabling MiMo', () => {
    render(<MiMoTTSSettings />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable MiMo TTS' }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(screen.getByRole('status').textContent).toContain('Enter your MiMo API key first');
    expect(getMiMoConfig().enabled).toBe(false);
  });
  it('saves a trimmed key and selects MiMo; disabling it restores Edge', () => {
    const generate = vi.spyOn(mimoSpeech, 'generate');
    render(<MiMoTTSSettings />);
    fireEvent.change(screen.getByLabelText('MiMo API Key'), { target: { value: ' test-key。 ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable MiMo TTS' }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(getMiMoConfig()).toMatchObject({
      enabled: true,
      apiKey: 'test-key',
      voice: '茉莉',
      batchMinutes: 0.5,
    });
    expect(TTSUtils.getPreferredClient()).toBe('mimo-tts');
    expect(generate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Allow retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use one reserve request' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable MiMo TTS' }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(TTSUtils.getPreferredClient()).toBe('edge-tts');
  });
  it('clears the MiMo recording cache without generating audio', async () => {
    const clear = vi.spyOn(mimoSpeech, 'clearCache').mockResolvedValue();
    const generate = vi.spyOn(mimoSpeech, 'generate');
    render(<MiMoTTSSettings />);
    fireEvent.click(screen.getByRole('button', { name: /^Clear$/ }));
    await screen.findByText('MiMo audio cache cleared.');
    expect(clear).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });
});
