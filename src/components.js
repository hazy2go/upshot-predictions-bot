import {
  ComponentType as CT, ButtonStyle, Colors, Points,
  statusLabel, statusColor, starPoints, weightedStarRating, Status, isRated, renderStars,
} from './constants.js';

// ── Helpers ─────────────────────────────────────────────────

function container(accentColor, children) {
  return { type: CT.Container, accent_color: accentColor, components: children };
}

function text(content) {
  return { type: CT.TextDisplay, content };
}

function separator(spacing = 1) {
  return { type: CT.Separator, spacing, divider: true };
}

function actionRow(...buttons) {
  return { type: CT.ActionRow, components: buttons };
}

function button(customId, label, style = ButtonStyle.Secondary, options = {}) {
  return {
    type: CT.Button,
    custom_id: customId,
    label,
    style,
    ...options,
  };
}

// Upshot value fields (pointsValue, prizePool, scores) are micro-units: 1e6 = 1
// unit. Format a stored gold value for display, e.g. 941666666 -> "941.67".
export function formatGold(microUnits) {
  const n = Number(microUnits) || 0;
  return (n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Link-style button: opens a URL instead of firing an interaction (no custom_id).
function linkButton(url, label) {
  return { type: CT.Button, style: ButtonStyle.Link, url, label };
}

/**
 * MediaGallery that references local attachments via attachment:// protocol.
 * Filenames must match the AttachmentBuilder `name` used when sending the message.
 */
function mediaGallery(filenames) {
  return {
    type: CT.MediaGallery,
    items: filenames.map(f => ({ media: { url: `attachment://${f}` } })),
  };
}

// ── Prediction panel (posted by admin to any channel) ─────────

export function buildPredictionPanel(title, description, imageUrl) {
  const children = [];

  children.push(text(`## ${title}`));
  children.push(separator());
  children.push(text(description));

  if (imageUrl) {
    children.push({
      type: CT.MediaGallery,
      items: [{ media: { url: imageUrl } }],
    });
  }

  children.push(separator());
  children.push(text('-# Everything you need is one tap away — no commands to memorize.'));
  children.push(actionRow(
    button('hub_mycards', '📇 My Cards', ButtonStyle.Success),
    button('panel_predict_url', '🔗 Predict by URL', ButtonStyle.Primary),
    button('hub_mystats', '📊 My Stats', ButtonStyle.Secondary),
    button('panel_help:0', '❓ How It Works', ButtonStyle.Secondary),
  ));

  return {
    components: [container(Colors.Leaderboard, children)],
    flags: 1 << 15,
  };
}

// ── Card picker (ephemeral — pick a card to predict, no URL needed) ──

// Discord StringSelect menus cap at 25 options, so we page through the full
// list 25 at a time with prev/next buttons — every card stays reachable.
export const CARDS_PER_PAGE = 25;

/**
 * StringSelect listing the cards a member can predict on right now, paginated.
 * cards: [{ id, name, inContest }] — already filtered (no taken cards).
 * Pick a card to open its detail view; predictions are made from there.
 */
export function buildCardPicker(cards, { page = 0, query = null } = {}) {
  const totalPages = Math.max(1, Math.ceil(cards.length / CARDS_PER_PAGE));
  const idx = Math.max(0, Math.min(page, totalPages - 1));
  const start = idx * CARDS_PER_PAGE;
  const pageCards = cards.slice(start, start + CARDS_PER_PAGE);

  const children = [];

  children.push(text('## 📇 Your Predictable Cards'));
  if (query) {
    children.push(text(`-# 🔍 Search: **${query}** — ${cards.length} match${cards.length === 1 ? '' : 'es'}. Cards in an open prediction are hidden.`));
  } else {
    children.push(text(`-# Pick a card to see its details, then predict. Cards already in an open prediction are hidden. (**${cards.length}** card${cards.length === 1 ? '' : 's'})`));
  }
  children.push(separator());

  // No matches (e.g. a search that found nothing) — a StringSelect with 0
  // options is rejected by Discord, so show a message + actions instead.
  if (cards.length === 0) {
    children.push(text(query ? `No cards match **${query}**.` : 'No cards to show.'));
    children.push(actionRow(
      button('mycards_search', '🔍 Search again', ButtonStyle.Primary),
      ...(query ? [button('mycards_search_clear', '✖ Show all', ButtonStyle.Secondary)] : []),
    ));
    return { components: [container(Colors.Leaderboard, children)], flags: (1 << 15) | (1 << 6) };
  }

  const options = pageCards.map(c => ({
    label: c.name.length > 100 ? c.name.slice(0, 97) + '...' : c.name,
    value: c.id,
    description: c.inContest ? '🏅 From a contest you entered' : 'In your wallet',
  }));

  children.push({
    type: CT.ActionRow,
    components: [{
      type: CT.StringSelect,
      custom_id: 'predict_card_select',
      placeholder: totalPages > 1
        ? `Select a card… (page ${idx + 1} of ${totalPages})`
        : 'Select a card to see its details…',
      min_values: 1,
      max_values: 1,
      options,
    }],
  });

  if (totalPages > 1) {
    children.push(separator());
    children.push(text(`-# Page ${idx + 1} of ${totalPages} · showing cards ${start + 1}–${start + pageCards.length}`));
    // custom_id is `mycards_page:<targetPage>:<role>`. The role suffix keeps all
    // four ids unique even when targets coincide (e.g. on page 1, First and Prev
    // both point to page 0; near the end, Next and Last both point to the last
    // page) — Discord rejects the whole message if two custom_ids match. The
    // handler reads split(':')[1] as the page, so the suffix is inert there.
    children.push(actionRow(
      button('mycards_page:0:first', '« First', ButtonStyle.Secondary, { disabled: idx === 0 }),
      button(`mycards_page:${idx - 1}:prev`, '← Prev', ButtonStyle.Secondary, { disabled: idx === 0 }),
      button(`mycards_page:${idx + 1}:next`, 'Next →', ButtonStyle.Secondary, { disabled: idx >= totalPages - 1 }),
      button(`mycards_page:${totalPages - 1}:last`, 'Last »', ButtonStyle.Secondary, { disabled: idx >= totalPages - 1 }),
    ));
  }

  // Search controls: search always available; clear only shown while filtering.
  children.push(separator());
  children.push(actionRow(
    button('mycards_search', '🔍 Search', ButtonStyle.Primary),
    ...(query ? [button('mycards_search_clear', '✖ Show all', ButtonStyle.Secondary)] : []),
  ));

  return {
    components: [container(Colors.Leaderboard, children)],
    flags: (1 << 15) | (1 << 6),
  };
}

/**
 * Card detail view shown after a member picks a card from the picker.
 * Surfaces the marketplace URL and card ID (both copyable/shareable) and offers
 * Back / Predict actions. `taken` is a message string when the card already has
 * an open prediction — in that case the Predict button is withheld.
 * card: { id, name, arweaveUrl?, rarity?, deadline?, inContest? }
 */
export function buildCardDetail(card, { taken = null } = {}) {
  const marketplaceUrl = `https://upshot.cards/card-detail/${card.id}`;
  const children = [];

  children.push(text(`## ${card.name || 'Upshot Card'}`));

  const image = card.arweaveUrl || card.image;
  if (image) {
    children.push({
      type: CT.MediaGallery,
      items: [{ media: { url: image } }],
    });
  }

  const meta = [];
  if (card.rarity) meta.push(`**Rarity:** ${card.rarity}`);
  if (card.deadline) meta.push(`**Event deadline:** ${card.deadline}`);
  meta.push(card.inContest ? '🏅 From a contest you entered' : '👛 In your wallet');
  children.push(text(meta.join(' · ')));

  children.push(separator());

  // Marketplace URL + card ID — both rendered as plain/code text so they're
  // easy to copy out of the embed and share.
  children.push(text(`🛒 **Marketplace URL**\n${marketplaceUrl}`));
  children.push(text(`🆔 **Card ID**\n\`${card.id}\``));
  children.push(text('-# Copy the link or ID above to share this card with anyone.'));

  children.push(separator());

  if (taken) {
    children.push(text(taken));
    children.push(actionRow(
      button('carddetail_back', '← Back to My Cards', ButtonStyle.Secondary),
      linkButton(marketplaceUrl, '🛒 View on Upshot'),
    ));
  } else {
    children.push(actionRow(
      button('carddetail_back', '← Back to My Cards', ButtonStyle.Secondary),
      button(`carddetail_predict:${card.id}`, '🔮 Predict on this card', ButtonStyle.Success),
      linkButton(marketplaceUrl, '🛒 View on Upshot'),
    ));
  }

  return {
    components: [container(Colors.Leaderboard, children)],
    flags: (1 << 15) | (1 << 6),
  };
}

// ── Contest announcements (new / results) ───────────────────
//
// Posted to the configured contests channel by the contest watcher. `contest` is
// the normalized shape from api.getContests(): { id, name, description, image,
// status, startDate, endDate, prizePool, prizeType, lineupCount }.

const CONTEST_URL = (id) => `https://upshot.cards/contests/${id}`;
const MEDAL = ['🥇', '🥈', '🥉'];

// ISO timestamp → Discord dynamic time tag, or null if unparseable.
function timeTag(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;
}

// Return a Discord-safe absolute image URL, or null. The loose `^https?://`
// test let malformed values through (spaces, stray newlines, a bare "https://"),
// which Discord rejects with URL_TYPE_INVALID_URL and kills the whole message.
// Parse with the WHATWG URL parser: it drops anything unparseable and normalizes
// the rest (e.g. percent-encodes spaces) so the media gallery always gets a
// well-formed http(s) URL.
function eventImage(image) {
  if (!image || typeof image !== 'string') return null;
  try {
    const u = new URL(image.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

// Format a micro-unit prize pool ("1250000000" → "1,250") or null.
function prizeText(contest) {
  if (contest.prizePool == null) return null;
  const n = Number(contest.prizePool);
  if (!Number.isFinite(n) || n <= 0) return null;
  const amount = (n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return contest.prizeType ? `${amount} ${contest.prizeType}` : amount;
}

export function buildContestLive(contest) {
  const children = [];
  children.push(text('## 🏆 New Contest Live'));
  children.push(text(`### ${(contest.name || 'Upshot contest').replace(/[\r\n]+/g, ' ')}`));

  const img = eventImage(contest.image);
  if (img) children.push({ type: CT.MediaGallery, items: [{ media: { url: img } }] });

  if (contest.description) children.push(text(contest.description.slice(0, 600)));

  const meta = [];
  const prize = prizeText(contest);
  if (prize) meta.push(`💰 **Prize pool:** ${prize}`);
  const end = timeTag(contest.endDate);
  if (end) meta.push(`🕒 **Ends:** ${end}`);
  if (meta.length) { children.push(separator()); children.push(text(meta.join('\n'))); }

  children.push(text('-# Build your lineup before it closes!'));
  children.push(actionRow(linkButton(CONTEST_URL(contest.id), '🎮 Enter on Upshot')));

  return { components: [container(Colors.Hit, children)], flags: 1 << 15 };
}

// `top` is [{ rank, username, score }] from api.getContestTop().
export function buildContestResults(contest, top) {
  const children = [];
  children.push(text('## 🏁 Contest Over'));
  children.push(text(`### ${(contest.name || 'Upshot contest').replace(/[\r\n]+/g, ' ')}`));

  const img = eventImage(contest.image);
  if (img) children.push({ type: CT.MediaGallery, items: [{ media: { url: img } }] });

  children.push(separator());
  if (top?.length) {
    children.push(text('**🏆 Top 3**'));
    const lines = top.slice(0, 3).map((e, i) =>
      `${MEDAL[i] || `#${e.rank}`} **${e.username || 'unknown'}** — ${(e.score / 1_000_000).toFixed(2)} pts`);
    children.push(text(lines.join('\n')));
  } else {
    children.push(text('✅ This contest has ended.'));
  }
  children.push(actionRow(linkButton(CONTEST_URL(contest.id), '🔗 View on Upshot')));

  return { components: [container(Colors.Leaderboard, children)], flags: 1 << 15 };
}

// Public list of LIVE contests for the admin `/announce contests list` command.
export function buildContestList(contests) {
  const children = [];
  children.push(text(`## 🏆 Live Contests (${contests.length})`));
  if (!contests.length) {
    children.push(text('-# No live contests right now.'));
  } else {
    const lines = contests.slice(0, 40).map(c => {
      const prize = prizeText(c);
      const ends = c.endDate && Number.isFinite(Date.parse(c.endDate)) ? ` · ends <t:${Math.floor(Date.parse(c.endDate) / 1000)}:R>` : '';
      return `🟢 **${(c.name || c.id).slice(0, 70)}**${prize ? ` · 💰 ${prize}` : ''}${ends}`;
    });
    children.push(text(lines.join('\n').slice(0, 3800)));
    if (contests.length > 40) children.push(text(`-# …and ${contests.length - 40} more`));
  }
  return { components: [container(Colors.Stats, children)], flags: 1 << 15 };
}

// ── Lucky Shots (raffles) announcements ─────────────────────
//
// `raffle` is the normalized shape from api.getRaffles(): { id, name,
// description, image, startDate, endDate, status, rewardType, totalTickets, ... }

const RAFFLE_URL = (id) => `https://upshot.cards/lucky-shots/${id}`;

function raffleReward(raffle) {
  const qty = raffle.rewards?.reduce((n, r) => n + (Number(r.quantity) || 0), 0) || 0;
  const type = (raffle.rewardType || '').toLowerCase();
  if (qty && type) return `${qty} ${type}`;
  if (raffle.rewardType) return raffle.rewardType;
  return null;
}

export function buildRaffleLive(raffle) {
  const children = [];
  children.push(text('## 🎰 Lucky Shot Live'));
  children.push(text(`### ${(raffle.name || 'Lucky Shot').replace(/[\r\n]+/g, ' ')}`));

  const img = eventImage(raffle.image);
  if (img) children.push({ type: CT.MediaGallery, items: [{ media: { url: img } }] });

  if (raffle.description) children.push(text(raffle.description.slice(0, 500)));

  const meta = [];
  const reward = raffleReward(raffle);
  if (reward) meta.push(`🎁 **Prize:** ${reward}`);
  const endMs = raffle.endDate ? Date.parse(raffle.endDate) : NaN;
  if (Number.isFinite(endMs)) meta.push(`🕒 **Ends:** <t:${Math.floor(endMs / 1000)}:F> (<t:${Math.floor(endMs / 1000)}:R>)`);
  if (meta.length) { children.push(separator()); children.push(text(meta.join('\n'))); }

  children.push(text('-# Grab your shot before it closes!'));
  children.push(actionRow(linkButton(RAFFLE_URL(raffle.id), '🎟 Enter on Upshot')));

  return { components: [container(Colors.Hit, children)], flags: 1 << 15 };
}

export function buildRaffleWinner(raffle, winner) {
  const children = [];
  children.push(text('## 🏆 Lucky Shot Winner'));
  children.push(text(`### ${(raffle.name || 'Lucky Shot').replace(/[\r\n]+/g, ' ')}`));

  const img = eventImage(raffle.image);
  if (img) children.push({ type: CT.MediaGallery, items: [{ media: { url: img } }] });

  children.push(separator());
  if (winner?.username || winner?.walletAddress) {
    const reward = raffleReward(raffle);
    const handle = winner.username ? `**${winner.username}**` : 'a lucky member';
    const wallet = winner.walletAddress ? `\n\`${winner.walletAddress}\`` : '';
    children.push(text(`🎉 Congratulations to ${handle}${reward ? ` — winner of **${reward}**` : ''}!${wallet}`));
  } else {
    children.push(text('✅ This Lucky Shot has been drawn.'));
  }
  children.push(actionRow(linkButton(RAFFLE_URL(raffle.id), '🔗 View on Upshot')));

  return { components: [container(Colors.Leaderboard, children)], flags: 1 << 15 };
}

// Public list of LIVE + upcoming (READY) raffles for `/announce luckyshots list`. For
// each LIVE raffle it shows the top-3 ticket holders. `topByRaffle` is a Map of
// raffleId → [{ rank, username, tickets, chance }] from api.getRaffleTop().
export function buildRaffleList(raffles, topByRaffle = new Map()) {
  // Only LIVE and READY — never ENDED/DRAWN.
  const order = { LIVE: 0, READY: 1 };
  const shown = raffles.filter(r => r.status === 'LIVE' || r.status === 'READY')
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  const children = [];
  children.push(text(`## 🎰 Lucky Shots (${shown.length} live/upcoming)`));
  if (!shown.length) {
    children.push(text('-# No live or upcoming Lucky Shots right now.'));
    return { components: [container(Colors.Stats, children)], flags: 1 << 15 };
  }

  for (const r of shown) {
    children.push(separator());
    const dot = r.status === 'LIVE' ? '🟢' : '🔜';
    const ends = r.endDate && Number.isFinite(Date.parse(r.endDate)) ? ` · ends <t:${Math.floor(Date.parse(r.endDate) / 1000)}:R>` : '';
    children.push(text(`${dot} **${(r.name || r.id).slice(0, 80)}** \`${r.status}\`${ends}`));

    if (r.status === 'LIVE') {
      const top = topByRaffle.get(r.id) || [];
      if (top.length) {
        const lines = top.slice(0, 3).map((e, i) => {
          const chance = e.chance != null ? ` · ${(e.chance * 100).toFixed(1)}%` : '';
          return `${MEDAL[i] || `#${e.rank}`} **${e.username || 'unknown'}** — ${e.tickets.toLocaleString('en-US')} 🎟${chance}`;
        });
        children.push(text(lines.join('\n')));
      } else {
        children.push(text('-# No tickets yet.'));
      }
    }
  }
  return { components: [container(Colors.Stats, children)], flags: 1 << 15 };
}

// ── Pack giveaways (Discord-native, button entry) ───────────
//
// `g` is the hydrated row from database.getGiveaway(): { id, pack_name,
// winners_count, description, required_roles[], excluded_roles[],
// excluded_users[], ends_at, status, winner_ids[], ... }

// Render the eligibility rules as human-readable lines (role/user mentions).
function giveawayRules(g) {
  const lines = [];
  if (g.required_roles?.length) {
    lines.push(`✅ **Must have:** ${g.required_roles.map(r => `<@&${r}>`).join(' or ')}`);
  }
  if (g.excluded_roles?.length) {
    lines.push(`🚫 **Excluded roles:** ${g.excluded_roles.map(r => `<@&${r}>`).join(', ')}`);
  }
  if (g.excluded_users?.length) {
    lines.push(`🚫 **Excluded:** ${g.excluded_users.map(u => `<@${u}>`).join(', ')}`);
  }
  if (g.require_prediction) {
    lines.push('📈 **Must have made at least one prediction**');
  }
  if (g.required_pack) {
    lines.push(`🎴 **Must hold pack:** ${g.required_pack}`);
  }
  return lines;
}

export function buildGiveawayLive(g, entryCount = 0) {
  const children = [];
  children.push(text('## 🎁 Pack Giveaway'));
  children.push(text(`### ${g.pack_name}`));
  if (g.description) children.push(text(g.description.slice(0, 600)));

  children.push(separator());
  const meta = [];
  meta.push(`🏆 **Winners:** ${g.winners_count}`);
  const endMs = Date.parse(g.ends_at);
  if (Number.isFinite(endMs)) meta.push(`🕒 **Ends:** <t:${Math.floor(endMs / 1000)}:F> (<t:${Math.floor(endMs / 1000)}:R>)`);
  meta.push(`🎟 **Entries:** ${entryCount}`);
  children.push(text(meta.join('\n')));

  const rules = giveawayRules(g);
  if (rules.length) { children.push(separator()); children.push(text(rules.join('\n'))); }

  children.push(text('-# 🔗 An Upshot wallet must be connected to enter — the pack is sent there automatically.'));
  children.push(actionRow(button(`gw_enter:${g.id}`, '🎟 Enter', ButtonStyle.Primary)));

  return { components: [container(Colors.Pending, children)], flags: 1 << 15 };
}

export function buildGiveawayEnded(g, winnerIds = []) {
  const children = [];
  children.push(text('## 🎁 Pack Giveaway — Ended'));
  children.push(text(`### ${g.pack_name}`));
  children.push(separator());
  if (winnerIds.length) {
    const who = winnerIds.map(id => `<@${id}>`).join(', ');
    children.push(text(`🎉 **Winner${winnerIds.length > 1 ? 's' : ''}:** ${who}`));
    children.push(text(`📦 A **${g.pack_name}** pack has been sent to ${winnerIds.length > 1 ? 'their wallets' : 'their wallet'}.`));
  } else {
    children.push(text('😕 No eligible entrants — no winner was drawn.'));
  }

  return { components: [container(winnerIds.length ? Colors.Hit : Colors.Fail, children)], flags: 1 << 15 };
}

// ── Store (packs + bundles) announcements ───────────────────
//
// `item` is the normalized shape from api.getStorePacks()/getStoreBundles():
// { id, kind: 'pack'|'bundle', name, description, image, status, price,
//   currency, cardQuantity, totalPacks, remaining }

const PACK_URL = () => 'https://upshot.cards/store';

function storePrice(item) {
  if (item.price == null) return null;
  const amount = item.price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${amount} ${item.currency || 'CASH'}`;
}

// "X / Y" (remaining of the initial drop) when the drop size is known, else "X".
// initialSupply is derived (sold + remaining); bundles carry no supply so it's
// null there and we just show remaining. null-safe → returns null if no stock.
function storeStock(item) {
  if (item.remaining == null) return null;
  const rem = item.remaining.toLocaleString('en-US');
  return item.initialSupply ? `${rem} / ${item.initialSupply.toLocaleString('en-US')}` : rem;
}

export function buildStoreListed(item) {
  const isBundle = item.kind === 'bundle';
  const children = [];
  children.push(text(isBundle ? '## 🎁 New Bundle Listed' : '## 📦 New Pack Listed'));
  children.push(text(`### ${(item.name || 'Upshot item').replace(/[\r\n]+/g, ' ')}`));

  const img = eventImage(item.image);
  if (img) children.push({ type: CT.MediaGallery, items: [{ media: { url: img } }] });

  if (item.description) children.push(text(item.description.slice(0, 500)));

  const meta = [];
  const price = storePrice(item);
  if (price) meta.push(`💵 **Price:** ${price}`);
  if (isBundle && item.totalPacks != null) meta.push(`📦 **Packs:** ${item.totalPacks}`);
  if (!isBundle && item.cardQuantity != null) meta.push(`🃏 **Cards per pack:** ${item.cardQuantity}`);
  const stock = storeStock(item);
  if (item.status !== 'COMING_SOON' && stock) meta.push(`📊 **Remaining:** ${stock}`);
  if (item.sold != null && item.sold > 0) meta.push(`🛒 **Sold:** ${item.sold.toLocaleString('en-US')}`);
  if (item.status === 'COMING_SOON') meta.push('🔜 **Coming soon**');
  if (meta.length) { children.push(separator()); children.push(text(meta.join('\n'))); }

  children.push(actionRow(linkButton(PACK_URL(), '🛒 Open the Store')));

  return { components: [container(Colors.Verified, children)], flags: 1 << 15 };
}

// Public list of available (ACTIVE) + upcoming (COMING_SOON) packs & bundles with
// remaining stock, for `/announce store list`. `items` is packs+bundles combined.
// Hide ACTIVE packs that are sold out (remaining:0 — Upshot keeps them ACTIVE),
// but always keep COMING_SOON ones: they're upcoming, not sold out, so a 0/empty
// stock there just means "not on sale yet" (and we never label them sold out).
export function buildStoreList(items) {
  const order = { ACTIVE: 0, COMING_SOON: 1 };
  const shown = items
    .filter(i => (i.status === 'ACTIVE' && i.remaining !== 0) || i.status === 'COMING_SOON')
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  const children = [];
  children.push(text(`## 🛒 Upshot Store (${shown.length} available)`));
  if (!shown.length) {
    children.push(text('-# Nothing available right now.'));
    return { components: [container(Colors.Stats, children)], flags: 1 << 15 };
  }

  const fmt = (i) => {
    const tag = i.kind === 'bundle' ? '🎁' : '📦';
    const soon = i.status === 'COMING_SOON' ? ' 🔜' : '';
    const price = storePrice(i);
    const rem = i.remaining != null && i.remaining > 0 ? `${storeStock(i)} left` : '';
    const bits = [price, rem].filter(Boolean).join(' · ');
    return `${tag} **${(i.name || i.id).slice(0, 70)}**${soon}${bits ? ` — ${bits}` : ''}`;
  };
  children.push(text(shown.slice(0, 40).map(fmt).join('\n').slice(0, 3800)));
  if (shown.length > 40) children.push(text(`-# …and ${shown.length - 40} more`));
  children.push(actionRow(linkButton(PACK_URL(), '🛒 Open the Store')));

  return { components: [container(Colors.Stats, children)], flags: 1 << 15 };
}

// ── Admin panel (/admin) — overview + quick access to settings & actions ────
//
// `cfg` is assembled by the handler: {
//   channels: { predictions, admin, leaderboard, contests, luckyshots, store } (id|null),
//   adminRole (id|null), ownerId (id|null), maxDaily, maxOpen, categories: [],
//   token: { set: bool, expiresInMin: number|null }
// }
// SETTINGS lists every configurable item so the panel and the configure select
// stay in sync. `key` is the select value; `kind` drives the input widget.
const ADMIN_SETTINGS = [
  { key: 'predictions_channel', label: 'Predictions channel', kind: 'channel', emoji: '📣' },
  { key: 'admin_channel',       label: 'Admin channel',       kind: 'channel', emoji: '🛡' },
  { key: 'leaderboard_channel', label: 'Leaderboard channel', kind: 'channel', emoji: '🏆' },
  { key: 'contests_channel',    label: 'Contests channel',    kind: 'channel', emoji: '🎯' },
  { key: 'luckyshots_channel',  label: 'Lucky Shots channel', kind: 'channel', emoji: '🎰' },
  { key: 'store_channel',       label: 'Store channel',       kind: 'channel', emoji: '🛒' },
  { key: 'admin_role',          label: 'Admin role',          kind: 'role',    emoji: '👮' },
  { key: 'max_daily',           label: 'Max predictions / day', kind: 'int',   emoji: '📆' },
  { key: 'max_open',            label: 'Max open predictions',  kind: 'int',   emoji: '📂' },
  { key: 'upshot_token',        label: 'Upshot token (packs/giveaways)', kind: 'token', emoji: '🔑' },
  { key: 'owner_id',            label: 'Lock /sendpack & /giveaway to me', kind: 'owner', emoji: '🔒' },
];

export const ADMIN_SETTINGS_LIST = ADMIN_SETTINGS; // exported for the handler

export function buildAdminPanel(cfg) {
  const ch = cfg.channels || {};
  const chan = (id) => id ? `<#${id}>` : '❌ not set';
  const tokenLine = cfg.token?.set
    ? (cfg.token.expiresInMin != null
        ? (cfg.token.expiresInMin > 0 ? `✅ set · expires in ~${cfg.token.expiresInMin} min` : '⚠️ set but EXPIRED')
        : '✅ set')
    : '❌ not set';

  const children = [];
  children.push(text('## 🛠 Admin Panel'));
  children.push(text('-# Overview of every setting. Use the menu to change one, or the buttons to run an action. (Slash commands still work too.)'));
  children.push(separator());
  children.push(text([
    '**Channels**',
    `📣 Predictions: ${chan(ch.predictions)}`,
    `🛡 Admin review: ${chan(ch.admin)}`,
    `🏆 Leaderboard: ${chan(ch.leaderboard)}`,
    `🎯 Contests: ${chan(ch.contests)}`,
    `🎰 Lucky Shots: ${chan(ch.luckyshots)}`,
    `🛒 Store: ${chan(ch.store)}`,
  ].join('\n')));
  children.push(text([
    '**Settings**',
    `👮 Admin role: ${cfg.adminRole ? `<@&${cfg.adminRole}>` : 'server admins'}`,
    `🔒 Pack/giveaway owner: ${cfg.ownerId ? `<@${cfg.ownerId}>` : 'any admin'}`,
    `📆 Max daily: **${cfg.maxDaily}** · 📂 Max open: **${cfg.maxOpen}**`,
    `🔑 Upshot token: ${tokenLine}`,
    `🗂 Categories: ${cfg.categories?.length ? cfg.categories.join(', ') : '—'}`,
  ].join('\n')));
  children.push(separator());

  // Configure select
  children.push({
    type: CT.ActionRow,
    components: [{
      type: CT.StringSelect,
      custom_id: 'admin_configure',
      placeholder: '⚙️ Change a setting…',
      min_values: 1,
      max_values: 1,
      options: ADMIN_SETTINGS.map(s => ({ label: s.label, value: s.key, emoji: { name: s.emoji } })),
    }],
  });

  // Action buttons
  children.push(actionRow(
    button('admin_act:refresh_lb', '🔄 Refresh leaderboard', ButtonStyle.Secondary),
    button('admin_act:contests', '🎯 Check contests', ButtonStyle.Secondary),
    button('admin_act:luckyshots', '🎰 Check Lucky Shots', ButtonStyle.Secondary),
  ));
  children.push(actionRow(
    button('admin_act:store', '🛒 Check store', ButtonStyle.Secondary),
    button('admin_act:resolve', '✅ Check resolutions', ButtonStyle.Secondary),
    button('admin_refresh', '↻ Refresh panel', ButtonStyle.Primary),
  ));

  return { components: [container(Colors.Admin, children)], flags: (1 << 15) | (1 << 6) };
}

// Sub-view: pick a channel for a given setting (ChannelSelect + Back).
export function buildAdminPickChannel(setting) {
  return {
    components: [container(Colors.Admin, [
      text(`## ${setting.emoji} Set ${setting.label}`),
      text('-# Pick a text channel below, or go back.'),
      { type: CT.ActionRow, components: [{
        type: CT.ChannelSelect,
        custom_id: `admin_setchan:${setting.key}`,
        placeholder: 'Select a channel…',
        channel_types: [0], // GuildText
        min_values: 1, max_values: 1,
      }] },
      actionRow(button('admin_back', '← Back', ButtonStyle.Secondary)),
    ])],
    flags: (1 << 15) | (1 << 6),
  };
}

// Sub-view: pick the admin role (RoleSelect + Back).
export function buildAdminPickRole() {
  return {
    components: [container(Colors.Admin, [
      text('## 👮 Set Admin role'),
      text('-# Pick the role that can review/resolve predictions, or go back.'),
      { type: CT.ActionRow, components: [{
        type: CT.RoleSelect,
        custom_id: 'admin_setrole',
        placeholder: 'Select a role…',
        min_values: 1, max_values: 1,
      }] },
      actionRow(button('admin_back', '← Back', ButtonStyle.Secondary)),
    ])],
    flags: (1 << 15) | (1 << 6),
  };
}

export function buildCardPickerEmpty() {
  return {
    components: [
      container(Colors.Stats, [
        text('## 📇 No Predictable Cards Found'),
        text('We couldn\'t find any Upshot cards in your wallet or active contest lineups.'),
        text('-# Your wallet may be empty, or the Upshot API may be temporarily down. Get cards at [upshot.cards](https://upshot.cards), then tap Try Again.'),
        separator(),
        actionRow(
          button('mycards_retry', '🔄 Try Again', ButtonStyle.Success),
        ),
      ]),
    ],
    flags: (1 << 15) | (1 << 6),
  };
}

// ── Help pages (ephemeral, paginated) ─────────────────────────

const helpPages = [
  // Page 1 — Getting Started
  [
    '## Getting Started',
    '',
    '**The panel has everything — no commands needed:**',
    '📇 **My Cards** · 📊 **My Stats** · ❓ **How It Works**',
    '',
    '-# 🏆 The Top 10 each month earn rewards — predictions are **70%** of your score. See the last page for details.',
    '',
    '**1. Link your Upshot profile**',
    'The first time you tap **My Cards**, you\'ll be asked to paste your Upshot profile URL.',
    '',
    '**How to get your profile URL:**',
    'Go to [upshot.cards](https://upshot.cards), click **View Profile** (top-right), then copy the URL or click **Share Profile**.',
    '',
    '**2. Pick a card and predict**',
    'Tap **📇 My Cards** to browse every card you can predict on — including cards in your contest lineups. Open one to see its details and marketplace link, then hit **Predict** and write your thesis. No URLs to copy.',
  ].join('\n'),

  // Page 2 — Picking your card
  [
    '## Picking Your Card',
    '',
    '**📇 My Cards — the only way to predict**',
    'Tap **My Cards** to browse every card you own or have entered in a contest. The list pages through all of them 25 at a time, and cards someone already predicted on are hidden, so you never pick a dead end.',
    '',
    '**Card details**',
    'Open a card to see its image, rarity, event deadline, and its **marketplace URL + card ID** — both easy to copy and share. From there, hit **🔮 Predict** to make your call, or **← Back** to browse more.',
    '',
    '**What happens after you submit:**',
    '- The bot fetches the card image, name, and deadline automatically',
    '- Your prediction is titled after the card — you just write the thesis',
    '- It checks your wallet (and contest lineups) actually hold the card',
    '- Your prediction is posted to the feed and sent for admin review',
    '',
    '**Tweet URL (optional)**',
    'Link a tweet about your prediction for a **+1 bonus point** if it hits. Must be from twitter.com or x.com.',
  ].join('\n'),

  // Page 3 — Points & Community Voting
  [
    '## Points & Community Voting',
    '',
    '**Quality rating (0-3 stars)**',
    '🚫 0 stars = **0 pts** · ⭐ 1 star = 1 pt · ⭐⭐ 2 stars = 3 pts · ⭐⭐⭐ 3 stars = 5 pts',
    '',
    '🚫 **0 stars = low-effort.** Restating the card, a question, hype, off-topic or spam earns **nothing** — no points, and **no hit or tweet bonus even if it comes true.** Put in real effort: make an original call and back it up.',
    '',
    '**Community voting**',
    'Every prediction has vote buttons — rate others\' predictions 1-3 stars! You can\'t vote on your own. The final quality rating is:',
    '- **70% admin** + **30% community average**',
    '- You can change your vote at any time',
    '- A 0★ low-effort rating stands on its own — community votes can\'t lift it',
    '',
    '**Outcome Bonuses** (1★+ only)',
    '🟢 Prediction hits = **+10 pts**',
    '📎 Tweet linked + hit = **+1 pt**',
    '🔴 Prediction fails = quality pts only',
    '',
    '-# Example: admin 3⭐, community avg 2⭐ → weighted 3⭐ (5pts) + hit (10) + tweet (1) = **16 pts**',
    '-# Example: 🚫 0★ low-effort → **0 pts**, even if it hits and has a tweet',
  ].join('\n'),

  // Page 4 — Rules & Tips
  [
    '## Rules & Tips',
    '',
    '- **1 prediction per day** — make it count',
    '- **Max 5 open predictions** — let some resolve before adding more',
    '- **Edit window** — you can edit within 1 hour of submitting; after that it\'s locked in',
    '- **You must own the card** — your wallet is checked automatically; no ownership = prediction removed',
    '- ‼️ **Link your OWN profile only** — using someone else\'s = permanent ban from rewards',
    '- **Auto-resolve** — outcomes are checked automatically via the Upshot API every 12h',
    '',
    '**Prefer typing? Optional slash-command shortcuts:**',
    '`/mycontests` — Your active contest lineups',
    '`/pastleaderboard` — View a past month\'s leaderboard',
    '`/upshotrank` — Your Upshot season rank',
    '`/link-upshot` — Update your profile link',
  ].join('\n'),

  // Page 5 — Monthly Rewards
  [
    '## 🎁 Monthly Rewards',
    '',
    'Each month the **Top 10** community members earn rewards. Your score is made up of:',
    '- **70%** — Predictions (everything in this bot)',
    '- **20%** — Content (your tweets in the content channel)',
    '- **10%** — Engagement (activity in the tweets channel)',
    '',
    '**Prizes**',
    '🏅 **Top 3** → 3 Packs + Role',
    '🎖️ **4th–10th** → 2 Packs + Role',
    '',
    '-# The leaderboard auto-posts in its own channel and resets at the start of each month.',
  ].join('\n'),
];

export function buildHelpPage(page) {
  const total = helpPages.length;
  const idx = Math.max(0, Math.min(page, total - 1));
  const children = [];

  children.push(text(helpPages[idx]));
  children.push(separator());
  children.push(text(`-# Page ${idx + 1} of ${total}`));

  const btns = [];
  if (idx > 0) {
    btns.push(button(`panel_help:${idx - 1}`, '← Back', ButtonStyle.Secondary));
  }
  if (idx < total - 1) {
    btns.push(button(`panel_help:${idx + 1}`, 'Next →', ButtonStyle.Secondary));
  }
  if (btns.length > 0) {
    children.push(actionRow(...btns));
  }

  return {
    components: [container(Colors.Stats, children)],
    flags: (1 << 15) | (1 << 6), // Components v2 + Ephemeral
  };
}

// ── Contest lineups (paginated, ephemeral) ───────────────────

/**
 * Build the contest overview page — lists all contests with a button for each.
 */
export function buildContestOverview(contests) {
  // Cap how many we render: each contest is 1 text node + 1 button, and Discord
  // rejects a message with >40 components / >5 button rows, so a member in 20+
  // contests would otherwise blow the whole message up. Show the first 20.
  const MAX = 20;
  const shown = contests.slice(0, MAX);

  const children = [];
  children.push(text('## 🏅 Your Active Contests'));
  children.push(separator());

  // One joined text block (not one node per contest) so the component count
  // stays well under Discord's 40-per-message cap even with the button row(s).
  const lines = shown.map(c => {
    const lineupCount = c.lineups.length;
    const ranks = c.lineups.map(l => l.rank).filter(Number.isFinite);
    const bestRank = ranks.length ? `#${Math.min(...ranks)}` : '—';
    return `**${c.contestName}**\n${lineupCount} lineup${lineupCount === 1 ? '' : 's'} · Best rank: ${bestRank}`;
  });
  children.push(text(lines.join('\n\n').slice(0, 3900)));

  children.push(separator());

  // One button per contest (max 5 per row). Index matches `shown`/`contestCache`.
  const btns = shown.map((c, i) =>
    button(`contest_select:${i}:0`, c.contestName.length > 40 ? c.contestName.slice(0, 37) + '...' : c.contestName, ButtonStyle.Primary)
  );
  for (let i = 0; i < btns.length; i += 5) {
    children.push(actionRow(...btns.slice(i, i + 5)));
  }
  if (contests.length > MAX) {
    children.push(text(`-# Showing ${MAX} of ${contests.length} contests.`));
  }

  return {
    components: [container(Colors.Gold, children)],
    flags: (1 << 15) | (1 << 6),
  };
}

/**
 * Build a single lineup page within a contest.
 */
export function buildContestLineupPage(contest, lineupIdx, contestIdx) {
  const total = contest.lineups.length;
  const idx = Math.max(0, Math.min(lineupIdx, total - 1));
  const lineup = contest.lineups[idx];
  const children = [];

  children.push(text(`## 🏅 ${contest.contestName}`));
  children.push(separator());

  children.push(text(`**Lineup ${idx + 1} of ${total}** · Rank **#${lineup.rank}** / ${lineup.totalLineups}`));
  const score = (lineup.score / 1_000_000).toFixed(2);
  children.push(text(`**Score:** ${score} pts`));
  children.push(separator());

  for (let i = 0; i < lineup.cards.length; i++) {
    const card = lineup.cards[i];
    children.push(text(`**${i + 1}.** ${card.name}\n-# \`${card.id}\``));
  }

  children.push(separator());

  // Predict directly from this lineup — no backtracking to the card picker.
  const predictOptions = lineup.cards.slice(0, 25).map(c => ({
    label: c.name.length > 100 ? c.name.slice(0, 97) + '...' : c.name,
    value: c.id,
    description: '🏅 From this contest lineup',
  }));
  if (predictOptions.length > 0) {
    children.push({
      type: CT.ActionRow,
      components: [{
        type: CT.StringSelect,
        custom_id: 'contest_predict_select',
        placeholder: '🔮 Predict on a card from this lineup…',
        min_values: 1,
        max_values: 1,
        options: predictOptions,
      }],
    });
  }

  // Navigation
  const btns = [];
  btns.push(button('contest_back', '← All Contests', ButtonStyle.Secondary));
  if (idx > 0) {
    btns.push(button(`contest_select:${contestIdx}:${idx - 1}`, '← Prev', ButtonStyle.Secondary));
  }
  if (idx < total - 1) {
    btns.push(button(`contest_select:${contestIdx}:${idx + 1}`, 'Next →', ButtonStyle.Secondary));
  }
  children.push(actionRow(...btns));

  return {
    components: [container(Colors.Gold, children)],
    flags: (1 << 15) | (1 << 6),
  };
}

// ── Prediction card (public #predictions) ────────────────────

export function buildPredictionCard(prediction, upshotUrl) {
  const color = statusColor(prediction.status);
  const label = statusLabel(prediction.status);
  const children = [];

  // Status badge
  children.push(text(`**${label}**`));
  children.push(separator());

  // Title + meta
  const profileLink = upshotUrl ? `[Upshot Profile](${upshotUrl})` : '';
  children.push(text(`## ${prediction.title}`));
  children.push(text(`<@${prediction.author_id}> · ${profileLink} · Deadline: ${prediction.deadline}`));

  // Description (truncated for feed)
  const desc = prediction.description.length > 280
    ? prediction.description.slice(0, 280) + '...'
    : prediction.description;
  children.push(text(desc));

  // Card image from Arweave (fetched via API)
  if (prediction.card_image) {
    children.push({
      type: CT.MediaGallery,
      items: [{ media: { url: prediction.card_image } }],
    });
  }

  // Proof indicators
  const proofParts = [];
  if (prediction.ownership_verified) {
    proofParts.push('✅ Card ownership verified');
  }
  if (prediction.tweet_url) {
    proofParts.push(`📎 [Tweet Proof](${prediction.tweet_url})`);
  }
  if (proofParts.length > 0) {
    children.push(text(proofParts.join(' · ')));
  }

  children.push(separator());

  // Community rating display
  if (prediction.community_star_avg) {
    const communityStars = prediction.community_star_avg.toFixed(1);
    const communityLine = `👥 Community: **${communityStars}** avg`;
    if (isRated(prediction)) {
      const effective = weightedStarRating(prediction.star_rating, prediction.community_star_avg);
      children.push(text(`${communityLine} · Admin: ${renderStars(prediction.star_rating)} · Weighted: **${renderStars(effective)}**`));
    } else {
      children.push(text(communityLine));
    }
  }

  // Points display (if rated)
  if (isRated(prediction)) {
    const effective = weightedStarRating(prediction.star_rating, prediction.community_star_avg);

    if (effective === 0) {
      // Low-effort: make it unmistakable that this submission earned nothing.
      children.push(text('🚫 **Low-effort — 0★** · **No points awarded** (no rewards even if it hits or has a tweet)'));
    } else {
      const stars = renderStars(effective);
      let pointsLine = `${stars} ${starPoints(effective)} pts`;

      if (prediction.outcome === 'hit') {
        const parts = [`+${starPoints(effective)} quality`, '+10 hit bonus'];
        if (prediction.tweet_url) parts.push(`+${Points.TweetBonus} tweet bonus`);
        pointsLine = `${stars} **${prediction.total_points} pts awarded** (${parts.join(', ')})`;
      } else if (prediction.outcome === 'fail') {
        pointsLine = `${stars} **${prediction.total_points} pts awarded** (quality only)`;
      }

      children.push(text(pointsLine));
    }
  }

  // Footer
  const id = String(prediction.id).padStart(4, '0');
  const date = prediction.created_at?.split('T')[0] || prediction.created_at?.split(' ')[0] || '';
  children.push(text(`-# ID \`#${id}\` · ${date}`));

  // Action buttons
  const btns = [];
  if (prediction.card_id) {
    btns.push(linkButton(`https://upshot.cards/card-detail/${prediction.card_id}`, '🛒 Buy this card'));
  }
  if (prediction.description.length > 280) {
    btns.push(button(`read_more:${prediction.id}`, '📖 Read More', ButtonStyle.Secondary));
  }
  if ([Status.PendingVerification, Status.PendingReview].includes(prediction.status)) {
    btns.push(button(`edit_prediction:${prediction.id}`, '✏ Edit', ButtonStyle.Secondary));
  }
  if (btns.length > 0) {
    children.push(actionRow(...btns));
  }

  // Community vote buttons
  children.push(actionRow(
    button(`community_vote:${prediction.id}:1`, '1 ⭐', ButtonStyle.Secondary),
    button(`community_vote:${prediction.id}:2`, '2 ⭐⭐', ButtonStyle.Secondary),
    button(`community_vote:${prediction.id}:3`, '3 ⭐⭐⭐', ButtonStyle.Secondary),
  ));

  return {
    components: [container(color, children)],
    flags: 1 << 15,
  };
}

// ── Admin review card (#admin-review) ────────────────────────

export function buildAdminCard(prediction, upshotUrl) {
  const children = [];

  children.push(text('**🟣 Admin Review**'));
  children.push(separator());

  const id = String(prediction.id).padStart(4, '0');
  children.push(text(`## ${prediction.title}`));
  children.push(text(`Submitted by <@${prediction.author_id}> · ID \`#${id}\` · ${prediction.created_at?.split('T')[0] || prediction.created_at?.split(' ')[0] || ''}`));

  // Upshot profile
  if (upshotUrl) {
    children.push(text(`🔗 [Upshot Profile](${upshotUrl})`));
  }

  // Full description (no truncation for admin)
  children.push(text(prediction.description));

  // Card image from Arweave
  if (prediction.card_image) {
    children.push({
      type: CT.MediaGallery,
      items: [{ media: { url: prediction.card_image } }],
    });
  }

  // API ownership pre-check result
  if (prediction.ownership_check === 'verified_contest') {
    children.push(text('🤖 **API Pre-check:** ✅ Card in user\'s active contest lineup'));
  } else if (prediction.ownership_check === 'verified') {
    children.push(text('🤖 **API Pre-check:** ✅ User owns this card'));
  } else if (prediction.ownership_check === 'not_found') {
    children.push(text('🤖 **API Pre-check:** ❌ Card NOT found in user\'s wallet'));
  } else if (prediction.ownership_check === 'error') {
    children.push(text('🤖 **API Pre-check:** ⚠️ Could not verify (API error)'));
  }

  // Card ID
  if (prediction.card_id) {
    children.push(text(`🃏 **Card:** \`${prediction.card_id}\``));
  }

  // Tweet proof
  if (prediction.tweet_url) {
    children.push(text(`📎 [Tweet Proof](${prediction.tweet_url})`));
  }

  // Community rating
  if (prediction.community_star_avg) {
    children.push(text(`👥 **Community rating:** ${prediction.community_star_avg.toFixed(1)} avg`));
  }

  children.push(separator());

  // Status info
  const label = statusLabel(prediction.status);
  let statusInfo = `**Status:** ${label}`;
  if (isRated(prediction)) {
    const effective = weightedStarRating(prediction.star_rating, prediction.community_star_avg);
    statusInfo += ` · **Admin:** ${renderStars(prediction.star_rating)} · **Weighted:** ${renderStars(effective)} (${starPoints(effective)} pts)`;
  }
  if (prediction.ownership_verified) {
    statusInfo += ` · ✅ Ownership verified by <@${prediction.verified_by}>`;
  }
  if (prediction.total_points > 0) {
    statusInfo += ` · **Total:** ${prediction.total_points} pts`;
  }
  children.push(text(statusInfo));

  // Action buttons — context-dependent
  const buttons = [];

  if (!prediction.ownership_verified) {
    buttons.push(button(`verify_ownership:${prediction.id}`, '✅ Verify Ownership', ButtonStyle.Success));
  }

  if (prediction.ownership_verified) {
    const label = isRated(prediction) ? '⭐ Change Rating' : '⭐ Assign Stars';
    const style = isRated(prediction) ? ButtonStyle.Secondary : ButtonStyle.Primary;
    buttons.push(button(`assign_stars:${prediction.id}`, label, style));
  }

  if (isRated(prediction)) {
    buttons.push(button(`check_resolve:${prediction.id}`, '🔍 Recheck', ButtonStyle.Primary));
    buttons.push(button(`mark_hit:${prediction.id}`, '🟢 Mark Hit', ButtonStyle.Success));
    buttons.push(button(`mark_fail:${prediction.id}`, '🔴 Mark Fail', ButtonStyle.Danger));
  }

  buttons.push(button(`delete_prediction:${prediction.id}`, '🗑 Delete', ButtonStyle.Danger));

  for (let i = 0; i < buttons.length; i += 5) {
    children.push(actionRow(...buttons.slice(i, i + 5)));
  }

  return {
    components: [container(Colors.Admin, children)],
    flags: 1 << 15,
  };
}

// ── Leaderboard ──────────────────────────────────────────────

export function buildLeaderboard(entries, monthLabel, options = {}) {
  const { showProfiles = false, exportMonthKey = null } = options;
  const profileSuffix = (e) => {
    if (!showProfiles) return '';
    return e.upshot_url ? ` · [Upshot](${e.upshot_url})` : ' · *no Upshot*';
  };

  const lines = ['*Monthly standings · Rewards distributed at month end*', ''];

  if (entries.length === 0) {
    lines.push('*No rated predictions this month yet.*');
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    const top3 = entries.slice(0, 3);

    for (let i = 0; i < top3.length; i++) {
      const e = top3[i];
      const hitRate = e.resolved > 0 ? Math.round((e.hits / e.resolved) * 100) : 0;
      lines.push(
        `${medals[i]} **<@${e.author_id}>** — **${e.total_points}** pts · ${e.prediction_count} pred · ${hitRate}% hit${profileSuffix(e)}`
      );
    }

    if (entries.length > 3) {
      lines.push('');
      for (let i = 3; i < entries.length; i++) {
        const e = entries[i];
        const hitRate = e.resolved > 0 ? Math.round((e.hits / e.resolved) * 100) : 0;
        lines.push(
          `\`#${i + 1}\` <@${e.author_id}> · ${e.prediction_count} pred · ${hitRate}% hit · **${e.total_points}** pts${profileSuffix(e)}`
        );
      }
    }
  }

  // Embed descriptions cap at 4096 chars — trim trailing standings to fit.
  let description = lines.join('\n');
  if (description.length > 4096) {
    const note = '\n-# …more standings hidden (list too long to display).';
    const kept = [];
    let len = 0;
    for (const line of lines) {
      if (len + line.length + 1 + note.length > 4096) break;
      kept.push(line);
      len += line.length + 1;
    }
    description = kept.join('\n') + note;
  }

  const embed = {
    color: Colors.Leaderboard,
    title: `🏆 ${monthLabel} Leaderboard`,
    description,
    footer: { text: 'Updated in real-time · Tap 📇 My Cards to play · 📊 My Stats for your standings' },
    timestamp: new Date().toISOString(),
  };

  const payload = { embeds: [embed] };
  if (exportMonthKey) {
    payload.components = [actionRow(
      button(`leaderboard_export:${exportMonthKey}`, '📥 Export CSV', ButtonStyle.Secondary),
      button(`leaderboard_grant:${exportMonthKey}`, '🎖️ Grant Role to Top 10', ButtonStyle.Secondary),
    )];
  }
  return payload;
}

// ── Personal stats ───────────────────────────────────────────

const STATS_PAGE_SIZE = 15;

export function buildStatsCard(stats, userId, monthLabel, scoredPredictions = [], tier = 0, cardStats = null, futureOpen = [], page = 0, badges = []) {
  const children = [];

  const scoredPageCount = Math.max(1, Math.ceil(scoredPredictions.length / STATS_PAGE_SIZE));
  const scoredPage = Math.min(Math.max(0, page), scoredPageCount - 1);

  children.push(text(`## 📊 Your Stats — ${monthLabel}`));
  children.push(separator());

  // Upshot card collection (from wallet balances) — shown when the profile is
  // linked and the API responded.
  if (cardStats) {
    const c = cardStats;
    const copies = c.totalCopies !== c.totalCards ? ` (${c.totalCopies.toLocaleString('en-US')} copies)` : '';
    const cardWinRate = c.resolved > 0 ? Math.round((c.winning / c.resolved) * 100) : 0;
    children.push(text('**🃏 Card Collection**'));
    children.push(text([
      `**Total cards:** ${c.totalCards.toLocaleString('en-US')}${copies}`,
      `**🟢 Active:** ${c.active.toLocaleString('en-US')}`,
      `**🏆 Winning:** ${c.winning.toLocaleString('en-US')}  ·  **🔴 Lost:** ${c.lost.toLocaleString('en-US')}  (${cardWinRate}% of ${c.resolved.toLocaleString('en-US')} resolved)`,
    ].join('\n')));
    children.push(separator());
  }

  const hitRate = stats.resolved > 0 ? Math.round((stats.hits / stats.resolved) * 100) : 0;
  const avgRating = stats.avg_rating ? stats.avg_rating.toFixed(1) : '—';

  children.push(text([
    `**Total Points:** ${stats.total_points || 0}`,
    `**Predictions:** ${stats.prediction_count || 0}`,
    `**Hit Rate:** ${hitRate}% (${stats.hits || 0}/${stats.resolved || 0} resolved)`,
    `**Avg Quality:** ${avgRating} ⭐`,
    `**Rank:** ${stats.rank ? `#${stats.rank} of ${stats.total_entries}` : 'Unranked'}`,
    tier > 0 ? `**Tier:** ${tier} 🏅 (${tier} top-10 ${tier === 1 ? 'month' : 'months'})` : null,
  ].filter(Boolean).join('\n')));

  if (!stats.rank) {
    children.push(text('-# Make a rated prediction to join the leaderboard.'));
  }

  if (badges.length > 0) {
    children.push(separator());
    children.push(text(`**🎖️ Badges (${badges.length})**`));
    children.push(text(badges.map(b => {
      const label = `${b.emoji ? b.emoji + ' ' : '🏅 '}**${b.name}**`;
      return b.description ? `${label} — ${b.description}` : label;
    }).join('\n')));
  }

  if (scoredPredictions.length > 0) {
    children.push(separator());
    const pageSuffix = scoredPageCount > 1 ? ` — Page ${scoredPage + 1}/${scoredPageCount}` : '';
    children.push(text(`**Scoring Predictions (${scoredPredictions.length})**${pageSuffix}`));
    const start = scoredPage * STATS_PAGE_SIZE;
    const lines = scoredPredictions.slice(start, start + STATS_PAGE_SIZE).map(p => {
      const id = String(p.id).padStart(4, '0');
      const stars = renderStars(p.star_rating);
      const outcomeIcon = p.outcome === 'hit' ? '🟢' : p.outcome === 'fail' ? '🔴' : '⏳';
      const titleSnip = p.title.length > 55 ? p.title.slice(0, 55) + '…' : p.title;
      return `${outcomeIcon} \`#${id}\` **${p.total_points}**pts ${stars} — ${titleSnip}`;
    });
    children.push(text(lines.join('\n')));
  }

  if (futureOpen.length > 0) {
    children.push(separator());
    children.push(text(`**Open in Future Months (${futureOpen.length})**`));
    const lines = futureOpen.slice(0, 15).map(p => {
      const id = String(p.id).padStart(4, '0');
      const stars = renderStars(p.star_rating);
      const titleSnip = p.title.length > 55 ? p.title.slice(0, 55) + '…' : p.title;
      return `⏳ \`#${id}\` ${stars} — ${titleSnip} (due ${p.deadline})`;
    });
    children.push(text(lines.join('\n')));
    if (futureOpen.length > 15) {
      children.push(text(`-# +${futureOpen.length - 15} more`));
    }
  }

  children.push(separator());
  children.push(text('-# Points = quality stars (0/1/3/5) + hit bonus (+10) + tweet bonus (+1) · 🚫 0★ low-effort = 0 pts'));

  // Pager for the scored list — only when it spans more than one page.
  if (scoredPageCount > 1) {
    children.push(actionRow(
      button(`mystats_page:${scoredPage - 1}`, '◀ Prev', ButtonStyle.Secondary, { disabled: scoredPage === 0 }),
      button(`mystats_page:${scoredPage + 1}`, 'Next ▶', ButtonStyle.Secondary, { disabled: scoredPage >= scoredPageCount - 1 }),
    ));
  }

  return {
    components: [container(Colors.Stats, children)],
    flags: 1 << 15,
  };
}

// ── Shot Caller monitoring panel (paginated, Components v2) ──
//
// `view` is a plain, pre-formatted data object built in index.js:
//   { title, headerLines[], blocks[] (this page's member blocks),
//     page, totalPages, afkCount, neverBountyCount, footer }
// Nav buttons carry the target page; the tag buttons act on the whole role.
export function buildShotCallerPanel(view) {
  const {
    title, headerLines = [], blocks = [], page = 0, totalPages = 1,
    afkCount = 0, neverBountyCount = 0, footer = '',
  } = view;

  const children = [];
  children.push(text(`## ${title}`));
  if (headerLines.length) children.push(text(headerLines.join('\n')));
  children.push(separator());
  children.push(text(blocks.length ? blocks.join('\n\n') : '_No members on this page._'));
  children.push(separator());
  const pageInfo = totalPages > 1 ? `Page ${page + 1}/${totalPages} · ` : '';
  children.push(text(`-# ${pageInfo}${footer}`));

  if (totalPages > 1) {
    children.push(actionRow(
      button('shotcallers_page:0', '« First', ButtonStyle.Secondary, { disabled: page === 0 }),
      button(`shotcallers_page:${page - 1}`, '← Prev', ButtonStyle.Secondary, { disabled: page === 0 }),
      button(`shotcallers_page:${page + 1}`, 'Next →', ButtonStyle.Secondary, { disabled: page >= totalPages - 1 }),
      button(`shotcallers_page:${totalPages - 1}`, 'Last »', ButtonStyle.Secondary, { disabled: page >= totalPages - 1 }),
    ));
  }

  const tagButtons = [];
  if (afkCount > 0) tagButtons.push(button('shotcallers_tag_afk', `🔔 Tag ${afkCount} AFK`, ButtonStyle.Danger));
  if (neverBountyCount > 0) tagButtons.push(button('shotcallers_tag_nobounty', `🎯 Tag ${neverBountyCount} no-bounty`, ButtonStyle.Danger));
  if (tagButtons.length) children.push(actionRow(...tagButtons));

  return { components: [container(Colors.Stats, children)], flags: 1 << 15 };
}

// ── User self-cancel (deadline > 30 days away) ───────────────

export function buildCancelPicker(predictions, minDays) {
  const options = predictions.slice(0, 25).map(p => ({
    label: `#${String(p.id).padStart(4, '0')} — ${p.title.slice(0, 80)}`,
    description: `Deadline: ${p.deadline}`,
    value: String(p.id),
  }));
  return {
    components: [
      container(Colors.Pending, [
        text('**🗑 Cancel a Prediction**'),
        text(`Only open predictions with a deadline more than ${minDays} days away can be cancelled. Cancelling permanently removes the prediction and its public post.`),
        {
          type: CT.ActionRow,
          components: [{
            type: CT.StringSelect,
            custom_id: 'cancel_pred_select',
            placeholder: 'Select a prediction to cancel',
            min_values: 1,
            max_values: 1,
            options,
          }],
        },
      ]),
    ],
    flags: (1 << 15) | (1 << 6),
  };
}

export function buildUserCancelConfirm(prediction) {
  const id = String(prediction.id).padStart(4, '0');
  return {
    components: [
      container(Colors.Fail, [
        text(`**⚠️ Cancel #${id} — ${prediction.title}?**`),
        text(`Deadline: ${prediction.deadline}\nThis permanently removes the prediction and deletes its public post. This cannot be undone.`),
        actionRow(
          button(`user_cancel_confirm:${prediction.id}`, 'Yes, Cancel It', ButtonStyle.Danger),
          button(`user_cancel_abort:${prediction.id}`, 'Keep It', ButtonStyle.Secondary),
        ),
      ]),
    ],
    flags: (1 << 15) | (1 << 6),
  };
}

// ── Card battle ("highest card wins") ────────────────────────

// The dropped embed with the public Pull button + admin Stop / Results buttons.
// When the battle is stopped the Pull button is disabled and the header flips.
export function buildCardBattleLive(battle, { pulls = 0, remaining = null } = {}) {
  const stopped = battle.status === 'stopped';
  const children = [];
  children.push(text(stopped ? '## 🎴 Highest Card Wins — 🛑 Closed' : '## 🎴 Highest Card Wins'));
  children.push(text(stopped
    ? '-# Pulls are closed. Tap **🏆 Results** to see the top cards.'
    : '**Tap the button to pull one random gold card — highest gold value wins!**\nOne pull per person. Everyone sees what you get.'));

  children.push(separator());
  const meta = [`🎁 **Cards in the pool:** ${battle.pool_size}`, `🎴 **Pulled so far:** ${pulls}`];
  if (remaining != null) meta.push(`📦 **Left:** ${remaining}`);
  children.push(text(meta.join('\n')));

  children.push(separator());
  children.push(actionRow(
    button(`cardbattle_pull:${battle.id}`, '🎴 Pull a Card', ButtonStyle.Success, stopped ? { disabled: true } : {}),
    button(`cardbattle_stop:${battle.id}`, '🛑 Stop', ButtonStyle.Danger, stopped ? { disabled: true } : {}),
    button(`cardbattle_results:${battle.id}`, '🏆 Results', ButtonStyle.Secondary),
  ));

  return { components: [container(Colors.Gold, children)], flags: 1 << 15 };
}

// Public reveal posted when a member pulls a card.
export function buildCardBattlePull({ displayName, card }) {
  const children = [];
  children.push(text(`## 🎴 ${displayName} pulled a card!`));
  children.push(text(`### ${(card.name || 'Gold Card').replace(/[\r\n]+/g, ' ')}`));

  const img = eventImage(card.image);
  if (img) children.push({ type: CT.MediaGallery, items: [{ media: { url: img } }] });

  children.push(separator());
  children.push(text(`🪙 **Gold value:** ${formatGold(card.goldValue)}`));

  return { components: [container(Colors.Gold, children)], flags: 1 << 15 };
}

// Top-3 standings. `tiers` = [{ rank, gold, entries: [{ displayName, cardName }] }],
// pre-ranked with ties sharing a rank (dense rank, top 3 distinct gold values).
export function buildCardBattleResults({ tiers = [], totalPulls = 0 } = {}) {
  const MEDALS = ['🥇', '🥈', '🥉'];
  const children = [];
  children.push(text('## 🏆 Highest Card Wins — Results'));

  if (!tiers.length) {
    children.push(text('-# No one pulled a card this round.'));
    return { components: [container(Colors.Gold, children)], flags: 1 << 15 };
  }

  for (const tier of tiers) {
    children.push(separator());
    const badge = MEDALS[tier.rank - 1] || `#${tier.rank}`;
    const goldStr = formatGold(tier.gold);
    const header = tier.entries.length > 1
      ? `${badge} **${goldStr}** 🪙 — tie (${tier.entries.length})`
      : `${badge} **${goldStr}** 🪙`;
    children.push(text(header));
    for (const e of tier.entries) {
      children.push(text(`• **${e.displayName}** — ${(e.cardName || 'Gold Card').replace(/[\r\n]+/g, ' ')}`));
    }
  }

  children.push(separator());
  children.push(text(`-# ${totalPulls} total pull${totalPulls === 1 ? '' : 's'}.`));
  return { components: [container(Colors.Gold, children)], flags: 1 << 15 };
}

// ── Delete confirmation ──────────────────────────────────────

export function buildDeleteConfirm(predictionId) {
  return {
    components: [
      container(Colors.Fail, [
        text('**⚠️ Confirm Deletion**'),
        text('This will permanently remove this prediction and delete the public prediction post.'),
        actionRow(
          button(`confirm_delete:${predictionId}`, 'Yes, Delete', ButtonStyle.Danger),
          button(`cancel_delete:${predictionId}`, 'Cancel', ButtonStyle.Secondary),
        ),
      ]),
    ],
    flags: (1 << 15) | (1 << 6),
  };
}
