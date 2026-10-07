import type { TTSClient, TTSCapabilities, TTSMessageEvent } from './TTSClient';
import type { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import type { TTSController } from './TTSController';
import { parseSSMLMarks } from '@/utils/ssml';
import { md5 } from 'js-md5';
import i18n from '@/i18n/i18n';
import { eventDispatcher } from '@/utils/event';
import { TTSUtils } from './TTSUtils';
import {
  buildGeminiBatches,
  estimateGeminiSeconds,
  GEMINI_VOICES,
  geminiSpeech,
  getGeminiConfig,
  getGeminiDurationScale,
  recordGeminiDurationScale,
  GEMINI_BUDGET_MESSAGE,
  GEMINI_RESERVE_MESSAGE,
  GEMINI_RETRY_MESSAGE,
  type GeminiAudio,
  type GeminiBatch,
  type GeminiSentence,
} from './gemini';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
interface PreparedSection {
  id: string;
  sentences: GeminiSentence[];
}
interface PreparedBatch extends GeminiBatch {
  first: number;
  audio?: GeminiAudio;
  pending?: Promise<GeminiAudio>;
  requested?: boolean;
  lookaheadStarted?: boolean;
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
  #sectionId = '';
  #sections: PreparedSection[] = [];
  #activeSection = '';
  #activeStart = 0;
  #activeEnd = 0;
  #planKey = '';
  #planSignature = '';
  #sentences: GeminiSentence[] = [];
  #batches: PreparedBatch[] = [];
  #legacyBatches: PreparedBatch[] = [];
  #cursor = 0;
  #audio: HTMLAudioElement | null = null;
  #url: string | null = null;
  #loadedBatch: PreparedBatch | null = null;
  #generation = 0;
  #paused = false;
  #nextPosition: number | null = 0;
  #resumeWaiters = new Set<() => void>();
  #lookaheadAbort: AbortController | null = null;

  constructor(private controller?: TTSController) {}
  async init(): Promise<boolean> {
    const config = getGeminiConfig();
    this.initialized = config.enabled && !!config.apiKey;
    this.#voice = TTSUtils.getPreferredVoice(this.name, this.#lang) || `gemini:${config.voice}`;
    return this.initialized;
  }
  activateSection(id: string): boolean {
    let first = 0;
    for (const section of this.#sections) {
      const end = first + section.sentences.length;
      if (section.id === id) {
        this.#activeSection = id;
        this.#activeStart = first;
        this.#activeEnd = end;
        if (this.#cursor < first || this.#cursor >= end) this.#cursor = first;
        return true;
      }
      first = end;
    }
    return false;
  }
  prepareSection(id: string, sentences: GeminiSentence[], following: PreparedSection[] = []): void {
    const config = this.#config();
    const identity = `${id}|${config.model}|${config.voice}|${config.batchMinutes}`;
    if (this.#section === identity) return;
    this.#generation++;
    this.#lookaheadAbort?.abort();
    for (const wake of this.#resumeWaiters) wake();
    this.#releaseAudio();
    this.#section = identity;
    this.#sectionId = id;
    this.#sections = [{ id, sentences }, ...following];
    sentences = this.#sections.flatMap((section) => section.sentences);
    this.#sentences = sentences;
    this.#batches = [];
    let legacyFirst = 0;
    this.#legacyBatches = this.#sections.flatMap((section) =>
      buildGeminiBatches(section.sentences, config.batchMinutes).map((batch) => {
        const result = { ...batch, first: legacyFirst };
        legacyFirst += batch.sentences.length;
        return result;
      }),
    );
    this.#planKey = `readest-gemini-plan-${md5(identity)}`;
    this.#planSignature = md5(JSON.stringify(sentences));
    try {
      const plan = JSON.parse(localStorage.getItem(this.#planKey) || '{}') as {
        signature?: string;
        ends?: number[];
        requestedEnds?: number[];
      };
      if (
        plan.signature === this.#planSignature &&
        plan.ends?.at(-1) === sentences.length &&
        plan.ends.every((end, i) => Number.isInteger(end) && end > (plan.ends![i - 1] || 0))
      ) {
        let first = 0;
        this.#batches = plan.ends.map((end) => {
          const slice = sentences.slice(first, end);
          const batch = {
            first,
            requested: plan.requestedEnds?.includes(end),
            sentences: slice,
            estimatedSeconds: slice.reduce((sum, s) => sum + estimateGeminiSeconds(s.text), 0),
          };
          first = end;
          return batch;
        });
      }
    } catch {}
    let first = 0;
    if (!this.#batches.length) {
      for (const batch of buildGeminiBatches(
        sentences,
        config.batchMinutes,
        getGeminiDurationScale(config, sentences[0]?.lang || this.#lang),
      )) {
        this.#batches.push({ ...batch, first });
        first += batch.sentences.length;
      }
    }
    this.#cursor = 0;
    this.#nextPosition = 0;
    this.activateSection(id);
    this.#savePlan();
  }
  #config() {
    return { ...getGeminiConfig(), voice: this.getVoiceId().replace(/^gemini:/, '') };
  }
  #savePlan(): void {
    if (!this.#planKey) return;
    try {
      localStorage.setItem(
        this.#planKey,
        JSON.stringify({
          signature: this.#planSignature,
          ends: this.#batches.map((batch) => batch.first + batch.sentences.length),
          requestedEnds: this.#batches
            .filter((batch) => batch.requested)
            .map((batch) => batch.first + batch.sentences.length),
        }),
      );
    } catch {}
  }
  #calibrate(batch: PreparedBatch, audio: GeminiAudio): void {
    if (!this.#batches.includes(batch)) return;
    const config = this.#config();
    const lang = batch.sentences[0]?.lang || this.#lang;
    recordGeminiDurationScale(config, lang, audio.duration, batch.estimatedSeconds);
    // Already requested recordings retain their exact text/cache key. Only
    // unrequested lookahead is resized using the measured narration speed.
    let keep = this.#batches.indexOf(batch) + 1;
    for (let i = keep; i < this.#batches.length; i++)
      if (this.#batches[i]!.requested || this.#batches[i]!.pending) keep = i + 1;
    const last = this.#batches[keep - 1]!;
    let first = last.first + last.sentences.length;
    const tail = buildGeminiBatches(
      this.#sentences.slice(first),
      config.batchMinutes,
      getGeminiDurationScale(config, lang),
    );
    this.#batches.splice(
      keep,
      this.#batches.length - keep,
      ...tail.map((batch) => {
        const result = { ...batch, first };
        first += batch.sentences.length;
        return result;
      }),
    );
    this.#savePlan();
  }
  #findMarks(marks: TTSMark[]): number {
    const matches = (index: number) =>
      index + marks.length <= this.#activeEnd &&
      marks.every(
        (mark, offset) =>
          normalize(this.#sentences[index + offset]?.text || '') === normalize(mark.text),
      );
    const cfi = this.controller?.getSpokenSentence()?.cfi;
    if (cfi) {
      for (let i = this.#activeStart; i < this.#activeEnd; i++)
        if (this.#sentences[i]!.cfi === cfi && matches(i)) return i;
    }
    for (let i = Math.max(this.#cursor, this.#activeStart); i < this.#activeEnd; i++)
      if (matches(i)) return i;
    for (let i = this.#activeStart; i < this.#cursor; i++) if (matches(i)) return i;
    return -1;
  }
  async #batchAt(index: number, signal: AbortSignal): Promise<PreparedBatch> {
    const position = this.#batches.findIndex(
      (batch) => index >= batch.first && index < batch.first + batch.sentences.length,
    );
    const batch = this.#batches[position]!;
    if (batch.audio || batch.pending) return batch;
    const cached = await geminiSpeech.getCached(
      batch.sentences.map((s) => s.text).join('\n'),
      this.#config(),
    );
    if (cached) {
      batch.audio = cached;
      batch.requested = true;
      this.#calibrate(batch, cached);
      return batch;
    }
    if (signal.aborted) return batch;
    // Reuse old per-chapter recordings, including short tails, before
    // requesting new cross-chapter audio for the same text.
    const legacy = this.#legacyBatches.find(
      (candidate) =>
        index >= candidate.first && index < candidate.first + candidate.sentences.length,
    );
    if (
      legacy &&
      (legacy.first !== batch.first || legacy.sentences.length !== batch.sentences.length)
    ) {
      const end = legacy.first + legacy.sentences.length;
      const startIndex = this.#batches.findIndex(
        (candidate) => candidate.first + candidate.sentences.length > legacy.first,
      );
      let endIndex = startIndex;
      while (endIndex < this.#batches.length && this.#batches[endIndex]!.first < end) endIndex++;
      const overlaps = this.#batches.slice(startIndex, endIndex);
      if (
        overlaps.every(
          (candidate) => candidate === batch || (!candidate.requested && !candidate.pending),
        )
      ) {
        const audio = await geminiSpeech.getCached(
          legacy.sentences.map((s) => s.text).join('\n'),
          this.#config(),
        );
        if (audio && !signal.aborted && this.#batches.includes(batch)) {
          const replacements: PreparedBatch[] = [];
          const addSlice = (first: number, stop: number) => {
            const slice = this.#sentences.slice(first, stop);
            if (slice.length)
              replacements.push({
                first,
                sentences: slice,
                estimatedSeconds: slice.reduce((sum, s) => sum + estimateGeminiSeconds(s.text), 0),
              });
          };
          addSlice(overlaps[0]!.first, legacy.first);
          const restored = { ...legacy, audio, requested: true };
          replacements.push(restored);
          const last = overlaps.at(-1)!;
          addSlice(end, last.first + last.sentences.length);
          this.#batches.splice(startIndex, endIndex - startIndex, ...replacements);
          this.#calibrate(restored, audio);
          return restored;
        }
      }
    }
    if (this.#nextPosition === null || index === batch.first) return batch;
    // With no cached recording, spend the request on text AFTER the chosen
    // sentence. Keep any already generated future batch's cache key intact.
    let end = position + 1;
    while (
      end < this.#batches.length &&
      !this.#batches[end]!.requested &&
      !this.#batches[end]!.pending
    )
      end++;
    const stop = this.#batches[end]?.first ?? this.#sentences.length;
    const config = this.#config();
    let first = index;
    const tail = buildGeminiBatches(
      this.#sentences.slice(index, stop),
      config.batchMinutes,
      getGeminiDurationScale(config, this.#sentences[index]!.lang),
    ).map((batch) => {
      const result = { ...batch, first };
      first += batch.sentences.length;
      return result;
    });
    const prefix = this.#sentences.slice(batch.first, index);
    this.#batches.splice(
      position,
      end - position,
      {
        first: batch.first,
        sentences: prefix,
        estimatedSeconds: prefix.reduce((sum, s) => sum + estimateGeminiSeconds(s.text), 0),
      },
      ...tail,
    );
    this.#savePlan();
    return tail[0]!;
  }
  async #getAudio(
    batch: PreparedBatch,
    signal: AbortSignal,
    preload = false,
  ): Promise<GeminiAudio> {
    if (batch.audio) return batch.audio;
    if (batch.pending) {
      try {
        return await batch.pending;
      } catch {
        /* foreground may use the last regular request */
      }
    }
    const generation = this.#generation;
    const pending = geminiSpeech.generate(
      batch.sentences.map((s) => s.text).join('\n'),
      this.#config(),
      {
        signal,
        preload,
        beforeRequest: preload ? undefined : () => this.#waitForResume(signal, generation),
      },
    );
    batch.pending = pending;
    try {
      const audio = await pending;
      batch.audio = audio;
      batch.requested = true;
      this.#calibrate(batch, audio);
      return audio;
    } catch (error) {
      if (
        !preload &&
        !signal.aborted &&
        generation === this.#generation &&
        error instanceof Error &&
        error.name !== 'AbortError'
      ) {
        const message = [GEMINI_BUDGET_MESSAGE, GEMINI_RESERVE_MESSAGE].includes(error.message)
          ? error.message
          : GEMINI_RETRY_MESSAGE;
        void eventDispatcher.dispatch('toast', {
          message: i18n.t(message),
          type: 'error',
          timeout: 8000,
        });
      }
      throw error;
    } finally {
      if (batch.pending === pending) batch.pending = undefined;
    }
  }
  async #waitForResume(signal: AbortSignal, generation: number): Promise<void> {
    if (signal.aborted || generation !== this.#generation)
      throw new DOMException('Aborted', 'AbortError');
    if (!this.#paused) return;
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        this.#resumeWaiters.delete(wake);
        signal.removeEventListener('abort', wake);
        if (signal.aborted || generation !== this.#generation)
          reject(new DOMException('Aborted', 'AbortError'));
        else resolve();
      };
      this.#resumeWaiters.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });
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
    const index = this.#batches.indexOf(batch);
    this.#batches.forEach((other, i) => {
      if (Math.abs(i - index) > 1) other.audio = undefined;
    });
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
    batch: PreparedBatch,
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
        // At most one recording ahead, only near the audible end. Paused or
        // abandoned playback never starts new lookahead requests.
        if (
          !signal.aborted &&
          generation === this.#generation &&
          !this.#paused &&
          !this.controller?.stopAtChapterEnd &&
          !player.paused &&
          (batch.audio?.duration || player.duration) - player.currentTime <= 75 * this.#rate
        ) {
          const next = this.#batches[this.#batches.indexOf(batch) + 1];
          if (next && !next.audio && !next.pending && !next.lookaheadStarted && !lookedAhead) {
            lookedAhead = true;
            next.lookaheadStarted = true;
            this.#lookaheadAbort?.abort();
            this.#lookaheadAbort = new AbortController();
            const lookaheadSignal = AbortSignal.any([signal, this.#lookaheadAbort.signal]);
            void this.#batchAt(next.first, lookaheadSignal)
              .then((prepared) => {
                prepared.lookaheadStarted = true;
                if (lookaheadSignal.aborted || generation !== this.#generation)
                  throw new DOMException('Aborted', 'AbortError');
                return this.#getAudio(prepared, lookaheadSignal, true);
              })
              .catch((error) => {
                if (
                  (error instanceof Error || error instanceof DOMException) &&
                  error.name === 'AbortError'
                ) {
                  lookedAhead = false;
                  next.lookaheadStarted = false;
                }
              });
          }
        }
        if (
          signal.aborted ||
          generation !== this.#generation ||
          player.ended ||
          player.currentTime >= end - 1e-6
        )
          done();
      };
      let lookedAhead = false;
      const timer = setInterval(check, 50);
      player.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', done, { once: true });
      check();
    });
  }
  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml, this.#lang);
    if (!marks.length || signal.aborted) return;
    let first = this.#findMarks(marks);
    let batches = this.#batches;
    if (first < 0) {
      if (this.#sentences.length)
        throw new Error(
          'The selected speech text could not be matched to this chapter. No Gemini request was sent.',
        );
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
      const batch =
        batches === this.#batches
          ? await this.#batchAt(index, signal)
          : batches.find((b) => index >= b.first && index < b.first + b.sentences.length)!;
      if (signal.aborted || generation !== this.#generation) return;
      const audio = await this.#getAudio(batch, signal);
      if (signal.aborted || generation !== this.#generation) return;
      if (preload) break;
      const newRecording = this.#loadedBatch !== batch;
      const player = await this.#load(batch, audio, signal);
      if (signal.aborted || generation !== this.#generation) return;
      const bounds = this.#bounds(batch, index, audio.duration);
      if (newRecording || this.#nextPosition !== null) {
        player.currentTime = Math.min(audio.duration, bounds.start + (this.#nextPosition || 0));
        this.#nextPosition = null;
      }
      player.playbackRate = this.#rate;
      // play() on an ended HTMLAudioElement restarts it from zero. Delayed
      // text-cursor catch-up must never restart an already completed batch.
      if (!this.#paused && !player.ended && player.paused) await player.play();
      this.controller?.dispatchSpeakMark(marks[offset]);
      yield { code: 'boundary', mark: marks[offset]!.name };
      await this.#waitUntil(player, bounds.end, signal, generation, batch);
      if (signal.aborted || generation !== this.#generation) return;
      this.#cursor = index + 1;
    }
    yield { code: 'end' };
  }
  async pause(): Promise<boolean> {
    this.#paused = true;
    this.#lookaheadAbort?.abort();
    this.#audio?.pause();
    return true;
  }
  async resume(): Promise<boolean> {
    this.#paused = false;
    for (const wake of this.#resumeWaiters) wake();
    if (this.#audio && !this.#audio.ended) await this.#audio.play();
    return true;
  }
  async stop(handover = false): Promise<void> {
    this.#generation++;
    this.#lookaheadAbort?.abort();
    for (const wake of this.#resumeWaiters) wake();
    if (!handover) {
      this.#paused = false;
      this.#audio?.pause();
      this.#nextPosition = 0;
    }
  }
  setNextChunkPosition(seconds: number): void {
    this.#nextPosition = Math.max(0, seconds);
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
      if (this.#sectionId) {
        const active = this.#activeSection;
        const cursor = this.#cursor;
        const [first, ...following] = this.#sections;
        this.prepareSection(first!.id, first!.sentences, following);
        this.activateSection(active);
        this.#cursor = cursor;
      } else this.#releaseAudio();
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
      managesLookahead: true,
    };
  }
}
