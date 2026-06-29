import { describe, it, expect } from "vitest";
import { titleFrom, newThread, addMessage } from "../src/history";

describe("titleFrom", () => {
  it("collapses whitespace and truncates long text", () => {
    expect(titleFrom("  hello   world  ")).toBe("hello world");
    expect(titleFrom("x".repeat(60))).toBe("x".repeat(40) + "…");
  });
  it("falls back for empty text", () => {
    expect(titleFrom("   ")).toBe("New chat");
  });
});

describe("addMessage", () => {
  it("titles the thread from the first user message only", () => {
    const t = newThread("id1", 123);
    addMessage(t, "user", "first question");
    addMessage(t, "assistant", "an answer");
    addMessage(t, "user", "second question");
    expect(t.title).toBe("first question");
    expect(t.messages.length).toBe(3);
  });
});
