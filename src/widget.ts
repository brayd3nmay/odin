import { setIcon } from "obsidian";
import type BuddyPlugin from "./main";
import { getTarget, applyTarget } from "./edit";
import type { Target, EditorLike } from "./edit";
import { diffLines } from "./diff";
import { PROMPTS } from "./agent";

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
    // chat input added in Task 11.
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

  // ponytail: placeholder until Task 10 wires up the real implementation.
  private async runGaps() {
    this.addMsg("buddy-status", "Find Gaps is wired up in a later step.");
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

  focusChat() { this.open(); }
}
