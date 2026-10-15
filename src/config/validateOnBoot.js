// Imported FIRST by server.js. ES modules evaluate dependencies in import order,
// so this runs (and may exit the process) before the app, DB client or cron jobs load.
import { validateEnv } from './env.js';

validateEnv();
