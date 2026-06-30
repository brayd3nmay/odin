import { describe, it, expect } from "vitest";
import { extractText, stripFences, preserveEdges } from "../src/parse";

describe("extractText", () => {
  it("prefers the final successful result string", () => {
    const msgs = [
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
      { type: "result", subtype: "success", result: "FINAL" },
    ];
    expect(extractText(msgs)).toBe("FINAL");
  });

  it("falls back to concatenated assistant text blocks", () => {
    const msgs = [
      { type: "assistant", message: { content: [{ type: "text", text: "a" }, { type: "tool_use", name: "x" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "b" }] } },
    ];
    expect(extractText(msgs)).toBe("ab");
  });
});

describe("stripFences", () => {
  it("removes a wrapping code fence", () => {
    expect(stripFences("```md\nhello\n```")).toBe("hello");
  });
  it("leaves unfenced text untouched", () => {
    expect(stripFences("hello")).toBe("hello");
  });
});

describe("preserveEdges", () => {
  it("restores a trailing blank line the model dropped", () => {
    expect(preserveEdges("a\nb\n", "a\nb")).toBe("a\nb\n");
  });
  it("keeps original leading/trailing whitespace, not the transformed body's", () => {
    expect(preserveEdges("\n\nhi\n", "  hi.  ")).toBe("\n\nhi.\n");
  });
  it("is a no-op when edges already match", () => {
    expect(preserveEdges("a\n", "a\n")).toBe("a\n");
  });
});
