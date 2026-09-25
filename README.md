# Agent Hub

Desktop workspace for coding with agents. Tasks, notes, and codebase context share a repository canvas. Sessions hold agent and shell terminals.

## Run

Requires Node.js 22+ for development.

```sh
npm install
npm run dev
```

`npm run dev:web` opens a browser preview with sample repositories. The preview stores changes in local browser storage; terminals run only in the desktop app.

## Tasks canvas

- Click **Note** or **Task**, double-click blank canvas space to jot a note, or right-click for other kinds and sections. Press `N` for a note, `T` for a task, and `F` to fit the canvas. A new note saves when you click outside its quick capture card.
- Drag blank canvas space to pan. Scroll to pan; pinch or Command/Control-scroll to zoom. Drag a card into a section. Drag a section header to move it and its cards, or its lower corner to resize it.
- Click a card to edit it in a document tab. Drag its link handle onto another card, or click the handle and then the target card. Search finds notes anywhere on the canvas, including collapsed sections. Filter by kind, hide completed tasks, inspect prior versions, and restore notes from Trash.
- Tasks use `open`, `working`, `blocked`, and `done`. Completing a task records its outcome and acceptance checks, and creates or updates a concise Codebase Context note with evidence paths. If there was no durable learning, record a reason.

Board files live in the selected repository:

| Path | Contents |
| --- | --- |
| `.agents-hub/notes/<id>.md` | One Markdown note with JSON metadata between `---` lines. |
| `.agents-hub/canvas.json` | Card positions and flat sections. |
| `.agents-hub/history/` | Previous app and agent written note revisions. |
| `.agents-hub/trash/` | Recoverable deleted notes. |
| `.agents-hub/operations/` | Completion journals used to detect interrupted captures. |
| `.agents-hub/README.md` | Agent instructions generated on first board open. |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | Small managed instruction blocks that point compatible agent CLIs to the board. Existing content is retained. If `AGENTS.override.md` exists, it gets the same block. |

The app watches valid direct edits to note files. An invalid file stays on disk and appears as an error while other notes remain available. Content edits use revision checks so a stale editor cannot overwrite a changed note. The legacy `.agents-hub/tickets/*.json` files are imported additively on first board open and remain in place.

## Sessions and agent access

A Session groups independently running terminals for one repository. Assign a Task to a Session, then choose **Work in Session**. The task changes to `working`, and the Session shows a briefing containing the task, acceptance checks, linked context, and board access instructions. Send it to a running agent terminal or copy it for another CLI. **Board brief** in the Sessions toolbar prepares a general handoff for any model. Shell terminals do not receive a prompt automatically; copy the brief into an agent started in the shell.

### Live agent state

Claude Code and Codex terminals (including custom profiles that run them) are launched with per-run integration flags; nothing in `~/.claude` or `~/.codex` is modified:

| | Claude Code | Codex |
| --- | --- | --- |
| State | Hooks passed with `--settings` post each event to a loopback endpoint | `notify` reports finished turns; approvals arrive as OSC 9 escapes |
| Board | `--mcp-config` registers the `agent-hub` MCP server | `-c mcp_servers.agent_hub.*` registers it |
| Resume | `--session-id` on first launch, `--resume` afterwards | `codex resume <thread-id>` |

Other agents are tracked from the screen: output means working, a quiet screen means idle, and a bell or OSC 9/777 notification means the agent needs you. Tabs show each agent's state and current action. An agent that needs you, or finishes while the window is unfocused, raises a notification; the Dock badge counts agents waiting on you. Reopening a stopped agent resumes its conversation; **New conversation** starts fresh. Codex prints a one-line notice that command-line overrides run it without its shared background server.

### Agents keep running

Terminals run in a small supervisor process, so agents keep working after you quit Agent Hub and reattach, screen intact, when you open it again. **Quit and Stop Agents** (⌥⌘Q) stops them instead. The supervisor exits on its own once no terminal is running and no window is connected. Hooks keep reporting to the same local port and token across restarts; events that happen while the app is closed are not replayed, so an agent shows as idle until its next event.

### Board access from terminals

Every desktop terminal receives `AGENT_HUB_REPO`, `AGENT_HUB_SESSION_ID`, `AGENT_HUB_TERMINAL_ID`, `AGENT_HUB_BOARD_RUNTIME`, and `AGENT_HUB_BOARD_CLI`, and has the `agent-hub-board` command on its PATH. The board summary's `activeTask` is resolved from the Session on every call, so a Task handed to an already-running agent is visible immediately.

```sh
agent-hub-board summary
agent-hub-board search '{"kind":"context","text":"database"}'
agent-hub-board read '"AH-12345678"'
```

Commands are `summary`, `search`, `read`, `related`, `update-task`, `upsert-context`, and `complete-task`. Pass one JSON argument after the command. Mutations require an `expectedRevision` from a fresh read; `complete-task` also requires an outcome and either an evidence-backed context change or a no-learning reason. `agent-hub-board mcp` is a stdio MCP server exposing the same tools; Claude Code and Codex terminals get it automatically. Board reads from agents never rewrite `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`; only the desktop app maintains those blocks.

On board open, Agent Hub adds a marked block to root `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` so Codex, Claude Code, and Gemini CLI can discover the board when launched from the repository. Other CLIs need the **Board brief** prompt or equivalent project instructions. An arbitrary model cannot be made to interpret environment variables by Agent Hub alone. Agents without the board CLI can read `.agents-hub/README.md` and the note files directly. Their access to the board depends on their own file and tool permissions.

## Build

```sh
npm test
npm run build
npm run package
```

The macOS app directory is written to `release/`.
