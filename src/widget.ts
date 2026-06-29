import { setIcon } from "obsidian";
import type BuddyPlugin from "./main";

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

    this.streamEl = this.card.createDiv({ cls: "buddy-stream" });
    // chips + chat input are added in Tasks 9 & 11.
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

  // filled in later tasks
  runQuickAction(_kind: "fix" | "refine" | "gaps") {}
  focusChat() { this.open(); }
}
