export interface EditorLike {
  getSelection(): string;
  replaceSelection(s: string): void;
  getValue(): string;
  setValue(s: string): void;
}

export interface Target {
  text: string;
  isSelection: boolean;
}

export function getTarget(e: EditorLike): Target {
  const sel = e.getSelection();
  return sel && sel.length > 0
    ? { text: sel, isSelection: true }
    : { text: e.getValue(), isSelection: false };
}

export function applyTarget(e: EditorLike, t: Target, newText: string): void {
  if (t.isSelection) e.replaceSelection(newText);
  else e.setValue(newText);
}

// ---- Line-region editing (used by the in-editor inline diff) ----
// A minimal slice of Obsidian's Editor: line-addressed reads/writes. Kept as an interface so
// this module stays free of the `obsidian` runtime and remains unit-testable.
export interface Pos {
  line: number;
  ch: number;
}
export interface LineEditor {
  lineCount(): number;
  getLine(n: number): string;
  getRange(from: Pos, to: Pos): string;
  replaceRange(replacement: string, from: Pos, to: Pos): void;
  listSelections(): { anchor: Pos; head: Pos }[];
}

// A whole-line range (0-based, inclusive) plus its current text. The inline diff always works on
// full lines so deleted/added lines align to editor lines.
export interface Region {
  fromLine: number;
  toLine: number;
  text: string;
}

export function getRegion(e: LineEditor): Region {
  const sel = e.listSelections()[0];
  let fromLine = 0;
  let toLine = e.lineCount() - 1;
  if (sel && (sel.anchor.line !== sel.head.line || sel.anchor.ch !== sel.head.ch)) {
    fromLine = Math.min(sel.anchor.line, sel.head.line);
    toLine = Math.max(sel.anchor.line, sel.head.line);
  }
  const text = e.getRange({ line: fromLine, ch: 0 }, { line: toLine, ch: e.getLine(toLine).length });
  return { fromLine, toLine, text };
}

export function applyRegion(e: LineEditor, r: Region, newText: string): void {
  e.replaceRange(newText, { line: r.fromLine, ch: 0 }, { line: r.toLine, ch: e.getLine(r.toLine).length });
}
