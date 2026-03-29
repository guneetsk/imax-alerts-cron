// Load env
const fs = require('fs');
const localEnv = fs.readFileSync('C:/Users/gunee/Downloads/claude code/imax-alerts/.env.local', 'utf8');
const dbMatch = localEnv.match(/DATABASE_URL="([^"]+)"/);
process.env.DATABASE_URL = dbMatch ? dbMatch[1] : localEnv.match(/DATABASE_URL=(.+)/)?.[1]?.trim();

const creds = fs.readFileSync('C:/credentials/.env', 'utf8');
process.env.GMAIL_APP_PASSWORD = creds.match(/GMAIL_APP_PASSWORD_ALERTS_GUNEET=(.+)/)[1].trim();

require('./index.js');
