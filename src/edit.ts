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
