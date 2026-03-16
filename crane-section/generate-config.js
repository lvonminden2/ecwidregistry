// Generates crane.config.json from environment variables.
// Reads ../.env automatically if present (for local development).
import { writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load ../.env if it exists
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  const { config } = await import('dotenv');
  config({ path: envPath });
}

const clientId     = process.env.ECWID_CLIENT_ID;
const clientSecret = process.env.ECWID_CLIENT_SECRET;
const storeId      = process.env.ECWID_STORE_ID;

if (!clientId || !clientSecret || !storeId) {
  console.error('Missing required env vars: ECWID_CLIENT_ID, ECWID_CLIENT_SECRET, ECWID_STORE_ID');
  process.exit(1);
}

const config = { client_id: clientId, client_secret: clientSecret, store_id: storeId };
writeFileSync(resolve(__dirname, 'crane.config.json'), JSON.stringify(config, null, 2) + '\n');
console.log('crane.config.json generated from environment variables.');
