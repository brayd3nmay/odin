import { describe, expect, it } from "vitest";
import {
  codexThreadOptions,
  resolveCodexPath,
  resolveExecutablePath,
  parseCodexEdit,
  parseClaudeAuth,
  parseCodexAuth,
} from "../src/agent";

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

describe("parseCodexEdit", () => {
  it("parses a well-formed block with a summary and surrounding reply", () => {
    const r = parseCodexEdit('Here you go.\n<odin_propose_note_edit summary="tidy">\nNew body\n</odin_propose_note_edit>');
    expect(r).not.toBeNull();
    expect(r!.summary).toBe("tidy");
    expect(r!.content).toBe("New body");
    expect(r!.reply).toBe("Here you go.");
  });
  it("falls back to a default summary when none is given", () => {
    const r = parseCodexEdit("<odin_propose_note_edit>\nBody\n</odin_propose_note_edit>");
    expect(r!.summary).toBe("Proposed note edit");
    expect(r!.content).toBe("Body");
  });
  it("tolerates a missing closing tag (takes the rest of the message)", () => {
    const r = parseCodexEdit('reply\n<odin_propose_note_edit summary="x">\nrest of note');
    expect(r).not.toBeNull();
    expect(r!.content).toBe("rest of note");
    expect(r!.summary).toBe("x");
  });
  it("is case-insensitive and ignores extra attributes", () => {
    const r = parseCodexEdit('<ODIN_PROPOSE_NOTE_EDIT data-x="1" summary="S">\nC\n</ODIN_PROPOSE_NOTE_EDIT>');
    expect(r!.summary).toBe("S");
    expect(r!.content).toBe("C");
  });
  it("strips a fenced body", () => {
    const r = parseCodexEdit("<odin_propose_note_edit>\n```md\n# H\n```\n</odin_propose_note_edit>");
    expect(r!.content).toBe("# H");
  });
  it("returns null when there is no block", () => {
    expect(parseCodexEdit("just a normal reply")).toBeNull();
  });
});

describe("parseClaudeAuth", () => {
  it("reads loggedIn:true with a human detail", () => {
    const r = parseClaudeAuth('{"loggedIn":true,"email":"a@b.com","subscriptionType":"pro"}');
    expect(r.authed).toBe(true);
    expect(r.detail).toContain("a@b.com");
  });
  it("treats loggedIn:false as not authed", () => {
    expect(parseClaudeAuth('{"loggedIn":false}').authed).toBe(false);
  });
  it("treats non-JSON as not authed", () => {
    expect(parseClaudeAuth("garbage").authed).toBe(false);
  });
});

describe("parseCodexAuth", () => {
  it("recognizes a logged-in line regardless of case", () => {
    expect(parseCodexAuth("Logged in using ChatGPT").authed).toBe(true);
  });
  it("treats anything else as not authed", () => {
    expect(parseCodexAuth("Not logged in").authed).toBe(false);
    expect(parseCodexAuth("").authed).toBe(false);
  });
});
