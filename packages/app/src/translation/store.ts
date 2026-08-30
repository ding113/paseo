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

export function translationEntryKey(
  promptKind: TranslationPromptKind,
  targetLanguage: string,
  text: string,
): string {
  return `${promptKind}\n${targetLanguage}\n${text}`;
}

export type TranslationStatus = "pending" | "streaming" | "complete" | "failed";

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
  /** What was sent to the agent, even while an optimistic row still presents local text. */
  wireTexts: Record<string, string>;
}

export const useTranslationStore = create<TranslationState>()(() => ({
  entries: {},
  status: {},
  originals: {},
  wireTexts: {},
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
let configGeneration = 0;
const activeControllers = new Set<AbortController>();

/**
 * Kept in sync from React by `useTranslationRuntimeSync`. The queue runs outside React, so
 * it reads the config from here rather than from a hook.
 */
function configFingerprint(value: TranslationConfig): string {
  return [
    value.provider,
    value.baseUrl,
    value.apiKey,
    value.model,
    value.reasoningEffort,
    value.myLanguage,
    value.agentLanguage,
  ].join("\u0000");
}

export function setTranslationConfig(next: TranslationConfig): void {
  const previous = config;
  config = next;
  // Failures are sticky for the session, so correcting a bad endpoint, key, or model has to
  // retire them. Otherwise every message that failed under the old settings stays
  // untranslated until the app restarts.
  if (configFingerprint(previous) !== configFingerprint(next)) {
    configGeneration += 1;
    for (const controller of activeControllers) controller.abort(new Error("Config changed"));
    activeControllers.clear();
    queue = new Map();
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    const { entries, status } = useTranslationStore.getState();
    if (Object.keys(status).length > 0) {
      const completeEntries: Record<string, string> = {};
      const completeStatus: Record<string, TranslationStatus> = {};
      for (const [key, value] of Object.entries(entries)) {
        if (status[key] === "complete") {
          completeEntries[key] = value;
          completeStatus[key] = "complete";
        }
      }
      useTranslationStore.setState({ entries: completeEntries, status: completeStatus });
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
    for (const key of Object.keys(entries)) status[key] = "complete";
    return { entries: { ...state.entries, ...entries }, status };
  });
}

function commitStreaming(entries: Record<string, string>): void {
  if (Object.keys(entries).length === 0) return;
  useTranslationStore.setState((state) => {
    const shouldUpdateStatus = Object.entries(entries).some(
      ([key, value]) => value.trim().length > 0 && state.status[key] !== "streaming",
    );
    const status = shouldUpdateStatus ? { ...state.status } : state.status;
    for (const [key, value] of Object.entries(entries)) {
      if (value.trim().length > 0 && status[key] !== "streaming") {
        status[key] = "streaming";
      }
    }
    return { entries: { ...state.entries, ...entries }, status };
  });
}

function markPending(keys: readonly string[]): void {
  useTranslationStore.setState((state) => {
    const status = { ...state.status };
    for (const key of keys) status[key] = "pending";
    return { status };
  });
}

function markFailed(keys: readonly string[]): void {
  useTranslationStore.setState((state) => {
    const status = { ...state.status };
    const entries = { ...state.entries };
    for (const key of keys) {
      status[key] = "failed";
      delete entries[key];
    }
    return { entries, status };
  });
}

function joinAvailablePrefix(parts: readonly TextPart[]): string {
  const visible: TextPart[] = [];
  for (const part of parts) {
    if (part.translate && part.text.trim().length === 0) break;
    visible.push(part);
  }
  return joinParts(visible);
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
  const generation = configGeneration;
  const requestConfig = config;
  const controller = new AbortController();
  let stopped = false;
  activeControllers.add(controller);
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
    activeControllers.delete(controller);
    return;
  }

  const results: Array<TextPart[]> = expanded.map((entry) =>
    entry.parts.map((part) => ({ ...part, text: part.translate ? "" : part.text })),
  );

  for (let offset = 0; offset < pending.length; offset += MAX_BATCH_SEGMENTS) {
    const chunk = pending.slice(offset, offset + MAX_BATCH_SEGMENTS);
    try {
      const translated = await translateSegments({
        segments: chunk.map((item) => item.text),
        targetLanguage,
        config: requestConfig,
        promptKind,
        signal: controller.signal,
        onText: (segmentIndex, value) => {
          if (stopped || generation !== configGeneration) return;
          const item = chunk[segmentIndex];
          if (!item) return;
          const part = results[item.jobIndex]?.[item.partIndex];
          if (!part) return;
          part.text = value;
          const job = expanded[item.jobIndex]?.job;
          const parts = results[item.jobIndex];
          if (job && parts) commitStreaming({ [job.key]: joinAvailablePrefix(parts) });
        },
      });
      chunk.forEach((item, index) => {
        const value = translated[index];
        if (value === undefined) return;
        const part = results[item.jobIndex]?.[item.partIndex];
        if (part) part.text = value;
      });
    } catch (error) {
      stopped = true;
      controller.abort(error);
      if (generation === configGeneration) {
        console.warn("[translation] Batch failed", error);
        markFailed(jobs.map((job) => job.key));
      }
      activeControllers.delete(controller);
      return;
    }
  }

  activeControllers.delete(controller);
  if (generation !== configGeneration) return;

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

  const key = translationEntryKey(promptKind, targetLanguage, text);
  const state = useTranslationStore.getState();
  // A failed job stays failed for the session. Retrying on every render would turn a bad
  // endpoint into an unbounded request loop.
  if (state.status[key] === "failed") return undefined;
  const known = state.entries[key];
  if (known !== undefined) return known;

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
  queueMicrotask(() => {
    if (queue.has(key)) markPending([key]);
  });
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
  const key = translationEntryKey(promptKind, targetLanguage, text);
  const state = useTranslationStore.getState();
  const known = state.entries[key];
  if (known !== undefined && state.status[key] === "complete") return known;

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

  const key = translationEntryKey(promptKind, targetLanguage, text);
  const current = useTranslationStore.getState();
  const known = current.entries[key];
  if (
    known !== undefined &&
    current.status[key] !== "pending" &&
    current.status[key] !== "streaming"
  ) {
    return known;
  }
  if (current.status[key] === "pending" || current.status[key] === "streaming") {
    const inFlight = await waitForTranslation(key);
    if (inFlight !== undefined) return inFlight;
  }
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

function waitForTranslation(key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const unsubscribe = useTranslationStore.subscribe((state, previous) => {
      if (state.status[key] === previous.status[key]) return;
      if (state.status[key] === "complete") {
        unsubscribe();
        resolve(state.entries[key]);
      } else if (state.status[key] === "failed" || state.status[key] === undefined) {
        unsubscribe();
        resolve(undefined);
      }
    });
  });
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
  const slash = splitLeadingSlashCommand(text);
  const translatedBody = await translateNow(slash.body, config.agentLanguage);
  const wireText = `${slash.prefix}${translatedBody}`;
  if (wireText !== text) {
    useTranslationStore.setState((current) => ({
      originals: { ...current.originals, [clientMessageId]: text },
      wireTexts: { ...current.wireTexts, [clientMessageId]: wireText },
    }));
  }
  return wireText;
}

/** Translate free-form interactive UI input into the language used by the agent. */
export function translateTextForAgent(text: string): Promise<string> {
  return translateNow(text, config.agentLanguage);
}

export function selectPromptOriginal(
  state: TranslationState,
  clientMessageId: string | undefined,
): string | undefined {
  return clientMessageId === undefined ? undefined : state.originals[clientMessageId];
}

export function selectPromptWireText(
  state: TranslationState,
  clientMessageId: string | undefined,
): string | undefined {
  return clientMessageId === undefined ? undefined : state.wireTexts[clientMessageId];
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
  return state.entries[translationEntryKey(promptKind, targetLanguage, text)];
}

export function selectTranslationStatus(
  state: TranslationState,
  text: string,
  targetLanguage: string,
  promptKind: TranslationPromptKind = "default",
): TranslationStatus | undefined {
  return state.status[translationEntryKey(promptKind, targetLanguage, text)];
}

export function splitLeadingSlashCommand(text: string): { prefix: string; body: string } {
  const command = text.match(/^(\s*\/\S+)(\s*)([\s\S]*)$/);
  if (!command) return { prefix: "", body: text };
  return { prefix: `${command[1]}${command[2]}`, body: command[3] ?? "" };
}

/** Test seam: drop all queued work and memoized results. */
export function resetTranslationStoreForTest(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  queue = new Map();
  configGeneration += 1;
  for (const controller of activeControllers) controller.abort(new Error("Test reset"));
  activeControllers.clear();
  config = DEFAULT_TRANSLATION_CONFIG;
  useTranslationStore.setState({ entries: {}, status: {}, originals: {}, wireTexts: {} }, true);
}
