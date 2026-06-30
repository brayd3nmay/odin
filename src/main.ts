import { Plugin, FileSystemAdapter, MarkdownView } from "obsidian";
import { BuddySettings, DEFAULT_SETTINGS, BuddySettingTab } from "./settings";
import { ChatThread } from "./history";
import { AgentClient, resolveClaudePath } from "./agent";
import { FloatingWidget } from "./widget";
import { buddyDiffField } from "./editor-diff";

interface BuddyData {
  settings: BuddySettings;
  threads: ChatThread[];
}

export default class BuddyPlugin extends Plugin {
  settings!: BuddySettings;
  threads: ChatThread[] = [];
  agent!: AgentClient;
  widget!: FloatingWidget;

  async onload() {
    await this.loadAll();
    this.addSettingTab(new BuddySettingTab(this.app, this));

    const basePath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    this.agent = new AgentClient({
      cwd: basePath,
      claudePath: resolveClaudePath(this.settings.claudePath),
    });
    this.widget = new FloatingWidget(this);

    // Renders the in-editor inline diff preview (red deletions / green additions) when Claude
    // proposes an edit. Decorations only; the document is untouched until the user accepts.
    this.registerEditorExtension(buddyDiffField);

    this.addCommand({
      id: "toggle-claude-widget",
      name: "Toggle Claude widget",
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
            item.setTitle(`Claude: ${a.name}`).setIcon("sparkles").onClick(() => this.widget.runQuickAction(a.kind)),
          );
        }
      }),
    );

    console.log("Obsidian Buddy loaded");
  }

  onunload() {
    this.widget?.destroy();
    console.log("Obsidian Buddy unloaded");
  }

  activeMarkdownView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  async loadAll() {
    const data = (await this.loadData()) as BuddyData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
    this.threads = data?.threads ?? [];
  }

  async saveSettings() {
    await this.saveData({ settings: this.settings, threads: this.threads } as BuddyData);
  }
}
