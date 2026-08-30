export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionFormQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

export type QuestionSelections = Record<number, ReadonlySet<number>>;
export type QuestionOtherTexts = Record<number, string>;

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function parseQuestionFormQuestions(input: unknown): QuestionFormQuestion[] | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("questions" in input) ||
    !Array.isArray((input as Record<string, unknown>).questions)
  ) {
    return null;
  }
  const raw = (input as Record<string, unknown>).questions as unknown[];
  const questions: QuestionFormQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || typeof q.header !== "string") return null;
    if (!Array.isArray(q.options)) return null;
    const options: QuestionOption[] = [];
    for (const opt of q.options as unknown[]) {
      if (typeof opt !== "object" || opt === null) return null;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== "string") return null;
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : undefined,
      });
    }
    questions.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther === true || q.isOther === true,
      allowEmpty: q.allowEmpty === true,
      placeholder: readOptionalString(q, "placeholder"),
      dismissLabel: readOptionalString(q, "dismissLabel"),
    });
  }
  return questions.length > 0 ? questions : null;
}

export function questionShowsTextInput(question: QuestionFormQuestion): boolean {
  return question.options.length === 0 || question.allowOther;
}

export function isQuestionAnswered(
  question: QuestionFormQuestion,
  qIndex: number,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  const selected = selections[qIndex];
  if (selected && selected.size > 0) {
    return true;
  }

  if (!questionShowsTextInput(question)) {
    return false;
  }

  const otherText = otherTexts[qIndex]?.trim();
  if (otherText && otherText.length > 0) {
    return true;
  }

  return question.allowEmpty;
}

export function areQuestionsAnswered(
  questions: QuestionFormQuestion[] | null,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  return (
    questions?.every((question, qIndex) =>
      isQuestionAnswered(question, qIndex, selections, otherTexts),
    ) ?? false
  );
}

export function buildQuestionFormAnswers(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = selections[i];
    const otherText = otherTexts[i]?.trim();

    if (questionShowsTextInput(q)) {
      if (otherText && otherText.length > 0) {
        answers[q.header] = otherText;
        continue;
      }
      if (q.allowEmpty && q.options.length === 0) {
        answers[q.header] = "";
        continue;
      }
    }

    if (selected && selected.size > 0) {
      const labels = Array.from(selected).map((idx) => q.options[idx].label);
      answers[q.header] = labels.join(", ");
    }
  }
  return answers;
}

export function projectQuestionFormTranslations(
  questions: QuestionFormQuestion[],
  translate: (text: string) => string,
): QuestionFormQuestion[] {
  const translated = (text: string | undefined): string | undefined =>
    text === undefined || text.length === 0 ? text : translate(text);
  return questions.map((question) => ({
    ...question,
    question: translated(question.question) ?? question.question,
    header: translated(question.header) ?? question.header,
    placeholder: translated(question.placeholder),
    dismissLabel: translated(question.dismissLabel),
    options: question.options.map((option) => ({
      ...option,
      label: translated(option.label) ?? option.label,
      description: translated(option.description),
    })),
  }));
}

export function listQuestionFormTranslatableTexts(questions: QuestionFormQuestion[]): string[] {
  const texts = new Set<string>();
  const add = (text: string | undefined) => {
    if (text?.trim()) texts.add(text);
  };
  for (const question of questions) {
    add(question.question);
    add(question.header);
    add(question.placeholder);
    add(question.dismissLabel);
    for (const option of question.options) {
      add(option.label);
      add(option.description);
    }
  }
  return [...texts];
}

export async function buildQuestionFormAnswersForAgent(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
  translate: (text: string) => Promise<string>,
): Promise<Record<string, string>> {
  const answers = buildQuestionFormAnswers(questions, selections, otherTexts);
  await Promise.all(
    questions.map(async (question, index) => {
      const otherText = otherTexts[index]?.trim();
      if (!questionShowsTextInput(question) || !otherText) return;
      answers[question.header] = await translate(otherText);
    }),
  );
  return answers;
}

export function shouldSubmitEmptyOnDismiss(questions: QuestionFormQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => question.allowEmpty && question.options.length === 0)
  );
}

export function resolveDismissLabel(
  questions: QuestionFormQuestion[],
  fallbackLabel = "Dismiss",
): string {
  return questions.find((question) => question.dismissLabel)?.dismissLabel ?? fallbackLabel;
}
