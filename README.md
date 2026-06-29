# Obsidian Buddy

A floating Claude assistant for [Obsidian](https://obsidian.md/) that fixes formatting, refines notes, finds gaps in thinking, and chats about your ideas — powered by the [Claude Agent SDK](https://docs.anthropic.com/agents/overview).

**Desktop-only plugin** that requires the [Claude Code CLI](https://claude.ai/code) installed and logged in.

## Prerequisites

- **Obsidian** 1.5.0+
- **Claude Code CLI** installed and logged in. Install it via:
  ```bash
  npm install -g @anthropic-ai/claude
  ```
  Then log in:
  ```bash
  claude login
  ```
  The plugin will auto-detect your `claude` executable. If needed, you can manually specify its path in plugin settings.

## Installation

1. **Build the plugin**
   ```bash
   npm install
   npm run build
   ```

2. **Copy the compiled files into your vault**
   - Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/obsidian-buddy/` (create the directory if it doesn't exist).

3. **Enable the plugin in Obsidian**
   - Open **Settings** → **Community plugins** → **Installed plugins**
   - Find "Obsidian Buddy" and toggle it on.

## Features

### Fix Formatting
Fixes **capitalization and punctuation only** — useful for cleaning up voice-to-text notes. No words are added, removed, or reordered; structure and formatting are always preserved.

**Trigger:** Click the "Fix Formatting" chip in the Claude widget, or use the command `Claude: Fix Formatting` from the editor context menu or command palette.

### Refine
Improves readability by applying **Markdown formatting (headings, lists, bold, italics)** without changing wording. Respects your optional formatting style guide configured in settings.

**Trigger:** Click the "Refine" chip, or use `Claude: Refine` from the command menu.

### Find Gaps
Analyzes your note in a **read-only mode** and surfaces missing points, incomplete ideas, and things worth verifying. Can search related notes in your vault and optionally search the web (see settings).

**Trigger:** Click the "Find Gaps" chip, or use `Claude: Find Gaps`. The plugin will never edit your notes with this feature.

### Chat
A **vault-aware conversational assistant** that understands your notes and can suggest edits (which you review and approve). Supports web search (optional), model selection, and extended thinking. Chat history is persistent.

**Trigger:** Type in the input box at the bottom of the Claude widget, or send a message. Claude can propose edits via a clear diff preview; you accept or reject.

## Settings

Access plugin settings via **Obsidian Settings** → **Community plugins** → **Obsidian Buddy**.

### Per-Feature Defaults

Set the **model** (Opus, Sonnet, or Haiku) and **thinking level** (No thinking, Think, or Think hard) for each feature:

- **Fix Formatting:** Haiku, no thinking (fast)
- **Refine:** Sonnet, think (balanced)
- **Find Gaps:** Sonnet, think hard (thorough analysis)
- **Chat:** Sonnet, think (conversational)

You can override these per-feature defaults in the widget header (dropdown menus).

### Formatting Style Guide

Paste your preferred formatting rules (e.g., heading styles, bullet-list conventions, capitalization). This is injected into the **Refine** prompt.

### Allow Web Search

Toggle on/off for **Find Gaps** and **Chat** to use web search and fetch. Enabled by default.

### Claude Executable Path

Leave blank to auto-detect your installed `claude`. Manually specify a path if needed (e.g., for a non-standard installation).

## Privacy & Data

- **Note and vault content:** Your active note and other vault notes (when accessed by features like Find Gaps and Chat) are sent to Claude for processing.
- **Web search:** Only enabled if toggled on in settings. Web search queries and fetched content are sent to Claude.
- **Chat history:** Stored locally in Obsidian's plugin data directory; not sent to Anthropic except during chat turns.

All communication uses the Claude Code CLI, which authenticates via your Claude login.

## Commands

- **Toggle Claude widget:** Open/close the floating assistant.
- **Fix Formatting:** Apply capitalization and punctuation fixes.
- **Refine:** Reformat for readability.
- **Find Gaps:** Analyze for missing content.

Commands are available via the command palette (`Ctrl+P` / `Cmd+P` → search "Claude") or the editor context menu (right-click on a note).

## How It Works

The plugin spawns an agent via the Claude Agent SDK, which:

1. Reads your current note and optionally other vault files (via Obsidian's file APIs).
2. Optionally searches the web (if enabled).
3. For **Fix Formatting** and **Refine:** returns transformed text, which you can accept or reject via a diff preview.
4. For **Find Gaps:** returns analysis (read-only).
5. For **Chat:** can propose edits to the open note via `propose_note_edit`; you review the diff and choose to accept or reject.

All edits are explicit; the plugin never overwrites your notes without your approval.

## Troubleshooting

### "Claude not found" error
- Ensure the Claude Code CLI is installed and logged in: `claude login`
- Check that `claude` is on your PATH: `which claude`
- If installed elsewhere, manually set the path in plugin settings.

### Features don't work after enabling
- Reload the plugin: disable and re-enable it in Community plugins settings.
- Check the Obsidian console (`Ctrl+Shift+I` / `Cmd+Option+I`) for error details.

### Chat history is lost
- Chat history is stored locally. If you've uninstalled and reinstalled Obsidian or the plugin, previous threads won't be recovered. New threads will be saved.

## Development

```bash
npm install      # Install dependencies
npm run dev      # Watch mode (rebuild on file changes)
npm run build    # Production build
npm test         # Run test suite (EditApplier, diff, parse, history)
```

## License

MIT — see LICENSE for details.
