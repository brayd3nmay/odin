// Pure helpers for reading Agent SDK message streams. No SDK/obsidian imports
// so this is unit-testable in plain Node.

export function extractText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === "result" && m.subtype === "success" && typeof m.result === "string") {
      return m.result;
    }
  }
  const parts: string[] = [];
  for (const m of messages) {
    if (m?.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b?.type === "text") parts.push(b.text);
      }
    }
  }
  return parts.join("");
}

export function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}
