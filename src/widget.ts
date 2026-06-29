import { setIcon } from "obsidian";
import type BuddyPlugin from "./main";
import { getTarget, applyTarget } from "./edit";
import type { Target, EditorLike } from "./edit";
import { diffLines } from "./diff";
import { PROMPTS } from "./agent";
import { newThread, addMessage, ChatThread } from "./history";
import { MODELS } from "./settings";

// Anthropic glyph as an inline SVG path (themed via currentColor).
const ANTHROPIC_SVG =
  `<svg viewBox="0 0 46 32" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">` +
  `<path d="M32.7 0H26l11.9 32h6.8L32.7 0ZM13.3 0 1.4 32h6.9l2.4-6.6h12.4l2.4 6.6h6.9L20.5 0h-7.2Zm-.4 19.6 4-11 4 11h-8Z"/></svg>`;

type Mode = "collapsed" | "card";

export class FloatingWidget {
  private root: HTMLElement;
  private bubble: HTMLElement;
  private card: HTMLElement;
  private streamEl!: HTMLElement;
  private mode: Mode = "collapsed";
  private expanded = false;
  private thread: ChatThread | null = null;
  private pendingPropose: ((accepted: boolean) => void) | null = null;

  constructor(private plugin: BuddyPlugin) {
    this.root = document.body.createDiv({ cls: "buddy-root" });

    this.bubble = this.root.createDiv({ cls: "buddy-bubble" });
    this.bubble.innerHTML = ANTHROPIC_SVG;
    this.bubble.onclick = () => this.open();

    this.card = this.root.createDiv({ cls: "buddy-card" });
    this.buildCardChrome();
    this.setMode("collapsed");
  }

  private buildCardChrome() {
    const header = this.card.createDiv({ cls: "buddy-header" });
    const title = header.createDiv({ cls: "buddy-title" });
    title.innerHTML = ANTHROPIC_SVG;
    title.createSpan({ text: "Claude" });

    const sel = header.createDiv({ cls: "buddy-selectors" });
    const modelSel = sel.createEl("select", { cls: "buddy-select" });
    for (const m of MODELS) modelSel.createEl("option", { text: m.label, value: m.id });
    modelSel.value = this.plugin.settings.chat.model;
    modelSel.onchange = async () => { this.plugin.settings.chat.model = modelSel.value; await this.plugin.saveSettings(); };

    const thinkSel = sel.createEl("select", { cls: "buddy-select" });
    for (const [v, label] of [["off", "No thinking"], ["normal", "Think"], ["high", "Think hard"]]) {
      thinkSel.createEl("option", { text: label, value: v });
    }
    thinkSel.value = this.plugin.settings.chat.thinking;
    thinkSel.onchange = async () => {
      this.plugin.settings.chat.thinking = thinkSel.value as any;
      await this.plugin.saveSettings();
    };

    const controls = header.createDiv({ cls: "buddy-controls" });
    const min = controls.createSpan({ cls: "buddy-ctl" });
    setIcon(min, "minus");
    min.onclick = () => this.minimize();
    const exp = controls.createSpan({ cls: "buddy-ctl" });
    setIcon(exp, "maximize-2");
    exp.onclick = () => this.expand();
    const close = controls.createSpan({ cls: "buddy-ctl" });
    setIcon(close, "x");
    close.onclick = () => this.close();

    const chips = this.card.createDiv({ cls: "buddy-chips" });
    const chip = (label: string, kind: "fix" | "refine" | "gaps") => {
      const c = chips.createDiv({ cls: "buddy-chip", text: label });
      c.onclick = () => this.runQuickAction(kind);
    };
    chip("Fix Formatting", "fix");
    chip("Refine", "refine");
    chip("Find Gaps", "gaps");

    this.streamEl = this.card.createDiv({ cls: "buddy-stream" });

    const footer = this.card.createDiv({ cls: "buddy-footer" });
    const histBtn = footer.createEl("button", { cls: "buddy-hist-btn" });
    setIcon(histBtn, "history");
    histBtn.onclick = () => this.showHistory();
    const input = footer.createEl("textarea", { cls: "buddy-input", attr: { placeholder: "Ask anything…", rows: "1" } });
    const send = footer.createEl("button", { cls: "buddy-send mod-cta" });
    setIcon(send, "arrow-up");
    const submit = () => { const v = input.value.trim(); if (v) { input.value = ""; this.sendChat(v); } };
    send.onclick = submit;
    input.onkeydown = (ev: KeyboardEvent) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submit(); } };
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.bubble.toggleClass("is-hidden", mode === "card");
    this.card.toggleClass("is-open", mode === "card");
  }

  open() { this.setMode("card"); }
  close() { this.setMode("collapsed"); }
  minimize() { this.setMode("collapsed"); }
  toggle() { this.mode === "card" ? this.close() : this.open(); }
  expand() {
    this.expanded = !this.expanded;
    this.card.toggleClass("is-expanded", this.expanded);
  }
  destroy() { this.root.remove(); }

  private addMsg(cls: string, text?: string): HTMLElement {
    const el = this.streamEl.createDiv({ cls: `buddy-msg ${cls}` });
    if (text) el.setText(text);
    this.streamEl.scrollTop = this.streamEl.scrollHeight;
    return el;
  }

  private featureCfg(kind: "fix" | "refine" | "gaps") {
    const s = this.plugin.settings;
    return kind === "fix" ? s.fixFormatting : kind === "refine" ? s.refine : s.findGaps;
  }

  async runQuickAction(kind: "fix" | "refine" | "gaps") {
    this.open();
    if (kind === "gaps") return this.runGaps();
    const tkind = kind as "fix" | "refine"; // narrowed: gaps handled above
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("buddy-error", "Open a note first."); return; }
    const editor = view.editor;
    const target = getTarget(editor);
    if (!target.text.trim()) { this.addMsg("buddy-error", "Nothing to format."); return; }

    const cfg = this.featureCfg(tkind);
    const prompt = tkind === "fix"
      ? PROMPTS.fixFormatting
      : PROMPTS.refine(this.plugin.settings.styleGuide);

    const status = this.addMsg("buddy-status", tkind === "fix" ? "Fixing formatting…" : "Refining…");
    const abort = new AbortController();
    try {
      const proposed = await this.plugin.agent.transform(prompt, target.text, {
        model: cfg.model, thinking: cfg.thinking, allowWeb: false, abort,
      });
      status.remove();
      this.renderDiff(
        target.text, proposed,
        () => applyTarget(editor, target, proposed),
        tkind, cfg, target, editor,
      );
    } catch (e) {
      status.setText("Error: " + (e instanceof Error ? e.message : String(e)));
      status.addClass("buddy-error");
    }
  }

  private async runGaps() {
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("buddy-error", "Open a note first."); return; }
    const text = view.editor.getValue();
    if (!text.trim()) { this.addMsg("buddy-error", "This note is empty."); return; }

    const cfg = this.plugin.settings.findGaps;
    const status = this.addMsg("buddy-status", "Looking for gaps…");
    const abort = new AbortController();
    try {
      const report = await this.plugin.agent.analysis(
        PROMPTS.findGaps,
        `Here is my note. Find gaps and quiz me.\n\n---\n${text}`,
        { onAskUser: (q) => this.askUser(q), onProgress: (t) => status.setText(t) },
        { model: cfg.model, thinking: cfg.thinking, allowWeb: this.plugin.settings.allowWeb, abort },
      );
      status.remove();
      this.addMsg("buddy-report").setText(report);
    } catch (e) {
      status.setText("Error: " + (e instanceof Error ? e.message : String(e)));
      status.addClass("buddy-error");
    }
  }

  // Renders a question with an input; resolves when the user answers. Used as the ask_user handler.
  askUser(question: string): Promise<string> {
    return new Promise((resolve) => {
      const box = this.addMsg("buddy-ask");
      box.createDiv({ cls: "buddy-ask-q", text: question });
      const input = box.createEl("input", { cls: "buddy-ask-input", attr: { placeholder: "Your answer…" } });
      input.focus();
      input.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === "Enter" && input.value.trim()) {
          const answer = input.value.trim();
          box.empty();
          box.setText(`You: ${answer}`);
          resolve(answer);
        }
      };
    });
  }

  private renderDiff(
    original: string, proposed: string,
    onAccept: () => void,
    kind: "fix" | "refine",
    cfg: { model: string; thinking: import("./settings").ThinkingLevel },
    target: Target,
    editor: EditorLike,
  ) {
    const wrap = this.addMsg("buddy-diff");
    const ops = diffLines(original, proposed);
    const pre = wrap.createEl("pre", { cls: "buddy-diffbody" });
    for (const op of ops) {
      const line = pre.createDiv({ cls: `buddy-dl buddy-dl-${op.type}` });
      line.setText((op.type === "add" ? "+ " : op.type === "del" ? "- " : "  ") + op.text);
    }
    const actions = wrap.createDiv({ cls: "buddy-diff-actions" });
    const accept = actions.createEl("button", { text: "Accept", cls: "mod-cta" });
    const reject = actions.createEl("button", { text: "Reject" });
    const steerInput = actions.createEl("input", { cls: "buddy-steer", attr: { placeholder: "Steer (e.g. also bold key terms)…" } });

    accept.onclick = () => { onAccept(); wrap.empty(); wrap.setText("✓ Applied."); };
    reject.onclick = () => { wrap.empty(); wrap.setText("Discarded."); };
    steerInput.onkeydown = async (ev: KeyboardEvent) => {
      if (ev.key !== "Enter" || !steerInput.value.trim()) return;
      const instruction = steerInput.value.trim();
      wrap.remove();
      const status = this.addMsg("buddy-status", "Updating…");
      const abort = new AbortController();
      const basePrompt = kind === "fix" ? PROMPTS.fixFormatting : PROMPTS.refine(this.plugin.settings.styleGuide);
      const followPrompt = `${basePrompt}\n\nThe user reviewed your previous result and asks: "${instruction}". ` +
        `Apply that to the text below (which is the ORIGINAL note, not your previous output).`;
      try {
        const next = await this.plugin.agent.transform(followPrompt, original, {
          model: cfg.model, thinking: cfg.thinking, allowWeb: false, abort,
        });
        status.remove();
        this.renderDiff(original, next, () => applyTarget(editor, target, next), kind, cfg, target, editor);
      } catch (e) {
        status.setText("Error: " + (e instanceof Error ? e.message : String(e)));
      }
    };
  }

  private ensureThread() {
    if (!this.thread) {
      this.thread = newThread(crypto.randomUUID(), Date.now());
      this.plugin.threads.unshift(this.thread);
    }
    return this.thread;
  }

  private async sendChat(text: string) {
    this.open();
    const thread = this.ensureThread();
    addMessage(thread, "user", text);
    this.addMsg("buddy-user").setText(text);
    const status = this.addMsg("buddy-status", "Thinking…");
    const cfg = this.plugin.settings.chat;
    const abort = new AbortController();

    const ui = {
      onAskUser: (q: string) => this.askUser(q),
      onProposeEdit: (content: string, summary: string) => this.proposeEdit(content, summary),
      onProgress: (t: string) => status.setText(t),
    };
    try {
      const { text: reply, sessionId } = await this.plugin.agent.chat(text, thread.sessionId, ui, {
        model: cfg.model, thinking: cfg.thinking, allowWeb: this.plugin.settings.allowWeb, abort,
      });
      thread.sessionId = sessionId;
      status.remove();
      addMessage(thread, "assistant", reply);
      this.addMsg("buddy-assistant").setText(reply);
      await this.plugin.saveThreads();
    } catch (e) {
      status.setText("Error: " + (e instanceof Error ? e.message : String(e)));
      status.addClass("buddy-error");
      await this.plugin.saveThreads();
    }
  }

  private resetStream() {
    if (this.pendingPropose) {
      const r = this.pendingPropose;
      this.pendingPropose = null;
      r(false);
    }
    this.streamEl.empty();
  }

  // Chat's only way to edit: diff the active note's current content against the proposal.
  private proposeEdit(content: string, _summary: string): Promise<boolean> {
    return new Promise((resolve) => {
      const view = this.plugin.activeMarkdownView();
      if (!view) { this.addMsg("buddy-error", "No open note to edit."); resolve(false); return; }
      this.pendingPropose = resolve;
      const editor = view.editor;
      const original = editor.getValue();
      const wrap = this.addMsg("buddy-diff");
      for (const op of diffLines(original, content)) {
        wrap.createEl("pre", { cls: `buddy-dl buddy-dl-${op.type}` })
          .setText((op.type === "add" ? "+ " : op.type === "del" ? "- " : "  ") + op.text);
      }
      const actions = wrap.createDiv({ cls: "buddy-diff-actions" });
      const accept = actions.createEl("button", { text: "Accept", cls: "mod-cta" });
      const reject = actions.createEl("button", { text: "Reject" });
      accept.onclick = () => { this.pendingPropose = null; applyTarget(editor, { text: original, isSelection: false }, content); wrap.setText("✓ Applied."); resolve(true); };
      reject.onclick = () => { this.pendingPropose = null; wrap.setText("Rejected."); resolve(false); };
    });
  }

  private showHistory() {
    this.resetStream();
    const list = this.addMsg("buddy-history");
    const nw = list.createEl("button", { text: "+ New chat", cls: "mod-cta" });
    nw.onclick = () => { this.thread = null; this.resetStream(); };
    for (const t of this.plugin.threads) {
      const row = list.createDiv({ cls: "buddy-hist-row" });
      const open = row.createSpan({ cls: "buddy-hist-title", text: t.title });
      open.onclick = () => this.loadThread(t);
      const del = row.createSpan({ cls: "buddy-ctl" });
      setIcon(del, "trash");
      del.onclick = async () => {
        this.plugin.threads = this.plugin.threads.filter((x) => x.id !== t.id);
        if (this.thread?.id === t.id) this.thread = null;
        await this.plugin.saveThreads();
        this.showHistory();
      };
    }
  }

  private loadThread(t: ChatThread) {
    this.thread = t;
    this.resetStream();
    for (const m of t.messages) {
      this.addMsg(m.role === "user" ? "buddy-user" : "buddy-assistant").setText(m.text);
    }
  }

  focusChat() { this.open(); }
}
