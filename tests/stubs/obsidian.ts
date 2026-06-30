export class PluginSettingTab {
  constructor(..._args: unknown[]) {}
}

export class Setting {
  constructor(..._args: unknown[]) {}
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addDropdown() { return this; }
  addTextArea() { return this; }
  addToggle() { return this; }
  addText() { return this; }
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}
