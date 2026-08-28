# Bitbucket Diff Enhancer

A Chrome extension (plus a Tampermonkey userscript) for Bitbucket Cloud that makes
pull requests easier to review.

## Features

- **Readable diffs** — view, copy, or download a PR diff as clean `diff --git`
  text, per file or for the whole pull request (uses the Bitbucket API for full
  diffs, with a DOM fallback). The viewer has syntax highlighting and a
  configurable font/theme.
- **Comment filter** — hide inline comments from authors you choose (e.g. bots
  like `DSO-PR-Bot`). Patterns support `*`/`?` wildcards (e.g. `*bot*`), and are
  case-insensitive.
- **Hide resolved comments** — collapse away resolved comment threads so only
  open feedback remains.
- **Copy PR summary** — title, URL, author, Jira ticket, branches, description,
  files changed, and `+/-` lines in one click.
- **Copy for AI review** — copies the full diff plus a ready-made review prompt
  for ChatGPT/Claude.
- **Review templates** — pre-filled approval and "changes requested" messages.
- **Open in external tools** — per-file (or whole-repository) deep links into
  your editor/terminal (VS Code, JetBrains, Warp, etc.) via configurable URL
  templates.
- **Options page** — a full settings page, plus **export/import** to share
  configuration with teammates.
- **Dark theme** — injected buttons, modals, and the diff viewer follow
  Bitbucket's theme (with a manual auto/light/dark override).
- **Settings UI** — a gear icon next to each file's diff buttons, or the
  **Comment filter** button in the PR header.

## Install

### Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select this folder.

### Userscript (Tampermonkey)

Install `userscript/bitbucketDiff.js` in Tampermonkey, Greasemonkey, or any
userscript manager.

## Project structure

```
.
├── manifest.json               # Chrome MV3 manifest
├── background.js               # Service worker: cross-origin fetches
├── content.js                  # Content script: diff extraction + comment filtering
├── options.html/js/css         # Full settings page (export/import, etc.)
├── lib/
│   └── core.js                 # Shared pure logic (glob matching, diff helpers)
├── test/
│   └── core.test.js            # Unit tests (Node's built-in test runner)
├── icons/                      # Extension icons
├── userscript/
│   └── bitbucketDiff.js        # Tampermonkey version of the same tool
├── package.json                # `npm test` script
└── README.md
```

## Testing

```sh
npm test
```

Runs the unit tests for the shared pure logic (`lib/core.js`) — glob matching,
author blocking, and diff text helpers — using Node's built-in test runner.

## How it works

- The content script injects **View diff** / **Copy diff** buttons into each
  diff file, and **View full diff** / **Copy full diff** into the PR header.
- Cross-origin API calls are performed by the background service worker using
  the logged-in Bitbucket session (via `host_permissions`), with a DOM-scroll
  fallback when the API is unavailable.
- Comment filtering watches the DOM and hides threads from configured authors
  and resolved threads, configurable from the settings popup.
