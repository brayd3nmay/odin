import { App, PluginSettingTab, Setting, debounce } from "obsidian";

export type ThinkingLevel = "off" | "normal" | "high";

export interface FeatureConfig {
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
}

export const MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

export const THINKING_LEVELS: { id: ThinkingLevel; label: string }[] = [
  { id: "off", label: "No thinking" },
  { id: "normal", label: "Think" },
  { id: "high", label: "Think hard" },
];

export const DEFAULT_SETTINGS: OdinSettings = {
  fixFormatting: { model: "haiku", thinking: "off" },
  refine: { model: "sonnet", thinking: "normal" },
  findGaps: { model: "sonnet", thinking: "high" },
  chat: { model: "sonnet", thinking: "normal" },
  styleGuide: "",
  allowWeb: true,
  claudePath: "",
};

export function thinkingTokens(level: ThinkingLevel): number {
  return level === "high" ? 10000 : level === "normal" ? 4000 : 0;
}

interface PluginLike {
  settings: OdinSettings;
  saveSettings(): Promise<void>;
}

export class OdinSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PluginLike) {
    super(app, plugin as any);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const featureRow = (name: string, key: "fixFormatting" | "refine" | "findGaps" | "chat") => {
      const cfg = this.plugin.settings[key];
      new Setting(containerEl)
        .setName(name)
        .setDesc("Model and thinking level")
        .addDropdown((d) => {
          for (const m of MODELS) d.addOption(m.id, m.label);
          d.setValue(cfg.model).onChange(async (v) => {
            cfg.model = v;
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
  }
}
