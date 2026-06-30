import { diffLines } from "./diff";

// A line-level plan for rendering an inline diff *preview* without mutating the document:
//  - `dels` are region-relative line indices (0-based) that are deleted (mark them red).
//  - `adds` are runs of new lines, each inserted after region line `after` (-1 = before line 0).
// The CM layer turns these region-relative indices into document positions. Kept pure (no
// CodeMirror imports) so it can be unit-tested without the editor.
export interface DiffPlan {
  dels: number[];
  adds: { after: number; lines: string[] }[];
}

export function planDiff(original: string, proposed: string): DiffPlan {
  const dels: number[] = [];
  const adds: { after: number; lines: string[] }[] = [];
  let regionLine = 0; // index into the ORIGINAL region's lines
  let pending: { after: number; lines: string[] } | null = null;
  const flush = () => {
    if (pending) {
      adds.push(pending);
      pending = null;
    }
  };
  for (const op of diffLines(original, proposed)) {
    if (op.type === "add") {
      // consecutive adds share the same anchor (the last original line consumed)
      if (!pending) pending = { after: regionLine - 1, lines: [] };
      pending.lines.push(op.text);
    } else {
      flush();
      if (op.type === "del") dels.push(regionLine);
      regionLine++;
    }
  }
  flush();
  return { dels, adds };
}
