// In-editor inline diff preview, rendered with CodeMirror 6 decorations (Obsidian provides CM6 at
// runtime — see esbuild `external: ["@codemirror/*"]`). Deleted lines get a red line decoration;
// added lines render as a green block widget *without mutating the document* — the note only
// changes when the user accepts. Register `buddyDiffField` via plugin.registerEditorExtension.
import { EditorView, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { StateField, StateEffect, Range } from "@codemirror/state";
import { planDiff } from "./diffplan";

const setDiff = StateEffect.define<DecorationSet>();
const clearDiff = StateEffect.define<void>();

export const buddyDiffField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDiff)) deco = e.value;
      else if (e.is(clearDiff)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Green "+ line" rows for added text. A block widget so it sits between real editor lines.
class AddedLines extends WidgetType {
  constructor(readonly lines: string[]) {
    super();
  }
  eq(other: AddedLines) {
    return other.lines.length === this.lines.length && other.lines.every((l, i) => l === this.lines[i]);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "buddy-cm-add";
    for (const l of this.lines) {
      const row = wrap.createDiv({ cls: "buddy-cm-line" });
      row.createSpan({ cls: "buddy-cm-mk", text: "+" });
      row.createSpan({ cls: "buddy-cm-tx", text: l.length ? l : " " });
    }
    return wrap;
  }
}

// `fromLine` is the 0-based document line where `original` begins (0 for whole-note edits).
export function showDiff(view: EditorView, fromLine: number, original: string, proposed: string) {
  const plan = planDiff(original, proposed);
  const doc = view.state.doc;
  const ranges: Range<Decoration>[] = [];
  for (const d of plan.dels) {
    const ln = doc.line(fromLine + 1 + d); // doc.line() is 1-based
    ranges.push(Decoration.line({ class: "buddy-cm-del" }).range(ln.from));
  }
  for (const a of plan.adds) {
    const widget = new AddedLines(a.lines);
    const deco = Decoration.widget({ widget, block: true, side: a.after < 0 ? -1 : 1 });
    const pos = a.after < 0 ? doc.line(fromLine + 1).from : doc.line(fromLine + 1 + a.after).to;
    ranges.push(deco.range(pos));
  }
  view.dispatch({ effects: setDiff.of(Decoration.set(ranges, true)) });
}

export function hideDiff(view: EditorView) {
  view.dispatch({ effects: clearDiff.of() });
}
