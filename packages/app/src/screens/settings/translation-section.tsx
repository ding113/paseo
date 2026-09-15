import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useAppSettings } from "@/hooks/use-settings";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import {
  applyTranslationProvider,
  testTranslationConnection,
  type TranslationConfig,
  type TranslationProvider,
  type TranslationReasoningEffort,
} from "@/translation/client";

type TextKey = "baseUrl" | "apiKey" | "model" | "myLanguage" | "agentLanguage";

interface TranslationTextFieldProps {
  fieldKey: TextKey;
  value: string;
  secure?: boolean;
  onCommit: (key: TextKey, value: string) => void;
  onDraft: (key: TextKey, value: string) => void;
}

const TranslationTextField = memo(function TranslationTextField({
  fieldKey,
  value,
  secure,
  onCommit,
  onDraft,
}: TranslationTextFieldProps) {
  const { t } = useTranslation();
  // The input is uncontrolled, so in-progress text lives in a ref: a keystroke should not
  // re-render the section, and nothing persists until blur.
  const draft = useRef(value);

  useEffect(() => {
    draft.current = value;
  }, [value]);

  const handleChangeText = useCallback(
    (next: string) => {
      draft.current = next;
      onDraft(fieldKey, next);
    },
    [fieldKey, onDraft],
  );

  const handleBlur = useCallback(() => {
    onCommit(fieldKey, draft.current);
  }, [fieldKey, onCommit]);

  return (
    <Field
      label={t(`settings.translation.${fieldKey}.label`)}
      hint={t(`settings.translation.${fieldKey}.hint`)}
      testID={`translation-${fieldKey}`}
    >
      <FormTextInput
        initialValue={value}
        resetKey={value}
        onChangeText={handleChangeText}
        onBlur={handleBlur}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure ?? false}
        placeholder={t(`settings.translation.${fieldKey}.placeholder`)}
      />
    </Field>
  );
});

const PROVIDERS: TranslationProvider[] = ["openai-compatible", "openai", "anthropic", "google"];
const EFFORTS: TranslationReasoningEffort[] = ["default", "low", "medium", "high"];

function SelectRow<T extends string>({
  label,
  hint,
  value,
  options,
  labelFor,
  onChange,
}: {
  label: string;
  hint: string;
  value: T;
  options: readonly T[];
  labelFor: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <View style={settingsStyles.card}>
      <DropdownMenu>
        <DropdownMenuTrigger style={settingsStyles.row} accessibilityRole="button">
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{label}</Text>
            <Text style={settingsStyles.rowHint}>{hint}</Text>
          </View>
          <Text style={settingsStyles.rowTitle}>{labelFor(value)}</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={240}>
          {options.map((option) => (
            <SelectMenuItem
              key={option}
              option={option}
              selectedValue={value}
              label={labelFor(option)}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function SelectMenuItem<T extends string>({
  option,
  selectedValue,
  label,
  onChange,
}: {
  option: T;
  selectedValue: T;
  label: string;
  onChange: (value: T) => void;
}) {
  const handleSelect = useCallback(() => onChange(option), [onChange, option]);
  return (
    <DropdownMenuItem selected={option === selectedValue} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

export function TranslationSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const config = settings.translation;
  const draftsRef = useRef<TranslationConfig>(config);
  // Fields the user has typed into but not yet committed. A commit elsewhere in the section
  // rewrites `config`, and without this the effect below would drop every other in-flight draft.
  const dirtyRef = useRef<Set<TextKey>>(new Set());
  const testSequenceRef = useRef(0);
  const [testState, setTestState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [testError, setTestError] = useState("");
  const providerLabel = useCallback(
    (value: TranslationProvider) => t(`settings.translation.provider.options.${value}`),
    [t],
  );
  const effortLabel = useCallback(
    (value: TranslationReasoningEffort) =>
      t(`settings.translation.reasoningEffort.options.${value}`),
    [t],
  );

  useEffect(() => {
    const drafts = draftsRef.current;
    const next = { ...config };
    for (const key of dirtyRef.current) next[key] = drafts[key];
    draftsRef.current = next;
  }, [config]);

  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      const next = { ...draftsRef.current, enabled };
      draftsRef.current = next;
      void updateSettings({ translation: next });
    },
    [updateSettings],
  );

  const handleCommit = useCallback(
    (key: TextKey, next: string) => {
      const value = next.trim();
      dirtyRef.current.delete(key);
      if (value === config[key]) return;
      const translation = { ...draftsRef.current, [key]: value };
      draftsRef.current = translation;
      void updateSettings({ translation });
    },
    [config, updateSettings],
  );

  const handleDraft = useCallback((key: TextKey, value: string) => {
    draftsRef.current = { ...draftsRef.current, [key]: value };
    dirtyRef.current.add(key);
    testSequenceRef.current += 1;
    setTestState("idle");
  }, []);

  const handleProviderChange = useCallback(
    (provider: TranslationProvider) => {
      const next = applyTranslationProvider(draftsRef.current, provider);
      draftsRef.current = next;
      testSequenceRef.current += 1;
      setTestState("idle");
      void updateSettings({ translation: next });
    },
    [updateSettings],
  );

  const handleEffortChange = useCallback(
    (reasoningEffort: TranslationReasoningEffort) => {
      const next = { ...draftsRef.current, reasoningEffort };
      draftsRef.current = next;
      testSequenceRef.current += 1;
      setTestState("idle");
      void updateSettings({ translation: next });
    },
    [updateSettings],
  );

  const handleTestConnection = useCallback(async () => {
    const sequence = testSequenceRef.current + 1;
    testSequenceRef.current = sequence;
    const candidate = {
      ...draftsRef.current,
      baseUrl: draftsRef.current.baseUrl.trim(),
      apiKey: draftsRef.current.apiKey.trim(),
      model: draftsRef.current.model.trim(),
      myLanguage: draftsRef.current.myLanguage.trim(),
      agentLanguage: draftsRef.current.agentLanguage.trim(),
    };
    setTestState("pending");
    setTestError("");
    try {
      await testTranslationConnection(candidate);
      if (testSequenceRef.current === sequence) setTestState("success");
    } catch (error) {
      if (testSequenceRef.current === sequence) {
        setTestError(error instanceof Error ? error.message : String(error));
        setTestState("error");
      }
    }
  }, []);

  let testStatus = t("settings.translation.test.hint");
  if (testState === "success") testStatus = t("settings.translation.test.success");
  else if (testState === "error") {
    testStatus = t("settings.translation.test.error", { message: testError });
  }

  return (
    <SettingsSection title={t("settings.translation.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.translation.enabled")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.translation.enabledHint")}</Text>
          </View>
          <Switch
            value={config.enabled}
            onValueChange={handleEnabledChange}
            accessibilityLabel={t("settings.translation.enabled")}
            testID="translation-enabled-toggle"
          />
        </View>
      </View>
      <SelectRow
        label={t("settings.translation.provider.label")}
        hint={t("settings.translation.provider.hint")}
        value={config.provider}
        options={PROVIDERS}
        labelFor={providerLabel}
        onChange={handleProviderChange}
      />
      <SelectRow
        label={t("settings.translation.reasoningEffort.label")}
        hint={t("settings.translation.reasoningEffort.hint")}
        value={config.reasoningEffort}
        options={EFFORTS}
        labelFor={effortLabel}
        onChange={handleEffortChange}
      />
      <TranslationTextField
        fieldKey="myLanguage"
        value={config.myLanguage}
        onCommit={handleCommit}
        onDraft={handleDraft}
      />
      <TranslationTextField
        fieldKey="agentLanguage"
        value={config.agentLanguage}
        onCommit={handleCommit}
        onDraft={handleDraft}
      />
      <TranslationTextField
        fieldKey="baseUrl"
        value={config.baseUrl}
        onCommit={handleCommit}
        onDraft={handleDraft}
      />
      <TranslationTextField
        fieldKey="apiKey"
        value={config.apiKey}
        secure
        onCommit={handleCommit}
        onDraft={handleDraft}
      />
      <TranslationTextField
        fieldKey="model"
        value={config.model}
        onCommit={handleCommit}
        onDraft={handleDraft}
      />
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.translation.test.title")}</Text>
            <Text style={settingsStyles.rowHint} testID="translation-test-status">
              {testStatus}
            </Text>
          </View>
          <Button
            size="sm"
            variant="outline"
            loading={testState === "pending"}
            onPress={handleTestConnection}
            testID="translation-test-button"
          >
            {t("settings.translation.test.action")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}
