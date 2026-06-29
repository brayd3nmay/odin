export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  sessionId?: string;
  messages: ChatMsg[];
}

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length <= 40 ? clean : clean.slice(0, 40) + "…";
}

export function newThread(id: string, createdAt: number): ChatThread {
  return { id, title: "New chat", createdAt, messages: [] };
}

export function addMessage(t: ChatThread, role: "user" | "assistant", text: string): ChatThread {
  t.messages.push({ role, text });
  if (role === "user" && t.messages.filter((m) => m.role === "user").length === 1) {
    t.title = titleFrom(text);
  }
  return t;
}
