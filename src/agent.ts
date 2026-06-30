import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Codex, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { z } from "zod";
import { execSync } from "child_process";
import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import { extractText, stripFences } from "./parse";
import { AgentProvider, thinkingTokens, ThinkingLevel } from "./settings";

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
    "to edit other files. If you need clarification, call ask_user. Be concise.",
};

type ExecProbe = (cmd: string) => string;
type ExistsProbe = (p: string) => boolean;

export interface ResolveExecutablePathOptions {
  override: string;
  command: string;
  candidates: string[];
  shell?: string;
  exists?: ExistsProbe;
  exec?: ExecProbe;
}

export interface ResolveCliPathDeps {
  exists?: ExistsProbe;
  exec?: ExecProbe;
  home?: string;
  shell?: string;
}

// Resolve a user's installed CLI. GUI apps on macOS get a minimal PATH, so an in-process
// `command -v` often misses user installs. Ask the user's login shell first, then fall
// back to known locations.
export function resolveExecutablePath(opts: ResolveExecutablePathOptions): string | undefined {
  const exists = opts.exists ?? existsSync;
  if (opts.override && exists(opts.override)) return opts.override;

  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  const exec = opts.exec ?? ((cmd) => execSync(cmd, { encoding: "utf8", timeout: 5000 }));
  const probes = [`${shell} -lic 'command -v ${opts.command}'`, `command -v ${opts.command}`];
  for (const cmd of probes) {
    try {
      const found = exec(cmd)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && exists(l));
      if (found) return found;
    } catch {
      // try the next probe / fall through to known locations
    }
  }

  for (const c of opts.candidates) if (exists(c)) return c;
  return undefined;
}

export function resolveClaudePath(override: string, deps: ResolveCliPathDeps = {}): string | undefined {
  const home = deps.home ?? os.homedir();
  return resolveExecutablePath({
    override,
    command: "claude",
    shell: deps.shell,
    exists: deps.exists,
    exec: deps.exec,
    candidates: [
      path.join(home, ".local", "bin", "claude"),
      path.join(home, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      path.join(home, ".npm-global", "bin", "claude"),
    ],
  });
}

export function resolveCodexPath(override: string, deps: ResolveCliPathDeps = {}): string | undefined {
  const home = deps.home ?? os.homedir();
  return resolveExecutablePath({
    override,
    command: "codex",
    shell: deps.shell,
    exists: deps.exists,
    exec: deps.exec,
    candidates: [
      path.join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      path.join(home, ".npm-global", "bin", "codex"),
    ],
  });
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

function codexReasoningEffort(level: ThinkingLevel): ThreadOptions["modelReasoningEffort"] {
  if (level === "high") return "high";
  if (level === "normal") return "medium";
  return "minimal";
}

export function codexThreadOptions(o: {
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  allowWeb: boolean;
}): ThreadOptions {
  const opts: ThreadOptions = {
    workingDirectory: o.cwd,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: codexReasoningEffort(o.thinking),
    webSearchMode: o.allowWeb ? "live" : "disabled",
  };
  if (o.model && o.model !== "auto") opts.model = o.model;
  return opts;
}

// The read-only tool allowlist — this IS the plugin's "no write tools" security model.
// Kept in one place so analysis() and chat() can never drift out of sync.
function builtinTools(allowWeb: boolean): string[] {
  return allowWeb ? ["Read", "Glob", "Grep", "WebSearch", "WebFetch"] : ["Read", "Glob", "Grep"];
}

function parseCodexEdit(text: string): { reply: string; summary: string; content: string } | null {
  const match = text.match(/<odin_propose_note_edit(?:\s+summary="([^"]*)")?\s*>\n?([\s\S]*?)\n?<\/odin_propose_note_edit>/);
  if (!match) return null;
  return {
    reply: text.replace(match[0], "").trim(),
    summary: (match[1] ?? "Proposed note edit").trim() || "Proposed note edit",
    content: stripFences(match[2].trim()),
  };
}

export class AgentClient {
  constructor(private cfg: { cwd: string; provider: AgentProvider; claudePath?: string; codexPath?: string }) {}

  // One-shot transform: no tools, plain string prompt. Used by Fix Formatting & Refine.
  // `hooks` optionally surfaces live thinking while it works (the result is shown as a diff, not typed).
  async transform(systemPrompt: string, text: string, o: RunOpts, hooks?: StreamHooks): Promise<string> {
    if (this.cfg.provider === "codex") return this.transformCodex(systemPrompt, text, o, hooks);
    return this.transformClaude(systemPrompt, text, o, hooks);
  }

  private async transformClaude(systemPrompt: string, text: string, o: RunOpts, hooks?: StreamHooks): Promise<string> {
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
    return stripFences(extractText(messages));
  }

  private async transformCodex(systemPrompt: string, text: string, o: RunOpts, hooks?: StreamHooks): Promise<string> {
    const prompt =
      `${systemPrompt}\n\n` +
      "Use only the text below. Do not inspect files, run commands, or modify files. " +
      "Return only the transformed text with no commentary or code fences.\n\n---\n" +
      text;
    const result = await this.runCodex(prompt, {
      model: o.model,
      thinking: o.thinking,
      allowWeb: false,
      abort: o.abort,
    }, hooks);
    return stripFences(result.text);
  }

  // Read-only vault + optional web + ask_user. Used by Find Gaps.
  async analysis(systemPrompt: string, userText: string, ui: AgentUI, o: RunOpts): Promise<string> {
    if (this.cfg.provider === "codex") return this.analysisCodex(systemPrompt, userText, ui, o);
    return this.analysisClaude(systemPrompt, userText, ui, o);
  }

  private async analysisClaude(systemPrompt: string, userText: string, ui: AgentUI, o: RunOpts): Promise<string> {
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

  private async analysisCodex(systemPrompt: string, userText: string, ui: AgentUI, o: RunOpts): Promise<string> {
    const prompt =
      systemPrompt.replace("If you need clarification, call ask_user.", "If you need clarification, ask it directly in your response.") +
      "\n\nYou are running in read-only mode. Do not modify files. Use the active note text below as primary context.\n\n" +
      userText;
    const result = await this.runCodex(prompt, o, ui);
    return result.text;
  }

  // Persistent chat via resume. Read-only vault + optional web + ask_user + propose_note_edit.
  async chat(
    userText: string,
    resumeSessionId: string | undefined,
    ui: AgentUI,
    o: RunOpts,
  ): Promise<{ text: string; sessionId: string }> {
    if (this.cfg.provider === "codex") return this.chatCodex(userText, resumeSessionId, ui, o);
    return this.chatClaude(userText, resumeSessionId, ui, o);
  }

  private async chatClaude(
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

  private async chatCodex(
    userText: string,
    resumeSessionId: string | undefined,
    ui: AgentUI,
    o: RunOpts,
  ): Promise<{ text: string; sessionId: string }> {
    const prompt =
      PROMPTS.chat.replace("If you need clarification, call ask_user.", "If you need clarification, ask it directly in your response.")
        .replace("You can only edit the currently open note, and only via the propose_note_edit tool (the user reviews a diff and approves). Never attempt to edit other files. ", "") +
      "\n\nYou are running through Codex in read-only mode. Never edit files directly. " +
      "If the user wants the current note changed, include the complete replacement note inside this exact XML block at the end of your response:\n" +
      '<odin_propose_note_edit summary="one-line summary">\nFULL NEW NOTE CONTENT\n</odin_propose_note_edit>\n' +
      "Do not use that block unless you are proposing a full-note edit for review.\n\n" +
      userText;

    const result = await this.runCodex(prompt, o, ui, resumeSessionId, false);
    const parsed = parseCodexEdit(result.text);
    if (!parsed || !ui.onProposeEdit) {
      return { text: result.text, sessionId: result.sessionId ?? resumeSessionId ?? "" };
    }

    const accepted = await ui.onProposeEdit(parsed.content, parsed.summary);
    const visible = [
      parsed.reply || parsed.summary || "I prepared an edit for the open note.",
      accepted ? "User accepted; the note was updated." : "User rejected; the note is unchanged.",
    ].join("\n\n");
    return { text: visible, sessionId: result.sessionId ?? resumeSessionId ?? "" };
  }

  private async runCodex(
    prompt: string,
    o: RunOpts,
    hooks?: StreamHooks,
    resumeSessionId?: string,
    streamText = true,
  ): Promise<{ text: string; sessionId?: string }> {
    const codex = new Codex({ codexPathOverride: this.cfg.codexPath });
    const opts = codexThreadOptions({
      cwd: this.cfg.cwd,
      model: o.model,
      thinking: o.thinking,
      allowWeb: o.allowWeb,
    });
    const thread = resumeSessionId ? codex.resumeThread(resumeSessionId, opts) : codex.startThread(opts);
    const { events } = await thread.runStreamed(prompt, { signal: o.abort.signal });
    let final = "";
    for await (const event of events) {
      this.handleCodexEvent(event, hooks, streamText);
      if (event.type === "item.completed" && event.item.type === "agent_message") final = event.item.text;
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") throw new Error(event.message);
    }
    return { text: final, sessionId: thread.id ?? resumeSessionId };
  }

  private handleCodexEvent(event: ThreadEvent, hooks?: StreamHooks, streamText = true) {
    if (!hooks) return;
    if (event.type !== "item.completed" && event.type !== "item.started") return;
    const item = event.item;
    if (item.type === "reasoning" && event.type === "item.completed") hooks.onThinking?.(item.text);
    else if (item.type === "agent_message" && event.type === "item.completed" && streamText) hooks.onText?.(item.text);
    else if (item.type === "web_search" && event.type === "item.started") hooks.onTool?.("WebSearch");
    else if (item.type === "command_execution" && event.type === "item.started") hooks.onTool?.("Shell");
    else if (item.type === "mcp_tool_call" && event.type === "item.started") hooks.onTool?.(`mcp__${item.server}__${item.tool}`);
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
