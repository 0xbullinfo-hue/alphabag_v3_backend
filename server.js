// server.js handles initialization and listening
import app from './src/app.js';
import { config } from './src/config/env.js';
import './cron/check_followed_whales.js';
import './cron/heatIndexCron.js';

const PORT = config.port;

const listenCallback = () => {
  console.log(`\n[SYSTEM] AlphaBAG Infrastructure Active`);
  console.log(`[SYSTEM] Port/Socket: ${PORT} (Source: ${process.env.PORT ? 'Environment' : 'Default/Config'})`);
  console.log(`[SYSTEM] Environment: ${process.env.NODE_ENV || 'development'}`);
  if (!config.jwtSecret || config.jwtSecret.includes('urgent')) {
    console.warn(`[WARNING] Using non-secure or default JWT Secret.`);
  }
};

if (typeof PORT === 'string' && isNaN(Number(PORT))) {
  // cPanel Passenger Unix Socket Mode
  app.listen(PORT, listenCallback);
} else {
  // Local Port Mode
  app.listen(Number(PORT), '0.0.0.0', listenCallback);
}
