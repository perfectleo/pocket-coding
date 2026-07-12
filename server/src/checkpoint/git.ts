import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const GIT_USER_NAME = 'pocket';
const GIT_USER_EMAIL = 'pocket@local';

function shadowDir(cwd: string): string {
  return join(cwd, '.pocket', 'shadow.git');
}

function baseArgs(cwd: string): string[] {
  return [
    `--git-dir=${shadowDir(cwd)}`,
    `--work-tree=${cwd}`,
    '-c', `user.name=${GIT_USER_NAME}`,
    '-c', `user.email=${GIT_USER_EMAIL}`,
  ];
}

async function git(cwd: string, sub: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const args = [...baseArgs(cwd), ...sub];
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 15_000,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`git ${sub.join(' ')} failed: ${e.stderr || e.message || 'unknown'}`);
  }
}

export function shadowExists(cwd: string): boolean {
  return existsSync(shadowDir(cwd));
}

export async function initShadow(cwd: string): Promise<void> {
  if (shadowExists(cwd)) return;
  mkdirSync(join(cwd, '.pocket'), { recursive: true });
  await execFileP('git', ['init', '--bare', shadowDir(cwd)], { maxBuffer: 8 * 1024 * 1024 });
  // Initial baseline snapshot — never track .pocket itself.
  await git(cwd, ['add', '-A', '--', ':!/.pocket']);
  try {
    await git(cwd, ['commit', '-m', 'pocket-baseline', '--allow-empty']);
  } catch {
    // Empty workdir: force an empty commit so we still have a baseline ref.
    await git(cwd, ['commit', '--allow-empty', '-m', 'pocket-baseline']);
  }
}

export async function headRef(cwd: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', 'HEAD']);
  return out.trim();
}

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '-A', '--', ':!/.pocket']);
  try {
    await git(cwd, ['commit', '-m', message, '--allow-empty']);
  } catch {
    // Nothing to commit — return current HEAD as the "snapshot".
  }
  return headRef(cwd);
}

export async function diffNameOnly(cwd: string, base: string, head: string | null): Promise<string[]> {
  const args = head ? ['diff', '--name-only', base, head, '--', ':!/.pocket'] : ['diff', '--name-only', base, '--', ':!/.pocket'];
  const out = await git(cwd, args);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function diffRaw(cwd: string, base: string, files?: string[]): Promise<string> {
  const args = ['diff', base];
  if (files && files.length > 0) args.push('--', ...files);
  else args.push('--', ':!/.pocket');
  return git(cwd, args);
}

export async function restoreFromCommit(cwd: string, commit: string, files?: string[]): Promise<void> {
  if (files && files.length > 0) {
    // Partial restore — checkout only listed files from that commit.
    await git(cwd, ['checkout', commit, '--', ...files]);
    return;
  }
  // Full restore: reset index to that commit, force-checkout work-tree to match,
  // then clean untracked files (except .pocket/).
  await git(cwd, ['reset', '--hard', commit, '--']);
  // `reset --hard` already touches work-tree; `clean -fd` removes untracked dirs/files.
  try {
    await git(cwd, ['clean', '-fd', '-e', '/.pocket']);
  } catch {
    // clean failure (no untracked) is non-fatal
  }
}

export async function listCommits(cwd: string, limit = 50): Promise<string[]> {
  const out = await git(cwd, ['log', `--max-count=${limit}`, '--format=%H']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function pruneOlderThan(cwd: string, keepRef: string): Promise<void> {
  // Keep `keepRef` and everything reachable from it; GC the rest.
  // We don't actually expire commits (they're cheap), but we drop orphan refs.
  try {
    await git(cwd, ['gc', '--auto', '--prune=now']);
    void keepRef;
  } catch {
    // GC failures are non-fatal.
  }
}
