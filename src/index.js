import {
  Client, GatewayIntentBits, Events, Routes, AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  MessageFlags, ComponentType, ButtonStyle,
} from 'discord.js';
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  linkUpshot, getUpshotProfile,
  createPrediction, getPrediction, updatePrediction, deletePrediction,
  countUserDailyPredictions, getUserStats, getLeaderboard, getUserMonthScoredPredictions,
  recordTierAward, getUserTier,
  getLeaderboardMessageId, setLeaderboardMessageId,
  getPanels, addPanel, removePanel,
  getConfig, setConfig, getAllConfig,
  getCategories, addCategory, removeCategory,
  resetUser, resetAllUsers, deleteLastPrediction,
  deleteUserProfile, deleteAllProfiles,
  countUserUnresolved, getUserOpenPredictions, getUserUnresolvedPredictions, hasUnresolvedPredictionForCard,
  getUnresolvedRatedPredictions, getResolvedCount, getUnresolvedCount,
  getProfileByWallet, getProfileByUrl, getAllUsers, getDbPath,
  upsertCommunityVote, getCommunityVoteSummary,
  getPendingVerificationPredictions, getUnratedVerifiedPredictions, getRatedActivePredictions,
  getContestWatchState, setContestWatchState,
  getRaffleWatchState, setRaffleWatchState,
  getStoreWatchState, setStoreWatchState,
} from './database.js';

import { rateWithAI, MODEL as NIM_MODEL } from './nim.js';

import {
  buildPredictionCard, buildAdminCard,
  buildLeaderboard, buildStatsCard, buildDeleteConfirm,
  buildCancelPicker, buildUserCancelConfirm,
  buildPredictionPanel, buildHelpPage,
  buildContestOverview, buildContestLineupPage,
  buildCardPicker, buildCardPickerEmpty, buildCardDetail,
  buildContestLive, buildContestResults, buildContestList,
  buildRaffleLive, buildRaffleWinner, buildRaffleList,
  buildStoreListed, buildStoreList,
  buildAdminPanel, buildAdminPickChannel, buildAdminPickRole, ADMIN_SETTINGS_LIST,
} from './components.js';

import { commands } from './commands.js';
import { registerReferralHandlers, tryHandleReferralInteraction } from './referral.js';

import {
  Status, DefaultCategories, starPoints, totalPoints, weightedStarRating, isRated, renderStars,
} from './constants.js';

import {
  extractWallet, extractCardId,
  getCardDetails, checkCardOwnership, checkCardResolution, isInstantWinCard,
  getSeasonRank, getUserContestLineups, getPredictableCards, getCardStats,
  getUserProfile, getUserPacks, transferPack, refreshUpshotAccessToken,
  getContests, getContestTop, getRaffles, getRaffleDetail, getRaffleTop,
  getStorePacks, getStoreBundles,
} from './api.js';

// ── Client ──────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // referral: GUILD_MEMBER_ADD
    GatewayIntentBits.GuildInvites,   // referral: invite create/delete
  ],
  rest: {
    timeout: 30_000, // 30s REST timeout (default is 15s, too short for Pi with large attachments)
  },
});

registerReferralHandlers(client);

// ── Config resolver (DB first, .env fallback) ───────────────

function cfg(guildId, key, fallbackEnv) {
  return getConfig(guildId, key) ?? process.env[fallbackEnv] ?? null;
}

function getPredictionsChannelId(guildId) {
  return cfg(guildId, 'predictions_channel', 'PREDICTIONS_CHANNEL_ID');
}

// Friendly "this card is already taken" message that links to the blocking
// prediction, so the user can see what's there instead of guessing and
// backtracking. `existing` comes from hasUnresolvedPredictionForCard.
function cardTakenMessage(existing, guildId, userId) {
  const channelId = getPredictionsChannelId(guildId);
  const jump = channelId && existing.embed_message_id
    ? `https://discord.com/channels/${guildId}/${channelId}/${existing.embed_message_id}`
    : null;
  const titlePart = existing.title ? `: **${existing.title}**` : '';
  const linkPart = jump ? ` → [view it](${jump})` : '';
  if (existing.author_id === userId) {
    return `⏳ You already have an open prediction on this card${titlePart}${linkPart}. Wait for it to resolve, or pick another card.`;
  }
  return `⏳ <@${existing.author_id}> already has an open prediction on this card${titlePart}${linkPart}. Pick another card.`;
}

function getAdminChannelId(guildId) {
  return cfg(guildId, 'admin_channel', 'ADMIN_REVIEW_CHANNEL_ID');
}

// Resolve the UPSHOT_TOKEN_FILE path (expanding a leading ~), or null if unset.
function upshotTokenFilePath() {
  const raw = process.env.UPSHOT_TOKEN_FILE;
  if (!raw) return null;
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

// Parse the token cache file (or null on any problem). Shape written by
// writeUpshotTokenFile / scripts/upshot-refresh.mjs.
function readUpshotTokenJson() {
  const file = upshotTokenFilePath();
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Read the access token from the cache file (UPSHOT_TOKEN_FILE), if set and not
// expired. Returns the token string or null.
function readUpshotTokenFile() {
  const json = readUpshotTokenJson();
  if (!json) return null;
  const token = json.accessToken || json.token || json.access_token;
  if (!token) return null;
  const exp = json.expires_at ?? json.expiresAt ?? json.exp;
  if (exp != null) {
    const expMs = typeof exp === 'number'
      ? (exp < 1e12 ? exp * 1000 : exp)   // epoch seconds vs ms
      : Date.parse(exp);                  // ISO string
    if (Number.isFinite(expMs) && expMs <= Date.now() + 30_000) return null; // expired (30s skew)
  }
  return token;
}

// The (rotating) refresh token: cache file → UPSHOT_REFRESH_TOKEN env (seed).
function readUpshotRefreshToken() {
  const json = readUpshotTokenJson();
  return json?.refreshToken || json?.refresh_token || process.env.UPSHOT_REFRESH_TOKEN || null;
}

// Atomically persist a freshly-minted access+refresh token pair (chmod 600).
// Writing to a temp file + rename avoids a torn read if the bot reads mid-write.
function writeUpshotTokenFile({ accessToken, refreshToken }) {
  const file = upshotTokenFilePath();
  if (!file) return false;
  const payload = decodeJwtPayload(accessToken) || {};
  const refreshPayload = decodeJwtPayload(refreshToken) || {};
  const out = {
    token: accessToken,
    accessToken,
    refreshToken,
    wallet: payload.walletAddress ?? null,
    user_id: payload.id ?? null,
    expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    refresh_expires_at: refreshPayload.exp ? new Date(refreshPayload.exp * 1000).toISOString() : null,
    extracted_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return true;
}

// Upshot Bearer token used to send packs. Resolution order: cache file → DB
// (/setup upshot-token) → UPSHOT_JWT env. Sensitive — never log its value.
function getUpshotToken(guildId) {
  return readUpshotTokenFile() || cfg(guildId, 'upshot_token', 'UPSHOT_JWT');
}

// Refresh the Upshot access token, hands-off. Preferred path is a pure-HTTP
// refresh-token exchange (POST /auth/refresh) — no browser, no OAuth — writing
// the rotated pair back to UPSHOT_TOKEN_FILE. Falls back to an external command
// (UPSHOT_TOKEN_REFRESH_CMD, e.g. a browser extractor) when no refresh token is
// available. Concurrent calls are de-duped so the single-use refresh token is
// never spent twice in parallel. Returns true on success.
let _upshotRefreshInFlight = null;
async function refreshUpshotToken() {
  if (_upshotRefreshInFlight) return _upshotRefreshInFlight;
  _upshotRefreshInFlight = (async () => {
    const refreshToken = readUpshotRefreshToken();
    if (refreshToken && upshotTokenFilePath()) {
      const r = await refreshUpshotAccessToken(refreshToken);
      if (r.ok) {
        writeUpshotTokenFile({ accessToken: r.accessToken, refreshToken: r.refreshToken });
        return true;
      }
      console.error('Upshot HTTP token refresh failed:', r.code, r.error);
      // fall through to the command-based extractor if one is configured
    }
    const cmd = process.env.UPSHOT_TOKEN_REFRESH_CMD;
    if (!cmd) return false;
    try {
      await execFileAsync('/bin/sh', ['-c', cmd], { timeout: 120_000 });
      return true;
    } catch (err) {
      console.error('Upshot token refresh command failed:', err.message);
      return false;
    }
  })();
  try {
    return await _upshotRefreshInFlight;
  } finally {
    _upshotRefreshInFlight = null;
  }
}

// Proactively refresh if the cached access token is missing or within
// REFRESH_SKEW of expiry. Cheap no-op when the token is still comfortably valid.
const UPSHOT_REFRESH_SKEW_MS = 60 * 60 * 1000; // refresh once it's <1h from expiry
function upshotTokenExpiresSoon() {
  const json = readUpshotTokenJson();
  const token = json?.accessToken || json?.token || json?.access_token;
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false; // no exp → can't tell; leave it
  return payload.exp * 1000 <= Date.now() + UPSHOT_REFRESH_SKEW_MS;
}
async function maybeRefreshUpshotToken() {
  // Only act when we have a refresh-token path configured and the token is stale.
  if (!upshotTokenFilePath() || !readUpshotRefreshToken()) return;
  if (!upshotTokenExpiresSoon()) return;
  const ok = await refreshUpshotToken();
  console.log(ok ? 'Upshot token: proactively refreshed.' : 'Upshot token: proactive refresh failed.');
}

// Decode a JWT's payload (no signature check — just to read exp/wallet locally).
// Returns the payload object, or null if it doesn't look like a JWT.
function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Accept either a raw Bearer token or the JSON the browser extractor produces
// ({ token, wallet, expires_at, ... }). Returns the token string, or null.
function extractTokenFromInput(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      return json.token || json.accessToken || json.access_token || null;
    } catch {
      return null;
    }
  }
  return trimmed || null;
}

function getLeaderboardChannelId(guildId) {
  return cfg(guildId, 'leaderboard_channel', 'LEADERBOARD_CHANNEL_ID');
}

function getContestsChannelId(guildId) {
  return cfg(guildId, 'contests_channel', 'CONTESTS_CHANNEL_ID');
}

function getLuckyShotsChannelId(guildId) {
  return cfg(guildId, 'luckyshots_channel', 'LUCKYSHOTS_CHANNEL_ID');
}

function getStoreChannelId(guildId) {
  return cfg(guildId, 'store_channel', 'STORE_CHANNEL_ID');
}

function getAdminRoleId(guildId) {
  return cfg(guildId, 'admin_role', 'ADMIN_ROLE_ID');
}

// /sendpack is restricted to a single owner when one is configured (via
// `/setup owner` or the OWNER_ID env). Until an owner is set it falls back to
// the normal admin check, so the command isn't locked out before first setup.
function getOwnerId(guildId) {
  return cfg(guildId, 'owner_id', 'OWNER_ID');
}

function canSendPack(interaction) {
  const ownerId = getOwnerId(interaction.guildId);
  return ownerId ? interaction.user.id === ownerId : isAdmin(interaction.member);
}

function getMaxDaily(guildId) {
  return parseInt(cfg(guildId, 'max_daily', 'MAX_DAILY_PREDICTIONS') || '3', 10);
}

function getMaxOpen(guildId) {
  return parseInt(cfg(guildId, 'max_open', 'MAX_OPEN_PREDICTIONS') || '5', 10);
}

// ── Helpers ──────────────────────────────────────────────────

function getCategoryList(guildId) {
  return getCategories(guildId) || DefaultCategories;
}

function chunkLines(lines, maxLength = 1800) {
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    let remaining = line;
    while (remaining.length > maxLength) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    current = remaining;
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Fuzzy match a user's category input against the known list.
 * Returns the matched category name or null.
 * Tolerates typos by using Levenshtein distance.
 */
function matchCategory(input, categories) {
  const lower = input.toLowerCase().trim();

  // Exact match (case-insensitive)
  const exact = categories.find(c => c.toLowerCase() === lower);
  if (exact) return exact;

  // Starts-with match (e.g. "def" → "DeFi", "gam" → "Gaming")
  const startsWith = categories.find(c => c.toLowerCase().startsWith(lower));
  if (startsWith) return startsWith;

  // Contains match (e.g. "nft" matches "NFTs")
  const contains = categories.find(c => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()));
  if (contains) return contains;

  // Levenshtein distance — allow up to 2 edits for short names, 3 for longer
  let bestMatch = null;
  let bestDist = Infinity;
  for (const cat of categories) {
    const dist = levenshtein(lower, cat.toLowerCase());
    const threshold = cat.length <= 4 ? 2 : 3;
    if (dist <= threshold && dist < bestDist) {
      bestDist = dist;
      bestMatch = cat;
    }
  }

  return bestMatch;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function currentMonthLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Month key (YYYY-MM) for the calendar month before `ref` (default: now).
function previousMonthKey(ref = new Date()) {
  const d = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Central point calculation. Uses weighted star rating (admin 70% + community 30%).
 * Call after any change to stars, outcome, or community votes.
 * Returns the updated prediction.
 */
function recalculatePoints(predictionId) {
  const prediction = getPrediction(predictionId);
  if (!isRated(prediction)) return prediction;

  const effectiveStars = weightedStarRating(prediction.star_rating, prediction.community_star_avg);
  const hasTweet = !!prediction.tweet_url;
  const pts = totalPoints(effectiveStars, prediction.outcome, hasTweet);

  updatePrediction(predictionId, { total_points: pts });
  return getPrediction(predictionId);
}

function isAdmin(member) {
  const roleId = getAdminRoleId(member.guild.id);
  return roleId ? member.roles.cache.has(roleId) : member.permissions.has('Administrator');
}

/**
 * Safely fetch a channel. Returns null if the channel doesn't exist or bot lacks access.
 */
async function safeGetChannel(channelId) {
  try {
    return await client.channels.fetch(channelId);
  } catch (err) {
    console.error(`Cannot access channel ${channelId}:`, err.message);
    return null;
  }
}

/**
 * Safely fetch a message from a channel. Returns null on failure.
 */
async function safeGetMessage(channel, messageId) {
  try {
    return await channel.messages.fetch(messageId);
  } catch {
    return null;
  }
}

// ── Post / Sync embeds ──────────────────────────────────────
//
// Card images are now Arweave URLs (fetched via Upshot API).
// No local image files — MediaGallery uses external URLs directly.

async function postPredictionToFeed(prediction, guildId) {
  const profile = getUpshotProfile(prediction.author_id);
  const channelId = getPredictionsChannelId(guildId);
  if (!channelId) return null;
  const channel = await safeGetChannel(channelId);
  if (!channel) return null;

  const payload = buildPredictionCard(prediction, profile?.upshot_url);

  try {
    const msg = await channel.send(payload);
    updatePrediction(prediction.id, { embed_message_id: msg.id });
    return msg;
  } catch (err) {
    console.error(`Failed to post prediction #${prediction.id} to feed:`, err.message);
    return null;
  }
}

async function postToAdminReview(prediction, guildId) {
  const profile = getUpshotProfile(prediction.author_id);
  const channelId = getAdminChannelId(guildId);
  if (!channelId) return null;
  const channel = await safeGetChannel(channelId);
  if (!channel) return null;

  const payload = buildAdminCard(prediction, profile?.upshot_url);

  try {
    const msg = await channel.send(payload);
    updatePrediction(prediction.id, { admin_message_id: msg.id });
    return msg;
  } catch (err) {
    console.error(`Failed to post prediction #${prediction.id} to admin review:`, err.message);
    return null;
  }
}

async function syncPredictionEmbeds(predictionId, guildId) {
  const prediction = getPrediction(predictionId);
  if (!prediction) return;

  const profile = getUpshotProfile(prediction.author_id);

  // Update public embed
  if (prediction.embed_message_id) {
    const channelId = getPredictionsChannelId(guildId);
    if (channelId) {
      const channel = await safeGetChannel(channelId);
      if (channel) {
        const msg = await safeGetMessage(channel, prediction.embed_message_id);
        if (msg) {
          try {
            const payload = buildPredictionCard(prediction, profile?.upshot_url);
            await msg.edit(payload);
          } catch (err) {
            console.error(`Failed to edit public embed #${predictionId}:`, err.message);
          }
        }
      }
    }
  }

  // Update admin embed
  if (prediction.admin_message_id) {
    const channelId = getAdminChannelId(guildId);
    if (channelId) {
      const channel = await safeGetChannel(channelId);
      if (channel) {
        const msg = await safeGetMessage(channel, prediction.admin_message_id);
        if (msg) {
          try {
            const payload = buildAdminCard(prediction, profile?.upshot_url);
            await msg.edit(payload);
          } catch (err) {
            console.error(`Failed to edit admin embed #${predictionId}:`, err.message);
          }
        } else {
          console.warn(`syncPredictionEmbeds: admin message ${prediction.admin_message_id} for #${predictionId} not found in channel`);
        }
      }
    }
  } else {
    console.warn(`syncPredictionEmbeds: no admin_message_id on #${predictionId} — admin embed was never posted`);
  }
}

async function refreshLeaderboard(guildId) {
  const entries = getLeaderboard(currentMonthKey());
  const payload = buildLeaderboard(entries, currentMonthLabel());
  const channelId = getLeaderboardChannelId(guildId);
  if (!channelId) return null;
  const channel = await safeGetChannel(channelId);
  if (!channel) return null;

  const existingId = getLeaderboardMessageId(guildId);
  if (existingId) {
    const msg = await safeGetMessage(channel, existingId);
    if (msg) {
      try {
        await msg.edit(payload);
        return msg;
      } catch (err) {
        // A leaderboard posted before the embed migration still carries the
        // Components v2 flag, which Discord won't let coexist with `embeds` on
        // edit (MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2). This is a
        // one-time migration, not a real failure — drop the old message and
        // post a fresh embed below.
        console.warn('Recreating leaderboard message (could not edit existing one):', err.message);
        setLeaderboardMessageId(guildId, '');
        try { await msg.delete(); } catch { /* no perms or already gone */ }
      }
    }
  }

  try {
    const msg = await channel.send(payload);
    setLeaderboardMessageId(guildId, msg.id);
    try { await msg.pin(); } catch { /* already pinned or no perms */ }
    return msg;
  } catch (err) {
    console.error('Failed to create leaderboard:', err.message);
    return null;
  }
}

// ── Slash commands ──────────────────────────────────────────

// Temporary storage for guild context between command/button → modal flow
const pendingSubmissions = new Map();
const pendingTimers = new Map();

function setPendingSubmission(userId, data) {
  // Clear old timer if exists
  const oldTimer = pendingTimers.get(userId);
  if (oldTimer) clearTimeout(oldTimer);
  pendingSubmissions.set(userId, data);
  const timer = setTimeout(() => {
    pendingSubmissions.delete(userId);
    pendingTimers.delete(userId);
  }, 5 * 60 * 1000);
  pendingTimers.set(userId, timer);
}

/**
 * Show the prediction modal. Works from both /predict command and panel button.
 * If user hasn't linked their profile yet, show the link-profile modal first.
 */
/**
 * Show the first-time profile-link modal. Used wherever a member tries to act
 * before linking (predict modal, card picker).
 */
async function showLinkProfileModal(interaction) {
  setPendingSubmission(interaction.user.id, {
    guildId: interaction.guildId,
    awaitingLink: true,
  });

  const modal = new ModalBuilder()
    .setCustomId('link_profile_modal')
    .setTitle('Link Your Upshot Profile');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('profile_url')
        .setLabel('Your Upshot profile URL')
        .setPlaceholder('https://upshot.cards/profile/0x89A8f58daF80b0B7...')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(200)
        .setRequired(true)
    ),
  );

  return interaction.showModal(modal);
}

async function showPredictModal(interaction, { presetCardId = null, presetCardName = null } = {}) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile) {
    // Show profile-link modal first — prediction modal follows after submit
    return showLinkProfileModal(interaction);
  }

  const maxDaily = getMaxDaily(interaction.guildId);
  const todayCount = countUserDailyPredictions(interaction.user.id);
  if (todayCount >= maxDaily) {
    return interaction.reply({
      content: `❌ You've reached the daily limit of **${maxDaily}** predictions. Try again tomorrow.`,
      flags: ['Ephemeral'],
    });
  }

  const maxOpen = getMaxOpen(interaction.guildId);
  const openCount = countUserUnresolved(interaction.user.id);
  if (openCount >= maxOpen) {
    return interaction.reply({
      content: `❌ You have **${openCount}** open predictions (max **${maxOpen}**). Wait for some to resolve before submitting more.`,
      flags: ['Ephemeral'],
    });
  }

  // Store guild context for modal submit. When a card was pre-selected from the
  // picker, carry its id (and name, used as the title fallback) so the submit
  // handler skips the URL field entirely.
  setPendingSubmission(interaction.user.id, {
    guildId: interaction.guildId,
    ...(presetCardId ? { cardId: presetCardId, cardName: presetCardName } : {}),
  });

  const modalTitle = presetCardName
    ? `Predict: ${presetCardName}`.slice(0, 45)
    : 'Submit a Prediction';

  const modal = new ModalBuilder()
    .setCustomId('predict_modal')
    .setTitle(modalTitle);

  // Title is auto-derived from the card name — we don't ask the user for it.
  const rows = [
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description')
        .setPlaceholder('Your thesis, data, charts, evidence...')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(2000)
        .setRequired(true)
    ),
  ];

  // Only ask for a card URL when one wasn't already chosen from the picker.
  if (!presetCardId) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('card_url')
          .setLabel('Card URL or ID')
          .setPlaceholder('https://upshot.cards/card-detail/cm... or cm...')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(280)
          .setRequired(true)
      ),
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('tweet_url')
        .setLabel('Tweet URL (optional, +1 bonus on hit)')
        .setPlaceholder('https://x.com/... or https://twitter.com/...')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(280)
        .setRequired(false)
    ),
  );

  modal.addComponents(...rows);

  await interaction.showModal(modal);
}

/**
 * Check if a profile URL or wallet is already linked to another user.
 * Returns the existing profile row if duplicate, null if clear.
 */
function checkDuplicateProfile(url, wallet, currentUserId) {
  // Check by URL
  const byUrl = getProfileByUrl(url);
  if (byUrl && byUrl.discord_id !== currentUserId) return byUrl;

  // Check by wallet
  if (wallet) {
    const byWallet = getProfileByWallet(wallet);
    if (byWallet && byWallet.discord_id !== currentUserId) return byWallet;
  }

  return null;
}

async function handleLinkUpshot(interaction) {
  const url = interaction.options.getString('url', true).trim();

  if (!url.startsWith('https://') || !url.includes('upshot')) {
    return interaction.reply({
      content: '❌ Invalid Upshot profile URL. Expected format: `https://upshot.cards/profile/0x...`',
      flags: ['Ephemeral'],
    });
  }

  const wallet = extractWallet(url);

  // Duplicate check
  const existing = checkDuplicateProfile(url, wallet, interaction.user.id);
  if (existing) {
    notifyAdmin(interaction.guildId,
      `⚠️ **Duplicate profile attempt**\n` +
      `**User:** <@${interaction.user.id}> tried to link\n` +
      `**URL:** ${url}\n` +
      `**Already belongs to:** <@${existing.discord_id}> (linked ${existing.linked_at})`
    ).catch(() => {});

    return interaction.reply({
      content: '❌ This Upshot profile is already linked to another user.',
      flags: ['Ephemeral'],
    });
  }

  linkUpshot(interaction.user.id, url, wallet);

  const walletNote = wallet
    ? `\n🔑 Wallet: \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\` (auto-detected for card ownership checks)`
    : '\n⚠️ Could not detect wallet address — card ownership checks won\'t work. Use a profile URL with your wallet address.';

  await interaction.reply({
    content: `✅ Upshot profile linked!\n🔗 ${url}${walletNote}\n\nYou can now submit predictions with \`/predict\`.`,
    flags: ['Ephemeral'],
  });
}

async function buildMyStatsPayload(userId, page = 0) {
  const monthKey = currentMonthKey();
  const stats = getUserStats(userId, monthKey);
  const scored = getUserMonthScoredPredictions(userId, monthKey);
  const tier = getUserTier(userId);
  // Open predictions whose deadline falls in a future month don't show up in the
  // monthly scoring list — surface them so the open slots reconcile on screen.
  const futureOpen = getUserOpenPredictions(userId).filter(p => p.month_key !== monthKey);

  // Card collection stats come from the linked wallet's balances (paginated, can
  // take a moment for large wallets). No wallet → skip them.
  const profile = getUpshotProfile(userId);
  let cardStats = null;
  if (profile?.wallet_address) {
    cardStats = await getCardStats(profile.wallet_address).catch(() => null);
  }

  return buildStatsCard(stats, userId, currentMonthLabel(), scored, tier, cardStats, futureOpen, page);
}

async function handleMyStats(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const payload = await buildMyStatsPayload(interaction.user.id, 0);
  await interaction.editReply(payload);
}

async function handleMyStatsPage(interaction, page) {
  await interaction.deferUpdate();
  const payload = await buildMyStatsPayload(interaction.user.id, page);
  await interaction.editReply(payload);
}

async function handleUpshotRank(interaction) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile?.wallet_address) {
    return interaction.reply({
      content: '❌ Link your Upshot profile first with `/link-upshot` or tap **📇 My Cards**.',
      flags: ['Ephemeral'],
    });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const rank = await getSeasonRank(profile.wallet_address);
  if (!rank) {
    return interaction.editReply({ content: '❌ Could not fetch your Upshot rank. The API may be down or you may not have any season activity.' });
  }

  const seasonEnd = rank.seasonEnd ? new Date(rank.seasonEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const name = rank.displayName || rank.username || 'Unknown';
  const lines = [
    `**🏆 Upshot Season Rank — ${name}**`,
    '',
    `**Rank:** #${rank.rank.toLocaleString()} of ${rank.totalParticipants.toLocaleString()}`,
    `**Total XP:** ${rank.effectiveXP.toLocaleString()}`,
    '',
    `**Breakdown:**`,
    `- Winning cards: ${rank.winningCardPoints.toLocaleString()} pts`,
    `- Set completion: ${rank.setCompletionPoints.toLocaleString()} pts`,
    `- Other: ${rank.otherRankPoints.toLocaleString()} pts`,
    '',
    `-# Season ends ${seasonEnd}`,
  ];

  await interaction.editReply({ content: lines.join('\n') });
}

async function handlePastLeaderboard(interaction) {
  const monthInput = interaction.options.getString('month', true).trim();
  if (!/^\d{4}-\d{2}$/.test(monthInput)) {
    return interaction.reply({ content: '❌ Invalid format. Use `YYYY-MM` (e.g. `2026-03`).', flags: ['Ephemeral'] });
  }

  const entries = getLeaderboard(monthInput, 10).map(e => ({
    ...e,
    upshot_url: getUpshotProfile(e.author_id)?.upshot_url || null,
  }));
  const [yyyy, mm] = monthInput.split('-');
  const label = new Date(parseInt(yyyy), parseInt(mm) - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const payload = buildLeaderboard(entries, label, { showProfiles: true, exportMonthKey: monthInput });
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function handleLeaderboardGrantRole(interaction, monthKey) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return interaction.reply({ content: '❌ Invalid month.', flags: ['Ephemeral'] });
  }
  const roleId = interaction.values?.[0];
  if (!roleId) {
    return interaction.reply({ content: '❌ No role selected.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    return interaction.editReply({ content: '❌ Role not found.' });
  }
  const me = interaction.guild.members.me;
  if (me && role.position >= me.roles.highest.position) {
    return interaction.editReply({ content: `❌ My highest role is below <@&${roleId}>. Move my role above it.` });
  }

  const top = getLeaderboard(monthKey, 10);
  if (top.length === 0) {
    return interaction.editReply({ content: `❌ No entries for \`${monthKey}\`.` });
  }

  const granted = [];
  const failed = [];
  for (const e of top) {
    try {
      const member = await interaction.guild.members.fetch(e.author_id);
      await member.roles.add(role, `Top 10 of ${monthKey} leaderboard`);
      granted.push(e.author_id);
    } catch (err) {
      failed.push({ id: e.author_id, reason: err.message });
    }
  }

  const lines = [
    `🎖️ Granted <@&${roleId}> to **${granted.length}** of top 10 for \`${monthKey}\``,
    granted.length > 0 ? granted.map((id, i) => `${i + 1}. <@${id}>`).join('\n') : '',
    failed.length > 0 ? `\n**Failed (${failed.length}):**\n${failed.map(f => `• <@${f.id}> — ${f.reason}`).join('\n')}` : '',
  ].filter(Boolean);

  await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
}

async function handleProcessTiers(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }
  const monthKey = (interaction.options.getString('month') || previousMonthKey()).trim();
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return interaction.reply({ content: '❌ Invalid month — use `YYYY-MM` (e.g. `2026-05`).', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const { promoted, failed, skipped } = await processTiers(interaction.guildId, monthKey);
  // Keep the rollover baseline in sync so the auto-run doesn't re-process this
  // month (or anything before it) again.
  const last = getConfig(interaction.guildId, 'tiers_last_processed');
  if (last == null || last < monthKey) setConfig(interaction.guildId, 'tiers_last_processed', monthKey);

  if (promoted.length === 0 && failed.length === 0 && skipped === 0) {
    return interaction.editReply({ content: `No leaderboard entries found for \`${monthKey}\`.` });
  }
  const lines = [
    `🏅 Processed tiers for \`${monthKey}\` — **${promoted.length}** promoted${skipped ? `, ${skipped} already counted` : ''}`,
    promoted.length ? promoted.map(p => `• <@${p.id}> → **${tierRoleName(p.tier)}**`).join('\n') : '',
    failed.length ? `\n**Failed (${failed.length}):**\n${failed.map(f => `• <@${f.id}> — ${f.reason}`).join('\n')}` : '',
  ].filter(Boolean);
  await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
}

async function handleLeaderboardExport(interaction, monthKey) {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return interaction.reply({ content: '❌ Invalid month.', flags: ['Ephemeral'] });
  }
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const entries = getLeaderboard(monthKey, 1000);
  const rows = [['rank', 'discord_id', 'discord_username', 'upshot_url', 'wallet_address', 'total_points', 'predictions', 'hits', 'fails', 'resolved', 'hit_rate_pct']];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const profile = getUpshotProfile(e.author_id);
    let username = '';
    try {
      const u = await client.users.fetch(e.author_id);
      username = u?.username || '';
    } catch { /* ignore */ }
    const hitRate = e.resolved > 0 ? Math.round((e.hits / e.resolved) * 100) : 0;
    rows.push([
      i + 1,
      e.author_id,
      username,
      profile?.upshot_url || '',
      profile?.wallet_address || '',
      e.total_points || 0,
      e.prediction_count || 0,
      e.hits || 0,
      e.fails || 0,
      e.resolved || 0,
      hitRate,
    ]);
  }

  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map(r => r.map(escape).join(',')).join('\n');
  const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `leaderboard-${monthKey}.csv` });
  await interaction.editReply({ content: `📥 Leaderboard export for **${monthKey}** (${entries.length} entries)`, files: [file] });
}

// Cache contest data per user for navigation (cleared after 10 min)
const contestCache = new Map();

async function handleMyContests(interaction) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile?.wallet_address) {
    return interaction.reply({
      content: '❌ Link your Upshot profile first with `/link-upshot` or tap **📇 My Cards**.',
      flags: ['Ephemeral'],
    });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const contests = await getUserContestLineups(profile.wallet_address);
  if (contests.length === 0) {
    return interaction.editReply({ content: 'You\'re not entered in any active contests.' });
  }

  // Cache for navigation. Use scheduleCacheEvict (not a bare setTimeout) so
  // re-running /mycontests doesn't stack timers — an early one would otherwise
  // evict the entry the user just refreshed, mid-navigation.
  contestCache.set(interaction.user.id, contests);
  scheduleCacheEvict(contestCache, 'contests', interaction.user.id);

  const payload = buildContestOverview(contests);
  await interaction.editReply(payload);
}

// ── Send packs (admin) ───────────────────────────────────────
//
// Sends unopened Upshot packs FROM the admin's account (whose Bearer token is
// configured via /setup upshot-token) TO a member who has linked their Upshot
// profile. Two-step: /sendpack validates + shows a confirm button; the actual
// POST /packs/transfer only fires on confirm (it's irreversible).

const pendingPackSends = new Map(); // adminId -> { ...transfer params }

// Short cache so per-keystroke autocomplete doesn't hammer the Upshot API.
const packCache = new Map(); // wallet -> { at, packs }
async function getPacksCached(wallet) {
  const hit = packCache.get(wallet);
  if (hit && Date.now() - hit.at < 30_000) return hit.packs;
  const packs = await getUserPacks(wallet);
  packCache.set(wallet, { at: Date.now(), packs });
  return packs;
}

// Autocomplete for /sendpack's `pack` option — suggests the admin's own
// unopened packs. Must respond within ~3s, so it's best-effort and cached.
async function handleSendPackAutocomplete(interaction) {
  try {
    const sender = getUpshotProfile(interaction.user.id);
    if (!sender?.wallet_address) return await interaction.respond([]);
    const focused = (interaction.options.getFocused() || '').toLowerCase();
    const packs = await getPacksCached(sender.wallet_address);
    const choices = packs
      .filter(p => !focused || p.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(p => ({ name: `${p.name} (×${p.quantity})`.slice(0, 100), value: p.packId.slice(0, 100) }));
    return await interaction.respond(choices);
  } catch {
    try { return await interaction.respond([]); } catch { /* interaction expired */ }
  }
}

async function handleSendPack(interaction) {
  if (!canSendPack(interaction)) {
    return interaction.reply({ content: '❌ Only the configured pack owner can use this command.', flags: ['Ephemeral'] });
  }

  const usersRaw = interaction.options.getString('users', true);
  const packQuery = interaction.options.getString('pack', true).trim();
  const quantity = interaction.options.getInteger('quantity', true);

  // Parse one or more mentions (e.g. "@alice @bob") into a deduped list of ids.
  const recipientDiscordIds = [...new Set([...usersRaw.matchAll(/<@!?(\d+)>/g)].map(m => m[1]))];

  await interaction.deferReply({ flags: ['Ephemeral'] });

  if (recipientDiscordIds.length === 0) {
    return interaction.editReply({ content: '❌ Mention at least one member to send to (e.g. `@alice @bob`).' });
  }

  let token = getUpshotToken(interaction.guildId);
  if (!token) {
    // The cached access token may simply be expired — try a hands-off refresh
    // (rotating refresh token, no browser) before giving up.
    if (await refreshUpshotToken()) token = getUpshotToken(interaction.guildId);
  }
  if (!token) {
    return interaction.editReply({ content: '❌ No Upshot token set. Run `/setup upshot-token` first (your Bearer accessToken), or re-link the session if the refresh token expired.' });
  }

  // Sender = the admin's own linked account (the token should belong to it).
  const sender = getUpshotProfile(interaction.user.id);
  if (!sender?.wallet_address) {
    return interaction.editReply({ content: '❌ Link your own Upshot profile first (so I can read your packs) — use `/link-upshot`.' });
  }

  // Validate the pack against the sender's unopened inventory.
  const packs = await getUserPacks(sender.wallet_address);
  if (packs.length === 0) {
    return interaction.editReply({ content: 'You have no unopened packs to send (or the Upshot API is unreachable).' });
  }
  const match = packs.find(p => p.name.toLowerCase() === packQuery.toLowerCase())
    || packs.find(p => p.packId === packQuery);
  if (!match) {
    const list = packs.map(p => `• ${p.name} ×${p.quantity}`).join('\n');
    return interaction.editReply({ content: `❌ You don't have a pack named **${packQuery}**. Your packs:\n${list}` });
  }

  // Resolve each recipient: they must have a linked profile and a usable Upshot id.
  const recipients = [];
  const skipped = [];
  await Promise.all(recipientDiscordIds.map(async (id) => {
    const profile = getUpshotProfile(id);
    if (!profile?.wallet_address) {
      skipped.push(`<@${id}> — no linked Upshot profile`);
      return;
    }
    const upshot = await getUserProfile(profile.wallet_address);
    if (!upshot?.id) {
      skipped.push(`<@${id}> — couldn't resolve their Upshot account (they may need to log into Upshot once)`);
      return;
    }
    recipients.push({ recipientId: upshot.id, recipientDiscordId: id, recipientWallet: profile.wallet_address });
  }));

  if (recipients.length === 0) {
    return interaction.editReply({ content: `❌ No valid recipients:\n${skipped.map(s => `• ${s}`).join('\n')}` });
  }

  const totalNeeded = quantity * recipients.length;
  if (totalNeeded > match.quantity) {
    return interaction.editReply({
      content: `❌ You only have **${match.quantity}× ${match.name}** — can't send ${quantity} to each of ${recipients.length} recipient(s) (need ${totalNeeded}).`,
    });
  }

  pendingPackSends.set(interaction.user.id, {
    recipients,
    packId: match.packId,
    packName: match.name,
    quantity,
    guildId: interaction.guildId,
  });
  setTimeout(() => pendingPackSends.delete(interaction.user.id), 5 * 60 * 1000);

  const recipientLines = recipients
    .map(r => `• <@${r.recipientDiscordId}> (\`${r.recipientWallet.slice(0, 6)}…${r.recipientWallet.slice(-4)}\`)`)
    .join('\n');
  const skipNote = skipped.length ? `\n\n⚠️ Skipping:\n${skipped.map(s => `• ${s}`).join('\n')}` : '';

  return interaction.editReply({
    content: `⚠️ **Confirm pack transfer** — this is irreversible.\n\n`
      + `Send **${quantity}× ${match.name}** to each of ${recipients.length} recipient(s) (${totalNeeded} total):\n${recipientLines}${skipNote}`,
    components: [{
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, custom_id: 'confirm_sendpack', label: '✅ Send', style: ButtonStyle.Success },
        { type: ComponentType.Button, custom_id: 'cancel_sendpack', label: 'Cancel', style: ButtonStyle.Secondary },
      ],
    }],
  });
}

async function handleConfirmSendPack(interaction) {
  if (!canSendPack(interaction)) {
    return interaction.reply({ content: '❌ Only the configured pack owner can use this command.', flags: ['Ephemeral'] });
  }
  const pending = pendingPackSends.get(interaction.user.id);
  if (!pending) {
    return interaction.update({ content: '⌛ This confirmation expired. Run `/sendpack` again.', components: [] });
  }
  pendingPackSends.delete(interaction.user.id);

  await interaction.update({
    content: `⏳ Sending **${pending.quantity}× ${pending.packName}** to ${pending.recipients.length} recipient(s)…`,
    components: [],
  });

  // Send to each recipient in turn. One failure doesn't abort the rest.
  const sent = [];
  const failed = [];
  let refreshed = false;
  for (const r of pending.recipients) {
    const params = { recipientId: r.recipientId, packId: pending.packId, quantity: pending.quantity };
    let result = await transferPack(params, getUpshotToken(pending.guildId));

    // On an auth failure, try a one-shot token refresh (if configured) and retry — once per run.
    if ((result.code === 401 || result.code === 403) && !refreshed && await refreshUpshotToken()) {
      refreshed = true;
      const fresh = getUpshotToken(pending.guildId);
      if (fresh) result = await transferPack(params, fresh);
    }

    if (result.ok) {
      sent.push(r);
    } else {
      const reason = result.code === 401 || result.code === 403
        ? 'token expired/rejected'
        : result.code === 'shield'
          ? 'blocked by anti-bot shield'
          : (result.error || 'unknown error');
      failed.push({ ...r, reason });
    }
  }

  const lines = [];
  if (sent.length) {
    lines.push(`✅ Sent **${pending.quantity}× ${pending.packName}** to ${sent.length} recipient(s):`);
    lines.push(...sent.map(r => `• <@${r.recipientDiscordId}>`));
  }
  if (failed.length) {
    lines.push(`❌ Failed for ${failed.length} recipient(s):`);
    lines.push(...failed.map(r => `• <@${r.recipientDiscordId}> — ${r.reason}`));
  }
  await interaction.editReply({ content: lines.join('\n') });

  if (sent.length) {
    // Public announcement in the channel where /sendpack was used.
    const packLabel = pending.quantity > 1 ? `**${pending.quantity}× ${pending.packName}** packs` : `a **${pending.packName}** pack`;
    const mentions = sent.map(r => `<@${r.recipientDiscordId}>`).join(', ');
    await interaction.channel?.send({
      content: `🎁 <@${interaction.user.id}> sent ${packLabel} to ${mentions}! 🎉`,
    }).catch(e => console.error('Pack announce failed:', e.message));

    notifyAdmin(pending.guildId,
      `📦 **Pack sent** — <@${interaction.user.id}> sent **${pending.quantity}× ${pending.packName}** to `
      + sent.map(r => `<@${r.recipientDiscordId}> (\`${r.recipientWallet}\`)`).join(', ') + '.'
    ).catch(() => {});
  }
}

async function handleCancelSendPack(interaction) {
  pendingPackSends.delete(interaction.user.id);
  return interaction.update({ content: 'Cancelled — no packs were sent.', components: [] });
}

// ── Card picker (pick a card to predict — no URL needed) ─────

// Per-user cache of the full predictable-card list so the pagination buttons can
// page through every card without re-hitting the Upshot API on each click.
// Shape: userId -> { cards: [{id,name,inContest}], page: number }
const cardPickerCache = new Map();
// Per-user cache of the card currently being viewed in detail, so the Back /
// Predict buttons know which card (and which picker page to return to).
// Shape: userId -> { cardId, cardName, page }
const cardViewCache = new Map();

// Schedule a per-user cache eviction, clearing any prior timer first. Without
// this, re-opening My Cards stacks bare setTimeouts: the earliest one fires ~10
// min after the FIRST open and deletes the entry the user just refreshed,
// dropping them into the "cache expired" fallback mid-flow (and leaking timer
// handles). Keyed by `${cache tag}:${userId}` so the two caches don't collide.
const cacheEvictTimers = new Map();
function scheduleCacheEvict(cache, tag, userId, ms = 10 * 60 * 1000) {
  const key = `${tag}:${userId}`;
  const prev = cacheEvictTimers.get(key);
  if (prev) clearTimeout(prev);
  const handle = setTimeout(() => {
    cache.delete(userId);
    cacheEvictTimers.delete(key);
  }, ms);
  if (handle.unref) handle.unref();
  cacheEvictTimers.set(key, handle);
}

// The cards currently shown in the picker = the full available list filtered by
// the active search query (case-insensitive name match), or all of them.
function pickerView(cached) {
  if (!cached?.cards) return [];
  const q = cached.query?.trim().toLowerCase();
  return q ? cached.cards.filter(c => (c.name || '').toLowerCase().includes(q)) : cached.cards;
}

async function handleCardPicker(interaction) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile?.wallet_address) {
    // Not linked (or no wallet detected) — link first, then re-tap My Cards.
    return showLinkProfileModal(interaction);
  }

  // Browsing is always allowed — members can look up their cards and copy
  // marketplace links even after hitting their daily/open limits. The
  // daily/open caps are enforced when they actually press Predict
  // (see showPredictModal), so the limit message lands on the action, not here.

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const cards = await getPredictableCards(profile.wallet_address);
  // Hide cards that already have an open prediction (one per card, globally) —
  // this is the "no backtracking" win: you only see cards you can actually post.
  const available = cards.filter(c => !hasUnresolvedPredictionForCard(c.id));

  if (available.length === 0) {
    cardPickerCache.delete(interaction.user.id);
    return interaction.editReply(buildCardPickerEmpty());
  }

  cardPickerCache.set(interaction.user.id, { cards: available, page: 0, query: null });
  scheduleCacheEvict(cardPickerCache, 'picker', interaction.user.id);

  return interaction.editReply(buildCardPicker(available, { page: 0 }));
}

// Pagination: jump the My Cards picker to a specific page (no API refetch).
async function handleCardPage(interaction, page) {
  const cached = cardPickerCache.get(interaction.user.id);
  if (!cached?.cards?.length) {
    // Cache expired — rebuild the list from scratch.
    return handleCardPicker(interaction);
  }
  cached.page = page;
  return interaction.update(buildCardPicker(pickerView(cached), { page, query: cached.query }));
}

// 🔍 Search button → modal asking for a card-name query.
async function handleMyCardSearch(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('mycards_search_modal')
    .setTitle('Search Your Cards');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('query')
        .setLabel('Card name')
        .setPlaceholder('e.g. Monaco, World Cup, Leclerc')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true),
    ),
  );
  return interaction.showModal(modal);
}

// Search modal submit → filter the cached card list and re-render the picker.
async function handleMyCardSearchSubmit(interaction) {
  const cached = cardPickerCache.get(interaction.user.id);
  if (!cached?.cards?.length) {
    return handleCardPicker(interaction); // cache expired — rebuild (full list)
  }
  cached.query = interaction.fields.getTextInputValue('query')?.trim() || null;
  cached.page = 0;
  return interaction.update(buildCardPicker(pickerView(cached), { page: 0, query: cached.query }));
}

// ✖ Show all → drop the search filter.
async function handleMyCardSearchClear(interaction) {
  const cached = cardPickerCache.get(interaction.user.id);
  if (!cached?.cards?.length) {
    return handleCardPicker(interaction);
  }
  cached.query = null;
  cached.page = 0;
  return interaction.update(buildCardPicker(cached.cards, { page: 0 }));
}

// My Cards select → show the card detail view (image, marketplace URL, card ID)
// with Back / Predict actions. Predictions are made from this detail view.
async function handleMyCardSelect(interaction) {
  const cardId = interaction.values?.[0];
  if (!cardId) {
    return interaction.reply({ content: '❌ No card selected.', flags: ['Ephemeral'] });
  }

  // Fetching card details can exceed the 3s window — ack first, then edit.
  await interaction.deferUpdate();

  const cached = cardPickerCache.get(interaction.user.id);
  const page = cached?.page ?? 0;
  const pickerLabel = interaction.component?.options?.find(o => o.value === cardId)?.label || null;
  const pickerCard = cached?.cards?.find(c => c.id === cardId) || null;

  // Best-effort enrichment — the detail view still renders if the API is down.
  let details = null;
  try {
    details = await getCardDetails(cardId);
  } catch (err) {
    console.error(`Card detail: getCardDetails failed for ${cardId}:`, err.message);
  }

  let deadline = null;
  if (details?.eventDate) {
    const d = new Date(details.eventDate);
    deadline = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  const card = {
    id: cardId,
    name: details?.name || pickerLabel || cardId,
    arweaveUrl: details?.arweaveUrl || null,
    rarity: details?.rarity || null,
    deadline,
    inContest: pickerCard?.inContest || false,
  };

  // The card may have been claimed by someone else while the picker was open.
  const existing = hasUnresolvedPredictionForCard(cardId);
  const taken = existing
    ? cardTakenMessage(existing, interaction.guildId, interaction.user.id)
    : null;

  cardViewCache.set(interaction.user.id, { cardId, cardName: card.name, page });
  scheduleCacheEvict(cardViewCache, 'view', interaction.user.id);

  return interaction.editReply(buildCardDetail(card, { taken }));
}

// Detail view → Back: return to the picker at the page they came from.
async function handleCardDetailBack(interaction) {
  const cached = cardPickerCache.get(interaction.user.id);
  if (!cached?.cards?.length) {
    // Cache expired — rebuild the list from scratch.
    return handleCardPicker(interaction);
  }
  const view = cardViewCache.get(interaction.user.id);
  const page = view?.page ?? cached.page ?? 0;
  cached.page = page;
  return interaction.update(buildCardPicker(pickerView(cached), { page, query: cached.query }));
}

// Detail view → Predict: open the prediction modal for the viewed card.
async function handleCardDetailPredict(interaction) {
  const cardId = interaction.customId.split(':')[1];
  if (!cardId) {
    return interaction.reply({ content: '❌ No card selected.', flags: ['Ephemeral'] });
  }
  // Re-check — someone may have grabbed this card while the detail was open.
  const existing = hasUnresolvedPredictionForCard(cardId);
  if (existing) {
    return interaction.reply({
      content: cardTakenMessage(existing, interaction.guildId, interaction.user.id),
      flags: ['Ephemeral'],
    });
  }
  const view = cardViewCache.get(interaction.user.id);
  const presetCardName = view?.cardId === cardId ? view.cardName : null;
  return showPredictModal(interaction, { presetCardId: cardId, presetCardName });
}

// ── Manual "Predict by URL" — step 1: ask only for the card URL/ID ──
// Validation happens on submit (handlePredictUrlModalSubmit) BEFORE asking for
// the prediction text, so members don't waste effort on a card that's expired or
// already taken.
async function showPredictUrlModal(interaction) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile) return showLinkProfileModal(interaction);

  const modal = new ModalBuilder()
    .setCustomId('predict_url_modal')
    .setTitle('Predict by Card URL / ID');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('card_url')
        .setLabel('Card URL or ID')
        .setPlaceholder('https://upshot.cards/card-detail/cm... or cm...')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(280)
        .setRequired(true),
    ),
  );
  return interaction.showModal(modal);
}

// Manual "Predict by URL" — step 1 submit: validate the card up front, then show
// it with a "write your prediction" button (the existing card-detail view). If
// it's expired or already predicted, tell them to pick another — no wasted typing.
async function handlePredictUrlModalSubmit(interaction) {
  const raw = interaction.fields.getTextInputValue('card_url')?.trim();
  const isUrl = raw?.startsWith('https://') && raw.includes('upshot');
  const isRawId = /^cm[a-z0-9]{10,}$/i.test(raw || '');
  if (!raw || (!isUrl && !isRawId)) {
    return interaction.reply({
      content: '❌ Invalid card URL or ID. Use the full card URL from upshot.cards or a card ID starting with `cm`.',
      flags: ['Ephemeral'],
    });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  // Fail fast on the daily/open caps before anything else.
  const maxDaily = getMaxDaily(interaction.guildId);
  if (countUserDailyPredictions(interaction.user.id) >= maxDaily) {
    return interaction.editReply({ content: `❌ You've reached the daily limit of **${maxDaily}** predictions. Try again tomorrow.` });
  }
  const maxOpen = getMaxOpen(interaction.guildId);
  if (countUserUnresolved(interaction.user.id) >= maxOpen) {
    return interaction.editReply({ content: `❌ You have the max of **${maxOpen}** open predictions. Wait for some to resolve before submitting more.` });
  }

  const cardId = extractCardId(raw);

  // Already predicted?
  const existing = hasUnresolvedPredictionForCard(cardId);
  if (existing) {
    return interaction.editReply({ content: `${cardTakenMessage(existing, interaction.guildId, interaction.user.id)}\n-# Pick another card.` });
  }

  // Fetch + deadline check (live status, not a cached snapshot).
  const details = await getCardDetails(cardId, { fresh: true });
  if (!details) {
    return interaction.editReply({ content: '❌ Couldn\'t find that card on Upshot. Double-check the URL or ID and try again.' });
  }

  let deadline = null;
  if (details.eventDate) {
    const d = new Date(details.eventDate);
    deadline = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const today = new Date();
  const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
  const expired = details.resolvedAt || (deadline && deadline <= todayStr);
  if (expired) {
    return interaction.editReply({ content: `❌ This card's event deadline has already passed${deadline ? ` (**${deadline}**)` : ''}. You can't predict on it — pick another card.` });
  }

  // All good — show the card with a "Predict" button (reuses the My Cards detail
  // view + its carddetail_predict button → the prediction modal).
  const card = {
    id: cardId,
    name: details.name || cardId,
    arweaveUrl: details.arweaveUrl || null,
    rarity: details.rarity || null,
    deadline,
    inContest: false,
  };
  cardViewCache.set(interaction.user.id, { cardId, cardName: card.name, page: 0 });
  scheduleCacheEvict(cardViewCache, 'view', interaction.user.id);
  return interaction.editReply(buildCardDetail(card, { taken: null }));
}

// Contest-lineup select → straight to the prediction modal (no detail view).
async function handleCardSelect(interaction) {
  const cardId = interaction.values?.[0];
  if (!cardId) {
    return interaction.reply({ content: '❌ No card selected.', flags: ['Ephemeral'] });
  }
  // Re-check — someone may have grabbed this card while the picker was open.
  const existing = hasUnresolvedPredictionForCard(cardId);
  if (existing) {
    return interaction.reply({
      content: cardTakenMessage(existing, interaction.guildId, interaction.user.id),
      flags: ['Ephemeral'],
    });
  }
  const presetCardName = interaction.component?.options?.find(o => o.value === cardId)?.label || null;
  return showPredictModal(interaction, { presetCardId: cardId, presetCardName });
}

async function handleCurrentLeaderboard(interaction) {
  const entries = getLeaderboard(currentMonthKey());
  const payload = buildLeaderboard(entries, currentMonthLabel());
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

// Download a Discord CDN attachment into a buffer so we can re-upload it as a
// real message attachment. Discord's signed CDN URLs from option attachments
// expire — referencing them directly in MediaGallery items breaks the image
// once the signature rotates. Re-uploading via attachment:// keeps it durable.
async function downloadAttachment(att) {
  if (!att?.url) return null;
  if (att.contentType && !att.contentType.startsWith('image/')) return null;
  const res = await fetch(att.url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // Sanitize filename — fall back to extension from contentType.
  let name = (att.name || 'panel').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!/\.[a-zA-Z0-9]+$/.test(name)) {
    const ext = att.contentType?.split('/')[1] || 'png';
    name = `${name}.${ext}`;
  }
  return { buffer: buf, name };
}

async function handlePanel(interaction) {
  const title = interaction.options.getString('title', true);
  const description = interaction.options.getString('description', true);
  const imageAtt = interaction.options.getAttachment('image');

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const files = [];
  let imageUrl = null;
  if (imageAtt) {
    const dl = await downloadAttachment(imageAtt);
    if (dl) {
      files.push(new AttachmentBuilder(dl.buffer, { name: dl.name }));
      imageUrl = `attachment://${dl.name}`;
    }
  }

  const payload = buildPredictionPanel(title, description, imageUrl);
  const sent = await interaction.channel.send({ ...payload, files });
  // Track the panel so layout changes can be re-rendered on restart.
  addPanel(interaction.guildId, interaction.channel.id, sent.id);
  await interaction.editReply({ content: '✅ Panel posted!' });
}

// Parse title / description from an existing panel message so /edit-panel can
// keep fields the admin didn't override. Mirrors buildPredictionPanel layout:
// container -> [text("## title"), separator, text(description), maybe gallery, separator, actionRow].
function parsePanelMessage(message) {
  const container = message.components?.[0];
  const kids = container?.components;
  if (!kids || kids.length < 3) return null;
  const titleNode = kids[0];
  const descNode = kids[2];
  const titleRaw = titleNode?.content ?? '';
  const title = titleRaw.replace(/^##\s*/, '');
  const description = descNode?.content ?? '';
  return { title, description };
}

// Find the panel's current image URL on a fetched message. Prefer a real
// uploaded attachment, but fall back to the MediaGallery item inside the
// container — Components v2 messages don't always surface the file in
// message.attachments, which previously caused refresh to drop the image.
function panelImageUrl(message) {
  const att = message.attachments?.first?.();
  if (att?.url) return att.url;
  const kids = message.components?.[0]?.components ?? [];
  for (const node of kids) {
    const url = node?.items?.[0]?.media?.url;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
  }
  return null;
}

async function handleEditPanel(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const messageId = interaction.options.getString('message_id', true);
  const newTitle = interaction.options.getString('title');
  const newDesc = interaction.options.getString('description');
  const newImageAtt = interaction.options.getAttachment('image');
  const removeImage = interaction.options.getBoolean('remove_image') ?? false;

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const message = await safeGetMessage(interaction.channel, messageId);
  if (!message) {
    return interaction.editReply({ content: '❌ Could not find that message in this channel. Run /edit-panel in the same channel as the panel.' });
  }
  if (message.author?.id !== client.user.id) {
    return interaction.editReply({ content: '❌ That message wasn\'t posted by this bot.' });
  }

  const current = parsePanelMessage(message);
  if (!current) {
    return interaction.editReply({ content: '❌ That message doesn\'t look like a prediction panel.' });
  }

  const title = newTitle ?? current.title;
  const description = newDesc ?? current.description;

  const files = [];
  let imageUrl = null;
  if (removeImage) {
    // leave imageUrl null and files empty
  } else if (newImageAtt) {
    const dl = await downloadAttachment(newImageAtt);
    if (dl) {
      files.push(new AttachmentBuilder(dl.buffer, { name: dl.name }));
      imageUrl = `attachment://${dl.name}`;
    }
  } else {
    // Preserve existing image by re-downloading and re-attaching it. We can't
    // just keep the old URL — Discord rotates signatures, and on edit, files
    // not re-supplied are dropped from the message.
    const existing = message.attachments?.first?.();
    if (existing) {
      const dl = await downloadAttachment(existing);
      if (dl) {
        files.push(new AttachmentBuilder(dl.buffer, { name: dl.name }));
        imageUrl = `attachment://${dl.name}`;
      }
    }
  }

  const payload = buildPredictionPanel(title, description, imageUrl);
  await message.edit({ ...payload, files, attachments: [] });
  // Register (or re-register) this panel so future layout changes propagate.
  addPanel(interaction.guildId, interaction.channel.id, message.id);
  await interaction.editReply({ content: '✅ Panel updated.' });
}

// Re-render every tracked prediction panel so a changed layout (buttons, copy)
// propagates to already-posted panels. Runs on startup; preserves each panel's
// title/description/image by parsing + re-attaching from the live message.
async function refreshPanels(guildId) {
  const panels = getPanels(guildId);
  if (!panels.length) return;
  for (const { channelId, messageId } of panels) {
    const channel = await safeGetChannel(channelId);
    if (!channel) { removePanel(guildId, messageId); continue; }
    const message = await safeGetMessage(channel, messageId);
    if (!message) { removePanel(guildId, messageId); continue; }
    const current = parsePanelMessage(message);
    if (!current) continue;

    const files = [];
    let imageUrl = null;
    const srcUrl = panelImageUrl(message);
    if (srcUrl) {
      const dl = await downloadAttachment({ url: srcUrl, name: 'panel' });
      if (dl) {
        files.push(new AttachmentBuilder(dl.buffer, { name: dl.name }));
        imageUrl = `attachment://${dl.name}`;
      } else {
        // The panel has an image but we couldn't re-fetch it — skip this panel
        // rather than editing it and stripping the image. We'll retry next boot.
        console.warn(`Panel ${messageId}: image could not be re-fetched; skipping refresh to preserve it.`);
        continue;
      }
    }

    try {
      const payload = buildPredictionPanel(current.title, current.description, imageUrl);
      await message.edit({ ...payload, files, attachments: [] });
    } catch (err) {
      console.error(`Failed to refresh panel ${messageId}:`, err.message);
    }
  }
}

async function handleLeaderboardCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });
  await refreshLeaderboard(interaction.guildId);
  await interaction.editReply({ content: '✅ Leaderboard refreshed.' });
}

async function handleResolveCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const id = interaction.options.getInteger('id');
  const outcome = interaction.options.getString('outcome');
  const prediction = getPrediction(id);

  if (!prediction) {
    return interaction.reply({ content: `❌ Prediction #${id} not found.`, flags: ['Ephemeral'] });
  }
  if (!isRated(prediction)) {
    return interaction.reply({ content: '❌ Assign stars first.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const previousOutcome = prediction.outcome;
  const status = outcome === 'hit' ? Status.Hit : Status.Fail;

  updatePrediction(id, { outcome, status, resolved_by: interaction.user.id });
  const updated = recalculatePoints(id);

  await syncPredictionEmbeds(id, interaction.guildId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});

  const emoji = outcome === 'hit' ? '🟢' : '🔴';
  const override = previousOutcome ? ` (was **${previousOutcome}**)` : '';
  await interaction.editReply({
    content: `${emoji} **#${String(id).padStart(4, '0')}** resolved as **${outcome}**${override} — ${updated.total_points} pts total`,
  });
}

async function handleRefreshCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  // Acknowledge immediately. Refreshing embeds hits the Discord API and the
  // "all" sweep can run for a while; deferring first keeps us inside the 3s
  // interaction window. If the token already expired (bot was momentarily
  // busy / reconnecting), bail quietly instead of throwing 10062.
  try {
    await interaction.deferReply({ flags: ['Ephemeral'] });
  } catch (err) {
    console.warn('refresh: could not defer (interaction expired):', err.message);
    return;
  }

  const id = interaction.options.getInteger('id');
  const all = interaction.options.getBoolean('all');

  if (all) {
    const predictions = getUnresolvedRatedPredictions();
    if (predictions.length === 0) {
      return interaction.editReply({ content: '❌ No unresolved rated predictions to refresh.' });
    }
    let ok = 0;
    let fail = 0;
    for (const p of predictions) {
      try {
        await syncPredictionEmbeds(p.id, interaction.guildId);
        ok++;
      } catch (err) {
        fail++;
        console.warn(`refresh all: #${p.id} failed — ${err.message}`);
      }
    }
    return interaction.editReply({ content: `✅ Refreshed **${ok}** prediction(s)${fail ? ` — ${fail} failed (see logs)` : ''}.` });
  }

  if (id == null) {
    return interaction.editReply({ content: '❌ Provide an `id` or set `all:true`.' });
  }

  const prediction = getPrediction(id);
  if (!prediction) {
    return interaction.editReply({ content: `❌ Prediction #${id} not found.` });
  }

  await syncPredictionEmbeds(id, interaction.guildId);
  await interaction.editReply({ content: `✅ Refreshed embeds for prediction **#${String(id).padStart(4, '0')}**.` });
}

async function handleSetup(interaction) {
  // Requires Administrator permission (enforced by Discord via defaultMemberPermissions)
  if (!interaction.memberPermissions.has('Administrator')) {
    return interaction.reply({ content: '❌ Server admins only.', flags: ['Ephemeral'] });
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  switch (sub) {
    case 'predictions-channel': {
      const channel = interaction.options.getChannel('channel', true);
      setConfig(guildId, 'predictions_channel', channel.id);
      return interaction.reply({ content: `✅ Predictions channel set to <#${channel.id}>`, flags: ['Ephemeral'] });
    }
    case 'admin-channel': {
      const channel = interaction.options.getChannel('channel', true);
      setConfig(guildId, 'admin_channel', channel.id);
      return interaction.reply({ content: `✅ Admin review channel set to <#${channel.id}>`, flags: ['Ephemeral'] });
    }
    case 'leaderboard-channel': {
      const channel = interaction.options.getChannel('channel', true);
      setConfig(guildId, 'leaderboard_channel', channel.id);
      return interaction.reply({ content: `✅ Leaderboard channel set to <#${channel.id}>`, flags: ['Ephemeral'] });
    }
    case 'contests-channel': {
      const channel = interaction.options.getChannel('channel', true);
      setConfig(guildId, 'contests_channel', channel.id);
      return interaction.reply({ content: `✅ Contests channel set to <#${channel.id}>. New contests and their top-3 results will be announced there (first sync seeds silently — no backlog spam).`, flags: ['Ephemeral'] });
    }
    case 'luckyshots-channel': {
      const channel = interaction.options.getChannel('channel', true);
      setConfig(guildId, 'luckyshots_channel', channel.id);
      return interaction.reply({ content: `✅ Lucky Shots channel set to <#${channel.id}>. New live raffles and winners will be announced there (first sync seeds silently).`, flags: ['Ephemeral'] });
    }
    case 'store-channel': {
      const channel = interaction.options.getChannel('channel', true);
      setConfig(guildId, 'store_channel', channel.id);
      return interaction.reply({ content: `✅ Store channel set to <#${channel.id}>. New packs and bundles will be announced there (first sync seeds silently).`, flags: ['Ephemeral'] });
    }
    case 'admin-role': {
      const role = interaction.options.getRole('role', true);
      setConfig(guildId, 'admin_role', role.id);
      return interaction.reply({ content: `✅ Admin role set to <@&${role.id}>`, flags: ['Ephemeral'] });
    }
    case 'upshot-token': {
      // Accept the raw token OR the whole upshot-token.json the extractor dumps.
      const token = extractTokenFromInput(interaction.options.getString('token', true));
      if (!token) {
        return interaction.reply({ content: '❌ Couldn\'t find a token in that input. Paste either the raw token or the full `upshot-token.json` contents.', flags: ['Ephemeral'] });
      }

      // Decode the JWT locally to surface wallet + expiry (and reject dead tokens).
      const payload = decodeJwtPayload(token);
      if (payload?.exp && payload.exp * 1000 <= Date.now()) {
        const ago = Math.round((Date.now() - payload.exp * 1000) / 60000);
        return interaction.reply({ content: `❌ That token already expired ${ago} min ago — grab a fresh one and paste it again.`, flags: ['Ephemeral'] });
      }

      setConfig(guildId, 'upshot_token', token);

      // Never echo the token back — only the non-sensitive metadata from it.
      const wallet = payload?.walletAddress ? `\nWallet: \`${payload.walletAddress.slice(0, 6)}…${payload.walletAddress.slice(-4)}\`` : '';
      const expiry = payload?.exp ? `\nExpires: <t:${payload.exp}:R>` : '';
      return interaction.reply({ content: `✅ Upshot token saved. \`/sendpack\` can now send packs from your account.${wallet}${expiry}\n-# Tokens expire fast — re-run this with a fresh extract when sends start failing with an auth error.`, flags: ['Ephemeral'] });
    }
    case 'owner': {
      // Lock /sendpack to a single person. Once set, only the current owner (or
      // an OWNER_ID env) can reassign it — stops another admin from hijacking.
      const current = getOwnerId(guildId);
      if (current && current !== interaction.user.id) {
        return interaction.reply({ content: `❌ The pack owner is already set to <@${current}>. Only they can reassign it.`, flags: ['Ephemeral'] });
      }
      setConfig(guildId, 'owner_id', interaction.user.id);
      return interaction.reply({ content: `✅ You (<@${interaction.user.id}>) are now the pack owner. Only you can run \`/sendpack\` from here on.`, flags: ['Ephemeral'] });
    }
    case 'max-daily': {
      const limit = interaction.options.getInteger('limit', true);
      setConfig(guildId, 'max_daily', limit);
      return interaction.reply({ content: `✅ Max daily predictions set to **${limit}**`, flags: ['Ephemeral'] });
    }
    case 'max-open': {
      const limit = interaction.options.getInteger('limit', true);
      setConfig(guildId, 'max_open', limit);
      return interaction.reply({ content: `✅ Max open predictions set to **${limit}**`, flags: ['Ephemeral'] });
    }
    case 'add-category': {
      const name = interaction.options.getString('name', true).trim();
      const updated = addCategory(guildId, name);
      return interaction.reply({ content: `✅ Category **${name}** added.\nCurrent: ${updated.join(', ')}`, flags: ['Ephemeral'] });
    }
    case 'remove-category': {
      const name = interaction.options.getString('name', true).trim();
      const updated = removeCategory(guildId, name);
      return interaction.reply({ content: `✅ Category **${name}** removed.\nCurrent: ${updated.length > 0 ? updated.join(', ') : '*(empty — defaults will be used)*'}`, flags: ['Ephemeral'] });
    }
    case 'reset-user': {
      const user = interaction.options.getUser('user', true);
      const monthKey = currentMonthKey();
      const result = resetUser(user.id, monthKey);
      await refreshLeaderboard(guildId).catch(() => {});
      return interaction.reply({
        content: `✅ Reset <@${user.id}> — deleted **${result.changes}** prediction(s) for ${currentMonthLabel()}.`,
        flags: ['Ephemeral'],
      });
    }
    case 'reset-all': {
      const monthKey = currentMonthKey();
      const result = resetAllUsers(monthKey);
      await refreshLeaderboard(guildId).catch(() => {});
      return interaction.reply({
        content: `✅ Reset ALL users — deleted **${result.changes}** prediction(s) for ${currentMonthLabel()}.`,
        flags: ['Ephemeral'],
      });
    }
    case 'undo-last': {
      const user = interaction.options.getUser('user', true);
      const result = deleteLastPrediction(user.id);
      if (result.changes === 0) {
        return interaction.reply({ content: `❌ <@${user.id}> has no predictions to undo.`, flags: ['Ephemeral'] });
      }
      await refreshLeaderboard(guildId).catch(() => {});
      return interaction.reply({
        content: `✅ Deleted last prediction **#${String(result.id).padStart(4, '0')}** from <@${user.id}>.`,
        flags: ['Ephemeral'],
      });
    }
    case 'delete-profile': {
      const user = interaction.options.getUser('user', true);
      const result = deleteUserProfile(user.id);
      return interaction.reply({
        content: result.changes > 0
          ? `✅ Deleted <@${user.id}>'s linked Upshot profile.`
          : `❌ <@${user.id}> has no linked profile.`,
        flags: ['Ephemeral'],
      });
    }
    case 'delete-all-profiles': {
      const result = deleteAllProfiles();
      return interaction.reply({
        content: `✅ Deleted **${result.changes}** linked profile(s).`,
        flags: ['Ephemeral'],
      });
    }
    case 'export-db': {
      await interaction.deferReply({ flags: ['Ephemeral'] });
      const dbFile = new AttachmentBuilder(getDbPath(), { name: 'predictions.db' });
      return interaction.editReply({ content: '📦 Database export:', files: [dbFile] });
    }
    case 'auto-verify-all': {
      return handleAutoVerifyAll(interaction, guildId);
    }
    case 'auto-rate-all': {
      return handleAutoRateAll(interaction, guildId);
    }
    case 'recheck-all-ratings': {
      return handleRecheckAllRatings(interaction, guildId);
    }
    case 'check-all-resolutions': {
      return handleCheckAllResolutions(interaction);
    }
    case 'user-info': {
      const user = interaction.options.getUser('user', true);
      const profile = getUpshotProfile(user.id);
      const monthKey = currentMonthKey();
      const stats = getUserStats(user.id, monthKey);
      const scored = getUserMonthScoredPredictions(user.id, monthKey);
      const hitRate = stats.resolved > 0 ? Math.round((stats.hits / stats.resolved) * 100) : 0;
      const maxOpen = getMaxOpen(guildId);
      const openPredictions = getUserOpenPredictions(user.id);
      const summaryLines = [
        `**User Info — <@${user.id}>**`,
        '',
        `**Upshot URL:** ${profile?.upshot_url || 'Not linked'}`,
        `**Wallet:** \`${profile?.wallet_address || 'not detected'}\``,
        `**Linked:** ${profile?.linked_at || 'Not linked'}`,
        '',
        `**--- ${currentMonthLabel()} Stats ---**`,
        `**Predictions:** ${stats.prediction_count || 0}`,
        `**Points:** ${stats.total_points || 0}`,
        `**Hit Rate:** ${hitRate}% (${stats.hits || 0}/${stats.resolved || 0})`,
        `**Rank:** ${stats.rank ? `#${stats.rank} of ${stats.total_entries}` : 'Unranked'}`,
        `**Avg Rating:** ${stats.avg_rating ? stats.avg_rating.toFixed(1) : '—'} ⭐`,
        '',
        `**Open Predictions:** ${openPredictions.length}/${maxOpen}`,
      ];

      const openLines = openPredictions.length > 0
        ? openPredictions.map(prediction => {
          const shortTitle = prediction.title.length > 80
            ? `${prediction.title.slice(0, 77)}...`
            : prediction.title;
          return `• #${String(prediction.id).padStart(4, '0')} [${prediction.status}] ${prediction.deadline} - ${shortTitle}`;
        })
        : ['• None'];

      const scoredLines = scored.length > 0
        ? scored.map(p => {
          const id = String(p.id).padStart(4, '0');
          const stars = renderStars(p.star_rating);
          const outcomeIcon = p.outcome === 'hit' ? '🟢' : p.outcome === 'fail' ? '🔴' : '⏳';
          const shortTitle = p.title.length > 70 ? `${p.title.slice(0, 67)}...` : p.title;
          return `${outcomeIcon} #${id} **${p.total_points}**pts ${stars} — ${shortTitle}`;
        })
        : ['• None'];

      // Open predictions whose deadline falls in a future month don't appear in
      // the monthly scoring list, but still occupy an open slot — list them so
      // the open counter always reconciles with what's on screen.
      const futureOpen = openPredictions.filter(p => p.month_key !== monthKey);
      const futureOpenLines = futureOpen.length > 0
        ? [
          '',
          `**Open in Future Months (${futureOpen.length})**`,
          ...futureOpen.map(p => {
            const id = String(p.id).padStart(4, '0');
            const stars = renderStars(p.star_rating);
            const shortTitle = p.title.length > 70 ? `${p.title.slice(0, 67)}...` : p.title;
            return `⏳ #${id} ${stars} — ${shortTitle} (due ${p.deadline})`;
          }),
        ]
        : [];

      const messageChunks = chunkLines([
        ...summaryLines,
        '',
        `**Scoring Predictions This Month (${scored.length})**`,
        ...scoredLines,
        ...futureOpenLines,
        '',
        '**Open Prediction List**',
        ...openLines,
      ]);

      await interaction.reply({ content: messageChunks[0], flags: ['Ephemeral'] });
      for (const chunk of messageChunks.slice(1)) {
        await interaction.followUp({ content: chunk, flags: ['Ephemeral'] });
      }
      return;
    }
    case 'view': {
      const cfg = getAllConfig(guildId);
      const cats = getCategoryList(guildId);
      const unresolvedCount = getUnresolvedCount();
      const resolvedCount = getResolvedCount();
      const nextCheck = nextResolveCheck
        ? `<t:${Math.floor(nextResolveCheck.getTime() / 1000)}:R>`
        : '`not scheduled`';
      const lines = [
        '**Current Configuration**',
        '',
        `**Predictions channel:** ${cfg.predictions_channel ? `<#${cfg.predictions_channel}>` : '`not set (using .env)`'}`,
        `**Admin review channel:** ${cfg.admin_channel ? `<#${cfg.admin_channel}>` : '`not set (using .env)`'}`,
        `**Leaderboard channel:** ${cfg.leaderboard_channel ? `<#${cfg.leaderboard_channel}>` : '`not set (using .env)`'}`,
        `**Admin role:** ${cfg.admin_role ? `<@&${cfg.admin_role}>` : '`not set (using .env)`'}`,
        `**Max daily predictions:** ${cfg.max_daily || '`not set (default: 3)`'}`,
        `**Max open predictions:** ${cfg.max_open || '`not set (default: 5)`'}`,
        `**Categories:** ${cats.join(', ')}`,
        '',
        '**Auto-resolve**',
        `**Next check:** ${nextCheck}`,
        `**Unresolved (rated):** ${unresolvedCount}`,
        `**Total resolved:** ${resolvedCount}`,
      ];
      return interaction.reply({ content: lines.join('\n'), flags: ['Ephemeral'] });
    }
  }
}

// ── Bulk admin actions ──────────────────────────────────────

/**
 * In-memory store for AI rating batches pending admin approval.
 * Keyed by batchId, cleared on Accept/Cancel or bot restart.
 */
const pendingRatingBatches = new Map();

/**
 * Auto-pipeline triggered when a submission passes the Upshot API ownership pre-check.
 * Runs verification immediately, then (best-effort, non-blocking) asks the AI for a
 * star rating. Admins can always override the AI rating by clicking Assign Stars.
 */
async function autoVerifyAndRate(predictionId, guildId) {
  try {
    await applyVerification(predictionId, 'auto-api', guildId);
  } catch (err) {
    console.error(`auto-verify failed for #${predictionId}:`, err.message);
    return;
  }

  if (!process.env.NVIDIA_NIM_API_KEY) return;

  try {
    const p = getPrediction(predictionId);
    if (!p || isRated(p)) return;
    const ctx = await gatherRatingContext(p);
    const result = await rateWithAI(ctx);
    await applyStarRating(predictionId, result.stars, 'auto-ai', guildId);
  } catch (err) {
    console.error(`auto-rate failed for #${predictionId}:`, err.message);
  }
}

function formatId(id) {
  return `#${String(id).padStart(4, '0')}`;
}

async function handleAutoVerifyAll(interaction, guildId) {
  const preds = getPendingVerificationPredictions();
  if (preds.length === 0) {
    return interaction.reply({ content: '✅ No predictions pending verification.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  let verified = 0;
  const flagged = [];
  const errored = [];

  for (const p of preds) {
    const profile = getUpshotProfile(p.author_id);
    if (!profile?.wallet_address) {
      flagged.push(`${formatId(p.id)} (no wallet linked)`);
      continue;
    }
    const res = await checkCardOwnership(profile.wallet_address, p.card_id);
    if (res.error) {
      errored.push(`${formatId(p.id)} (${res.error})`);
      continue;
    }
    if (res.owned) {
      await applyVerification(p.id, interaction.user.id, guildId);
      verified++;
    } else {
      flagged.push(formatId(p.id));
    }
  }

  const lines = [
    `**Auto-verify complete** — ${preds.length} checked`,
    `✅ Verified: **${verified}**`,
    `⚠️ Flagged (not owned): **${flagged.length}**${flagged.length ? `\n   ${flagged.join(', ')}` : ''}`,
    `❌ API errors: **${errored.length}**${errored.length ? `\n   ${errored.join(', ')}` : ''}`,
  ];
  return interaction.editReply({ content: lines.join('\n') });
}

async function gatherRatingContext(prediction) {
  const ctx = {
    title: prediction.title,
    description: prediction.description,
    category: prediction.category,
    deadline: prediction.deadline,
  };
  if (prediction.card_id) {
    const card = await getCardDetails(prediction.card_id);
    if (card) {
      ctx.cardName = card.name || null;
      ctx.eventName = card.event?.name || null;
      ctx.eventDescription = card.event?.description || null;
      // The card's outcomeId is the outcome the user is betting on.
      const outcomes = card.event?.outcomes || [];
      const match = outcomes.find(o => o?.id === card.outcomeId);
      ctx.outcomeName = match?.name || null;
    }
  }
  return ctx;
}

// How many AI rating calls to run at once. Nemotron is slow per call, so a
// sequential loop over a big batch can take many minutes; a small pool cuts
// wall-clock without hammering the free-tier rate limit (429s are retried).
const RATE_CONCURRENCY = 3;

/**
 * Run an async mapper over `items` with at most `concurrency` in flight,
 * preserving input order in the returned results array.
 */
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * AI-rate a list of predictions concurrently. `extra(p)` lets the caller attach
 * fields (e.g. oldStars) to each suggestion. Returns { suggestions, failures }.
 */
async function rateManyPredictions(preds, extra = () => ({})) {
  const suggestions = [];
  const failures = [];
  const results = await mapPool(preds, RATE_CONCURRENCY, async (p) => {
    try {
      const ctx = await gatherRatingContext(p);
      const result = await rateWithAI(ctx);
      return { ok: true, suggestion: { id: p.id, stars: result.stars, reason: result.reason, title: p.title, ...extra(p) } };
    } catch (err) {
      return { ok: false, failure: `${formatId(p.id)} — ${err.message.slice(0, 120)}` };
    }
  });
  for (const r of results) {
    if (r.ok) suggestions.push(r.suggestion);
    else failures.push(r.failure);
  }
  return { suggestions, failures };
}

async function handleAutoRateAll(interaction, guildId) {
  const preds = getUnratedVerifiedPredictions();
  if (preds.length === 0) {
    return interaction.reply({ content: '✅ No verified predictions waiting for a star rating.', flags: ['Ephemeral'] });
  }

  if (!process.env.NVIDIA_NIM_API_KEY) {
    return interaction.reply({ content: '❌ `NVIDIA_NIM_API_KEY` is not set in .env.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const { suggestions, failures } = await rateManyPredictions(preds);

  if (suggestions.length === 0) {
    let content = `❌ All ${preds.length} AI calls failed.\n${failures.join('\n')}`;
    if (content.length > 1900) content = content.slice(0, 1870) + '\n... *(truncated)*';
    return interaction.editReply({ content });
  }

  const batchId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  pendingRatingBatches.set(batchId, { suggestions, guildId, adminId: interaction.user.id, createdAt: Date.now() });

  const header = `**AI rating suggestions** (${suggestions.length} predictions, model: \`${NIM_MODEL}\`)`;
  const body = suggestions.map(s => {
    const stars = renderStars(s.stars);
    const title = s.title.length > 60 ? s.title.slice(0, 57) + '...' : s.title;
    return `${formatId(s.id)} ${stars} — *${title}*\n   └ ${s.reason}`;
  }).join('\n\n');

  const footer = failures.length
    ? `\n\n⚠️ **${failures.length} failed:**\n${failures.join('\n')}`
    : '';

  let content = `${header}\n\n${body}${footer}`;
  // Discord message limit is 2000 chars in a reply
  if (content.length > 1900) {
    content = content.slice(0, 1870) + '\n... *(truncated — batch still has all items)*';
  }

  return interaction.editReply({
    content,
    components: [{
      type: 1, // ActionRow
      components: [
        { type: 2, style: 3, label: `✅ Accept All (${suggestions.length})`, custom_id: `accept_ratings:${batchId}` },
        { type: 2, style: 4, label: 'Cancel', custom_id: `cancel_ratings:${batchId}` },
      ],
    }],
  });
}

async function handleRecheckAllRatings(interaction, guildId) {
  const preds = getRatedActivePredictions();
  if (preds.length === 0) {
    return interaction.reply({ content: '✅ No active rated predictions to recheck.', flags: ['Ephemeral'] });
  }

  if (!process.env.NVIDIA_NIM_API_KEY) {
    return interaction.reply({ content: '❌ `NVIDIA_NIM_API_KEY` is not set in .env.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const { suggestions, failures } = await rateManyPredictions(preds, (p) => ({ oldStars: p.star_rating }));

  if (suggestions.length === 0) {
    let content = `❌ All ${preds.length} AI calls failed.\n${failures.join('\n')}`;
    if (content.length > 1900) content = content.slice(0, 1870) + '\n... *(truncated)*';
    return interaction.editReply({ content });
  }

  const changed = suggestions.filter(s => s.stars !== s.oldStars);

  if (changed.length === 0) {
    const footer = failures.length ? `\n\n⚠️ **${failures.length} failed:**\n${failures.join('\n')}` : '';
    return interaction.editReply({
      content: `✅ Rechecked **${suggestions.length}** active prediction${suggestions.length === 1 ? '' : 's'} — the AI agrees with every current rating, nothing to change.${footer}`,
    });
  }

  const batchId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  // Only the changed suggestions get applied; mode 'recheck' lets the accept
  // handler re-rate predictions that are already rated.
  pendingRatingBatches.set(batchId, { suggestions: changed, mode: 'recheck', guildId, adminId: interaction.user.id, createdAt: Date.now() });

  const header = `**AI re-rating suggestions** — ${changed.length} change${changed.length === 1 ? '' : 's'} across ${suggestions.length} active prediction${suggestions.length === 1 ? '' : 's'} (model: \`${NIM_MODEL}\`)`;
  const body = changed.map(s => {
    const title = s.title.length > 55 ? s.title.slice(0, 52) + '...' : s.title;
    return `${formatId(s.id)} ${renderStars(s.oldStars)} → ${renderStars(s.stars)} — *${title}*\n   └ ${s.reason}`;
  }).join('\n\n');

  const footer = failures.length
    ? `\n\n⚠️ **${failures.length} failed:**\n${failures.join('\n')}`
    : '';

  let content = `${header}\n\n${body}${footer}`;
  if (content.length > 1900) {
    content = content.slice(0, 1870) + '\n... *(truncated — batch still has all changes)*';
  }

  return interaction.editReply({
    content,
    components: [{
      type: 1, // ActionRow
      components: [
        { type: 2, style: 3, label: `✅ Apply ${changed.length} change${changed.length === 1 ? '' : 's'}`, custom_id: `accept_ratings:${batchId}` },
        { type: 2, style: 4, label: 'Cancel', custom_id: `cancel_ratings:${batchId}` },
      ],
    }],
  });
}

async function handleAcceptRatings(interaction, batchId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const batch = pendingRatingBatches.get(batchId);
  if (!batch) {
    return interaction.update({ content: '❌ Batch expired or already applied.', components: [] });
  }
  pendingRatingBatches.delete(batchId);

  const isRecheck = batch.mode === 'recheck';
  await interaction.update({ content: `⏳ Applying ${batch.suggestions.length} ${isRecheck ? 'rating change' : 'rating'}${batch.suggestions.length === 1 ? '' : 's'}...`, components: [] });

  let applied = 0;
  const skipped = [];
  for (const s of batch.suggestions) {
    const current = getPrediction(s.id);
    if (!current) { skipped.push(`${formatId(s.id)} (deleted)`); continue; }
    if (isRecheck) {
      // Re-rating an already-rated prediction; only skip if it has since
      // resolved (outcome is locked) or the rating already matches.
      if (current.outcome) { skipped.push(`${formatId(s.id)} (already resolved)`); continue; }
      if (current.star_rating === s.stars) { skipped.push(`${formatId(s.id)} (unchanged)`); continue; }
    } else {
      if (isRated(current)) { skipped.push(`${formatId(s.id)} (already rated)`); continue; }
      if (!current.ownership_verified) { skipped.push(`${formatId(s.id)} (no longer verified)`); continue; }
    }
    await applyStarRating(s.id, s.stars, batch.adminId, batch.guildId);
    applied++;
  }

  const lines = [
    `✅ Applied **${applied}** ${isRecheck ? 'rating change' : 'AI star rating'}${applied === 1 ? '' : 's'}`,
  ];
  if (skipped.length) lines.push(`⏭️ Skipped **${skipped.length}**: ${skipped.join(', ')}`);
  return interaction.editReply({ content: lines.join('\n'), components: [] });
}

async function handleCheckAllResolutions(interaction) {
  const count = getUnresolvedCount();
  if (count === 0) {
    return interaction.reply({ content: '✅ No unresolved rated predictions to check.', flags: ['Ephemeral'] });
  }

  await interaction.reply({
    content: `🔍 Checking **${count}** unresolved prediction(s) — ~3s between each call. Final summary will post to the admin channel.`,
    flags: ['Ephemeral'],
  });

  // Fire-and-forget — runAutoResolve already posts its summary via notifyAdmin
  // and takes ~3s × count, which would exceed the 3s interaction window.
  // Call runAutoResolve directly so we don't reset the 12h auto-resolve timer.
  runAutoResolve().catch(err => {
    console.error('Manual check-all-resolutions failed:', err);
  });
}

async function handleCancelRatings(interaction, batchId) {
  pendingRatingBatches.delete(batchId);
  return interaction.update({ content: '❌ AI rating suggestions discarded.', components: [] });
}

// ── Modal submits ───────────────────────────────────────────

async function handleLinkProfileModalSubmit(interaction) {
  const url = interaction.fields.getTextInputValue('profile_url').trim();

  if (!url.startsWith('https://') || !url.includes('upshot')) {
    return interaction.reply({
      content: '❌ Invalid URL. Please use your Upshot profile URL.\nExample: `https://upshot.cards/profile/0x89A8f58daF80b0B7a5419848c114AD272a72F887`',
      flags: ['Ephemeral'],
    });
  }

  const wallet = extractWallet(url);
  if (!wallet) {
    return interaction.reply({
      content: '❌ Could not find a wallet address (0x...) in that URL.\nMake sure you use the full profile URL from upshot.cards, e.g.:\n`https://upshot.cards/profile/0x89A8f58daF80b0B7a5419848c114AD272a72F887`',
      flags: ['Ephemeral'],
    });
  }

  // Duplicate check
  const existing = checkDuplicateProfile(url, wallet, interaction.user.id);
  if (existing) {
    notifyAdmin(interaction.guildId,
      `⚠️ **Duplicate profile attempt**\n` +
      `**User:** <@${interaction.user.id}> tried to link\n` +
      `**URL:** ${url}\n` +
      `**Already belongs to:** <@${existing.discord_id}> (linked ${existing.linked_at})`
    ).catch(() => {});

    return interaction.reply({
      content: '❌ This Upshot profile is already linked to another user.',
      flags: ['Ephemeral'],
    });
  }

  linkUpshot(interaction.user.id, url, wallet);

  await interaction.reply({
    content: `✅ **You're linked!** Wallet \`${wallet.slice(0, 6)}…${wallet.slice(-4)}\`.\n\nNext: tap **📇 My Cards** on the panel to pick a card and make your first prediction — no URL to copy, no title to write.`,
    flags: ['Ephemeral'],
  });
}

async function handlePredictModalSubmit(interaction) {
  // Retrieve guild context stored during /predict command or panel button
  const pending = pendingSubmissions.get(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: '❌ Submission expired. Tap **📇 My Cards**, pick your card again, and hit Predict.',
      flags: ['Ephemeral'],
    });
  }
  pendingSubmissions.delete(interaction.user.id);

  // When the card was chosen from the picker, its id is on the pending context
  // and the modal has no card_url field — reading it would throw.
  const presetCardId = pending.cardId || null;

  const description = interaction.fields.getTextInputValue('description');
  const rawCardUrl = presetCardId ? null : (interaction.fields.getTextInputValue('card_url')?.trim() || null);
  const rawTweetUrl = interaction.fields.getTextInputValue('tweet_url')?.trim() || null;

  // Validate tweet URL if provided
  const tweetUrl = rawTweetUrl && rawTweetUrl.startsWith('https://') && (rawTweetUrl.includes('twitter') || rawTweetUrl.includes('x.com'))
    ? rawTweetUrl
    : null;

  if (rawTweetUrl && !tweetUrl) {
    return interaction.reply({
      content: '❌ Invalid tweet URL. Must start with `https://` and be from twitter.com or x.com.',
      flags: ['Ephemeral'],
    });
  }

  // Validate card URL/ID format before hitting API (skipped for picker cards)
  if (rawCardUrl) {
    const isUrl = rawCardUrl.startsWith('https://') && rawCardUrl.includes('upshot');
    const isRawId = /^cm[a-z0-9]{10,}$/i.test(rawCardUrl);
    if (!isUrl && !isRawId) {
      return interaction.reply({
        content: '❌ Invalid card URL or ID. Use the full card URL from upshot.cards or a card ID starting with `cm`.\nExample: `https://upshot.cards/card-detail/cm...`',
        flags: ['Ephemeral'],
      });
    }
  }

  // Defer — API calls + posting to channels takes time
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const { guildId } = pending;

  // Extract card ID and fetch card details + ownership check
  // API failures are non-blocking — prediction still submits without card data
  const cardId = presetCardId || (rawCardUrl ? extractCardId(rawCardUrl) : null);
  let cardImage = null;
  let ownershipCheck = null;
  let deadlineFormatted = null;
  let cardName = null;

  if (cardId) {
    let cardDetails = null;
    try {
      cardDetails = await getCardDetails(cardId);
      if (cardDetails?.arweaveUrl) {
        cardImage = cardDetails.arweaveUrl;
      }
      if (cardDetails?.name) {
        cardName = cardDetails.name;
      }
      // Auto-fill deadline from card's event date
      if (cardDetails?.eventDate) {
        const d = new Date(cardDetails.eventDate);
        deadlineFormatted = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
    } catch (err) {
      console.error(`API pre-check: getCardDetails failed for ${cardId}:`, err.message);
    }

    // Reject if card not found AND we didn't get any data (API was reachable but card invalid)
    // If API failed entirely (network error), cardDetails is null but we let it through
    if (cardDetails === null) {
      // Check if API is reachable with a simple test
      try {
        const test = await fetch('https://api-mainnet.upshotcards.net/api/v1/categories', { signal: AbortSignal.timeout(5000) });
        if (test.ok) {
          // API is up but card not found — reject
          return interaction.editReply({
            content: '❌ Could not find that card on Upshot. Double-check the card URL or ID and try again.',
          });
        }
      } catch {
        // API is down — let through, admins will check
      }
    }

    // Forbid Instant Cash / Instant XP cards — they pay out on pack-pull and
    // carry no prediction, so they can't back one. (Only reject when we actually
    // got card data; a failed lookup falls through and is handled above.)
    if (cardDetails && isInstantWinCard(cardDetails)) {
      return interaction.editReply({
        content: '❌ That\'s an Instant Win card (Instant Cash or Instant XP). These pay out when pulled from a pack and can\'t be used to back a prediction. Pick a regular prediction card instead.',
      });
    }

    try {
      const profile = getUpshotProfile(interaction.user.id);
      const wallet = profile?.wallet_address;
      if (wallet) {
        const result = await checkCardOwnership(wallet, cardId);
        if (result.error) {
          ownershipCheck = 'error';
        } else if (result.inContest) {
          ownershipCheck = 'verified_contest';
        } else if (result.owned) {
          ownershipCheck = 'verified';
        } else {
          ownershipCheck = 'not_found';
        }
      }
    } catch (err) {
      console.error(`API pre-check: checkCardOwnership failed for ${cardId}:`, err.message);
      ownershipCheck = 'error';
    }
  }

  // Check if card event has already passed or is today
  if (deadlineFormatted && deadlineFormatted !== 'TBD') {
    const today = new Date();
    const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    if (deadlineFormatted <= todayStr) {
      return interaction.editReply({
        content: `❌ This card's event deadline has already passed (**${deadlineFormatted}**). You can only submit predictions for upcoming events.`,
      });
    }
  }

  // Check for duplicate — reject if anyone has an unresolved prediction for the same card
  if (cardId) {
    const existing = hasUnresolvedPredictionForCard(cardId);
    if (existing) {
      return interaction.editReply({ content: cardTakenMessage(existing, guildId, interaction.user.id) });
    }
  }

  // Re-enforce the daily/open caps here, not just at modal-open. showPredictModal
  // checks them before opening the modal, but a user can open several Predict
  // modals while under the cap and submit them all — only this check, right
  // before createPrediction, is authoritative (the modal-open check is just a
  // fast UX bail-out).
  const maxDaily = getMaxDaily(guildId);
  if (countUserDailyPredictions(interaction.user.id) >= maxDaily) {
    return interaction.editReply({ content: `❌ You've reached the daily limit of **${maxDaily}** predictions. Try again tomorrow.` });
  }
  const maxOpen = getMaxOpen(guildId);
  const openCount = countUserUnresolved(interaction.user.id);
  if (openCount >= maxOpen) {
    return interaction.editReply({ content: `❌ You have **${openCount}** open predictions (max **${maxOpen}**). Wait for some to resolve before submitting more.` });
  }

  // Fallback deadline if API didn't return one
  if (!deadlineFormatted) {
    deadlineFormatted = 'TBD';
  }

  const proofType = tweetUrl ? 'tweet' : 'none';

  // Title is auto-derived from the card — fetched name first, then the picker's
  // label, then a generic fallback (covers API-down submissions).
  const title = (cardName || pending.cardName || 'Upshot prediction').slice(0, 100);

  let prediction;
  try {
    prediction = createPrediction({
      authorId: interaction.user.id,
      title,
      category: 'General',
      description,
      deadline: deadlineFormatted,
      proofType,
      tweetUrl,
      images: [],
      status: Status.PendingVerification,
      cardId,
      cardImage,
      ownershipCheck,
    });
  } catch (err) {
    console.error('Failed to create prediction:', err);
    return interaction.editReply({ content: '❌ Failed to save prediction. Please try again.' });
  }

  await postPredictionToFeed(prediction, guildId).catch(e => console.error('Feed post failed:', e.message));
  await postToAdminReview(prediction, guildId).catch(e => console.error('Admin post failed:', e.message));
  await refreshLeaderboard(guildId).catch(() => {});

  // Auto-verify + auto-rate when the API pre-check confirms ownership.
  // AI rating runs in the background; embeds update themselves when it lands.
  if (ownershipCheck === 'verified' || ownershipCheck === 'verified_contest') {
    autoVerifyAndRate(prediction.id, guildId).catch(() => {});
  }

  let statusNote = '';
  if (ownershipCheck === 'verified' || ownershipCheck === 'verified_contest') {
    statusNote = ' — ✅ Auto-verified via Upshot API.';
  } else if (ownershipCheck === 'not_found') {
    statusNote = ' — ⚠️ Card not found in your wallet (admin will review)';
  }

  await interaction.editReply({
    content: `✅ Prediction **#${String(prediction.id).padStart(4, '0')}** submitted! Now in the review queue.${statusNote}`,
  });
}

async function handleEditModalSubmit(interaction) {
  const predictionId = parseInt(interaction.customId.split(':')[1], 10);
  const prediction = getPrediction(predictionId);

  if (!prediction || prediction.author_id !== interaction.user.id) {
    return interaction.reply({ content: '❌ Not found or not yours.', flags: ['Ephemeral'] });
  }

  const title = interaction.fields.getTextInputValue('title');
  const description = interaction.fields.getTextInputValue('description');
  const deadline = interaction.fields.getTextInputValue('deadline');

  const updates = { title, description };
  const deadlineMatch = deadline.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (deadlineMatch) {
    const [, dd, mm, yyyy] = deadlineMatch;
    updates.deadline = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    updates.month_key = `${yyyy}-${mm.padStart(2, '0')}`;
  }

  // Build diff for admin notification
  const changes = [];
  if (prediction.title !== title) {
    changes.push(`**Title:** ${prediction.title} → ${title}`);
  }
  if (prediction.description !== description) {
    const oldSnip = prediction.description.length > 80 ? prediction.description.slice(0, 80) + '...' : prediction.description;
    const newSnip = description.length > 80 ? description.slice(0, 80) + '...' : description;
    changes.push(`**Description:** ${oldSnip} → ${newSnip}`);
  }
  if (updates.deadline && prediction.deadline !== updates.deadline) {
    changes.push(`**Deadline:** ${prediction.deadline} → ${updates.deadline}`);
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });
  updatePrediction(predictionId, updates);
  await syncPredictionEmbeds(predictionId, interaction.guildId);
  await interaction.editReply({ content: '✅ Prediction updated.' });

  // Notify admin channel about the edit
  if (changes.length > 0) {
    const adminChannelId = getAdminChannelId(interaction.guildId);
    if (adminChannelId) {
      const channel = await safeGetChannel(adminChannelId);
      if (channel) {
        const id = String(predictionId).padStart(4, '0');
        const msg = [
          `**✏️ Prediction #${id} edited by <@${interaction.user.id}>**`,
          ...changes,
        ].join('\n');
        await channel.send({ content: msg }).catch(() => {});
      }
    }
  }
}

async function handleStarsModalSubmit(interaction) {
  const predictionId = parseInt(interaction.customId.split(':')[1], 10);
  const starsInput = interaction.fields.getTextInputValue('stars').trim();
  const stars = parseInt(starsInput, 10);

  if (![0, 1, 2, 3].includes(stars)) {
    return interaction.reply({ content: '❌ Stars must be 0, 1, 2, or 3.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.reply({ content: '❌ Prediction not found.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const updated = await applyStarRating(predictionId, stars, interaction.user.id, interaction.guildId);

  const id = String(predictionId).padStart(4, '0');
  const content = stars === 0
    ? `🚫 Rated **#${id}** — **0★ low-effort**. No points, no rewards (even with a tweet).`
    : `⭐ Rated **#${id}** — ${stars} star${stars > 1 ? 's' : ''} (${updated.total_points} pts)`;
  await interaction.editReply({ content, flags: ['Ephemeral'] });
}

// ── Button handlers ─────────────────────────────────────────

async function handleButton(interaction) {
  // Legacy panel "Make a Prediction" button — route to the card picker.
  if (interaction.customId === 'panel_predict') {
    return handleCardPicker(interaction);
  }

  // Manual "Predict by URL" — opens a modal asking only for the card URL/ID; it's
  // validated (exists / deadline / already-predicted) before the prediction modal.
  if (interaction.customId === 'panel_predict_url') {
    return showPredictUrlModal(interaction);
  }

  // Hub buttons (self-serve panel) — reuse existing handlers
  if (interaction.customId === 'hub_mycards' || interaction.customId === 'mycards_retry') {
    return handleCardPicker(interaction);
  }

  // My Cards pagination
  if (interaction.customId.startsWith('mycards_page:')) {
    const page = parseInt(interaction.customId.split(':')[1], 10);
    return handleCardPage(interaction, Number.isNaN(page) ? 0 : page);
  }

  if (interaction.customId.startsWith('mystats_page:')) {
    const page = parseInt(interaction.customId.split(':')[1], 10);
    return handleMyStatsPage(interaction, Number.isNaN(page) ? 0 : page);
  }

  // Admin panel
  if (interaction.customId === 'admin_back' || interaction.customId === 'admin_refresh') {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
    return interaction.update(buildAdminPanel(gatherAdminCfg(interaction.guildId)));
  }
  if (interaction.customId.startsWith('admin_act:')) {
    return handleAdminAction(interaction, interaction.customId.split(':')[1]);
  }

  // My Cards search
  if (interaction.customId === 'mycards_search') {
    return handleMyCardSearch(interaction);
  }
  if (interaction.customId === 'mycards_search_clear') {
    return handleMyCardSearchClear(interaction);
  }

  // Card detail view actions
  if (interaction.customId === 'carddetail_back') {
    return handleCardDetailBack(interaction);
  }
  if (interaction.customId.startsWith('carddetail_predict:')) {
    return handleCardDetailPredict(interaction);
  }
  if (interaction.customId === 'hub_mystats') {
    return handleMyStats(interaction);
  }
  if (interaction.customId === 'hub_leaderboard') {
    return handleCurrentLeaderboard(interaction);
  }
  if (interaction.customId === 'hub_mycontests') {
    return handleMyContests(interaction);
  }

  // Help page buttons (panel_help:0, panel_help:1, etc.)
  if (interaction.customId.startsWith('panel_help:')) {
    const page = parseInt(interaction.customId.split(':')[1], 10);
    const payload = buildHelpPage(page);
    // If this help view is already ephemeral (opened from another ephemeral
    // flow), edit it in place. From a PUBLIC panel button, reply with a fresh
    // EPHEMERAL help page instead of posting it publicly — otherwise every
    // "How It Works" click spams the channel with a new public message.
    if (interaction.message.flags?.has(1 << 6)) {
      return interaction.update(payload);
    }
    return interaction.reply({ ...payload, flags: (payload.flags || 0) | (1 << 6) });
  }

  // Pack send confirmation
  if (interaction.customId === 'confirm_sendpack') {
    return handleConfirmSendPack(interaction);
  }
  if (interaction.customId === 'cancel_sendpack') {
    return handleCancelSendPack(interaction);
  }

  // Contest navigation
  if (interaction.customId === 'contest_back') {
    const contests = contestCache.get(interaction.user.id);
    if (!contests) return interaction.reply({ content: '❌ Session expired. Run `/mycontests` again.', flags: ['Ephemeral'] });
    return interaction.update(buildContestOverview(contests));
  }
  if (interaction.customId.startsWith('contest_select:')) {
    const [, contestIdxStr, lineupIdxStr] = interaction.customId.split(':');
    const contests = contestCache.get(interaction.user.id);
    if (!contests) return interaction.reply({ content: '❌ Session expired. Run `/mycontests` again.', flags: ['Ephemeral'] });
    const contestIdx = parseInt(contestIdxStr, 10);
    const lineupIdx = parseInt(lineupIdxStr, 10);
    if (contestIdx >= contests.length) return interaction.reply({ content: '❌ Contest not found.', flags: ['Ephemeral'] });
    return interaction.update(buildContestLineupPage(contests[contestIdx], lineupIdx, contestIdx));
  }

  // Leaderboard CSV export
  if (interaction.customId.startsWith('leaderboard_export:')) {
    return handleLeaderboardExport(interaction, interaction.customId.slice('leaderboard_export:'.length));
  }

  // Leaderboard grant role (admin) — show a role picker
  if (interaction.customId.startsWith('leaderboard_grant:')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
    }
    const monthKey = interaction.customId.slice('leaderboard_grant:'.length);
    return interaction.reply({
      content: `Pick a role to assign to the **top 10** of \`${monthKey}\`:`,
      components: [{
        type: 1,
        components: [{
          type: 6, // RoleSelect
          custom_id: `leaderboard_role_select:${monthKey}`,
          placeholder: 'Select a role',
          min_values: 1,
          max_values: 1,
        }],
      }],
      flags: ['Ephemeral'],
    });
  }

  // AI rating batch buttons (carry a batchId, not a predictionId)
  if (interaction.customId.startsWith('accept_ratings:')) {
    return handleAcceptRatings(interaction, interaction.customId.slice('accept_ratings:'.length));
  }
  if (interaction.customId.startsWith('cancel_ratings:')) {
    return handleCancelRatings(interaction, interaction.customId.slice('cancel_ratings:'.length));
  }

  const parts = interaction.customId.split(':');
  const action = parts[0];
  const predictionId = parseInt(parts[1] || '', 10);

  if (isNaN(predictionId)) {
    return interaction.reply({ content: '❓ Unknown action.', flags: ['Ephemeral'] });
  }

  // Community vote: community_vote:{id}:{stars}
  if (action === 'community_vote') {
    const stars = parseInt(parts[2], 10);
    if (![1, 2, 3].includes(stars)) return interaction.reply({ content: '❌ Invalid vote.', flags: ['Ephemeral'] });
    return handleCommunityVote(interaction, predictionId, stars);
  }

  switch (action) {
    case 'read_more':
      return handleReadMore(interaction, predictionId);
    case 'edit_prediction':
      return handleEditButton(interaction, predictionId);
    case 'verify_ownership':
      return handleVerifyOwnership(interaction, predictionId);
    case 'assign_stars':
      return handleAssignStars(interaction, predictionId);
    case 'check_resolve':
      return handleCheckResolve(interaction, predictionId);
    case 'mark_hit':
      return handleMarkOutcome(interaction, predictionId, 'hit');
    case 'mark_fail':
      return handleMarkOutcome(interaction, predictionId, 'fail');
    case 'delete_prediction':
      return handleDeleteButton(interaction, predictionId);
    case 'confirm_delete':
      return handleConfirmDelete(interaction, predictionId);
    case 'user_cancel_confirm':
      return handleUserCancelConfirm(interaction, predictionId);
    case 'user_cancel_abort':
      return interaction.reply({
        content: '👍 Kept — your prediction was not cancelled.',
        flags: ['Ephemeral'],
      });
    case 'cancel_delete':
      return interaction.reply({
        content: '❌ Deletion cancelled.',
        flags: ['Ephemeral'],
      });
    default:
      return interaction.reply({ content: '❓ Unknown action.', flags: ['Ephemeral'] });
  }
}

async function handleReadMore(interaction, predictionId) {
  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', flags: ['Ephemeral'] });

  const id = String(prediction.id).padStart(4, '0');
  // Discord message limit is 2000 chars — chunk if needed
  const header = `**${prediction.title}** · \`#${id}\`\n\n`;
  const content = header + prediction.description;

  if (content.length <= 2000) {
    return interaction.reply({ content, flags: ['Ephemeral'] });
  }

  // Send first 2000, follow up with the rest
  await interaction.reply({ content: content.slice(0, 2000), flags: ['Ephemeral'] });
  await interaction.followUp({ content: content.slice(2000), flags: ['Ephemeral'] });
}

async function handleEditButton(interaction, predictionId) {
  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.reply({ content: '❌ Prediction not found.', flags: ['Ephemeral'] });
  }
  if (prediction.author_id !== interaction.user.id) {
    return interaction.reply({ content: '❌ You can only edit your own predictions.', flags: ['Ephemeral'] });
  }
  if (![Status.PendingVerification, Status.PendingReview].includes(prediction.status)) {
    return interaction.reply({ content: '❌ This prediction can no longer be edited.', flags: ['Ephemeral'] });
  }

  // 1-hour edit window
  const createdAt = new Date(prediction.created_at + 'Z').getTime();
  const elapsed = Date.now() - createdAt;
  if (elapsed > 60 * 60 * 1000) {
    return interaction.reply({ content: '❌ Edit window has closed. Predictions can only be edited within 1 hour of submission.', flags: ['Ephemeral'] });
  }

  const modal = new ModalBuilder()
    .setCustomId(`edit_modal:${predictionId}`)
    .setTitle('Edit Prediction');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title')
        .setValue(prediction.title)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description')
        .setValue(prediction.description)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('deadline')
        .setLabel('Deadline (DD/MM/YYYY)')
        .setValue(prediction.deadline)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
  );

  await interaction.showModal(modal);
}

/**
 * Shared effect: mark ownership verified and resync embeds.
 * Used by both the manual button and /setup auto-verify-all.
 */
async function applyVerification(predictionId, verifierId, guildId) {
  updatePrediction(predictionId, {
    ownership_verified: 1,
    verified_by: verifierId,
    verified_at: new Date().toISOString(),
    status: Status.PendingReview,
  });
  await syncPredictionEmbeds(predictionId, guildId);
}

/**
 * Shared effect: assign stars, recalculate points, resync embeds + leaderboard.
 * Used by both the manual stars modal and /setup auto-rate-all accept-all.
 * Returns the updated prediction (with total_points).
 */
async function applyStarRating(predictionId, stars, raterId, guildId) {
  const prediction = getPrediction(predictionId);
  if (!prediction) return null;

  updatePrediction(predictionId, {
    star_rating: stars,
    status: prediction.outcome ? prediction.status : Status.Rated,
    rated_by: raterId,
  });
  const updated = recalculatePoints(predictionId);
  await syncPredictionEmbeds(predictionId, guildId);
  await refreshLeaderboard(guildId).catch(() => {});
  return updated;
}

async function handleVerifyOwnership(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', flags: ['Ephemeral'] });

  if (prediction.ownership_verified) {
    return interaction.reply({ content: '✅ Already verified.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  await applyVerification(predictionId, interaction.user.id, interaction.guildId);

  await interaction.editReply({
    content: `✅ Ownership verified for **#${String(predictionId).padStart(4, '0')}**. Ready for star rating.`,
  });
}

async function handleAssignStars(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', flags: ['Ephemeral'] });

  if (!prediction.ownership_verified) {
    return interaction.reply({ content: '❌ Verify ownership first.', flags: ['Ephemeral'] });
  }

  const modal = new ModalBuilder()
    .setCustomId(`stars_modal:${predictionId}`)
    .setTitle(`Rate Prediction #${String(predictionId).padStart(4, '0')}`);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('stars')
        .setLabel('Stars (0 = low-effort, or 1, 2, 3)')
        .setPlaceholder('0, 1, 2, or 3')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(1)
        .setRequired(true)
    ),
  );

  await interaction.showModal(modal);
}

async function handleCheckResolve(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', flags: ['Ephemeral'] });
  if (!prediction.card_id) return interaction.reply({ content: '❌ No card ID on this prediction.', flags: ['Ephemeral'] });

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const previousOutcome = prediction.outcome;
  const result = await checkCardResolution(prediction.card_id);

  if (result.error === 'no_winning_outcome') {
    return interaction.editReply({ content: '⏳ Event is marked resolved on Upshot but the winning outcome isn\'t published yet — try again shortly.' });
  }
  if (result.error) {
    return interaction.editReply({ content: `⚠️ API error: ${result.error}` });
  }

  if (!result.resolved) {
    return interaction.editReply({ content: '⏳ Card event is still **active** — not resolved yet.' });
  }

  const outcome = result.won ? 'hit' : 'fail';
  const status = outcome === 'hit' ? Status.Hit : Status.Fail;

  updatePrediction(predictionId, { outcome, status, resolved_by: 'auto' });
  const updated = recalculatePoints(predictionId);

  await syncPredictionEmbeds(predictionId, interaction.guildId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});

  const emoji = outcome === 'hit' ? '🟢' : '🔴';
  const change = previousOutcome && previousOutcome !== outcome ? ` (was **${previousOutcome}**)` : '';
  await interaction.editReply({
    content: `${emoji} **#${String(predictionId).padStart(4, '0')}** resolved via API — **${outcome}**${change} (${updated.total_points} pts)`,
  });
}

async function handleCommunityVote(interaction, predictionId, stars) {
  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', flags: ['Ephemeral'] });

  if (prediction.author_id === interaction.user.id) {
    return interaction.reply({ content: '❌ You can\'t vote on your own prediction.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  upsertCommunityVote(predictionId, interaction.user.id, stars);

  // Recalculate points if admin has already rated
  if (isRated(prediction)) {
    recalculatePoints(predictionId);
    await syncPredictionEmbeds(predictionId, interaction.guildId);
    if (prediction.outcome) {
      await refreshLeaderboard(interaction.guildId).catch(() => {});
    }
  } else {
    await syncPredictionEmbeds(predictionId, interaction.guildId);
  }

  const summary = getCommunityVoteSummary(predictionId);
  const avgStr = summary?.avg ? summary.avg.toFixed(1) : '—';
  const voteCount = summary?.count || 0;
  await interaction.editReply({
    content: `${'⭐'.repeat(stars)} You rated this prediction **${stars} star${stars > 1 ? 's' : ''}**. Community avg: **${avgStr}** (${voteCount} vote${voteCount !== 1 ? 's' : ''})`,
  });
}

async function handleMarkOutcome(interaction, predictionId, outcome) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', flags: ['Ephemeral'] });

  if (!isRated(prediction)) {
    return interaction.reply({ content: '❌ Assign stars first.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const previousOutcome = prediction.outcome;
  const status = outcome === 'hit' ? Status.Hit : Status.Fail;

  updatePrediction(predictionId, { outcome, status, resolved_by: interaction.user.id });
  const updated = recalculatePoints(predictionId);

  await syncPredictionEmbeds(predictionId, interaction.guildId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});

  const emoji = outcome === 'hit' ? '🟢' : '🔴';
  const override = previousOutcome ? ` (was **${previousOutcome}**)` : '';
  await interaction.editReply({
    content: `${emoji} **#${String(predictionId).padStart(4, '0')}** marked as **${outcome}**${override} — ${updated.total_points} pts total`,
  });
}

async function handleDeleteButton(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Already deleted.', flags: ['Ephemeral'] });

  await interaction.reply(buildDeleteConfirm(predictionId));
}

// Delete a prediction's public + admin embeds (best-effort).
async function deletePredictionMessages(guildId, prediction) {
  if (prediction.embed_message_id) {
    const channelId = getPredictionsChannelId(guildId);
    if (channelId) {
      const channel = await safeGetChannel(channelId);
      if (channel) {
        const msg = await safeGetMessage(channel, prediction.embed_message_id);
        if (msg) { try { await msg.delete(); } catch { /* ok */ } }
      }
    }
  }

  if (prediction.admin_message_id) {
    const channelId = getAdminChannelId(guildId);
    if (channelId) {
      const channel = await safeGetChannel(channelId);
      if (channel) {
        const msg = await safeGetMessage(channel, prediction.admin_message_id);
        if (msg) { try { await msg.delete(); } catch { /* ok */ } }
      }
    }
  }
}

async function handleConfirmDelete(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.reply({ content: '❌ Already deleted.', flags: ['Ephemeral'] });
  }

  await deletePredictionMessages(interaction.guildId, prediction);

  deletePrediction(predictionId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});

  await interaction.reply({
    content: `🗑 Prediction **#${String(predictionId).padStart(4, '0')}** deleted.`,
    flags: ['Ephemeral'],
  });
}

// ── User self-cancel (deadline > 30 days away) ───────────────

const CANCEL_MIN_DAYS = 30;

function isCancellable(prediction) {
  if (prediction.outcome !== null) return false;
  const deadlineMs = new Date(`${prediction.deadline}T00:00:00Z`).getTime();
  return deadlineMs - Date.now() > CANCEL_MIN_DAYS * 24 * 60 * 60 * 1000;
}

async function handleCancelPrediction(interaction) {
  const eligible = getUserUnresolvedPredictions(interaction.user.id).filter(isCancellable);
  if (eligible.length === 0) {
    return interaction.reply({
      content: `❌ You have no cancellable predictions. Only open predictions with a deadline more than ${CANCEL_MIN_DAYS} days away can be cancelled.`,
      flags: ['Ephemeral'],
    });
  }
  return interaction.reply(buildCancelPicker(eligible, CANCEL_MIN_DAYS));
}

async function handleCancelSelect(interaction) {
  const prediction = getPrediction(parseInt(interaction.values[0], 10));
  if (!prediction || prediction.author_id !== interaction.user.id || !isCancellable(prediction)) {
    return interaction.reply({ content: '❌ This prediction can no longer be cancelled.', flags: ['Ephemeral'] });
  }
  return interaction.update(buildUserCancelConfirm(prediction));
}

async function handleUserCancelConfirm(interaction, predictionId) {
  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.reply({ content: '❌ Already deleted.', flags: ['Ephemeral'] });
  }
  if (prediction.author_id !== interaction.user.id) {
    return interaction.reply({ content: '❌ You can only cancel your own predictions.', flags: ['Ephemeral'] });
  }
  if (!isCancellable(prediction)) {
    return interaction.reply({
      content: `❌ This prediction can no longer be cancelled — the deadline must be more than ${CANCEL_MIN_DAYS} days away and the prediction unresolved.`,
      flags: ['Ephemeral'],
    });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  await deletePredictionMessages(interaction.guildId, prediction);
  deletePrediction(prediction.id);
  await refreshLeaderboard(interaction.guildId).catch(() => {});
  notifyAdmin(
    interaction.guildId,
    `🗑 <@${interaction.user.id}> cancelled their prediction **#${formatId(prediction.id)} — ${prediction.title}** (deadline ${prediction.deadline}).`
  ).catch(() => {});

  await interaction.editReply({
    content: `🗑 Prediction **#${formatId(prediction.id)} — ${prediction.title}** cancelled.`,
  });
}

// ── Admin notifications ──────────────────────────────────────

async function notifyAdmin(guildId, message) {
  const channelId = getAdminChannelId(guildId);
  if (!channelId) return;
  const channel = await safeGetChannel(channelId);
  if (!channel) return;
  try {
    await channel.send({ content: message });
  } catch { /* can't send — channel may be inaccessible */ }
}

// ── Auto-resolve engine ──────────────────────────────────────

const RESOLVE_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
let nextResolveCheck = null;
let resolveTimer = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runAutoResolve() {
  const guildId = process.env.GUILD_ID;
  if (!guildId) {
    console.error('Auto-resolve: GUILD_ID not set, skipping');
    return;
  }

  console.log('Auto-resolve: Starting check...');
  const predictions = getUnresolvedRatedPredictions();

  if (predictions.length === 0) {
    console.log('Auto-resolve: No unresolved rated predictions');
    return;
  }

  console.log(`Auto-resolve: Checking ${predictions.length} prediction(s)...`);
  let resolved = 0;
  let gone = 0;        // card genuinely 404s — won't ever resolve via the API
  let transient = 0;   // couldn't reach the API this sweep — retried next time
  let errors = 0;      // unexpected failures in our own resolve logic

  for (const prediction of predictions) {
    try {
      const result = await checkCardResolution(prediction.card_id);

      if (result.error === 'card_not_found') {
        gone++;
        console.warn(`Auto-resolve: #${prediction.id} card no longer exists on Upshot (${prediction.card_id})`);
        continue;
      }
      if (result.error === 'fetch_failed' || result.error === 'no_winning_outcome') {
        // transient (timeout/rate-limit/5xx), or event flipped to RESOLVED before
        // its winner was published — recheck next sweep, don't mark a wrong loss.
        transient++;
        continue;
      }
      if (result.error) {
        errors++;
        console.error(`Auto-resolve: Error checking #${prediction.id}:`, result.error);
        continue;
      }

      if (!result.resolved) continue; // still active, skip

      const outcome = result.won ? 'hit' : 'fail';
      const status = outcome === 'hit' ? Status.Hit : Status.Fail;

      // Commit the resolution first — this is the source of truth. A failure in
      // the embed sync / admin ping below must NOT reclassify an already-resolved
      // prediction as an error, so those are individually guarded.
      updatePrediction(prediction.id, { outcome, status, resolved_by: 'auto' });
      recalculatePoints(prediction.id);
      resolved++;

      await syncPredictionEmbeds(prediction.id, guildId).catch((e) =>
        console.error(`Auto-resolve: embed sync failed for #${prediction.id}:`, e.message));

      const updatedPred = getPrediction(prediction.id);
      const emoji = outcome === 'hit' ? '🟢' : '🔴';
      const id = String(prediction.id).padStart(4, '0');
      await notifyAdmin(guildId,
        `${emoji} **Auto-resolved #${id}** — **${outcome}** (${updatedPred.total_points} pts) · <@${prediction.author_id}>`
      ).catch(() => {});
    } catch (err) {
      errors++;
      console.error(`Auto-resolve: Unexpected error on #${prediction.id}:`, err.message);
    }

    // 3 second delay between checks to be nice to the API
    await sleep(3000);
  }

  if (resolved > 0) {
    await refreshLeaderboard(guildId).catch(() => {});
  }

  const stillActive = predictions.length - resolved - gone;
  const extra = [
    gone ? `${gone} card(s) gone` : null,
    transient ? `${transient} unreachable (will retry)` : null,
    errors ? `${errors} error(s)` : null,
  ].filter(Boolean).join(', ');
  const summary = `🤖 **Auto-resolve complete** — ${resolved} resolved, ${stillActive} still active${extra ? ` · ${extra}` : ''}`;
  console.log(`Auto-resolve: ${resolved} resolved, ${gone} gone, ${transient} transient, ${errors} errors`);
  await notifyAdmin(guildId, summary);
}

async function safeRunAutoResolve() {
  try {
    await runAutoResolve();
  } catch (err) {
    console.error('Auto-resolve: Fatal error:', err);
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      await notifyAdmin(guildId, `❌ **Auto-resolve crashed:** ${err.message}`).catch(() => {});
    }
  }
  scheduleNextResolve();
}

function scheduleNextResolve() {
  nextResolveCheck = new Date(Date.now() + RESOLVE_INTERVAL);
  resolveTimer = setTimeout(safeRunAutoResolve, RESOLVE_INTERVAL);
  console.log(`Auto-resolve: Next check at ${nextResolveCheck.toISOString()}`);
}

// ── Contest watcher ──────────────────────────────────────────
//
// Polls Upshot's /contests hourly and announces, in the configured contests
// channel:
//   • a NEW contest going live ("🏆 New Contest Live — …, ends …")
//   • a contest finishing       ("🏁 Contest Over — top 3: 🥇 … 🥈 … 🥉 …")
// State is persisted per guild in bot_state so a restart never re-announces; the
// first run seeds the existing backlog SILENTLY. Contests go LIVE → COMPLETED.

const CONTEST_WATCH_INTERVAL = 60 * 60 * 1000; // 60 min
const CONTEST_SEED_V = 1;
let contestWatchTimer = null;

// Flags when SEEDING a contest (firstRun/reseed): everything present is
// pre-existing → suppress its current state; only future transitions fire.
function contestSeedFlags(status) {
  return { status, announcedLive: true, announcedDone: status === 'COMPLETED' };
}
// Flags for a GENUINELY-NEW contest seen after seeding: a new LIVE contest is
// announced; one first seen already COMPLETED is suppressed (didn't witness it).
function contestNewFlags(status) {
  return { status, announcedLive: status !== 'LIVE', announcedDone: status === 'COMPLETED' };
}

async function runContestWatch(guildId, { announce = true } = {}) {
  const contests = await getContests();
  if (!contests.length) return { ok: false, total: 0, newLive: 0, done: 0, seeded: false };

  const prev = getContestWatchState(guildId);
  const seeding = !prev || prev._v !== CONTEST_SEED_V;

  if (seeding) {
    const state = { _v: CONTEST_SEED_V };
    for (const c of contests) state[c.id] = contestSeedFlags(c.status);
    setContestWatchState(guildId, state);
    console.log(`Contest watch: seeded ${contests.length} contest(s) silently for ${guildId} (v${CONTEST_SEED_V})`);
    return { ok: true, total: contests.length, newLive: 0, done: 0, seeded: true };
  }

  const state = prev;
  const channelId = getContestsChannelId(guildId);
  const channel = announce && channelId ? await safeGetChannel(channelId) : null;
  const liveIds = new Set(contests.map(c => c.id));

  let newLive = 0;
  let done = 0;

  for (const contest of contests) {
    if (!state[contest.id]) state[contest.id] = contestNewFlags(contest.status);
    const seen = state[contest.id];

    // Only mark announced on a SUCCESSFUL send — a transient Discord error must
    // not permanently suppress the announcement (it retries next sweep). With no
    // channel configured the flag stays false so it fires once one is set.
    if (contest.status === 'LIVE' && !seen.announcedLive && channel) {
      try {
        await channel.send(buildContestLive(contest));
        seen.announcedLive = true; newLive++;
      } catch (e) { console.error(`Contest watch: live announce failed for ${contest.id}:`, e.message); }
    }
    if (contest.status === 'COMPLETED' && !seen.announcedDone && channel) {
      try {
        const top = await getContestTop(contest.id, 3);
        await channel.send(buildContestResults(contest, top));
        seen.announcedDone = true; done++;
      } catch (e) { console.error(`Contest watch: results announce failed for ${contest.id}:`, e.message); }
    }
    seen.status = contest.status;
  }

  // Prune contests that have dropped off the API list so state can't grow forever.
  for (const id of Object.keys(state)) if (id !== '_v' && !liveIds.has(id)) delete state[id];

  setContestWatchState(guildId, state);
  if (newLive || done) console.log(`Contest watch: announced ${newLive} new live, ${done} completed`);
  return { ok: true, total: contests.length, newLive, done, seeded: false };
}

async function safeRunContestWatch() {
  const guildId = process.env.GUILD_ID;
  if (guildId) {
    try {
      await runContestWatch(guildId);
    } catch (err) {
      console.error('Contest watch: fatal error:', err.message);
    }
  }
  contestWatchTimer = setTimeout(safeRunContestWatch, CONTEST_WATCH_INTERVAL);
}

// Admin /contests command: `check` runs a watch pass now, `list` posts the
// current LIVE contests publicly to the channel.
async function handleContestsCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
  }
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply(sub === 'list' ? {} : { flags: ['Ephemeral'] });

  if (sub === 'list') {
    const live = (await getContests()).filter(c => c.status === 'LIVE');
    return interaction.editReply(buildContestList(live));
  }

  // sub === 'check'
  const r = await runContestWatch(interaction.guildId, { announce: true });
  if (!r.ok) {
    return interaction.editReply({ content: '⚠️ Couldn\'t reach the Upshot contests API just now — try again in a moment.' });
  }
  if (r.seeded) {
    return interaction.editReply({ content: `✅ First sync done — seeded **${r.total}** contest(s) silently. From now on new contests and results will post to the channel.` });
  }
  const channelSet = !!getContestsChannelId(interaction.guildId);
  const note = channelSet ? '' : '\n-# ⚠️ No contests channel set — run `/setup contests-channel`.';
  return interaction.editReply({ content: `✅ Checked **${r.total}** contest(s) — announced **${r.newLive}** new live, **${r.done}** completed.${note}` });
}

// ── Lucky Shots (raffle) watcher ─────────────────────────────
//
// Polls Upshot's /raffles endpoint and announces, in the configured Lucky Shots
// channel, when a raffle goes LIVE ("🎰 Lucky Shot Live — ends …") and when it's
// DRAWN ("🏆 Winner — @user"). The DRAWN list holds ~20 historical raffles, so a
// winner is announced ONLY for a raffle whose live→drawn transition we actually
// witnessed — a previously-unseen raffle that's already DRAWN is seeded silently
// (it may just be rotating into the list, not freshly won). First run for a
// guild seeds the whole backlog silently. Mirrors the event watcher.

const RAFFLE_WATCH_INTERVAL = 30 * 60 * 1000; // 30 min — Lucky Shots are time-sensitive
const RAFFLE_SEED_V = 1;
let raffleWatchTimer = null;

// Flags when SEEDING a raffle (firstRun/reseed): everything present is
// pre-existing, so suppress its current state. A READY raffle keeps
// announcedLive:false so its future READY→LIVE transition still announces;
// anything already LIVE/ENDED/DRAWN is suppressed.
function raffleSeedFlags(status) {
  return {
    status,
    announcedLive: status !== 'READY',
    announcedDrawn: status === 'DRAWN',
  };
}

async function runRaffleWatch(guildId, { announce = true } = {}) {
  // Pull the statuses we care about and merge (a raffle appears under one).
  const lists = await Promise.all([getRaffles('READY'), getRaffles('LIVE'), getRaffles('ENDED'), getRaffles('DRAWN')]);
  const byId = new Map();
  for (const list of lists) for (const r of list) if (!byId.has(r.id)) byId.set(r.id, r);
  const raffles = [...byId.values()];
  if (!raffles.length) return { ok: false, total: 0, live: 0, winners: 0, seeded: false };

  const prev = getRaffleWatchState(guildId);
  const seeding = !prev || prev._v !== RAFFLE_SEED_V;

  if (seeding) {
    const state = { _v: RAFFLE_SEED_V };
    for (const raffle of raffles) state[raffle.id] = raffleSeedFlags(raffle.status);
    setRaffleWatchState(guildId, state);
    console.log(`Lucky Shots: seeded ${raffles.length} raffle(s) silently for ${guildId} (v${RAFFLE_SEED_V})`);
    return { ok: true, total: raffles.length, live: 0, winners: 0, seeded: true };
  }

  const state = prev;
  const channelId = getLuckyShotsChannelId(guildId);
  const channel = announce && channelId ? await safeGetChannel(channelId) : null;
  const liveIds = new Set(raffles.map(r => r.id));

  let live = 0;
  let winners = 0;

  for (const raffle of raffles) {
    if (!state[raffle.id]) {
      // Genuinely new since last seed. A new LIVE raffle is freshly live (announce
      // it); anything first seen already DRAWN is seeded silently (it may just be
      // rotating into the historical DRAWN list, not freshly won).
      state[raffle.id] = {
        status: raffle.status,
        announcedLive: raffle.status === 'ENDED' || raffle.status === 'DRAWN',
        announcedDrawn: raffle.status === 'DRAWN',
      };
    }
    const seen = state[raffle.id];

    // Mark announced only on a successful send (see contest watcher note).
    if (raffle.status === 'LIVE' && !seen.announcedLive && channel) {
      try {
        await channel.send(buildRaffleLive(raffle));
        seen.announcedLive = true; live++;
      } catch (e) { console.error(`Lucky Shots: live announce failed for ${raffle.id}:`, e.message); }
    }

    if (raffle.status === 'DRAWN' && !seen.announcedDrawn && channel) {
      try {
        const detail = await getRaffleDetail(raffle.id);
        await channel.send(buildRaffleWinner(raffle, detail?.winner || null));
        seen.announcedDrawn = true; winners++;
      } catch (e) { console.error(`Lucky Shots: winner announce failed for ${raffle.id}:`, e.message); }
    }

    seen.status = raffle.status;
  }

  // Prune raffles that have dropped off the API lists so state doesn't grow forever.
  for (const id of Object.keys(state)) if (id !== '_v' && !liveIds.has(id)) delete state[id];

  setRaffleWatchState(guildId, state);
  if (live || winners) console.log(`Lucky Shots: announced ${live} live, ${winners} winner(s)`);
  return { ok: true, total: raffles.length, live, winners, seeded: false };
}

async function safeRunRaffleWatch() {
  const guildId = process.env.GUILD_ID;
  if (guildId) {
    try {
      await runRaffleWatch(guildId);
    } catch (err) {
      console.error('Lucky Shots: fatal error:', err.message);
    }
  }
  raffleWatchTimer = setTimeout(safeRunRaffleWatch, RAFFLE_WATCH_INTERVAL);
}

// Admin /luckyshots command: `check` runs a watch pass now, `list` posts the
// current raffles publicly to the channel.
async function handleLuckyShotsCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
  }
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply(sub === 'list' ? {} : { flags: ['Ephemeral'] });

  if (sub === 'list') {
    // Only LIVE + upcoming (READY) — never ENDED/DRAWN.
    const raffles = [...new Map((await Promise.all(
      ['READY', 'LIVE'].map(s => getRaffles(s))
    )).flat().map(r => [r.id, r])).values()];
    // For each LIVE raffle, pull its top-3 ticket holders (with chance %).
    const topByRaffle = new Map();
    await Promise.all(raffles.filter(r => r.status === 'LIVE').map(async (r) => {
      topByRaffle.set(r.id, await getRaffleTop(r.id, 3, r.totalTickets));
    }));
    return interaction.editReply(buildRaffleList(raffles, topByRaffle));
  }

  // sub === 'check'
  const r = await runRaffleWatch(interaction.guildId, { announce: true });
  if (!r.ok) {
    return interaction.editReply({ content: '⚠️ Couldn\'t reach the Upshot raffles API just now. If this persists on the Pi, the shield is blocking it — set `UPSHOT_RAFFLE_BASE` to the sniper proxy.' });
  }
  if (r.seeded) {
    return interaction.editReply({ content: `✅ First sync done — seeded **${r.total}** raffle(s) silently. From now on new live Lucky Shots and winners will post to the channel.` });
  }
  const channelSet = !!getLuckyShotsChannelId(interaction.guildId);
  const note = channelSet ? '' : '\n-# ⚠️ No Lucky Shots channel set — run `/setup luckyshots-channel`.';
  return interaction.editReply({ content: `✅ Checked **${r.total}** raffle(s) — announced **${r.live}** live, **${r.winners}** winner(s).${note}` });
}

// ── Store watcher (packs + bundles) ──────────────────────────
//
// Polls Upshot's /packs and /bundles hourly and announces, in the configured
// store channel, when a NEW pack or bundle is LISTED (becomes ACTIVE or
// COMING_SOON) — with price, supply, and remaining stock. Per-guild state in
// bot_state; first run seeds silently. Items are keyed by id with a kind prefix
// so a pack and bundle can never collide.

const STORE_WATCH_INTERVAL = 60 * 60 * 1000; // 60 min
// v2: STORE_VISIBLE now excludes sold-out ACTIVE packs. /packs is paginated, so
// the watcher sees the full back-catalogue (incl. long-sold-out ACTIVE packs
// Upshot never flips to SOLD_OUT); a re-seed silently rebuilds per-guild state so
// those don't get mis-announced as new listings.
const STORE_SEED_V = 2;
let storeWatchTimer = null;

// "Listable" = on sale now WITH stock, or upcoming. A sold-out ACTIVE pack
// (remaining 0 — Upshot leaves these ACTIVE rather than flipping to SOLD_OUT)
// must never be announced. COMING_SOON is always listable: 0 stock there means
// "not on sale yet", not sold out. Mirrors the /store list filter in components.js.
const STORE_VISIBLE = (item) =>
  (item.status === 'ACTIVE' && item.remaining !== 0) || item.status === 'COMING_SOON';

async function getStoreItems() {
  const [packs, bundles] = await Promise.all([getStorePacks(), getStoreBundles()]);
  return [...packs, ...bundles];
}

async function runStoreWatch(guildId, { announce = true } = {}) {
  const items = await getStoreItems();
  if (!items.length) return { ok: false, total: 0, listed: 0, seeded: false };

  const prev = getStoreWatchState(guildId);
  const seeding = !prev || prev._v !== STORE_SEED_V;
  const key = (i) => `${i.kind}:${i.id}`;

  if (seeding) {
    const state = { _v: STORE_SEED_V };
    for (const i of items) state[key(i)] = { status: i.status, announcedListed: true };
    setStoreWatchState(guildId, state);
    console.log(`Store watch: seeded ${items.length} item(s) silently for ${guildId} (v${STORE_SEED_V})`);
    return { ok: true, total: items.length, listed: 0, seeded: true };
  }

  const state = prev;
  const channelId = getStoreChannelId(guildId);
  const channel = announce && channelId ? await safeGetChannel(channelId) : null;
  const liveKeys = new Set(items.map(key));

  let listed = 0;
  for (const item of items) {
    const k = key(item);
    if (!state[k]) state[k] = { status: item.status, announcedListed: false }; // new since last seed
    const seen = state[k];

    // Mark announced only on a successful send (see contest watcher note).
    if (STORE_VISIBLE(item) && !seen.announcedListed && channel) {
      try {
        await channel.send(buildStoreListed(item));
        seen.announcedListed = true; listed++;
      } catch (e) { console.error(`Store watch: listing announce failed for ${k}:`, e.message); }
    }
    seen.status = item.status;
  }

  for (const k of Object.keys(state)) if (k !== '_v' && !liveKeys.has(k)) delete state[k];

  setStoreWatchState(guildId, state);
  if (listed) console.log(`Store watch: announced ${listed} new listing(s)`);
  return { ok: true, total: items.length, listed, seeded: false };
}

async function safeRunStoreWatch() {
  const guildId = process.env.GUILD_ID;
  if (guildId) {
    try {
      await runStoreWatch(guildId);
    } catch (err) {
      console.error('Store watch: fatal error:', err.message);
    }
  }
  storeWatchTimer = setTimeout(safeRunStoreWatch, STORE_WATCH_INTERVAL);
}

// Admin /store command: `check` runs a watch pass now, `list` posts the
// available + upcoming packs/bundles (with remaining stock) publicly.
async function handleStoreCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
  }
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply(sub === 'list' ? {} : { flags: ['Ephemeral'] });

  if (sub === 'list') {
    return interaction.editReply(buildStoreList(await getStoreItems()));
  }

  // sub === 'check'
  const r = await runStoreWatch(interaction.guildId, { announce: true });
  if (!r.ok) {
    return interaction.editReply({ content: '⚠️ Couldn\'t reach the Upshot store API just now — try again in a moment.' });
  }
  if (r.seeded) {
    return interaction.editReply({ content: `✅ First sync done — seeded **${r.total}** store item(s) silently. From now on new packs/bundles will post to the channel.` });
  }
  const channelSet = !!getStoreChannelId(interaction.guildId);
  const note = channelSet ? '' : '\n-# ⚠️ No store channel set — run `/setup store-channel`.';
  return interaction.editReply({ content: `✅ Checked **${r.total}** store item(s) — announced **${r.listed}** new listing(s).${note}` });
}

// ── Tier roles (cumulative top-10 leaderboard tiers) ─────────
//
// Each month a user finishes top 10 they earn one tier. Tiers are cumulative
// and STACK: reaching tier 3 means you hold "Tier 1" + "Tier 2" + "Tier 3".
// The "Tier N" roles are auto-created by name as users first reach them.

const TIER_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // re-check for month rollover every 6h
let tierTimer = null;

function tierRoleName(n) {
  return `Tier ${n}`;
}

// Find the "Tier N" role, creating it if it doesn't exist yet. Returns the role
// or null if creation failed (e.g. missing Manage Roles permission).
async function ensureTierRole(guild, n) {
  const name = tierRoleName(n);
  const existing = guild.roles.cache.find(r => r.name === name);
  if (existing) return existing;
  try {
    return await guild.roles.create({ name, reason: `Auto-created leaderboard tier ${n}`, hoist: false, mentionable: false });
  } catch (err) {
    console.error(`Tiers: failed to create role "${name}":`, err.message);
    return null;
  }
}

// Process one finished month: award a tier to each top-10 finisher and sync
// their stacked tier roles. Idempotent — safe to re-run on the same month.
async function processTiers(guildId, monthKey) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.error(`Tiers: guild ${guildId} not found`);
    return { promoted: [], failed: [], skipped: 0 };
  }
  await guild.roles.fetch().catch(() => {});

  const top = getLeaderboard(monthKey, 10);
  const promoted = [];
  const failed = [];
  let skipped = 0;

  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    const rank = i + 1;

    // Idempotency: only the FIRST time we see this user+month counts toward
    // their tier. Re-running won't inflate anyone's tier.
    const isNew = recordTierAward(entry.author_id, monthKey, rank);
    if (!isNew) { skipped++; continue; }

    const tier = getUserTier(entry.author_id);

    const member = await guild.members.fetch(entry.author_id).catch(() => null);
    if (!member) {
      failed.push({ id: entry.author_id, tier, reason: 'not in server' });
      continue;
    }

    // Stack: ensure the member holds every tier role from 1..tier.
    const toAdd = [];
    let roleError = null;
    for (let t = 1; t <= tier; t++) {
      const role = await ensureTierRole(guild, t);
      if (!role) { roleError = `couldn't create "${tierRoleName(t)}"`; break; }
      if (!member.roles.cache.has(role.id)) toAdd.push(role);
    }
    if (roleError) {
      failed.push({ id: entry.author_id, tier, reason: roleError });
      continue;
    }

    try {
      if (toAdd.length > 0) {
        await member.roles.add(toAdd, `Reached tier ${tier} (top 10 of ${monthKey})`);
      }
      promoted.push({ id: entry.author_id, tier });
    } catch (err) {
      failed.push({ id: entry.author_id, tier, reason: err.message });
    }
  }

  return { promoted, failed, skipped };
}

// Run the rollover for the previous month if it hasn't been processed yet.
// `tiers_last_processed` config holds the last month we acted on. On first ever
// run we set the baseline WITHOUT processing, so the feature never retroactively
// mass-grants months that predate it — the first real run is the next rollover.
async function runTierRollover() {
  const guildId = process.env.GUILD_ID;
  if (!guildId) return;

  const target = previousMonthKey();
  const last = getConfig(guildId, 'tiers_last_processed');

  if (last == null) {
    setConfig(guildId, 'tiers_last_processed', target);
    console.log(`Tiers: baseline set to ${target} (no retroactive processing). Awards begin next month rollover.`);
    return;
  }
  if (last === target || last > target) return; // already processed (or clock skew)

  console.log(`Tiers: processing rollover for ${target}...`);
  const { promoted, failed, skipped } = await processTiers(guildId, target);
  setConfig(guildId, 'tiers_last_processed', target);

  const lines = [`🏅 **Tier rollover for \`${target}\`** — ${promoted.length} promoted${skipped ? `, ${skipped} already counted` : ''}`];
  if (promoted.length) lines.push(promoted.map(p => `• <@${p.id}> → **${tierRoleName(p.tier)}**`).join('\n'));
  if (failed.length) lines.push(`\n**Failed (${failed.length}):**\n${failed.map(f => `• <@${f.id}> — ${f.reason}`).join('\n')}`);
  await notifyAdmin(guildId, lines.join('\n'));
}

async function safeRunTierRollover() {
  try {
    await runTierRollover();
  } catch (err) {
    console.error('Tiers: rollover failed:', err);
    const guildId = process.env.GUILD_ID;
    if (guildId) await notifyAdmin(guildId, `❌ **Tier rollover crashed:** ${err.message}`).catch(() => {});
  }
  tierTimer = setTimeout(safeRunTierRollover, TIER_CHECK_INTERVAL);
}

// ── Admin panel (/admin) ─────────────────────────────────────
// A single overview + quick-access surface. The slash commands all still work;
// this is purely additive. Every setting reads/writes through the same getters
// and setConfig the /setup subcommands use, so the two stay in sync.

function gatherAdminCfg(guildId) {
  const token = getUpshotToken(guildId);
  let expiresInMin = null;
  if (token) {
    const p = decodeJwtPayload(token);
    if (p?.exp) expiresInMin = Math.round((p.exp * 1000 - Date.now()) / 60000);
  }
  return {
    channels: {
      predictions: getPredictionsChannelId(guildId),
      admin: getAdminChannelId(guildId),
      leaderboard: getLeaderboardChannelId(guildId),
      contests: getContestsChannelId(guildId),
      luckyshots: getLuckyShotsChannelId(guildId),
      store: getStoreChannelId(guildId),
    },
    adminRole: getAdminRoleId(guildId),
    ownerId: getOwnerId(guildId),
    maxDaily: getMaxDaily(guildId),
    maxOpen: getMaxOpen(guildId),
    categories: getCategoryList(guildId),
    token: { set: !!token, expiresInMin },
  };
}

async function handleAdminPanel(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
  }
  return interaction.reply(buildAdminPanel(gatherAdminCfg(interaction.guildId)));
}

// "⚙️ Change a setting…" select → route to the right input for that setting.
async function handleAdminConfigure(interaction) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
  const setting = ADMIN_SETTINGS_LIST.find(s => s.key === interaction.values?.[0]);
  if (!setting) return interaction.update(buildAdminPanel(gatherAdminCfg(interaction.guildId)));

  if (setting.kind === 'channel') return interaction.update(buildAdminPickChannel(setting));
  if (setting.kind === 'role') return interaction.update(buildAdminPickRole());
  if (setting.kind === 'owner') {
    setConfig(interaction.guildId, 'owner_id', interaction.user.id);
    return interaction.update(buildAdminPanel(gatherAdminCfg(interaction.guildId)));
  }
  if (setting.kind === 'int') {
    const current = setting.key === 'max_daily' ? getMaxDaily(interaction.guildId) : getMaxOpen(interaction.guildId);
    const modal = new ModalBuilder().setCustomId(`admin_limit:${setting.key}`).setTitle(setting.label);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('value').setLabel(setting.label)
        .setPlaceholder(String(current)).setValue(String(current))
        .setStyle(TextInputStyle.Short).setMaxLength(3).setRequired(true)));
    return interaction.showModal(modal);
  }
  if (setting.kind === 'token') {
    const modal = new ModalBuilder().setCustomId('admin_token').setTitle('Set Upshot Token');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('token').setLabel('Bearer token or upshot-token.json')
        .setPlaceholder('Paste the raw token, OR the whole upshot-token.json')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true)));
    return interaction.showModal(modal);
  }
}

async function handleAdminSetChannel(interaction) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
  const key = interaction.customId.split(':')[1];
  const channelId = interaction.values?.[0];
  if (key && channelId) setConfig(interaction.guildId, key, channelId);
  return interaction.update(buildAdminPanel(gatherAdminCfg(interaction.guildId)));
}

async function handleAdminSetRole(interaction) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
  const roleId = interaction.values?.[0];
  if (roleId) setConfig(interaction.guildId, 'admin_role', roleId);
  return interaction.update(buildAdminPanel(gatherAdminCfg(interaction.guildId)));
}

async function handleAdminLimitModal(interaction) {
  const key = interaction.customId.split(':')[1];
  const max = key === 'max_daily' ? 20 : 50;
  const val = parseInt(interaction.fields.getTextInputValue('value'), 10);
  if (!Number.isInteger(val) || val < 1 || val > max) {
    return interaction.reply({ content: `❌ Enter a whole number between 1 and ${max}.`, flags: ['Ephemeral'] });
  }
  setConfig(interaction.guildId, key, val);
  return interaction.update(buildAdminPanel(gatherAdminCfg(interaction.guildId)));
}

async function handleAdminTokenModal(interaction) {
  const token = extractTokenFromInput(interaction.fields.getTextInputValue('token'));
  if (!token) return interaction.reply({ content: '❌ Couldn\'t find a token in that input.', flags: ['Ephemeral'] });
  const payload = decodeJwtPayload(token);
  if (payload?.exp && payload.exp * 1000 <= Date.now()) {
    return interaction.reply({ content: '❌ That token has already expired — grab a fresh one.', flags: ['Ephemeral'] });
  }
  setConfig(interaction.guildId, 'upshot_token', token);
  return interaction.update(buildAdminPanel(gatherAdminCfg(interaction.guildId)));
}

// Action buttons run the work in a SEPARATE ephemeral reply so the panel stays.
async function handleAdminAction(interaction, action) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '❌ Admins only.', flags: ['Ephemeral'] });
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const gid = interaction.guildId;
  try {
    if (action === 'refresh_lb') {
      await refreshLeaderboard(gid);
      return interaction.editReply({ content: '✅ Leaderboard refreshed.' });
    }
    if (action === 'resolve') {
      runAutoResolve().catch(e => console.error('Admin resolve:', e.message));
      return interaction.editReply({ content: '✅ Resolution check started — results post to the admin channel.' });
    }
    const watch = action === 'contests' ? runContestWatch
      : action === 'luckyshots' ? runRaffleWatch
      : action === 'store' ? runStoreWatch : null;
    if (!watch) return interaction.editReply({ content: '❌ Unknown action.' });
    const r = await watch(gid, { announce: true });
    if (!r.ok) return interaction.editReply({ content: '⚠️ Couldn\'t reach the Upshot API just now — try again in a moment.' });
    if (r.seeded) return interaction.editReply({ content: `✅ First sync — seeded **${r.total}** silently. Future changes will announce.` });
    const n = r.newLive ?? r.live ?? r.listed ?? 0;
    const extra = r.done ? `, ${r.done} completed` : r.winners ? `, ${r.winners} winner(s)` : '';
    return interaction.editReply({ content: `✅ Checked **${r.total}** — announced **${n}** new${extra}.` });
  } catch (err) {
    return interaction.editReply({ content: `❌ Action failed: ${err.message}` });
  }
}

// ── Event routing ────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (await tryHandleReferralInteraction(interaction)) return;

    if (interaction.isAutocomplete?.()) {
      if (interaction.commandName === 'sendpack') return await handleSendPackAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'predict': return await handleCardPicker(interaction);
        case 'panel': return await handlePanel(interaction);
        case 'edit-panel': return await handleEditPanel(interaction);
        case 'link-upshot': return await handleLinkUpshot(interaction);
        case 'mystats': return await handleMyStats(interaction);
        case 'cancel-prediction': return await handleCancelPrediction(interaction);
        case 'upshotrank': return await handleUpshotRank(interaction);
        case 'pastleaderboard': return await handlePastLeaderboard(interaction);
        case 'mycontests': return await handleMyContests(interaction);
        case 'contests': return await handleContestsCommand(interaction);
        case 'luckyshots': return await handleLuckyShotsCommand(interaction);
        case 'store': return await handleStoreCommand(interaction);
        case 'admin': return await handleAdminPanel(interaction);
        case 'refresh': return await handleRefreshCommand(interaction);
        case 'resolve': return await handleResolveCommand(interaction);
        case 'leaderboard': return await handleLeaderboardCommand(interaction);
        case 'setup': return await handleSetup(interaction);
        case 'sendpack': return await handleSendPack(interaction);
        case 'process-tiers': return await handleProcessTiers(interaction);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'link_profile_modal') {
        return await handleLinkProfileModalSubmit(interaction);
      }
      if (interaction.customId === 'mycards_search_modal') {
        return await handleMyCardSearchSubmit(interaction);
      }
      if (interaction.customId === 'predict_url_modal') {
        return await handlePredictUrlModalSubmit(interaction);
      }
      if (interaction.customId === 'predict_modal') {
        return await handlePredictModalSubmit(interaction);
      }
      if (interaction.customId.startsWith('edit_modal:')) {
        return await handleEditModalSubmit(interaction);
      }
      if (interaction.customId.startsWith('stars_modal:')) {
        return await handleStarsModalSubmit(interaction);
      }
      if (interaction.customId.startsWith('admin_limit:')) {
        return await handleAdminLimitModal(interaction);
      }
      if (interaction.customId === 'admin_token') {
        return await handleAdminTokenModal(interaction);
      }
    }

    if (interaction.isButton()) {
      return await handleButton(interaction);
    }

    if (interaction.isStringSelectMenu?.()) {
      // My Cards select opens the card detail view first; the contest-lineup
      // select goes straight to the prediction modal. Both carry a card id in
      // interaction.values[0] and the name in the option label.
      if (interaction.customId === 'predict_card_select') {
        return await handleMyCardSelect(interaction);
      }
      if (interaction.customId === 'contest_predict_select') {
        return await handleCardSelect(interaction);
      }
      if (interaction.customId === 'admin_configure') {
        return await handleAdminConfigure(interaction);
      }
      if (interaction.customId === 'cancel_pred_select') {
        return await handleCancelSelect(interaction);
      }
    }

    if (interaction.isChannelSelectMenu?.()) {
      if (interaction.customId.startsWith('admin_setchan:')) {
        return await handleAdminSetChannel(interaction);
      }
    }

    if (interaction.isRoleSelectMenu?.()) {
      if (interaction.customId === 'admin_setrole') {
        return await handleAdminSetRole(interaction);
      }
      if (interaction.customId.startsWith('leaderboard_role_select:')) {
        const monthKey = interaction.customId.slice('leaderboard_role_select:'.length);
        return await handleLeaderboardGrantRole(interaction, monthKey);
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);
    const reply = { content: '❌ Something went wrong. Please try again.', flags: ['Ephemeral'] };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch { /* can't reply — interaction may have timed out */ }

    // Notify admin channel of errors
    if (interaction.guildId) {
      const cmd = interaction.commandName || interaction.customId || 'unknown';
      notifyAdmin(interaction.guildId, `⚠️ **Interaction error** (\`${cmd}\`): ${error.message}`).catch(() => {});
    }
  }
});

// ── Startup ──────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Auto-register slash commands on every startup
  try {
    const body = commands.map(c => c.toJSON());
    if (process.env.GUILD_ID) {
      await client.rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
        { body },
      );
    } else {
      await client.rest.put(
        Routes.applicationCommands(client.user.id),
        { body },
      );
    }
    console.log(`   Registered ${commands.length} slash commands`);
  } catch (err) {
    console.error('   Failed to register commands:', err.message);
  }

  console.log(`   Use /setup to configure channels, admin role, and limits`);

  // Re-render tracked prediction panels so layout/copy changes propagate to
  // already-posted panels without an admin having to re-post them.
  for (const [guildId] of client.guilds.cache) {
    await refreshPanels(guildId).catch(e => console.error('Panel refresh failed:', e.message));
  }

  // Start auto-resolve timer (first run after 1 minute to let bot settle)
  setTimeout(safeRunAutoResolve, 60_000);
  nextResolveCheck = new Date(Date.now() + 60_000);
  console.log(`   Auto-resolve: first check in 1 minute, then every 12h`);

  // Start tier rollover timer (first run after 2 minutes, then every 6h).
  tierTimer = setTimeout(safeRunTierRollover, 120_000);
  console.log(`   Tier rollover: first check in 2 minutes, then every 6h`);

  // Start the contest watcher (first run after 90s, then every 60 min).
  // The first run seeds the existing contest backlog silently.
  contestWatchTimer = setTimeout(safeRunContestWatch, 90_000);
  console.log(`   Contest watch: first check in 90s, then every 60min`);

  // Start the Lucky Shots (raffle) watcher (first run after 2 min, then 30 min).
  raffleWatchTimer = setTimeout(safeRunRaffleWatch, 120_000);
  console.log(`   Lucky Shots watch: first check in 2 min, then every 30min`);

  // Start the store watcher (first run after 2.5 min, then every 60 min).
  storeWatchTimer = setTimeout(safeRunStoreWatch, 150_000);
  console.log(`   Store watch: first check in 2.5 min, then every 60min`);

  // Keep the Upshot token fresh hands-off: the access token lives ~15h and the
  // refresh token is a rotating 7-day sliding window, so a check every 6h keeps
  // both alive indefinitely with no browser/login (no-op unless near expiry).
  if (upshotTokenFilePath() && readUpshotRefreshToken()) {
    setTimeout(() => { maybeRefreshUpshotToken().catch(() => {}); }, 30_000);
    setInterval(() => { maybeRefreshUpshotToken().catch(() => {}); }, 6 * 60 * 60 * 1000);
    console.log(`   Upshot token: auto-refresh armed (first check in 30s, then every 6h)`);
  }
});

// ── Global error handling → admin channel ────────────────────

process.on('unhandledRejection', async (err) => {
  console.error('Unhandled rejection:', err);
  const guildId = process.env.GUILD_ID;
  if (guildId) {
    await notifyAdmin(guildId, `❌ **Unhandled error:** ${err?.message || err}`).catch(() => {});
  }
});

// Clean shutdown
process.on('SIGTERM', () => {
  if (resolveTimer) clearTimeout(resolveTimer);
  if (tierTimer) clearTimeout(tierTimer);
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  if (resolveTimer) clearTimeout(resolveTimer);
  if (tierTimer) clearTimeout(tierTimer);
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
