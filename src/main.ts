import { Plugin, FileSystemAdapter, MarkdownView } from "obsidian";
import { BuddySettings, DEFAULT_SETTINGS, BuddySettingTab } from "./settings";
import { ChatThread } from "./history";
import { AgentClient, resolveClaudePath } from "./agent";
import { FloatingWidget } from "./widget";

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

    this.addCommand({
      id: "toggle-claude-widget",
      name: "Toggle Claude widget",
      callback: () => this.widget.toggle(),
    });

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

  async saveThreads() {
    await this.saveSettings();
  }
}
