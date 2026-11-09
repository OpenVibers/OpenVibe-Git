'use strict';

/** Seal a push-mirror token at rest (AES-256-GCM; the key is sha256(GIT_SECRET_KEY)). Never logged, never shown. */
const crypto = require('node:crypto');

const keyOf = (secret) => crypto.createHash('sha256').update(String(secret || '')).digest();

function seal(text, secret) {
    if (!text) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
    const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${body.toString('base64url')}`;
}

function open(sealed, secret) {
    if (!sealed) return null;
    const [v, ivB64, tagB64, bodyB64] = String(sealed).split('.');
    if (v !== 'v1' || !ivB64 || !tagB64 || !bodyB64) return null;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(ivB64, 'base64url'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64url')), decipher.final()]).toString('utf8');
    } catch { return null; }
}

module.exports = { seal, open };
