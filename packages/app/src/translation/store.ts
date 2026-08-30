import { create } from "zustand";
import { translationCache } from "./cache";
import {
  DEFAULT_TRANSLATION_CONFIG,
  isTranslationConfigured,
  translateSegments,
  type TranslationPromptKind,
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

function entryKey(promptKind: TranslationPromptKind, targetLanguage: string, text: string): string {
  return `${promptKind}\n${targetLanguage}\n${text}`;
}

export type TranslationStatus = "failed";

interface TranslationState {
  entries: Record<string, string>;
  status: Record<string, TranslationStatus>;
  /**
   * What the user typed, keyed by the prompt's `clientMessageId`.
   *
   * Keyed by identity rather than by the wire text: two different prompts can translate to
   * the same string, and a text-keyed map would let the second overwrite the first, so one
   * message would render another's words.
   */
  originals: Record<string, string>;
}

export const useTranslationStore = create<TranslationState>()(() => ({
  entries: {},
  status: {},
  originals: {},
}));

interface QueuedJob {
  key: string;
  text: string;
  targetLanguage: string;
  promptKind: TranslationPromptKind;
}

let config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG;
let queue = new Map<string, QueuedJob>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Kept in sync from React by `useTranslationRuntimeSync`. The queue runs outside React, so
 * it reads the config from here rather than from a hook.
 */
function configFingerprint(value: TranslationConfig): string {
  return [value.baseUrl, value.apiKey, value.model, value.myLanguage, value.agentLanguage].join(
    "\u0000",
  );
}

export function setTranslationConfig(next: TranslationConfig): void {
  const previous = config;
  config = next;
  // Failures are sticky for the session, so correcting a bad endpoint, key, or model has to
  // retire them. Otherwise every message that failed under the old settings stays
  // untranslated until the app restarts.
  if (configFingerprint(previous) !== configFingerprint(next)) {
    const { status } = useTranslationStore.getState();
    if (Object.keys(status).length > 0) {
      useTranslationStore.setState({ status: {} });
    }
  }
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
async function runJobs(
  targetLanguage: string,
  promptKind: TranslationPromptKind,
  jobs: readonly QueuedJob[],
): Promise<void> {
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
        promptKind,
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
    translationCache.set(targetLanguage, entry.job.text, body, promptKind);
  });
  commitEntries(entries);
}

function flushQueue(): void {
  flushTimer = null;
  const drained = [...queue.values()];
  queue = new Map();
  if (drained.length === 0) return;

  const byPrompt = new Map<string, QueuedJob[]>();
  for (const job of drained) {
    const bucketKey = `${job.promptKind}\u0000${job.targetLanguage}`;
    const bucket = byPrompt.get(bucketKey);
    if (bucket) bucket.push(job);
    else byPrompt.set(bucketKey, [job]);
  }

  for (const jobs of byPrompt.values()) {
    const first = jobs[0];
    if (first) void runJobs(first.targetLanguage, first.promptKind, jobs);
  }
}

/**
 * Ask for a translation. Safe to call from render: it returns a cached value when there is
 * one and otherwise only schedules work, without writing store state synchronously.
 */
export function requestTranslation(
  text: string,
  targetLanguage: string,
  promptKind: TranslationPromptKind = "default",
): string | undefined {
  if (!isTranslationConfigured(config)) return undefined;
  if (text.trim().length === 0) return undefined;

  const key = entryKey(promptKind, targetLanguage, text);
  const state = useTranslationStore.getState();
  const known = state.entries[key];
  if (known !== undefined) return known;
  // A failed job stays failed for the session. Retrying on every render would turn a bad
  // endpoint into an unbounded request loop.
  if (state.status[key] === "failed") return undefined;

  const cached = translationCache.get(targetLanguage, text, promptKind);
  if (cached !== undefined) {
    // Deferred because callers read this during render, and writing store state there is
    // what produces React's "cannot update a component while rendering" warning.
    queueMicrotask(() => commitEntries({ [key]: cached }));
    return cached;
  }

  // The queue itself is the de-dupe, so no store write is needed to mark work in flight.
  if (queue.has(key)) return undefined;
  queue.set(key, { key, text, targetLanguage, promptKind });
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
export function lookupTranslation(
  text: string,
  targetLanguage: string,
  promptKind: TranslationPromptKind = "default",
): string | undefined {
  const key = entryKey(promptKind, targetLanguage, text);
  const known = useTranslationStore.getState().entries[key];
  if (known !== undefined) return known;

  const cached = translationCache.get(targetLanguage, text, promptKind);
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
export async function translateNow(
  text: string,
  targetLanguage: string,
  promptKind: TranslationPromptKind = "default",
): Promise<string> {
  if (!isTranslationConfigured(config)) return text;
  if (text.trim().length === 0) return text;

  const key = entryKey(promptKind, targetLanguage, text);
  const known = useTranslationStore.getState().entries[key];
  if (known !== undefined) return known;
  const cached = translationCache.get(targetLanguage, text, promptKind);
  if (cached !== undefined) return cached;

  try {
    await runJobs(targetLanguage, promptKind, [{ key, text, targetLanguage, promptKind }]);
    return useTranslationStore.getState().entries[key] ?? text;
  } catch (error) {
    console.warn("[translation] Input translation failed; sending the original", error);
    return text;
  }
}

/**
 * Translate composer input into the agent's language and return what should go on the wire.
 *
 * The original is recorded against the prompt's `clientMessageId`. The daemon echoes back a
 * canonical `user_message` holding the text it received — the translation — which replaces
 * the optimistic row; without this the user would read a translation of their own words.
 */
export async function translateComposerInput(
  text: string,
  clientMessageId: string,
): Promise<string> {
  const wireText = await translateNow(text, config.agentLanguage);
  if (wireText !== text) {
    useTranslationStore.setState((current) => ({
      originals: { ...current.originals, [clientMessageId]: text },
    }));
  }
  return wireText;
}

export function selectPromptOriginal(
  state: TranslationState,
  clientMessageId: string | undefined,
): string | undefined {
  return clientMessageId === undefined ? undefined : state.originals[clientMessageId];
}

/**
 * The reader-language translation of `text` if one is already known, else `text`.
 *
 * Synchronous and request-free, for non-React callers such as the copy action, which must
 * put on the clipboard exactly what the reader sees.
 */
export function translateForReaderSync(text: string): string {
  return lookupTranslation(text, config.myLanguage) ?? text;
}

export function translateForAgentOutputSync(text: string): string {
  return lookupTranslation(text, config.myLanguage, "agent-output") ?? text;
}

export function selectTranslation(
  state: TranslationState,
  text: string,
  targetLanguage: string,
  promptKind: TranslationPromptKind = "default",
): string | undefined {
  return state.entries[entryKey(promptKind, targetLanguage, text)];
}

/** Test seam: drop all queued work and memoized results. */
export function resetTranslationStoreForTest(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  queue = new Map();
  config = DEFAULT_TRANSLATION_CONFIG;
  useTranslationStore.setState({ entries: {}, status: {}, originals: {} }, true);
}
