import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  buildQuestionFormAnswersForAgent,
  parseQuestionFormQuestions,
  projectQuestionFormTranslations,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./question-form-card-core";

describe("question form card core", () => {
  test("treats optional input prompts as skippable empty answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Optional comment?",
          header: "Response",
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
          dismissLabel: "Skip",
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(areQuestionsAnswered(questions, {}, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, {})).toEqual({ Response: "" });
    expect(shouldSubmitEmptyOnDismiss(questions)).toBe(true);
    expect(resolveDismissLabel(questions)).toBe("Skip");
  });

  test("requires a selection for option-only questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick one",
          header: "Response",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(false);
    expect(areQuestionsAnswered(questions, {}, { 0: "freeform" })).toBe(false);
    expect(areQuestionsAnswered(questions, { 0: new Set([1]) }, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      Response: "B",
    });
  });

  test("shows text input for explicit other questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          isOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  test("shows text input for questions that allow other answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          allowOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  test("projects question copy into the reader language without changing option identity", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Choose a path",
          header: "Path",
          options: [{ label: "Fast", description: "Ship now" }],
          allowOther: true,
          placeholder: "Type another path",
          dismissLabel: "Skip this",
        },
      ],
    });
    if (!questions) throw new Error("questions did not parse");
    const translated = projectQuestionFormTranslations(questions, (text) => `译:${text}`);
    expect(translated[0]).toMatchObject({
      question: "译:Choose a path",
      header: "译:Path",
      placeholder: "译:Type another path",
      dismissLabel: "译:Skip this",
      options: [{ label: "译:Fast", description: "译:Ship now" }],
    });
  });

  test("translates free-text answers back to the agent language but preserves selected values", async () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        { question: "Pick", header: "Choice", options: [{ label: "Original option" }] },
        { question: "Explain", header: "Reason", options: [], allowEmpty: false },
      ],
    });
    if (!questions) throw new Error("questions did not parse");
    const translate = async (text: string) => `agent:${text}`;
    await expect(
      buildQuestionFormAnswersForAgent(
        questions,
        { 0: new Set([0]) },
        { 1: "用户输入" },
        translate,
      ),
    ).resolves.toEqual({ Choice: "Original option", Reason: "agent:用户输入" });
  });
});
