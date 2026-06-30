import { Plugin, FileSystemAdapter, MarkdownView } from "obsidian";
import * as path from "path";
import { OdinSettings, OdinSettingTab, normalizeSettings, AgentProvider } from "./settings";
import { ChatThread } from "./history";
import { AgentClient, resolveClaudePath, resolveCodexPath } from "./agent";
import { FloatingWidget } from "./widget";
import { odinDiffField } from "./editor-diff";

interface OdinData {
  settings: OdinSettings;
  threads: ChatThread[];
}

export default class OdinPlugin extends Plugin {
  settings!: OdinSettings;
  threads: ChatThread[] = [];
  agent!: AgentClient;
  widget!: FloatingWidget;

  async onload() {
    await this.loadAll();
    this.addSettingTab(new OdinSettingTab(this.app, this));

    this.refreshAgent();
    this.widget = new FloatingWidget(this);

    // Renders the in-editor inline diff preview (red deletions / green additions) when the agent
    // proposes an edit. Decorations only; the document is untouched until the user accepts.
    this.registerEditorExtension(odinDiffField);

    this.addCommand({
      id: "toggle-odin-widget",
      name: "Toggle Odin widget",
      callback: () => this.widget.toggle(),
    });

    const actions: { id: string; name: string; kind: "fix" | "refine" | "gaps" }[] = [
      { id: "fix-formatting", name: "Fix Formatting", kind: "fix" },
      { id: "refine-note", name: "Refine", kind: "refine" },
      { id: "find-gaps", name: "Find Gaps", kind: "gaps" },
    ];
    for (const a of actions) {
      this.addCommand({
        id: a.id,
        name: a.name,
        editorCallback: () => this.widget.runQuickAction(a.kind),
      });
    }
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        for (const a of actions) {
          menu.addItem((item) =>
            item.setTitle(`Odin: ${a.name}`).setIcon("sparkles").onClick(() => this.widget.runQuickAction(a.kind)),
          );
        }
      }),
    );

    console.log("Odin loaded");
  }

  onunload() {
    this.widget?.destroy();
    console.log("Odin unloaded");
  }

  activeMarkdownView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  async loadAll() {
    const data = (await this.loadData()) as OdinData | null;
    this.settings = normalizeSettings(data?.settings);
    this.threads = data?.threads ?? [];
  }

  refreshAgent() {
    const basePath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    // Odin's own skill store lives under the plugin's own folder, NOT the vault's .claude/skills — so
    // the user's personal Claude Code skills never collide with or bleed into Odin's.
    const pluginDir = this.manifest.dir ?? path.join(this.app.vault.configDir, "plugins", this.manifest.id);
    this.agent = new AgentClient({
      cwd: basePath,
      skillsDir: path.join(basePath, pluginDir, "skills"),
      claudePath: resolveClaudePath(this.settings.claudePath),
      codexPath: resolveCodexPath(this.settings.codexPath),
    });
  }

  availableProviders() {
    return this.agent.availableProviders();
  }

  checkProvider(provider: AgentProvider) {
    return this.agent.checkProvider(provider);
  }

  listSkills() {
    return this.agent.listSkills();
  }

  removeSkill(slug: string) {
    return this.agent.removeSkill(slug);
  }

  async saveSettings() {
    await this.saveData({ settings: this.settings, threads: this.threads } as OdinData);
    this.refreshAgent();
    this.widget?.refreshBrand();
  }
}
