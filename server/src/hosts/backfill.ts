// Transcript backfill — reconciles a Pocket session's SQLite message log with
// the AI tool's own on-disk session file (the single source of truth).
//
// Two entry points:
//   backfillSession()  — full import for a freshly-imported desktop session.
//   reconcileSession() — incremental catch-up: append only turns that happened
//                        in the desktop terminal since we last looked.
//
// Both are idempotent via messages.external_turn_ref (see store.hasExternalRef).

import { newId } from '../gateway/auth.js';
import type { Store, SessionRow } from '../store/sqlite.js';
import type { ToolId } from '../protocol.js';
import { findHostSession } from './session-scanner.js';
import { parseTranscript, type TranscriptEntry } from './transcript-loader.js';

function roleToMessageRole(entry: TranscriptEntry): 'user' | 'assistant' | 'system' {
  return entry.role;
}

function entryToRow(
  sessionId: string,
  seq: number,
  entry: TranscriptEntry,
): Parameters<Store['appendMessage']>[0] {
  const isUserText = entry.event.type === 'text';
  return {
    id: newId('m'),
    session_id: sessionId,
    seq,
    role: roleToMessageRole(entry),
    type: isUserText ? 'text' : entry.event.type,
    payload: JSON.stringify(entry.event.type === 'text' ? { text: entry.event.text } : entry.event),
    turn_id: null,
    created_at: entry.createdAt || Date.now(),
    source: 'external',
    external_turn_ref: entry.ref,
  };
}

interface BackfillResult {
  imported: number;
  total: number;
  lastSeq: number;
}

function applyEntries(
  store: Store,
  sessionId: string,
  entries: TranscriptEntry[],
): BackfillResult {
  let seq = store.maxSeq(sessionId);
  let imported = 0;
  for (const entry of entries) {
    if (store.hasExternalRef(sessionId, entry.ref)) continue;
    seq += 1;
    store.appendMessage(entryToRow(sessionId, seq, entry));
    imported += 1;
  }
  if (imported > 0) {
    store.updateSessionLastSeq(sessionId, seq);
  }
  return { imported, total: entries.length, lastSeq: seq };
}

/** Full backfill for a session whose externalSessionId points at a host
 *  transcript. Returns counts, or null if the transcript file is missing. */
export function backfillSession(
  store: Store,
  opts: { sessionId: string; toolId: ToolId; externalSessionId: string },
): BackfillResult | null {
  const host = findHostSession(opts.externalSessionId, opts.toolId);
  if (!host) return null;
  const transcript = parseTranscript(opts.toolId, host.filePath, host.updatedAt);
  return applyEntries(store, opts.sessionId, transcript.entries);
}

/** Incremental reconcile — same as backfill but a no-op for turns already
 *  recorded. Safe to call on every attach / message fetch. */
export function reconcileSession(store: Store, row: SessionRow): BackfillResult | null {
  if (!row.external_session_id) return null;
  return backfillSession(store, {
    sessionId: row.id,
    toolId: row.tool_id as ToolId,
    externalSessionId: row.external_session_id,
  });
}
