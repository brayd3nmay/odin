import { Menu, setTooltip, setIcon, MarkdownRenderer } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type OdinPlugin from "./main";
import { getRegion, applyRegion, Region, LineEditor } from "./edit";
import { showDiff, hideDiff } from "./editor-diff";
import { planDiff } from "./diffplan";
import { PROMPTS, StreamHooks, EditResult } from "./agent";
import { newThread, addMessage, ChatThread } from "./history";
import { MODELS, THINKING_LEVELS, FeatureConfig, ThinkingLevel } from "./settings";
import { SkillInfo } from "./skill";
import { CLAUDE_SPARK } from "./icons";

type Mode = "collapsed" | "card";

// Per-tool step metadata: an icon + plain-language label so the timeline reads clearly and each
// kind of work has its own glyph. Web work spins; everything else is static (see CSS .is-spin).
const STEPS: Record<string, { icon: string; label: string; spin?: boolean }> = {
  Read: { icon: "book-open", label: "Reading a note" },
  Glob: { icon: "search", label: "Searching your vault" },
  Grep: { icon: "search", label: "Searching your vault" },
  WebSearch: { icon: "globe", label: "Searching the web", spin: true },
  WebFetch: { icon: "globe", label: "Reading a web page", spin: true },
  // the chat agent's own self-editing tools, surfaced as timeline nodes:
  update_style_guide: { icon: "pencil", label: "Updating your style guide" },
  create_skill: { icon: "puzzle", label: "Creating a skill" },
};
// Strip the mcp__<server>__ prefix so in-process tools map to STEPS by bare name; only ask_user and
// propose_note_edit are hidden (they render their own inline UI, not a timeline node).
function stepInfo(name: string): { icon: string; label: string; spin?: boolean } | null {
  const bare = name.startsWith("mcp__") ? name.replace(/^mcp__[^_]+__/, "") : name;
  if (bare === "ask_user" || bare === "propose_note_edit") return null;
  return STEPS[bare] ?? { icon: "wrench", label: `Using ${bare}` };
}

// Slash commands typed in the composer. fix/refine/gaps mirror runQuickAction; help lists them.
// The menu pops above the input whenever the value is just "/" + word chars (see updateSlash).
const COMMANDS: { cmd: string; icon: string; label: string; desc: string }[] = [
  { cmd: "fix", icon: "list-checks", label: "Fix formatting", desc: "Tidy formatting — never changes your words" },
  { cmd: "refine", icon: "wand-2", label: "Refine", desc: "Restructure and polish the note" },
  { cmd: "gaps", icon: "search", label: "Find gaps", desc: "Quiz you on what's missing" },
  { cmd: "help", icon: "help-circle", label: "Help", desc: "List these commands" },
];

const PLACEHOLDER = "Ask anything, or / for commands…";

// A row in the "/" menu: a built-in command, or a user-authored skill (skill set). Skills are run by
// injecting their SKILL.md body into the chat agent (see invokeSkill).
type SlashEntry = { cmd: string; icon: string; label: string; desc: string; skill?: SkillInfo };

const html = (el: HTMLElement, svg: string) => { el.innerHTML = svg; };
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

// A live "thinking" region rendered as ONE vertical timeline that stays IN the chat (not hidden):
// reasoning and tool calls share a single ordered node list (a reasoning delta opens/extends a
// "Thinking" node with a breathing dot; a tool call closes it and appends a tool node that dims when
// done; the next reasoning delta opens a fresh node) — so the chat reads "Thinking → Read a note →
// Thinking …". Each Thinking node expands to its full reasoning on click; the live one is open. The
// head says "Thinking…" then "Thought for Ns" (always the brain glyph — no checkmarks).
type LiveNode = { el: HTMLElement; ic: HTMLElement; kind: "think" | "tool"; detail: HTMLElement | null; text: string };

class Thinking {
  el: HTMLElement;
  private head: HTMLElement;
  private headIc: HTMLElement;
  private headLabel: HTMLElement;
  private peek: HTMLElement;
  private list: HTMLElement;
  private live: LiveNode | null = null;
  private start = Date.now();
  private done = false;

  constructor(parent: HTMLElement, private scroll: () => void) {
    // Expanded by default: the timeline is visible inline. The head still toggles a whole-block collapse.
    this.el = parent.createDiv({ cls: "odin-think" });
    this.head = this.el.createDiv({ cls: "odin-think-head" });
    this.head.onclick = () => this.el.toggleClass("is-collapsed", !this.el.hasClass("is-collapsed"));
    setIcon(this.head.createSpan({ cls: "odin-chev" }), "chevron-right");
    this.headIc = this.head.createSpan();
    this.headLabel = this.head.createSpan({ cls: "odin-think-label" });
    this.peek = this.el.createDiv({ cls: "odin-think-peek" });
    this.list = this.el.createDiv({ cls: "odin-timeline" });
    this.setHead("Thinking…");
  }

  // Head label mirrors the current activity; the head container's is-live drives the label shimmer.
  // The head glyph stays the brain (the "thinking" mark) rather than swapping to per-tool icons.
  private setHead(label: string) {
    this.head.toggleClass("is-live", !this.done);
    this.headIc.className = "odin-think-ic" + (this.done ? "" : " is-live");
    setIcon(this.headIc, "brain");
    this.headLabel.setText(label);
  }

  // Close the current live node and append a fresh one. Think nodes carry an expandable detail (their
  // full reasoning); the live think node starts open, completed ones collapse to just their label.
  private openNode(kind: "think" | "tool", icon: string | null, label: string, spin = false): HTMLElement {
    this.markLastDone();
    const node = this.list.createDiv({ cls: "odin-tl-node is-live is-" + kind });
    const ic = node.createSpan({ cls: "odin-tl-ic" + (kind === "think" ? " odin-tl-dot" : "") + (spin ? " is-spin" : "") });
    if (icon) setIcon(ic, icon);
    const body = node.createDiv({ cls: "odin-tl-body" });
    const labelRow = body.createDiv({ cls: "odin-tl-label" });
    labelRow.createSpan({ text: label });
    let detail: HTMLElement | null = null;
    if (kind === "think") {
      node.addClass("is-open");
      setIcon(labelRow.createSpan({ cls: "odin-tl-chev" }), "chevron-right");
      labelRow.onclick = () => node.toggleClass("is-open", !node.hasClass("is-open"));
      detail = body.createDiv({ cls: "odin-tl-detail" });
    }
    this.live = { el: node, ic, kind, detail, text: "" };
    this.setHead(kind === "think" ? "Thinking…" : label);
    this.scroll();
    return body;
  }

  reasoning(delta: string) {
    if (!this.live || this.live.kind !== "think") this.openNode("think", null, "Thinking");
    const n = this.live!;
    n.text += delta;
    if (n.detail) { n.detail.setText(n.text); n.detail.scrollTop = n.detail.scrollHeight; }
    // collapsed-block head ticker mirrors the same reasoning tail
    this.peek.setText(n.text);
    this.peek.scrollTop = this.peek.scrollHeight;
    this.scroll();
  }

  tool(name: string) {
    const info = stepInfo(name);
    if (!info) return;
    this.openNode("tool", info.icon, info.label, info.spin);
  }

  // Finish the live node: stop its animation (a tool dims to muted; a thinking node collapses its
  // detail to just the label). No checkmarks.
  private markLastDone() {
    if (!this.live) return;
    this.live.el.removeClass("is-live");
    if (this.live.kind === "think") this.live.el.removeClass("is-open");
    this.live = null;
  }

  collapse() {
    if (this.done) return;
    this.done = true;
    this.markLastDone();
    const secs = ((Date.now() - this.start) / 1000).toFixed(1);
    this.setHead(`Thought for ${secs}s`);
    this.peek.empty();
  }
}

type Reply = { append: (d: string) => void; done: () => void };

// Orders a streaming run into blocks in the sequence they actually happen. Thinking/tools group into
// one Thinking block; text into one reply bubble; a new round (text after thinking, or anything after
// an ask) opens a fresh block below — so steps never hoist above the message they followed.
class Transcript {
  private think: Thinking | null = null;
  private reply: Reply | null = null;
  constructor(private mkThink: () => Thinking, private mkReply: () => Reply) {}

  private closeThink() { if (this.think) { this.think.collapse(); this.think = null; } }
  private closeReply() { if (this.reply) { this.reply.done(); this.reply = null; } }

  thinking(delta: string) { this.closeReply(); (this.think ??= this.mkThink()).reasoning(delta); }
  tool(name: string) { this.closeReply(); (this.think ??= this.mkThink()).tool(name); }
  text(delta: string) { this.closeThink(); (this.reply ??= this.mkReply()).append(delta); }
  // Close open blocks so the next thing (an ask box, an edit popup, more output) starts below them.
  break() { this.closeThink(); this.closeReply(); }
  finish(full: string) {
    this.closeThink();
    if (!this.reply && full.trim()) (this.reply = this.mkReply()).append(full);
    this.closeReply();
  }
}

export class FloatingWidget {
  private root: HTMLElement;
  private bubble: HTMLElement;
  private card: HTMLElement;
  private streamEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private field!: HTMLElement;
  private send!: HTMLElement;
  private escHint!: HTMLElement;
  private expandBtn!: HTMLElement;
  private editPop!: HTMLElement;
  private slashMenu!: HTMLElement;
  private modelSel!: HTMLElement;
  private thinkSel!: HTMLElement;
  private mode: Mode = "collapsed";
  private expanded = false;
  private historyOpen = false;
  private thread: ChatThread | null = null;
  private pendingAsk: ((answer: string) => void) | null = null;
  private pendingConfirm: ((ok: boolean) => void) | null = null;
  private aborters = new Set<AbortController>();
  private busy = false;
  // Auto-scroll follows new output only while the user is already at the bottom (see scroll()).
  private stick = true;
  // Slash-command menu state (open while slashItems is non-empty).
  private slashItems: { entry: SlashEntry; el: HTMLElement }[] = [];
  private slashSel = 0;
  // The vault's authored skills, refreshed from disk when the menu opens so a just-created skill shows.
  private skills: SkillInfo[] = [];

  // The currently-previewed edit (diff shown in the editor; controls in the panel).
  private pendingDiff: {
    view: EditorView;
    accept: () => void;
    reject: () => void;
    steer?: (instruction: string) => void; // absent for chat-tool edits (not re-runnable)
  } | null = null;

  constructor(private plugin: OdinPlugin) {
    this.root = document.body.createDiv({ cls: "odin-root" });
    // A real <button> so the single entry point is keyboard-focusable and announced.
    this.bubble = this.root.createEl("button", { cls: "odin-bubble" });
    setTooltip(this.bubble, "Open Claude");
    this.bubble.setAttr("aria-label", "Open Claude");
    html(this.bubble, CLAUDE_SPARK);
    this.bubble.onclick = () => this.open();
    this.card = this.root.createDiv({ cls: "odin-card", attr: { role: "dialog", "aria-label": "Claude chat" } });
    this.buildChrome();
    this.setMode("collapsed");
    this.maybeEmpty();
  }

  private buildChrome() {
    const header = this.card.createDiv({ cls: "odin-header" });
    const title = header.createDiv({ cls: "odin-title" });
    html(title.createSpan({ cls: "odin-title-spark" }), CLAUDE_SPARK);
    title.createSpan({ text: "Claude" });
    header.createDiv({ cls: "odin-spacer" });
    this.iconBtn(header, "plus", "New chat", () => this.newChat());
    const histBtn = this.iconBtn(header, "history", "History", () => this.toggleHistory());
    histBtn.addClass("odin-hist");
    header.createDiv({ cls: "odin-divider" });
    this.iconBtn(header, "minus", "Minimize", () => this.close());
    this.expandBtn = this.iconBtn(header, "maximize-2", "Expand", () => this.expand());

    this.streamEl = this.card.createDiv({ cls: "odin-stream" });
    // Track whether the user is parked at the bottom; if they scroll up to read (e.g. the
    // thinking), we stop auto-scrolling so streaming output doesn't yank them back down.
    this.streamEl.addEventListener("scroll", () => {
      const el = this.streamEl;
      this.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    });

    // composer zone. The edit-approval prompt sits between the stream and the input (in flow, not
    // floating over messages) so it never covers the conversation while a diff is being reviewed.
    const composer = this.card.createDiv({ cls: "odin-composer" });
    this.editPop = composer.createDiv({ cls: "odin-editpop" });

    const footer = composer.createDiv({ cls: "odin-footer" });
    this.field = footer.createDiv({ cls: "odin-field" });
    this.slashMenu = this.field.createDiv({ cls: "odin-slash" });
    this.input = this.field.createEl("textarea", {
      cls: "odin-input",
      attr: { placeholder: PLACEHOLDER, rows: "1" },
    });
    const bar = this.field.createDiv({ cls: "odin-inbar" });
    this.modelSel = this.ghostSelect(bar, (ev) =>
      this.pickerMenu(ev, MODELS, this.plugin.settings.chat.model, (id) => { this.plugin.settings.chat.model = id; }));
    this.thinkSel = this.ghostSelect(bar, (ev) =>
      this.pickerMenu(ev, THINKING_LEVELS, this.plugin.settings.chat.thinking, (id) => { this.plugin.settings.chat.thinking = id as ThinkingLevel; }));
    bar.createDiv({ cls: "odin-spacer" });
    this.escHint = bar.createSpan({ cls: "odin-esc-hint" });
    this.send = bar.createEl("button", { cls: "odin-send clickable-icon" });
    setIcon(this.send, "corner-down-left");
    setTooltip(this.send, "Send");
    this.send.onclick = () => (this.busy ? this.stop() : this.submit());
    this.refreshSelectors();

    this.input.onfocus = () => this.field.addClass("is-focus");
    this.input.onblur = () => this.field.removeClass("is-focus");
    this.input.oninput = () => this.updateSlash();
    this.input.onkeydown = (ev: KeyboardEvent) => this.onInputKey(ev);
  }

  private iconBtn(parent: HTMLElement, name: string, tip: string, onClick: () => void): HTMLElement {
    const b = parent.createEl("button", { cls: "odin-iconbtn clickable-icon" });
    setIcon(b, name);
    setTooltip(b, tip);
    b.onclick = onClick;
    return b;
  }

  private refreshSkills() {
    try { this.skills = this.plugin.agent.listSkills(); } catch { this.skills = []; }
  }

  // Built-in commands plus the vault's authored skills (built-ins win on a name collision).
  private slashEntries(): SlashEntry[] {
    const builtin = new Set(COMMANDS.map((c) => c.cmd));
    const skillRows: SlashEntry[] = this.skills
      .filter((s) => !builtin.has(s.slug))
      .map((s) => ({ cmd: s.slug, icon: "puzzle", label: s.name, desc: s.description || "Saved skill", skill: s }));
    return [...COMMANDS, ...skillRows];
  }

  // Rebuild the slash menu from the current input. Open only while the value is "/" + cmd chars (word
  // chars or hyphens, so skill slugs like /mermaid-diagram match), and never while steering an edit.
  private updateSlash() {
    if (this.pendingDiff) return this.hideSlash();
    const m = /^\/([\w-]*)$/.exec(this.input.value);
    if (!m) return this.hideSlash();
    this.refreshSkills();
    const q = m[1].toLowerCase();
    const matches = this.slashEntries().filter((c) => c.cmd.startsWith(q));
    if (!matches.length) return this.hideSlash();
    this.slashMenu.empty();
    this.slashItems = [];
    // No per-row icons: built-ins and user skills read as one uniform list of /name + description.
    matches.forEach((entry, i) => {
      const row = this.slashMenu.createDiv({ cls: "odin-slash-row" });
      row.createSpan({ cls: "odin-slash-cmd", text: "/" + entry.cmd });
      row.createSpan({ cls: "odin-slash-desc", text: entry.desc });
      row.onmouseenter = () => this.setSlashSel(i);
      row.onclick = () => this.chooseSlash(entry);
      this.slashItems.push({ entry, el: row });
    });
    this.setSlashSel(Math.min(this.slashSel, matches.length - 1));
    this.slashMenu.addClass("is-shown");
  }

  private setSlashSel(i: number) {
    this.slashSel = i < 0 ? 0 : i;
    this.slashItems.forEach((it, idx) => it.el.toggleClass("is-sel", idx === this.slashSel));
  }

  private hideSlash() {
    this.slashMenu.removeClass("is-shown");
    this.slashMenu.empty();
    this.slashItems = [];
    this.slashSel = 0;
  }

  private chooseSlash(entry: SlashEntry) {
    this.input.value = "";
    this.hideSlash();
    if (entry.skill) this.invokeSkill(entry.skill);
    else this.runCommand(entry.cmd);
  }

  // Run a user skill by handing its SKILL.md body to the chat agent against the open note. The user
  // bubble shows "/<slug>"; the agent receives the full instructions.
  private invokeSkill(skill: SkillInfo) {
    this.sendChat(this.skillPrompt(skill.name, skill.body), "/" + skill.slug);
  }
  private skillPrompt(name: string, body: string): string {
    return (
      `Run my saved "${name}" skill on the currently open note. Follow these instructions exactly:\n\n` +
      "----- SKILL -----\n" + body + "\n----- END SKILL -----"
    );
  }

  private runCommand(cmd: string) {
    // Echo the invocation so the user sees what they triggered — slash commands run note actions
    // (not chat messages), so without this nothing appears before the assistant starts working.
    this.open();
    this.addMsg("odin-user odin-cmd").setText("/" + cmd);
    if (cmd === "help") return this.showHelp();
    this.runQuickAction(cmd as "fix" | "refine" | "gaps");
  }

  private showHelp() {
    this.open();
    const box = this.addMsg("odin-help");
    box.createDiv({ cls: "odin-help-title", text: "Commands" });
    for (const c of COMMANDS) {
      const row = box.createDiv({ cls: "odin-help-row" });
      setIcon(row.createSpan({ cls: "odin-help-ic" }), c.icon);
      row.createSpan({ cls: "odin-help-cmd", text: "/" + c.cmd });
      row.createSpan({ cls: "odin-help-desc", text: c.desc });
    }
  }

  private ghostSelect(parent: HTMLElement, onClick: (ev: MouseEvent) => void): HTMLElement {
    const b = parent.createEl("button", { cls: "odin-ghostsel" });
    b.onclick = (ev) => onClick(ev);
    return b;
  }

  private refreshSelectors() {
    const cfg = this.plugin.settings.chat;
    const model = MODELS.find((m) => m.id === cfg.model)?.label ?? cfg.model;
    const think = THINKING_LEVELS.find((t) => t.id === cfg.thinking)?.label ?? cfg.thinking;
    this.modelSel.setText(model);
    setIcon(this.modelSel.createSpan({ cls: "odin-car" }), "chevron-down");
    this.thinkSel.setText(think);
    setIcon(this.thinkSel.createSpan({ cls: "odin-car" }), "chevron-down");
  }

  private pickerMenu(ev: MouseEvent, items: { id: string; label: string }[], current: string, choose: (id: string) => void) {
    const menu = new Menu();
    for (const it of items) {
      menu.addItem((i) =>
        i.setTitle(it.label).setChecked(current === it.id).onClick(async () => {
          choose(it.id);
          await this.plugin.saveSettings();
          this.refreshSelectors();
        }),
      );
    }
    menu.showAtMouseEvent(ev);
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.bubble.toggleClass("is-hidden", mode === "card");
    this.card.toggleClass("is-open", mode === "card");
  }
  open() { this.stick = true; this.setMode("card"); this.input?.focus(); }
  close() { this.pendingDiff?.reject(); this.setMode("collapsed"); }
  toggle() { this.mode === "card" ? this.close() : this.open(); }
  expand() {
    this.expanded = !this.expanded;
    this.card.toggleClass("is-expanded", this.expanded);
    setIcon(this.expandBtn, this.expanded ? "minimize-2" : "maximize-2");
    setTooltip(this.expandBtn, this.expanded ? "Shrink" : "Expand");
  }
  destroy() { this.cancelAll(); this.root.remove(); }

  private addMsg(cls: string, text?: string): HTMLElement {
    this.clearEmpty();
    const el = this.streamEl.createDiv({ cls: `odin-msg ${cls}` });
    if (text) el.setText(text);
    this.scroll();
    return el;
  }

  // First-run greeting: a centered spark + one-liner shown only while the stream is empty.
  private maybeEmpty() {
    if (this.streamEl.childElementCount) return;
    const e = this.streamEl.createDiv({ cls: "odin-empty" });
    html(e.createSpan({ cls: "odin-empty-spark" }), CLAUDE_SPARK);
    e.createDiv({ text: "Ask about your notes, or type / for commands." });
  }
  private clearEmpty() { this.streamEl.querySelector(".odin-empty")?.remove(); }
  private scroll() { if (this.stick) this.streamEl.scrollTop = this.streamEl.scrollHeight; }
  private showError(el: HTMLElement, e: unknown) {
    if ((e as any)?.name === "AbortError") { el.remove(); return; }
    el.setText("Error: " + (e instanceof Error ? e.message : String(e)));
    el.addClass("odin-error");
  }
  // The identical tail of every run's catch block: surface the error in a fresh status line.
  private fail(e: unknown) { this.showError(this.addMsg("odin-error"), e); }

  // A streaming assistant reply: Markdown is re-rendered live as deltas arrive, with a blinking caret
  // until done. Renders are coalesced (one at a time) and lightly throttled so a fast stream doesn't
  // thrash the renderer; the loop keeps going until the rendered text matches the latest received.
  private newReply(): Reply {
    const el = this.addMsg("odin-assistant is-streaming");
    let raw = "";
    let shown = "";
    let running = false;
    const pump = async () => {
      if (running) return;
      running = true;
      while (shown !== raw) {
        const snap = raw;
        await this.renderMd(el, snap);
        shown = snap;
        this.scroll();
        await sleep(90);
      }
      running = false;
    };
    return {
      append: (d) => { raw += d; void pump(); },
      done: () => { el.removeClass("is-streaming"); void pump(); },
    };
  }

  // Render Markdown off-DOM, then swap it in atomically so the bubble never flashes empty mid-stream.
  // ponytail: each render registers a MarkdownRenderChild on the plugin — fine for chat-length replies;
  // give replies their own Component if that ever accumulates.
  private async renderMd(el: HTMLElement, md: string): Promise<void> {
    const tmp = document.createElement("div");
    const src = this.plugin.activeMarkdownView()?.file?.path ?? "";
    await MarkdownRenderer.render(this.plugin.app, md, tmp, src, this.plugin);
    el.replaceChildren(...Array.from(tmp.childNodes));
  }

  private setBusy(on: boolean) {
    this.busy = on;
    if (on) this.stick = true; // a new run: follow its output until the user scrolls away
    this.send.toggleClass("is-stop", on);
    setIcon(this.send, on ? "square" : "corner-down-left");
    setTooltip(this.send, on ? "Stop" : "Send");
    this.escHint.setText(on ? "Esc to stop" : "");
  }

  private track(c: AbortController): AbortController { this.aborters.add(c); return c; }
  private stop() { this.cancelRuns(); }
  private cancelRuns() { for (const c of this.aborters) c.abort(); this.aborters.clear(); this.setBusy(false); }
  private cancelAll() { this.cancelRuns(); this.clearPending(); this.clearDiff(); }
  private clearPending() {
    if (this.pendingAsk) { const r = this.pendingAsk; this.pendingAsk = null; r(""); }
    if (this.pendingConfirm) { const r = this.pendingConfirm; this.pendingConfirm = null; r(false); }
  }

  private submit() {
    const v = this.input.value.trim();
    if (!v) return;
    this.input.value = "";
    // A pending edit: typing steers it. Transform edits route the steer to a fresh chat; chat-tool
    // edits feed it back to the awaiting agent, which revises and re-proposes (see presentEdit).
    if (this.pendingDiff) { this.pendingDiff.steer?.(v); return; }
    // Fallback for an exact "/cmd" typed past the menu (e.g. with a trailing space the menu dropped).
    const m = /^\/([\w-]+)$/.exec(v);
    if (m) {
      this.refreshSkills();
      const entry = this.slashEntries().find((e) => e.cmd === m[1]);
      if (entry) { this.hideSlash(); return entry.skill ? this.invokeSkill(entry.skill) : this.runCommand(entry.cmd); }
    }
    this.sendChat(v);
  }
  private onInputKey(ev: KeyboardEvent) {
    if (this.slashItems.length) {
      const n = this.slashItems.length;
      if (ev.key === "ArrowDown") { ev.preventDefault(); this.setSlashSel((this.slashSel + 1) % n); return; }
      if (ev.key === "ArrowUp") { ev.preventDefault(); this.setSlashSel((this.slashSel - 1 + n) % n); return; }
      if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); this.chooseSlash(this.slashItems[this.slashSel].entry); return; }
      if (ev.key === "Escape") { ev.preventDefault(); this.hideSlash(); return; }
    }
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && this.pendingDiff) {
      ev.preventDefault();
      this.pendingDiff.accept();
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); this.submit(); return; }
    if (ev.key === "Escape") {
      ev.preventDefault();
      if (this.pendingDiff) this.pendingDiff.reject();
      else if (this.busy) this.stop();
    }
  }

  async runQuickAction(kind: "fix" | "refine" | "gaps") {
    this.open();
    if (this.busy) return;
    if (kind === "gaps") return this.runGaps();
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("odin-error", "Open a note first."); return; }
    const editor = view.editor as unknown as LineEditor;
    const region = getRegion(editor);
    if (!region.text.trim()) { this.addMsg("odin-error", "Nothing to format."); return; }

    const cfg = kind === "fix" ? this.plugin.settings.fixFormatting : this.plugin.settings.refine;
    this.runTransform(view, editor, region, kind, cfg);
  }

  // One Fix/Refine pass over the region, then preview the result. Steering the preview goes through
  // the chat agent (steerPrompt → sendChat), not another toolless transform — the transform can only
  // emit note content, so it can't answer questions or use tools.
  private async runTransform(view: any, editor: LineEditor, region: Region, kind: "fix" | "refine", cfg: FeatureConfig) {
    this.setBusy(true);
    this.clearEmpty();
    const thinking = new Thinking(this.streamEl, () => this.scroll());
    const abort = this.track(new AbortController());
    try {
      const proposed = await this.plugin.agent.transform(this.basePromptFor(kind), region.text, {
        model: cfg.model, thinking: cfg.thinking, allowWeb: false, abort,
      }, { onThinking: (d) => thinking.reasoning(d) });
      thinking.collapse();
      this.setBusy(false);
      this.presentEdit(view, editor, region, proposed, (instr) =>
        this.sendChat(this.steerPrompt(proposed, instr), instr));
    } catch (e) {
      thinking.collapse();
      this.setBusy(false);
      this.fail(e);
    }
  }

  private async runGaps() {
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("odin-error", "Open a note first."); return; }
    const text = view.editor.getValue();
    if (!text.trim()) { this.addMsg("odin-error", "This note is empty."); return; }

    const cfg = this.plugin.settings.findGaps;
    this.setBusy(true);
    this.clearEmpty();
    const tx = this.newTranscript();
    const abort = this.track(new AbortController());
    try {
      const report = await this.plugin.agent.analysis(
        PROMPTS.findGaps,
        `Here is my note. Find gaps and quiz me.\n\n---\n${text}`,
        {
          onAskUser: (q) => { tx.break(); return this.askUser(q); },
          onTool: (n) => tx.tool(n),
          onThinking: (d) => tx.thinking(d),
          onText: (d) => tx.text(d),
        },
        { model: cfg.model, thinking: cfg.thinking, allowWeb: this.plugin.settings.allowWeb, abort },
      );
      tx.finish(report);
      this.setBusy(false);
    } catch (e) {
      tx.break();
      this.setBusy(false);
      this.fail(e);
    }
  }

  // `display` is what the user sees in their bubble; `text` is what the agent receives. They differ
  // when steering an edit: the bubble shows the bare instruction, the prompt carries the proposal too.
  private async sendChat(text: string, display: string = text) {
    // Never send an empty/whitespace message: the agent would receive only the open-note prefix and
    // (correctly) report "your message came through empty". submit() already guards, this backstops it.
    if (this.busy || !text.trim()) return;
    this.open();
    const thread = this.ensureThread();
    addMessage(thread, "user", display);
    this.addMsg("odin-user").setText(display);
    this.setBusy(true);
    const tx = this.newTranscript();
    const cfg = this.plugin.settings.chat;
    const abort = this.track(new AbortController());

    const ui = {
      onAskUser: (q: string) => { tx.break(); return this.askUser(q); },
      onProposeEdit: (content: string, summary: string) => { tx.break(); return this.proposeEdit(content, summary); },
      // Self-editing tools: each is gated behind an inline Approve/Decline. The style guide is
      // append-only (persisted here, where the plugin lives); the skill file is written by the
      // agent only after this resolves true.
      onUpdateStyleGuide: async (pref: string) => {
        tx.break();
        const ok = await this.confirmInline("Add this to your formatting style guide?", pref);
        if (ok) {
          const cur = this.plugin.settings.styleGuide.trim();
          this.plugin.settings.styleGuide = cur ? `${cur}\n${pref}` : pref;
          await this.plugin.saveSettings();
        }
        return ok;
      },
      onCreateSkill: (slug: string, summary: string) => {
        tx.break();
        return this.confirmInline(`Create a new skill “${slug}”?`, summary);
      },
      onTool: (n: string) => tx.tool(n),
      onThinking: (d: string) => tx.thinking(d),
      onText: (d: string) => tx.text(d),
    };
    // Tell the agent which note is open so it edits/reads the right file instead of guessing.
    const openPath = this.plugin.activeMarkdownView()?.file?.path;
    const prompt = openPath ? `[Currently open note: ${openPath}]\n\n${text}` : text;
    try {
      const { text: full, sessionId } = await this.plugin.agent.chat(prompt, thread.sessionId, ui, {
        model: cfg.model, thinking: cfg.thinking, allowWeb: this.plugin.settings.allowWeb, abort,
      });
      thread.sessionId = sessionId;
      tx.finish(full);
      addMessage(thread, "assistant", full);
      this.setBusy(false);
      await this.plugin.saveSettings();
    } catch (e) {
      tx.break();
      this.setBusy(false);
      this.fail(e);
      await this.plugin.saveSettings();
    }
  }

  private newTranscript(): Transcript {
    return new Transcript(() => new Thinking(this.streamEl, () => this.scroll()), () => this.newReply());
  }

  // Show a diff for review. Always steerable: accept (⌘↵), reject (Esc), or just type a message + Enter
  // to revise. `onSteerNewChat` is set for toolless transform edits (steering starts a fresh chat);
  // for chat-tool edits it's absent, so steering resolves with feedback the awaiting agent re-proposes from.
  private presentEdit(view: any, editor: LineEditor, region: Region, proposed: string, onSteerNewChat?: (instruction: string) => void): Promise<EditResult> {
    // No-op edit: nothing to add or delete → don't force a diff, just say so.
    const plan = planDiff(region.text, proposed);
    if (!plan.dels.length && !plan.adds.length) {
      this.statusLine("info", "No changes needed.");
      return Promise.resolve({ accepted: false });
    }
    return new Promise((resolve) => {
      const cm = (view.editor as any).cm as EditorView;
      this.clearDiff();
      showDiff(cm, region.fromLine, region.text, proposed);

      // Approval prompt sits in flow just above the composer (see .odin-editpop) so it stays put
      // while the diff is reviewed, without covering the conversation above it.
      const pop = this.editPop;
      pop.empty();
      const head = pop.createDiv({ cls: "odin-editpop-head" });
      setIcon(head.createSpan({ cls: "odin-editpop-ic" }), "file-text");
      head.createSpan({ cls: "odin-editpop-title", text: "Apply this edit to your note?" });
      pop.createDiv({ cls: "odin-editpop-sub", text: "Accept, reject, or type to steer — changes are highlighted in your note." });
      const acts = pop.createDiv({ cls: "odin-editacts" });
      const accept = acts.createEl("button", { cls: "odin-pb is-accept" });
      setIcon(accept.createSpan({ cls: "odin-pb-ic" }), "check");
      accept.createSpan({ text: "Accept" });
      accept.createSpan({ cls: "odin-kbd", text: "⌘↵" });
      const reject = acts.createEl("button", { cls: "odin-pb" });
      reject.createSpan({ text: "Reject" });
      reject.createSpan({ cls: "odin-kbd", text: "Esc" });
      pop.addClass("is-shown");

      this.enterSteer();
      const finish = (r: EditResult) => {
        this.exitSteer();
        this.clearDiff(); // also hides the popup
        if (r.accepted) this.statusLine("hammer", "Applied to your note.");
        else if (!r.feedback) this.statusLine("x", "Discarded.");
        resolve(r);
      };
      this.pendingDiff = {
        view: cm,
        // Clear the preview decorations before mutating the doc so nothing maps through the change.
        accept: () => { this.clearDiff(); applyRegion(editor, region, proposed); finish({ accepted: true }); },
        reject: () => finish({ accepted: false }),
        steer: (instr) => {
          this.clearDiff();
          this.exitSteer();
          if (onSteerNewChat) {
            onSteerNewChat(instr); // transform: starts a fresh chat (which echoes its own user bubble)
            resolve({ accepted: false });
          } else {
            this.addMsg("odin-user").setText(instr); // chat: echo the steer; agent re-proposes from feedback
            resolve({ accepted: false, feedback: instr });
          }
        },
      };
      accept.onclick = () => this.pendingDiff?.accept();
      reject.onclick = () => this.pendingDiff?.reject();
    });
  }

  // A status line with a leading icon (e.g. hammer for an applied edit), in muted text — no green checks.
  private statusLine(icon: string, text: string): HTMLElement {
    const el = this.addMsg("odin-statline");
    setIcon(el.createSpan({ cls: "odin-statline-ic" }), icon);
    el.createSpan({ text });
    return el;
  }

  private enterSteer() {
    this.field.addClass("is-steer");
    this.input.setAttribute("placeholder", "Steer this edit…");
    this.input.focus(); // so ⌘↵ accept / Esc reject / steer typing are live immediately
  }
  private exitSteer() {
    this.field.removeClass("is-steer");
    this.input.setAttribute("placeholder", PLACEHOLDER);
  }
  private clearDiff() {
    if (this.pendingDiff) { try { hideDiff(this.pendingDiff.view); } catch { /* view gone */ } }
    this.pendingDiff = null;
    this.editPop?.empty();
    this.editPop?.removeClass("is-shown");
  }

  // Chat's edit tool: diff the whole open note against the proposed content. No onSteerNewChat, so the
  // user can type to steer and the agent revises in place.
  private proposeEdit(content: string, _summary: string): Promise<EditResult> {
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("odin-error", "No open note to edit."); return Promise.resolve({ accepted: false }); }
    const editor = view.editor as unknown as LineEditor;
    const region: Region = { fromLine: 0, toLine: editor.lineCount() - 1, text: view.editor.getValue() };
    return this.presentEdit(view, editor, region, content);
  }

  askUser(question: string): Promise<string> {
    return new Promise((resolve) => {
      const box = this.addMsg("odin-ask");
      box.createDiv({ cls: "odin-ask-q", text: question });
      const input = box.createEl("input", { cls: "odin-ask-input", attr: { placeholder: "Type your answer…" } });
      const hint = box.createDiv({ cls: "odin-ask-hint", text: "Enter to send" });
      input.focus();
      this.pendingAsk = resolve;
      input.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === "Enter" && input.value.trim()) {
          const answer = input.value.trim();
          // Keep the question on screen; swap the input out for the answer so the exchange reads as Q → A.
          input.remove();
          hint.remove();
          box.addClass("is-answered");
          box.createDiv({ cls: "odin-ask-a", text: answer });
          this.pendingAsk = null;
          resolve(answer);
        }
      };
    });
  }

  // Inline Approve/Decline for the agent's self-editing tools (style guide / new skill). Resolves
  // false if the run is cancelled while waiting (see clearPending).
  private confirmInline(title: string, body: string): Promise<boolean> {
    return new Promise((resolve) => {
      const box = this.addMsg("odin-confirm");
      box.createDiv({ cls: "odin-confirm-title", text: title });
      if (body) box.createDiv({ cls: "odin-confirm-body", text: body });
      const acts = box.createDiv({ cls: "odin-editacts" });
      const accept = acts.createEl("button", { cls: "odin-pb is-accept" });
      setIcon(accept.createSpan({ cls: "odin-pb-ic" }), "check");
      accept.createSpan({ text: "Approve" });
      const reject = acts.createEl("button", { cls: "odin-pb", text: "Decline" });
      this.pendingConfirm = resolve;
      const done = (ok: boolean) => {
        if (this.pendingConfirm !== resolve) return; // already resolved/cancelled
        this.pendingConfirm = null;
        acts.remove();
        box.addClass("is-answered");
        box.createDiv({ cls: "odin-confirm-result", text: ok ? "✓ Approved" : "Declined" });
        resolve(ok);
      };
      accept.onclick = () => done(true);
      reject.onclick = () => done(false);
    });
  }

  private ensureThread() {
    if (!this.thread) {
      this.thread = newThread(crypto.randomUUID());
      this.plugin.threads.unshift(this.thread);
    }
    return this.thread;
  }
  // Switching thread / starting a new chat: abort any in-flight run first so its Transcript can't
  // keep appending into detached nodes or save onto the wrong thread, then wipe and re-greet.
  private resetStream() { this.cancelRuns(); this.stick = true; this.clearPending(); this.clearDiff(); this.streamEl.empty(); this.maybeEmpty(); }

  private basePromptFor(kind: "fix" | "refine"): string {
    return kind === "fix" ? PROMPTS.fixFormatting : PROMPTS.refine(this.plugin.settings.styleGuide);
  }

  // Wraps a steering instruction with the just-proposed text as context. The transform that produced
  // the preview is sessionless, so the chat agent needs the proposal handed to it to discuss or revise.
  private steerPrompt(proposed: string, instruction: string): string {
    return (
      "You proposed this revised version of the open note, shown to me as a diff to review:\n\n" +
      "```\n" + proposed + "\n```\n\n" +
      instruction +
      "\n\n(If I'm asking you to change the note, use propose_note_edit to revise it; otherwise just reply.)"
    );
  }

  // Start a fresh chat, discarding the on-screen conversation but keeping prior threads in history.
  private newChat() { this.historyOpen = false; this.thread = null; this.resetStream(); }

  private toggleHistory() {
    if (this.historyOpen) {
      // Close back out to where we were: the current thread, or an empty composer.
      this.historyOpen = false;
      this.thread ? this.loadThread(this.thread) : this.resetStream();
    } else {
      this.showHistory();
    }
  }

  private showHistory() {
    this.historyOpen = true;
    this.resetStream();
    const list = this.addMsg("odin-history");
    for (const t of this.plugin.threads) {
      const row = list.createDiv({ cls: "odin-hist-row" });
      row.createSpan({ cls: "odin-hist-title", text: t.title }).onclick = () => this.loadThread(t);
      const del = this.iconBtn(row, "trash-2", "Delete", async () => {
        this.plugin.threads = this.plugin.threads.filter((x) => x.id !== t.id);
        if (this.thread?.id === t.id) this.thread = null;
        await this.plugin.saveSettings();
        this.showHistory();
      });
      del.addClass("odin-hist-del");
    }
  }
  private loadThread(t: ChatThread) {
    this.historyOpen = false;
    this.thread = t;
    this.resetStream();
    for (const m of t.messages) {
      if (m.role === "user") this.addMsg("odin-user").setText(m.text);
      else this.renderMd(this.addMsg("odin-assistant"), m.text);
    }
  }
}
