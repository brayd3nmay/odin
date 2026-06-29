import { describe, it, expect } from "vitest";
import { getTarget, applyTarget, EditorLike } from "../src/edit";

function fakeEditor(selection: string, value: string): EditorLike & { value: string; replaced?: string } {
  return {
    value,
    getSelection: () => selection,
    getValue() { return this.value; },
    setValue(s: string) { this.value = s; },
    replaceSelection(s: string) { (this as any).replaced = s; },
  };
}

describe("getTarget", () => {
  it("targets the selection when one exists", () => {
    expect(getTarget(fakeEditor("sel", "whole"))).toEqual({ text: "sel", isSelection: true });
  });
  it("targets the whole note when no selection", () => {
    expect(getTarget(fakeEditor("", "whole"))).toEqual({ text: "whole", isSelection: false });
  });
});

describe("applyTarget", () => {
  it("replaces selection when isSelection", () => {
    const e = fakeEditor("sel", "whole");
    applyTarget(e, { text: "sel", isSelection: true }, "NEW");
    expect((e as any).replaced).toBe("NEW");
  });
  it("sets whole value when not a selection", () => {
    const e = fakeEditor("", "whole");
    applyTarget(e, { text: "whole", isSelection: false }, "NEW");
    expect(e.value).toBe("NEW");
  });
});
