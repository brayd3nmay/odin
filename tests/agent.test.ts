import { describe, expect, it } from "vitest";
import { codexThreadOptions, resolveCodexPath, resolveExecutablePath } from "../src/agent";

describe("resolveExecutablePath", () => {
  it("uses an existing explicit override first", () => {
    const resolved = resolveExecutablePath({
      override: "/tools/codex",
      command: "codex",
      candidates: ["/fallback/codex"],
      exists: (p) => p === "/tools/codex",
      exec: () => {
        throw new Error("should not probe");
      },
    });

    expect(resolved).toBe("/tools/codex");
  });

  it("asks the login shell before falling back to known locations", () => {
    const resolved = resolveExecutablePath({
      override: "",
      command: "codex",
      candidates: ["/fallback/codex"],
      shell: "/bin/zsh",
      exists: (p) => p === "/shell/codex" || p === "/fallback/codex",
      exec: (cmd) => (cmd === "/bin/zsh -lic 'command -v codex'" ? "/shell/codex\n" : ""),
    });

    expect(resolved).toBe("/shell/codex");
  });
});

describe("resolveCodexPath", () => {
  it("resolves a local codex executable", () => {
    const resolved = resolveCodexPath("", {
      exists: (p) => p === "/opt/homebrew/bin/codex",
      exec: () => "",
      home: "/Users/tester",
      shell: "/bin/zsh",
    });

    expect(resolved).toBe("/opt/homebrew/bin/codex");
  });
});

describe("codexThreadOptions", () => {
  it("uses ChatGPT-backed Codex defaults without API-key options", () => {
    expect(codexThreadOptions({
      cwd: "/vault",
      model: "auto",
      thinking: "high",
      allowWeb: true,
    })).toEqual({
      workingDirectory: "/vault",
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      modelReasoningEffort: "high",
      webSearchMode: "live",
    });
  });

  it("omits the model override when Codex default is selected", () => {
    expect(codexThreadOptions({
      cwd: "/vault",
      model: "auto",
      thinking: "off",
      allowWeb: false,
    })).not.toHaveProperty("model");
  });
});
