import { Menu, setTooltip, setIcon } from "obsidian";
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

  constructor(parent: HTMLElement, private scroll: () => void) {
    this.el = parent.createDiv({ cls: "odin-think is-collapsed" });
    this.head = this.el.createDiv({ cls: "odin-think-head" });
    this.head.onclick = () => this.el.toggleClass("is-collapsed", !this.el.hasClass("is-collapsed"));
    this.steps = this.el.createDiv({ cls: "odin-steps" });
    this.reason = this.el.createDiv({ cls: "odin-think-reason" });
    this.renderHead();
  }

  private renderHead() {
    this.head.empty();
    setIcon(this.head.createSpan({ cls: "odin-chev" }), "chevron-right");
    if (this.done) {
      const secs = ((Date.now() - this.start) / 1000).toFixed(1);
      this.head.createSpan({ text: `Thought for ${secs}s` });
    } else {
      this.head.createSpan({ cls: "odin-spinner" });
      this.head.createSpan({ cls: "odin-think-label", text: "Thinking…" });
    }
  }

  tool(name: string) {
    const label = toolLabel(name);
    if (!label) return;
    this.markLastDone();
    const step = this.steps.createDiv({ cls: "odin-step is-live" });
    html(step.createSpan({ cls: "odin-step-ic" }), `<span class="odin-spinner odin-spinner-sm"></span>`);
    step.createSpan({ cls: "odin-step-tx", text: label });
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
      setIcon(this.lastStep.querySelector(".odin-step-ic") as HTMLElement, "check");
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
  private editPop!: HTMLElement;
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

  // The currently-previewed edit (diff shown in the editor; controls in the panel).
  private pendingDiff: {
    view: EditorView;
    accept: () => void;
    reject: () => void;
    steer: (instruction: string) => void;
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

    // composer zone, wrapped so the edit-approval popup can float above it (anchored, not in-stream)
    const composer = this.card.createDiv({ cls: "odin-composer" });
    this.editPop = composer.createDiv({ cls: "odin-editpop" });

    const actions = composer.createDiv({ cls: "odin-actions" });
    this.quickAction(actions, "fix", "list-checks", "Fix formatting");
    this.quickAction(actions, "refine", "wand-2", "Refine");
    this.quickAction(actions, "gaps", "search", "Find gaps");

    const footer = composer.createDiv({ cls: "odin-footer" });
    this.field = footer.createDiv({ cls: "odin-field" });
    this.input = this.field.createEl("textarea", {
      cls: "odin-input",
      attr: { placeholder: "Ask anything…", rows: "1" },
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
    this.input.onkeydown = (ev: KeyboardEvent) => this.onInputKey(ev);
  }

  private iconBtn(parent: HTMLElement, name: string, tip: string, onClick: () => void): HTMLElement {
    const b = parent.createEl("button", { cls: "odin-iconbtn clickable-icon" });
    setIcon(b, name);
    setTooltip(b, tip);
    b.onclick = onClick;
    return b;
  }

  private quickAction(parent: HTMLElement, kind: "fix" | "refine" | "gaps", name: string, label: string) {
    const b = parent.createEl("button", { cls: `odin-qa odin-qa-${kind}` });
    setIcon(b.createSpan({ cls: "odin-qa-ic" }), name);
    b.createSpan({ text: label });
    b.onclick = () => this.runQuickAction(kind);
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

  // A streaming assistant reply: deltas append with a blinking caret until done.
  private newReply(): { append: (d: string) => void; done: () => void } {
    const el = this.addMsg("odin-assistant is-streaming");
    return {
      append: (d) => { el.setText(el.getText() + d); this.scroll(); },
      done: () => el.removeClass("is-streaming"),
    };
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

  // One Fix/Refine pass over the region, then preview the result. A steering `instruction` (from
  // reviewing a previous result) is folded into the prompt; the transform always re-runs against
  // the ORIGINAL text, never its own output.
  private async runTransform(view: any, editor: LineEditor, region: Region, kind: "fix" | "refine", cfg: FeatureConfig, instruction?: string) {
    this.setBusy(true);
    const thinking = new Thinking(this.streamEl, () => this.scroll());
    const abort = this.track(new AbortController());
    const prompt = instruction
      ? `${this.basePromptFor(kind)}\n\nThe user reviewed your previous result and asks: "${instruction}". ` +
        `Apply that to the text below (which is the ORIGINAL, not your previous output).`
      : this.basePromptFor(kind);
    try {
      const proposed = await this.plugin.agent.transform(prompt, region.text, {
        model: cfg.model, thinking: cfg.thinking, allowWeb: false, abort,
      }, { onThinking: (d) => thinking.reasoning(d) });
      thinking.collapse();
      this.setBusy(false);
      this.presentEdit(view, editor, region, proposed, (instr) =>
        this.runTransform(view, editor, region, kind, cfg, instr));
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
      this.showError(this.addMsg("odin-status"), e);
    }
  }

  private async sendChat(text: string) {
    if (this.busy) return;
    this.open();
    const thread = this.ensureThread();
    addMessage(thread, "user", text);
    this.addMsg("odin-user").setText(text);
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
    // Tell the agent which note is open so it edits/reads the right file instead of guessing.
    const openPath = this.plugin.activeMarkdownView()?.file?.path;
    const prompt = openPath ? `[Currently open note: ${openPath}]\n\n${text}` : text;
    try {
      const { text: full, sessionId } = await this.plugin.agent.chat(prompt, thread.sessionId, ui, {
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
      this.showError(this.addMsg("odin-status"), e);
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

      // Approval prompt floats above the composer (see .odin-editpop) so it stays put while the
      // diff is reviewed, instead of scrolling away in the stream.
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
        steer: steer ? (instr) => { this.clearDiff(); steer(instr); } : () => {},
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
      box.createDiv({ cls: "odin-ask-hint", text: "Enter to send" });
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
      this.addMsg(m.role === "user" ? "odin-user" : "odin-assistant").setText(m.text);
    }
  }
}
