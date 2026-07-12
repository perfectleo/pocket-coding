// Push notification manager. Sends APNs (iOS) and FCM (Android) messages.
// Both providers are optional: if credentials are not configured, send() logs
// and returns silently. This keeps local dev working without a push setup.

import http2 from 'node:http2';
import { createSign } from 'node:crypto';
import { config } from '../config.js';
import type { Store } from '../store/sqlite.js';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export class PushManager {
  constructor(private readonly store: Store) {}

  async notifyDevice(deviceId: string, payload: PushPayload): Promise<void> {
    const tokens = this.store.listPushTokens(deviceId);
    if (tokens.length === 0) return;
    await Promise.all(
      tokens.map((t) =>
        t.platform === 'ios'
          ? this.sendApns(t.token, payload)
          : this.sendFcm(t.token, payload),
      ),
    );
  }

  private async sendApns(token: string, p: PushPayload): Promise<void> {
    const { apnsTeamId, apnsKeyId, apnsPrivateKey, apnsBundleId, apnsUseSandbox } = config.push;
    if (!apnsTeamId || !apnsKeyId || !apnsPrivateKey || !apnsBundleId) {
      return;
    }
    const host = apnsUseSandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    const path = `/3/device/${token}`;
    const jwt = this.signApnsJwt(apnsTeamId, apnsKeyId, apnsPrivateKey);
    const body = JSON.stringify({
      aps: {
        alert: { title: p.title, body: p.body },
        sound: 'default',
        'mutable-content': 1,
      },
      ...(p.data || {}),
    });

    return new Promise((resolve) => {
      const client = http2.connect(`https://${host}`, { rejectUnauthorized: true });
      client.on('error', () => { client.destroy(); resolve(); });
      const req = client.request({
        ':method': 'POST',
        ':path': path,
        'authorization': `bearer ${jwt}`,
        'apns-topic': apnsBundleId,
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      });
      req.write(body);
      req.end();
      req.on('response', () => { client.destroy(); resolve(); });
      req.on('error', () => { client.destroy(); resolve(); });
    });
  }

  private signApnsJwt(teamId: string, keyId: string, privateKeyPem: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString('base64url');
    const signer = createSign('SHA256');
    signer.update(`${header}.${payload}`);
    signer.end();
    const sig = signer.sign(privateKeyPem).toString('base64url');
    return `${header}.${payload}.${sig}`;
  }

  private async sendFcm(token: string, p: PushPayload): Promise<void> {
    const { fcmServiceAccount } = config.push;
    if (!fcmServiceAccount) return;
    let creds: { clientEmail: string; privateKey: string; projectId: string };
    try {
      creds = JSON.parse(fcmServiceAccount);
    } catch {
      return;
    }
    const accessToken = await this.getFcmAccessToken(creds);
    if (!accessToken) return;

    const url = `https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`;
    const body = JSON.stringify({
      message: {
        token,
        notification: { title: p.title, body: p.body },
        data: p.data,
        android: { priority: 'high' },
      },
    });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body,
      });
      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[push] FCM ${res.status}: ${errText.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[push] FCM error: ${(e as Error).message}`);
    }
  }

  private async getFcmAccessToken(creds: {
    clientEmail: string;
    privateKey: string;
    projectId: string;
  }): Promise<string | null> {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: creds.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url');
    const signer = createSign('SHA256');
    signer.update(`${header}.${payload}`);
    signer.end();
    const sig = signer.sign(creds.privateKey.replace(/\\n/g, '\n')).toString('base64url');
    const assertion = `${header}.${payload}.${sig}`;

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
      const j = (await res.json()) as { access_token?: string };
      return j.access_token ?? null;
    } catch {
      return null;
    }
  }
}
