// Generates crane.config.json from environment variables + database.
// Reads ../.env automatically if present (for local development).
import { writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load ../.env if it exists
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  const { config } = await import('dotenv');
  config({ path: envPath });
}

const clientId     = process.env.ECWID_CLIENT_ID;
const clientSecret = process.env.ECWID_CLIENT_SECRET;
let   storeId      = process.env.ECWID_STORE_ID;

// If no ECWID_STORE_ID env var, pull the first store from the SQLite database
if (!storeId) {
  const dbPath = resolve(__dirname, '../data/registry.db');
  if (existsSync(dbPath)) {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT store_id FROM stores LIMIT 1').get();
    db.close();
    if (row) {
      storeId = row.store_id;
      console.log(`Using store_id=${storeId} from database.`);
    }
  }
}

if (!clientId || !clientSecret) {
  console.error('Missing required env vars: ECWID_CLIENT_ID, ECWID_CLIENT_SECRET');
  process.exit(1);
}

if (!storeId) {
  console.warn('No ECWID_STORE_ID env var and no stores in database — skipping crane deploy.');
  process.exit(1);
}

const config = { app_client_id: clientId, app_secret_key: clientSecret, store_id: storeId };
writeFileSync(resolve(__dirname, 'crane.config.json'), JSON.stringify(config, null, 2) + '\n');
console.log('crane.config.json generated successfully.');
