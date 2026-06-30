import { describe, it, expect } from "vitest";
import { skillSlug, skillDoc, parseSkill, safeSkillDir } from "../src/skill";

describe("skillSlug", () => {
  it("slugifies a normal name", () => {
    expect(skillSlug("Weekly Review")).toBe("weekly-review");
  });
  it("cannot escape the skills dir (no separators or traversal survive)", () => {
    expect(skillSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(skillSlug("a/b\\c")).toBe("a-b-c");
    expect(skillSlug("..")).toBe("");
  });
  it("collapses junk and trims dashes", () => {
    expect(skillSlug("  !!Foo__Bar!!  ")).toBe("foo-bar");
  });
  it("returns empty when nothing is usable", () => {
    expect(skillSlug("!!!")).toBe("");
    expect(skillSlug("")).toBe("");
  });
  it("caps length and never leaves a trailing dash", () => {
    const s = skillSlug("a".repeat(100));
    expect(s.length).toBe(64);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("skillDoc", () => {
  it("quotes the description so a colon can't break the YAML", () => {
    const doc = skillDoc("foo", "Use when: formatting notes", "Do the thing.");
    expect(doc).toContain("name: foo");
    expect(doc).toContain('description: "Use when: formatting notes"');
    expect(doc.endsWith("Do the thing.\n")).toBe(true);
  });
  it("escapes embedded quotes and flattens whitespace", () => {
    expect(skillDoc("f", 'a "b"\n  c', "x")).toContain('description: "a \\"b\\" c"');
  });
});

describe("parseSkill", () => {
  it("round-trips what skillDoc writes", () => {
    const doc = skillDoc("mermaid-diagram", "Use when: making a diagram", "Generate a mermaid block.");
    const p = parseSkill(doc);
    expect(p.name).toBe("mermaid-diagram");
    expect(p.description).toBe("Use when: making a diagram");
    expect(p.body).toBe("Generate a mermaid block.");
  });
  it("reads a bare (unquoted) description from a hand-written skill", () => {
    const p = parseSkill("---\nname: foo\ndescription: do the thing\n---\n\nbody here");
    expect(p.name).toBe("foo");
    expect(p.description).toBe("do the thing");
    expect(p.body).toBe("body here");
  });
  it("falls back to whole-file body when there's no frontmatter", () => {
    const p = parseSkill("just instructions, no frontmatter");
    expect(p.name).toBe("");
    expect(p.body).toBe("just instructions, no frontmatter");
  });
});

describe("safeSkillDir", () => {
  it("resolves a normal name to a dir + SKILL.md under root", () => {
    const loc = safeSkillDir("/vault/skills", "Weekly Review");
    expect(loc).not.toBeNull();
    expect(loc!.slug).toBe("weekly-review");
    expect(loc!.dir).toBe("/vault/skills/weekly-review");
    expect(loc!.file).toBe("/vault/skills/weekly-review/SKILL.md");
  });
  it("returns null when the name yields no usable slug", () => {
    expect(safeSkillDir("/vault/skills", "...")).toBeNull();
    expect(safeSkillDir("/vault/skills", "")).toBeNull();
  });
  it("neutralizes traversal — the result stays under root", () => {
    const loc = safeSkillDir("/vault/skills", "../../etc");
    expect(loc).not.toBeNull();
    expect(loc!.dir.startsWith("/vault/skills/")).toBe(true);
  });
});
