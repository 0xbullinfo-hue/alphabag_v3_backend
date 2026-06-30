import { execSync } from 'child_process';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function runMigration() {
    console.log("[MIGRATE] Connecting to database using pg Pool...");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    let adminsToMigrate = [];
    
    try {
        // Query users table for admin users using raw SQL so schema definition does not block us
        const res = await pool.query("SELECT * FROM users WHERE email = 'adminbx1p@alphabagpro.com' OR \"isAdmin\" = true");
        adminsToMigrate = res.rows;
        console.log(`[MIGRATE] Found ${adminsToMigrate.length} admin accounts to migrate:`, adminsToMigrate.map(a => a.email));
    } catch (e) {
        console.log("[MIGRATE] Could not query users for admins, perhaps they were already migrated or columns don't exist yet:", e.message);
    }

    // If no admin accounts found in DB, let's look at users.json just in case
    if (adminsToMigrate.length === 0) {
        try {
            const fs = await import('fs/promises');
            const path = await import('path');
            const { fileURLToPath } = await import('url');
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const usersJsonPath = path.join(__dirname, '../../data/users.json');
            
            const data = await fs.readFile(usersJsonPath, 'utf-8');
            const users = JSON.parse(data);
            const jsonAdmins = users.filter(u => u.isAdmin || u.email === 'adminbx1p@alphabagpro.com');
            console.log(`[MIGRATE] Found ${jsonAdmins.length} admin accounts in users.json`);
            for (const a of jsonAdmins) {
                if (a.email && a.password) {
                    adminsToMigrate.push(a);
                }
            }
        } catch (e) {
            console.log("[MIGRATE] Could not read users.json:", e.message);
        }
    }

    // Default fallback admin if absolutely none found
    if (adminsToMigrate.length === 0) {
        console.log("[MIGRATE] No admins found anywhere. Preparing default admin credentials...");
        const hashedPassword = await bcrypt.hash('admin123', 10);
        adminsToMigrate.push({
            email: 'adminbx1p@alphabagpro.com',
            password: hashedPassword
        });
    }

    console.log("[MIGRATE] Running Prisma schema push...");
    try {
        execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit', cwd: '/var/www/html/alphabag_v3_backend' });
        console.log("[MIGRATE] Prisma db push successful.");
    } catch (err) {
        console.error("[MIGRATE] Prisma db push failed:", err.message);
        process.exit(1);
    }

    console.log("[MIGRATE] Regenerating Prisma client...");
    try {
        execSync('npx prisma generate', { stdio: 'inherit', cwd: '/var/www/html/alphabag_v3_backend' });
        console.log("[MIGRATE] Prisma client generation successful.");
    } catch (err) {
        console.error("[MIGRATE] Prisma client generation failed:", err.message);
        process.exit(1);
    }

    console.log("[MIGRATE] Inserting admin accounts into the new admins table...");
    for (const admin of adminsToMigrate) {
        try {
            const id = admin.id || 'admin_' + Date.now();
            await pool.query(
                'INSERT INTO admins (id, email, password, "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW()) ON CONFLICT (email) DO UPDATE SET password = $3',
                [id, admin.email, admin.password]
            );
            console.log(`[MIGRATE] Successfully migrated/inserted admin: ${admin.email}`);
        } catch (err) {
            console.error(`[MIGRATE] Failed to insert admin ${admin.email}:`, err.message);
        }
    }

    console.log("[MIGRATE] Closing database pool.");
    await pool.end();
    console.log("[MIGRATE] Migration complete!");
}

runMigration().catch(console.error);
