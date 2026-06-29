import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execSync } from "child_process";
import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import { extractText, stripFences } from "./parse";
import { thinkingTokens, ThinkingLevel } from "./settings";

export const PROMPTS = {
  fixFormatting:
    "You fix ONLY capitalization and punctuation in the user's note (often from voice-to-text). " +
    "Hard rules: do NOT change, add, remove, or reorder any words. Do NOT change formatting, headings, " +
    "lists, or structure. Only fix capitalization, sentence punctuation, and obvious spacing. " +
    "Return ONLY the corrected text — no commentary, no code fences.",
  refine: (styleGuide: string) =>
    "You reformat the user's note for readability WITHOUT changing the wording. " +
    "Hard rules: do NOT add, remove, or reword content (you may adjust capitalization/punctuation only as " +
    "needed to form headings). Apply Markdown formatting — headings, bullet/numbered lists, bold, italics — " +
    "where it improves structure. Preserve all original meaning. Return ONLY the formatted Markdown — no " +
    "commentary, no code fences." +
    (styleGuide ? "\n\nFollow the user's formatting preferences:\n" + styleGuide : ""),
  findGaps:
    "You review the user's note and surface what's missing. You may read related notes in the vault and " +
    "search the web for context, but you must NOT edit anything. Respond with two short sections: " +
    "'Gaps & missing points' (important things absent, incomplete, or worth verifying) and " +
    "'Questions to test yourself'. Flag anything that looks factually off. If you need clarification, call ask_user.",
  chat:
    "You are a helpful assistant embedded in Obsidian, working with the user's note. You may read other notes " +
    "in the vault and search the web. You can only edit the currently open note, and only via the " +
    "propose_note_edit tool (the user reviews a diff and approves). Never attempt to edit other files. " +
    "If you need clarification, call ask_user. Be concise.",
};

// Resolve the user's installed `claude`. Returns undefined to let the SDK use its bundled binary.
// ponytail: best-effort path probing; manual-verified, not unit-tested.
export function resolveClaudePath(override: string): string | undefined {
  if (override && existsSync(override)) return override;
  try {
    const found = execSync("command -v claude", { encoding: "utf8" }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    // not on PATH; fall through to common locations
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

export interface RunOpts {
  model: string;
  thinking: ThinkingLevel;
  allowWeb: boolean;
  abort: AbortController;
}

export interface AgentUI {
  onAskUser(q: string): Promise<string>;
  onProposeEdit?(content: string, summary: string): Promise<boolean>;
  onProgress?(text: string): void;
}

// ponytail: parent_tool_use_id is required (string | null) in SDKUserMessage; brief omitted it.
async function* once(text: string) {
  yield { type: "user" as const, message: { role: "user" as const, content: text }, parent_tool_use_id: null };
}

function thinkingOpt(level: ThinkingLevel): { maxThinkingTokens?: number } {
  const t = thinkingTokens(level);
  return t > 0 ? { maxThinkingTokens: t } : {};
}

export class AgentClient {
  constructor(private cfg: { cwd: string; claudePath?: string }) {}

  // One-shot transform: no tools, plain string prompt. Used by Fix Formatting & Refine.
  async transform(systemPrompt: string, text: string, o: RunOpts): Promise<string> {
    const messages: any[] = [];
    for await (const m of query({
      prompt: text,
      options: {
        systemPrompt,
        model: o.model,
        tools: [],
        pathToClaudeCodeExecutable: this.cfg.claudePath,
        abortController: o.abort,
        ...thinkingOpt(o.thinking),
      },
    })) {
      messages.push(m);
    }
    return stripFences(extractText(messages));
  }

  // Read-only vault + optional web + ask_user. Used by Find Gaps.
  async analysis(systemPrompt: string, userText: string, ui: AgentUI, o: RunOpts): Promise<string> {
    const buddy = createSdkMcpServer({
      name: "buddy",
      version: "1.0.0",
      tools: [this.askUserTool(ui)],
    });
    const builtins = o.allowWeb
      ? ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
      : ["Read", "Glob", "Grep"];
    const messages: any[] = [];
    for await (const m of query({
      prompt: once(userText),
      options: {
        systemPrompt,
        model: o.model,
        cwd: this.cfg.cwd,
        tools: builtins,
        mcpServers: { buddy },
        allowedTools: [...builtins, "mcp__buddy__ask_user"],
        pathToClaudeCodeExecutable: this.cfg.claudePath,
        abortController: o.abort,
        ...thinkingOpt(o.thinking),
      },
    })) {
      messages.push(m);
      this.reportProgress(m, ui);
    }
    return extractText(messages);
  }

  // Persistent chat via resume. Read-only vault + optional web + ask_user + propose_note_edit.
  async chat(
    userText: string,
    resumeSessionId: string | undefined,
    ui: AgentUI,
    o: RunOpts,
  ): Promise<{ text: string; sessionId: string }> {
    // ponytail: any[] avoids the generic mismatch between SdkMcpToolDefinition<{question}> and SdkMcpToolDefinition<{new_content,summary}>
    const tools: any[] = [this.askUserTool(ui)];
    if (ui.onProposeEdit) tools.push(this.proposeEditTool(ui));
    const buddy = createSdkMcpServer({ name: "buddy", version: "1.0.0", tools });
    const builtins = o.allowWeb
      ? ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
      : ["Read", "Glob", "Grep"];
    const allowed = [...builtins, "mcp__buddy__ask_user"];
    if (ui.onProposeEdit) allowed.push("mcp__buddy__propose_note_edit");

    const messages: any[] = [];
    let sessionId = resumeSessionId ?? "";
    for await (const m of query({
      prompt: once(userText),
      options: {
        systemPrompt: PROMPTS.chat,
        model: o.model,
        cwd: this.cfg.cwd,
        tools: builtins,
        mcpServers: { buddy },
        allowedTools: allowed,
        resume: resumeSessionId,
        pathToClaudeCodeExecutable: this.cfg.claudePath,
        abortController: o.abort,
        ...thinkingOpt(o.thinking),
      },
    })) {
      messages.push(m);
      if ((m as any)?.session_id) sessionId = (m as any).session_id;
      this.reportProgress(m, ui);
    }
    return { text: extractText(messages), sessionId };
  }

  private reportProgress(m: any, ui: AgentUI) {
    if (!ui.onProgress) return;
    if (m?.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b?.type === "tool_use") ui.onProgress(`Using ${b.name}…`);
      }
    }
  }

  private askUserTool(ui: AgentUI) {
    return tool(
      "ask_user",
      "Ask the user a clarifying question and wait for their typed answer.",
      { question: z.string().describe("The question to show the user") },
      async (args) => ({ content: [{ type: "text" as const, text: await ui.onAskUser(args.question) }] }),
      { annotations: { readOnlyHint: true } },
    );
  }

  private proposeEditTool(ui: AgentUI) {
    return tool(
      "propose_note_edit",
      "Propose new full content for the currently open note. The user reviews a diff and accepts or rejects.",
      {
        new_content: z.string().describe("The complete new note content"),
        summary: z.string().describe("One-line summary of the change"),
      },
      async (args) => {
        const accepted = await ui.onProposeEdit!(args.new_content, args.summary);
        return {
          content: [
            {
              type: "text" as const,
              text: accepted
                ? "User accepted; the note was updated."
                : "User rejected; the note is unchanged.",
            },
          ],
        };
      },
    );
  }
}
