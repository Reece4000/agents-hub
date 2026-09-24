import type { BoardSnapshot } from '../shared/board'
export type TerminalKind = 'codex' | 'claude' | 'cursor' | 'shell' | 'custom'
export interface Attachment { id: string; name: string; mime: string; size: number; preview?: string; path?: string }
export interface Draft { html: string; text: string; attachments: Attachment[] }
export interface TerminalProfile { label: string; executable: string; args: string[] }
/** What an agent terminal is doing right now. `waiting` means it needs the
 *  person (a permission prompt or question); `idle` means its turn is over. */
export type AgentState = 'starting' | 'working' | 'waiting' | 'idle' | 'exited'
export interface AgentActivity {
  state: AgentState; detail: string; since: string;
  /** `hooks`: reported by the agent itself; `terminal`: inferred from its screen. */
  source: 'hooks' | 'terminal';
  providerSessionId?: string;
}
/** A terminal process slot within a named context. Custom profiles are
 *  launched as an executable plus argv; shell interpolation is never used. */
export interface TerminalResource {
  id: string; contextId: string; repo: string; name: string; agent: string;
  terminalKind: TerminalKind;
  profile?: TerminalProfile;
  /** Working directory when it is not the repository root: a Task's worktree. */
  cwd?: string;
  draft: Draft;
  terminalRunning?: boolean;
  /** Live agent state; never persisted. */
  activity?: AgentActivity;
  /** The agent CLI's own conversation id, so reopening resumes it. */
  conversationId?: string;
  createdAt: string; updatedAt: string;
}
/** A durable group of terminals for one workspace task or area of work. */
export interface RepoContext {
  id: string; repo: string; name: string; terminals: TerminalResource[];
  createdAt: string; updatedAt: string;
}
export interface Viewport { x: number; y: number; zoom: number }
export interface Workspace {
  version: 2; repos: string[]; contexts: RepoContext[]; selectedRepo: string;
  /** Per-repository selected context id, so switching repos restores each
   *  repo's active tab. Absent entries fall back to the repo's first context. */
  selectedContexts?: Record<string, string>;
  viewports: Record<string, Viewport>; theme: 'dark' | 'light' | 'system';
  /** Custom theme colours (normalized `#rrggbb`). Background themes the
   *  workspace canvas and the TUI grounds; accent themes Agent Hub chrome and
   *  the TUI cursor/selection. Absent means the per-mode defaults. */
  themeBackground?: string; themeAccent?: string;
}
export type TicketStatus = 'backlog' | 'planning' | 'ready' | 'in_progress' | 'needs_testing' | 'blocked' | 'completed'
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'
/** Agent-readable workspace ticket stored as an individual JSON file under
 *  `.agents-hub/tickets/`. */
export interface Ticket {
  id: string; title: string; status: TicketStatus; priority: TicketPriority;
  description: string; acceptance: string[]; agent: string; contextId: string; contextName: string;
  createdAt: string; updatedAt: string;
}
export interface Bootstrap { workspace: Workspace; error?: string }
export interface Bridge {
  invoke<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(listener: (workspace: Workspace) => void): () => void;
  desktop: boolean;
  onResource?: (listener: (resource: TerminalResource) => void) => () => void;
  onTickets?: (listener: (snapshot: { repo: string; tickets: Ticket[]; error?: string }) => void) => () => void;
  onBoard?: (listener: (snapshot: BoardSnapshot) => void) => () => void;
  onTerminal?: (listener: (event: {id:string; data?:string; seq?:number; exitCode?:number}) => void) => () => void;
  onFocusTerminal?: (listener: (id: string) => void) => () => void;
  onFocusNote?: (listener: (target: { repo: string; id: string }) => void) => () => void;
  terminalInput?: (id:string,data:string) => void;
  terminalResize?: (id:string,cols:number,rows:number) => void;
}
declare global { interface Window { agentHub?: Bridge } }
