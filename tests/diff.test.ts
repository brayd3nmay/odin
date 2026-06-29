import { describe, it, expect } from "vitest";
import { diffLines } from "../src/diff";

describe("diffLines", () => {
  it("marks a changed middle line as del then add", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "x" },
      { type: "same", text: "c" },
    ]);
  });

  it("handles pure additions", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
    ]);
  });

  it("returns empty for two empty strings", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("treats an empty original as all additions", () => {
    expect(diffLines("", "x\ny")).toEqual([
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
  });

  it("treats an empty new text as all deletions", () => {
    expect(diffLines("a\nb", "")).toEqual([
      { type: "del", text: "a" },
      { type: "del", text: "b" },
    ]);
  });
});
