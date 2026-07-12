import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

// JWT secret must survive server restarts, otherwise every restart
// invalidates all paired device tokens and users get "配对失败" on WS
// reconnect. Persist it to <dataDir>/jwt-secret; generate on first run.
// POCKET_JWT_SECRET env var still wins if set.
function resolveJwtSecret(dataDir: string): string {
  const envVal = process.env.POCKET_JWT_SECRET;
  if (envVal && envVal.length > 0) return envVal;
  const file = join(dataDir, 'jwt-secret');
  try {
    if (existsSync(file)) {
      const s = readFileSync(file, 'utf8').trim();
      if (s) return s;
    }
  } catch {
    // fall through to generate
  }
  const fresh = randomBytes(32).toString('hex');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, fresh, { mode: 0o600 });
  } catch {
    // If we can't persist, fall back to in-memory (tokens reset on restart).
  }
  return fresh;
}

const _dataDir = env('POCKET_DATA_DIR', join(homedir(), '.pocket'));

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  dataDir: _dataDir,
  jwtSecret: resolveJwtSecret(_dataDir),
  jwtTtlSec: Number(env('POCKET_JWT_TTL_SEC', String(60 * 60 * 24 * 30))),
  pairTtlMs: Number(env('POCKET_PAIR_TTL_MS', String(10 * 60 * 1000))),
  pairFailWindowMs: Number(env('POCKET_PAIR_FAIL_WINDOW_MS', String(5 * 60 * 1000))),
  pairFailMax: Number(env('POCKET_PAIR_FAIL_MAX', '3')),
  pairFailLockMs: Number(env('POCKET_PAIR_FAIL_LOCK_MS', String(15 * 60 * 1000))),
  scrollbackBytes: Number(env('POCKET_SCROLLBACK_BYTES', String(256 * 1024))),
  workspacesDir: env('POCKET_WORKSPACES_DIR', process.cwd()),
  approvalTimeoutMs: Number(env('POCKET_APPROVAL_TIMEOUT_MS', String(60 * 1000))),
  push: {
    apnsTeamId: env('POCKET_APNS_TEAM_ID', ''),
    apnsKeyId: env('POCKET_APNS_KEY_ID', ''),
    apnsPrivateKey: env('POCKET_APNS_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
    apnsBundleId: env('POCKET_APNS_BUNDLE_ID', ''),
    apnsUseSandbox: env('POCKET_APNS_USE_SANDBOX', 'true') === 'true',
    fcmServiceAccount: env('POCKET_FCM_SERVICE_ACCOUNT', ''),
  },
};

export const dbPath = join(config.dataDir, 'pocket.db');
