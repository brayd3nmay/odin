import { describe, it, expect } from "vitest";
import { planDiff } from "../src/diffplan";

describe("planDiff", () => {
  it("plans a replaced middle line as del + add anchored after it", () => {
    // a / b->x / c : delete region line 1 (b), insert [x] after region line 1
    expect(planDiff("a\nb\nc", "a\nx\nc")).toEqual({
      dels: [1],
      adds: [{ after: 1, lines: ["x"] }],
    });
  });

  it("plans a pure append after the last line", () => {
    expect(planDiff("a\nb", "a\nb\nc\nd")).toEqual({
      dels: [],
      adds: [{ after: 1, lines: ["c", "d"] }],
    });
  });

  it("plans a prepend before the first line (after = -1)", () => {
    expect(planDiff("a", "x\na")).toEqual({
      dels: [],
      adds: [{ after: -1, lines: ["x"] }],
    });
  });

  it("plans pure deletions", () => {
    expect(planDiff("a\nb\nc", "a\nc")).toEqual({
      dels: [1],
      adds: [],
    });
  });

  it("groups consecutive added lines into one run", () => {
    // Sticky example: append a blank + heading + body after the last line
    expect(planDiff("Fixed.", "Fixed.\n\n## Sticky\nbody")).toEqual({
      dels: [],
      adds: [{ after: 0, lines: ["", "## Sticky", "body"] }],
    });
  });

  it("no diff -> empty plan", () => {
    expect(planDiff("a\nb", "a\nb")).toEqual({ dels: [], adds: [] });
  });
});
