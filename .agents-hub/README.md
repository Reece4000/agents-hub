# Agent Hub board

The Tasks canvas is shared repo memory. Read `.agents-hub/notes/*.md` for tasks, notes, and codebase context. Each note has JSON metadata between `---` lines and a Markdown body. `.agents-hub/canvas.json` holds only spatial layout.

Start with a board summary, search for related Context notes, and read the active task. In Agent Hub terminals, `AGENT_HUB_REPO`, `AGENT_HUB_ACTIVE_TASK_ID`, `AGENT_HUB_BOARD_RUNTIME`, and `AGENT_HUB_BOARD_CLI` point to the board. Run `ELECTRON_RUN_AS_NODE=1 "$AGENT_HUB_BOARD_RUNTIME" "$AGENT_HUB_BOARD_CLI" summary` and use `search`, `read`, or `related` with a JSON argument. The same executable with `mcp` serves board tools over stdio.

Keep task status current. On completion, record outcome and checked acceptance criteria. Capture a concise codebase fact with evidence paths in a Context note using `complete-task`; give a no-learning reason only when nothing durable was learned. Commands check `expectedRevision`; read again if another writer changed a note.

Old `.agents-hub/tickets/*.json` files are preserved as migration sources. Edit the new note files for current Tasks.
