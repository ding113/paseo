import { create } from "zustand";
import { translationCache } from "./cache";
import {
  DEFAULT_TRANSLATION_CONFIG,
  isTranslationConfigured,
  translateSegments,
  type TranslationConfig,
} from "./client";
import { joinParts, splitTranslatableParts, type TextPart } from "./segments";

/**
 * How long to collect newly-requested text before issuing one request. A message's blocks
 * are promoted to the timeline within a few frames of each other, so this window is what
 * turns "one request per paragraph" into "one request per message".
 */
const BATCH_WINDOW_MS = 300;
/** Concurrent requests per flush. Each segment is its own request; this caps the fan-out. */
const MAX_BATCH_SEGMENTS = 20;

function entryKey(targetLanguage: string, text: string): string {
  return `${targetLanguage}\n${text}`;
}

export type TranslationStatus = "failed";

interface TranslationState {
  entries: Record<string, string>;
  status: Record<string, TranslationStatus>;
}

export const useTranslationStore = create<TranslationState>()(() => ({
  entries: {},
  status: {},
}));

interface QueuedJob {
  key: string;
  text: string;
  targetLanguage: string;
}

let config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG;
let queue = new Map<string, QueuedJob>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Kept in sync from React by `useTranslationRuntimeSync`. The queue runs outside React, so
 * it reads the config from here rather than from a hook.
 */
export function setTranslationConfig(next: TranslationConfig): void {
  config = next;
}

export function getTranslationConfig(): TranslationConfig {
  return config;
}

function commitEntries(entries: Record<string, string>): void {
  if (Object.keys(entries).length === 0) return;
  useTranslationStore.setState((state) => {
    const status = { ...state.status };
    for (const key of Object.keys(entries)) delete status[key];
    return { entries: { ...state.entries, ...entries }, status };
  });
}

function markFailed(keys: readonly string[]): void {
  useTranslationStore.setState((state) => {
    const status = { ...state.status };
    for (const key of keys) status[key] = "failed";
    return { status };
  });
}

/**
 * Translate a set of jobs for one language in as few requests as possible.
 *
 * Each job expands into its prose blocks; code blocks never leave the client. The
 * expanded segments from every job are flattened into shared requests and then folded
 * back into per-job messages by walking the parts in order.
 */
async function runJobs(targetLanguage: string, jobs: readonly QueuedJob[]): Promise<void> {
  const expanded = jobs.map((job) => ({ job, parts: splitTranslatableParts(job.text) }));

  const pending: Array<{ jobIndex: number; partIndex: number; text: string }> = [];
  expanded.forEach((entry, jobIndex) => {
    entry.parts.forEach((part, partIndex) => {
      if (part.translate && part.text.trim().length > 0) {
        pending.push({ jobIndex, partIndex, text: part.text });
      }
    });
  });

  if (pending.length === 0) {
    // Nothing translatable — the message is pure code. Record it as its own translation so
    // it is not re-queued on every render.
    commitEntries(Object.fromEntries(jobs.map((job) => [job.key, job.text])));
    return;
  }

  const results: Array<TextPart[]> = expanded.map((entry) =>
    entry.parts.map((part) => ({ ...part })),
  );

  for (let offset = 0; offset < pending.length; offset += MAX_BATCH_SEGMENTS) {
    const chunk = pending.slice(offset, offset + MAX_BATCH_SEGMENTS);
    try {
      const translated = await translateSegments({
        segments: chunk.map((item) => item.text),
        targetLanguage,
        config,
      });
      chunk.forEach((item, index) => {
        const value = translated[index];
        if (value === undefined) return;
        const part = results[item.jobIndex]?.[item.partIndex];
        if (part) part.text = value;
      });
    } catch (error) {
      console.warn("[translation] Batch failed", error);
      markFailed(chunk.map((item) => expanded[item.jobIndex]?.job.key ?? ""));
      return;
    }
  }

  const entries: Record<string, string> = {};
  expanded.forEach((entry, jobIndex) => {
    const parts = results[jobIndex];
    if (!parts) return;
    const body = joinParts(parts);
    entries[entry.job.key] = body;
    translationCache.set(targetLanguage, entry.job.text, body);
  });
  commitEntries(entries);
}

function flushQueue(): void {
  flushTimer = null;
  const drained = [...queue.values()];
  queue = new Map();
  if (drained.length === 0) return;

  const byLanguage = new Map<string, QueuedJob[]>();
  for (const job of drained) {
    const bucket = byLanguage.get(job.targetLanguage);
    if (bucket) bucket.push(job);
    else byLanguage.set(job.targetLanguage, [job]);
  }

  for (const [targetLanguage, jobs] of byLanguage) {
    void runJobs(targetLanguage, jobs);
  }
}

/**
 * Ask for a translation. Safe to call from render: it returns a cached value when there is
 * one and otherwise only schedules work, without writing store state synchronously.
 */
export function requestTranslation(text: string, targetLanguage: string): string | undefined {
  if (!isTranslationConfigured(config)) return undefined;
  if (text.trim().length === 0) return undefined;

  const key = entryKey(targetLanguage, text);
  const state = useTranslationStore.getState();
  const known = state.entries[key];
  if (known !== undefined) return known;
  // A failed job stays failed for the session. Retrying on every render would turn a bad
  // endpoint into an unbounded request loop.
  if (state.status[key] === "failed") return undefined;

  const cached = translationCache.get(targetLanguage, text);
  if (cached !== undefined) {
    // Deferred because callers read this during render, and writing store state there is
    // what produces React's "cannot update a component while rendering" warning.
    queueMicrotask(() => commitEntries({ [key]: cached }));
    return cached;
  }

  // The queue itself is the de-dupe, so no store write is needed to mark work in flight.
  if (queue.has(key)) return undefined;
  queue.set(key, { key, text, targetLanguage });
  if (flushTimer === null) {
    flushTimer = setTimeout(flushQueue, BATCH_WINDOW_MS);
  }
  return undefined;
}

/**
 * Read a known translation without ever requesting one.
 *
 * Used for the user's own messages: the original is seeded when the prompt is sent, so a
 * hit is what they typed. A miss means the text was never translated here — a message
 * from before translation was configured, or from the CLI — and paying for a round trip
 * to render someone's own words back at them is not worth it.
 */
export function lookupTranslation(text: string, targetLanguage: string): string | undefined {
  const key = entryKey(targetLanguage, text);
  const known = useTranslationStore.getState().entries[key];
  if (known !== undefined) return known;

  const cached = translationCache.get(targetLanguage, text);
  if (cached === undefined) return undefined;
  queueMicrotask(() => commitEntries({ [key]: cached }));
  return cached;
}

/**
 * Translate one string and wait for it. Used for composer input, where the user has
 * already pressed send and the translated text is what goes on the wire.
 *
 * A failure returns the original rather than throwing: the alternative is that a flaky
 * translation endpoint blocks the user from talking to their agent at all. The agent still
 * receives the message, just untranslated.
 */
export async function translateNow(text: string, targetLanguage: string): Promise<string> {
  if (!isTranslationConfigured(config)) return text;
  if (text.trim().length === 0) return text;

  const key = entryKey(targetLanguage, text);
  const known = useTranslationStore.getState().entries[key];
  if (known !== undefined) return known;
  const cached = translationCache.get(targetLanguage, text);
  if (cached !== undefined) return cached;

  try {
    await runJobs(targetLanguage, [{ key, text, targetLanguage }]);
    return useTranslationStore.getState().entries[key] ?? text;
  } catch (error) {
    console.warn("[translation] Input translation failed; sending the original", error);
    return text;
  }
}

function seedTranslation(targetLanguage: string, text: string, translated: string): void {
  translationCache.set(targetLanguage, text, translated);
  commitEntries({ [entryKey(targetLanguage, text)]: translated });
}

/**
 * Translate composer input into the agent's language and return what should go on the wire.
 *
 * It also seeds the reverse direction. The daemon echoes back a canonical `user_message`
 * containing the text it received — the translation — which would otherwise replace the
 * optimistic row and show the user a translation of their own words. Registering the
 * original as the translation of the wire text makes that echo render as what they typed,
 * with no message-id bookkeeping anywhere.
 */
export async function translateComposerInput(text: string): Promise<string> {
  const wireText = await translateNow(text, config.agentLanguage);
  if (wireText !== text) {
    seedTranslation(config.myLanguage, wireText, text);
  }
  return wireText;
}

export function selectTranslation(
  state: TranslationState,
  text: string,
  targetLanguage: string,
): string | undefined {
  return state.entries[entryKey(targetLanguage, text)];
}

/** Test seam: drop all queued work and memoized results. */
export function resetTranslationStoreForTest(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  queue = new Map();
  config = DEFAULT_TRANSLATION_CONFIG;
  useTranslationStore.setState({ entries: {}, status: {} }, true);
}
