import { describe, expect, it } from "vitest";
import { createTranslationCache, type KeyValueStore } from "./cache";

function createMemoryStore(seed?: string): KeyValueStore & { value: string | null } {
  return {
    value: seed ?? null,
    async getItem() {
      return this.value;
    },
    async setItem(_key: string, value: string) {
      this.value = value;
    },
  };
}

describe("translation cache", () => {
  it("round-trips a translation", () => {
    const cache = createTranslationCache(createMemoryStore());
    cache.set("zh-CN", "Hello", "你好");
    expect(cache.get("zh-CN", "Hello")).toBe("你好");
  });

  it("misses instead of returning another language's translation", () => {
    const cache = createTranslationCache(createMemoryStore());
    cache.set("zh-CN", "Hello", "你好");
    expect(cache.get("ja", "Hello")).toBeUndefined();
  });

  it("keeps agent-output rewrites separate from default translations", () => {
    const cache = createTranslationCache(createMemoryStore());
    cache.set("zh-CN", "Hello", "你好");
    expect(cache.get("zh-CN", "Hello", "agent-output")).toBeUndefined();
    cache.set("zh-CN", "Hello", "你好，朋友", "agent-output");
    expect(cache.get("zh-CN", "Hello")).toBe("你好");
    expect(cache.get("zh-CN", "Hello", "agent-output")).toBe("你好，朋友");
  });

  it("misses for text it has never seen", () => {
    const cache = createTranslationCache(createMemoryStore());
    cache.set("zh-CN", "Hello", "你好");
    expect(cache.get("zh-CN", "Goodbye")).toBeUndefined();
  });

  it("evicts the least recently used entry past the size bound", () => {
    const cache = createTranslationCache(createMemoryStore());
    // One char over the 1_000_000-char ceiling, spread over two entries.
    const big = "x".repeat(600_000);
    cache.set("zh-CN", `a${big}`, "1");
    cache.set("zh-CN", `b${big}`, "2");
    expect(cache.get("zh-CN", `a${big}`)).toBeUndefined();
    expect(cache.get("zh-CN", `b${big}`)).toBe("2");
  });

  it("keeps an entry alive when it is read before the bound is hit", () => {
    const cache = createTranslationCache(createMemoryStore());
    const big = "x".repeat(600_000);
    cache.set("zh-CN", `a${big}`, "1");
    // Reading `a` makes `b` the least recently used once the next write overflows.
    expect(cache.get("zh-CN", `a${big}`)).toBe("1");
    cache.set("zh-CN", `b${big}`, "2");
    expect(cache.get("zh-CN", `a${big}`)).toBeUndefined();
  });

  it("restores persisted entries on hydrate", async () => {
    const store = createMemoryStore();
    const first = createTranslationCache(store);
    first.set("zh-CN", "Hello", "你好");
    await first.flush();

    const second = createTranslationCache(store);
    expect(second.get("zh-CN", "Hello")).toBeUndefined();
    await second.hydrate();
    expect(second.get("zh-CN", "Hello")).toBe("你好");
  });

  it("survives a corrupt persisted payload", async () => {
    const cache = createTranslationCache(createMemoryStore("not json"));
    await cache.hydrate();
    expect(cache.size()).toBe(0);
  });
});
