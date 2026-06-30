import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Codex, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { z } from "zod";
import { execSync, execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { extractText, stripFences, preserveEdges } from "./parse";
import { safeSkillDir, skillDoc, parseSkill, SkillInfo } from "./skill";
import { AgentProvider, thinkingTokens, ThinkingLevel } from "./settings";

// Full SDK isolation from the user's own Claude Code config. settingSources:[] loads NO filesystem
// settings, so neither ~/.claude (global) NOR the vault's .claude (project) — personal CLAUDE.md,
// hooks, permissions, skills — can bleed into the Obsidian assistant. skills:[] enables zero
// auto-discovered skills; it's redundant under settingSources:[] (skills load only from a settings
// source) but explicit. Odin's own skills are injected directly via the "/" menu (see widget.invokeSkill).
const ISOLATED_SETTINGS: { settingSources: ("user" | "project" | "local")[]; skills: string[] } = {
  settingSources: [],
  skills: [],
};

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
    "to change), do NOT call propose_note_edit: ask via ask_user or just reply in plain text. After the user " +
    "accepts, rejects, or steers a proposed edit, reply with a brief one-line confirmation of the outcome and " +
    "stop — NEVER say the user's message was empty or 'didn't come through' (the user is present; they just " +
    "acted on an edit). Be concise. " +
    "Your replies are shown to the user as rendered Markdown, so write Markdown directly — use headings, " +
    "lists, bold/italics, and inline code where they help. Do NOT wrap your whole reply in a code fence; " +
    "reserve fenced code blocks for actual code, or for when the user explicitly asks to see raw Markdown source." +
    "\n\nYou also have tools for evolving how you work — but use them ONLY when the user EXPLICITLY asks you " +
    "to, never proactively or to be helpful. Style guide (the user's Refine formatting preferences): " +
    "update_style_guide appends ONE concise preference (never overwriting); replace_style_guide rewrites the " +
    "WHOLE guide — use it to change or remove existing preferences, or pass an empty string to clear it (the " +
    "current guide, if any, is shown below). Skills (reusable workflows saved as files): create_skill saves a " +
    "new one, edit_skill overwrites an existing one (Read its SKILL.md first and pass the complete new " +
    "contents), and delete_skill removes one. The user approves each with a confirmation, so only call them on " +
    "a direct request like \"remember that…\", \"save this as a skill\", \"update my … skill\", or \"forget that " +
    "preference\". A created or edited skill is runnable by the user typing /<name> in the composer. Your " +
    "saved skills are NOT auto-loaded into this conversation — if the user asks whether you can see a skill, " +
    "tell them their saved skills run by typing /<name> in the composer; you don't have them listed unless one is invoked.",
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
  provider: AgentProvider;
  model: string;
  thinking: ThinkingLevel;
  allowWeb: boolean;
  abort: AbortController;
  // The user's current Refine style guide, surfaced to the chat model so replace_style_guide
  // (edit/clear) can act on what actually exists. Only set for chat; ignored elsewhere.
  styleGuide?: string;
}

// Live streaming hooks. Driven by includePartialMessages: text/thinking deltas arrive as
// stream_event messages; tool calls are read off assistant messages.
export interface StreamHooks {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  onTool?(name: string): void;
}

// Outcome of a proposed edit: accepted/rejected, or rejected-with-steer (feedback the agent should
// use to revise and re-propose, all within the same turn).
export type EditResult = { accepted: boolean; feedback?: string };

export interface AgentUI extends StreamHooks {
  onAskUser(q: string): Promise<string>;
  onProposeEdit?(content: string, summary: string): Promise<EditResult>;
  // Self-editing tools (chat only). Each resolves whether the user approved the inline confirmation.
  // Style-guide changes are persisted by the UI; skill files are written/removed here after approval.
  onUpdateStyleGuide?(preference: string): Promise<boolean>;
  onReplaceStyleGuide?(content: string): Promise<boolean>;
  onCreateSkill?(slug: string, summary: string): Promise<boolean>;
  onEditSkill?(slug: string, summary: string): Promise<boolean>;
  onDeleteSkill?(slug: string, summary: string): Promise<boolean>;
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

// Pull a proposed full-note edit out of a Codex reply. Tolerant by design: case-insensitive, allows
// any/extra attributes on the open tag, and treats a MISSING closing tag as "to end of message" — the
// old strict regex silently dropped the edit (leaving raw XML in the reply) whenever the model's tag
// shape drifted. Exported for tests.
export function parseCodexEdit(text: string): { reply: string; summary: string; content: string } | null {
  const m = text.match(/<odin_propose_note_edit\b([^>]*)>\r?\n?([\s\S]*?)(?:\r?\n?<\/odin_propose_note_edit>|$)/i);
  if (!m) return null;
  const summary = (m[1].match(/summary\s*=\s*"([^"]*)"/i)?.[1] ?? "").trim() || "Proposed note edit";
  return {
    reply: text.replace(m[0], "").trim(),
    summary,
    content: stripFences(m[2].trim()),
  };
}

export interface ProviderStatus {
  provider: AgentProvider;
  path?: string;
  version?: string;
  authed: boolean;
  detail: string;
  hint?: string;
}

// Parse `claude auth status --json` stdout into authed + a human-readable detail. Exported for tests.
export function parseClaudeAuth(stdout: string): { authed: boolean; detail: string } {
  try {
    const j = JSON.parse(stdout);
    if (j?.loggedIn === true) {
      const who = j.email || j.authMethod || "logged in";
      const plan = j.subscriptionType ? ` · ${j.subscriptionType}` : "";
      return { authed: true, detail: `${who}${plan}` };
    }
  } catch {
    /* not JSON → fall through to not-authed */
  }
  return { authed: false, detail: "Not logged in" };
}

// Parse `codex login status` stdout. The exit code is unreliable (a bad subcommand still exits 0), so
// read the first line. Exported for tests.
export function parseCodexAuth(stdout: string): { authed: boolean; detail: string } {
  const line = stdout.trim().split("\n")[0]?.trim() ?? "";
  if (/^logged in/i.test(line)) return { authed: true, detail: line };
  return { authed: false, detail: line || "Not logged in" };
}

export class AgentClient {
  // skillsDir is Odin's OWN skill store (the plugin's dir, not the vault's .claude/skills) so the
  // user's personal Claude Code skills never collide with or bleed into Odin's — see main.refreshAgent.
  constructor(private cfg: { cwd: string; skillsDir: string; claudePath?: string; codexPath?: string }) {}

  // Which providers have a resolved CLI. ponytail: best-effort detection from resolved
  // CLI paths; show both if neither is detectable so we never lock the user out.
  availableProviders(): AgentProvider[] {
    const out: AgentProvider[] = [];
    if (this.cfg.claudePath) out.push("claude");
    if (this.cfg.codexPath) out.push("codex");
    return out.length ? out : ["claude", "codex"];
  }

  // A zero-token connection check for the settings doctor: resolve the CLI, read its version, then ask
  // the CLI's OWN auth-status command (no model turn). A missing CLI / exec failure → not authed.
  async checkProvider(provider: AgentProvider): Promise<ProviderStatus> {
    const cliPath = provider === "claude" ? this.cfg.claudePath : this.cfg.codexPath;
    const label = provider === "claude" ? "Claude" : "Codex";
    const loginHint = provider === "claude" ? "Run `claude login` in your terminal." : "Run `codex login` in your terminal.";
    if (!cliPath) {
      return { provider, authed: false, detail: `No ${label} CLI found`, hint: `Install the ${label} CLI, then reopen settings — or set its path below.` };
    }
    // execFileSync (no shell) — cliPath is passed as argv[0], so a path with spaces or shell
    // metacharacters can't break out into a command string.
    const run = (args: string[]) => execFileSync(cliPath, args, { encoding: "utf8", timeout: 8000 });
    let version: string | undefined;
    try {
      version = run(["--version"]).trim().split("\n")[0];
    } catch {
      /* version is best-effort */
    }
    try {
      const r =
        provider === "claude"
          ? parseClaudeAuth(run(["auth", "status", "--json"]))
          : parseCodexAuth(run(["login", "status"]));
      return { provider, path: cliPath, version, authed: r.authed, detail: r.detail, hint: r.authed ? undefined : loginHint };
    } catch {
      return { provider, path: cliPath, version, authed: false, detail: "Could not check login status", hint: loginHint };
    }
  }

  // The skills Odin has authored (<skillsDir>/<slug>/SKILL.md), surfaced in the widget's "/" menu so
  // the user can run them directly. Sync + cheap (a handful of small files).
  listSkills(): SkillInfo[] {
    const dir = this.cfg.skillsDir;
    if (!existsSync(dir)) return [];
    const out: SkillInfo[] = [];
    for (const slug of readdirSync(dir)) {
      const file = path.join(dir, slug, "SKILL.md");
      if (!existsSync(file)) continue;
      try {
        const p = parseSkill(readFileSync(file, "utf8"));
        out.push({ slug, name: p.name || slug, description: p.description, body: p.body });
      } catch {
        /* skip an unreadable skill */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Delete an Odin skill by slug (used by the settings list). Same containment guard as the chat tool.
  removeSkill(slug: string): boolean {
    const loc = safeSkillDir(this.cfg.skillsDir, slug);
    if (!loc || !existsSync(loc.file)) return false;
    rmSync(loc.dir, { recursive: true, force: true });
    return true;
  }

  // One-shot transform used by Fix Formatting & Refine; the result is shown as a diff, not typed.
  // `hooks` optionally surfaces live thinking while it works.
  async transform(systemPrompt: string, text: string, o: RunOpts, hooks?: StreamHooks): Promise<string> {
    if (o.provider === "codex") return this.transformCodex(systemPrompt, text, o, hooks);
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
        ...ISOLATED_SETTINGS,
        pathToClaudeCodeExecutable: this.cfg.claudePath,
        abortController: o.abort,
        ...(hooks ? { includePartialMessages: true } : {}),
        ...thinkingOpt(o.thinking),
      },
    })) {
      messages.push(m);
      if (hooks) this.handleStream(m, hooks);
    }
    // Restore edges the model drops on rewrite (see preserveEdges).
    return preserveEdges(text, stripFences(extractText(messages)));
  }

  private async transformCodex(systemPrompt: string, text: string, o: RunOpts, hooks?: StreamHooks): Promise<string> {
    const prompt =
      `${systemPrompt}\n\n` +
      "Use only the text below. Do not inspect files, run commands, or modify files. " +
      "Return only the transformed text with no commentary or code fences.\n\n---\n" +
      text;
    const result = await this.runCodex(prompt, { ...o, allowWeb: false }, hooks);
    return preserveEdges(text, stripFences(result.text));
  }

  // Read-only vault + optional web + ask_user. Used by Find Gaps.
  async analysis(systemPrompt: string, userText: string, ui: AgentUI, o: RunOpts): Promise<string> {
    if (o.provider === "codex") return this.analysisCodex(systemPrompt, userText, ui, o);
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
        ...ISOLATED_SETTINGS,
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
    if (o.provider === "codex") return this.chatCodex(userText, resumeSessionId, ui, o);
    return this.chatClaude(userText, resumeSessionId, ui, o);
  }

  private async chatClaude(
    userText: string,
    resumeSessionId: string | undefined,
    ui: AgentUI,
    o: RunOpts,
  ): Promise<{ text: string; sessionId: string }> {
    // askUser is always on; the rest are gated by which UI callbacks the caller supplied. One table so
    // a tool can never be stream-enabled-but-not-allowed (a row carries both the tool and its allow entry).
    // ponytail: any[] avoids the generic mismatch between the differently-shaped SdkMcpToolDefinitions.
    const builtins = builtinTools(o.allowWeb);
    const tools: any[] = [this.askUserTool(ui)];
    const allowed = [...builtins, "mcp__odin__ask_user"];
    const optional: [unknown, () => any, string][] = [
      [ui.onProposeEdit, () => this.proposeEditTool(ui), "propose_note_edit"],
      [ui.onUpdateStyleGuide, () => this.updateStyleGuideTool(ui), "update_style_guide"],
      [ui.onReplaceStyleGuide, () => this.replaceStyleGuideTool(ui), "replace_style_guide"],
      [ui.onCreateSkill, () => this.createSkillTool(ui), "create_skill"],
      [ui.onEditSkill, () => this.editSkillTool(ui), "edit_skill"],
      [ui.onDeleteSkill, () => this.deleteSkillTool(ui), "delete_skill"],
    ];
    for (const [on, make, name] of optional) if (on) { tools.push(make()); allowed.push("mcp__odin__" + name); }
    const odin = createSdkMcpServer({ name: "odin", version: "1.0.0", tools });

    const guide = o.styleGuide?.trim();
    const systemPrompt = guide
      ? `${PROMPTS.chat}\n\nThe user's CURRENT Refine style guide (what replace_style_guide overwrites; edit or clear it only on explicit request):\n${guide}`
      : PROMPTS.chat;
    const messages: any[] = [];
    let sessionId = resumeSessionId ?? "";
    for await (const m of query({
      prompt: once(userText),
      options: {
        systemPrompt,
        model: o.model,
        cwd: this.cfg.cwd,
        tools: builtins,
        mcpServers: { odin },
        allowedTools: allowed,
        resume: resumeSessionId,
        // Fully isolate the chat from the user's own Claude Code config — see ISOLATED_SETTINGS. This
        // is the path the persistent chat runs on, so the vault's .claude (personal CLAUDE.md, hooks
        // like a SessionStart skill, permissions) must NOT bleed in; Odin's own skills are invoked
        // directly via the "/" menu (see widget.invokeSkill).
        ...ISOLATED_SETTINGS,
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
      PROMPTS.chat.replace("ask via ask_user or just reply in plain text", "ask the question directly in your reply")
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

    const edit = await ui.onProposeEdit(parsed.content, parsed.summary);
    const visible = [
      parsed.reply || parsed.summary || "I prepared an edit for the open note.",
      edit.accepted
        ? "User accepted; the note was updated."
        : edit.feedback
          ? `User asked for changes: ${edit.feedback}`
          : "User rejected; the note is unchanged.",
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
      "Propose new full content for the currently open note. The user reviews a diff and accepts or rejects. " +
        "new_content must be ONLY the note's actual text — never a question, clarification, or message to the " +
        "user. If you don't yet know what to edit, don't call this tool; ask via ask_user or reply in plain text.",
      {
        new_content: z.string().describe("The complete new note content — note text only, never a message to the user"),
        summary: z.string().describe("One-line summary of the change"),
      },
      async (args) => {
        const r = await ui.onProposeEdit!(args.new_content, args.summary);
        const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
        if (r.accepted) return text("User accepted; the note was updated. Confirm what changed in one short line, then stop.");
        if (r.feedback) {
          return text(
            `User did NOT accept this version — they want changes: ${r.feedback}\n` +
              "Revise the note accordingly and call propose_note_edit again with the complete updated content.",
          );
        }
        return text("User rejected; the note is unchanged. Briefly acknowledge, then stop.");
      },
    );
  }

  // Append one formatting preference to the user's Refine style guide. The UI confirms + persists;
  // this tool only forwards the request and reports the outcome.
  private updateStyleGuideTool(ui: AgentUI) {
    return tool(
      "update_style_guide",
      "Append ONE concise formatting preference to the user's Refine style guide. Use ONLY when the user " +
        "explicitly asks you to remember how they like notes formatted. It is appended, never overwriting; the " +
        "user approves before it is saved.",
      { preference: z.string().describe("One concise formatting preference to remember (a single sentence)") },
      async (args) => {
        const ok = await ui.onUpdateStyleGuide!(args.preference.trim());
        return {
          content: [{ type: "text" as const, text: ok ? "Saved to your style guide." : "User declined; style guide unchanged." }],
        };
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  // Author a skill SKILL.md in Odin's own skills dir (cfg.skillsDir). Safety lives in code, not a
  // dialog: slug sanitization, path containment under the skills dir (safeSkillDir), and no-overwrite.
  // The file is only written after the user approves the inline confirmation (ui.onCreateSkill).
  private createSkillTool(ui: AgentUI) {
    return tool(
      "create_skill",
      "Author a reusable skill (saved as a SKILL.md in Odin's skills folder) so it is runnable in the " +
        "user's NEXT chat via /<name>. Use ONLY when the user explicitly asks you to save or remember a " +
        "workflow. Does not overwrite an existing skill.",
      {
        name: z.string().describe("Short skill name; becomes the directory slug"),
        description: z.string().describe("One-line description of when to use the skill"),
        instructions: z.string().describe("The skill body in Markdown — what to do when it runs"),
      },
      async (args) => {
        const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
        const loc = safeSkillDir(this.cfg.skillsDir, args.name);
        if (!loc) return text("Invalid skill name.");
        if (existsSync(loc.file)) return text(`A skill named "${loc.slug}" already exists; not overwriting.`);
        const ok = await ui.onCreateSkill!(loc.slug, args.description.trim());
        if (!ok) return text("User declined; no skill was created.");
        mkdirSync(loc.dir, { recursive: true });
        writeFileSync(loc.file, skillDoc(loc.slug, args.description, args.instructions), "utf8");
        return text(`Created skill "${loc.slug}". The user can run it anytime by typing /${loc.slug} in the composer.`);
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  // Overwrite an EXISTING skill's SKILL.md. Mirror of createSkillTool but inverted: the skill must
  // already exist (create_skill handles new ones). Same slug/containment guard; write after approval.
  private editSkillTool(ui: AgentUI) {
    return tool(
      "edit_skill",
      "Overwrite an EXISTING skill's SKILL.md with new contents. First Read the " +
        "current SKILL.md, then pass the COMPLETE new description and instructions (this replaces the whole " +
        "file). Use ONLY when the user explicitly asks to change an existing skill. Fails if no such skill " +
        "exists — use create_skill for new ones.",
      {
        name: z.string().describe("Name of the existing skill (its directory slug)"),
        description: z.string().describe("The complete new one-line description"),
        instructions: z.string().describe("The complete new skill body in Markdown (replaces the old body)"),
      },
      async (args) => {
        const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
        const loc = safeSkillDir(this.cfg.skillsDir, args.name);
        if (!loc) return text("Invalid skill name.");
        if (!existsSync(loc.file)) return text(this.noSuchSkill(loc.slug));
        const ok = await ui.onEditSkill!(loc.slug, args.description.trim());
        if (!ok) return text("User declined; the skill was not changed.");
        writeFileSync(loc.file, skillDoc(loc.slug, args.description, args.instructions), "utf8");
        return text(`Updated skill "${loc.slug}".`);
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  // Delete an EXISTING skill directory. Same containment guard; removes only after approval.
  private deleteSkillTool(ui: AgentUI) {
    return tool(
      "delete_skill",
      "Delete an EXISTING skill (removes its folder and SKILL.md). Use ONLY when the user " +
        "explicitly asks to delete or remove a skill. The user approves before it is removed.",
      { name: z.string().describe("Name of the existing skill (its directory slug)") },
      async (args) => {
        const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
        const loc = safeSkillDir(this.cfg.skillsDir, args.name);
        if (!loc) return text("Invalid skill name.");
        if (!existsSync(loc.file)) return text(this.noSuchSkill(loc.slug));
        const desc = parseSkill(readFileSync(loc.file, "utf8")).description;
        const ok = await ui.onDeleteSkill!(loc.slug, desc);
        if (!ok) return text("User declined; the skill was not deleted.");
        rmSync(loc.dir, { recursive: true, force: true });
        return text(`Deleted skill "${loc.slug}".`);
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  // Replace the entire Refine style guide (or clear it with ""). The UI confirms + persists; this tool
  // only forwards the request. One primitive covers editing and deleting within the single text blob.
  private replaceStyleGuideTool(ui: AgentUI) {
    return tool(
      "replace_style_guide",
      "Replace the user's ENTIRE Refine style guide with new content (pass an empty string to clear it). " +
        "Use ONLY when the user explicitly asks to change, fix, or remove their formatting preferences; the " +
        "current guide is shown in your context. The user approves before it is saved.",
      { content: z.string().describe("The complete new style guide (empty string clears it entirely)") },
      async (args) => {
        const ok = await ui.onReplaceStyleGuide!(args.content);
        return {
          content: [{ type: "text" as const, text: ok ? "Style guide updated." : "User declined; style guide unchanged." }],
        };
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  // Shared not-found message for edit/delete: name the missing slug and list what does exist.
  private noSuchSkill(slug: string): string {
    const existing = this.listSkills().map((s) => s.slug);
    return `No skill named "${slug}" exists. Existing skills: ${existing.length ? existing.join(", ") : "(none)"}. Use create_skill to make a new one.`;
  }
}
