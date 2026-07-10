# TurnFold

A Chrome extension that adds **Notion-style toggles to claude.ai conversations**. Every turn (your question + Claude's answer) gets a fold chevron, so long chats collapse down to a scannable list of one-line questions instead of an endless scroll.

## Features

- **Fold any turn** — hover a question and click the round chevron on its left, Notion-toggle style. Collapsed turns shrink to the first line of your question; the answer is hidden. Click the question (or the chevron) to unfold.
- **Outline sidebar** — a small tab on the right edge of the window opens an outline listing every question in the chat. Click an entry to jump to that turn (with a brief highlight), or click its chevron to fold/unfold it from the outline.
- **Collapse all / Expand all** — buttons in the outline header.
- **Persists across reloads** — fold state is saved per conversation in `chrome.storage.local` and restored when you come back. Everything starts expanded by default; new messages always arrive expanded.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+O` | Toggle the outline sidebar |
| `Alt+Shift+C` | Collapse all turns |
| `Alt+Shift+E` | Expand all turns |

## Install

### Option A — download the zip (easiest)

1. Grab `TurnFold.zip` from the [latest release](https://github.com/8ddieHu0314/TurnFold/releases/latest) and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped `TurnFold` folder.
5. Open (or reload) any conversation on [claude.ai](https://claude.ai).

### Option B — from source

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `src/` folder.

Works in any Chromium browser (Chrome, Edge, Brave, Arc).

## How it works

A content script groups the chat into turns: each `[data-testid="user-message"]` starts a turn that runs until the next one. Because claude.ai is a React app, the script **never moves or removes React-owned DOM nodes** — folding is done purely by toggling CSS classes (`display: none` on the answer, a one-line clamp on the question), and the chevron/sidebar are small elements appended outside React's control. A `MutationObserver` plus a slow periodic tick re-apply state whenever React re-renders (streaming answers, edits, switching conversations).

Fold state is keyed by conversation ID (from the URL) plus each turn's position and a hash of its first line, so it survives reloads but resets harmlessly if a message is edited. Stored state is pruned beyond the 200 most recently used conversations.

## Privacy

No data leaves your browser. The extension has no background script, no network access, and only the `storage` permission; it runs solely on `claude.ai`.

## Troubleshooting

If claude.ai ships a redesign and toggles stop appearing, the DOM selectors at the top of `src/content.js` (`USER_MSG_SELECTOR`, `WRAPPER_SELECTOR`) are the only things that should need updating.
