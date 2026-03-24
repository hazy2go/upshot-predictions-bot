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
      arweaveUrl: card.image ? `https://arweave.net/${card.image}` : null,
      maxSupply: card.maxSupply,
      pointsValue: card.pointsValue,
      event: card.event || null,
    };
  } catch (err) {
    console.error(`Upshot API: getCardDetails(${cardId}) failed:`, err.message);
    return null;
  }
}

/**
 * Check if a wallet owns a specific card.
 * Returns { owned: boolean, quantity: number, winning: boolean, card: object|null }
 */
export async function checkCardOwnership(walletAddress, cardId) {
  try {
    const res = await fetch(`${BASE}/cards/balances/${walletAddress}?cardId=${cardId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { owned: false, quantity: 0, winning: false, card: null };
    const json = await res.json();
    const data = json.data;

    if (!data || !data[cardId]) {
      return { owned: false, quantity: 0, winning: false, card: null };
    }

    const entry = data[cardId];
    const claimed = parseInt(entry.claimedQuantity || '0', 10);
    const unclaimed = parseInt(entry.unclaimedQuantity || '0', 10);

    return {
      owned: (claimed + unclaimed) > 0,
      quantity: claimed + unclaimed,
      winning: !!entry.winning,
      card: entry.card || null,
    };
  } catch (err) {
    console.error(`Upshot API: checkCardOwnership(${walletAddress}, ${cardId}) failed:`, err.message);
    return { owned: false, quantity: 0, winning: false, card: null, error: err.message };
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
