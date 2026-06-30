import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, defaultFeatureConfig, modelChoices, normalizeSettings } from "../src/settings";

vi.mock("obsidian", () => ({
  PluginSettingTab: class {},
  Setting: class {},
  debounce: (fn: (...args: unknown[]) => unknown) => fn,
}));

describe("normalizeSettings", () => {
  it("defaults a legacy install (no provider) to Claude on every feature", () => {
    const settings = normalizeSettings({
      chat: { model: "sonnet", thinking: "high" },
      claudePath: "/custom/claude",
    });

    // Provider now lives per-feature; there is no top-level provider anymore.
    expect((settings as Record<string, unknown>).provider).toBeUndefined();
    expect(settings.chat).toEqual({ provider: "claude", model: "sonnet", thinking: "high" });
    expect(settings.fixFormatting.provider).toBe("claude");
    expect(settings.claudePath).toBe("/custom/claude");
    expect(settings.codexPath).toBe("");
  });

  it("migrates a legacy top-level provider into each feature and fills defaults", () => {
    const settings = normalizeSettings({
      provider: "codex",
      codexPath: "/custom/codex",
      chat: { model: "gpt-5.5" },
    });

    expect(settings.codexPath).toBe("/custom/codex");
    expect(settings.chat).toEqual({ provider: "codex", model: "gpt-5.5", thinking: DEFAULT_SETTINGS.chat.thinking });
    // A feature with nothing stored falls back to that provider's defaults.
    expect(settings.refine).toEqual(defaultFeatureConfig("codex", "refine"));
  });

  it("honors an explicit per-feature provider over the legacy fallback", () => {
    const settings = normalizeSettings({
      provider: "claude",
      refine: { provider: "codex", model: "gpt-5.5", thinking: "high" },
    });

    expect(settings.refine).toEqual({ provider: "codex", model: "gpt-5.5", thinking: "high" });
    expect(settings.chat.provider).toBe("claude"); // others still take the legacy fallback
  });

  it("drops a stored model that doesn't belong to the feature's provider", () => {
    const settings = normalizeSettings({
      chat: { provider: "claude", model: "gpt-5.5" }, // a Codex model under Claude
    });

    expect(settings.chat).toEqual(defaultFeatureConfig("claude", "chat"));
  });
});

describe("modelChoices", () => {
  it("tags each model with its provider and a 'Provider · Model' label", () => {
    const claude = modelChoices(["claude"]);
    expect(claude.map((m) => m.id)).toContain("sonnet");
    expect(claude.every((m) => m.provider === "claude")).toBe(true);
    expect(claude[0].label).toBe("Claude · Opus");
  });

  it("concatenates choices across providers in the order given", () => {
    expect(modelChoices(["codex", "claude"]).map((m) => m.id)).toEqual([
      "auto", "gpt-5.5", "gpt-5.4-mini", "opus", "sonnet", "haiku",
    ]);
  });

  it("returns nothing when no provider is connected", () => {
    expect(modelChoices([])).toEqual([]);
  });
});
