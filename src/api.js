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
    const res = await fetch(`${BASE}/contests?status=LIVE`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    const contests = json.data || json;
    if (!Array.isArray(contests)) return false;

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
