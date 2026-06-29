import { Plugin } from "obsidian";
import { BuddySettings, DEFAULT_SETTINGS, BuddySettingTab } from "./settings";
import { ChatThread } from "./history";

interface BuddyData {
  settings: BuddySettings;
  threads: ChatThread[];
}

export default class BuddyPlugin extends Plugin {
  settings!: BuddySettings;
  threads: ChatThread[] = [];

  async onload() {
    await this.loadAll();
    this.addSettingTab(new BuddySettingTab(this.app, this));
    console.log("Obsidian Buddy loaded");
  }

  onunload() {
    console.log("Obsidian Buddy unloaded");
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
