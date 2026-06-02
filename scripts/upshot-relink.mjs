#!/usr/bin/env node
//
// Re-link the Upshot session — only needed if the refresh-token chain ever
// lapses (the bot was offline > 7 days, so scripts/upshot-refresh.mjs can no
// longer renew). Day-to-day you never run this: the bot keeps itself fresh
// in-process via POST /auth/refresh every 6h.
//
// What it does: launches REAL system Chromium (so Google's anti-automation does
// NOT block the login — unlike a Playwright-driven browser) with a persistent
// profile, attaches over CDP, waits for upshot.cards to hold a token, reads the
// refresh token straight out of localStorage, and seeds cache/upshot-token.json.
// Because the profile is persistent, after the first sign-in future re-links
// usually need no interaction at all (the Privy session lasts ~30 days).
//
//   node scripts/upshot-relink.mjs        # opens a window; sign in via VNC if prompted
//
// Env:
//   UPSHOT_TOKEN_FILE    where to write the token JSON (default ./cache/upshot-token.json)
//   UPSHOT_PROFILE_DIR   persistent chromium profile  (default ./cache/upshot-profile)
//   UPSHOT_APP_URL       app origin                    (default https://upshot.cards)
//   CHROMIUM_BIN         chromium binary               (default /usr/bin/chromium)
//   CDP_PORT             devtools port                 (default 9222)
//   DISPLAY              X display for the headed window (default :0)

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const TOKEN_FILE = expand(process.env.UPSHOT_TOKEN_FILE || './cache/upshot-token.json');
const PROFILE_DIR = expand(process.env.UPSHOT_PROFILE_DIR || './cache/upshot-profile');
const APP_URL = process.env.UPSHOT_APP_URL || 'https://upshot.cards';
const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
const PORT = process.env.CDP_PORT || 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Launch real system Chromium, detached, with the persistent profile + CDP port.
const child = spawn(CHROMIUM, [
  `--user-data-dir=${PROFILE_DIR}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900',
  APP_URL,
], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } });
child.unref();

console.log('🔑 Opened Chromium on the Pi display. If it shows a login, sign in to Upshot with Google via VNC / Pi Connect.');
console.log('   (If the saved session is still valid you do not need to do anything.)');

// Wait for the CDP endpoint, then poll localStorage for the refresh token.
async function cdpPage() {
  const res = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
  return res.find((p) => p.type === 'page' && p.url.includes('upshot'));
}

let page = null;
for (let i = 0; i < 30 && !page; i++) { await sleep(1000); page = await cdpPage().catch(() => null); }
if (!page) { console.error('❌ Chromium did not expose a CDP page.'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');

const readRefresh = `(()=>{try{return JSON.parse(localStorage.getItem('global-store'))?.state?.authState?.refreshToken||''}catch{return ''}})()`;
let refreshToken = '';
const deadline = Date.now() + 5 * 60_000; // up to 5 min for a human login
while (Date.now() < deadline && !refreshToken) {
  refreshToken = (await send('Runtime.evaluate', { expression: readRefresh, returnByValue: true })).result.value;
  if (!refreshToken) await sleep(2000);
}
ws.close();
try { process.kill(-child.pid); } catch { /* already gone */ }

if (!refreshToken) { console.error('❌ Timed out waiting for a logged-in session.'); process.exit(1); }

// Hand the captured refresh token to the seeder, which does the single
// /auth/refresh exchange and writes cache/upshot-token.json (one write path).
process.env.UPSHOT_REFRESH_TOKEN = refreshToken;
process.env.UPSHOT_TOKEN_FILE = TOKEN_FILE;
await import('./upshot-refresh.mjs');
