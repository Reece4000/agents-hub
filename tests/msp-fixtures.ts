/** Phase 0 typed fixtures for the MSP wire contract (Muse 1.0.3, stable surface).
 *
 *  These lock the executable contracts later phases build on: session/turn
 *  admission shapes, approval/question settlement, history/gap recovery, and
 *  structured wire errors. They are hand-written against
 *  `server/generated/msp.d.ts` (verified identical to
 *  `muse schema generate-ts` output for this binary) so tests can exercise
 *  failure paths without a live host.
 */
import type {
  ApprovalDecideParams,
  ApprovalRequestParams,
  ErrorObject,
  SessionCompactParams,
  SessionCompactResult,
  SessionHistory,
  SessionResumeParams,
  SessionStartParams,
  TurnStartParams,
  TurnStartResult,
  UserInputAnswerParams,
  UserInputRequestParams,
  ViewGapParams,
  ViewPageParams,
} from '../server/generated/msp'

/** Minimal durable session/start: the server mints the id, defaults apply. */
export const sessionStartMinimal: SessionStartParams = {
  commandId: '0196a5f0-0000-7000-8000-000000000001',
  workspaceRoot: '/tmp/agent-hub-phase0',
}

/** Full session/start. Note what is ABSENT by contract: no worktree, effort,
 *  permission-profile, or compaction-strategy field exists on this method.
 *  Effort travels on turn/start; worktree isolation is a CLI `-w` flag, not
 *  an MSP field. */
export const sessionStartFull: SessionStartParams = {
  commandId: '0196a5f0-0000-7000-8000-000000000002',
  workspaceRoot: '/tmp/agent-hub-phase0',
  modelId: 'default',
  providerId: null,
  approvalMode: 'promptUnmatched',
  config: {},
}

/** Compile-time guard: SessionStartParams must not grow CLI-invented fields.
 *  If a future schema adds a member, the ExactKeys assertion below fails and
 *  forces a deliberate contract review instead of silent drift. */
type ExactKeys<T, Expected extends keyof T> = Exclude<keyof T, Expected> extends never
  ? Expected extends keyof T
    ? unknown
    : never
  : never
export const _sessionStartKeyGuard: ExactKeys<
  SessionStartParams,
  'approvalMode' | 'commandId' | 'config' | 'modelId' | 'providerId' | 'sessionId' | 'workspaceRoot'
> = undefined as unknown as undefined

/** turn/start carries the reasoning tier sampled at submission. */
export const turnStartEffort: TurnStartParams = {
  commandId: '0196a5f0-0000-7000-8000-000000000003',
  sessionId: 'ses_phase0',
  reasoningEffort: 'high',
  input: [{ type: 'text', text: 'Reply with exactly AGENT_HUB_OK. Do not use tools.' }],
}

/** Queue-while-busy admission: disposition is authoritative, not derived. */
export const turnStartQueuedAck: TurnStartResult = {
  commandId: '0196a5f0-0000-7000-8000-000000000004',
  disposition: 'queued',
  startedNewTurn: false,
  status: 'accepted',
  turnId: '0196a5f0-0000-7000-8000-000000000004',
}

/** A pending tool approval: decide with the CURRENT choiceId and
 *  currentRequirementId, never a hard-coded binary allow/deny. */
const range = {
  first: { id: 'rec_phase0_1', sequence: 1 },
  last: { id: 'rec_phase0_1', sequence: 1 },
  stream: { id: 'run_phase0', kind: 'run' },
}

export const approvalPending: ApprovalRequestParams = {
  approvalId: 'apr_phase0',
  availableChoices: [
    { choiceId: 'allow-once', decision: 'approved', label: 'Allow once', scope: 'once' },
    { choiceId: 'deny', decision: 'denied', label: 'Deny', scope: 'once' },
  ],
  currentRequirementId: { approvalId: 'apr_phase0', sourceIndex: 0 },
  itemId: 'item_phase0',
  judgeEscalated: false,
  protectedWrite: false,
  rawArgs: '{"command":"ls"}',
  sessionId: 'ses_phase0',
  sourceRange: range,
  subject: { kind: 'shell', command: 'ls' },
  taskId: 'task_phase0',
  toolCallId: 'call_phase0',
  toolName: 'shell',
  turnId: 'turn_phase0',
  viewCursor: 'cursor:phase0:1',
}

export const approvalDecide: ApprovalDecideParams = {
  approvalId: approvalPending.approvalId,
  choiceId: 'allow-once',
  commandId: '0196a5f0-0000-7000-8000-000000000005',
  requirementId: { ...approvalPending.currentRequirementId },
  sessionId: 'ses_phase0',
}

/** An unanswered question: reconnect must neither lose nor auto-answer it. */
export const questionPending: UserInputRequestParams = {
  userInputId: 'inq_phase0',
  sessionId: 'ses_phase0',
  turnId: 'turn_phase0',
  itemId: 'item_phase0',
  toolCallId: 'call_phase0',
  toolName: 'shell',
  questions: [
    {
      header: 'Working directory',
      id: 'q0',
      options: [{ label: 'Repository root' }, { label: 'Current directory' }],
      question: 'Where should this command run?',
      selection: { mode: 'single' },
    },
  ],
  viewCursor: 'cursor:phase0:2',
}

export const questionAnswer: UserInputAnswerParams = {
  commandId: '0196a5f0-0000-7000-8000-000000000006',
  sessionId: 'ses_phase0',
  userInputId: 'inq_phase0',
  answers: [{ questionId: 'q0', freeText: 'Use the existing helper.' }],
}

/** History envelopes: inline items, snapshot-at-cursor, and none-with-reason.
 *  Cursors are opaque: clients relay them, never parse or order them. */
export const historyInline: SessionHistory = {
  items: [{ itemId: 'm1', kind: 'userMessage', status: 'completed', revision: 1, text: 'Hello' }],
  mode: 'inline',
  snapshot: null,
}

export const historyNone: SessionHistory = {
  items: null,
  mode: 'none',
  noneReason: 'excluded',
  snapshot: null,
}

export const resumeSuffixOnly: SessionResumeParams = {
  commandId: '0196a5f0-0000-7000-8000-000000000007',
  sessionId: 'ses_phase0',
  cursor: 'cursor:phase0:9',
}

/** Gap recovery bracket: page (after, next) forward, discard overlap, splice —
 *  or re-anchor. The server holds no partial-fill state. */
export const gapBracket: ViewGapParams = {
  after: 'cursor:phase0:10',
  next: 'cursor:phase0:20',
  sessionId: 'ses_phase0',
}

export const pageForward: ViewPageParams = {
  cursor: 'cursor:phase0:10',
  direction: 'forward',
  limit: 100,
  sessionId: 'ses_phase0',
}

/** Manual compaction: ack is admission-only; noop is success, not error. */
export const compactRequest: SessionCompactParams = {
  commandId: '0196a5f0-0000-7000-8000-000000000008',
  sessionId: 'ses_phase0',
}

export const compactNoop: SessionCompactResult = {
  commandId: compactRequest.commandId,
  reason: 'no_compactable_history',
  status: 'noop',
}

/** Structured wire errors. `MspClient` today flattens these into text
 *  (message + JSON data); Phase 3 must retain code/kind/data so callers can
 *  branch without parsing strings. */
export const errSessionInUse: ErrorObject = {
  code: -32021,
  message: 'Session is already active in another window.',
  data: { kind: 'sessionInUse', sessionId: 'ses_phase0', retryable: false },
}

export const errApprovalStale: ErrorObject = {
  code: -32053,
  message: 'The approval requirement is stale; refresh and decide again.',
  data: {
    kind: 'approvalRequirementStale',
    approvalId: 'apr_phase0',
    currentRequirementId: { approvalId: 'apr_phase0', sourceIndex: 1 },
    retryable: false,
  },
}

export const errCommandRejected: ErrorObject = {
  code: -32030,
  message: 'Command rejected.',
  data: {
    kind: 'commandRejected',
    commandId: '0196a5f0-0000-7000-8000-000000000004',
    reason: 'duplicate_turn',
    retryable: false,
  },
}

export const errViewTruncated: ErrorObject = {
  code: -32040,
  message: 'The requested view position is no longer servable.',
  data: { kind: 'viewTruncated', earliestCursor: 'cursor:phase0:5', retryable: false },
}
