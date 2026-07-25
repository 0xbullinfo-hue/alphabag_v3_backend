/**
 * Seed or reset an admin account. Run locally with direct database
 * access — this is intentionally NOT an HTTP endpoint. The previous
 * implementation (GET /api/db-seed-admin, guarded only by a secret
 * hardcoded in source) allowed anyone who had ever seen the repo to
 * create or take over an admin account. Don't reintroduce this over
 * HTTP, even behind auth — bootstrapping the first admin account is a
 * one-time operational task, not a product feature.
 *
 * Usage:
 *   node src/scripts/seed-admin.js admin@alphabagpro.com 'a-strong-password'
 *
 * Requires DATABASE_URL to be set in the environment (same as the
 * running server would use).
 */
import bcrypt from 'bcryptjs';
import { store } from '../services/storeService.js';

async function main() {
    const [, , email, password] = process.argv;

    if (!email || !password) {
        console.error('Usage: node src/scripts/seed-admin.js <email> <password>');
        process.exit(1);
    }
    if (password.length < 12) {
        console.error('Refusing to seed an admin with a password under 12 characters.');
        process.exit(1);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const existing = await store.findOne('admins', { email });

    if (existing) {
        await store.update('admins', a => a.email === email, a => ({
            password: hashedPassword,
            updatedAt: new Date().toISOString(),
        }));
        console.log(`Admin ${email} password updated.`);
    } else {
        await store.create('admins', {
            id: 'admin_' + Date.now(),
            email,
            password: hashedPassword,
            createdAt: new Date().toISOString(),
        });
        console.log(`Admin ${email} created.`);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
