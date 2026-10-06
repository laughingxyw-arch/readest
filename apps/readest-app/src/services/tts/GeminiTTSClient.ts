import type { TTSClient, TTSCapabilities, TTSMessageEvent } from './TTSClient';
import type { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import type { TTSController } from './TTSController';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSUtils } from './TTSUtils';
import {
  buildGeminiBatches,
  estimateGeminiSeconds,
  GEMINI_VOICES,
  geminiSpeech,
  getGeminiConfig,
  type GeminiAudio,
  type GeminiBatch,
  type GeminiSentence,
} from './gemini';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
interface PreparedBatch extends GeminiBatch {
  first: number;
  audio?: GeminiAudio;
}

// A long recording is kept intact. Sentence locations are proportional
// estimates used to advance foliate's cursor, never advertised as real
// text alignment. Pauses/voice changes do not resynthesize cached recordings.
export class GeminiTTSClient implements TTSClient {
  name = 'gemini-tts';
  initialized = false;
  #lang = 'zh';
  #voice = '';
  #rate = 1;
  #section = '';
  #sentences: GeminiSentence[] = [];
  #batches: PreparedBatch[] = [];
  #cursor = 0;
  #audio: HTMLAudioElement | null = null;
  #url: string | null = null;
  #loadedBatch: PreparedBatch | null = null;
  #generation = 0;
  #paused = false;

  constructor(private controller?: TTSController) {}
  async init(): Promise<boolean> {
    const config = getGeminiConfig();
    this.initialized = config.enabled && !!config.apiKey;
    this.#voice = TTSUtils.getPreferredVoice(this.name, this.#lang) || `gemini:${config.voice}`;
    return this.initialized;
  }
  prepareSection(id: string, sentences: GeminiSentence[]): void {
    const config = getGeminiConfig();
    const identity = `${id}|${config.batchMinutes}`;
    if (this.#section === identity) return;
    this.#section = identity;
    this.#sentences = sentences;
    this.#batches = [];
    let first = 0;
    for (const batch of buildGeminiBatches(sentences, config.batchMinutes)) {
      this.#batches.push({ ...batch, first });
      first += batch.sentences.length;
    }
    this.#cursor = 0;
  }
  #findMarks(marks: TTSMark[]): number {
    const matches = (index: number) =>
      marks.every(
        (mark, offset) =>
          normalize(this.#sentences[index + offset]?.text || '') === normalize(mark.text),
      );
    for (let i = this.#cursor; i < this.#sentences.length; i++) if (matches(i)) return i;
    for (let i = 0; i < this.#cursor; i++) if (matches(i)) return i;
    return -1;
  }
  async #getAudio(batch: PreparedBatch): Promise<GeminiAudio> {
    const config = getGeminiConfig();
    config.voice = this.getVoiceId().replace(/^gemini:/, '');
    // Service cache keys include voice/model/text, so changing voices never
    // reuses an old narrator's audio. Store the result only for this lookup.
    const audio = await geminiSpeech.generate(
      batch.sentences.map((s) => s.text).join('\n'),
      config,
    );
    batch.audio = audio;
    return audio;
  }
  async #load(
    batch: PreparedBatch,
    audio: GeminiAudio,
    signal: AbortSignal,
  ): Promise<HTMLAudioElement> {
    if (this.#loadedBatch === batch && this.#audio) return this.#audio;
    this.#releaseAudio();
    this.#audio = new Audio();
    this.#audio.preload = 'auto';
    this.#audio.playbackRate = this.#rate;
    this.#url = URL.createObjectURL(audio.blob);
    this.#audio.src = this.#url;
    const player = this.#audio;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        player.removeEventListener('loadedmetadata', ready);
        player.removeEventListener('error', failed);
        signal.removeEventListener('abort', aborted);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('Could not play the generated Gemini audio.'));
      };
      const aborted = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timeout = setTimeout(failed, 30000);
      player.addEventListener('loadedmetadata', ready, { once: true });
      player.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      else if (player.readyState >= 1) ready();
      else player.load();
    });
    this.#loadedBatch = batch;
    return player;
  }
  #bounds(batch: PreparedBatch, index: number, duration: number): { start: number; end: number } {
    const weights = batch.sentences.map((s) => estimateGeminiSeconds(s.text));
    const total = weights.reduce((a, b) => a + b, 0);
    const local = index - batch.first;
    const before = weights.slice(0, local).reduce((a, b) => a + b, 0);
    return {
      start: (duration * before) / total,
      end: (duration * (before + weights[local]!)) / total,
    };
  }
  async #waitUntil(
    player: HTMLAudioElement,
    end: number,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearInterval(timer);
        player.removeEventListener('error', failed);
        signal.removeEventListener('abort', done);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('Gemini audio playback failed.'));
      };
      const check = () => {
        if (
          signal.aborted ||
          generation !== this.#generation ||
          player.ended ||
          player.currentTime >= end - 0.025
        )
          done();
      };
      const timer = setInterval(check, 50);
      player.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', done, { once: true });
      check();
    });
  }
  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml, this.#lang);
    if (!marks.length || signal.aborted) return;
    if (!preload) this.#paused = false;
    let first = this.#findMarks(marks);
    let batches = this.#batches;
    if (first < 0) {
      // Selection-only reading can contain a range absent from the section.
      // It is an explicit short request; ordinary reading always batches.
      first = 0;
      let ordinal = 0;
      batches = buildGeminiBatches(
        marks.map((m) => ({ text: m.text, lang: m.language })),
        getGeminiConfig().batchMinutes,
      ).map((batch) => {
        const result = { ...batch, first: ordinal };
        ordinal += batch.sentences.length;
        return result;
      });
    }
    const generation = this.#generation;
    for (let offset = 0; offset < marks.length; offset++) {
      if (signal.aborted || generation !== this.#generation) return;
      const index = first + offset;
      const batch = batches.find((b) => index >= b.first && index < b.first + b.sentences.length)!;
      const audio = await this.#getAudio(batch);
      if (signal.aborted || generation !== this.#generation) return;
      if (preload) continue;
      const player = await this.#load(batch, audio, signal);
      if (signal.aborted || generation !== this.#generation) return;
      const bounds = this.#bounds(batch, index, audio.duration);
      if (Math.abs(player.currentTime - bounds.start) > 0.35) player.currentTime = bounds.start;
      player.playbackRate = this.#rate;
      if (!this.#paused) await player.play();
      this.controller?.dispatchSpeakMark(marks[offset]);
      yield { code: 'boundary', mark: marks[offset]!.name };
      await this.#waitUntil(player, bounds.end, signal, generation);
      if (signal.aborted || generation !== this.#generation) return;
      this.#cursor = index + 1;
    }
    if (!preload) this.#audio?.pause();
    yield { code: 'end' };
  }
  async pause(): Promise<boolean> {
    this.#paused = true;
    this.#audio?.pause();
    return true;
  }
  async resume(): Promise<boolean> {
    this.#paused = false;
    if (this.#audio) await this.#audio.play();
    return true;
  }
  async stop(): Promise<void> {
    this.#generation++;
    this.#audio?.pause();
  }
  async shutdown(): Promise<void> {
    await this.stop();
    this.#releaseAudio();
    this.initialized = false;
  }
  #releaseAudio(): void {
    this.#audio?.pause();
    this.#audio?.removeAttribute('src');
    this.#audio?.load();
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = null;
    this.#audio = null;
    this.#loadedBatch = null;
  }
  setPrimaryLang(lang: string): void {
    this.#lang = lang;
  }
  async setRate(rate: number): Promise<void> {
    this.#rate = rate;
    if (this.#audio) this.#audio.playbackRate = rate;
  }
  async setPitch(_pitch: number): Promise<void> {}
  async setVoice(voice: string): Promise<void> {
    if (GEMINI_VOICES.some((v) => `gemini:${v}` === voice)) {
      this.#voice = voice;
      this.#releaseAudio();
    }
  }
  getVoiceId(): string {
    return this.#voice || `gemini:${getGeminiConfig().voice}`;
  }
  getSpeakingLang(): string {
    return this.#lang;
  }
  async getAllVoices(): Promise<TTSVoice[]> {
    return GEMINI_VOICES.map((voice) => ({
      id: `gemini:${voice}`,
      name: voice,
      lang: this.#lang,
      disabled: !this.initialized,
    }));
  }
  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    if (!this.initialized) return [];
    return [
      {
        id: this.name,
        name: 'Gemini TTS',
        disabled: !this.initialized,
        voices: (await this.getAllVoices()).map((v) => ({ ...v, lang })),
      },
    ];
  }
  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }
  getCapabilities(): TTSCapabilities {
    return {
      wordBoundaries: false,
      mediaClock: false,
      textHighlight: false,
      gapControl: false,
      liveRateChange: true,
      continuousTimeline: true,
      bookDownload: false,
    };
  }
}
