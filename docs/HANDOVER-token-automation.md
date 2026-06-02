# Handover — automate the Upshot token on the Raspberry Pi

**For:** the Claude running on the Raspberry Pi (where this bot is actually deployed).
**From:** Claude on a Mac dev machine. I built the scaffolding but discovered the
chosen approach is blocked by Google's anti-automation, and the bot doesn't even
run on this machine — it runs on your Pi. Please take it from here.

---

## 1. The goal (in the user's words)

> "the bot gets the token without me having to copy-paste or use the script"

Today the bot needs an Upshot **Bearer JWT** to send packs. The user currently
gets it by running a browser snippet that reads `localStorage["global-store"]`
on upshot.cards and copies the `accessToken` out. They want this to be
**hands-off**: the bot should obtain/refresh the token by itself.

Upshot login is **Google / social OAuth** (confirmed by the user). The token is a
JWT whose payload carries `walletAddress`, `id`, and `exp`.

---

## 2. What's already in the repo (merged to `main`)

Three PRs landed during the session that produced this doc:

- **#17** — `/sendpack` now sends to **multiple recipients** (a `users` string
  option parsed for `<@id>` mentions; `quantity` is per-recipient).
- **#18** — `/sendpack` is **owner-gated**, and `/setup upshot-token` accepts a
  pasted token *or* the whole `upshot-token.json` blob (decodes the JWT).
- **#19** — a **Playwright extractor** (`scripts/extract-upshot-token.mjs`) that
  was meant to log in via a persistent browser profile and write the token file.
  **⚠️ This is the part that's blocked — see §4.**

### Token plumbing the bot already has (don't rebuild this)

In `src/index.js`:

- `readUpshotTokenFile()` — reads `process.env.UPSHOT_TOKEN_FILE` (expands `~`),
  expects JSON with `accessToken | token | access_token` and
  `expires_at | expiresAt | exp`. **Expired tokens are ignored** (30 s skew).
- `getUpshotToken(guildId)` — resolution order:
  **(1)** `UPSHOT_TOKEN_FILE` → **(2)** DB value from `/setup upshot-token` →
  **(3)** `UPSHOT_JWT` env.
- `refreshUpshotToken()` — on a **401/403** from `POST /packs/transfer`, the bot
  runs `process.env.UPSHOT_TOKEN_REFRESH_CMD` via `/bin/sh -c`, then **retries the
  send once**.

So: **anything that writes a fresh `upshot-token.json` and is runnable as a shell
command is automatically wired in.** You only need to make the *minting* work.

### Owner gate (so only the user can `/sendpack`)

`canSendPack()` → `getOwnerId()` = `cfg(guildId,'owner_id','OWNER_ID')`. The user
should run `/setup owner` once in Discord to lock `/sendpack` to themselves (or set
an `OWNER_ID` env). Not blocking for token work, just FYI.

### The Upshot API

- Base: `https://api-mainnet.upshotcards.net/api/v1` (`src/api.js`).
- Only authed call: `POST /packs/transfer` with `Authorization: Bearer <jwt>`.
- Web app origin: `https://upshot.cards` (override via `UPSHOT_APP_URL`).

---

## 3. The extractor as it stands

`scripts/extract-upshot-token.mjs` (committed in #19):

- Modes: `--login` (headed, 5-min window for the human to sign in) and default
  (headless, 30 s — meant for the bot's refresh).
- Uses `chromium.launchPersistentContext(UPSHOT_PROFILE_DIR, …)`, loads
  `UPSHOT_APP_URL`, polls `localStorage["global-store"].state.authState.accessToken`,
  decodes the JWT, writes `UPSHOT_TOKEN_FILE` (`{token, accessToken, wallet,
  user_id, expires_at, extracted_at}`, `chmod 600`).
- Env: `UPSHOT_TOKEN_FILE` (default `./cache/upshot-token.json`),
  `UPSHOT_PROFILE_DIR` (default `./cache/upshot-profile`),
  `UPSHOT_APP_URL` (default `https://upshot.cards`).
- npm scripts: `npm run upshot-login`, `npm run upshot-token`.
- `playwright ^1.49.0` is in `devDependencies`. `cache/` is gitignored.

---

## 4. The blocker I hit (read this before doing anything)

Running `npm run upshot-login` on the Mac launched Playwright's bundled Chromium,
and **Google refused the sign-in** with:

> "This browser or app may not be secure. Try using a different browser…"

This is Google's standard block on automated browsers (`navigator.webdriver`,
the `--enable-automation` flag, etc.). **Google only blocks the OAuth login
step** — once a profile is authenticated, loading upshot.cards and reading the
token never touches Google again. So the persistent-profile idea is sound; the
*one-time login inside an automated Chromium* is what fails.

On top of that, your environment is harder than the Mac's:
- **Raspberry Pi = ARM + (almost certainly) headless** (no display). Playwright's
  bundled Chromium has poor/zero ARM support — you'll likely need the **system
  Chromium** (`sudo apt install chromium chromium-driver`) and point Playwright at
  it via `channel: 'chromium'` or `executablePath`.
- A headed Google login needs a display. On a headless Pi that means VNC, an
  attached monitor, or X-forwarding for the one-time sign-in.

---

## 5. Recommended approaches, best first

### ⭐ Option A — Pure-HTTP refresh token (best for a headless Pi; investigate first)

If Upshot issues a **refresh token** alongside the access token, you can refresh
with a plain `fetch` — **no browser, no display, perfect for the Pi.**

**Investigate (ask the user to do this once in their normal browser):**
1. On upshot.cards while logged in, open DevTools → Application → Local Storage →
   `global-store`. Dump the **whole** object (not just `accessToken`). Look for
   `refreshToken`, `refresh_token`, or anything token-like under `state.authState`.
2. DevTools → Network, then trigger/await a token refresh (reload, or wait for the
   access token to roll over). Look for a request like `POST /auth/refresh`,
   `/auth/token`, `/sessions/refresh`, etc. Capture its **URL, method, request
   headers, and body**.

**If such an endpoint exists:** implement `refreshUpshotToken()`-style logic in
`src/api.js` that POSTs the refresh token and writes the new access token to
`UPSHOT_TOKEN_FILE` (or returns it directly). Store the refresh token as a secret
(env or a `chmod 600` file). This removes Playwright entirely. **Strongly
preferred** — try this before any browser approach.

> Note: the current snippet only grabs `accessToken`. The user has never checked
> for a refresh token — so this genuinely needs investigating, don't assume it
> doesn't exist.

### Option B — Real Chrome over CDP on the Pi (browser, but gets past Google)

Make the one-time login happen in **real Chromium launched normally** (not driven
by Playwright), which Google doesn't flag, then attach over the DevTools protocol
to read the token.

1. `sudo apt install chromium` (64-bit Raspberry Pi OS — verify with `uname -m`
   → expect `aarch64`).
2. Launch the system Chromium **yourself** with a dedicated profile + debug port
   (do this via a desktop/VNC session for the one-time login):
   `chromium --user-data-dir=~/upshot-profile --remote-debugging-port=9222`
   Sign into Upshot with Google in that window. Because *you* launched real
   Chromium (no automation flags, `navigator.webdriver` is false), Google allows
   it.
3. Rewrite the extractor to **`chromium.connectOverCDP('http://localhost:9222')`**
   instead of `launchPersistentContext`, then read `localStorage` as it does now.
4. For unattended refresh: relaunch that same Chromium **headless** with the same
   `--user-data-dir` (the Google session cookies persist there, so no Google
   interaction is needed — just loading upshot.cards re-mints the JWT into
   localStorage), connect over CDP, read, write the file.

This keeps the existing token-file plumbing; only the extractor's connect logic
changes. Cookies stay on the Pi, so no cross-machine encryption problems.

### Option C — Mint on a machine with a display, sync the file to the Pi

If browsers on the Pi prove too painful, run the extractor on a machine that has a
display **and real Chrome** (e.g. the user's Mac), on a schedule, and ship the
resulting `upshot-token.json` to the Pi:

- macOS cron/launchd runs the extractor (Option B-style, real Chrome) →
  writes `upshot-token.json`.
- `scp`/`rsync`/Syncthing the file to the Pi at the `UPSHOT_TOKEN_FILE` path.
- The Pi's bot just reads it. Zero browser on the Pi.

Downside: depends on the Mac being on. Good stopgap.

### Option D — Status quo (manual), only if all else fails

Keep `/setup upshot-token` (paste token or the `upshot-token.json` blob). Already
works; it's just the manual flow the user wants to escape.

> ⚠️ Do **not** copy a Chrome **profile** from the Mac to the Pi expecting the
> login to survive — Chrome encrypts cookies with an OS-specific key (macOS
> Keychain vs. Linux keyring), so cookies won't decrypt across machines. Mint the
> session *on the machine that will use it*, or sync the *token file* (Option C),
> not the profile.

---

## 6. Concrete task list for you (Pi Claude)

1. **Confirm the environment:** `uname -m` (expect `aarch64`), is there a display
   / VNC?, Node version, where the bot's working dir + `.env` live, and how the bot
   is started (systemd? pm2? plain `node`?).
2. **Pull `main`** so you have #17–#19 and this doc.
3. **Try Option A first.** Get the user to dump the full `global-store` and watch
   for a refresh endpoint (§5A). If it exists, implement HTTP refresh in
   `src/api.js` + a small writer for `UPSHOT_TOKEN_FILE`, set
   `UPSHOT_TOKEN_REFRESH_CMD` accordingly, and you're done — no browser.
4. **If no refresh token, do Option B.** Install system Chromium, rewrite the
   extractor to `connectOverCDP`, do the one-time headed login over VNC, verify a
   headless refresh run writes a valid (non-expired) token file.
5. **Wire `.env`** on the Pi:
   ```
   UPSHOT_TOKEN_FILE=/home/<user>/upshot-predictions-bot/cache/upshot-token.json
   UPSHOT_TOKEN_REFRESH_CMD=node scripts/extract-upshot-token.mjs   # or your HTTP refresher
   ```
6. **End-to-end test:** delete/expire the token file, run a `/sendpack`, confirm
   the bot fires `UPSHOT_TOKEN_REFRESH_CMD`, gets a fresh token, and the transfer
   succeeds.
7. Remind the user to run **`/setup owner`** once so only they can `/sendpack`.
8. Ship changes as a PR and merge (the user's standing preference is: ship each
   change as a PR, then merge + sync `main` without asking).

---

## 7. Repo quick reference

| Thing | Where |
|---|---|
| Repo | `github.com/hazy2go/upshot-predictions-bot`, branch `main` |
| Bot entry | `src/index.js` (ESM, `"type":"module"`) |
| Token resolution / refresh | `getUpshotToken`, `readUpshotTokenFile`, `refreshUpshotToken` in `src/index.js` |
| Upshot API calls | `src/api.js` (base `https://api-mainnet.upshotcards.net/api/v1`) |
| Slash command defs | `src/commands.js` |
| `/setup` handler | `handleSetup()` in `src/index.js` |
| `/sendpack` handlers | `handleSendPack`, `handleConfirmSendPack` in `src/index.js` |
| Extractor | `scripts/extract-upshot-token.mjs` |
| Token-related env | `UPSHOT_TOKEN_FILE`, `UPSHOT_TOKEN_REFRESH_CMD`, `UPSHOT_JWT`, `UPSHOT_PROFILE_DIR`, `UPSHOT_APP_URL`, `OWNER_ID` — documented in `.env.example` |
| JWT payload fields | `walletAddress`, `id`, `exp` |

### The manual extraction snippet (reference — what we're automating)

```js
const raw = localStorage.getItem("global-store");
const token = JSON.parse(raw)?.state?.authState?.accessToken;
// JWT payload: { id, walletAddress, exp, ... }
```

---

## 8. Note for the user

I installed `playwright` + Chromium **on the Mac by mistake** — harmless (it's in
`devDependencies` and `node_modules`/`cache/` are gitignored), but it does nothing
for you there since the bot runs on the Pi. You can ignore or `rm -rf node_modules`
on the Mac. The real work happens on the Pi following §6 above.
