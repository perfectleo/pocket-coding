import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
const enc = new TextEncoder();
const key = enc.encode(config.jwtSecret);
export async function signDeviceToken(deviceId) {
    const expiresAt = Math.floor(Date.now() / 1000) + config.jwtTtlSec;
    const token = await new SignJWT({ deviceId, kind: 'device' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(key);
    return { token, expiresAt: expiresAt * 1000 };
}
export async function verifyToken(token) {
    try {
        const { payload } = await jwtVerify(token, key);
        if (payload.kind !== 'device' || typeof payload.deviceId !== 'string')
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
export function generatePairCode() {
    const n = randomBytes(3).readUIntBE(0, 3) % 1_000_000;
    return n.toString().padStart(6, '0');
}
export function newDeviceId() {
    return randomUUID();
}
export function newSessionId() {
    return 's_' + randomUUID().replace(/-/g, '').slice(0, 16);
}
export function newId(prefix) {
    return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 12);
}
// Generate a short-lived preview token derived from device token.
export function generatePreviewToken() {
    return 'pv_' + randomBytes(12).toString('base64url');
}
export async function authenticate(token, store) {
    if (!token)
        return null;
    const payload = await verifyToken(token);
    if (!payload)
        return null;
    const device = store.getDevice(payload.deviceId);
    if (!device)
        return null;
    store.touchDevice(payload.deviceId);
    return { deviceId: payload.deviceId };
}
export function bearerOf(authHeader) {
    if (!authHeader)
        return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    return m ? m[1] : undefined;
}
//# sourceMappingURL=auth.js.map