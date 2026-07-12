import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store, CheckpointRow } from '../store/sqlite.js';
import type { DiffHunk } from '../protocol.js';
import { newId } from '../gateway/auth.js';
import {
  commitAll,
  diffNameOnly,
  diffRaw,
  headRef,
  initShadow,
  restoreFromCommit,
  shadowExists,
} from './git.js';

const execFileP = promisify(execFile);

export interface SnapshotResult {
  cpId: string;
  shadowCommit: string;
  files: Array<{ path: string; added: number; removed: number }>;
}

export async function ensureShadow(cwd: string, store: Store, sessionId: string): Promise<void> {
  if (!shadowExists(cwd)) {
    await initShadow(cwd);
    const ref = await headRef(cwd);
    store.updateSessionBaseline(sessionId, ref);
  }
}

export async function snapshot(
  cwd: string,
  store: Store,
  sessionId: string,
  turnId: string,
): Promise<SnapshotResult> {
  await ensureShadow(cwd, store, sessionId);
  const baseline = store.getSession(sessionId)?.baseline_ref ?? (await headRef(cwd));
  const shadowCommit = await commitAll(cwd, `turn-${turnId}`);
  const changedPaths = await diffNameOnly(cwd, baseline, shadowCommit);
  const files = await Promise.all(
    changedPaths.map(async (p) => {
      const stat = await fileStat(cwd, baseline, shadowCommit, p);
      return { path: p, added: stat.added, removed: stat.removed };
    }),
  );
  const cpId = newId('cp');
  const row: CheckpointRow = {
    id: cpId,
    session_id: sessionId,
    turn_id: turnId,
    shadow_commit: shadowCommit,
    status: 'pending',
    files: JSON.stringify(files),
    created_at: Date.now(),
  };
  store.createCheckpoint(row);
  return { cpId, shadowCommit, files };
}

export async function computeDiff(
  cwd: string,
  store: Store,
  sessionId: string,
  cpId?: string,
  files?: string[],
): Promise<DiffHunk[]> {
  await ensureShadow(cwd, store, sessionId);
  const baseline = store.getSession(sessionId)?.baseline_ref ?? (await headRef(cwd));
  let base = baseline;
  if (cpId) {
    const cp = store.getCheckpoint(cpId);
    if (!cp) throw new Error('checkpoint_not_found');
    base = cp.shadow_commit;
  }
  const raw = await diffRaw(cwd, base, files);
  return parseUnifiedDiff(raw);
}

export async function accept(
  cwd: string,
  store: Store,
  sessionId: string,
  cpId: string,
  files?: string[],
): Promise<void> {
  const cp = store.getCheckpoint(cpId);
  if (!cp) throw new Error('checkpoint_not_found');
  if (cp.session_id !== sessionId) throw new Error('checkpoint_session_mismatch');

  if (files && files.length > 0) {
    // Partial accept: restore only the listed files from this checkpoint's shadow commit,
    // then commit a new baseline that advances with just those files.
    await restoreFromCommit(cwd, cp.shadow_commit, files);
    await commitAll(cwd, `accept-${cpId}-partial`);
    const newBaseline = await headRef(cwd);
    store.updateSessionBaseline(sessionId, newBaseline);
  } else {
    // Full accept: baseline jumps to this checkpoint's commit.
    store.updateSessionBaseline(sessionId, cp.shadow_commit);
    // Make shadow HEAD point at this commit so the work-tree and baseline agree.
    try {
      await execFileP('git', [
        `--git-dir=${cwd}/.pocket/shadow.git`,
        'reset', '--soft', cp.shadow_commit,
      ]);
    } catch {
      // non-fatal
    }
  }
  store.updateCheckpointStatus(cpId, 'accepted');
  // Mark earlier pending checkpoints as superseded — we only keep 'accepted'/'rolledback' history.
  const earlier = store.listCheckpoints(sessionId);
  for (const e of earlier) {
    if (e.id !== cpId && e.status === 'pending' && e.created_at <= cp.created_at) {
      store.updateCheckpointStatus(e.id, 'rolledback');
    }
  }
}

export async function rollback(
  cwd: string,
  store: Store,
  sessionId: string,
  cpId: string,
): Promise<void> {
  const cp = store.getCheckpoint(cpId);
  if (!cp) throw new Error('checkpoint_not_found');
  if (cp.session_id !== sessionId) throw new Error('checkpoint_session_mismatch');
  await restoreFromCommit(cwd, cp.shadow_commit);
  await commitAll(cwd, `rollback-${cpId}`);
  store.updateCheckpointStatus(cpId, 'rolledback');
  // Mark later pending checkpoints as rolledback (their changes are gone now).
  const all = store.listCheckpoints(sessionId);
  for (const c of all) {
    if (c.created_at > cp.created_at && c.status === 'pending') {
      store.updateCheckpointStatus(c.id, 'rolledback');
    }
  }
}

// ---------- diff parsing ----------

interface FileStat { added: number; removed: number; }

async function fileStat(cwd: string, base: string, head: string, file: string): Promise<FileStat> {
  // Use --numstat to get added/removed counts per file.
  const { stdout } = await execFileP(
    'git',
    [`--git-dir=${cwd}/.pocket/shadow.git`, 'diff', '--numstat', base, head, '--', file],
    { maxBuffer: 8 * 1024 * 1024 },
  ).catch(() => ({ stdout: '' }));
  const m = stdout.match(/^(\d+|-)\s+(\d+|-)\s+/);
  const added = m && m[1] !== '-' ? Number(m[1]) : 0;
  const removed = m && m[2] !== '-' ? Number(m[2]) : 0;
  return { added, removed };
}

function parseUnifiedDiff(raw: string): DiffHunk[] {
  if (!raw.trim()) return [];
  const out: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let hunk: DiffHunk['hunks'][number] | null = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (hunk && cur) cur.hunks.push(hunk);
      if (cur) out.push(cur);
      cur = null;
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      // could be "/dev/null" or "a/path"
      const p = line.slice(4).replace(/^a\//, '');
      if (p === '/dev/null') continue;
      if (!cur) {
        cur = { file: p, hunks: [], added: 0, removed: 0 };
      } else if (!cur.file || cur.file === '/dev/null') {
        cur.file = p;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      if (p === '/dev/null') continue;
      if (!cur) {
        cur = { file: p, hunks: [], added: 0, removed: 0 };
      } else if (!cur.file || cur.file === '/dev/null') {
        cur.file = p;
      }
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (hunk && cur) cur.hunks.push(hunk);
      hunk = { header: line, lines: [] };
      const m = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      continue;
    }
    if (!hunk || !cur) continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', newNo: ++newNo, text: line.slice(1) });
      cur.added++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', oldNo: ++oldNo, text: line.slice(1) });
      cur.removed++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ type: 'ctx', oldNo: ++oldNo, newNo: ++newNo, text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    }
  }
  if (hunk && cur) cur.hunks.push(hunk);
  if (cur) out.push(cur);
  return out;
}
