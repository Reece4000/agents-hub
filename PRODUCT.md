# Product behavior

Agent Hub has two repository views.

**Tasks** is a spatial canvas for Tasks, Notes, Codebase Context, and Sections. A Task represents work and its observable completion checks. A Codebase Context note records a specific, evidence-backed fact that should survive a Session. Notes hold questions and observations. Sections organize cards visually; links record relationships between notes. Search covers the whole board, independent of viewport and section collapse.

**Sessions** groups agent or shell terminals running in a repository. A Task can be assigned to one Session. The **Work in Session** action prepares a briefing from the Task and linked Context notes. A running agent can receive the briefing through its terminal; a shell or unsupported CLI can use the copyable text and repo files. Terminal conversations remain owned by their CLIs.

The repository owns board content in `.agents-hub/notes/`. The app owns terminal settings and drafts in its local data directory. Canvas layout is repo-local but separate from note content. Notes are version checked, written atomically, and retain history and Trash. Completing a Task journals the context change before marking it done; an interrupted capture is surfaced for recovery. Existing ticket JSON is kept as a migration source. Existing terminal groups retain their internal identities while the UI calls them Sessions.

The bundled board CLI and stdio MCP server use the same store as the renderer. They provide summary, search, read, related notes, task progress, context upsert, and task completion. MCP registration is configured per external agent CLI; Agent Hub does not assume every executable supports the protocol.
