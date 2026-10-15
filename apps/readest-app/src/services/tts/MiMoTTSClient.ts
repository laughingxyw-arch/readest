import type { TTSClient, TTSCapabilities, TTSMessageEvent } from './TTSClient';
import type { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import type { TTSController } from './TTSController';
import { parseSSMLMarks } from '@/utils/ssml';
import { md5 } from 'js-md5';
import { TTSUtils } from './TTSUtils';
import {
  buildMiMoBatches,
  estimateMiMoSeconds,
  MIMO_VOICES,
  MiMoAPIError,
  mimoSpeech,
  getMiMoConfig,
  getMiMoDurationScale,
  recordMiMoDurationScale,
  type MiMoAudio,
  type MiMoBatch,
  type MiMoSentence,
} from './mimo';

const PLAYBACK_STALL_MS = 10000;

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
interface PreparedSection {
  id: string;
  sentences: MiMoSentence[];
}
interface PreparedBatch extends MiMoBatch {
  first: number;
  audio?: MiMoAudio;
  pending?: Promise<MiMoAudio>;
  requested?: boolean;
}

// Each recording is one highlighted text segment. Only its real end advances
// the reader; no proportional sentence timestamps are used during playback.
export class MiMoTTSClient implements TTSClient {
  name = 'mimo-tts';
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
  #sentences: MiMoSentence[] = [];
  #batches: PreparedBatch[] = [];
  #cursor = 0;
  #audio: HTMLAudioElement | null = null;
  #url: string | null = null;
  #loadedBatch: PreparedBatch | null = null;
  #generation = 0;
  #paused = false;
  #nextPosition: number | null = 0;
  #resumeWaiters = new Set<() => void>();
  #lookaheadAbort: AbortController | null = null;
  #requestsAbort = new AbortController();
  #bufferTask: Promise<void> | null = null;
  #bufferTarget = 90;
  #latencies: number[] = [];
  #bufferRetryAt = 0;
  #bufferFailures = 0;

  constructor(private controller?: TTSController) {}
  async init(): Promise<boolean> {
    const config = getMiMoConfig();
    this.initialized = config.enabled && !!config.apiKey;
    this.#voice = TTSUtils.getPreferredVoice(this.name, this.#lang) || `mimo:${config.voice}`;
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
  prepareSection(id: string, sentences: MiMoSentence[], following: PreparedSection[] = []): void {
    const config = this.#config();
    const identity = `segments-v1|${id}|${config.model}|${config.voice}|${config.batchMinutes}`;
    if (this.#section === identity) return;
    this.#generation++;
    this.#cancelBufferRequests();
    for (const wake of this.#resumeWaiters) wake();
    this.#releaseAudio();
    this.#section = identity;
    this.#sectionId = id;
    this.#sections = [{ id, sentences }, ...following];
    sentences = this.#sections.flatMap((section) =>
      section.sentences.map((sentence) => ({ ...sentence, section: section.id })),
    );
    this.#sentences = sentences;
    this.#batches = [];
    this.#planKey = `readest-mimo-plan-${md5(identity)}`;
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
            estimatedSeconds: slice.reduce((sum, s) => sum + estimateMiMoSeconds(s.text), 0),
          };
          first = end;
          return batch;
        });
      }
    } catch {}
    let first = 0;
    if (!this.#batches.length) {
      for (const batch of buildMiMoBatches(
        sentences,
        config.batchMinutes,
        getMiMoDurationScale(config, sentences[0]?.lang || this.#lang),
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
    return { ...getMiMoConfig(), voice: this.getVoiceId().replace(/^mimo:/, '') };
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
  #calibrate(batch: PreparedBatch, audio: MiMoAudio): void {
    if (!this.#batches.includes(batch)) return;
    const config = this.#config();
    const lang = batch.sentences[0]?.lang || this.#lang;
    recordMiMoDurationScale(config, lang, audio.duration, batch.estimatedSeconds);
    // Already requested recordings retain their exact text/cache key. Only
    // unrequested lookahead is resized using the measured narration speed.
    let keep = this.#batches.indexOf(batch) + 1;
    for (let i = keep; i < this.#batches.length; i++)
      if (this.#batches[i]!.requested || this.#batches[i]!.pending) keep = i + 1;
    const last = this.#batches[keep - 1]!;
    let first = last.first + last.sentences.length;
    const tail = buildMiMoBatches(
      this.#sentences.slice(first),
      config.batchMinutes,
      getMiMoDurationScale(config, lang),
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
    if (index === batch.first && (batch.audio || batch.pending)) return batch;
    const cached = await mimoSpeech.getCached(
      batch.sentences.map((s) => s.text).join('\n'),
      this.#config(),
    );
    if (cached && index === batch.first) {
      batch.audio = cached;
      batch.requested = true;
      this.#calibrate(batch, cached);
      return batch;
    }
    if (signal.aborted) return batch;
    if (index === batch.first) return batch;
    // An explicit sentence start must be exact even inside a cached segment:
    // cache its suffix instead of seeking to a guessed timestamp.
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
    const tail = buildMiMoBatches(
      this.#sentences.slice(index, stop),
      config.batchMinutes,
      getMiMoDurationScale(config, this.#sentences[index]!.lang),
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
        estimatedSeconds: prefix.reduce((sum, s) => sum + estimateMiMoSeconds(s.text), 0),
      },
      ...tail,
    );
    this.#savePlan();
    return tail[0]!;
  }
  async #getAudio(batch: PreparedBatch, signal: AbortSignal, preload = false): Promise<MiMoAudio> {
    if (batch.audio) return batch.audio;
    if (batch.pending) {
      try {
        return await batch.pending;
      } catch {
        /* Foreground reading can retry a failed lookahead. */
      }
    }
    const generation = this.#generation;
    const config = this.#config();
    const requestSignal = this.#requestsAbort.signal;
    const pending = mimoSpeech.generate(batch.sentences.map((s) => s.text).join('\n'), config, {
      signal,
      preload,
      cancelSignal: requestSignal,
      onGenerated: (elapsed) => {
        // Normal segment handover keeps the request useful, including its
        // latency sample. Only explicit position/voice cancellation discards it.
        if (requestSignal.aborted) return;
        this.#latencies.push(elapsed / 1000);
        if (this.#latencies.length > 10) this.#latencies.shift();
        const sorted = [...this.#latencies].sort((a, b) => a - b);
        const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
        const target = Math.min(180, Math.max(60, p90 * 3));
        this.#bufferTarget =
          target >= this.#bufferTarget ? target : this.#bufferTarget * 0.8 + target * 0.2;
      },
      beforeRequest: preload ? undefined : () => this.#waitForResume(signal, generation),
    });
    batch.pending = pending;
    try {
      const audio = await pending;
      batch.audio = audio;
      batch.requested = true;
      this.#bufferRetryAt = 0;
      this.#bufferFailures = 0;
      this.#calibrate(batch, audio);
      return audio;
    } catch (error) {
      // Late failures from an abandoned position must not reopen its dialog.
      if (signal.aborted || generation !== this.#generation)
        throw new DOMException('Aborted', 'AbortError');
      if ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError')
        throw new Error('MiMo speech request was interrupted. Please try again.');
      throw error;
    } finally {
      if (batch.pending === pending) batch.pending = undefined;
    }
  }
  #cancelBufferRequests(): void {
    this.#lookaheadAbort?.abort();
    this.#requestsAbort.abort();
    this.#requestsAbort = new AbortController();
    this.#bufferRetryAt = 0;
    this.#bufferFailures = 0;
  }
  #bufferSeconds(batch: PreparedBatch): number {
    const index = this.#batches.indexOf(batch);
    if (index < 0) return 0;
    let seconds = Math.max(0, (batch.audio?.duration || 0) - (this.#audio?.currentTime || 0));
    for (let i = index + 1; i < this.#batches.length; i++) {
      const next = this.#batches[i]!;
      if (
        !next.audio ||
        (this.controller?.stopAtChapterEnd &&
          next.sentences[0]?.section !== batch.sentences[0]?.section)
      )
        break;
      seconds += next.audio.duration;
    }
    return seconds / this.#rate;
  }
  #ensureBuffer(batch: PreparedBatch, signal: AbortSignal, generation: number): void {
    const index = this.#batches.indexOf(batch);
    if (
      index < 0 ||
      signal.aborted ||
      generation !== this.#generation ||
      this.#paused ||
      this.#loadedBatch !== batch ||
      this.#audio?.paused ||
      this.#audio?.ended ||
      this.#bufferTask ||
      performance.now() < this.#bufferRetryAt ||
      this.#bufferSeconds(batch) >= this.#bufferTarget * 0.75
    )
      return;
    let nextIndex = index + 1;
    while (this.#batches[nextIndex]?.audio) nextIndex++;
    const missing = this.#batches[nextIndex];
    if (
      !missing ||
      (this.controller?.stopAtChapterEnd &&
        missing.sentences[0]?.section !== batch.sentences[0]?.section)
    )
      return;
    this.#lookaheadAbort = new AbortController();
    const abort = AbortSignal.any([signal, this.#lookaheadAbort.signal]);
    const task = this.#fillBuffer(batch, abort, generation)
      .catch((error) => {
        if (abort.aborted || generation !== this.#generation) return;
        this.#bufferFailures++;
        this.#bufferRetryAt =
          error instanceof MiMoAPIError && [400, 401, 403].includes(error.status)
            ? Infinity
            : performance.now() + Math.min(30000, 1000 * 2 ** Math.min(5, this.#bufferFailures));
      })
      .finally(() => {
        if (this.#bufferTask === task) this.#bufferTask = null;
      });
    this.#bufferTask = task;
  }
  async #fillBuffer(batch: PreparedBatch, signal: AbortSignal, generation: number): Promise<void> {
    let cursor = batch;
    while (
      !signal.aborted &&
      generation === this.#generation &&
      !this.#paused &&
      !this.#audio?.ended
    ) {
      if (this.#bufferSeconds(batch) >= this.#bufferTarget) return;
      // Bound memory as well as playable seconds (especially at high rates).
      const bytes = this.#batches.reduce((size, item) => size + (item.audio?.blob.size || 0), 0);
      if (bytes >= 32 * 1024 * 1024) return;
      const next = this.#batches[this.#batches.indexOf(cursor) + 1];
      if (
        !next ||
        (this.controller?.stopAtChapterEnd &&
          next.sentences[0]?.section !== batch.sentences[0]?.section)
      )
        return;
      cursor = await this.#batchAt(next.first, signal);
      if (signal.aborted || generation !== this.#generation || this.#paused) return;
      await this.#getAudio(cursor, signal, true);
      this.#bufferFailures = 0;
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
    audio: MiMoAudio,
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
        reject(new Error('Could not play the generated MiMo audio.'));
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
      if (i < index - 1) other.audio = undefined;
    });
    return player;
  }
  async #play(player: HTMLAudioElement, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.#paused) return;
    const generation = this.#generation;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        player.removeEventListener('pause', paused);
        signal?.removeEventListener('abort', paused);
      };
      const paused = () => {
        cleanup();
        resolve();
      };
      const timeout = setTimeout(() => {
        if (this.#paused || signal?.aborted || generation !== this.#generation) {
          paused();
          return;
        }
        cleanup();
        player.pause();
        reject(new Error('MiMo audio did not start. Please start reading again.'));
      }, PLAYBACK_STALL_MS);
      player.addEventListener('pause', paused, { once: true });
      signal?.addEventListener('abort', paused, { once: true });
      player.play().then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          if (this.#paused || signal?.aborted || generation !== this.#generation) resolve();
          else if (
            (error instanceof Error || error instanceof DOMException) &&
            error.name === 'AbortError'
          )
            reject(new Error('MiMo audio playback was interrupted. Please start reading again.'));
          else reject(error);
        },
      );
    });
  }
  async #waitUntil(
    player: HTMLAudioElement,
    signal: AbortSignal,
    generation: number,
    batch: PreparedBatch,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearInterval(timer);
        player.removeEventListener('error', failed);
        player.removeEventListener('ended', check);
        player.removeEventListener('seeking', resetProgress);
        signal.removeEventListener('abort', done);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('MiMo audio playback failed.'));
      };
      const check = () => {
        if (signal.aborted || generation !== this.#generation || player.ended) {
          done();
          return;
        }
        const now = performance.now();
        if (
          this.#paused ||
          player.seeking ||
          player.currentTime < lastPosition ||
          this.#rate !== progressRate
        ) {
          resetProgress();
        } else if (now - progressStartedAt >= PLAYBACK_STALL_MS) {
          // Tiny clock changes must not keep a broken output stream alive.
          // Allow substantial output jitter, but require 20% of the requested
          // progress over a full window. Pause, seek and rate changes restart it.
          const expected = ((now - progressStartedAt) / 1000) * progressRate;
          const progress = player.currentTime - progressPosition;
          if (progress < expected * 0.2) {
            player.pause();
            cleanup();
            reject(
              new Error(
                `MiMo audio is not progressing. Please start reading again. ` +
                  `(Progress: ${progress.toFixed(2)}s; expected: ${expected.toFixed(2)}s; rate: ${progressRate}x.)`,
              ),
            );
            return;
          }
          resetProgress();
        }
        lastPosition = player.currentTime;
        this.#ensureBuffer(batch, signal, generation);
      };
      let lastPosition = player.currentTime;
      let progressPosition = player.currentTime;
      let progressStartedAt = performance.now();
      let progressRate = this.#rate;
      const resetProgress = () => {
        progressPosition = player.currentTime;
        progressStartedAt = performance.now();
        progressRate = this.#rate;
      };
      const timer = setInterval(check, 50);
      player.addEventListener('error', failed, { once: true });
      player.addEventListener('ended', check);
      player.addEventListener('seeking', resetProgress);
      signal.addEventListener('abort', done, { once: true });
      check();
    });
  }
  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload = false,
    selectionOnly = false,
  ): AsyncIterable<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml, this.#lang);
    if (!marks.length || signal.aborted) return;
    let first = selectionOnly ? -1 : this.#findMarks(marks);
    let batches = this.#batches;
    if (first < 0) {
      if (!selectionOnly && this.#sentences.length)
        throw new Error(
          'The selected speech text could not be matched to this chapter. No MiMo request was sent.',
        );
      // Selection-only reading can contain a range absent from the section.
      // It is an explicit short request; ordinary reading always batches.
      first = 0;
      let ordinal = 0;
      batches = buildMiMoBatches(
        marks.map((m) => ({ text: m.text, lang: m.language })),
        getMiMoConfig().batchMinutes,
      ).map((batch) => {
        const result = { ...batch, first: ordinal };
        ordinal += batch.sentences.length;
        return result;
      });
    }
    const generation = this.#generation;
    // Prepared reading consumes a complete segment, possibly spanning several
    // original paragraphs. The controller resumes at its next CFI after end.
    const planned = batches === this.#batches;
    const selected = planned ? [await this.#batchAt(first, signal)] : batches;
    for (const batch of selected) {
      if (signal.aborted || generation !== this.#generation) return;
      const audio = await this.#getAudio(batch, signal);
      if (signal.aborted || generation !== this.#generation) return;
      if (preload) break;
      const newRecording = this.#loadedBatch !== batch;
      const player = await this.#load(batch, audio, signal);
      if (signal.aborted || generation !== this.#generation) return;
      if (newRecording || this.#nextPosition !== null) {
        player.currentTime = Math.min(audio.duration, this.#nextPosition || 0);
        this.#nextPosition = null;
      }
      player.playbackRate = this.#rate;
      if (!this.#paused && !player.ended && player.paused) await this.#play(player, signal);
      if (planned) this.#ensureBuffer(batch, signal, generation);
      const end = batch.first + batch.sentences.length;
      const next = this.#sentences[end];
      yield {
        code: 'boundary',
        mark: marks[0]!.name,
        segment: planned
          ? {
              startCFI: batch.sentences[0]?.cfi,
              endCFI: batch.sentences.at(-1)?.cfi,
              nextCFI: next?.section === batch.sentences[0]?.section ? next?.cfi : undefined,
            }
          : undefined,
      };
      await this.#waitUntil(player, signal, generation, batch);
      if (signal.aborted || generation !== this.#generation) return;
      await this.#waitForResume(signal, generation);
      if (signal.aborted || generation !== this.#generation) return;
      if (planned) this.#cursor = end;
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
    // A navigation offset belongs to the next speak(), not the old recording.
    if (this.#audio && !this.#audio.ended && this.#nextPosition === null)
      await this.#play(this.#audio);
    return true;
  }
  async stop(handover = false): Promise<void> {
    this.#generation++;
    this.#lookaheadAbort?.abort();
    if (!handover) this.#cancelBufferRequests();
    for (const wake of this.#resumeWaiters) wake();
    if (!handover) {
      this.#paused = false;
      this.#audio?.pause();
      this.#nextPosition = 0;
    }
  }
  setNextChunkPosition(seconds: number): void {
    this.#cancelBufferRequests();
    this.#batches.forEach((batch) => {
      if (batch !== this.#loadedBatch) batch.audio = undefined;
    });
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
    if (MIMO_VOICES.some((v) => `mimo:${v}` === voice)) {
      this.#voice = voice;
      this.#latencies = [];
      this.#bufferTarget = 90;
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
    return this.#voice || `mimo:${getMiMoConfig().voice}`;
  }
  getSpeakingLang(): string {
    return this.#lang;
  }
  async getAllVoices(): Promise<TTSVoice[]> {
    return MIMO_VOICES.map((voice) => ({
      id: `mimo:${voice}`,
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
        name: 'MiMo TTS',
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
      ownsAudioFocus: false,
      wordBoundaries: false,
      mediaClock: false,
      textHighlight: true,
      segmentBoundaries: true,
      gapControl: false,
      liveRateChange: true,
      continuousTimeline: true,
      bookDownload: false,
      managesLookahead: true,
    };
  }
}
