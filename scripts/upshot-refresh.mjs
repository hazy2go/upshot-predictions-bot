#!/usr/bin/env node
//
// Pure-HTTP Upshot token refresher — NO browser, NO Google/Privy OAuth.
//
// Upshot's web app stays logged in by POSTing its (rotating) refresh token to
//   POST /api/v1/auth/refresh  { refreshToken }  → { data: { accessToken, refreshToken } }
// We do exactly the same. Both tokens rotate, so we persist the new pair every
// time. As long as this runs at least once every 7 days the chain never breaks.
//
// The bot does this automatically in-process (every 6h); this script is for
// manual refreshes, seeding the very first token, or use as a cron fallback.
//
//   Refresh now (reads refreshToken from the token file):
//     node scripts/upshot-refresh.mjs
//
//   Seed the token file from a refresh token (first-time / re-link):
//     node scripts/upshot-refresh.mjs --refresh-token '<jwt>'
//     UPSHOT_REFRESH_TOKEN='<jwt>' node scripts/upshot-refresh.mjs
//
// Env:
//   UPSHOT_TOKEN_FILE      where to read/write the token JSON (default ./cache/upshot-token.json)
//   UPSHOT_REFRESH_TOKEN   seed refresh token (only needed for the first run)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshUpshotAccessToken } from '../src/api.js';

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const TOKEN_FILE = expand(process.env.UPSHOT_TOKEN_FILE || './cache/upshot-token.json');

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

function readExisting() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}

function getSeedRefreshToken() {
  const flagIdx = process.argv.indexOf('--refresh-token');
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) return process.argv[flagIdx + 1];
  if (process.env.UPSHOT_REFRESH_TOKEN) return process.env.UPSHOT_REFRESH_TOKEN;
  const existing = readExisting();
  return existing?.refreshToken || existing?.refresh_token || null;
}

function writeTokenFile({ accessToken, refreshToken }) {
  const payload = decodeJwtPayload(accessToken) || {};
  const refreshPayload = decodeJwtPayload(refreshToken) || {};
  const out = {
    token: accessToken,
    accessToken,
    refreshToken,
    wallet: payload.walletAddress ?? null,
    user_id: payload.id ?? null,
    expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    refresh_expires_at: refreshPayload.exp ? new Date(refreshPayload.exp * 1000).toISOString() : null,
    extracted_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* best effort */ }
  return out;
}

const refreshToken = getSeedRefreshToken();
if (!refreshToken) {
  console.error('❌ No refresh token. Pass --refresh-token <jwt> (or set UPSHOT_REFRESH_TOKEN) for the first run.');
  process.exit(2);
}

const r = await refreshUpshotAccessToken(refreshToken);
if (!r.ok) {
  console.error(`❌ Refresh failed (${r.code}): ${r.error}`);
  if (r.code === 401 || r.code === 403) {
    console.error('   The refresh token is expired or revoked — re-link the session (log in once and re-seed).');
  }
  process.exit(1);
}

const out = writeTokenFile({ accessToken: r.accessToken, refreshToken: r.refreshToken });
console.log(`✅ Wrote ${TOKEN_FILE}`);
console.log(`   access token expires:  ${out.expires_at}`);
console.log(`   refresh token expires: ${out.refresh_expires_at}`);
if (out.wallet) console.log(`   wallet: ${out.wallet.slice(0, 6)}…${out.wallet.slice(-4)}`);
