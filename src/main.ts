import { Plugin } from "obsidian";

export default class BuddyPlugin extends Plugin {
  async onload() {
    console.log("Obsidian Buddy loaded");
  }
  onunload() {
    console.log("Obsidian Buddy unloaded");
  }
}
