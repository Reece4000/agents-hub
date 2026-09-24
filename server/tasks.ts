import { v7 as uuid } from 'uuid'
import type { Session, TaskResource } from '../src/types'

/** Phase 1 task migration (docs/PHASE-1-DESIGN.md §3, §7). Existing session
 *  ids are kept verbatim as task ids; each record gains one default
 *  resource slot of its current kind. Additive and idempotent: records that
 *  already carry identity pass through untouched, and old builds ignore the
 *  new fields (their JSON round-trip preserves them), so rollback is the
 *  previous release. No PTY launches happen here. */

export function defaultResourceFor(session: Pick<Session, 'terminalKind'>): TaskResource {
  return {
    resourceId: `res-${uuid()}`,
    kind: session.terminalKind === 'shell' ? 'shell' : 'muse',
    generation: 0,
  }
}

export function ensureTaskIdentity(session: Session): Session {
  if (!session.taskId) session.taskId = session.id
  if (!session.resources) session.resources = [defaultResourceFor(session)]
  return session
}

export function migrateSessionsToTasks(sessions: Session[]): { migrated: number } {
  let migrated = 0
  for (const session of sessions) {
    if (!session.taskId || !session.resources) {
      ensureTaskIdentity(session)
      migrated++
    }
  }
  return { migrated }
}
