#!/usr/bin/env node
// ── One-time referral backfill ──────────────────────────────
//
// Sends the bot's existing users + predictions history to the referral server
// so members who linked/predicted BEFORE the live push shipped count too.
// The server upserts (discordId for links, predictionId for predictions), so
// this is idempotent — safe to re-run, safe to run alongside live pushes.
//
//   node scripts/backfill-referral.mjs            # send
//   node scripts/backfill-referral.mjs --dry-run  # print counts, send nothing
//
// Reads the DB read-only and never writes to it.

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { sqlTimeToIso } from '../src/referralPush.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same path src/database.js opens (<repo>/data/predictions.db). DB_PATH
// overrides it for one-off runs against a copy.
const DB_PATH = process.env.DB_PATH || resolve(__dirname, '..', 'data', 'predictions.db');

const base = process.env.REFERRAL_API_URL?.trim();
const secret = process.env.REFERRAL_API_SECRET?.trim();
const dryRun = process.argv.includes('--dry-run');

if (!dryRun && (!base || !secret)) {
  console.error('REFERRAL_API_URL / REFERRAL_API_SECRET missing — set them or pass --dry-run.');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Every linked profile, including rows with no resolvable wallet: the contract
// says `wallet` may be null and the server keys on discordId, so filtering
// them out here would hide real Discord↔Upshot links from the server.
const links = db.prepare(`
  SELECT discord_id AS discordId, wallet_address AS wallet, upshot_url AS upshotUrl, linked_at AS linkedAt
  FROM users
  ORDER BY linked_at ASC
`).all().map(r => ({ ...r, linkedAt: sqlTimeToIso(r.linkedAt), method: 'pasted' }));

const predictions = db.prepare(`
  SELECT id AS predictionId, author_id AS discordId, created_at AS createdAt
  FROM predictions
  ORDER BY id ASC
`).all().map(r => ({ ...r, createdAt: sqlTimeToIso(r.createdAt) }));

const withWallet = links.filter(l => l.wallet).length;
console.log(`DB: ${DB_PATH}`);
console.log(`backfilling ${links.length} links (${withWallet} with a wallet, ${links.length - withWallet} without), ${predictions.length} predictions`);
if (dryRun) {
  console.log('--dry-run — nothing sent. Sample:', JSON.stringify({ link: links[0] ?? null, prediction: predictions[0] ?? null }, null, 2));
  process.exit(0);
}

async function send(body, label) {
  const res = await fetch(`${base}/api/bot/backfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': secret },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`  ${label} -> ${res.status} ${text.slice(0, 200)}`);
  return res.ok;
}

// Chunk predictions so a large table doesn't become one giant request. Links
// ride along in the first chunk.
const CHUNK = 500;
let ok = true;
if (predictions.length === 0) {
  ok = await send({ links, predictions: [] }, 'links only');
} else {
  for (let i = 0; i < predictions.length; i += CHUNK) {
    const slice = predictions.slice(i, i + CHUNK);
    const label = `predictions ${i + 1}-${i + slice.length}${i === 0 ? ` + ${links.length} links` : ''}`;
    ok = (await send({ links: i === 0 ? links : [], predictions: slice }, label)) && ok;
  }
}

console.log(ok ? 'done' : 'done — with errors above (safe to re-run once the server is up)');
process.exit(ok ? 0 : 1);
