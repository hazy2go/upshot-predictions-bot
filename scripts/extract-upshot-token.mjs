#!/usr/bin/env node
//
// Auto-extract the Upshot access token — no copy-paste, no browser snippet.
//
// How it works: Upshot uses Google/social login, so the bot can't sign in via a
// plain HTTP call. Instead this opens upshot.cards in a *persistent* browser
// profile and reads the token straight out of `localStorage["global-store"]`
// (the same value the manual snippet grabs). Because the profile is persistent,
// you log in ONCE in a real window; every run after that is already
// authenticated and runs headless.
//
//   First-time login (opens a real window — sign in with Google here):
//     node scripts/extract-upshot-token.mjs --login
//
//   Refresh (headless — this is what the bot runs on a 401/403):
//     node scripts/extract-upshot-token.mjs
//
// Then point the bot at the output file:
//   UPSHOT_TOKEN_FILE=./cache/upshot-token.json
//   UPSHOT_TOKEN_REFRESH_CMD=node scripts/extract-upshot-token.mjs
//
// Env overrides:
//   UPSHOT_TOKEN_FILE   where to write the token JSON   (default ./cache/upshot-token.json)
//   UPSHOT_PROFILE_DIR  persistent browser profile dir  (default ./cache/upshot-profile)
//   UPSHOT_APP_URL      the web app origin to load       (default https://upshot.cards)
//
// Requires Playwright + a Chromium build:
//   npm install && npx playwright install chromium

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEADED = process.argv.includes('--login') || process.argv.includes('--headed');

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const TOKEN_FILE = expand(process.env.UPSHOT_TOKEN_FILE || './cache/upshot-token.json');
const PROFILE_DIR = expand(process.env.UPSHOT_PROFILE_DIR || './cache/upshot-profile');
const APP_URL = process.env.UPSHOT_APP_URL || 'https://upshot.cards';

// Pulls the accessToken out of the app's persisted store. Mirrors the manual
// snippet: global-store → state.authState.accessToken. Returns null until login
// has populated it. Runs inside the page.
function readTokenInPage() {
  try {
    const raw = localStorage.getItem('global-store');
    if (!raw) return null;
    const token = JSON.parse(raw)?.state?.authState?.accessToken;
    return token || null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('❌ Playwright is not installed. Run:\n   npm install && npx playwright install chromium');
    process.exit(2);
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Headed first-login gets a long window to finish the Google flow; the
    // headless refresh only needs the already-authenticated store to load.
    const deadline = Date.now() + (HEADED ? 5 * 60_000 : 30_000);
    if (HEADED) {
      console.log('🔑 A browser window is open. Sign in to Upshot with Google.');
      console.log('   Once you\'re logged in and see your cards, leave it — this will grab the token automatically.');
    }

    let token = null;
    while (Date.now() < deadline) {
      token = await page.evaluate(readTokenInPage).catch(() => null);
      if (token) break;
      await page.waitForTimeout(1000);
    }

    if (!token) {
      console.error(HEADED
        ? '❌ Timed out waiting for login. Re-run `--login` and complete the Google sign-in.'
        : '❌ No token found — the saved session has likely expired. Re-run: node scripts/extract-upshot-token.mjs --login');
      process.exit(1);
    }

    const payload = decodeJwtPayload(token);
    if (payload?.exp && payload.exp * 1000 <= Date.now()) {
      console.error('❌ The session produced an already-expired token. Re-run `--login`.');
      process.exit(1);
    }

    const out = {
      token,
      accessToken: token,
      wallet: payload?.walletAddress ?? null,
      user_id: payload?.id ?? null,
      expires_at: payload?.exp ? new Date(payload.exp * 1000).toISOString() : null,
      extracted_at: new Date().toISOString(),
    };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 2));
    fs.chmodSync(TOKEN_FILE, 0o600);

    const exp = out.expires_at ? ` (expires ${out.expires_at})` : '';
    console.log(`✅ Wrote token to ${TOKEN_FILE}${exp}`);
    if (out.wallet) console.log(`   Wallet: ${out.wallet.slice(0, 6)}…${out.wallet.slice(-4)}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('❌ Extraction failed:', err.message);
  process.exit(1);
});
