import crypto from 'crypto';
import { config } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const getEncryptionKey = () => {
    if (!config.cexEncryptionKey || !/^[a-fA-F0-9]{64}$/.test(config.cexEncryptionKey)) {
        throw new Error('CEX_ENCRYPTION_KEY must be a 64-character hexadecimal AES-256 key');
    }
    return Buffer.from(config.cexEncryptionKey, 'hex');
};

export const encryptCredential = (value) => {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
};

export const decryptCredential = (payload) => {
    const encoded = Buffer.from(payload, 'base64');
    if (encoded.length <= IV_BYTES + AUTH_TAG_BYTES) {
        throw new Error('Stored credential is malformed');
    }
    const iv = encoded.subarray(0, IV_BYTES);
    const authTag = encoded.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const encrypted = encoded.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};