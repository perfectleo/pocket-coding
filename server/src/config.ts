import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  dataDir: env('POCKET_DATA_DIR', join(homedir(), '.pocket')),
  jwtSecret: env('POCKET_JWT_SECRET', randomBytes(32).toString('hex')),
  jwtTtlSec: Number(env('POCKET_JWT_TTL_SEC', String(60 * 60 * 24 * 30))),
  pairTtlMs: Number(env('POCKET_PAIR_TTL_MS', String(10 * 60 * 1000))),
  pairFailWindowMs: Number(env('POCKET_PAIR_FAIL_WINDOW_MS', String(5 * 60 * 1000))),
  pairFailMax: Number(env('POCKET_PAIR_FAIL_MAX', '3')),
  pairFailLockMs: Number(env('POCKET_PAIR_FAIL_LOCK_MS', String(15 * 60 * 1000))),
  scrollbackBytes: Number(env('POCKET_SCROLLBACK_BYTES', String(256 * 1024))),
  workspacesDir: env('POCKET_WORKSPACES_DIR', join(homedir(), 'projects')),
};

export const dbPath = join(config.dataDir, 'pocket.db');
