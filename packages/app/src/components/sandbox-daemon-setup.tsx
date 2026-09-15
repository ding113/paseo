import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Copy, Link2, ShieldAlert } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import {
  EXTERNAL_DAEMON_ADDRESS,
  EXTERNAL_DAEMON_AGENT_PROMPT,
  EXTERNAL_DAEMON_SETUP_COMMANDS,
} from "@/desktop/daemon/app-sandbox";

const styles = StyleSheet.create((theme) => ({
  card: {
    width: "100%",
    maxWidth: 560,
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  step: {
    gap: theme.spacing[2],
  },
  stepLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));

export interface SandboxDaemonSetupProps {
  onConnect: () => void;
}

/**
 * Shown on first launch when Paseo is running inside the macOS App Sandbox, where the bundled
 * daemon cannot reach any coding agent on the machine. The App Store build would otherwise offer
 * the same "the daemon starts automatically" path as every other desktop build and then find
 * nothing, with no way for the user to tell why.
 */
export function SandboxDaemonSetup({ onConnect }: SandboxDaemonSetupProps) {
  const { t } = useTranslation();

  const copy = useCallback(
    (text: string, label: string) => {
      void copyToClipboard(text)
        .then(() => Alert.alert(t("common.states.copied"), label))
        .catch((error: unknown) => {
          console.error("[SandboxDaemonSetup] Failed to copy", error);
        });
    },
    [t],
  );

  const handleCopyCommands = useCallback(
    () => copy(EXTERNAL_DAEMON_SETUP_COMMANDS, t("onboarding.sandbox.commandsLabel")),
    [copy, t],
  );

  const handleCopyAgentPrompt = useCallback(
    () => copy(EXTERNAL_DAEMON_AGENT_PROMPT, t("onboarding.sandbox.agentPromptLabel")),
    [copy, t],
  );

  return (
    <View style={styles.card} testID="sandbox-daemon-setup">
      <View style={styles.header}>
        <ShieldAlert size={18} color={styles.title.color} />
        <Text style={styles.title}>{t("onboarding.sandbox.title")}</Text>
      </View>
      <Text style={styles.description}>{t("onboarding.sandbox.description")}</Text>

      <View style={styles.step}>
        <Text style={styles.stepLabel}>{t("onboarding.sandbox.commandsLabel")}</Text>
        <Text style={styles.code} selectable testID="sandbox-daemon-setup-commands">
          {EXTERNAL_DAEMON_SETUP_COMMANDS}
        </Text>
      </View>

      <View style={styles.step}>
        <Text style={styles.stepLabel}>{t("onboarding.sandbox.agentPromptLabel")}</Text>
        <Text style={styles.description}>{t("onboarding.sandbox.agentPromptHint")}</Text>
      </View>

      <Text style={styles.description}>
        {t("onboarding.sandbox.connectHint", { address: EXTERNAL_DAEMON_ADDRESS })}
      </Text>

      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          leftIcon={Copy}
          onPress={handleCopyCommands}
          testID="sandbox-daemon-copy-commands"
        >
          {t("onboarding.sandbox.copyCommands")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          leftIcon={Copy}
          onPress={handleCopyAgentPrompt}
          testID="sandbox-daemon-copy-agent-prompt"
        >
          {t("onboarding.sandbox.copyAgentPrompt")}
        </Button>
        <Button
          size="sm"
          variant="default"
          leftIcon={Link2}
          onPress={onConnect}
          testID="sandbox-daemon-connect"
        >
          {t("onboarding.sandbox.connect")}
        </Button>
      </View>
    </View>
  );
}
