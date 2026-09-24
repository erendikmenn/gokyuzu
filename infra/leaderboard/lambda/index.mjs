// Lambda entry (handler "infra/leaderboard/lambda/index.handler"; the zip keeps the repo layout so src/net/names.js
// resolves the same way as in the repository). Configuration from the environment, set by infra/leaderboard/setup.py:
// TABLE, SALT (secret, never logged), STAGE, ORIGINS (comma-separated allowed Origin values for POST).
import { readFileSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createDynamoDb } from './dynamo.mjs';

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));
const db = await createDynamoDb(process.env.TABLE);
try { await db.warm(); } catch { /* the first request retries */ }

const app = createApp({
  db, rules, salt: process.env.SALT, stage: process.env.STAGE || 'staging',
  origins: (process.env.ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
});

export const handler = (event) => app(event);
