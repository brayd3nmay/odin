import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, defaultFeatureConfig, modelsForProvider, normalizeSettings } from "../src/settings";

vi.mock("obsidian", () => ({
  PluginSettingTab: class {},
  Setting: class {},
  debounce: (fn: (...args: unknown[]) => unknown) => fn,
}));

describe("normalizeSettings", () => {
  it("defaults legacy installs to Claude while adding Codex settings", () => {
    const settings = normalizeSettings({
      chat: { model: "sonnet", thinking: "high" },
      claudePath: "/custom/claude",
    });

    expect(settings.provider).toBe("claude");
    expect(settings.chat).toEqual({ model: "sonnet", thinking: "high" });
    expect(settings.claudePath).toBe("/custom/claude");
    expect(settings.codexPath).toBe("");
  });

  it("keeps Codex provider settings and fills missing feature defaults", () => {
    const settings = normalizeSettings({
      provider: "codex",
      codexPath: "/custom/codex",
      chat: { model: "gpt-5.5" },
    });

    expect(settings.provider).toBe("codex");
    expect(settings.codexPath).toBe("/custom/codex");
    expect(settings.chat).toEqual({ model: "gpt-5.5", thinking: DEFAULT_SETTINGS.chat.thinking });
    expect(settings.refine).toEqual(defaultFeatureConfig("codex", "refine"));
  });
});

describe("modelsForProvider", () => {
  it("uses provider-specific model menus", () => {
    expect(modelsForProvider("claude").map((m) => m.id)).toContain("sonnet");
    expect(modelsForProvider("codex").map((m) => m.id)).toEqual(["auto", "gpt-5.5", "gpt-5.4-mini"]);
  });
});
