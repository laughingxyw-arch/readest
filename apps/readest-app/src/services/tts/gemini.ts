import { md5 } from 'js-md5';

const CONFIG_KEY = 'readest-gemini-tts';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const GEMINI_VOICES = [
  'Algenib',
  'Charon',
  'Fenrir',
  'Orus',
  'Puck',
  'Kore',
  'Aoede',
  'Leda',
  'Zephyr',
] as const;

export interface GeminiConfig {
  enabled: boolean;
  apiKey: string;
  model: 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts';
  voice: string;
  batchMinutes: number;
  dailyLimit: number;
}
const defaults: GeminiConfig = {
  enabled: false,
  apiKey: '',
  model: 'gemini-3.8-flash-tts',
  voice: 'Algenib',
  batchMinutes: 8,
  dailyLimit: 10,
};

export function getGeminiConfig(): GeminiConfig {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') as Partial<GeminiConfig>;
    return {
      enabled: value.enabled === true,
      apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
      model: value.model === 'gemini-3.8-flash-lite-tts' ? value.model : defaults.model,
      voice:
        typeof value.voice === 'string' &&
        GEMINI_VOICES.includes(value.voice as (typeof GEMINI_VOICES)[number])
          ? value.voice
          : defaults.voice,
      batchMinutes: Math.min(9, Math.max(2, Number(value.batchMinutes) || 8)),
      dailyLimit: Math.min(10000, Math.max(1, Math.floor(Number(value.dailyLimit) || 10))),
    };
  } catch {
    return { ...defaults };
  }
}

// Device-local only: never part of Readest's settings export or cloud sync.
export function setGeminiConfig(config: GeminiConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export interface GeminiSentence {
  text: string;
  lang: string;
}
export interface GeminiBatch {
  sentences: GeminiSentence[];
  estimatedSeconds: number;
}
export function estimateGeminiSeconds(text: string): number {
  const cjk =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length || 0;
  const words =
    text
      .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
      .match(/[\p{L}\p{N}]+/gu)?.length || 0;
  return Math.max(0.2, cjk / 4.5 + words / 2.5);
}

export function buildGeminiBatches(sentences: GeminiSentence[], minutes: number): GeminiBatch[] {
  const batches: GeminiBatch[] = [];
  let batch: GeminiBatch = { sentences: [], estimatedSeconds: 0 };
  let chars = 0;
  for (const sentence of sentences) {
    if (!sentence.text.trim()) continue;
    const seconds = estimateGeminiSeconds(sentence.text);
    if (
      batch.sentences.length &&
      (batch.estimatedSeconds + seconds > minutes * 60 || chars + sentence.text.length > 7000)
    ) {
      batches.push(batch);
      batch = { sentences: [], estimatedSeconds: 0 };
      chars = 0;
    }
    if (seconds > 600 || sentence.text.length > 7000)
      throw new Error(
        'A single sentence exceeds the Gemini speech limit. Split this text into sentences first.',
      );
    batch.sentences.push(sentence);
    batch.estimatedSeconds += seconds;
    chars += sentence.text.length;
  }
  if (batch.sentences.length) batches.push(batch);
  return batches;
}

export interface GeminiAudio {
  blob: Blob;
  duration: number;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
export function decodeGeminiAudio(response: unknown): GeminiAudio {
  let encoded = '';
  const walk = (value: unknown): void => {
    if (encoded) return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    const obj = record(value);
    if (!obj) return;
    if (
      typeof obj['data'] === 'string' &&
      (obj['type'] === 'audio' || String(obj['mime_type'] || '').startsWith('audio/'))
    ) {
      encoded = obj['data'];
      return;
    }
    for (const [key, child] of Object.entries(obj)) if (key !== 'data') walk(child);
  };
  walk(response);
  if (!encoded) throw new Error('Gemini returned no audio.');
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const tag = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw new Error('Gemini returned an invalid WAV file.');
  let bytesPerSecond = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > bytes.length) throw new Error('Gemini returned a truncated WAV file.');
    if (tag(offset) === 'fmt ' && size >= 16) bytesPerSecond = view.getUint32(offset + 16, true);
    if (tag(offset) === 'data') dataBytes += size;
    offset += 8 + size + (size % 2);
  }
  if (!bytesPerSecond || !dataBytes) throw new Error('Gemini returned empty audio.');
  return { blob: new Blob([bytes], { type: 'audio/wav' }), duration: dataBytes / bytesPerSecond };
}

interface CachedAudio extends GeminiAudio {
  key: string;
  updated: number;
}
export class GeminiAudioCache {
  async #database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('readest-gemini-audio', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('audio', { keyPath: 'key' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  async get(key: string): Promise<GeminiAudio | null> {
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
  async put(key: string, audio: GeminiAudio): Promise<void> {
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

const pacificDate = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const usageKey = (config: GeminiConfig) =>
  `readest-gemini-usage-${md5(config.apiKey)}-${config.model}`;
export function getGeminiUsage(config = getGeminiConfig()): number {
  try {
    const value = JSON.parse(localStorage.getItem(usageKey(config)) || '{}') as {
      day?: string;
      used?: number;
    };
    return value.day === pacificDate() ? value.used || 0 : 0;
  } catch {
    return 0;
  }
}

const STYLE = 'Read naturally at a normal audiobook pace. Use the language of the supplied text.';
export class GeminiSpeechService {
  #pending = new Map<string, Promise<GeminiAudio>>();
  #memory = new Map<string, GeminiAudio>();
  #queue: Promise<unknown> = Promise.resolve();
  #starts: number[] = [];
  constructor(
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private cache: GeminiAudioCache | null = typeof indexedDB === 'undefined'
      ? null
      : new GeminiAudioCache(),
  ) {}

  generate(text: string, config: GeminiConfig): Promise<GeminiAudio> {
    const key = md5(JSON.stringify([config.model, config.voice, STYLE, text]));
    const pendingKey = `${key}:${md5(config.apiKey)}:${pacificDate()}:${config.dailyLimit}`;
    const memory = this.#memory.get(key);
    if (memory) return Promise.resolve(memory);
    const pending = this.#pending.get(pendingKey);
    if (pending) return pending;
    const promise = this.#queue
      .catch(() => {})
      .then(async () => {
        const cached = await this.cache?.get(key).catch(() => null);
        if (cached) {
          this.#remember(key, cached);
          return cached;
        }
        if (!config.apiKey) throw new Error('Set your Gemini API key in Settings → TTS first.');
        let used = getGeminiUsage(config);
        if (used >= config.dailyLimit)
          throw new Error(
            'The local daily Gemini request budget has been reached. Cached audio still works.',
          );
        this.#starts = this.#starts.filter((t) => Date.now() - t < 60000);
        if (this.#starts.length >= 3) {
          await new Promise((resolve) =>
            setTimeout(resolve, 60010 - (Date.now() - this.#starts[0]!)),
          );
          this.#starts = this.#starts.filter((t) => Date.now() - t < 60000);
        }
        used = getGeminiUsage(config);
        if (used >= config.dailyLimit)
          throw new Error('The local daily Gemini request budget has been reached.');
        localStorage.setItem(
          usageKey(config),
          JSON.stringify({ day: pacificDate(), used: used + 1 }),
        );
        this.#starts.push(Date.now());
        const response = await this.fetcher(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
          body: JSON.stringify({
            model: config.model,
            input: [
              {
                type: 'user_input',
                content: [
                  { type: 'text', text, annotations: [{ type: 'speech_metadata', style: STYLE }] },
                ],
              },
            ],
            response_format: { type: 'audio' },
            generation_config: { speech_config: [{ voice: config.voice }] },
          }),
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
        if (!response.ok) {
          const hint =
            response.status === 429
              ? 'Quota or rate limit reached. Wait for the reset or check AI Studio.'
              : response.status === 400 || response.status === 401 || response.status === 403
                ? 'Check your API key, model access and region in AI Studio.'
                : 'Speech generation failed. Try again later.';
          throw new Error(`Gemini TTS (${response.status}): ${hint}`);
        }
        const audio = decodeGeminiAudio(await response.json());
        await this.cache?.put(key, audio).catch(() => {});
        this.#remember(key, audio);
        return audio;
      });
    this.#queue = promise;
    this.#pending.set(pendingKey, promise);
    // Retain failures for this page session: concurrent playback/preload must
    // not turn a single 429 into several billable retries.
    void promise.then(
      () => this.#pending.delete(pendingKey),
      () => {},
    );
    return promise;
  }
  #remember(key: string, audio: GeminiAudio) {
    this.#memory.set(key, audio);
    while (this.#memory.size > 3) this.#memory.delete(this.#memory.keys().next().value!);
  }
  async clearCache(): Promise<void> {
    this.#memory.clear();
    this.#pending.clear();
    await this.cache?.clear();
  }
}
export const geminiSpeech = new GeminiSpeechService();
