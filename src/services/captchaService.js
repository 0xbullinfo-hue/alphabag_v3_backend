import { config } from '../config/env.js';

/**
 * Verifies Turnstile / hCaptcha token against Cloudflare / hCaptcha siteverify API.
 * Uses 5-second timeout and fails closed in production.
 *
 * @param {string} token - The captcha response token from client
 * @returns {Promise<{ valid: boolean, error?: string, status?: number }>}
 */
export async function verifyCaptcha(token) {
    const secret = process.env.CAPTCHA_SECRET_KEY;
    if (!secret) {
        if (config.isProduction) {
            return { valid: false, error: 'CAPTCHA service is not configured on server', status: 503 };
        }
        return { valid: true };
    }

    if (!token) {
        return { valid: false, error: 'CAPTCHA token required for this action', status: 400 };
    }

    try {
        const verifyUrl = process.env.CAPTCHA_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const response = await fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret, response: token }),
            signal: AbortSignal.timeout(5000)
        });
        const data = await response.json();
        return data.success
            ? { valid: true }
            : { valid: false, error: 'CAPTCHA verification failed', status: 400 };
    } catch (err) {
        console.error('[CAPTCHA] Verification error:', err);
        return { valid: false, error: 'CAPTCHA service unreachable', status: 502 };
    }
}

/**
 * Extracts captcha token from request body or header, and validates it.
 */
export async function verifyRequestCaptcha(req) {
    const token = req.body?.captchaToken || req.headers?.['x-captcha-token'];
    return verifyCaptcha(token);
}
