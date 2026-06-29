import { setIcon } from "obsidian";
import type BuddyPlugin from "./main";
import { getTarget, applyTarget } from "./edit";
import type { Target, EditorLike } from "./edit";
import { diffLines } from "./diff";
import { PROMPTS } from "./agent";
import { newThread, addMessage, ChatThread } from "./history";
import { MODELS } from "./settings";

// Official Claude "spark" mark. Uses currentColor (not the brand orange) so it greys to
// match Obsidian's other icons — muted by default, accent on hover via the widget CSS.
const CLAUDE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 257" ` +
  `preserveAspectRatio="xMidYMid" fill="currentColor">` +
  `<path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"/></svg>`;

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
  private pendingAsk: ((answer: string) => void) | null = null;
  private aborters = new Set<AbortController>();
  private busy = false;

  constructor(private plugin: BuddyPlugin) {
    this.root = document.body.createDiv({ cls: "buddy-root" });

    this.bubble = this.root.createDiv({ cls: "buddy-bubble" });
    this.bubble.innerHTML = CLAUDE_SVG;
    this.bubble.onclick = () => this.open();

    this.card = this.root.createDiv({ cls: "buddy-card" });
    this.buildCardChrome();
    this.setMode("collapsed");
  }

  private buildCardChrome() {
    const header = this.card.createDiv({ cls: "buddy-header" });
    const title = header.createDiv({ cls: "buddy-title" });
    title.innerHTML = CLAUDE_SVG;
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

    this.streamEl = this.card.createDiv({ cls: "buddy-stream" });

    // Quick-action bar sits directly above the input row.
    const chips = this.card.createDiv({ cls: "buddy-chips" });
    const chip = (label: string, kind: "fix" | "refine" | "gaps") => {
      const c = chips.createDiv({ cls: "buddy-chip", text: label });
      c.onclick = () => this.runQuickAction(kind);
    };
    chip("Fix Formatting", "fix");
    chip("Refine", "refine");
    chip("Find Gaps", "gaps");

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
  destroy() { this.cancelAll(); this.root.remove(); }

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
    const abort = this.track(new AbortController());
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
    const abort = this.track(new AbortController());
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
      this.pendingAsk = resolve;
      input.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === "Enter" && input.value.trim()) {
          const answer = input.value.trim();
          box.empty();
          box.setText(`You: ${answer}`);
          this.pendingAsk = null;
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
      const abort = this.track(new AbortController());
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
    if (this.busy) return;
    this.busy = true;
    try {
      this.open();
      const thread = this.ensureThread();
      addMessage(thread, "user", text);
      this.addMsg("buddy-user").setText(text);
      const status = this.addMsg("buddy-status", "Thinking…");
      const cfg = this.plugin.settings.chat;
      const abort = this.track(new AbortController());

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
    } finally {
      this.busy = false;
    }
  }

  private track(c: AbortController): AbortController {
    this.aborters.add(c);
    return c;
  }

  private cancelAll() {
    for (const c of this.aborters) c.abort();
    this.aborters.clear();
    if (this.pendingPropose) { const r = this.pendingPropose; this.pendingPropose = null; r(false); }
    if (this.pendingAsk) { const r = this.pendingAsk; this.pendingAsk = null; r(""); }
    // ponytail: completed controllers stay in aborters until cancelAll clears them — aborting settled controllers is a harmless no-op
  }

  private resetStream() {
    if (this.pendingPropose) { const r = this.pendingPropose; this.pendingPropose = null; r(false); }
    if (this.pendingAsk) { const r = this.pendingAsk; this.pendingAsk = null; r(""); }
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
