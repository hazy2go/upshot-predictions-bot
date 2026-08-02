#!/usr/bin/env node
// ── Repair missing wallet addresses ─────────────────────────
//
// A handful of legacy `users` rows have wallet_address NULL even though the
// address is right there in the stored upshot_url. (Both current link paths
// reject a URL with no extractable wallet, so this can only be pre-existing
// data — but those rows still read as "linked, no wallet" everywhere: user
// info, CSV exports, and the referral server's eligibility checks.)
//
// Re-runs the same extractor the live link path uses and fills in what it can.
//
//   node scripts/repair-wallets.mjs --dry-run   # show what would change
//   node scripts/repair-wallets.mjs             # apply (takes a backup first)
//
// Idempotent: rows that already have a wallet are never touched. After a real
// run, re-run scripts/backfill-referral.mjs to push the corrected values.

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { extractWallet } from '../src/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, '..', 'data', 'predictions.db');
const dryRun = process.argv.includes('--dry-run');

const db = new Database(DB_PATH);
// The bot is running against this same file — wait rather than fail on a lock.
db.pragma('busy_timeout = 5000');

const broken = db.prepare(`
  SELECT discord_id, upshot_url, linked_at
  FROM users
  WHERE wallet_address IS NULL OR trim(wallet_address) = ''
  ORDER BY linked_at ASC
`).all();

console.log(`DB: ${DB_PATH}`);
console.log(`${broken.length} row(s) with no wallet_address\n`);

const fixable = [];
const unfixable = [];
for (const row of broken) {
  const wallet = extractWallet(row.upshot_url);
  (wallet ? fixable : unfixable).push({ ...row, wallet });
}

for (const r of fixable) console.log(`  FIX  ${r.discord_id}  ${r.wallet}  (linked ${r.linked_at})`);
for (const r of unfixable) console.log(`  SKIP ${r.discord_id}  no 0x… in url: ${r.upshot_url}`);

if (!fixable.length) {
  console.log('\nNothing to repair.');
  process.exit(0);
}

if (dryRun) {
  console.log(`\n--dry-run — no changes written (${fixable.length} would be repaired).`);
  process.exit(0);
}

// Online backup before touching production data. A plain file copy would be
// unsafe here: the DB is in WAL mode with the bot actively writing to it.
const backupDir = resolve(__dirname, '..', 'data', 'backups');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(backupDir, `predictions-prerepair-${stamp}.db`);
await db.backup(backupPath);
console.log(`\nbackup written: ${backupPath}`);

// Guard the UPDATE on the column still being empty, so a concurrent link from
// the running bot can't be clobbered between the SELECT above and this write.
const stmt = db.prepare(`
  UPDATE users SET wallet_address = ?
  WHERE discord_id = ? AND (wallet_address IS NULL OR trim(wallet_address) = '')
`);
let repaired = 0;
const run = db.transaction((rows) => {
  for (const r of rows) repaired += stmt.run(r.wallet, r.discord_id).changes;
});
run(fixable);

const left = db.prepare("SELECT COUNT(*) n FROM users WHERE wallet_address IS NULL OR trim(wallet_address) = ''").get().n;
console.log(`repaired ${repaired} row(s); ${left} still without a wallet`);
console.log('\nNext: node scripts/backfill-referral.mjs   # push corrected wallets (idempotent)');
