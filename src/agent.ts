import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execSync } from "child_process";
import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import { extractText, stripFences, preserveEdges } from "./parse";
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
    "You are a helpful assistant embedded in Obsidian, working with the user's note. The user's message is " +
    "prefixed with [Currently open note: <path>] (relative to the vault root) telling you exactly which note " +
    "is open — read that file for context and treat it as the note to edit; do NOT guess from recently " +
    "modified files. You may read other notes in the vault and search the web. You can only edit the currently " +
    "open note, and only via the propose_note_edit tool (the user reviews a diff and approves). Never attempt " +
    "to edit other files. propose_note_edit is ONLY for the note's actual new content — never put a question, " +
    "clarification, or message to the user in it. If the request is ambiguous (e.g. you don't know which part " +
    "to change), do NOT call propose_note_edit: ask via ask_user or just reply in plain text. Be concise.",
};

// Resolve the user's installed `claude`. Returns undefined to let the SDK use its bundled binary.
// GUI apps on macOS get a minimal PATH, so an in-process `command -v claude` usually misses
// user installs (~/.local/bin, homebrew, nvm). Ask the user's login shell (which loads their real
// PATH) first, then fall back to known locations.
// ponytail: best-effort path probing; manual-verified, not unit-tested.
export function resolveClaudePath(override: string): string | undefined {
  if (override && existsSync(override)) return override;

  const shell = process.env.SHELL || "/bin/zsh";
  const probes = [`${shell} -lic 'command -v claude'`, "command -v claude"];
  for (const cmd of probes) {
    try {
      const found = execSync(cmd, { encoding: "utf8", timeout: 5000 })
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && existsSync(l));
      if (found) return found;
    } catch {
      // try the next probe / fall through to known locations
    }
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".npm-global", "bin", "claude"),
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

// Live streaming hooks. Driven by includePartialMessages: text/thinking deltas arrive as
// stream_event messages; tool calls are read off assistant messages.
export interface StreamHooks {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  onTool?(name: string): void;
}

export interface AgentUI extends StreamHooks {
  onAskUser(q: string): Promise<string>;
  onProposeEdit?(content: string, summary: string): Promise<boolean>;
}

// ponytail: parent_tool_use_id is required (string | null) in SDKUserMessage; brief omitted it.
async function* once(text: string) {
  yield { type: "user" as const, message: { role: "user" as const, content: text }, parent_tool_use_id: null };
}

function thinkingOpt(level: ThinkingLevel): { maxThinkingTokens?: number } {
  const t = thinkingTokens(level);
  return t > 0 ? { maxThinkingTokens: t } : {};
}

// The read-only tool allowlist — this IS the plugin's "no write tools" security model.
// Kept in one place so analysis() and chat() can never drift out of sync.
function builtinTools(allowWeb: boolean): string[] {
  return allowWeb ? ["Read", "Glob", "Grep", "WebSearch", "WebFetch"] : ["Read", "Glob", "Grep"];
}

export class AgentClient {
  constructor(private cfg: { cwd: string; claudePath?: string }) {}

  // One-shot transform: no tools, plain string prompt. Used by Fix Formatting & Refine.
  // `hooks` optionally surfaces live thinking while it works (the result is shown as a diff, not typed).
  async transform(systemPrompt: string, text: string, o: RunOpts, hooks?: StreamHooks): Promise<string> {
    const messages: any[] = [];
    for await (const m of query({
      prompt: text,
      options: {
        systemPrompt,
        model: o.model,
        tools: [],
        pathToClaudeCodeExecutable: this.cfg.claudePath,
        abortController: o.abort,
        ...(hooks ? { includePartialMessages: true } : {}),
        ...thinkingOpt(o.thinking),
      },
    })) {
      messages.push(m);
      if (hooks) this.handleStream(m, hooks);
    }
    // Restore the original edges: Fix/Refine shouldn't alter leading/trailing whitespace, but the
    // model drops it on rewrite, producing a phantom blank-line diff that steering can't undo.
    return preserveEdges(text, stripFences(extractText(messages)));
  }

  // Read-only vault + optional web + ask_user. Used by Find Gaps.
  async analysis(systemPrompt: string, userText: string, ui: AgentUI, o: RunOpts): Promise<string> {
    const odin = createSdkMcpServer({
      name: "odin",
      version: "1.0.0",
      tools: [this.askUserTool(ui)],
    });
    const builtins = builtinTools(o.allowWeb);
    const messages: any[] = [];
    for await (const m of query({
      prompt: once(userText),
      options: {
        systemPrompt,
        model: o.model,
        cwd: this.cfg.cwd,
        tools: builtins,
        mcpServers: { odin },
        allowedTools: [...builtins, "mcp__odin__ask_user"],
        pathToClaudeCodeExecutable: this.cfg.claudePath,
        abortController: o.abort,
        includePartialMessages: true,
        ...thinkingOpt(o.thinking),
      },
    })) {
      messages.push(m);
      this.handleStream(m, ui);
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
    const odin = createSdkMcpServer({ name: "odin", version: "1.0.0", tools });
    const builtins = builtinTools(o.allowWeb);
    const allowed = [...builtins, "mcp__odin__ask_user"];
    if (ui.onProposeEdit) allowed.push("mcp__odin__propose_note_edit");

    const messages: any[] = [];
    let sessionId = resumeSessionId ?? "";
    for await (const m of query({
      prompt: once(userText),
      options: {
        systemPrompt: PROMPTS.chat,
        model: o.model,
        cwd: this.cfg.cwd,
        tools: builtins,
        mcpServers: { odin },
        allowedTools: allowed,
        resume: resumeSessionId,
        pathToClaudeCodeExecutable: this.cfg.claudePath,
        abortController: o.abort,
        includePartialMessages: true,
        ...thinkingOpt(o.thinking),
      },
    })) {
      messages.push(m);
      if ((m as any)?.session_id) sessionId = (m as any).session_id;
      this.handleStream(m, ui);
    }
    return { text: extractText(messages), sessionId };
  }

  // Fan out streaming events: text/thinking deltas (from stream_event) drive the typewriter and
  // live reasoning; tool_use blocks (from assistant messages) drive the step list.
  private handleStream(m: any, hooks: StreamHooks) {
    if (m?.type === "stream_event") {
      const delta = m.event?.delta;
      if (m.event?.type === "content_block_delta" && delta) {
        if (delta.type === "text_delta" && hooks.onText) hooks.onText(delta.text);
        else if (delta.type === "thinking_delta" && hooks.onThinking) hooks.onThinking(delta.thinking);
      }
      return;
    }
    if (m?.type === "assistant" && hooks.onTool) {
      for (const b of m.message?.content ?? []) {
        if (b?.type === "tool_use") hooks.onTool(b.name);
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
      "Propose new full content for the currently open note. The user reviews a diff and accepts or rejects. " +
        "new_content must be ONLY the note's actual text — never a question, clarification, or message to the " +
        "user. If you don't yet know what to edit, don't call this tool; ask via ask_user or reply in plain text.",
      {
        new_content: z.string().describe("The complete new note content — note text only, never a message to the user"),
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
