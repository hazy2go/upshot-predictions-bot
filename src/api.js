// ── Upshot Public API Client ─────────────────────────────────
//
// Base URL: https://api-mainnet.upshotcards.net/api/v1
// No auth required for read endpoints.
//
// Card images are Arweave transaction IDs: https://arweave.net/{image}

const BASE = 'https://api-mainnet.upshotcards.net/api/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global concurrency limiter for ALL Upshot requests. My Cards (and the
// watchers) fan out a lot — paginated balances + every live contest's standings
// + per-card lookups — and firing them all at once makes Upshot's shield reset
// the connections ("fetch failed" / ECONNRESET), which on the Pi turned My Cards
// into 0 cards. Funnelling every request through a small semaphore caps how many
// hit the network simultaneously, no matter how many callers fan out, so a burst
// becomes a smooth queue instead of a flood. Tunable via UPSHOT_MAX_CONCURRENCY.
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.UPSHOT_MAX_CONCURRENCY || '4', 10));
let _inFlight = 0;
const _waiters = [];
function acquireSlot() {
  if (_inFlight < MAX_CONCURRENCY) { _inFlight++; return Promise.resolve(); }
  return new Promise((resolve) => _waiters.push(resolve));
}
function releaseSlot() {
  const next = _waiters.shift();
  if (next) next(); // hand the slot directly to the next waiter (count stays put)
  else _inFlight--;
}

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
      await acquireSlot();
      let res;
      try {
        res = await fetch(url, {
          signal: AbortSignal.timeout(timeout),
          headers: { ...READ_HEADERS, ...headers },
        });
      } finally {
        releaseSlot();
      }
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

// The /contests endpoint is PAGINATED — meta: { total, lastPage, currentPage,
// perPage }, perPage defaulting to 20. Fetching only page 1 silently drops every
// contest past the first 20: a card entered in a LIVE contest on page 2+ then
// reads as "not owned" (checkCardInContests never scans that contest — the "bot
// says I don't own my card but I do" bug), and the contest watcher never sees
// those contests to announce them. A high perPage collapses it to one request
// (the endpoint honors perPage≥100, unlike /cards/balances which caps at 100);
// we still page through lastPage in case that cap behavior ever changes.
// Returns [] on a page-1 failure. Bounded concurrency keeps us off the shield.
const CONTESTS_PER_PAGE = 200;
const CONTESTS_MAX_PAGES = 25; // safety cap (~5000 contests); log if exceeded
async function fetchAllContests() {
  const page = (p) => fetchRetry(`${BASE}/contests?page=${p}&perPage=${CONTESTS_PER_PAGE}`, { timeout: 12_000 });
  const arrOf = (json) => Array.isArray(json?.data ?? json) ? (json.data ?? json) : [];

  const first = await page(1);
  if (!first.ok) return [];
  const firstJson = await first.json();
  const out = [...arrOf(firstJson)];

  let lastPage = firstJson.meta?.lastPage || 1;
  if (lastPage > CONTESTS_MAX_PAGES) {
    console.warn(`Upshot API: ${firstJson.meta?.total} contests (${lastPage} pages); capping at ${CONTESTS_MAX_PAGES}.`);
    lastPage = CONTESTS_MAX_PAGES;
  }

  const CHUNK = 5;
  for (let start = 2; start <= lastPage; start += CHUNK) {
    const batch = [];
    for (let p = start; p < start + CHUNK && p <= lastPage; p++) batch.push(p);
    const results = await Promise.allSettled(batch.map(p => page(p).then(r => r.ok ? r.json() : null)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) out.push(...arrOf(r.value));
    }
  }
  return out;
}

// Live contests, deduped and cached. Returns [] on failure (never throws).
async function getLiveContests() {
  if (_liveContests && Date.now() - _liveContests.at < LIVE_CONTESTS_TTL) {
    return _liveContests.value;
  }
  if (_liveContestsInFlight) return _liveContestsInFlight;
  _liveContestsInFlight = (async () => {
    // NOTE: ?status=LIVE upstream filter is unreliable — returns only a subset
    // of LIVE contests. Fetch all (paginated) and filter client-side.
    const all = await fetchAllContests();
    return all.filter(c => c.status === 'LIVE');
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
    // retries:2 so a transient miss doesn't leave the card showing its raw ID in
    // the picker (the global concurrency limiter keeps the extra attempts from
    // flooding the API).
    const cardNames = new Map();
    const cardFetches = await Promise.allSettled(
      [...allCardIds].map(async (cardId) => {
        const details = await getCardDetails(cardId, { retries: 2 });
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
 * Drop any card whose event deadline has already passed. Cards that carry an
 * embedded `event` (everything from wallet balances) are filtered inline with
 * NO network call — critical for large wallets (hundreds/thousands of cards;
 * fetching each would take minutes and trip the API shield). Only cards WITHOUT
 * an embedded event (contest-lineup cards) fall back to a bounded getCardDetails
 * lookup. Cards whose lookup fails are kept (the submit flow rejects expired
 * stragglers as a backstop). Returns { id, name, inContest } entries.
 */
async function filterOutExpiredCards(cards) {
  const out = [];
  const needFetch = [];

  for (const c of cards) {
    if (c.event) {
      if (!eventDeadlinePassed({ resolvedAt: c.event.resolvedAt, eventDate: c.event.eventDate })) {
        out.push({ id: c.id, name: c.name, inContest: c.inContest });
      }
    } else {
      needFetch.push(c);
    }
  }

  const CHUNK = 12;
  for (let i = 0; i < needFetch.length; i += CHUNK) {
    const chunk = needFetch.slice(i, i + CHUNK);
    const results = await Promise.allSettled(chunk.map(c => getCardDetails(c.id, { retries: 2 })));
    for (let j = 0; j < chunk.length; j++) {
      const details = results[j].status === 'fulfilled' ? results[j].value : null;
      if (eventDeadlinePassed(details)) continue;
      out.push({ id: chunk[j].id, name: details?.name || chunk[j].name, inContest: chunk[j].inContest });
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

// The unfiltered /cards/balances/{wallet} endpoint is PAGINATED — meta:
// { total, lastPage, currentPage, perPage }. perPage caps at 100 (200+ returns
// empty), and there's no owned-only filter. We must page through ALL of it or a
// large wallet silently loses every card past page 1 (the "My Cards doesn't
// show my card" bug — a 2,393-entry wallet only ever surfaced its first 20).
// Returns [cardId, entry] pairs across every page. Bounded concurrency keeps us
// from firing 100+ requests at the shield at once.
const BALANCES_PER_PAGE = 100;
const BALANCES_MAX_PAGES = 60; // safety cap (~6000 entries); log if a wallet exceeds it

// Returns { pairs, complete }. `complete` is false if page 1 failed or any
// later page errored — callers use it to avoid CACHING a partial list (which
// would otherwise pin "fewer cards than you own" for the whole TTL). A capped
// (too-many-pages) wallet still counts as complete: we intentionally stop there.
async function fetchAllBalancePairs(walletAddress) {
  const pairsOf = (data) => Array.isArray(data)
    ? data.map(e => [e?.cardId || e?.card?.id, e])
    : Object.entries(data || {});

  const page = (p) => fetchRetry(`${BASE}/cards/balances/${walletAddress}?page=${p}&perPage=${BALANCES_PER_PAGE}`, { timeout: 15_000 });

  const first = await page(1);
  if (!first.ok) return { pairs: [], complete: false };
  const firstJson = await first.json();
  const out = pairsOf(firstJson.data ?? firstJson);
  let complete = true;

  let lastPage = firstJson.meta?.lastPage || 1;
  if (lastPage > BALANCES_MAX_PAGES) {
    console.warn(`Upshot API: ${walletAddress} has ${firstJson.meta?.total} balance entries (${lastPage} pages); capping at ${BALANCES_MAX_PAGES}.`);
    lastPage = BALANCES_MAX_PAGES;
  }

  // Pages 2..lastPage in small concurrent batches.
  const CHUNK = 6;
  for (let start = 2; start <= lastPage; start += CHUNK) {
    const batch = [];
    for (let p = start; p < start + CHUNK && p <= lastPage; p++) batch.push(p);
    const results = await Promise.allSettled(batch.map(p => page(p).then(r => r.ok ? r.json() : null)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) out.push(...pairsOf(r.value.data ?? r.value));
      else complete = false; // a page failed — result is partial, don't cache it
    }
  }
  return { pairs: out, complete };
}

// Aggregate collection stats for a wallet from its (paginated) balances. Uses
// the embedded event on each card, so no per-card fetches. Returns:
//   { totalCards, totalCopies, active, resolved, winning, lost }
// totalCards = distinct cards held (qty>0); totalCopies = sum of all copies.
// (We deliberately don't surface claimed/unclaimed — that's an internal Upshot
// accounting split, not "prizes to claim", and is confusing as a headline stat.)
// Cached briefly so repeated /mystats taps don't re-page a large wallet.
const cardStatsCache = new Map(); // wallet -> { at, value }
const CARD_STATS_TTL = 2 * 60 * 1000;

export async function getCardStats(walletAddress) {
  const cached = cardStatsCache.get(walletAddress);
  if (cached && Date.now() - cached.at < CARD_STATS_TTL) return cached.value;

  const s = { totalCards: 0, totalCopies: 0, active: 0, resolved: 0, winning: 0, lost: 0 };
  let complete;
  try {
    const res = await fetchAllBalancePairs(walletAddress);
    complete = res.complete;
    for (const [cardId, entry] of res.pairs) {
      if (!cardId || !entry) continue;
      const claimed = parseInt(entry.claimedQuantity || '0', 10);
      const unc = parseInt(entry.unclaimedQuantity || '0', 10);
      const qty = claimed + unc;
      if (qty <= 0) continue;
      s.totalCards++;
      s.totalCopies += qty;
      const ev = entry.card?.event || entry.card?.outcome?.event || null;
      if (ev?.status === 'RESOLVED') {
        s.resolved++;
        const outcomeId = entry.card?.outcomeId;
        const won = outcomeId && ev.winningOutcomeId ? outcomeId === ev.winningOutcomeId : !!entry.winning;
        if (won) s.winning++; else s.lost++;
      } else if (ev?.status === 'ACTIVE') {
        s.active++;
      }
    }
  } catch (err) {
    console.error(`Upshot API: getCardStats(${walletAddress}) failed:`, err.message);
    return null;
  }
  // Don't cache a partial fetch (a failed page) or a zero result (likely a
  // transient miss) — either would pin wrong numbers for the TTL.
  if (complete && s.totalCards > 0) {
    cacheSet(cardStatsCache, walletAddress, { at: Date.now(), value: s }, 1000);
  }
  return s;
}

export async function getPredictableCards(walletAddress) {
  const cached = predictableCardsCache.get(walletAddress);
  if (cached && Date.now() - cached.at < PREDICTABLE_CARDS_TTL) {
    return cached.value;
  }

  const byId = new Map();
  let balancesComplete = true;

  // 1. Wallet balances — ALL pages (the endpoint is paginated; see above). The
  // balances payload embeds each card's event, so we capture it here and the
  // deadline filter can use it directly — no per-card detail fetch (a large
  // wallet is hundreds/thousands of cards; fetching each would take minutes and
  // hammer the API).
  try {
    const res = await fetchAllBalancePairs(walletAddress);
    balancesComplete = res.complete;
    for (const [cardId, entry] of res.pairs) {
      if (!cardId || !entry) continue;
      const claimed = parseInt(entry.claimedQuantity || '0', 10);
      const unclaimed = parseInt(entry.unclaimedQuantity || '0', 10);
      if (claimed + unclaimed <= 0) continue;
      const event = entry.card?.event || entry.card?.outcome?.event || null;
      byId.set(cardId, { id: cardId, name: entry.card?.name || cardId, inContest: false, event });
    }
  } catch (err) {
    balancesComplete = false;
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

  // Cache only useful, COMPLETE results — don't pin an empty list (likely a
  // transient API failure) or a partial one (a failed balance page) for the full
  // TTL, which would hide cards the user actually owns.
  if (result.length > 0 && balancesComplete) {
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
 * List Upshot contests. Read-only, best-effort: returns [] on any failure.
 *   GET /contests → { data: [{ id, name, status, startDate, endDate, prizePool, ... }] }
 * The ?status filter is unreliable upstream, so we fetch all and the caller
 * filters client-side. `status` is 'LIVE' while running and 'COMPLETED' once
 * settled. Normalized array:
 *   { id, name, description, image, status, startDate, endDate, prizePool,
 *     prizeType, lineupCount }
 * Used by the contest watcher to announce new contests and their top-3 results.
 */
export async function getContests() {
  try {
    // Paginated upstream — page through all of it (see fetchAllContests), or the
    // watcher never announces contests/results that land past the first page.
    const all = await fetchAllContests();
    if (!Array.isArray(all)) return [];
    return all.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description || null,
      image: c.image || null,
      status: c.status || null,
      startDate: c.startDate || null,
      endDate: c.endDate || null,
      prizePool: c.prizePool ?? null,
      prizeType: c.prizeType || null,
      lineupCount: c.lineupCount ?? null,
    })).filter(c => c.id);
  } catch (err) {
    console.error('Upshot API: getContests() failed:', err.message);
    return [];
  }
}

/**
 * Top-N standings for a contest. Reuses the cached standings fetch.
 * Returns [{ rank, username, walletAddress, score }] (score is the raw
 * micro-unit integer; format with /1e6 for display). Best-effort [].
 */
export async function getContestTop(contestId, n = 3) {
  try {
    const data = await getContestStandings(contestId);
    const standings = data?.standings || [];
    return standings.slice(0, n).map((e, i) => ({
      rank: e.rank ?? i + 1,
      username: e.user?.username || e.user?.displayName || null,
      walletAddress: e.user?.walletAddress || null,
      score: parseInt(e.currentScore || '0', 10),
    }));
  } catch (err) {
    console.error(`Upshot API: getContestTop(${contestId}) failed:`, err.message);
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
 * Top-N ticket holders ("Live Leaderboard") for a raffle.
 *   GET /raffles/{id}/standings → [{ ticketCount, user: { username, ... } }]
 * The list is already sorted by ticketCount desc. Returns
 *   [{ rank, username, tickets, chance }]
 * where tickets is the human count (ticketCount / 1e6) and chance is the share
 * of totalTickets (0–1), if totalTickets is provided. Best-effort [].
 */
export async function getRaffleTop(raffleId, n = 3, totalTickets = null) {
  try {
    const res = await fetchRetry(`${RAFFLE_BASE}/raffles/${raffleId}/standings`, { timeout: 12_000 });
    if (!res.ok) return [];
    const json = await res.json();
    const arr = json.data ?? json;
    if (!Array.isArray(arr)) return [];
    const total = totalTickets != null ? Number(totalTickets) : null;
    return arr.slice(0, n).map((e, i) => {
      const raw = Number(e.ticketCount || 0);
      return {
        rank: i + 1,
        username: e.user?.username || e.user?.displayName || null,
        tickets: Math.round(raw / 1_000_000),
        chance: total && total > 0 ? raw / total : null,
      };
    });
  } catch (err) {
    console.error(`Upshot API: getRaffleTop(${raffleId}) failed:`, err.message);
    return [];
  }
}

// ── Store (packs + bundles) ──────────────────────────────────
//
// The store at upshot.cards/store is two endpoints: /packs and /bundles. Both
// carry `status` (ACTIVE / COMING_SOON / SOLD_OUT / DRAFT / UNAVAILABLE /
// ARCHIVED), an effective price in micro-units, and `remainingStock`.

function normalizeStoreItem(raw, kind) {
  const priceRaw = raw.effectivePrice ?? raw.finalPrice ?? raw.pricePerPack ?? raw.basePrice;
  const price = priceRaw != null && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) / 1_000_000 : null;
  return {
    id: raw.id,
    kind, // 'pack' | 'bundle'
    name: raw.name,
    description: raw.description || null,
    image: raw.image || null,
    status: raw.status || null,
    price,
    currency: raw.priceCurrency || 'CASH',
    cardQuantity: raw.cardQuantity ?? null,   // packs
    totalPacks: raw.totalPacks ?? null,        // bundles
    remaining: raw.remainingStock ?? null,
    releaseDate: raw.releaseDate || null,
  };
}

// List store packs (normalized). Read-only, best-effort: [] on failure.
export async function getStorePacks() {
  try {
    const res = await fetchRetry(`${BASE}/packs`, { timeout: 12_000 });
    if (!res.ok) return [];
    const all = (await res.json()).data ?? [];
    return Array.isArray(all) ? all.map(p => normalizeStoreItem(p, 'pack')).filter(x => x.id) : [];
  } catch (err) {
    console.error('Upshot API: getStorePacks() failed:', err.message);
    return [];
  }
}

// List store bundles (normalized). Read-only, best-effort: [] on failure.
export async function getStoreBundles() {
  try {
    const res = await fetchRetry(`${BASE}/bundles`, { timeout: 12_000 });
    if (!res.ok) return [];
    const all = (await res.json()).data ?? [];
    return Array.isArray(all) ? all.map(b => normalizeStoreItem(b, 'bundle')).filter(x => x.id) : [];
  } catch (err) {
    console.error('Upshot API: getStoreBundles() failed:', err.message);
    return [];
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
