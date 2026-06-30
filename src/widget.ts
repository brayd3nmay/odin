import { Menu, setTooltip } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type BuddyPlugin from "./main";
import { getRegion, applyRegion, Region, LineEditor } from "./edit";
import { showDiff, hideDiff } from "./editor-diff";
import { planDiff } from "./diffplan";
import { PROMPTS, StreamHooks } from "./agent";
import { newThread, addMessage, ChatThread } from "./history";
import { MODELS, THINKING_LEVELS, FeatureConfig } from "./settings";
import { CLAUDE_SPARK, icon } from "./icons";

type Mode = "collapsed" | "card";

// Friendly labels for the read-only tools so the thinking steps read in plain language.
const TOOL_LABELS: Record<string, string> = {
  Read: "Reading a note",
  Glob: "Searching your vault",
  Grep: "Searching your vault",
  WebSearch: "Searching the web",
  WebFetch: "Reading a web page",
};
function toolLabel(name: string): string | null {
  if (name.startsWith("mcp__")) return null; // internal (ask_user / propose_note_edit) — not a step
  return TOOL_LABELS[name] ?? `Using ${name}`;
}

const html = (el: HTMLElement, svg: string) => { el.innerHTML = svg; };

// A live "thinking" region: spinner + streamed tool steps + reasoning, collapsing to "Thought for Ns".
class Thinking {
  el: HTMLElement;
  private head: HTMLElement;
  private steps: HTMLElement;
  private reason: HTMLElement;
  private lastStep: HTMLElement | null = null;
  private start = Date.now();
  private done = false;

  constructor(parent: HTMLElement, scroll: () => void) {
    // Collapsed by default: the head is a one-line toggle; the steps + reasoning stay hidden until expanded.
    this.el = parent.createDiv({ cls: "buddy-think is-collapsed" });
    this.head = this.el.createDiv({ cls: "buddy-think-head" });
    this.head.onclick = () => this.el.toggleClass("is-collapsed", !this.el.hasClass("is-collapsed"));
    this.steps = this.el.createDiv({ cls: "buddy-steps" });
    this.reason = this.el.createDiv({ cls: "buddy-think-reason" });
    this.scroll = scroll;
    this.renderHead();
  }
  private scroll: () => void;

  // Live: chevron + spinner + "Thinking…". Done: chevron + "Thought for Ns".
  private renderHead() {
    this.head.empty();
    this.head.createSpan({ cls: "buddy-chev", text: "▾" });
    if (this.done) {
      const secs = ((Date.now() - this.start) / 1000).toFixed(1);
      this.head.createSpan({ text: `Thought for ${secs}s` });
    } else {
      this.head.createSpan({ cls: "buddy-spinner" });
      this.head.createSpan({ cls: "buddy-think-label", text: "Thinking…" });
    }
  }

  tool(name: string) {
    const label = toolLabel(name);
    if (!label) return;
    this.markLastDone();
    const step = this.steps.createDiv({ cls: "buddy-step is-live" });
    html(step.createSpan({ cls: "buddy-step-ic" }), `<span class="buddy-spinner buddy-spinner-sm"></span>`);
    step.createSpan({ cls: "buddy-step-tx", text: label });
    this.lastStep = step;
    this.scroll();
  }

  reasoning(delta: string) {
    this.reason.addClass("is-shown");
    this.reason.setText(this.reason.getText() + delta);
    this.scroll();
  }

  private markLastDone() {
    if (this.lastStep) {
      this.lastStep.removeClass("is-live");
      html(this.lastStep.querySelector(".buddy-step-ic") as HTMLElement, icon("tick-02"));
    }
  }

  collapse() {
    if (this.done) return;
    this.done = true;
    this.markLastDone();
    this.renderHead();
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
  private modelSel!: HTMLElement;
  private thinkSel!: HTMLElement;
  private mode: Mode = "collapsed";
  private expanded = false;
  private thread: ChatThread | null = null;
  private pendingAsk: ((answer: string) => void) | null = null;
  private aborters = new Set<AbortController>();
  private busy = false;

  // The currently-previewed edit (diff shown in the editor; controls in the panel).
  private pendingDiff: {
    view: EditorView;
    accept: () => void;
    reject: () => void;
    steer: (instruction: string) => void;
  } | null = null;

  constructor(private plugin: BuddyPlugin) {
    this.root = document.body.createDiv({ cls: "buddy-root" });
    this.bubble = this.root.createDiv({ cls: "buddy-bubble" });
    html(this.bubble, CLAUDE_SPARK);
    this.bubble.onclick = () => this.open();
    this.card = this.root.createDiv({ cls: "buddy-card" });
    this.buildChrome();
    this.setMode("collapsed");
  }

  private buildChrome() {
    // header: title · history · window controls
    const header = this.card.createDiv({ cls: "buddy-header" });
    const title = header.createDiv({ cls: "buddy-title" });
    html(title.createSpan({ cls: "buddy-title-spark" }), CLAUDE_SPARK);
    title.createSpan({ text: "Claude" });
    header.createDiv({ cls: "buddy-spacer" });
    const histBtn = this.iconBtn(header, "clock-01", "History", () => this.showHistory());
    histBtn.addClass("buddy-hist");
    header.createDiv({ cls: "buddy-divider" });
    this.iconBtn(header, "minus-sign", "Minimize", () => this.close());
    this.iconBtn(header, "arrow-expand-01", "Expand", () => this.expand());
    this.iconBtn(header, "cancel-01", "Close", () => this.close());

    this.streamEl = this.card.createDiv({ cls: "buddy-stream" });

    // quick actions: big icons, left aligned, own hover color
    const actions = this.card.createDiv({ cls: "buddy-actions" });
    this.quickAction(actions, "fix", "text-check", "Fix formatting");
    this.quickAction(actions, "refine", "magic-wand-02", "Refine");
    this.quickAction(actions, "gaps", "search-01", "Find gaps");

    // footer: input row + (model · thinking) on the bottom
    const footer = this.card.createDiv({ cls: "buddy-footer" });
    const inputRow = footer.createDiv({ cls: "buddy-inputrow" });
    this.field = inputRow.createDiv({ cls: "buddy-field" });
    this.input = this.field.createEl("textarea", {
      cls: "buddy-input",
      attr: { placeholder: "Ask anything…", rows: "1" },
    });
    this.send = inputRow.createEl("button", { cls: "buddy-send" });
    html(this.send, icon("arrow-up-01"));
    this.send.onclick = () => (this.busy ? this.stop() : this.submit());

    const botRow = footer.createDiv({ cls: "buddy-botrow" });
    this.modelSel = this.ghostSelect(botRow, (ev) => this.modelMenu(ev));
    this.thinkSel = this.ghostSelect(botRow, (ev) => this.thinkMenu(ev));
    botRow.createDiv({ cls: "buddy-spacer" });
    botRow.createSpan({ cls: "buddy-esc-hint" });
    this.refreshSelectors();

    this.input.onfocus = () => this.field.addClass("is-focus");
    this.input.onblur = () => this.field.removeClass("is-focus");
    this.input.onkeydown = (ev: KeyboardEvent) => this.onInputKey(ev);
  }

  private iconBtn(parent: HTMLElement, name: Parameters<typeof icon>[0], tip: string, onClick: () => void): HTMLElement {
    const b = parent.createEl("button", { cls: "buddy-iconbtn" });
    html(b, icon(name));
    setTooltip(b, tip);
    b.onclick = onClick;
    return b;
  }

  private quickAction(parent: HTMLElement, kind: "fix" | "refine" | "gaps", name: Parameters<typeof icon>[0], label: string) {
    const b = parent.createEl("button", { cls: `buddy-qa buddy-qa-${kind}` });
    html(b.createSpan({ cls: "buddy-qa-ic" }), icon(name));
    b.createSpan({ text: label });
    b.onclick = () => this.runQuickAction(kind);
  }

  private ghostSelect(parent: HTMLElement, onClick: (ev: MouseEvent) => void): HTMLElement {
    const b = parent.createEl("button", { cls: "buddy-ghostsel" });
    b.onclick = (ev) => onClick(ev);
    return b;
  }

  private refreshSelectors() {
    const cfg = this.plugin.settings.chat;
    const model = MODELS.find((m) => m.id === cfg.model)?.label ?? cfg.model;
    const think = THINKING_LEVELS.find((t) => t.id === cfg.thinking)?.label ?? cfg.thinking;
    this.modelSel.setText(model);
    this.modelSel.createSpan({ cls: "buddy-car", text: "▾" });
    this.thinkSel.setText(think);
    this.thinkSel.createSpan({ cls: "buddy-car", text: "▾" });
  }

  private modelMenu(ev: MouseEvent) {
    const menu = new Menu();
    for (const m of MODELS) {
      menu.addItem((i) =>
        i.setTitle(m.label).setChecked(this.plugin.settings.chat.model === m.id).onClick(async () => {
          this.plugin.settings.chat.model = m.id;
          await this.plugin.saveSettings();
          this.refreshSelectors();
        }),
      );
    }
    menu.showAtMouseEvent(ev);
  }

  private thinkMenu(ev: MouseEvent) {
    const menu = new Menu();
    for (const t of THINKING_LEVELS) {
      menu.addItem((i) =>
        i.setTitle(t.label).setChecked(this.plugin.settings.chat.thinking === t.id).onClick(async () => {
          this.plugin.settings.chat.thinking = t.id;
          await this.plugin.saveSettings();
          this.refreshSelectors();
        }),
      );
    }
    menu.showAtMouseEvent(ev);
  }

  // ---- modes ----
  private setMode(mode: Mode) {
    this.mode = mode;
    this.bubble.toggleClass("is-hidden", mode === "card");
    this.card.toggleClass("is-open", mode === "card");
  }
  open() { this.setMode("card"); this.input?.focus(); }
  close() { this.pendingDiff?.reject(); this.setMode("collapsed"); }
  toggle() { this.mode === "card" ? this.close() : this.open(); }
  expand() { this.expanded = !this.expanded; this.card.toggleClass("is-expanded", this.expanded); }
  destroy() { this.cancelAll(); this.root.remove(); }

  // ---- stream rendering helpers ----
  private addMsg(cls: string, text?: string): HTMLElement {
    const el = this.streamEl.createDiv({ cls: `buddy-msg ${cls}` });
    if (text) el.setText(text);
    this.scroll();
    return el;
  }
  private scroll() { this.streamEl.scrollTop = this.streamEl.scrollHeight; }
  private showError(el: HTMLElement, e: unknown) {
    if ((e as any)?.name === "AbortError") { el.remove(); return; }
    el.setText("Error: " + (e instanceof Error ? e.message : String(e)));
    el.addClass("buddy-error");
  }

  // A streaming assistant reply: deltas append with a blinking caret until done.
  private newReply(): { append: (d: string) => void; done: () => void } {
    const el = this.addMsg("buddy-assistant is-streaming");
    return {
      append: (d) => { el.setText(el.getText() + d); this.scroll(); },
      done: () => el.removeClass("is-streaming"),
    };
  }

  private setBusy(on: boolean) {
    this.busy = on;
    this.card.toggleClass("is-busy", on);
    this.send.toggleClass("is-stop", on);
    html(this.send, icon(on ? "stop" : "arrow-up-01"));
    (this.card.querySelector(".buddy-esc-hint") as HTMLElement)?.setText(on ? "Esc to stop" : "");
  }

  private track(c: AbortController): AbortController { this.aborters.add(c); return c; }
  private stop() { this.cancelRuns(); }
  private cancelRuns() { for (const c of this.aborters) c.abort(); this.aborters.clear(); this.setBusy(false); }
  private cancelAll() { this.cancelRuns(); this.clearPending(); this.clearDiff(); }
  private clearPending() { if (this.pendingAsk) { const r = this.pendingAsk; this.pendingAsk = null; r(""); } }

  // ---- input / keys ----
  private submit() {
    const v = this.input.value.trim();
    if (!v) return;
    this.input.value = "";
    if (this.pendingDiff) { this.pendingDiff.steer(v); return; }
    this.sendChat(v);
  }
  private onInputKey(ev: KeyboardEvent) {
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

  // ---- quick actions ----
  async runQuickAction(kind: "fix" | "refine" | "gaps") {
    this.open();
    if (this.busy) return;
    if (kind === "gaps") return this.runGaps();
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("buddy-error", "Open a note first."); return; }
    const editor = view.editor as unknown as LineEditor;
    const region = getRegion(editor);
    if (!region.text.trim()) { this.addMsg("buddy-error", "Nothing to format."); return; }

    const cfg = kind === "fix" ? this.plugin.settings.fixFormatting : this.plugin.settings.refine;
    this.setBusy(true);
    const thinking = new Thinking(this.streamEl, () => this.scroll());
    const abort = this.track(new AbortController());
    try {
      const proposed = await this.plugin.agent.transform(this.basePromptFor(kind), region.text, {
        model: cfg.model, thinking: cfg.thinking, allowWeb: false, abort,
      }, { onThinking: (d) => thinking.reasoning(d) });
      thinking.collapse();
      this.setBusy(false);
      this.presentEdit(view, editor, region, proposed, (instruction) =>
        this.steerTransform(view, editor, region, proposed, kind, cfg, instruction));
    } catch (e) {
      thinking.collapse();
      this.setBusy(false);
      this.showError(this.addMsg("buddy-status"), e);
    }
  }

  private async steerTransform(view: any, editor: LineEditor, region: Region, prev: string, kind: "fix" | "refine", cfg: FeatureConfig, instruction: string) {
    this.setBusy(true);
    const thinking = new Thinking(this.streamEl, () => this.scroll());
    const abort = this.track(new AbortController());
    const followPrompt = `${this.basePromptFor(kind)}\n\nThe user reviewed your previous result and asks: "${instruction}". ` +
      `Apply that to the text below (which is the ORIGINAL, not your previous output).`;
    try {
      const next = await this.plugin.agent.transform(followPrompt, region.text, {
        model: cfg.model, thinking: cfg.thinking, allowWeb: false, abort,
      }, { onThinking: (d) => thinking.reasoning(d) });
      thinking.collapse();
      this.setBusy(false);
      this.presentEdit(view, editor, region, next, (instr) =>
        this.steerTransform(view, editor, region, next, kind, cfg, instr));
    } catch (e) {
      thinking.collapse();
      this.setBusy(false);
      this.showError(this.addMsg("buddy-status"), e);
    }
  }

  private async runGaps() {
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("buddy-error", "Open a note first."); return; }
    const text = view.editor.getValue();
    if (!text.trim()) { this.addMsg("buddy-error", "This note is empty."); return; }

    const cfg = this.plugin.settings.findGaps;
    this.setBusy(true);
    const thinking = new Thinking(this.streamEl, () => this.scroll());
    const reply = this.lazyReply(() => thinking.collapse());
    const abort = this.track(new AbortController());
    try {
      const report = await this.plugin.agent.analysis(
        PROMPTS.findGaps,
        `Here is my note. Find gaps and quiz me.\n\n---\n${text}`,
        {
          onAskUser: (q) => this.askUser(q),
          onTool: (n) => thinking.tool(n),
          onThinking: (d) => thinking.reasoning(d),
          onText: (d) => reply.append(d),
        },
        { model: cfg.model, thinking: cfg.thinking, allowWeb: this.plugin.settings.allowWeb, abort },
      );
      thinking.collapse();
      reply.finish(report);
      this.setBusy(false);
    } catch (e) {
      thinking.collapse();
      this.setBusy(false);
      this.showError(this.addMsg("buddy-status"), e);
    }
  }

  // ---- chat ----
  private async sendChat(text: string) {
    if (this.busy) return;
    this.open();
    const thread = this.ensureThread();
    addMessage(thread, "user", text);
    this.addMsg("buddy-user").setText(text);
    this.setBusy(true);
    const thinking = new Thinking(this.streamEl, () => this.scroll());
    const reply = this.lazyReply(() => thinking.collapse());
    const cfg = this.plugin.settings.chat;
    const abort = this.track(new AbortController());

    const ui = {
      onAskUser: (q: string) => this.askUser(q),
      onProposeEdit: (content: string, summary: string) => this.proposeEdit(content, summary),
      onTool: (n: string) => thinking.tool(n),
      onThinking: (d: string) => thinking.reasoning(d),
      onText: (d: string) => reply.append(d),
    };
    try {
      const { text: full, sessionId } = await this.plugin.agent.chat(text, thread.sessionId, ui, {
        model: cfg.model, thinking: cfg.thinking, allowWeb: this.plugin.settings.allowWeb, abort,
      });
      thread.sessionId = sessionId;
      thinking.collapse();
      reply.finish(full);
      addMessage(thread, "assistant", full);
      this.setBusy(false);
      await this.plugin.saveSettings();
    } catch (e) {
      thinking.collapse();
      reply.discard();
      this.setBusy(false);
      this.showError(this.addMsg("buddy-status"), e);
      await this.plugin.saveSettings();
    }
  }

  // A reply bubble created on first text delta. `onFirst` runs once (to collapse thinking).
  private lazyReply(onFirst: () => void) {
    let r: { append: (d: string) => void; done: () => void } | null = null;
    let started = false;
    return {
      append: (d: string) => {
        if (!started) { started = true; onFirst(); r = this.newReply(); }
        r!.append(d);
      },
      // Ensure the final text is shown (covers replies that arrive without partial deltas).
      finish: (full: string) => {
        if (!started && full.trim()) { onFirst(); r = this.newReply(); r.append(full); }
        r?.done();
      },
      discard: () => r?.done(),
    };
  }

  // ---- in-editor diff preview + panel controls ----
  private presentEdit(view: any, editor: LineEditor, region: Region, proposed: string, steer?: (instruction: string) => void): Promise<boolean> {
    // No-op edit: nothing to add or delete → don't force a diff, just say so.
    const plan = planDiff(region.text, proposed);
    if (!plan.dels.length && !plan.adds.length) {
      this.addMsg("buddy-status-ok", "No changes needed.");
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const cm = (view.editor as any).cm as EditorView;
      this.clearDiff();
      showDiff(cm, region.fromLine, region.text, proposed);

      const card = this.addMsg("buddy-noteref");
      html(card.createSpan({ cls: "buddy-noteref-ic" }), icon("note-01"));
      card.createSpan({ text: "Proposed an edit — changes are highlighted in your note." });
      const acts = this.addMsg("buddy-editacts");
      const accept = acts.createEl("button", { cls: "buddy-pb is-accept" });
      html(accept.createSpan({ cls: "buddy-pb-ic" }), icon("tick-02"));
      accept.createSpan({ text: "Accept" });
      accept.createSpan({ cls: "buddy-kbd", text: "⌘↵" });
      const reject = acts.createEl("button", { cls: "buddy-pb" });
      reject.createSpan({ text: "Reject" });
      reject.createSpan({ cls: "buddy-kbd", text: "Esc" });

      this.enterSteer();
      const finish = (applied: boolean) => {
        this.exitSteer();
        this.clearDiff();
        acts.remove();
        card.setText(applied ? "✓ Applied to your note." : "Discarded.");
        card.removeClass("buddy-noteref");
        card.addClass(applied ? "buddy-status-ok" : "buddy-status");
        resolve(applied);
      };
      this.pendingDiff = {
        view: cm,
        // Clear the preview decorations before mutating the doc so nothing maps through the change.
        accept: () => { this.clearDiff(); applyRegion(editor, region, proposed); finish(true); },
        reject: () => finish(false),
        steer: steer ? (instr) => { this.clearDiff(); acts.remove(); card.remove(); steer(instr); } : () => {},
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
  }

  // Chat's edit tool: diff the whole open note against the proposed content.
  private proposeEdit(content: string, _summary: string): Promise<boolean> {
    const view = this.plugin.activeMarkdownView();
    if (!view) { this.addMsg("buddy-error", "No open note to edit."); return Promise.resolve(false); }
    const editor = view.editor as unknown as LineEditor;
    const region: Region = { fromLine: 0, toLine: editor.lineCount() - 1, text: view.editor.getValue() };
    return this.presentEdit(view, editor, region, content);
  }

  // ---- ask_user ----
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

  // ---- history ----
  private ensureThread() {
    if (!this.thread) {
      this.thread = newThread(crypto.randomUUID(), Date.now());
      this.plugin.threads.unshift(this.thread);
    }
    return this.thread;
  }
  private resetStream() { this.clearPending(); this.clearDiff(); this.streamEl.empty(); }

  private basePromptFor(kind: "fix" | "refine"): string {
    return kind === "fix" ? PROMPTS.fixFormatting : PROMPTS.refine(this.plugin.settings.styleGuide);
  }

  private showHistory() {
    this.resetStream();
    const list = this.addMsg("buddy-history");
    const nw = list.createEl("button", { cls: "buddy-pb is-accept" });
    nw.setText("+ New chat");
    nw.onclick = () => { this.thread = null; this.resetStream(); };
    for (const t of this.plugin.threads) {
      const row = list.createDiv({ cls: "buddy-hist-row" });
      row.createSpan({ cls: "buddy-hist-title", text: t.title }).onclick = () => this.loadThread(t);
      const del = this.iconBtn(row, "cancel-01", "Delete", async () => {
        this.plugin.threads = this.plugin.threads.filter((x) => x.id !== t.id);
        if (this.thread?.id === t.id) this.thread = null;
        await this.plugin.saveSettings();
        this.showHistory();
      });
      del.addClass("buddy-hist-del");
    }
  }
  private loadThread(t: ChatThread) {
    this.thread = t;
    this.resetStream();
    for (const m of t.messages) {
      this.addMsg(m.role === "user" ? "buddy-user" : "buddy-assistant").setText(m.text);
    }
  }
}
