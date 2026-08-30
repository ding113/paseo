import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, { useState, useCallback, useEffect, useMemo } from "react";
import { View, Text, Pressable, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Check, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { isWeb } from "@/constants/platform";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  buildQuestionFormAnswersForAgent,
  isQuestionAnswered,
  listQuestionFormTranslatableTexts,
  parseQuestionFormQuestions,
  projectQuestionFormTranslations,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
  type QuestionFormQuestion,
  type QuestionOption,
} from "./question-form-card-core";
import { isTranslationConfigured } from "@/translation/client";
import { useTranslationConfig } from "@/translation/use-translation";
import {
  requestTranslation,
  translateTextForAgent,
  translationEntryKey,
  useTranslationStore,
} from "@/translation/store";

interface QuestionFormCardProps {
  permission: PendingPermission;
  onRespond: (response: AgentPermissionResponse) => void;
  isResponding: boolean;
}

const IS_WEB = isWeb;

function useTranslatedQuestionForm(questions: QuestionFormQuestion[] | null): {
  questions: QuestionFormQuestion[] | null;
  ready: boolean;
} {
  const config = useTranslationConfig();
  const enabled = isTranslationConfigured(config);
  const entries = useTranslationStore((state) => state.entries);
  const statuses = useTranslationStore((state) => state.status);
  const texts = useMemo(
    () => (questions ? listQuestionFormTranslatableTexts(questions) : []),
    [questions],
  );

  useEffect(() => {
    if (!enabled) return;
    for (const text of texts) {
      requestTranslation(text, config.myLanguage, "agent-output");
    }
  }, [config.myLanguage, enabled, texts]);

  return useMemo(() => {
    if (!questions || !enabled) return { questions, ready: true };
    let ready = true;
    const translated = projectQuestionFormTranslations(questions, (text) => {
      const key = translationEntryKey("agent-output", config.myLanguage, text);
      const status = statuses[key];
      if (status === "failed") return text;
      if (status !== "complete") ready = false;
      return entries[key] ?? text;
    });
    return { questions: translated, ready };
  }, [config.myLanguage, enabled, entries, questions, statuses]);
}

function getQuestionInputPlaceholder({
  question,
  answerPlaceholder,
  otherPlaceholder,
}: {
  question: QuestionFormQuestion;
  answerPlaceholder: string;
  otherPlaceholder: string;
}): string {
  return (
    question.placeholder ?? (question.options.length === 0 ? answerPlaceholder : otherPlaceholder)
  );
}

interface QuestionOptionRowProps {
  qIndex: number;
  optIndex: number;
  option: QuestionOption;
  isSelected: boolean;
  multiSelect: boolean;
  isResponding: boolean;
  onToggle: (qIndex: number, optIndex: number, multiSelect: boolean) => void;
}

function QuestionOptionRow({
  qIndex,
  optIndex,
  option,
  isSelected,
  multiSelect,
  isResponding,
  onToggle,
}: QuestionOptionRowProps) {
  const { theme } = useUnistyles();

  const handlePress = useCallback(() => {
    onToggle(qIndex, optIndex, multiSelect);
  }, [onToggle, qIndex, optIndex, multiSelect]);

  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.optionItem,
      (Boolean(hovered) || isSelected) && {
        backgroundColor: theme.colors.surface2,
      },
      pressed && styles.optionItemPressed,
    ],
    [isSelected, theme.colors.surface2],
  );

  const optionLabelStyle = useMemo(
    () => [
      styles.optionLabel,
      { color: isSelected ? theme.colors.foreground : theme.colors.foregroundMuted },
    ],
    [isSelected, theme.colors.foreground, theme.colors.foregroundMuted],
  );
  const optionDescriptionStyle = useMemo(
    () => [styles.optionDescription, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const accessibilityState = useMemo(() => ({ checked: isSelected }), [isSelected]);

  // Static left-side control: square for multi-select, circle for single-select.
  // Always rendered so toggling only swaps fill/border — the row never reflows.
  const controlStyle = useMemo(
    () => [
      styles.selectionControl,
      multiSelect ? styles.selectionControlCheckbox : styles.selectionControlRadio,
      {
        borderColor: isSelected ? theme.colors.accent : theme.colors.foregroundExtraMuted,
        backgroundColor: isSelected && multiSelect ? theme.colors.accent : "transparent",
      },
    ],
    [isSelected, multiSelect, theme.colors.accent, theme.colors.foregroundExtraMuted],
  );
  const radioDotStyle = useMemo(
    () => [styles.selectionRadioDot, { backgroundColor: theme.colors.accent }],
    [theme.colors.accent],
  );

  return (
    <Pressable
      style={pressableStyle}
      onPress={handlePress}
      disabled={isResponding}
      accessibilityRole={multiSelect ? "checkbox" : "radio"}
      accessibilityLabel={option.label}
      accessibilityState={accessibilityState}
      aria-checked={isSelected}
    >
      <View style={styles.optionItemContent}>
        <View style={controlStyle}>
          {isSelected && multiSelect ? (
            <Check size={12} color={theme.colors.accentForeground} />
          ) : null}
          {isSelected && !multiSelect ? <View style={radioDotStyle} /> : null}
        </View>
        <View style={styles.optionTextBlock}>
          <Text style={optionLabelStyle}>{option.label}</Text>
          {option.description ? (
            <Text style={optionDescriptionStyle}>{option.description}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

interface QuestionNavButtonProps {
  index: number;
  total: number;
  header: string;
  isActive: boolean;
  isAnswered: boolean;
  isResponding: boolean;
  onSelect: (index: number) => void;
}

function QuestionNavButton({
  index,
  total,
  header,
  isActive,
  isAnswered,
  isResponding,
  onSelect,
}: QuestionNavButtonProps) {
  const { theme } = useUnistyles();
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const handlePress = useCallback(() => {
    onSelect(index);
  }, [index, onSelect]);
  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      return [
        styles.questionNavButton,
        {
          backgroundColor:
            isActive || Boolean(hovered) ? theme.colors.surface2 : theme.colors.surface1,
          borderColor: isActive ? theme.colors.foregroundMuted : theme.colors.border,
        },
        pressed && styles.optionItemPressed,
      ];
    },
    [
      isActive,
      theme.colors.border,
      theme.colors.foregroundMuted,
      theme.colors.surface1,
      theme.colors.surface2,
    ],
  );
  const textStyle = useMemo(
    () => [
      styles.questionNavText,
      { color: isActive ? theme.colors.foreground : theme.colors.foregroundMuted },
    ],
    [isActive, theme.colors.foreground, theme.colors.foregroundMuted],
  );

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`Question ${index + 1} of ${total}`}
      accessibilityState={accessibilityState}
      aria-selected={isActive}
      testID={`question-form-question-nav-${index + 1}`}
      style={pressableStyle}
      onPress={handlePress}
      disabled={isResponding}
    >
      {isAnswered ? (
        <Check
          size={12}
          color={isActive ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      ) : null}
      <Text style={textStyle} numberOfLines={1}>
        {header}
      </Text>
    </Pressable>
  );
}

interface QuestionNavProps {
  questions: QuestionFormQuestion[];
  activeIndex: number;
  isAnswered: (qIndex: number) => boolean;
  isResponding: boolean;
  onSelect: (index: number) => void;
}

// Titled tabs (one per question header) with a check on answered ones. Hidden for
// a lone question — a single "1 of 1" tab carries no information.
function QuestionNav({
  questions,
  activeIndex,
  isAnswered,
  isResponding,
  onSelect,
}: QuestionNavProps) {
  if (questions.length <= 1) {
    return null;
  }
  return (
    <View
      style={styles.questionNav}
      testID="question-form-question-nav"
      accessibilityRole="tablist"
    >
      {questions.map((question, qIndex) => (
        <QuestionNavButton
          key={question.header}
          index={qIndex}
          total={questions.length}
          header={question.header}
          isActive={qIndex === activeIndex}
          isAnswered={isAnswered(qIndex)}
          isResponding={isResponding}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

interface QuestionOtherInputProps {
  qIndex: number;
  accessibilityLabel: string;
  value: string;
  placeholder: string;
  isResponding: boolean;
  onChange: (qIndex: number, text: string) => void;
  onSubmit: () => void;
}

function QuestionOtherInput({
  qIndex,
  accessibilityLabel,
  value,
  placeholder,
  isResponding,
  onChange,
  onSubmit,
}: QuestionOtherInputProps) {
  const { theme } = useUnistyles();
  const handleChange = useCallback(
    (text: string) => {
      onChange(qIndex, text);
    },
    [onChange, qIndex],
  );
  const otherInputStyle = useMemo(
    () =>
      [
        styles.otherInput,
        {
          borderColor: value.length > 0 ? theme.colors.borderAccent : theme.colors.border,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface2,
        },
        IS_WEB ? { outlineStyle: "none", outlineWidth: 0, outlineColor: "transparent" } : null,
      ] as const,
    [
      value.length,
      theme.colors.borderAccent,
      theme.colors.border,
      theme.colors.foreground,
      theme.colors.surface2,
    ],
  );
  return (
    <TextInput
      // @ts-expect-error - outlineStyle is web-only
      style={otherInputStyle}
      accessibilityLabel={accessibilityLabel}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      initialValue={value}
      onChangeText={handleChange}
      onSubmitEditing={onSubmit}
      editable={!isResponding}
      blurOnSubmit={false}
    />
  );
}

function useQuestionFormSelection(questions: QuestionFormQuestion[] | null) {
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);

  const toggleOption = useCallback(
    (qIndex: number, optIndex: number, multiSelect: boolean) => {
      const current = selections[qIndex] ?? new Set<number>();
      const next = new Set(current);
      if (multiSelect) {
        if (next.has(optIndex)) next.delete(optIndex);
        else next.add(optIndex);
      } else if (next.has(optIndex)) {
        next.clear();
      } else {
        next.clear();
        next.add(optIndex);
      }

      setSelections((previous) => ({ ...previous, [qIndex]: next }));
      setOtherTexts((previous) => {
        if (!previous[qIndex]) return previous;
        const nextTexts = { ...previous };
        delete nextTexts[qIndex];
        return nextTexts;
      });

      if (!multiSelect && next.size > 0 && qIndex === activeQuestionIndex && questions) {
        setActiveQuestionIndex(Math.min(qIndex + 1, questions.length - 1));
      }
    },
    [activeQuestionIndex, questions, selections],
  );

  const setOtherText = useCallback((qIndex: number, text: string) => {
    setOtherTexts((previous) => ({ ...previous, [qIndex]: text }));
    if (text.length > 0) {
      setSelections((previous) => {
        if (!previous[qIndex] || previous[qIndex].size === 0) return previous;
        return { ...previous, [qIndex]: new Set<number>() };
      });
    }
  }, []);

  const selectQuestion = useCallback((index: number) => setActiveQuestionIndex(index), []);
  return {
    activeQuestionIndex,
    otherTexts,
    selections,
    selectQuestion,
    setActiveQuestionIndex,
    setOtherText,
    toggleOption,
  };
}

function useQuestionFormSubmission({
  questions,
  selections,
  otherTexts,
  allAnswered,
  isResponding,
  permissionInput,
  onRespond,
}: {
  questions: QuestionFormQuestion[] | null;
  selections: Record<number, Set<number>>;
  otherTexts: Record<number, string>;
  allAnswered: boolean;
  isResponding: boolean;
  permissionInput: PendingPermission["request"]["input"];
  onRespond: (response: AgentPermissionResponse) => void;
}) {
  const [isPreparingResponse, setIsPreparingResponse] = useState(false);
  const [respondingAction, setRespondingAction] = useState<"submit" | "dismiss" | null>(null);
  const isBusy = isResponding || isPreparingResponse || respondingAction !== null;

  const handleSubmit = useCallback(() => {
    if (!questions || !allAnswered || isBusy) return;
    setRespondingAction("submit");
    setIsPreparingResponse(true);
    const submitAnswers = async () => {
      try {
        const answers = await buildQuestionFormAnswersForAgent(
          questions,
          selections,
          otherTexts,
          translateTextForAgent,
        );
        onRespond({ behavior: "allow", updatedInput: { ...permissionInput, answers } });
      } catch (error) {
        console.warn("[QuestionForm] Failed to prepare translated answers", error);
        setIsPreparingResponse(false);
        setRespondingAction(null);
      }
    };
    void submitAnswers();
  }, [allAnswered, isBusy, onRespond, otherTexts, permissionInput, questions, selections]);

  const handleDeny = useCallback(() => {
    if (!questions || isBusy) return;
    setRespondingAction("dismiss");
    if (shouldSubmitEmptyOnDismiss(questions)) {
      onRespond({
        behavior: "allow",
        updatedInput: {
          ...permissionInput,
          answers: buildQuestionFormAnswers(questions, selections, otherTexts),
        },
      });
      return;
    }
    onRespond({ behavior: "deny", message: "Dismissed by user" });
  }, [isBusy, onRespond, otherTexts, permissionInput, questions, selections]);

  return { handleDeny, handleSubmit, isBusy, respondingAction };
}

// The remaining branches are the form's visual states (tabs, options, free text, loading).
// eslint-disable-next-line complexity
export function QuestionFormCard({ permission, onRespond, isResponding }: QuestionFormCardProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const questions = useMemo(
    () => parseQuestionFormQuestions(permission.request.input),
    [permission.request.input],
  );
  const translatedForm = useTranslatedQuestionForm(questions);
  const displayQuestions = translatedForm.questions;

  const {
    activeQuestionIndex,
    otherTexts,
    selections,
    selectQuestion,
    setActiveQuestionIndex,
    setOtherText,
    toggleOption,
  } = useQuestionFormSelection(questions);

  const allAnswered = areQuestionsAnswered(questions, selections, otherTexts);
  const { handleDeny, handleSubmit, isBusy, respondingAction } = useQuestionFormSubmission({
    questions,
    selections,
    otherTexts,
    allAnswered,
    isResponding,
    permissionInput: permission.request.input,
    onRespond,
  });
  const resolvedActiveQuestionIndex = questions
    ? Math.min(activeQuestionIndex, questions.length - 1)
    : 0;
  const activeQuestion = questions?.[resolvedActiveQuestionIndex];
  const displayActiveQuestion = displayQuestions?.[resolvedActiveQuestionIndex];
  const activeQuestionAnswered = activeQuestion
    ? isQuestionAnswered(activeQuestion, resolvedActiveQuestionIndex, selections, otherTexts)
    : false;
  const isLastQuestion = questions ? resolvedActiveQuestionIndex === questions.length - 1 : true;

  const navIsAnswered = useCallback(
    (qIndex: number) =>
      questions ? isQuestionAnswered(questions[qIndex], qIndex, selections, otherTexts) : false,
    [questions, selections, otherTexts],
  );

  const handlePrimaryAction = useCallback(() => {
    if (!isLastQuestion) {
      if (!activeQuestionAnswered || isBusy) return;
      setActiveQuestionIndex((index) => Math.min(index + 1, (questions?.length ?? 1) - 1));
      return;
    }
    handleSubmit();
  }, [
    activeQuestionAnswered,
    handleSubmit,
    isBusy,
    isLastQuestion,
    questions?.length,
    setActiveQuestionIndex,
  ]);

  const dismissButtonStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.actionButton,
      {
        backgroundColor: hovered ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: theme.colors.borderAccent,
      },
      pressed && styles.optionItemPressed,
    ],
    [theme.colors.surface2, theme.colors.surface1, theme.colors.borderAccent],
  );

  const primaryDisabled = isBusy || (isLastQuestion ? !allAnswered : !activeQuestionAnswered);
  const primaryActionLabel = isLastQuestion
    ? t("message.question.submit")
    : t("message.question.next");
  const submitButtonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.actionButton,
      {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
        opacity: primaryDisabled ? 0.5 : 1,
      },
      pressed && !primaryDisabled ? styles.optionItemPressed : null,
    ],
    [primaryDisabled, theme.colors.accent],
  );

  const containerStyle = useMemo(
    () => [
      styles.container,
      {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
      },
    ],
    [theme.colors.surface1, theme.colors.border],
  );
  const questionTextStyle = useMemo(
    () => [styles.questionText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  // Single-select radios need a group; checkboxes are valid standalone.
  const optionsGroupAccessibility = useMemo(
    () =>
      displayActiveQuestion && activeQuestion && !activeQuestion.multiSelect
        ? ({
            accessibilityRole: "radiogroup",
            accessibilityLabel: displayActiveQuestion.question,
          } as const)
        : {},
    [activeQuestion, displayActiveQuestion],
  );
  const actionsContainerStyle = useMemo(
    () => [styles.actionsContainer, !isMobile && styles.actionsContainerDesktop],
    [isMobile],
  );
  const dismissActionTextStyle = useMemo(
    () => [styles.actionText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const submitActionTextColor = theme.colors.accentForeground;
  const submitActionTextStyle = useMemo(
    () => [styles.actionText, { color: submitActionTextColor }],
    [submitActionTextColor],
  );

  if (!questions) {
    return null;
  }

  if (!translatedForm.ready || !displayQuestions) {
    return (
      <View style={containerStyle} testID="question-form-translation-loading">
        <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
      </View>
    );
  }

  const dismissLabel = resolveDismissLabel(displayQuestions, t("common.actions.dismiss"));
  const selected = selections[resolvedActiveQuestionIndex] ?? new Set<number>();
  const otherText = otherTexts[resolvedActiveQuestionIndex] ?? "";
  const showTextInput = activeQuestion ? questionShowsTextInput(activeQuestion) : false;

  return (
    <View style={containerStyle} testID="question-form-card">
      <QuestionNav
        questions={displayQuestions}
        activeIndex={resolvedActiveQuestionIndex}
        isAnswered={navIsAnswered}
        isResponding={isBusy}
        onSelect={selectQuestion}
      />
      <View style={styles.questionHeader}>
        <Text testID="question-form-current-question" style={questionTextStyle}>
          {displayActiveQuestion?.question}
        </Text>
      </View>

      {activeQuestion ? (
        <View key={activeQuestion.question} style={styles.questionBlock}>
          {displayActiveQuestion && activeQuestion.options.length > 0 ? (
            <View style={styles.optionsWrap} {...optionsGroupAccessibility}>
              {displayActiveQuestion.options.map((opt, optIndex) => (
                <QuestionOptionRow
                  key={opt.label}
                  qIndex={resolvedActiveQuestionIndex}
                  optIndex={optIndex}
                  option={opt}
                  isSelected={selected.has(optIndex)}
                  multiSelect={activeQuestion.multiSelect}
                  isResponding={isBusy}
                  onToggle={toggleOption}
                />
              ))}
            </View>
          ) : null}
          {showTextInput && displayActiveQuestion ? (
            <QuestionOtherInput
              qIndex={resolvedActiveQuestionIndex}
              accessibilityLabel={displayActiveQuestion.question}
              value={otherText}
              placeholder={getQuestionInputPlaceholder({
                question: displayActiveQuestion,
                answerPlaceholder: t("message.question.answerPlaceholder"),
                otherPlaceholder: t("message.question.otherPlaceholder"),
              })}
              isResponding={isBusy}
              onChange={setOtherText}
              onSubmit={handlePrimaryAction}
            />
          ) : null}
        </View>
      ) : null}

      <View style={actionsContainerStyle}>
        <Pressable
          style={dismissButtonStyle}
          onPress={handleDeny}
          disabled={isBusy}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          testID="question-form-dismiss"
        >
          {respondingAction === "dismiss" ? (
            <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <View style={styles.actionContent}>
              <X size={14} color={theme.colors.foregroundMuted} />
              <Text style={dismissActionTextStyle}>{dismissLabel}</Text>
            </View>
          )}
        </Pressable>

        <Pressable
          style={submitButtonStyle}
          onPress={handlePrimaryAction}
          disabled={primaryDisabled}
          accessibilityRole="button"
          accessibilityLabel={primaryActionLabel}
          testID="question-form-primary-action"
        >
          {respondingAction === "submit" ? (
            <LoadingSpinner size="small" color={theme.colors.accentForeground} />
          ) : (
            <View style={styles.actionContent}>
              <Check size={14} color={submitActionTextColor} />
              <Text style={submitActionTextStyle}>{primaryActionLabel}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[3],
  },
  questionBlock: {
    gap: theme.spacing[2],
  },
  questionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    flex: 1,
  },
  questionText: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 22,
  },
  optionsWrap: {
    gap: theme.spacing[1],
  },
  questionNav: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  questionNavButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 28,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
  },
  questionNavText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  optionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  optionItemPressed: {
    opacity: 0.9,
  },
  optionItemContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  optionTextBlock: {
    flex: 1,
    gap: theme.spacing[1],
  },
  optionLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 22,
  },
  optionDescription: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  selectionControl: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    marginTop: 2, // optical-align 18px control to the 22px label first line
  },
  selectionControlCheckbox: {
    borderRadius: theme.borderRadius.base,
  },
  selectionControlRadio: {
    borderRadius: 999,
  },
  selectionRadioDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  otherInput: {
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.base,
  },
  actionsContainer: {
    gap: theme.spacing[2],
  },
  actionsContainerDesktop: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
  },
  actionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionText: {
    fontSize: theme.fontSize.base,
  },
}));
