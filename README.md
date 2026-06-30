# Odin

A floating AI assistant for [Obsidian](https://obsidian.md/) that fixes formatting, refines notes, finds gaps in your thinking, and chats about your ideas — powered by either the [Claude Agent SDK](https://docs.anthropic.com/agents/overview) or the [Codex SDK](https://developers.openai.com/codex/sdk).

**Desktop-only plugin** that uses your local logged-in agent CLI. No API key is required for the built-in Claude or Codex provider paths: Claude authenticates through Claude Code, and Codex authenticates through your ChatGPT-backed Codex login.

## Prerequisites

- **Obsidian** 1.5.0+
- **Claude Code CLI** installed and logged in:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```
  The plugin auto-detects your `claude` executable. If it lives somewhere non-standard, set the path manually in plugin settings.
- **Codex CLI** installed and signed in with ChatGPT if you want to use Codex:
  ```bash
  codex login
  ```
  The plugin auto-detects your `codex` executable. If it lives somewhere non-standard, set the path manually in plugin settings.

## Installation

1. **Build the plugin**
   ```bash
   npm install
   npm run build
   ```

2. **Copy the compiled files into your vault**
   - Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/odin/` (create the directory if it doesn't exist).

3. **Enable the plugin in Obsidian**
   - Open **Settings** → **Community plugins** → **Installed plugins**
   - Find **Odin** and toggle it on.

## Features

### Fix Formatting
Fixes **capitalization and punctuation only** — useful for cleaning up voice-to-text notes. No words are added, removed, or reordered; structure and formatting are always preserved.

**Trigger:** Click the "Fix Formatting" chip in the Odin widget, or use `Odin: Fix Formatting` from the editor context menu or command palette.

### Refine
Improves readability by applying **Markdown formatting (headings, lists, bold, italics)** without changing wording. Respects your optional formatting style guide configured in settings.

**Trigger:** Click the "Refine" chip, or use `Odin: Refine` from the command menu.

### Find Gaps
Analyzes your note in a **read-only mode** and surfaces missing points, incomplete ideas, and things worth verifying. Can search related notes in your vault and optionally search the web (see settings). Never edits your notes.

**Trigger:** Click the "Find Gaps" chip, or use `Odin: Find Gaps`.

### Chat
A **vault-aware conversational assistant** that understands your notes and can suggest edits (which you review and approve). Supports web search (optional), model selection, and extended thinking. Chat history is persistent.

**Trigger:** Type in the input box at the bottom of the Odin widget. The active agent can propose edits via a clear diff preview; you accept or reject each one.

## Settings

Access plugin settings via **Obsidian Settings** → **Community plugins** → **Odin**.

### Provider

Choose **Claude** or **Codex**. Claude uses your local Claude Code login. Codex uses your local Codex CLI ChatGPT login and runs in read-only mode when inspecting your vault; proposed note edits still go through Odin's diff approval UI.

### Per-Feature Defaults

Set the **model** and **thinking level** (No thinking, Think, or Think hard) for each feature. Model choices change with the selected provider:

- **Claude:** Opus, Sonnet, or Haiku
- **Codex:** Codex default, GPT-5.5, or GPT-5.4 mini

Override these per-feature defaults in the widget header (dropdown menus).

### Formatting Style Guide

Paste your preferred formatting rules (e.g., heading styles, bullet-list conventions, capitalization). This is injected into the **Refine** prompt.

### Allow Web Search

Toggle on/off for **Find Gaps** and **Chat** to use web search and fetch. Enabled by default.

### Claude Executable Path

Leave blank to auto-detect your installed `claude`. Set a path manually if needed (e.g., for a non-standard installation).

### Codex Executable Path

Leave blank to auto-detect your installed `codex`. Codex uses your ChatGPT login by default; Odin does not ask for an OpenAI API key.

## Privacy & Data

- **Note and vault content:** Your active note and other vault notes (when accessed by features like Find Gaps and Chat) are sent to the selected provider for processing.
- **Web search:** Only enabled if toggled on in settings. Web search queries and fetched content are sent to the selected provider.
- **Chat history:** Stored locally in Obsidian's plugin data directory; not sent to a provider except during chat turns.

All communication goes through the selected local CLI/SDK path.

## How It Works

The plugin spawns an agent via the selected provider SDK, which:

1. Reads your current note and optionally other vault files (via Obsidian's file APIs).
2. Optionally searches the web (if enabled).
3. For **Fix Formatting** and **Refine:** returns transformed text, which you accept or reject via a diff preview.
4. For **Find Gaps:** returns analysis (read-only).
5. For **Chat:** can propose edits to the open note; you review the diff and choose to accept or reject.

All edits are explicit; the plugin never overwrites your notes without your approval.

## Troubleshooting

### "Claude not found" error
- Ensure the Claude Code CLI is installed and logged in: `claude login`
- Check that `claude` is on your PATH: `which claude`
- If installed elsewhere, set the path manually in plugin settings.

### "Codex not found" error
- Ensure the Codex CLI is installed and signed in with ChatGPT: `codex login`
- Check that `codex` is on your PATH: `which codex`
- If installed elsewhere, set the path manually in plugin settings.

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
npm test         # Run test suite
```

## License

MIT
