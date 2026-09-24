/** Phase 0 executable contracts (AGENTIC-ROADMAP.md Phase 0 exit).
 *
 *  These tests lock the wire/transport facts later phases depend on, using the
 *  typed fixtures in ./msp-fixtures.ts. They run offline against the
 *  checked-in schema — no live host required.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { newRecord } from '../server/store'
import { foldEvent } from '../server/fold'
import {
  _sessionStartKeyGuard,
  approvalDecide,
  approvalPending,
  compactNoop,
  compactRequest,
  errApprovalStale,
  errCommandRejected,
  errSessionInUse,
  errViewTruncated,
  gapBracket,
  historyInline,
  historyNone,
  pageForward,
  questionAnswer,
  questionPending,
  resumeSuffixOnly,
  sessionStartFull,
  sessionStartMinimal,
  turnStartEffort,
  turnStartQueuedAck,
} from './msp-fixtures'

test('session/start carries workspace/model/approval/config only — no worktree, effort, or permission profile', () => {
  void _sessionStartKeyGuard
  for (const params of [sessionStartMinimal, sessionStartFull]) {
    const keys = Object.keys(params).sort()
    assert.ok(!keys.includes('worktree'), 'worktree is a CLI -w flag, not an MSP field')
    assert.ok(!keys.includes('reasoningEffort'), 'effort travels on turn/start')
    assert.ok(!keys.includes('permissionProfile'), 'permission profiles are CLI launch flags')
    assert.ok(!keys.includes('compactionStrategy'), 'no compaction strategy field exists')
    assert.match(params.commandId, /^[0-9a-f-]{36}$/, 'commandId is client-minted (UUIDv7)')
  }
  assert.deepEqual(
    Object.keys(sessionStartFull).sort(),
    ['approvalMode', 'commandId', 'config', 'modelId', 'providerId', 'workspaceRoot'],
  )
  assert.deepEqual(sessionStartFull.config, {}, 'config is reserved-empty in v1')
})

test('turn/start carries the reasoning tier; disposition is authoritative', () => {
  assert.equal(turnStartEffort.reasoningEffort, 'high')
  assert.ok(turnStartEffort.input.length > 0, 'input parts are required and non-empty')
  assert.equal(turnStartEffort.input[0].type, 'text')
  // The ack's disposition — not local derivation — decides queue/steer/start.
  assert.equal(turnStartQueuedAck.disposition, 'queued')
  assert.equal(turnStartQueuedAck.startedNewTurn, false)
  assert.equal(turnStartQueuedAck.status, 'accepted')
  assert.equal(turnStartQueuedAck.turnId, turnStartQueuedAck.commandId, 'fresh turnId derives from the submitting commandId')
})

test('approval decisions carry the live choiceId and requirementId guard', () => {
  const choiceIds = new Set(approvalPending.availableChoices.map(c => c.choiceId))
  assert.ok(choiceIds.has(approvalDecide.choiceId), 'decide must name a current availableChoices entry')
  assert.deepEqual(approvalDecide.requirementId, approvalPending.currentRequirementId)
  // Multi-stage approvals stay pending until settlement: updated folds keep,
  // resolved folds drop.
  const session = newRecord('s', '/tmp', 0)
  foldEvent(session, 'approval/requested', approvalPending)
  assert.equal(session.approvals.length, 1)
  foldEvent(session, 'approval/updated', { ...approvalPending })
  assert.equal(session.approvals.length, 1, 'partial updates refresh, never duplicate')
  foldEvent(session, 'approval/resolved', { approvalId: approvalPending.approvalId })
  assert.equal(session.approvals.length, 0)
})

test('questions survive reconnect: requested folds keep, settled folds drop, nothing auto-answers', () => {
  const session = newRecord('s', '/tmp', 0)
  foldEvent(session, 'userInput/requested', questionPending)
  assert.equal(session.questions.length, 1)
  assert.equal(questionAnswer.userInputId, questionPending.userInputId)
  assert.equal(questionAnswer.answers[0].questionId, questionPending.questions[0].id)
  foldEvent(session, 'userInput/settled', { userInputId: questionPending.userInputId })
  assert.equal(session.questions.length, 0)
})

test('history cursors are opaque: relayed, never parsed or ordered', () => {
  assert.equal(historyInline.mode, 'inline')
  assert.ok(historyInline.items?.length)
  assert.equal(historyNone.mode, 'none')
  assert.ok(historyNone.noneReason, 'none always carries a reason')
  // A resume with a cursor asks for the suffix only; the server reports what
  // it actually served in history.mode, never what was asked for.
  assert.ok(resumeSuffixOnly.cursor)
  // Gap brackets and page anchors are cursor pairs with session scope.
  assert.equal(gapBracket.sessionId, pageForward.sessionId)
  assert.ok(gapBracket.after && gapBracket.next && gapBracket.after !== gapBracket.next)
  assert.ok(pageForward.limit >= 1 && pageForward.limit <= 1000)
  assert.ok(pageForward.cursor && pageForward.cursor.length > 0)
  for (const cursor of [gapBracket.after, gapBracket.next, pageForward.cursor, resumeSuffixOnly.cursor]) {
    assert.equal(typeof cursor, 'string')
    assert.ok((cursor as string).length > 0)
  }
})

test('compact admission differs from outcome: noop is success, not error', () => {
  assert.equal(compactRequest.sessionId, 'ses_phase0')
  assert.equal(compactNoop.commandId, compactRequest.commandId)
  assert.equal(compactNoop.status, 'noop')
  assert.ok(compactNoop.reason, 'noop names why')
})

test('wire errors stay structured: code plus kind/data, never message parsing', () => {
  for (const error of [errSessionInUse, errApprovalStale, errCommandRejected, errViewTruncated]) {
    assert.equal(typeof error.code, 'number')
    assert.ok(error.data?.kind, 'kind is always present when data is')
    assert.ok(error.message.length > 0)
  }
  assert.equal(errSessionInUse.data?.kind, 'sessionInUse')
  assert.equal(errSessionInUse.data?.sessionId, 'ses_phase0')
  assert.deepEqual(errApprovalStale.data?.currentRequirementId, {
    approvalId: 'apr_phase0',
    sourceIndex: 1,
  })
  assert.equal(errCommandRejected.data?.commandId, turnStartQueuedAck.commandId)
  assert.ok('earliestCursor' in (errViewTruncated.data ?? {}), 'truncation names the oldest servable cursor')
})
