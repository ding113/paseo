import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "paseo.translation.cache.v1";
const MAX_ENTRIES = 2_000;
/** Rough ceiling so a long-lived install cannot grow AsyncStorage without bound. */
const MAX_CHARS = 1_000_000;
const WRITE_DEBOUNCE_MS = 2_000;

/**
 * The cache key is the target language plus the *whole* source string.
 *
 * ponytail: no hash. A 32-bit hash is shorter, but a collision serves one message's
 * translation under another message's text, which reads as a bug nobody can reproduce.
 * Storing the source costs the same order of bytes as the translation sitting next to
 * it, and the bounds below keep that honest.
 */
function cacheKey(targetLang: string, text: string): string {
  return `${targetLang}\u0000${text}`;
}

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface TranslationCache {
  get(targetLang: string, text: string): string | undefined;
  set(targetLang: string, text: string, translated: string): void;
  hydrate(): Promise<void>;
  /** Flush the pending debounced write. Tests await this; production fires on a timer. */
  flush(): Promise<void>;
  size(): number;
}

export function createTranslationCache(storage: KeyValueStore): TranslationCache {
  // Insertion order is the LRU order: a hit deletes and re-sets to move the entry to the end.
  const entries = new Map<string, string>();
  let chars = 0;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingWrite: Promise<void> | null = null;

  function evictUntilWithinBounds(): void {
    while (entries.size > MAX_ENTRIES || chars > MAX_CHARS) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      const value = entries.get(oldest.value);
      entries.delete(oldest.value);
      chars -= oldest.value.length + (value?.length ?? 0);
    }
  }

  async function write(): Promise<void> {
    writeTimer = null;
    try {
      await storage.setItem(STORAGE_KEY, JSON.stringify([...entries]));
    } catch (error) {
      console.warn("[translation] Failed to persist cache", error);
    }
  }

  function scheduleWrite(): void {
    if (writeTimer !== null) return;
    writeTimer = setTimeout(() => {
      pendingWrite = write();
    }, WRITE_DEBOUNCE_MS);
  }

  return {
    get(targetLang, text) {
      const key = cacheKey(targetLang, text);
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(targetLang, text, translated) {
      const key = cacheKey(targetLang, text);
      const previous = entries.get(key);
      if (previous !== undefined) {
        entries.delete(key);
        chars -= key.length + previous.length;
      }
      entries.set(key, translated);
      chars += key.length + translated.length;
      evictUntilWithinBounds();
      scheduleWrite();
    },
    async hydrate() {
      try {
        const raw = await storage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        for (const pair of parsed) {
          if (!Array.isArray(pair) || pair.length !== 2) continue;
          const [key, value] = pair;
          if (typeof key !== "string" || typeof value !== "string") continue;
          entries.set(key, value);
          chars += key.length + value.length;
        }
        evictUntilWithinBounds();
      } catch (error) {
        console.warn("[translation] Failed to hydrate cache", error);
      }
    },
    async flush() {
      if (writeTimer !== null) {
        clearTimeout(writeTimer);
        pendingWrite = write();
      }
      await pendingWrite;
    },
    size() {
      return entries.size;
    },
  };
}

export const translationCache: TranslationCache = createTranslationCache(AsyncStorage);
