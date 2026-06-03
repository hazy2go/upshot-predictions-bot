// ── Upshot Public API Client ─────────────────────────────────
//
// Base URL: https://api-mainnet.upshotcards.net/api/v1
// No auth required for read endpoints.
//
// Card images are Arweave transaction IDs: https://arweave.net/{image}

const BASE = 'https://api-mainnet.upshotcards.net/api/v1';

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
 */
export async function getCardDetails(cardId) {
  try {
    const res = await fetch(`${BASE}/cards/${cardId}?include=event,supply`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const card = json.data;
    if (!card) return null;

    return {
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
  } catch (err) {
    console.error(`Upshot API: getCardDetails(${cardId}) failed:`, err.message);
    return null;
  }
}

/**
 * Check if a wallet owns a specific card.
 * First checks wallet balances, then falls back to scanning active contests
 * (cards entered in contests don't show in balances).
 * Returns { owned: boolean, quantity: number, winning: boolean, card: object|null, inContest: boolean }
 */
export async function checkCardOwnership(walletAddress, cardId) {
  try {
    const res = await fetch(`${BASE}/cards/balances/${walletAddress}?cardId=${cardId}`, {
      signal: AbortSignal.timeout(10_000),
    });
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
    // NOTE: ?status=LIVE upstream filter is unreliable — returns only a subset
    // of LIVE contests. Fetch all and filter client-side.
    const res = await fetch(`${BASE}/contests`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    const all = json.data || json;
    if (!Array.isArray(all)) return false;
    const contests = all.filter(c => c.status === 'LIVE');

    const lowerWallet = walletAddress.toLowerCase();

    // Check each live contest's standings
    for (const contest of contests) {
      try {
        const sRes = await fetch(`${BASE}/contests/${contest.id}/standings`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!sRes.ok) continue;
        const sJson = await sRes.json();
        const standings = sJson.data?.standings || [];

        for (const entry of standings) {
          if (entry.user?.walletAddress?.toLowerCase() === lowerWallet) {
            if (entry.lineup?.cardIds?.includes(cardId)) {
              return true;
            }
          }
        }
      } catch {
        continue; // skip this contest on error
      }
    }

    return false;
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
    const res = await fetch(`${BASE}/contests`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const json = await res.json();
    const all = json.data || json;
    if (!Array.isArray(all)) return [];
    const contests = all.filter(c => c.status === 'LIVE');

    const lowerWallet = walletAddress.toLowerCase();

    // Fetch all contest standings in parallel
    const standingsResults = await Promise.allSettled(
      contests.map(async (contest) => {
        const sRes = await fetch(`${BASE}/contests/${contest.id}/standings`, { signal: AbortSignal.timeout(15_000) });
        if (!sRes.ok) return null;
        const sJson = await sRes.json();
        return { contest, standings: sJson.data?.standings || [], totalLineups: sJson.data?.totalLineups || 0 };
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

    // Fetch all card names in parallel (batch)
    const cardNames = new Map();
    const cardFetches = await Promise.allSettled(
      [...allCardIds].map(async (cardId) => {
        const cRes = await fetch(`${BASE}/cards/${cardId}`, { signal: AbortSignal.timeout(10_000) });
        if (cRes.ok) {
          const name = (await cRes.json()).data?.name || cardId;
          return { cardId, name };
        }
        return { cardId, name: cardId };
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
 * passed. Runs lookups in small concurrent batches to avoid hammering the API.
 * Also upgrades each card's name with the canonical one from the details call.
 */
async function filterOutExpiredCards(cards) {
  const out = [];
  const CHUNK = 10;
  for (let i = 0; i < cards.length; i += CHUNK) {
    const chunk = cards.slice(i, i + CHUNK);
    const results = await Promise.allSettled(chunk.map(c => getCardDetails(c.id)));
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
 */
export async function getPredictableCards(walletAddress) {
  const byId = new Map();

  // 1. Wallet balances (all cards, no cardId filter).
  try {
    const res = await fetch(`${BASE}/cards/balances/${walletAddress}`, {
      signal: AbortSignal.timeout(15_000),
    });
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
  try {
    return await filterOutExpiredCards([...byId.values()]);
  } catch (err) {
    console.error(`Upshot API: getPredictableCards deadline filter(${walletAddress}) failed:`, err.message);
    return [...byId.values()];
  }
}

/**
 * Check if a card's event has been resolved and whether the card won.
 * Returns { resolved: boolean, won: boolean | null, error?: string }
 *   - resolved=false: event still active
 *   - resolved=true, won=true: card outcome matches winning outcome (hit)
 *   - resolved=true, won=false: card lost (fail)
 */
export async function checkCardResolution(cardId) {
  try {
    const card = await getCardDetails(cardId);
    if (!card) return { resolved: false, won: null, error: 'card_not_found' };

    if (card.eventStatus !== 'RESOLVED') {
      return { resolved: false, won: null };
    }

    const won = card.outcomeId === card.winningOutcomeId;
    return { resolved: true, won };
  } catch (err) {
    console.error(`Upshot API: checkCardResolution(${cardId}) failed:`, err.message);
    return { resolved: false, won: null, error: err.message };
  }
}

/**
 * Get a user's season rank and XP from the Upshot leaderboard.
 * Returns { rank, effectiveXP, winningCardPoints, setCompletionPoints, otherRankPoints, totalParticipants, seasonEnd } or null.
 */
export async function getSeasonRank(walletAddress) {
  try {
    // 1. Get current season
    const seasonsRes = await fetch(`${BASE}/seasons`, { signal: AbortSignal.timeout(10_000) });
    if (!seasonsRes.ok) return null;
    const seasonsJson = await seasonsRes.json();
    const seasons = seasonsJson.data || [];
    if (seasons.length === 0) return null;
    const season = seasons[0]; // most recent season

    // 2. Get userId from wallet
    const userRes = await fetch(`${BASE}/users/${walletAddress}`, { signal: AbortSignal.timeout(10_000) });
    if (!userRes.ok) return null;
    const userJson = await userRes.json();
    const userId = userJson.data?.id;
    if (!userId) return null;

    // 3. Get season rank for user
    const rankRes = await fetch(`${BASE}/seasons/${season.id}/users/${userId}`, { signal: AbortSignal.timeout(10_000) });
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
    const res = await fetch(`${BASE}/users/${walletAddress}`, {
      signal: AbortSignal.timeout(10_000),
    });
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
    const res = await fetch(`${BASE}/packs/balances/${walletAddress}`, {
      signal: AbortSignal.timeout(10_000),
    });
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
