
import bcrypt from 'bcryptjs';
import { store } from '../services/storeService.js';

const createAdmin = async () => {
    const email = process.argv[2];
    const password = process.argv[3];

    if (!email || !password) {
        console.error('Usage: node create-admin.js <email> <password>');
        process.exit(1);
    }

    await store.init();
    const existing = await store.findOne('admins', { email });
    const hashedPassword = await bcrypt.hash(password, 10);

    if (existing) {
        console.log(`Admin ${email} already exists. Updating password...`);
        await store.update('admins', a => a.email === email, a => ({
            password: hashedPassword,
            updatedAt: new Date().toISOString()
        }));
        console.log('Admin password updated successfully.');
        process.exit(0);
    }

    await store.create('admins', {
        id: 'admin_' + Date.now(),
        email,
        password: hashedPassword,
        createdAt: new Date().toISOString()
    });

    console.log(`Admin user ${email} created successfully.`);
};

createAdmin().catch(console.error);
