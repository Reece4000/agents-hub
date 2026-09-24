import type { Item, ApprovalRequestParams, UserInputRequestParams, ReasoningEffort } from '../server/generated/msp'
import type { BoardSnapshot } from '../shared/board'
export type { Item, ReasoningEffort }
export type TerminalKind = 'muse' | 'codex' | 'claude' | 'cursor' | 'shell' | 'custom'
/** Phase 1 task/resource identity (docs/PHASE-1-DESIGN.md §3). A task owns
 *  title, repository reference, drafts, and resources; a resource is one
 *  terminal process slot. Stable local ids stay separate from provider
 *  session ids (`museId`) and OS pids; `generation` bumps per spawn so
 *  stale supervisor events are recognizable. */
export type ResourceKind = TerminalKind
export interface TaskResource {
  resourceId: string
  kind: ResourceKind
  generation: number
  museId?: string
  running?: boolean
}
export interface LaunchOptions { model: string; reasoningEffort: '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'; approvalMode: 'untrusted' | 'on-request' | 'never'; permissionProfile: string; trustWorkspace: boolean; yolo: boolean }
export interface Attachment { id: string; name: string; mime: string; size: number; preview?: string; path?: string }
export interface Draft { html: string; text: string; attachments: Attachment[] }
export interface TerminalProfile { label: string; executable: string; args: string[] }
/** A terminal process slot within a named context. Custom profiles are
 *  launched as an executable plus argv; shell interpolation is never used. */
export interface TerminalResource {
  id: string; contextId: string; repo: string; name: string; agent: string;
  terminalKind: TerminalKind;
  profile?: TerminalProfile;
  launch?: LaunchOptions;
  draft: Draft;
  terminalRunning?: boolean;
  createdAt: string; updatedAt: string;
}
/** A durable group of terminals for one workspace task or area of work. */
export interface RepoContext {
  id: string; repo: string; name: string; terminals: TerminalResource[];
  /** Compatibility projection of the first terminal for older workspace readers. */
  terminalKind: TerminalKind; launch: LaunchOptions; draft: Draft; terminalRunning: boolean;
  createdAt: string; updatedAt: string;
}
/** Legacy v1 record: one Agent Hub row per imported Muse session. Kept so v1
 *  workspace files migrate; new code stores RepoContext instead. */
export interface Session {
  museId?: string; ephemeral?: boolean; activity?: 'messages' | 'empty' | 'unknown'; inspectedAt?: string; terminalRunning?: boolean; terminalKind?: TerminalKind; ownership?: 'external'; preview?: string;
  taskId?: string; resources?: TaskResource[];
  id: string; repo: string; title: string; updatedAt: string; model: string;
  status: 'idle' | 'running' | 'error'; turnId?: string; archived?: boolean;
  position: { x: number; y: number }; width: number; height: number;
  draft: Draft; effort: ReasoningEffort | 'max' | ''; items: Item[]; loaded?: boolean;
  error?: string; historyNote?: string; launch?: LaunchOptions;
  approvals: ApprovalRequestParams[]; questions: UserInputRequestParams[];
}
export interface Viewport { x: number; y: number; zoom: number }
export interface Workspace {
  connection?: string; version: 2; repos: string[]; contexts: RepoContext[]; selectedRepo: string;
  /** Per-repository selected context id, so switching repos restores each
   *  repo's active tab. Absent entries fall back to the repo's first context. */
  selectedContexts?: Record<string, string>;
  /** Legacy v1 sessions. Present only in unmigrated files; the store converts
   *  them to contexts on load and never writes this field back. */
  sessions?: Session[];
  viewports: Record<string, Viewport>; theme: 'dark' | 'light' | 'system';
  /** Custom theme colours (normalized `#rrggbb`). Background themes the
   *  workspace canvas and the TUI grounds; accent themes Agent Hub chrome and
   *  the TUI cursor/selection. Absent means the per-mode defaults. */
  themeBackground?: string; themeAccent?: string;
}
export interface Skill { id: string; name: string; description: string }
export type TicketStatus = 'backlog' | 'planning' | 'ready' | 'in_progress' | 'needs_testing' | 'blocked' | 'completed'
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'
/** Agent-readable workspace ticket stored as an individual JSON file under
 *  `.agents-hub/tickets/`. */
export interface Ticket {
  id: string; title: string; status: TicketStatus; priority: TicketPriority;
  description: string; acceptance: string[]; agent: string; contextId: string; contextName: string;
  createdAt: string; updatedAt: string;
}
export interface Bootstrap { workspace: Workspace; skills: Skill[]; models: { modelId: string; displayLabel: string }[]; host: string; error?: string }
export interface Bridge {
  invoke<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(listener: (workspace: Workspace) => void): () => void;
  desktop: boolean;
  onResource?: (listener: (resource: TerminalResource) => void) => () => void;
  onTickets?: (listener: (snapshot: { repo: string; tickets: Ticket[]; error?: string }) => void) => () => void;
  onBoard?: (listener: (snapshot: BoardSnapshot) => void) => () => void;
  onTerminal?: (listener: (event: {id:string; data?:string; seq?:number; exitCode?:number}) => void) => () => void;
  terminalInput?: (id:string,data:string) => void;
  terminalResize?: (id:string,cols:number,rows:number) => void;
}
declare global { interface Window { agentHub?: Bridge } }
