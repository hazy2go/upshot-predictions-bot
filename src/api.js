// ── Upshot Public API Client ─────────────────────────────────
//
// Base URL: https://api-mainnet.upshotcards.net/api/v1
// No auth required for read endpoints.
//
// Card images are Arweave transaction IDs: https://arweave.net/{image}

const BASE = 'https://api-mainnet.upshotcards.net/api/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded cache set: the bot is a long-running process, so a plain Map keyed by
// card id / wallet / contest grows without limit (TTL governs whether a hit is
// *used*, never frees the entry). cacheSet evicts the oldest entry once the map
// passes `max` — Maps iterate in insertion order, so the first key is the oldest.
function cacheSet(map, key, value, max) {
  if (map.size >= max && !map.has(key)) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

// Browser-like headers for read requests. A bare Node fetch (no User-Agent, no
// Origin) is an easy bot signal — Upshot sits behind Bunny Shield, which can
// tarpit/drop those connections (they hang until our AbortSignal fires, showing
// up as "operation aborted due to timeout"). Sending the same headers the web
// app does makes server-side reads look like a real client. Can be overridden
// per call; the write endpoints set their own Origin explicitly.
const READ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': process.env.UPSHOT_APP_URL || 'https://upshot.cards',
  'Referer': (process.env.UPSHOT_APP_URL || 'https://upshot.cards') + '/',
};

/**
 * GET with retries on transient failures — network/timeout errors, HTTP 429,
 * and 5xx responses. Creates a fresh timeout per attempt and backs off
 * exponentially with jitter (≈250ms, 500ms, capped at 2s). When the server
 * sends a Retry-After header on a 429, that wins (capped at 5s) so we don't
 * hammer a rate-limited API. Non-transient responses (e.g. 404) are returned
 * immediately for the caller to handle; if every attempt throws, the last error
 * is rethrown so the existing try/catch blocks degrade gracefully.
 *
 * Default retries kept low (2) on purpose: these GETs fan out widely (a My
 * Cards open touches dozens of cards + every live contest), and an aggressive
 * retry count multiplies request volume against the API exactly when it's
 * already struggling — turning a transient blip into a self-inflicted flood.
 * Use only for idempotent GETs.
 */
async function fetchRetry(url, { timeout = 10_000, retries = 2, headers } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { ...READ_HEADERS, ...headers },
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(5000, retryAfter * 1000)
          : Math.min(2000, 250 * 2 ** attempt) + Math.random() * 100;
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(Math.min(2000, 250 * 2 ** attempt) + Math.random() * 100);
    }
  }
  throw lastErr;
}

// ── Live-contest data caches (shared across ALL users) ───────────────────────
//
// The LIVE-contest list and each contest's standings are GLOBAL — identical for
// every member. Yet every cold "My Cards" tap (checkCardInContests +
// getUserContestLineups → getPredictableCards) used to re-fetch the full list
// and every contest's standings from scratch. With N members tapping at once,
// that's N × (1 + #liveContests) requests in a burst — enough to trip Upshot's
// rate limiting, which made fetchRetry back off and retry, which slowed things
// down for everyone. A short TTL plus in-flight de-duplication collapses a
// concurrent stampede into a single shared fetch.
const LIVE_CONTESTS_TTL = 60_000;
const STANDINGS_TTL = 60_000;
let _liveContests = null;            // { at, value: contest[] }
let _liveContestsInFlight = null;    // Promise<contest[]>
const _standingsCache = new Map();   // contestId -> { at, value: {standings,totalLineups} }
const _standingsInFlight = new Map(); // contestId -> Promise

// Live contests, deduped and cached. Returns [] on failure (never throws).
async function getLiveContests() {
  if (_liveContests && Date.now() - _liveContests.at < LIVE_CONTESTS_TTL) {
    return _liveContests.value;
  }
  if (_liveContestsInFlight) return _liveContestsInFlight;
  _liveContestsInFlight = (async () => {
    // NOTE: ?status=LIVE upstream filter is unreliable — returns only a subset
    // of LIVE contests. Fetch all and filter client-side.
    const res = await fetchRetry(`${BASE}/contests`, { timeout: 10_000 });
    if (!res.ok) return [];
    const json = await res.json();
    const all = json.data || json;
    return Array.isArray(all) ? all.filter(c => c.status === 'LIVE') : [];
  })().catch((err) => {
    console.error('Upshot API: getLiveContests failed:', err.message);
    return [];
  });
  try {
    const value = await _liveContestsInFlight;
    if (value.length) _liveContests = { at: Date.now(), value };
    return value;
  } finally {
    _liveContestsInFlight = null;
  }
}

// One contest's standings, deduped and cached. Returns null on failure.
async function getContestStandings(contestId) {
  const cached = _standingsCache.get(contestId);
  if (cached && Date.now() - cached.at < STANDINGS_TTL) return cached.value;
  if (_standingsInFlight.has(contestId)) return _standingsInFlight.get(contestId);
  const p = (async () => {
    const sRes = await fetchRetry(`${BASE}/contests/${contestId}/standings`, { timeout: 15_000 });
    if (!sRes.ok) return null;
    const sJson = await sRes.json();
    return { standings: sJson.data?.standings || [], totalLineups: sJson.data?.totalLineups || 0 };
  })().catch(() => null);
  _standingsInFlight.set(contestId, p);
  try {
    const value = await p;
    if (value) cacheSet(_standingsCache, contestId, { at: Date.now(), value }, 200);
    return value;
  } finally {
    _standingsInFlight.delete(contestId);
  }
}

/**
 * Extract wallet address (0x...) from an Upshot profile URL.
 * Supports formats:
 *   https://upshot.cards/profile/0x89A8...
 *   https://upshot.xyz/user/0x89A8...
 *   Raw 0x address
 */
export function extractWallet(urlOrAddress) {
  if (!urlOrAddress) return null;
  const match = urlOrAddress.match(/(0x[a-fA-F0-9]{40})/);
  return match ? match[1] : null;
}

/**
 * Extract card ID from a URL or raw ID.
 * Supports:
 *   https://upshot.cards/card-detail/cmlyvmdds008a2hqifjhrrrds
 *   cmlyvmdds008a2hqifjhrrrds
 */
export function extractCardId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // Full URL — grab last path segment, strip query string
  if (trimmed.startsWith('https://')) {
    const url = new URL(trimmed);
    const segments = url.pathname.replace(/\/+$/, '').split('/');
    return segments[segments.length - 1];
  }

  // Raw card ID (starts with cm, ~25 chars)
  if (/^cm[a-z0-9]{10,}$/i.test(trimmed)) {
    return trimmed;
  }

  return trimmed; // fallback — let the API reject if invalid
}

/**
 * Fetch card details including Arweave image.
 * Returns { id, name, rarity, image, arweaveUrl, ... } or null.
 *
 * Results are cached for CARD_DETAILS_TTL — card name/image/event date are
 * stable, so this avoids re-fetching the same card across the deadline filter,
 * the detail view, and repeated My Cards opens. Only successful lookups are
 * cached (failures fall through so they're retried next time).
 *
 * `retries` is forwarded to fetchRetry. The bulk deadline filter passes a low
 * value so a large wallet doesn't multiply its request volume against the API.
 * Pass `fresh: true` to bypass the cache read (e.g. resolution checks that need
 * live event status); the result still refreshes the cache.
 */
const cardDetailsCache = new Map(); // cardId -> { at, value }
const CARD_DETAILS_TTL = 30 * 60 * 1000;

// Fetch + normalize a card, reporting WHY it failed so callers can tell a card
// that genuinely no longer exists from one we just couldn't reach. Returns:
//   { ok: true, value }            — found & parsed (also written to the cache)
//   { ok: false, notFound: true }  — API said 404 / returned no data: card gone
//   { ok: false, notFound: false } — transient: timeout, 5xx, network, bad JSON
// This distinction matters for auto-resolve: a transient miss must be retried on
// the next sweep, not logged as "card not found" (which scared us into thinking
// the API had dropped live cards when it was really just a timeout/shield block).
async function fetchCardDetails(cardId, { retries, timeout }) {
  try {
    const res = await fetchRetry(`${BASE}/cards/${cardId}?include=event,supply`, { timeout, retries });
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, notFound: false };
    const json = await res.json();
    const card = json.data;
    if (!card) return { ok: false, notFound: true };

    const value = {
      id: card.id,
      name: card.name,
      rarity: card.rarity,
      image: card.image,
      arweaveUrl: card.image
        ? (card.image.startsWith('http') ? card.image : `https://arweave.net/${card.image}`)
        : null,
      maxSupply: card.maxSupply,
      pointsValue: card.pointsValue,
      event: card.event || null,
      eventDate: card.event?.eventDate || null,
      outcomeId: card.outcomeId || null,
      eventStatus: card.event?.status || null,
      winningOutcomeId: card.event?.winningOutcomeId || null,
      resolvedAt: card.event?.resolvedAt || null,
    };
    cacheSet(cardDetailsCache, cardId, { at: Date.now(), value }, 2000);
    return { ok: true, value };
  } catch (err) {
    console.error(`Upshot API: getCardDetails(${cardId}) failed:`, err.message);
    return { ok: false, notFound: false };
  }
}

export async function getCardDetails(cardId, { retries = 3, fresh = false, timeout = 15_000 } = {}) {
  const cached = cardDetailsCache.get(cardId);
  if (!fresh && cached && Date.now() - cached.at < CARD_DETAILS_TTL) {
    return cached.value;
  }
  const result = await fetchCardDetails(cardId, { retries, timeout });
  return result.ok ? result.value : null;
}

/**
 * Check if a wallet owns a specific card.
 * First checks wallet balances, then falls back to scanning active contests
 * (cards entered in contests don't show in balances).
 * Returns { owned: boolean, quantity: number, winning: boolean, card: object|null, inContest: boolean }
 */
export async function checkCardOwnership(walletAddress, cardId) {
  try {
    const res = await fetchRetry(`${BASE}/cards/balances/${walletAddress}?cardId=${cardId}`, { timeout: 10_000 });
    if (!res.ok) return { owned: false, quantity: 0, winning: false, card: null };
    const json = await res.json();
    const data = json.data;

    if (data && data[cardId]) {
      const entry = data[cardId];
      const claimed = parseInt(entry.claimedQuantity || '0', 10);
      const unclaimed = parseInt(entry.unclaimedQuantity || '0', 10);

      if ((claimed + unclaimed) > 0) {
        return {
          owned: true,
          quantity: claimed + unclaimed,
          winning: !!entry.winning,
          card: entry.card || null,
          inContest: false,
        };
      }
    }

    // Card not in wallet — check if it's entered in an active contest
    const contestResult = await checkCardInContests(walletAddress, cardId);
    if (contestResult) {
      return { owned: true, quantity: 1, winning: false, card: null, inContest: true };
    }

    return { owned: false, quantity: 0, winning: false, card: null, inContest: false };
  } catch (err) {
    console.error(`Upshot API: checkCardOwnership(${walletAddress}, ${cardId}) failed:`, err.message);
    return { owned: false, quantity: 0, winning: false, card: null, error: err.message };
  }
}

/**
 * Check if a wallet has a card entered in any active/live contest.
 * Scans standings of all live contests for the wallet+card combo.
 * Returns true if found, false otherwise.
 */
async function checkCardInContests(walletAddress, cardId) {
  try {
    const contests = await getLiveContests();
    if (!contests.length) return false;

    const lowerWallet = walletAddress.toLowerCase();

    // Scan all live contests' standings in parallel (shared cache makes repeat
    // scans free) and stop as soon as the card turns up in the user's lineup.
    const found = await Promise.allSettled(
      contests.map(async (contest) => {
        const data = await getContestStandings(contest.id);
        for (const entry of (data?.standings || [])) {
          if (entry.user?.walletAddress?.toLowerCase() === lowerWallet
              && entry.lineup?.cardIds?.includes(cardId)) {
            return true;
          }
        }
        return false;
      })
    );

    return found.some(r => r.status === 'fulfilled' && r.value);
  } catch (err) {
    console.error(`Upshot API: checkCardInContests failed:`, err.message);
    return false;
  }
}

/**
 * Get all contests a user is entered in, with ALL their lineups and card details.
 * Returns array of { contestName, lineups: [{ rank, totalLineups, score, cards: [{ id, name }] }] }
 */
export async function getUserContestLineups(walletAddress) {
  try {
    const contests = await getLiveContests();
    if (!contests.length) return [];

    const lowerWallet = walletAddress.toLowerCase();

    // Fetch all contest standings in parallel (shared cache + in-flight dedup).
    const standingsResults = await Promise.allSettled(
      contests.map(async (contest) => {
        const data = await getContestStandings(contest.id);
        if (!data) return null;
        return { contest, standings: data.standings, totalLineups: data.totalLineups };
      })
    );

    // Collect all unique card IDs and user entries
    const allEntries = []; // { contest, entry, totalLineups }
    const allCardIds = new Set();

    for (const result of standingsResults) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const { contest, standings, totalLineups } = result.value;
      const entries = standings.filter(s => s.user?.walletAddress?.toLowerCase() === lowerWallet);
      for (const entry of entries) {
        allEntries.push({ contest, entry, totalLineups });
        for (const cardId of (entry.lineup?.cardIds || [])) {
          allCardIds.add(cardId);
        }
      }
    }

    if (allEntries.length === 0) return [];

    // Resolve card names via getCardDetails so the lookups land in the shared
    // card cache — the deadline filter (filterOutExpiredCards) then reuses them
    // instead of fetching every contest card a second time.
    const cardNames = new Map();
    const cardFetches = await Promise.allSettled(
      [...allCardIds].map(async (cardId) => {
        const details = await getCardDetails(cardId, { retries: 1 });
        return { cardId, name: details?.name || cardId };
      })
    );
    for (const r of cardFetches) {
      if (r.status === 'fulfilled') cardNames.set(r.value.cardId, r.value.name);
    }

    // Assemble results grouped by contest
    const contestMap = new Map();
    for (const { contest, entry, totalLineups } of allEntries) {
      if (!contestMap.has(contest.name)) {
        contestMap.set(contest.name, { contestName: contest.name, lineups: [] });
      }
      const cards = (entry.lineup?.cardIds || []).map(id => ({
        id,
        name: cardNames.get(id) || id,
      }));
      contestMap.get(contest.name).lineups.push({
        rank: entry.rank,
        totalLineups,
        score: parseInt(entry.currentScore || '0', 10),
        cards,
      });
    }

    return [...contestMap.values()];
  } catch (err) {
    console.error(`Upshot API: getUserContestLineups(${walletAddress}) failed:`, err.message);
    return [];
  }
}

/**
 * True when a card's event deadline is today or in the past (UTC) — i.e. it can
 * no longer be predicted on. Mirrors the deadline check in the submit flow.
 * Returns false on missing/unparseable data so we never hide a card we can't
 * positively prove is expired (the submit flow rejects stragglers as a backstop).
 */
function eventDeadlinePassed(details) {
  if (!details) return false;          // lookup failed — keep the card
  if (details.resolvedAt) return true; // event already resolved
  if (!details.eventDate) return false;
  const d = new Date(details.eventDate);
  if (Number.isNaN(d.getTime())) return false;
  const fmt = (dt) =>
    `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  return fmt(d) <= fmt(new Date());
}

/**
 * Enrich cards with event details and drop any whose deadline has already
 * passed. Runs lookups in bounded concurrent batches — a large wallet can be
 * dozens of cards, so we cap concurrency (not 1-at-a-time: serial chunks of 4
 * were the single biggest chunk of My Cards' cold latency) and use a single
 * retry per card (cached details — including contest cards already resolved by
 * getUserContestLineups — mean repeat opens cost nothing). Cards whose lookup
 * fails are kept (the submit flow rejects expired stragglers as a backstop).
 * Also upgrades each card's name with the canonical one.
 */
async function filterOutExpiredCards(cards) {
  const out = [];
  const CHUNK = 12;
  for (let i = 0; i < cards.length; i += CHUNK) {
    const chunk = cards.slice(i, i + CHUNK);
    const results = await Promise.allSettled(chunk.map(c => getCardDetails(c.id, { retries: 1 })));
    for (let j = 0; j < chunk.length; j++) {
      const details = results[j].status === 'fulfilled' ? results[j].value : null;
      if (eventDeadlinePassed(details)) continue;
      if (details?.name) chunk[j].name = details.name;
      out.push(chunk[j]);
    }
  }
  return out;
}

/**
 * Get every card a wallet could back a prediction with — owned cards (wallet
 * balances) plus cards entered in active contest lineups, with cards whose
 * event deadline has already passed removed.
 * Returns array of { id, name, inContest }. Best-effort: returns whatever it
 * could gather, [] on total failure. Wallet-owned cards win over contest cards
 * when a card appears in both.
 *
 * The assembled list is cached per wallet for PREDICTABLE_CARDS_TTL so repeated
 * My Cards taps don't re-run the whole balances + contests + per-card deadline
 * pipeline (and re-flood the API) every time. Only non-empty results are cached.
 */
const predictableCardsCache = new Map(); // wallet -> { at, value }
const PREDICTABLE_CARDS_TTL = 3 * 60 * 1000;

export async function getPredictableCards(walletAddress) {
  const cached = predictableCardsCache.get(walletAddress);
  if (cached && Date.now() - cached.at < PREDICTABLE_CARDS_TTL) {
    return cached.value;
  }

  const byId = new Map();

  // 1. Wallet balances (all cards, no cardId filter).
  try {
    const res = await fetchRetry(`${BASE}/cards/balances/${walletAddress}`, { timeout: 15_000 });
    if (res.ok) {
      const json = await res.json();
      const data = json.data ?? json;

      // Normalize into [cardId, entry] pairs. The filtered endpoint returns an
      // object keyed by cardId; defend against an array shape too.
      const pairs = Array.isArray(data)
        ? data.map(e => [e?.cardId || e?.card?.id, e])
        : Object.entries(data || {});

      for (const [cardId, entry] of pairs) {
        if (!cardId || !entry) continue;
        const claimed = parseInt(entry.claimedQuantity || '0', 10);
        const unclaimed = parseInt(entry.unclaimedQuantity || '0', 10);
        if (claimed + unclaimed <= 0) continue;
        byId.set(cardId, { id: cardId, name: entry.card?.name || cardId, inContest: false });
      }
    }
  } catch (err) {
    console.error(`Upshot API: getPredictableCards balances(${walletAddress}) failed:`, err.message);
  }

  // 2. Contest lineup cards (reuse the existing lineup fetcher).
  try {
    const contests = await getUserContestLineups(walletAddress);
    for (const contest of contests) {
      for (const lineup of contest.lineups) {
        for (const card of lineup.cards) {
          if (!card?.id || byId.has(card.id)) continue;
          byId.set(card.id, { id: card.id, name: card.name || card.id, inContest: true });
        }
      }
    }
  } catch (err) {
    console.error(`Upshot API: getPredictableCards contests(${walletAddress}) failed:`, err.message);
  }

  // Drop cards whose event deadline has already passed — they can't be predicted.
  let result;
  try {
    result = await filterOutExpiredCards([...byId.values()]);
  } catch (err) {
    console.error(`Upshot API: getPredictableCards deadline filter(${walletAddress}) failed:`, err.message);
    result = [...byId.values()];
  }

  // Cache only useful results — don't pin an empty list (likely a transient API
  // failure) for the full TTL and lock the user out of their cards.
  if (result.length > 0) {
    cacheSet(predictableCardsCache, walletAddress, { at: Date.now(), value: result }, 1000);
  }
  return result;
}

/**
 * Check if a card's event has been resolved and whether the card won.
 * Returns { resolved: boolean, won: boolean | null, error?: string }
 *   - resolved=false: event still active
 *   - resolved=true, won=true: card outcome matches winning outcome (hit)
 *   - resolved=true, won=false: card lost (fail)
 */
export async function checkCardResolution(cardId) {
  // Resolution detection must use live event status, not a cached snapshot, and
  // fail fast (1 retry, 10s): the auto-resolve sweep runs sequentially over
  // every open prediction, so the default 3 retries × 15s would let a single
  // hung/tarpitted card stall the whole batch for ~60s.
  //
  // Distinguish a genuine 404 (card gone — error 'card_not_found') from a
  // transient miss (timeout/5xx/network — error 'fetch_failed'). Both leave the
  // prediction unresolved for the next sweep, but only a real 404 is worth
  // flagging; conflating the two made transient timeouts look like Upshot had
  // dropped live cards.
  const r = await fetchCardDetails(cardId, { retries: 1, timeout: 10_000 });
  if (!r.ok) {
    return { resolved: false, won: null, error: r.notFound ? 'card_not_found' : 'fetch_failed' };
  }
  const card = r.value;
  if (card.eventStatus !== 'RESOLVED') {
    return { resolved: false, won: null };
  }
  const won = card.outcomeId === card.winningOutcomeId;
  return { resolved: true, won };
}

/**
 * List Upshot events (the things shown across the site — "F1 AU GP", "MrBeast
 * Hits 500M", etc). Read-only, best-effort: returns [] on any failure.
 *   GET /events  → { data: [{ id, name, status, eventDate, kind, outcomes, ... }] }
 * Returns a normalized array:
 *   { id, name, description, image, status, kind, eventDate, prizePool,
 *     winningOutcomeId, resolvedAt, outcomes: [{ id, name }] }
 * `status` is 'ACTIVE' while open and 'RESOLVED' once decided. The winning
 * outcome name is resolved by matching winningOutcomeId against outcomes[].
 * Used by the event watcher to announce new live events and their results; the
 * same shape should fit Lucky Shots once that endpoint is known.
 */
export async function getEvents() {
  try {
    const res = await fetchRetry(`${BASE}/events`, { timeout: 12_000 });
    if (!res.ok) return [];
    const json = await res.json();
    const all = json.data ?? json;
    if (!Array.isArray(all)) return [];
    return all.map(e => ({
      id: e.id,
      name: e.name,
      description: e.description || null,
      image: e.image || null,
      status: e.status || null,
      kind: e.kind || null,
      eventDate: e.eventDate || null,
      prizePool: e.prizePool || null,
      winningOutcomeId: e.winningOutcomeId || null,
      resolvedAt: e.resolvedAt || null,
      outcomes: Array.isArray(e.outcomes) ? e.outcomes.map(o => ({ id: o.id, name: o.name })) : [],
    })).filter(e => e.id);
  } catch (err) {
    console.error('Upshot API: getEvents() failed:', err.message);
    return [];
  }
}

// Base for Lucky Shots / raffle requests. Defaults to the normal API, but can be
// pointed at a local relay (e.g. the Upshot sniper CDP browser proxy) via
// UPSHOT_RAFFLE_BASE when direct server-side requests are blocked by the shield.
// The relay must mirror the same paths and return the same JSON.
const RAFFLE_BASE = process.env.UPSHOT_RAFFLE_BASE || BASE;

/**
 * List Upshot raffles ("Lucky Shots"). Pass a status to filter — unlike /events,
 * the ?status filter is honored here: READY (upcoming), LIVE, ENDED, DRAWN.
 * Read-only, best-effort: returns [] on any failure. Normalized shape:
 *   { id, name, description, image, startDate, endDate, status, rewardType,
 *     rewardAmount, winnerId, totalTickets, rewards: [{ refId, quantity }] }
 */
export async function getRaffles(status) {
  try {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await fetchRetry(`${RAFFLE_BASE}/raffles${qs}`, { timeout: 12_000 });
    if (!res.ok) return [];
    const json = await res.json();
    const all = json.data ?? json;
    if (!Array.isArray(all)) return [];
    return all.map(r => ({
      id: r.id,
      name: r.shortName || r.name || r.id,
      description: r.shortDescription || null,
      image: r.image || null,
      startDate: r.startDate || null,
      endDate: r.endDate || null,
      status: r.status || null,
      rewardType: r.rewardType || null,
      rewardAmount: r.rewardAmount ?? null,
      winnerId: r.winnerId || null,
      totalTickets: r.totalTickets ?? null,
      rewards: Array.isArray(r.rewards) ? r.rewards.map(x => ({ refId: x.refId, quantity: x.quantity })) : [],
    })).filter(r => r.id);
  } catch (err) {
    console.error('Upshot API: getRaffles() failed:', err.message);
    return [];
  }
}

/**
 * Fetch a single raffle's detail, including the embedded winner once DRAWN.
 * Returns { ...raffle, winner: { id, username, avatarUrl, walletAddress } | null }
 * or null on failure.
 */
export async function getRaffleDetail(raffleId) {
  try {
    const res = await fetchRetry(`${RAFFLE_BASE}/raffles/${raffleId}`, { timeout: 12_000 });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json.data ?? json;
    if (!r?.id) return null;
    return {
      id: r.id,
      name: r.shortName || r.name || r.id,
      status: r.status || null,
      endDate: r.endDate || null,
      image: r.image || null,
      winner: r.winner
        ? { id: r.winner.id, username: r.winner.username || null, avatarUrl: r.winner.avatarUrl || null, walletAddress: r.winner.walletAddress || null }
        : null,
    };
  } catch (err) {
    console.error(`Upshot API: getRaffleDetail(${raffleId}) failed:`, err.message);
    return null;
  }
}

/**
 * Get a user's season rank and XP from the Upshot leaderboard.
 * Returns { rank, effectiveXP, winningCardPoints, setCompletionPoints, otherRankPoints, totalParticipants, seasonEnd } or null.
 */
export async function getSeasonRank(walletAddress) {
  try {
    // 1. Get current season
    const seasonsRes = await fetchRetry(`${BASE}/seasons`, { timeout: 10_000 });
    if (!seasonsRes.ok) return null;
    const seasonsJson = await seasonsRes.json();
    const seasons = seasonsJson.data || [];
    if (seasons.length === 0) return null;
    const season = seasons[0]; // most recent season

    // 2. Get userId from wallet
    const userRes = await fetchRetry(`${BASE}/users/${walletAddress}`, { timeout: 10_000 });
    if (!userRes.ok) return null;
    const userJson = await userRes.json();
    const userId = userJson.data?.id;
    if (!userId) return null;

    // 3. Get season rank for user
    const rankRes = await fetchRetry(`${BASE}/seasons/${season.id}/users/${userId}`, { timeout: 10_000 });
    if (!rankRes.ok) return null;
    const rankJson = await rankRes.json();
    const data = rankJson.data;
    if (!data) return null;

    return {
      rank: data.rank,
      effectiveXP: parseInt(data.effectiveXP || '0', 10),
      winningCardPoints: data.winningCardPoints || 0,
      setCompletionPoints: data.setCompletionPoints || 0,
      otherRankPoints: data.otherRankPoints || 0,
      totalParticipants: season.totalParticipants || 0,
      seasonEnd: season.endDate,
      username: userJson.data?.username || null,
      displayName: userJson.data?.displayName || null,
    };
  } catch (err) {
    console.error(`Upshot API: getSeasonRank(${walletAddress}) failed:`, err.message);
    return null;
  }
}

/**
 * Look up a user profile by wallet address.
 * Returns { username, displayName, address, ... } or null.
 */
export async function getUserProfile(walletAddress) {
  try {
    const res = await fetchRetry(`${BASE}/users/${walletAddress}`, { timeout: 10_000 });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data || null;
  } catch (err) {
    console.error(`Upshot API: getUserProfile(${walletAddress}) failed:`, err.message);
    return null;
  }
}

/**
 * Transfer unopened packs to another Upshot user. MUTATING + IRREVERSIBLE.
 *   POST /packs/transfer  { recipientId, packId, quantity }
 *   Authorization: Bearer <accessToken>   (the app JWT from the sender's session)
 * `recipientId` is the recipient's internal Upshot user id (getUserProfile().id),
 * NOT a wallet address. Returns { ok, data? } or { ok:false, code, error }.
 */
export async function transferPack({ recipientId, packId, quantity }, token) {
  if (!token) return { ok: false, code: 'no_token', error: 'No Upshot token configured.' };
  try {
    const res = await fetch(`${BASE}/packs/transfer`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipientId, packId, quantity }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    // Bunny Shield serves an HTML challenge instead of JSON when it blocks us.
    if (body.trimStart().startsWith('<')) {
      return { ok: false, code: 'shield', error: 'Blocked by Upshot anti-bot shield (server-side request was challenged).' };
    }
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* non-JSON response */ }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: res.status, error: 'Upshot token expired or invalid — set a fresh one.' };
    }
    if (!res.ok) {
      return { ok: false, code: res.status, error: json?.message || json?.error || `HTTP ${res.status}` };
    }
    return { ok: true, data: json?.data ?? json ?? null };
  } catch (err) {
    return { ok: false, code: 'network', error: err.message };
  }
}

/**
 * Exchange a (rotating) Upshot refresh token for a fresh access token.
 *   POST /auth/refresh  { refreshToken }
 *   → 201 { data: { accessToken, refreshToken } }
 * This is the SAME endpoint the web app uses to stay logged in — no browser,
 * no Google/Privy OAuth round-trip needed for the Upshot JWT itself.
 * IMPORTANT: both tokens rotate (the old refresh token is invalidated on use),
 * so the caller MUST persist the returned refreshToken or the chain breaks.
 * Returns { ok:true, accessToken, refreshToken } or { ok:false, code, error }.
 */
export async function refreshUpshotAccessToken(refreshToken) {
  if (!refreshToken) return { ok: false, code: 'no_refresh', error: 'No Upshot refresh token available.' };
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': process.env.UPSHOT_APP_URL || 'https://upshot.cards',
      },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    // Bunny Shield serves an HTML challenge instead of JSON when it blocks us.
    if (text.trimStart().startsWith('<')) {
      return { ok: false, code: 'shield', error: 'Blocked by Upshot anti-bot shield.' };
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
    if (!res.ok) {
      return { ok: false, code: res.status, error: json?.message || json?.error || `HTTP ${res.status}` };
    }
    const data = json?.data ?? json ?? {};
    const accessToken = data.accessToken || data.token || data.access_token;
    const newRefresh = data.refreshToken || data.refresh_token || refreshToken;
    if (!accessToken) return { ok: false, code: 'no_token', error: 'Refresh response had no accessToken.' };
    return { ok: true, accessToken, refreshToken: newRefresh };
  } catch (err) {
    return { ok: false, code: 'network', error: err.message };
  }
}

/**
 * Unopened packs held by a wallet.
 *   GET /packs/balances/{wallet}
 *   → { data: { [packId]: { quantity, pack: { id, name, status, cardQuantity } } } }
 * Returns [{ packId, name, quantity, status, cardQuantity }] for packs with qty > 0.
 * Read-only. Best-effort: returns [] on any failure.
 */
export async function getUserPacks(walletAddress) {
  try {
    const res = await fetchRetry(`${BASE}/packs/balances/${walletAddress}`, { timeout: 10_000 });
    if (!res.ok) return [];
    const json = await res.json();
    const data = json.data ?? {};
    const out = [];
    for (const [packId, entry] of Object.entries(data)) {
      const quantity = parseInt(entry?.quantity ?? '0', 10);
      if (!quantity || quantity <= 0) continue;
      out.push({
        packId: entry?.pack?.id || packId,
        name: entry?.pack?.name || packId,
        quantity,
        status: entry?.pack?.status || null,
        cardQuantity: entry?.pack?.cardQuantity ?? null,
      });
    }
    return out;
  } catch (err) {
    console.error(`Upshot API: getUserPacks(${walletAddress}) failed:`, err.message);
    return [];
  }
}
