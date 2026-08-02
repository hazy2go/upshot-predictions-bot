// ── Referral-server signal push ─────────────────────────────
//
// The referral web server (Bring a Player v2.1) needs two signals that only
// this bot owns: the Discord↔Upshot wallet link, and timestamped prediction
// activity. The Mac mini running that server can't reach the Pi, but the bot
// already reaches the server — so the integration is a push: every link/
// prediction write POSTs the event, and scripts/backfill-referral.mjs sends
// the history once.
//
// FIRE AND FORGET. These calls must never throw, never block, and never fail a
// DB write: a referral-server outage cannot be allowed to break linking or
// prediction submission. Not awaited by design — callers return immediately.
//
// Disabled (silent no-op) unless REFERRAL_API_URL + REFERRAL_API_SECRET are
// set, which is the same pair src/referral.js already gates on.

function env(key) {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : null;
}

/**
 * SQLite `datetime('now')` writes 'YYYY-MM-DD HH:MM:SS' in UTC — not ISO-8601,
 * and with no zone marker, so `new Date(raw)` parses it as LOCAL time and
 * silently shifts every timestamp by the host's offset. The contract with the
 * referral server is ISO-8601, so normalize here (and in the backfill, which
 * reuses the same rule) rather than letting each call site guess.
 * Returns null for missing/unparseable input — the server tolerates null.
 */
export function sqlTimeToIso(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  const s = String(raw).trim();
  if (!s) return null;
  // Already ISO (has a T and/or a zone) — trust it.
  const iso = /[TZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Map this bot's prediction status onto the referral server's three-value
 * vocabulary: 'pending' | 'verified' | 'deleted'.
 *
 * NORMALIZE AT THE PUSH BOUNDARY — never send the raw column. The server's
 * "vetted" test is `status NOT IN ('pending','deleted')`, so a raw
 * 'pending_verification' would sail through as vetted and count an unreviewed
 * submission toward rewards.
 *
 * Both pending states map to 'pending': 'pending_verification' is a fresh
 * submission, and 'pending_review' has only passed the automated ownership
 * check — a human still has to rate it, so it is NOT vetted. (The server's
 * suggested CASE had `ELSE 'verified'`, which would have misfiled it.)
 * Everything from 'rated' onward — including the hit/fail outcomes — is
 * post-verification and therefore 'verified'.
 */
export function normalizePredictionStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'pending_verification' || s === 'pending_review' || s === 'pending') return 'pending';
  if (s === 'deleted' || s === 'cancelled') return 'deleted';
  return 'verified'; // rated / hit / fail / any future post-vet status
}

/**
 * POST a signal to the referral server. Returns immediately; failures are
 * logged, never thrown. `path` is server-relative, e.g. '/api/bot/prediction'.
 */
export function pushToReferral(path, payload) {
  const base = env('REFERRAL_API_URL');
  const secret = env('REFERRAL_API_SECRET');
  if (!base || !secret) return; // integration disabled → no-op

  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': secret },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      // A non-2xx is worth a line (the endpoints 404 until the server side
      // ships), but it's still not an error the caller can act on.
      if (!res.ok) console.error(`[referralPush] ${path} → HTTP ${res.status}`);
    })
    .catch((err) => console.error(`[referralPush] ${path} failed:`, err.message));
}

/**
 * Push a batch of payloads to the same endpoint, PACED. The retraction
 * endpoints take one id at a time, and the bulk admin actions (reset-all,
 * delete-all-profiles) can retract hundreds of rows at once — firing those as
 * one parallel burst is exactly the kind of spike that tips a small server
 * over. Sends them sequentially with a small gap instead.
 *
 * Fire-and-forget like pushToReferral: returns immediately, never throws, and
 * the caller is not expected to await it.
 */
export function pushManyToReferral(path, payloads, { gapMs = 50 } = {}) {
  const list = (payloads || []).filter(Boolean);
  if (!list.length) return;
  const base = env('REFERRAL_API_URL');
  const secret = env('REFERRAL_API_SECRET');
  if (!base || !secret) return;

  (async () => {
    let failures = 0;
    for (const payload of list) {
      try {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': secret },
          body: JSON.stringify(payload),
        });
        if (!res.ok) failures++;
      } catch {
        failures++;
      }
      if (gapMs) await new Promise(r => setTimeout(r, gapMs));
    }
    // One summary line rather than N — a bulk retraction shouldn't flood logs.
    console.log(`[referralPush] ${path} × ${list.length} sent${failures ? `, ${failures} failed` : ''}`);
  })().catch(err => console.error(`[referralPush] ${path} batch failed:`, err.message));
}
