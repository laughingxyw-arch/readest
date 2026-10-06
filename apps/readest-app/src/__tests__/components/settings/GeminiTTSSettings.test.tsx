import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import GeminiTTSSettings from '@/components/settings/GeminiTTSSettings';
import { getGeminiConfig } from '@/services/tts/gemini';
import { TTSUtils } from '@/services/tts/TTSUtils';

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('Gemini speech settings', () => {
  it('requires a key before enabling the provider', () => {
    render(<GeminiTTSSettings />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Gemini TTS' }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(screen.getByRole('status').textContent).toContain('Enter your Gemini API key');
    expect(getGeminiConfig().enabled).toBe(false);
  });

  it('saves a device-local key and selects Gemini as the preferred provider', () => {
    render(<GeminiTTSSettings />);
    const key = screen.getByLabelText('Gemini API Key');
    expect(key.getAttribute('type')).toBe('password');
    fireEvent.change(key, { target: { value: '  my-test-key  ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Gemini TTS' }));
    fireEvent.change(screen.getByLabelText('Gemini voice'), { target: { value: 'Charon' } });
    fireEvent.change(screen.getByLabelText('Audio per request'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(getGeminiConfig()).toMatchObject({
      enabled: true,
      apiKey: 'my-test-key',
      voice: 'Charon',
      batchMinutes: 9,
    });
    expect(TTSUtils.getPreferredClient()).toBe('gemini-tts');
    expect(TTSUtils.getPreferredVoice('gemini-tts', 'zh')).toBe('gemini:Charon');
    expect(screen.getByRole('status').textContent).toContain('Saved');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Gemini TTS' }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(TTSUtils.getPreferredClient()).toBe('edge-tts');
  });
});
