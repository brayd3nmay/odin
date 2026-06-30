// Pure helpers for authoring a Claude Code skill file. No SDK/obsidian/fs imports so the slug
// sanitization (a path-containment security boundary) and the frontmatter are unit-testable in
// plain Node — same pattern as parse.ts / diff.ts.

// A filesystem-safe, lowercase slug. Collapsing everything outside [a-z0-9] to single dashes means
// the result can never contain a path separator or "..", so it can't escape the skills directory.
// Caps the length and never leaves a trailing dash (even after the length cap). "" if nothing usable.
export function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

// SKILL.md contents. The model-supplied description is whitespace-flattened and quoted (with inner
// quotes escaped) so a colon or quote in it can't break the YAML frontmatter parser downstream.
export function skillDoc(slug: string, description: string, instructions: string): string {
  const desc = description.replace(/\s+/g, " ").trim().replace(/"/g, '\\"');
  return `---\nname: ${slug}\ndescription: "${desc}"\n---\n\n${instructions.trim()}\n`;
}

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  body: string;
}

// Read name/description out of a SKILL.md's frontmatter and return the body. Lenient: handles a
// quoted or bare description, and falls back to treating the whole file as the body if there's no
// frontmatter (so user/global skills written by other tools still parse).
export function parseSkill(content: string): { name: string; description: string; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: "", description: "", body: content.trim() };
  const front = m[1];
  const field = (key: string) => {
    const fm = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    let v = fm ? fm[1].trim() : "";
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    return v;
  };
  return { name: field("name"), description: field("description"), body: m[2].trim() };
}
