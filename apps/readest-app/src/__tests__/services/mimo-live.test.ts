import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { MiMoSpeechService } from '@/services/tts/mimo';

// Explicit opt-in only. CI and ordinary tests never spend API quota.
describe.skipIf(!process.env['MIMO_TTS_LIVE_KEY'])('MiMo live API integration', () => {
  it('generates real audio with the production service and replays it from cache', async () => {
    let requests = 0;
    let usage: unknown;
    const service = new MiMoSpeechService(async (input, init) => {
      requests++;
      const response = await fetch(input, init);
      if (response.ok) usage = (await response.clone().json()).usage;
      return response;
    }, null);
    const config = {
      enabled: true,
      apiKey: process.env['MIMO_TTS_LIVE_KEY']!,
      model: 'mimo-v2.5-tts' as const,
      voice: '茉莉',
      batchMinutes: 0.5,
    };
    const text =
      '清晨，窗外的天空慢慢亮了起来。街道还很安静，远处传来几声鸟鸣。我打开一本书，开始慢慢阅读。现在，请记住这一组数字：一、二、三、四、五、六、七、八、九、十。读书的乐趣，也是享受故事慢慢展开的过程。';
    const started = Date.now();
    const audio = await service.generate(text, config);
    expect(audio.duration).toBeGreaterThan(0);
    expect(audio.duration).toBeLessThanOrEqual(120);
    expect(audio.blob.type).toBe('audio/wav');
    expect(await service.generate(text, config)).toBe(audio);
    expect(requests).toBe(1);
    const folder = process.env['MIMO_TTS_LIVE_OUTPUT'];
    if (folder) {
      await mkdir(folder, { recursive: true });
      await writeFile(`${folder}/app-mimo.wav`, Buffer.from(await audio.blob.arrayBuffer()));
      await writeFile(
        `${folder}/app-result.json`,
        JSON.stringify(
          {
            model: config.model,
            voice: config.voice,
            audio_seconds: audio.duration,
            elapsed_seconds: (Date.now() - started) / 1000,
            requests,
            usage,
          },
          null,
          2,
        ),
      );
    }
  }, 190000);
});
