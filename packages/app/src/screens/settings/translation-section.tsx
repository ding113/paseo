import { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { useAppSettings } from "@/hooks/use-settings";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";

type TextKey = "baseUrl" | "apiKey" | "model" | "myLanguage" | "agentLanguage";

interface TranslationTextFieldProps {
  fieldKey: TextKey;
  value: string;
  secure?: boolean;
  onCommit: (key: TextKey, value: string) => void;
}

const TranslationTextField = memo(function TranslationTextField({
  fieldKey,
  value,
  secure,
  onCommit,
}: TranslationTextFieldProps) {
  const { t } = useTranslation();
  // The input is uncontrolled, so in-progress text lives in a ref: a keystroke should not
  // re-render the section, and nothing persists until blur.
  const draft = useRef(value);

  useEffect(() => {
    draft.current = value;
  }, [value]);

  const handleChangeText = useCallback((next: string) => {
    draft.current = next;
  }, []);

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

export function TranslationSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const config = settings.translation;

  const handleEnabledChange = useCallback(
    (enabled: boolean) => void updateSettings({ translation: { ...config, enabled } }),
    [config, updateSettings],
  );

  const handleCommit = useCallback(
    (key: TextKey, next: string) => {
      const value = next.trim();
      if (value === config[key]) return;
      void updateSettings({ translation: { ...config, [key]: value } });
    },
    [config, updateSettings],
  );

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
      <TranslationTextField
        fieldKey="myLanguage"
        value={config.myLanguage}
        onCommit={handleCommit}
      />
      <TranslationTextField
        fieldKey="agentLanguage"
        value={config.agentLanguage}
        onCommit={handleCommit}
      />
      <TranslationTextField fieldKey="baseUrl" value={config.baseUrl} onCommit={handleCommit} />
      <TranslationTextField
        fieldKey="apiKey"
        value={config.apiKey}
        secure
        onCommit={handleCommit}
      />
      <TranslationTextField fieldKey="model" value={config.model} onCommit={handleCommit} />
    </SettingsSection>
  );
}
