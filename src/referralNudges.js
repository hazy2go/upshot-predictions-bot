// ── Referral nudge delivery ─────────────────────────────────
//
// The referral web server queues short, stage-based "nudge" messages for
// invited members (and one to the inviter when a referee qualifies). It owns
// ALL the judgement — who gets a nudge, when, and the exact copy, including
// the <@id> mentions. This module is only the delivery arm:
//
//   poll GET /api/bot/nudges  →  post each verbatim to its channel  →
//   POST /api/bot/nudges/ack { ids } for the ones that actually sent
//
// Nothing is computed bot-side. The server already caps itself to one message
// per recipient per poll, so no local rate limiting is needed either.
//
// Ack is the ONLY thing that retires a nudge, so the rule is: ack exactly what
// Discord accepted. A send that fails is left unacked and comes back on the
// next poll; an ack that fails is retried, because dropping it re-posts a
// message the user has already seen.
//
// Env vars:
//   REFERRAL_API_URL / REFERRAL_API_SECRET  — same pair referral.js gates on
//   NUDGE_CHANNEL_ID     — optional override; otherwise each nudge's channelId
//   NUDGE_POLL_SECONDS   — optional, default 240 (~4 min)

import { Events } from 'discord.js';

const DEFAULT_POLL_SECONDS = 240;
const MIN_POLL_SECONDS = 60;      // the server's copy is not time-critical
const FETCH_TIMEOUT_MS = 10_000;
const ACK_ATTEMPTS = 3;
const SEND_GAP_MS = 250;          // gentle pacing; batches are single digits

function env(key) {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : null;
}

function isEnabled() {
  return !!(env('REFERRAL_API_URL') && env('REFERRAL_API_SECRET'));
}

function pollIntervalMs() {
  const raw = Number(env('NUDGE_POLL_SECONDS'));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_POLL_SECONDS * 1000;
  return Math.max(MIN_POLL_SECONDS, raw) * 1000;
}

async function api(path, init = {}) {
  const base = env('REFERRAL_API_URL');
  const secret = env('REFERRAL_API_SECRET');
  if (!base || !secret) return null;
  const headers = { 'X-Bot-Secret': secret, ...(init.headers || {}) };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// Channels that are missing or that we can't post in. A nudge for one of these
// will never succeed, so it would otherwise reprint the same stack trace every
// poll forever — log it once per channel and stay quiet after that. Cleared on
// nothing: a permission fix is rare enough that a bot restart is fine.
const brokenChannels = new Set();

async function resolveChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    if (!brokenChannels.has(channelId)) {
      brokenChannels.add(channelId);
      console.error(`[nudges] channel ${channelId} not found or not text-based — its nudges will keep requeueing until this is fixed`);
    }
    return null;
  }
  return channel;
}

/**
 * Post one nudge. Returns true only if Discord accepted the message — the
 * caller acks on true and nothing else.
 *
 * The copy comes from the server, so it goes out verbatim, but mentions are
 * restricted to users: the message legitimately needs <@id> pings, and nothing
 * queued for #general should ever be able to fire @everyone or a role ping,
 * whether by server bug or bad admin input.
 */
async function postNudge(client, nudge) {
  const channelId = env('NUDGE_CHANNEL_ID') || nudge.channelId;
  if (!channelId) {
    console.error(`[nudges] nudge ${nudge.id} has no channelId and NUDGE_CHANNEL_ID is unset — skipping`);
    return false;
  }
  const channel = await resolveChannel(client, channelId);
  if (!channel) return false;

  try {
    await channel.send({
      content: nudge.message,
      allowedMentions: { parse: ['users'] },
    });
    return true;
  } catch (err) {
    // 50013 Missing Permissions / 50001 Missing Access are configuration, not
    // a transient blip — same once-per-channel treatment as a dead channel.
    if (err?.code === 50013 || err?.code === 50001) {
      if (!brokenChannels.has(channelId)) {
        brokenChannels.add(channelId);
        console.error(`[nudges] cannot send in ${channelId} (${err.message}) — grant Send Messages; nudges will requeue meanwhile`);
      }
      return false;
    }
    console.error(`[nudges] send failed for nudge ${nudge.id}:`, err.message);
    return false;
  }
}

/**
 * Ack the delivered ids, with retries. An ack that never lands means the
 * server re-queues messages users have already been shown, which is the one
 * user-visible failure this module can cause — worth a few attempts.
 */
async function ackNudges(ids) {
  if (!ids.length) return;
  for (let attempt = 1; attempt <= ACK_ATTEMPTS; attempt++) {
    try {
      const res = await api('/api/bot/nudges/ack', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      if (res?.ok) return;
      console.error(`[nudges] ack HTTP ${res?.status} (attempt ${attempt}/${ACK_ATTEMPTS})`);
    } catch (err) {
      console.error(`[nudges] ack failed (attempt ${attempt}/${ACK_ATTEMPTS}):`, err.message);
    }
    if (attempt < ACK_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 2000));
  }
  console.error(`[nudges] GAVE UP acking ${ids.length} delivered nudge(s) [${ids.join(', ')}] — they may be re-posted`);
}

let polling = false; // a slow poll must not overlap the next tick

async function pollOnce(client) {
  if (polling) return;
  polling = true;
  try {
    let res;
    try {
      res = await api('/api/bot/nudges');
    } catch (err) {
      console.error('[nudges] referral server unreachable:', err.message);
      return;
    }
    if (!res) return;
    if (!res.ok) {
      console.error(`[nudges] GET /api/bot/nudges → HTTP ${res.status}`);
      return;
    }

    const body = await res.json().catch(() => null);
    const nudges = Array.isArray(body?.nudges) ? body.nudges : [];
    if (!nudges.length) return;

    const delivered = [];
    for (const nudge of nudges) {
      if (!nudge?.id || !nudge?.message) {
        console.warn('[nudges] skipping malformed nudge:', JSON.stringify(nudge));
        continue;
      }
      if (await postNudge(client, nudge)) delivered.push(nudge.id);
      if (SEND_GAP_MS) await new Promise(r => setTimeout(r, SEND_GAP_MS));
    }

    await ackNudges(delivered);
    const failed = nudges.length - delivered.length;
    console.log(`[nudges] delivered ${delivered.length}/${nudges.length}${failed ? ` (${failed} requeued)` : ''}`);
  } catch (err) {
    // The poller is a background timer — an escape here would take the process
    // down as an unhandled rejection.
    console.error('[nudges] poll failed:', err.message);
  } finally {
    polling = false;
  }
}

export function registerNudgePoller(client) {
  if (!isEnabled()) {
    console.log('[nudges] disabled (set REFERRAL_API_URL + REFERRAL_API_SECRET to enable)');
    return;
  }

  client.once(Events.ClientReady, () => {
    const every = pollIntervalMs();
    console.log(`[nudges] poller started — every ${Math.round(every / 1000)}s`);
    // Wait one interval before the first poll: at boot the referral panel and
    // invite caches are still settling, and a nudge is never urgent.
    const timer = setInterval(() => { pollOnce(client); }, every);
    timer.unref?.();
  });
}
