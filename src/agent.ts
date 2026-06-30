import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Codex, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { z } from "zod";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { extractText, stripFences, preserveEdges } from "./parse";
import { skillSlug, skillDoc, parseSkill, SkillInfo } from "./skill";
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
    "to edit other files. propose_note_edit is ONLY for the note's actual new content — never put a question, " +
    "clarification, or message to the user in it. If the request is ambiguous (e.g. you don't know which part " +
    "to change), do NOT call propose_note_edit: ask via ask_user or just reply in plain text. After the user " +
    "accepts, rejects, or steers a proposed edit, reply with a brief one-line confirmation of the outcome and " +
    "stop — NEVER say the user's message was empty or 'didn't come through' (the user is present; they just " +
    "acted on an edit). Be concise. " +
    "Your replies are shown to the user as rendered Markdown, so write Markdown directly — use headings, " +
    "lists, bold/italics, and inline code where they help. Do NOT wrap your whole reply in a code fence; " +
    "reserve fenced code blocks for actual code, or for when the user explicitly asks to see raw Markdown source." +
    "\n\nYou also have two tools for evolving how you work — but use them ONLY when the user EXPLICITLY asks " +
    "you to, never proactively or to be helpful: update_style_guide appends ONE concise formatting preference " +
    "to the user's Refine style guide (use it when they tell you how they like notes formatted and ask you to " +
    "remember it — it is appended, never overwriting); create_skill saves a reusable workflow as a skill file " +
    "(use it when they ask you to save or remember a workflow). The user approves each with a confirmation, so " +
    "only call them on a direct request like \"remember that…\" or \"save this as a skill\". A newly created skill " +
    "is immediately runnable by the user typing /<name> in the composer.",
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
  // The style guide is persisted by the UI; the skill file is written here only after approval.
  onUpdateStyleGuide?(preference: string): Promise<boolean>;
  onCreateSkill?(slug: string, summary: string): Promise<boolean>;
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
  constructor(private cfg: { cwd: string; claudePath?: string; codexPath?: string }) {}

  // Which providers have a resolved CLI. ponytail: best-effort detection from resolved
  // CLI paths; show both if neither is detectable so we never lock the user out.
  availableProviders(): AgentProvider[] {
    const out: AgentProvider[] = [];
    if (this.cfg.claudePath) out.push("claude");
    if (this.cfg.codexPath) out.push("codex");
    return out.length ? out : ["claude", "codex"];
  }

  // The skills authored in this vault (<cwd>/.claude/skills/<slug>/SKILL.md), surfaced in the widget's
  // "/" menu so the user can run them directly. Sync + cheap (a handful of small files).
  listSkills(): SkillInfo[] {
    const dir = path.join(this.cfg.cwd, ".claude", "skills");
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
    const result = await this.runCodex(prompt, {
      provider: "codex",
      model: o.model,
      thinking: o.thinking,
      allowWeb: false,
      abort: o.abort,
    }, hooks);
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
    // ponytail: any[] avoids the generic mismatch between SdkMcpToolDefinition<{question}> and SdkMcpToolDefinition<{new_content,summary}>
    const tools: any[] = [this.askUserTool(ui)];
    if (ui.onProposeEdit) tools.push(this.proposeEditTool(ui));
    if (ui.onUpdateStyleGuide) tools.push(this.updateStyleGuideTool(ui));
    if (ui.onCreateSkill) tools.push(this.createSkillTool(ui));
    const odin = createSdkMcpServer({ name: "odin", version: "1.0.0", tools });
    const builtins = builtinTools(o.allowWeb);
    const allowed = [...builtins, "mcp__odin__ask_user"];
    if (ui.onProposeEdit) allowed.push("mcp__odin__propose_note_edit");
    if (ui.onUpdateStyleGuide) allowed.push("mcp__odin__update_style_guide");
    if (ui.onCreateSkill) allowed.push("mcp__odin__create_skill");

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
        // Scope settings to the project so the user's GLOBAL Claude Code config/hooks don't bleed into
        // the Obsidian assistant. skills:[] disables the SDK's own skill auto-loading (which only found
        // global skills, not the vault's) — the user's authored skills are invoked directly via the
        // "/" menu (see widget.listSkills / invokeSkill) for immediate, reliable use.
        settingSources: ["project"],
        skills: [],
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

  // Author a Claude Code skill at <vault>/.claude/skills/<slug>/SKILL.md. Safety lives in code, not a
  // dialog: slug sanitization, path containment under the skills dir, and no-overwrite. The file is
  // only written after the user approves the inline confirmation (ui.onCreateSkill).
  private createSkillTool(ui: AgentUI) {
    return tool(
      "create_skill",
      "Author a reusable skill at .claude/skills/<name>/SKILL.md so it is available in the user's NEXT chat. " +
        "Use ONLY when the user explicitly asks you to save or remember a workflow. Does not overwrite an existing skill.",
      {
        name: z.string().describe("Short skill name; becomes the directory slug"),
        description: z.string().describe("One-line description of when to use the skill"),
        instructions: z.string().describe("The skill body in Markdown — what to do when it runs"),
      },
      async (args) => {
        const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
        const slug = skillSlug(args.name);
        if (!slug) return text("Invalid skill name.");
        const root = path.resolve(this.cfg.cwd, ".claude", "skills");
        const dir = path.join(root, slug);
        if (!path.resolve(dir).startsWith(root + path.sep)) return text("Refused: unsafe skill path.");
        const file = path.join(dir, "SKILL.md");
        if (existsSync(file)) return text(`A skill named "${slug}" already exists; not overwriting.`);
        const ok = await ui.onCreateSkill!(slug, args.description.trim());
        if (!ok) return text("User declined; no skill was created.");
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, skillDoc(slug, args.description, args.instructions), "utf8");
        return text(`Created skill "${slug}". The user can run it anytime by typing /${slug} in the composer.`);
      },
      { annotations: { readOnlyHint: false } },
    );
  }
}
