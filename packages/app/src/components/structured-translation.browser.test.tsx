import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import { DEFAULT_TRANSLATION_CONFIG } from "@/translation/client";
import {
  resetTranslationStoreForTest,
  setTranslationConfig,
  translationEntryKey,
  useTranslationStore,
} from "@/translation/store";
import type { PendingPermission } from "@/types/shared";
import { PlanCard } from "./plan-card";
import { QuestionFormCard } from "./question-form-card";

// PlanCard renders through the full Markdown renderer, whose code-block and diagram modules need
// native stubs this harness doesn't have. These tests only need the translated body to reach it.
vi.mock("@/components/markdown/renderer", async () => {
  const { createElement } = await import("react");
  return {
    MarkdownRenderer: ({ text }: { text: string }) => createElement("span", null, text),
  };
});

const translationConfig = {
  ...DEFAULT_TRANSLATION_CONFIG,
  enabled: true,
  apiKey: "test-key",
};
const optionQuestionPermission: PendingPermission = {
  key: "question-1",
  agentId: "agent-1",
  request: {
    id: "question-1",
    provider: "codex",
    name: "ask_user_question",
    kind: "question",
    input: {
      questions: [
        {
          question: "Choose a path",
          header: "Path",
          options: [{ label: "Fast", description: "Ship now" }],
          multiSelect: false,
        },
      ],
    },
  },
};
const freeTextQuestionPermission: PendingPermission = {
  key: "question-free-text",
  agentId: "agent-1",
  request: {
    id: "question-free-text",
    provider: "codex",
    name: "ask_user_question",
    kind: "question",
    input: {
      questions: [
        {
          question: "Explain the reason",
          header: "Reason",
          options: [],
          multiSelect: false,
        },
      ],
    },
  },
};
const ignoreResponse = () => {};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("structured agent translation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient();
    queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
      ...DEFAULT_CLIENT_SETTINGS,
      translation: translationConfig,
    });
    setTranslationConfig(translationConfig);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    resetTranslationStoreForTest();
    vi.unstubAllGlobals();
  });

  function seed(translations: Record<string, string>) {
    const entries: Record<string, string> = {};
    const status: Record<string, "complete"> = {};
    for (const [source, translated] of Object.entries(translations)) {
      const key = translationEntryKey("agent-output", "zh", source);
      entries[key] = translated;
      status[key] = "complete";
    }
    useTranslationStore.setState({ entries, status });
  }

  function render(node: React.ReactNode) {
    act(() => {
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
  }

  it("renders translated plan title, description, and markdown body", () => {
    seed({
      "Proposed plan": "计划标题",
      "Implementation details": "实现说明",
      "- Add tests": "- 添加测试",
    });
    render(
      <PlanCard title="Proposed plan" description="Implementation details" text="- Add tests" />,
    );
    expect(container.textContent).toContain("计划标题");
    expect(container.textContent).toContain("实现说明");
    expect(container.textContent).toContain("添加测试");
    expect(container.textContent).not.toContain("Proposed plan");
  });

  it("renders translated question and options while retaining the permission payload", () => {
    seed({
      "Choose a path": "选择路径",
      Path: "路径",
      Fast: "快速",
      "Ship now": "立即交付",
    });
    render(
      <QuestionFormCard
        permission={optionQuestionPermission}
        onRespond={ignoreResponse}
        isResponding={false}
      />,
    );
    expect(container.textContent).toContain("选择路径");
    expect(container.textContent).toContain("快速");
    expect(container.textContent).toContain("立即交付");
    expect(optionQuestionPermission.request.input).toMatchObject({
      questions: [{ question: "Choose a path", options: [{ label: "Fast" }] }],
    });
  });

  it("translates a free-text answer back to the agent language before responding", async () => {
    seed({ "Explain the reason": "说明原因", Reason: "原因" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({
              id: "translation",
              object: "chat.completion.chunk",
              created: 1,
              model: translationConfig.model,
              choices: [{ index: 0, delta: { content: "Agent answer" }, finish_reason: null }],
            })}\n\ndata: ${JSON.stringify({
              id: "translation",
              object: "chat.completion.chunk",
              created: 1,
              model: translationConfig.model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );
    const onRespond = vi.fn();
    render(
      <QuestionFormCard
        permission={freeTextQuestionPermission}
        onRespond={onRespond}
        isResponding={false}
      />,
    );
    const input = container.querySelector("input");
    const submit = container.querySelector('[data-testid="question-form-primary-action"]');
    if (!(input instanceof HTMLInputElement) || !(submit instanceof HTMLElement)) {
      throw new Error("question form controls did not render");
    }
    act(() => {
      fireEvent.change(input, { target: { value: "用户回答" } });
    });
    act(() => submit.click());
    await vi.waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith({
        behavior: "allow",
        updatedInput: expect.objectContaining({ answers: { Reason: "Agent answer" } }),
      });
    });
  });
});
