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

Every desktop terminal receives `AGENT_HUB_REPO`, `AGENT_HUB_BOARD_RUNTIME`, and `AGENT_HUB_BOARD_CLI`. A terminal opened while its Session has a working Task also receives `AGENT_HUB_ACTIVE_TASK_ID`. The bundled board executable uses the app's Electron runtime as Node:

```sh
ELECTRON_RUN_AS_NODE=1 "$AGENT_HUB_BOARD_RUNTIME" "$AGENT_HUB_BOARD_CLI" summary
ELECTRON_RUN_AS_NODE=1 "$AGENT_HUB_BOARD_RUNTIME" "$AGENT_HUB_BOARD_CLI" search '{"kind":"context","text":"database"}'
ELECTRON_RUN_AS_NODE=1 "$AGENT_HUB_BOARD_RUNTIME" "$AGENT_HUB_BOARD_CLI" read '"AH-12345678"'
```

Commands are `summary`, `search`, `read`, `related`, `update-task`, `upsert-context`, and `complete-task`. Pass one JSON argument after the command. Mutations require an `expectedRevision` from a fresh read; `complete-task` also requires an outcome and either an evidence-backed context change or a no-learning reason. The same executable with `mcp` implements a stdio MCP server exposing the board tools. Configure it in an agent that supports MCP using that agent's own settings; Agent Hub does not alter external CLI configuration.

On board open, Agent Hub adds a marked block to root `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` so Codex, Claude Code, and Gemini CLI can discover the board when launched from the repository. Other CLIs need the **Board brief** prompt or equivalent project instructions. An arbitrary model cannot be made to interpret environment variables by Agent Hub alone. Agents without the board CLI can read `.agents-hub/README.md` and the note files directly. Their access to the board depends on their own file and tool permissions.

## Build

```sh
npm test
npm run build
npm run package
```

The macOS app directory is written to `release/`.
