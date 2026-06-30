import { App, PluginSettingTab, Setting, debounce } from "obsidian";

export type AgentProvider = "claude" | "codex";
export type ThinkingLevel = "off" | "normal" | "high";
export type FeatureKey = "fixFormatting" | "refine" | "findGaps" | "chat";

export interface FeatureConfig {
  provider: AgentProvider;
  model: string;
  thinking: ThinkingLevel;
}

export interface OdinSettings {
  fixFormatting: FeatureConfig;
  refine: FeatureConfig;
  findGaps: FeatureConfig;
  chat: FeatureConfig;
  styleGuide: string;
  allowWeb: boolean;
  claudePath: string; // "" = auto-detect
  codexPath: string; // "" = auto-detect
}

export const PROVIDERS: { id: AgentProvider; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

export const CLAUDE_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

export const CODEX_MODELS = [
  { id: "auto", label: "Codex default" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
];

export const THINKING_LEVELS: { id: ThinkingLevel; label: string }[] = [
  { id: "off", label: "No thinking" },
  { id: "normal", label: "Think" },
  { id: "high", label: "Think hard" },
];

export const FEATURE_KEYS: FeatureKey[] = ["fixFormatting", "refine", "findGaps", "chat"];

const PROVIDER_FEATURE_DEFAULTS: Record<AgentProvider, Record<FeatureKey, Omit<FeatureConfig, "provider">>> = {
  claude: {
    fixFormatting: { model: "haiku", thinking: "off" },
    refine: { model: "sonnet", thinking: "normal" },
    findGaps: { model: "sonnet", thinking: "high" },
    chat: { model: "sonnet", thinking: "normal" },
  },
  codex: {
    fixFormatting: { model: "gpt-5.4-mini", thinking: "off" },
    refine: { model: "gpt-5.5", thinking: "normal" },
    findGaps: { model: "gpt-5.5", thinking: "high" },
    chat: { model: "gpt-5.5", thinking: "normal" },
  },
};

export interface ModelChoice {
  provider: AgentProvider;
  id: string;
  label: string;
}

// All models from the given providers, tagged with provider and a "Provider · Model" label
// for the unified picker. Pass the connected providers to filter.
export function modelChoices(providers: AgentProvider[]): ModelChoice[] {
  const byProvider: Record<AgentProvider, { id: string; label: string }[]> = {
    claude: CLAUDE_MODELS,
    codex: CODEX_MODELS,
  };
  return providers.flatMap((provider) =>
    byProvider[provider].map((m) => ({ provider, id: m.id, label: `${providerLabel(provider)} · ${m.label}` })),
  );
}

function modelIds(provider: AgentProvider): Set<string> {
  return new Set((provider === "codex" ? CODEX_MODELS : CLAUDE_MODELS).map((m) => m.id));
}

export function providerLabel(provider: AgentProvider): string {
  return PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

export function defaultFeatureConfig(provider: AgentProvider, key: FeatureKey): FeatureConfig {
  return { provider, ...PROVIDER_FEATURE_DEFAULTS[provider][key] };
}

function validProvider(value: unknown, fallback: AgentProvider): AgentProvider {
  return value === "codex" || value === "claude" ? value : fallback;
}

function validThinking(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return value === "off" || value === "normal" || value === "high" ? value : fallback;
}

function normalizeFeatureConfig(fallbackProvider: AgentProvider, key: FeatureKey, stored: unknown): FeatureConfig {
  const partial = typeof stored === "object" && stored !== null ? stored as Partial<FeatureConfig> : {};
  const provider = validProvider(partial.provider, fallbackProvider);
  const base = defaultFeatureConfig(provider, key);
  const model = typeof partial.model === "string" && modelIds(provider).has(partial.model) ? partial.model : base.model;
  return {
    provider,
    model,
    thinking: validThinking(partial.thinking, base.thinking),
  };
}

export function normalizeSettings(stored: unknown): OdinSettings {
  const data = typeof stored === "object" && stored !== null ? stored as Partial<OdinSettings> & { provider?: unknown } : {};
  // Legacy saves carried a top-level `provider`; use it only to migrate per-feature provider.
  const legacyProvider = validProvider(data.provider, "claude");
  return {
    fixFormatting: normalizeFeatureConfig(legacyProvider, "fixFormatting", data.fixFormatting),
    refine: normalizeFeatureConfig(legacyProvider, "refine", data.refine),
    findGaps: normalizeFeatureConfig(legacyProvider, "findGaps", data.findGaps),
    chat: normalizeFeatureConfig(legacyProvider, "chat", data.chat),
    styleGuide: typeof data.styleGuide === "string" ? data.styleGuide : "",
    allowWeb: typeof data.allowWeb === "boolean" ? data.allowWeb : true,
    claudePath: typeof data.claudePath === "string" ? data.claudePath : "",
    codexPath: typeof data.codexPath === "string" ? data.codexPath : "",
  };
}

export const DEFAULT_SETTINGS: OdinSettings = {
  fixFormatting: { provider: "claude", model: "haiku", thinking: "off" },
  refine: { provider: "claude", model: "sonnet", thinking: "normal" },
  findGaps: { provider: "claude", model: "sonnet", thinking: "high" },
  chat: { provider: "claude", model: "sonnet", thinking: "normal" },
  styleGuide: "",
  allowWeb: true,
  claudePath: "",
  codexPath: "",
};

export function thinkingTokens(level: ThinkingLevel): number {
  return level === "high" ? 10000 : level === "normal" ? 4000 : 0;
}

interface PluginLike {
  settings: OdinSettings;
  saveSettings(): Promise<void>;
  availableProviders(): AgentProvider[];
}

export class OdinSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PluginLike) {
    super(app, plugin as any);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const choices = modelChoices(this.plugin.availableProviders());
    const choiceKey = (provider: AgentProvider, model: string) => `${provider}:${model}`;
    const featureRow = (name: string, key: FeatureKey) => {
      const cfg = this.plugin.settings[key];
      new Setting(containerEl)
        .setName(name)
        .setDesc("Model and thinking level")
        .addDropdown((d) => {
          for (const c of choices) d.addOption(choiceKey(c.provider, c.id), c.label);
          d.setValue(choiceKey(cfg.provider, cfg.model)).onChange(async (v) => {
            const picked = choices.find((c) => choiceKey(c.provider, c.id) === v);
            if (picked) { cfg.provider = picked.provider; cfg.model = picked.id; }
            await this.plugin.saveSettings();
          });
        })
        .addDropdown((d) => {
          for (const t of THINKING_LEVELS) d.addOption(t.id, t.label);
          d.setValue(cfg.thinking).onChange(async (v) => {
            cfg.thinking = v as ThinkingLevel;
            await this.plugin.saveSettings();
          });
        });
    };

    new Setting(containerEl).setName("Defaults per feature").setHeading();
    featureRow("Fix Formatting", "fixFormatting");
    featureRow("Refine", "refine");
    featureRow("Find Gaps", "findGaps");
    featureRow("Chat", "chat");

    new Setting(containerEl).setName("Refine style guide").setHeading();
    new Setting(containerEl)
      .setName("Formatting style guide")
      .setDesc("Describe how you like notes formatted. Injected into Refine.")
      .addTextArea((t) => {
        // Debounce: each save rewrites the whole data file (settings + all threads),
        // so don't do it on every keystroke of a multi-paragraph guide.
        const save = debounce(() => this.plugin.saveSettings(), 500, true);
        t.setValue(this.plugin.settings.styleGuide).onChange((v) => {
          this.plugin.settings.styleGuide = v;
          save();
        });
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
      });

    new Setting(containerEl).setName("Other").setHeading();
    new Setting(containerEl)
      .setName("Allow web search")
      .setDesc("Let Find Gaps and Chat use WebSearch/WebFetch.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowWeb).onChange(async (v) => {
          this.plugin.settings.allowWeb = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Claude executable path (optional)")
      .setDesc("Leave blank to auto-detect your installed `claude`.")
      .addText((t) =>
        t.setValue(this.plugin.settings.claudePath).onChange(async (v) => {
          this.plugin.settings.claudePath = v.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Codex executable path (optional)")
      .setDesc("Leave blank to auto-detect your installed `codex`. Codex uses your ChatGPT login by default.")
      .addText((t) =>
        t.setValue(this.plugin.settings.codexPath).onChange(async (v) => {
          this.plugin.settings.codexPath = v.trim();
          await this.plugin.saveSettings();
        }),
      );
  }
}
