import { Menu, setTooltip, setIcon, MarkdownRenderer } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type OdinPlugin from "./main";
import { getRegion, applyRegion, Region, LineEditor } from "./edit";
import { showDiff, hideDiff } from "./editor-diff";
import { planDiff } from "./diffplan";
import { PROMPTS, StreamHooks } from "./agent";
import { newThread, addMessage, ChatThread } from "./history";
import { MODELS, THINKING_LEVELS, FeatureConfig, ThinkingLevel } from "./settings";
import { CLAUDE_SPARK } from "./icons";

type Mode = "collapsed" | "card";

// Per-tool step metadata: an icon + plain-language label so the thinking steps read clearly and
// each kind of work has its own glyph. Searches spin; everything else pulses (see CSS .is-spin).
const STEPS: Record<string, { icon: string; label: string; spin?: boolean }> = {
  Read: { icon: "book-open", label: "Reading a note" },
  Glob: { icon: "search", label: "Searching your vault" },
  Grep: { icon: "search", label: "Searching your vault" },
  WebSearch: { icon: "globe", label: "Searching the web", spin: true },
  WebFetch: { icon: "globe", label: "Reading a web page", spin: true },
};
function stepInfo(name: string): { icon: string; label: string; spin?: boolean } | null {
  if (name.startsWith("mcp__")) return null; // internal (ask_user / propose_note_edit) — not a step
  return STEPS[name] ?? { icon: "wrench", label: `Using ${name}` };
}

// Slash commands typed in the composer. fix/refine/gaps mirror runQuickAction; help lists them.
// The menu pops above the input whenever the value is just "/" + word chars (see updateSlash).
const COMMANDS: { cmd: string; icon: string; label: string; desc: string }[] = [
  { cmd: "fix", icon: "list-checks", label: "Fix formatting", desc: "Tidy formatting — never changes your words" },
  { cmd: "refine", icon: "wand-2", label: "Refine", desc: "Restructure and polish the note" },
  { cmd: "gaps", icon: "search", label: "Find gaps", desc: "Quiz you on what's missing" },
  { cmd: "help", icon: "help-circle", label: "Help", desc: "List these commands" },
];

const html = (el: HTMLElement, svg: string) => { el.innerHTML = svg; };
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

// A live "thinking" region. The head (animated icon + label) and a one-line "peek" ticker stay
// visible while collapsed so the user always has something to watch; expanding reveals the full
// step list and reasoning. Collapses to "Thought for Ns" when done.
class Thinking {
  el: HTMLElement;
  private head: HTMLElement;
  private headIc: HTMLElement;
  private headLabel: HTMLElement;
  private peek: HTMLElement;
  private steps: HTMLElement;
  private reason: HTMLElement;
  private lastStep: HTMLElement | null = null;
  private reasonText = "";
  private start = Date.now();
  private done = false;

  constructor(parent: HTMLElement, private scroll: () => void) {
    this.el = parent.createDiv({ cls: "odin-think is-collapsed" });
    this.head = this.el.createDiv({ cls: "odin-think-head" });
    this.head.onclick = () => this.el.toggleClass("is-collapsed", !this.el.hasClass("is-collapsed"));
    setIcon(this.head.createSpan({ cls: "odin-chev" }), "chevron-right");
    this.headIc = this.head.createSpan();
    this.headLabel = this.head.createSpan({ cls: "odin-think-label" });
    this.peek = this.el.createDiv({ cls: "odin-think-peek" });
    this.steps = this.el.createDiv({ cls: "odin-steps" });
    this.reason = this.el.createDiv({ cls: "odin-think-reason" });
    this.setHead("sparkles", "Thinking…");
  }

  // Head icon + label mirror the current activity so a collapsed panel still tells the story.
  private setHead(icon: string, label: string, spin = false) {
    this.headIc.className = "odin-think-ic" + (this.done ? "" : " is-live") + (spin ? " is-spin" : "");
    setIcon(this.headIc, icon);
    this.headLabel.setText(label);
  }

  tool(name: string) {
    const info = stepInfo(name);
    if (!info) return;
    this.markLastDone();
    this.setHead(info.icon, info.label, info.spin);
    const step = this.steps.createDiv({ cls: "odin-step is-live" });
    const ic = step.createSpan({ cls: "odin-step-ic" + (info.spin ? " is-spin" : "") });
    setIcon(ic, info.icon);
    step.createSpan({ cls: "odin-step-tx", text: info.label });
    this.lastStep = step;
    this.scroll();
  }

  reasoning(delta: string) {
    this.reasonText += delta;
    this.reason.addClass("is-shown");
    this.reason.setText(this.reasonText);
    // peek shows the tail of the reasoning; pin it to the bottom so the newest lines stay in view.
    this.peek.setText(this.reasonText);
    this.peek.scrollTop = this.peek.scrollHeight;
    this.scroll();
  }

  private markLastDone() {
    if (this.lastStep) {
      this.lastStep.removeClass("is-live");
      const ic = this.lastStep.querySelector(".odin-step-ic") as HTMLElement;
      ic.className = "odin-step-ic";
      setIcon(ic, "check");
    }
  }

  collapse() {
    if (this.done) return;
    this.done = true;
    this.markLastDone();
    const secs = ((Date.now() - this.start) / 1000).toFixed(1);
    this.setHead("sparkles", `Thought for ${secs}s`);
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
  private editPop!: HTMLElement;
  private slashMenu!: HTMLElement;
  private modelSel!: HTMLElement;
  private thinkSel!: HTMLElement;
  private mode: Mode = "collapsed";
  private expanded = false;
  private historyOpen = false;
  private thread: ChatThread | null = null;
  private pendingAsk: ((answer: string) => void) | null = null;
  private aborters = new Set<AbortController>();
  private busy = false;
  // Auto-scroll follows new output only while the user is already at the bottom (see scroll()).
  private stick = true;
  // Slash-command menu state (open while slashItems is non-empty).
  private slashItems: { cmd: string; el: HTMLElement }[] = [];
  private slashSel = 0;

  // The currently-previewed edit (diff shown in the editor; controls in the panel).
  private pendingDiff: {
    view: EditorView;
    accept: () => void;
    reject: () => void;
    steer?: (instruction: string) => void; // absent for chat-tool edits (not re-runnable)
  } | null = null;

  constructor(private plugin: OdinPlugin) {
    this.root = document.body.createDiv({ cls: "odin-root" });
    this.bubble = this.root.createDiv({ cls: "odin-bubble" });
    html(this.bubble, CLAUDE_SPARK);
    this.bubble.onclick = () => this.open();
    this.card = this.root.createDiv({ cls: "odin-card" });
    this.buildChrome();
    this.setMode("collapsed");
  }

  private buildChrome() {
    const header = this.card.createDiv({ cls: "odin-header" });
    const title = header.createDiv({ cls: "odin-title" });
    html(title.createSpan({ cls: "odin-title-spark" }), CLAUDE_SPARK);
    title.createSpan({ text: "Claude" });
    header.createDiv({ cls: "odin-spacer" });
    this.iconBtn(header, "plus", "New chat", () => this.newChat());
    const histBtn = this.iconBtn(header, "clock", "History", () => this.toggleHistory());
    histBtn.addClass("odin-hist");
    header.createDiv({ cls: "odin-divider" });
    this.iconBtn(header, "minus", "Minimize", () => this.close());
    this.iconBtn(header, "maximize-2", "Expand", () => this.expand());

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
      attr: { placeholder: "Ask anything, or / for commands…", rows: "1" },
    });
    const bar = this.field.createDiv({ cls: "odin-inbar" });
    this.modelSel = this.ghostSelect(bar, (ev) =>
      this.pickerMenu(ev, MODELS, this.plugin.settings.chat.model, (id) => { this.plugin.settings.chat.model = id; }));
    this.thinkSel = this.ghostSelect(bar, (ev) =>
      this.pickerMenu(ev, THINKING_LEVELS, this.plugin.settings.chat.thinking, (id) => { this.plugin.settings.chat.thinking = id as ThinkingLevel; }));
    bar.createDiv({ cls: "odin-spacer" });
    bar.createSpan({ cls: "odin-esc-hint" });
    this.send = bar.createEl("button", { cls: "odin-send clickable-icon" });
    setIcon(this.send, "send");
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

  // Rebuild the slash menu from the current input. Open only while the value is "/" + word chars
  // (so a real message that happens to contain "/" never triggers it), and never while steering an edit.
  private updateSlash() {
    if (this.pendingDiff) return this.hideSlash();
    const m = /^\/(\w*)$/.exec(this.input.value);
    const matches = m ? COMMANDS.filter((c) => c.cmd.startsWith(m[1].toLowerCase())) : [];
    if (!matches.length) return this.hideSlash();
    this.slashMenu.empty();
    this.slashItems = [];
    matches.forEach((c, i) => {
      const row = this.slashMenu.createDiv({ cls: "odin-slash-row" });
      setIcon(row.createSpan({ cls: "odin-slash-ic" }), c.icon);
      row.createSpan({ cls: "odin-slash-cmd", text: "/" + c.cmd });
      row.createSpan({ cls: "odin-slash-desc", text: c.desc });
      row.onmouseenter = () => this.setSlashSel(i);
      row.onclick = () => this.chooseSlash(c.cmd);
      this.slashItems.push({ cmd: c.cmd, el: row });
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

  private chooseSlash(cmd: string) {
    this.input.value = "";
    this.hideSlash();
    this.runCommand(cmd);
  }

  private runCommand(cmd: string) {
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
  expand() { this.expanded = !this.expanded; this.card.toggleClass("is-expanded", this.expanded); }
  destroy() { this.cancelAll(); this.root.remove(); }

  private addMsg(cls: string, text?: string): HTMLElement {
    const el = this.streamEl.createDiv({ cls: `odin-msg ${cls}` });
    if (text) el.setText(text);
    this.scroll();
    return el;
  }
  private scroll() { if (this.stick) this.streamEl.scrollTop = this.streamEl.scrollHeight; }
  private showError(el: HTMLElement, e: unknown) {
    if ((e as any)?.name === "AbortError") { el.remove(); return; }
    el.setText("Error: " + (e instanceof Error ? e.message : String(e)));
    el.addClass("odin-error");
  }

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
    this.card.toggleClass("is-busy", on);
    this.send.toggleClass("is-stop", on);
    setIcon(this.send, on ? "x" : "send");
    setTooltip(this.send, on ? "Stop" : "Send");
    (this.card.querySelector(".odin-esc-hint") as HTMLElement)?.setText(on ? "Esc to stop" : "");
  }

  private track(c: AbortController): AbortController { this.aborters.add(c); return c; }
  private stop() { this.cancelRuns(); }
  private cancelRuns() { for (const c of this.aborters) c.abort(); this.aborters.clear(); this.setBusy(false); }
  private cancelAll() { this.cancelRuns(); this.clearPending(); this.clearDiff(); }
  private clearPending() { if (this.pendingAsk) { const r = this.pendingAsk; this.pendingAsk = null; r(""); } }

  private submit() {
    const v = this.input.value.trim();
    if (!v) return;
    this.input.value = "";
    // A pending edit: hand the message to the chat agent (steer), which has a text channel, tools,
    // and propose_note_edit — so it can answer or revise. Never the toolless transform. sendChat
    // echoes the user bubble itself, so don't double-echo here.
    if (this.pendingDiff) { this.pendingDiff.steer?.(v); return; }
    // Fallback for an exact "/cmd" typed past the menu (e.g. with a trailing space the menu dropped).
    const m = /^\/(\w+)$/.exec(v);
    if (m && COMMANDS.some((c) => c.cmd === m[1])) { this.hideSlash(); return this.runCommand(m[1]); }
    this.sendChat(v);
  }
  private onInputKey(ev: KeyboardEvent) {
    if (this.slashItems.length) {
      const n = this.slashItems.length;
      if (ev.key === "ArrowDown") { ev.preventDefault(); this.setSlashSel((this.slashSel + 1) % n); return; }
      if (ev.key === "ArrowUp") { ev.preventDefault(); this.setSlashSel((this.slashSel - 1 + n) % n); return; }
      if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); this.chooseSlash(this.slashItems[this.slashSel].cmd); return; }
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
      this.showError(this.addMsg("odin-status"), e);
    }
  }

  private async runGaps() {
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("odin-error", "Open a note first."); return; }
    const text = view.editor.getValue();
    if (!text.trim()) { this.addMsg("odin-error", "This note is empty."); return; }

    const cfg = this.plugin.settings.findGaps;
    this.setBusy(true);
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
      this.showError(this.addMsg("odin-status"), e);
    }
  }

  // `display` is what the user sees in their bubble; `text` is what the agent receives. They differ
  // when steering an edit: the bubble shows the bare instruction, the prompt carries the proposal too.
  private async sendChat(text: string, display: string = text) {
    if (this.busy) return;
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
      this.showError(this.addMsg("odin-status"), e);
      await this.plugin.saveSettings();
    }
  }

  private newTranscript(): Transcript {
    return new Transcript(() => new Thinking(this.streamEl, () => this.scroll()), () => this.newReply());
  }

  private presentEdit(view: any, editor: LineEditor, region: Region, proposed: string, steer?: (instruction: string) => void): Promise<boolean> {
    // No-op edit: nothing to add or delete → don't force a diff, just say so.
    const plan = planDiff(region.text, proposed);
    if (!plan.dels.length && !plan.adds.length) {
      this.addMsg("odin-status-ok", "No changes needed.");
      return Promise.resolve(false);
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
      pop.createDiv({ cls: "odin-editpop-sub", text: "Changes are highlighted in your note." });
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
      const finish = (applied: boolean) => {
        this.exitSteer();
        this.clearDiff(); // also hides the popup
        this.addMsg(applied ? "odin-status-ok" : "odin-status")
          .setText(applied ? "✓ Applied to your note." : "Discarded.");
        resolve(applied);
      };
      this.pendingDiff = {
        view: cm,
        // Clear the preview decorations before mutating the doc so nothing maps through the change.
        accept: () => { this.clearDiff(); applyRegion(editor, region, proposed); finish(true); },
        reject: () => finish(false),
        steer: steer ? (instr) => { this.clearDiff(); steer(instr); } : undefined,
      };
      accept.onclick = () => this.pendingDiff?.accept();
      reject.onclick = () => this.pendingDiff?.reject();
    });
  }

  private enterSteer() {
    this.field.addClass("is-steer");
    this.input.setAttribute("placeholder", "Steer this edit…");
    this.input.focus(); // so ⌘↵ accept / Esc reject / steer typing are live immediately
  }
  private exitSteer() {
    this.field.removeClass("is-steer");
    this.input.setAttribute("placeholder", "Ask anything…");
  }
  private clearDiff() {
    if (this.pendingDiff) { try { hideDiff(this.pendingDiff.view); } catch { /* view gone */ } }
    this.pendingDiff = null;
    this.editPop?.empty();
    this.editPop?.removeClass("is-shown");
  }

  // Chat's edit tool: diff the whole open note against the proposed content.
  private proposeEdit(content: string, _summary: string): Promise<boolean> {
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("odin-error", "No open note to edit."); return Promise.resolve(false); }
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

  private ensureThread() {
    if (!this.thread) {
      this.thread = newThread(crypto.randomUUID());
      this.plugin.threads.unshift(this.thread);
    }
    return this.thread;
  }
  private resetStream() { this.stick = true; this.clearPending(); this.clearDiff(); this.streamEl.empty(); }

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
      const del = this.iconBtn(row, "x", "Delete", async () => {
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
