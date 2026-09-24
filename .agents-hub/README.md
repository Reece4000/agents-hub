# Agent Hub board

The Tasks canvas is shared repo memory. Read `.agents-hub/notes/*.md` for tasks, notes, and codebase context. Each note has JSON metadata between `---` lines and a Markdown body. `.agents-hub/canvas.json` holds only spatial layout.

In an Agent Hub terminal the board is available two ways:

- MCP tools named `board_*` (Claude Code and Codex terminals are configured automatically).
- The `agent-hub-board` command: `agent-hub-board summary`, then `search`, `read`, or `related` with one JSON argument, e.g. `agent-hub-board search '{"kind":"context","text":"database"}'`.

Start with `board_summary`. Its `activeTask` is the Task your Session is working on; read it, search for related Context notes, and keep its status current. Mutations take the `expectedRevision` from a fresh read; read again if another writer changed a note.

On completion, record the outcome and checked acceptance criteria with `board_complete_task` (`agent-hub-board complete-task`), capturing one concise, evidence-backed codebase fact in a Context note. Give a no-learning reason only when nothing durable was learned. Without the board tools, read these Markdown files directly and leave edits to an Agent Hub terminal.

Old `.agents-hub/tickets/*.json` files are preserved as migration sources. Edit the new note files for current Tasks.
