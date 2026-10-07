import { md5 } from 'js-md5';
import { getAIFetch } from '@/services/ai/utils/httpFetch';

const CONFIG_KEY = 'readest-mimo-tts';
const ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
export const MIMO_VOICES = [
  '茉莉',
  '冰糖',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
] as const;
export interface MiMoConfig {
  enabled: boolean;
  apiKey: string;
  model: 'mimo-v2.5-tts';
  voice: string;
  batchMinutes: number;
}
const defaults: MiMoConfig = {
  enabled: false,
  apiKey: '',
  model: 'mimo-v2.5-tts',
  voice: '茉莉',
  batchMinutes: 0.5,
};
export function getMiMoConfig(): MiMoConfig {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') as Partial<MiMoConfig>;
    return {
      enabled: value.enabled === true,
      apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim().replace(/[。．]+$/, '') : '',
      model: defaults.model,
      voice: MIMO_VOICES.includes(value.voice as (typeof MIMO_VOICES)[number])
        ? value.voice!
        : defaults.voice,
      batchMinutes: Math.min(
        2,
        Math.max(0.25, Number(value.batchMinutes) || defaults.batchMinutes),
      ),
    };
  } catch {
    return { ...defaults };
  }
}
// Device-local only; API keys are not included in settings sync or export.
export function setMiMoConfig(config: MiMoConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export interface MiMoSentence {
  text: string;
  lang: string;
  cfi?: string;
}
export interface MiMoBatch {
  sentences: MiMoSentence[];
  estimatedSeconds: number;
}
export function estimateMiMoSeconds(text: string): number {
  const cjk =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length || 0;
  const words =
    text
      .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
      .match(/[\p{L}\p{N}]+/gu)?.length || 0;
  return Math.max(0.2, cjk / 4.5 + words / 2.5);
}

export function buildMiMoBatches(
  sentences: MiMoSentence[],
  minutes: number,
  durationScale = 1,
): MiMoBatch[] {
  const batches: MiMoBatch[] = [];
  let batch: MiMoBatch = { sentences: [], estimatedSeconds: 0 };
  let chars = 0;
  for (const sentence of sentences) {
    if (!sentence.text.trim()) continue;
    const seconds = estimateMiMoSeconds(sentence.text);
    if (
      batch.sentences.length &&
      ((batch.estimatedSeconds + seconds) * durationScale > minutes * 60 ||
        chars + sentence.text.length > 2000)
    ) {
      batches.push(batch);
      batch = { sentences: [], estimatedSeconds: 0 };
      chars = 0;
    }
    if (sentence.text.length > 2000)
      throw new Error(
        'A single sentence is too long for a MiMo speech batch. Split this text into sentences first.',
      );
    batch.sentences.push(sentence);
    batch.estimatedSeconds += seconds;
    chars += sentence.text.length;
  }
  if (batch.sentences.length) batches.push(batch);
  return batches;
}

export interface MiMoAudio {
  blob: Blob;
  duration: number;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
export function decodeMiMoAudio(response: unknown): MiMoAudio {
  const choices = record(response)?.['choices'];
  const message = Array.isArray(choices) ? record(record(choices[0])?.['message']) : null;
  const encoded = record(message?.['audio'])?.['data'];
  if (typeof encoded !== 'string' || !encoded) throw new Error('MiMo returned no audio.');
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const tag = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw new Error('MiMo returned an invalid WAV file.');
  let bytesPerSecond = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > bytes.length) throw new Error('MiMo returned a truncated WAV file.');
    if (tag(offset) === 'fmt ' && size >= 16) bytesPerSecond = view.getUint32(offset + 16, true);
    if (tag(offset) === 'data') dataBytes += size;
    offset += 8 + size + (size % 2);
  }
  if (!bytesPerSecond || !dataBytes) throw new Error('MiMo returned empty audio.');
  return { blob: new Blob([bytes], { type: 'audio/wav' }), duration: dataBytes / bytesPerSecond };
}

interface CachedAudio extends MiMoAudio {
  key: string;
  updated: number;
}
export class MiMoAudioCache {
  async #database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('readest-mimo-audio', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('audio', { keyPath: 'key' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  async get(key: string): Promise<MiMoAudio | null> {
    const db = await this.#database();
    try {
      return await new Promise((resolve, reject) => {
        const r = db.transaction('audio').objectStore('audio').get(key);
        r.onsuccess = () => resolve((r.result as CachedAudio | undefined) || null);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  }
  async put(key: string, audio: MiMoAudio): Promise<void> {
    const db = await this.#database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('audio', 'readwrite');
        const store = tx.objectStore('audio');
        store.put({ key, ...audio, updated: Date.now() } satisfies CachedAudio);
        const r = store.getAll();
        r.onsuccess = () => {
          const rows = (r.result as CachedAudio[]).sort((a, b) => b.updated - a.updated);
          let size = 0;
          for (const row of rows) {
            size += row.blob.size;
            if (size > 500 * 1024 * 1024) store.delete(row.key);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  async clear(): Promise<void> {
    const db = await this.#database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('audio', 'readwrite');
        tx.objectStore('audio').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
}

const durationKey = (config: MiMoConfig, lang: string) =>
  `readest-mimo-duration-${md5(JSON.stringify([config.model, config.voice, lang]))}`;
export function getMiMoDurationScale(config: MiMoConfig, lang: string): number {
  const value = Number(localStorage.getItem(durationKey(config, lang))) || 1;
  return Math.min(2.5, Math.max(0.5, value));
}
export function recordMiMoDurationScale(
  config: MiMoConfig,
  lang: string,
  actual: number,
  estimated: number,
): void {
  // Tiny chapter headings are dominated by pauses and cannot calibrate pace.
  if (actual <= 0 || estimated < 15) return;
  const key = durationKey(config, lang);
  const previous = localStorage.getItem(key);
  const observed = Math.min(2.5, Math.max(0.5, actual / estimated));
  const scale = previous ? getMiMoDurationScale(config, lang) * 0.7 + observed * 0.3 : observed;
  try {
    localStorage.setItem(key, String(scale));
  } catch {
    /* Playback works without calibration storage. */
  }
}

const STYLE = '请以自然、清晰、正常的中文朗读语速读出文本，不要额外添加内容。';
interface MiMoGenerationOptions {
  preload?: boolean;
  signal?: AbortSignal;
  beforeRequest?: () => Promise<void>;
}
export class MiMoAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`MiMo TTS (${status}): ${message}`);
    this.name = 'MiMoAPIError';
  }
}
export class MiMoSpeechService {
  #pending = new Map<string, Promise<MiMoAudio>>();
  #memory = new Map<string, MiMoAudio>();
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    private fetcher: typeof fetch = (...args) => getAIFetch()(...args),
    private cache: MiMoAudioCache | null = typeof indexedDB === 'undefined'
      ? null
      : new MiMoAudioCache(),
  ) {}
  #key(text: string, config: MiMoConfig): string {
    return md5(JSON.stringify([config.model, config.voice, STYLE, text]));
  }
  async getCached(text: string, config: MiMoConfig): Promise<MiMoAudio | null> {
    const key = this.#key(text, config);
    const cached = this.#memory.get(key) || (await this.cache?.get(key).catch(() => null));
    if (cached) this.#remember(key, cached);
    return cached || null;
  }
  generate(
    text: string,
    config: MiMoConfig,
    options: MiMoGenerationOptions = {},
  ): Promise<MiMoAudio> {
    const key = this.#key(text, config);
    const pendingKey = `${key}:${md5(config.apiKey)}`;
    const memory = this.#memory.get(key);
    if (memory) return Promise.resolve(memory);
    const pending = this.#pending.get(pendingKey);
    if (pending) return pending;
    const promise = this.getCached(text, config).then((cached) => {
      if (cached) return cached;
      const queued = this.#queue
        .catch(() => {})
        .then(async () => {
          const cached = await this.getCached(text, config);
          if (cached) return cached;
          await options.beforeRequest?.();
          if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          if (!config.apiKey) throw new Error('Set your MiMo API key in Settings → TTS first.');
          // Once sent, finish and cache the recording even if playback is stopped.
          // Use an explicit timer: native HTTP must receive an actual abort event.
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(), 180000);
          try {
            const response = await this.fetcher(ENDPOINT, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`,
              },
              body: JSON.stringify({
                model: config.model,
                messages: [
                  { role: 'user', content: STYLE },
                  { role: 'assistant', content: text },
                ],
                audio: { format: 'wav', voice: config.voice },
                stream: false,
              }),
              signal: timeout.signal,
            });
            if (!response.ok) {
              const raw = await response.text();
              let message = '';
              try {
                const parsed = record(JSON.parse(raw));
                const detail = record(parsed?.['error']);
                const candidate = detail?.['message'] || parsed?.['message'] || parsed?.['detail'];
                if (typeof candidate === 'string') message = candidate;
              } catch {
                /* Non-JSON upstream failures still include the HTTP status. */
              }
              if (!message)
                message =
                  response.status === 429
                    ? 'Too many requests or insufficient quota. Check your MiMo account.'
                    : response.status === 401 || response.status === 403
                      ? 'Authentication or access denied. Check your MiMo API key and account.'
                      : response.status === 400
                        ? 'MiMo rejected this speech request.'
                        : 'MiMo speech generation failed. Please try again.';
              message = message
                .split(config.apiKey)
                .join('[redacted]')
                .replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]')
                .slice(0, 600);
              throw new MiMoAPIError(response.status, message);
            }
            const audio = decodeMiMoAudio(await response.json());
            await this.cache?.put(key, audio).catch(() => {});
            this.#remember(key, audio);
            return audio;
          } catch (error) {
            if (timeout.signal.aborted)
              throw new Error('MiMo speech generation timed out. Please try again.');
            throw error;
          } finally {
            clearTimeout(timer);
          }
        });
      this.#queue = queued;
      return queued;
    });
    this.#pending.set(pendingKey, promise);
    const cleanup = () => {
      if (this.#pending.get(pendingKey) === promise) this.#pending.delete(pendingKey);
    };
    // Failures do not lock subsequent user retries; there is no daily request budget.
    void promise.then(cleanup, cleanup);
    return promise;
  }
  #remember(key: string, audio: MiMoAudio): void {
    this.#memory.set(key, audio);
    while (this.#memory.size > 3) this.#memory.delete(this.#memory.keys().next().value!);
  }
  async clearCache(): Promise<void> {
    this.#memory.clear();
    await this.cache?.clear();
  }
}
export const mimoSpeech = new MiMoSpeechService();
