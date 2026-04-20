import {
  Client, GatewayIntentBits, Events, Routes, AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import 'dotenv/config';

import {
  linkUpshot, getUpshotProfile,
  createPrediction, getPrediction, updatePrediction, deletePrediction,
  countUserDailyPredictions, getUserStats, getLeaderboard,
  getLeaderboardMessageId, setLeaderboardMessageId,
  getConfig, setConfig, getAllConfig,
  getCategories, addCategory, removeCategory,
  resetUser, resetAllUsers, deleteLastPrediction,
  deleteUserProfile, deleteAllProfiles,
  countUserUnresolved, getUserOpenPredictions, hasUnresolvedPredictionForCard,
  getUnresolvedRatedPredictions, getResolvedCount, getUnresolvedCount,
  getProfileByWallet, getProfileByUrl, getAllUsers, getDbPath,
  upsertCommunityVote, getCommunityVoteSummary,
  getPendingVerificationPredictions, getUnratedVerifiedPredictions,
} from './database.js';

import { rateWithAI } from './nim.js';

import {
  buildPredictionCard, buildAdminCard,
  buildLeaderboard, buildStatsCard, buildDeleteConfirm,
  buildPredictionPanel, buildHelpPage,
  buildContestOverview, buildContestLineupPage,
} from './components.js';

import { commands } from './commands.js';

import {
  Status, DefaultCategories, starPoints, totalPoints, weightedStarRating,
} from './constants.js';

import {
  extractWallet, extractCardId,
  getCardDetails, checkCardOwnership, checkCardResolution,
  getSeasonRank, getUserContestLineups,
} from './api.js';

// ── Client ──────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
  rest: {
    timeout: 30_000, // 30s REST timeout (default is 15s, too short for Pi with large attachments)
  },
});

// ── Config resolver (DB first, .env fallback) ───────────────

function cfg(guildId, key, fallbackEnv) {
  return getConfig(guildId, key) ?? process.env[fallbackEnv] ?? null;
}

function getPredictionsChannelId(guildId) {
  return cfg(guildId, 'predictions_channel', 'PREDICTIONS_CHANNEL_ID');
}

function getAdminChannelId(guildId) {
  return cfg(guildId, 'admin_channel', 'ADMIN_REVIEW_CHANNEL_ID');
}

function getLeaderboardChannelId(guildId) {
  return cfg(guildId, 'leaderboard_channel', 'LEADERBOARD_CHANNEL_ID');
}

function getAdminRoleId(guildId) {
  return cfg(guildId, 'admin_role', 'ADMIN_ROLE_ID');
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

/**
 * Central point calculation. Uses weighted star rating (admin 70% + community 30%).
 * Call after any change to stars, outcome, or community votes.
 * Returns the updated prediction.
 */
function recalculatePoints(predictionId) {
  const prediction = getPrediction(predictionId);
  if (!prediction || !prediction.star_rating) return prediction;

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
        }
      }
    }
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
        console.error('Failed to edit leaderboard:', err.message);
        // Clear stale reference so we create a fresh one below
        setLeaderboardMessageId(guildId, '');
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
async function showPredictModal(interaction) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile) {
    // Show profile-link modal first — prediction modal follows after submit
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

  // Store guild context for modal submit
  setPendingSubmission(interaction.user.id, {
    guildId: interaction.guildId,
  });

  const modal = new ModalBuilder()
    .setCustomId('predict_modal')
    .setTitle('Submit a Prediction');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title')
        .setPlaceholder('e.g. BTC breaks $100K before April 2026')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description')
        .setPlaceholder('Your thesis, data, charts, evidence...')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(2000)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('card_url')
        .setLabel('Card URL or ID')
        .setPlaceholder('https://upshot.cards/card-detail/cm... or cm...')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(280)
        .setRequired(true)
    ),
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

async function handleMyStats(interaction) {
  const stats = getUserStats(interaction.user.id, currentMonthKey());
  const payload = buildStatsCard(stats, interaction.user.id, currentMonthLabel());
  await interaction.reply({ ...payload, flags: (1 << 15) | (1 << 6) });
}

async function handleUpshotRank(interaction) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile?.wallet_address) {
    return interaction.reply({
      content: '❌ Link your Upshot profile first with `/link-upshot` or click "Make a Prediction".',
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

  const entries = getLeaderboard(monthInput);
  const [yyyy, mm] = monthInput.split('-');
  const label = new Date(parseInt(yyyy), parseInt(mm) - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const payload = buildLeaderboard(entries, label);
  await interaction.reply({ ...payload, flags: (1 << 15) | (1 << 6) });
}

// Cache contest data per user for navigation (cleared after 10 min)
const contestCache = new Map();

async function handleMyContests(interaction) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile?.wallet_address) {
    return interaction.reply({
      content: '❌ Link your Upshot profile first with `/link-upshot` or click "Make a Prediction".',
      flags: ['Ephemeral'],
    });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const contests = await getUserContestLineups(profile.wallet_address);
  if (contests.length === 0) {
    return interaction.editReply({ content: 'You\'re not entered in any active contests.' });
  }

  // Cache for navigation
  contestCache.set(interaction.user.id, contests);
  setTimeout(() => contestCache.delete(interaction.user.id), 10 * 60 * 1000);

  const payload = buildContestOverview(contests);
  await interaction.editReply(payload);
}

async function handlePanel(interaction) {
  const title = interaction.options.getString('title', true);
  const description = interaction.options.getString('description', true);
  const imageAtt = interaction.options.getAttachment('image');
  const imageUrl = imageAtt?.contentType?.startsWith('image/') ? imageAtt.url : null;

  const payload = buildPredictionPanel(title, description, imageUrl);
  await interaction.channel.send(payload);
  await interaction.reply({ content: '✅ Panel posted!', flags: ['Ephemeral'] });
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
  if (!prediction.star_rating) {
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

  const id = interaction.options.getInteger('id');
  const prediction = getPrediction(id);
  if (!prediction) {
    return interaction.reply({ content: `❌ Prediction #${id} not found.`, flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });
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
    case 'admin-role': {
      const role = interaction.options.getRole('role', true);
      setConfig(guildId, 'admin_role', role.id);
      return interaction.reply({ content: `✅ Admin role set to <@&${role.id}>`, flags: ['Ephemeral'] });
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
    case 'user-info': {
      const user = interaction.options.getUser('user', true);
      const profile = getUpshotProfile(user.id);
      const stats = getUserStats(user.id, currentMonthKey());
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

      const messageChunks = chunkLines([
        ...summaryLines,
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
    if (!p || p.star_rating) return;
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

async function handleAutoRateAll(interaction, guildId) {
  const preds = getUnratedVerifiedPredictions();
  if (preds.length === 0) {
    return interaction.reply({ content: '✅ No verified predictions waiting for a star rating.', flags: ['Ephemeral'] });
  }

  if (!process.env.NVIDIA_NIM_API_KEY) {
    return interaction.reply({ content: '❌ `NVIDIA_NIM_API_KEY` is not set in .env.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const suggestions = [];
  const failures = [];

  for (const p of preds) {
    try {
      const ctx = await gatherRatingContext(p);
      const result = await rateWithAI(ctx);
      suggestions.push({ id: p.id, stars: result.stars, reason: result.reason, title: p.title });
      // Light throttle to be kind to free-tier rate limits
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      failures.push(`${formatId(p.id)} — ${err.message.slice(0, 120)}`);
    }
  }

  if (suggestions.length === 0) {
    let content = `❌ All ${preds.length} AI calls failed.\n${failures.join('\n')}`;
    if (content.length > 1900) content = content.slice(0, 1870) + '\n... *(truncated)*';
    return interaction.editReply({ content });
  }

  const batchId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  pendingRatingBatches.set(batchId, { suggestions, guildId, adminId: interaction.user.id, createdAt: Date.now() });

  const header = `**AI rating suggestions** (${suggestions.length} predictions, model: \`z-ai/glm4.7\`)`;
  const body = suggestions.map(s => {
    const stars = '⭐'.repeat(s.stars) + '☆'.repeat(3 - s.stars);
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

async function handleAcceptRatings(interaction, batchId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const batch = pendingRatingBatches.get(batchId);
  if (!batch) {
    return interaction.update({ content: '❌ Batch expired or already applied.', components: [] });
  }
  pendingRatingBatches.delete(batchId);

  await interaction.update({ content: `⏳ Applying ${batch.suggestions.length} ratings...`, components: [] });

  let applied = 0;
  const skipped = [];
  for (const s of batch.suggestions) {
    const current = getPrediction(s.id);
    if (!current) { skipped.push(`${formatId(s.id)} (deleted)`); continue; }
    if (current.star_rating) { skipped.push(`${formatId(s.id)} (already rated)`); continue; }
    if (!current.ownership_verified) { skipped.push(`${formatId(s.id)} (no longer verified)`); continue; }
    await applyStarRating(s.id, s.stars, batch.adminId, batch.guildId);
    applied++;
  }

  const lines = [
    `✅ Applied **${applied}** AI star rating${applied === 1 ? '' : 's'}`,
  ];
  if (skipped.length) lines.push(`⏭️ Skipped **${skipped.length}**: ${skipped.join(', ')}`);
  return interaction.editReply({ content: lines.join('\n'), components: [] });
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
    content: `✅ Profile linked! Wallet: \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`\n\nNow use \`/predict\` or click the Predict button to submit your first prediction.`,
    flags: ['Ephemeral'],
  });
}

async function handlePredictModalSubmit(interaction) {
  // Retrieve guild context stored during /predict command or panel button
  const pending = pendingSubmissions.get(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: '❌ Submission expired. Please run `/predict` again or click the Predict button.',
      flags: ['Ephemeral'],
    });
  }
  pendingSubmissions.delete(interaction.user.id);

  const title = interaction.fields.getTextInputValue('title');
  const description = interaction.fields.getTextInputValue('description');
  const rawCardUrl = interaction.fields.getTextInputValue('card_url')?.trim() || null;
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

  // Validate card URL/ID format before hitting API
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
  const cardId = rawCardUrl ? extractCardId(rawCardUrl) : null;
  let cardImage = null;
  let ownershipCheck = null;
  let deadlineFormatted = null;

  if (cardId) {
    let cardDetails = null;
    try {
      cardDetails = await getCardDetails(cardId);
      if (cardDetails?.arweaveUrl) {
        cardImage = cardDetails.arweaveUrl;
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
      const isSelf = existing.author_id === interaction.user.id;
      const msg = isSelf
        ? '❌ You already have an open prediction for this card. Wait for it to resolve first.'
        : '❌ Someone else already has an open prediction for this card.';
      return interaction.editReply({ content: msg });
    }
  }

  // Fallback deadline if API didn't return one
  if (!deadlineFormatted) {
    deadlineFormatted = 'TBD';
  }

  const proofType = tweetUrl ? 'tweet' : 'none';

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

  if (![1, 2, 3].includes(stars)) {
    return interaction.reply({ content: '❌ Stars must be 1, 2, or 3.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.reply({ content: '❌ Prediction not found.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const updated = await applyStarRating(predictionId, stars, interaction.user.id, interaction.guildId);

  await interaction.editReply({
    content: `⭐ Rated **#${String(predictionId).padStart(4, '0')}** — ${stars} star${stars > 1 ? 's' : ''} (${updated.total_points} pts)`,
    flags: ['Ephemeral'],
  });
}

// ── Button handlers ─────────────────────────────────────────

async function handleButton(interaction) {
  // Panel predict button
  if (interaction.customId === 'panel_predict') {
    return showPredictModal(interaction);
  }

  // Help page buttons (panel_help:0, panel_help:1, etc.)
  if (interaction.customId.startsWith('panel_help:')) {
    const page = parseInt(interaction.customId.split(':')[1], 10);
    const payload = buildHelpPage(page);
    if (interaction.message.flags.has(1 << 6)) {
      return interaction.update(payload);
    }
    return interaction.reply(payload);
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
        .setLabel('Stars (1, 2, or 3)')
        .setPlaceholder('1, 2, or 3')
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
  if (prediction.star_rating) {
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

  if (!prediction.star_rating) {
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

async function handleConfirmDelete(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.reply({ content: '❌ Already deleted.', flags: ['Ephemeral'] });
  }

  // Delete public embed
  if (prediction.embed_message_id) {
    const channelId = getPredictionsChannelId(interaction.guildId);
    if (channelId) {
      const channel = await safeGetChannel(channelId);
      if (channel) {
        const msg = await safeGetMessage(channel, prediction.embed_message_id);
        if (msg) { try { await msg.delete(); } catch { /* ok */ } }
      }
    }
  }

  // Delete admin embed
  if (prediction.admin_message_id) {
    const channelId = getAdminChannelId(interaction.guildId);
    if (channelId) {
      const channel = await safeGetChannel(channelId);
      if (channel) {
        const msg = await safeGetMessage(channel, prediction.admin_message_id);
        if (msg) { try { await msg.delete(); } catch { /* ok */ } }
      }
    }
  }

  deletePrediction(predictionId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});

  await interaction.reply({
    content: `🗑 Prediction **#${String(predictionId).padStart(4, '0')}** deleted.`,
    flags: ['Ephemeral'],
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
  let errors = 0;

  for (const prediction of predictions) {
    try {
      const result = await checkCardResolution(prediction.card_id);

      if (result.error) {
        errors++;
        console.error(`Auto-resolve: Error checking #${prediction.id}:`, result.error);
        continue;
      }

      if (!result.resolved) continue; // still active, skip

      const outcome = result.won ? 'hit' : 'fail';
      const status = outcome === 'hit' ? Status.Hit : Status.Fail;

      updatePrediction(prediction.id, { outcome, status, resolved_by: 'auto' });
      recalculatePoints(prediction.id);

      await syncPredictionEmbeds(prediction.id, guildId);
      resolved++;

      const updatedPred = getPrediction(prediction.id);
      const emoji = outcome === 'hit' ? '🟢' : '🔴';
      const id = String(prediction.id).padStart(4, '0');
      await notifyAdmin(guildId,
        `${emoji} **Auto-resolved #${id}** — **${outcome}** (${updatedPred.total_points} pts) · <@${prediction.author_id}>`
      );
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

  const summary = `🤖 **Auto-resolve complete** — ${resolved} resolved, ${errors} error(s), ${predictions.length - resolved - errors} still active`;
  console.log(`Auto-resolve: ${resolved} resolved, ${errors} errors`);
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

// ── Event routing ────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'predict': return await showPredictModal(interaction);
        case 'panel': return await handlePanel(interaction);
        case 'link-upshot': return await handleLinkUpshot(interaction);
        case 'mystats': return await handleMyStats(interaction);
        case 'upshotrank': return await handleUpshotRank(interaction);
        case 'pastleaderboard': return await handlePastLeaderboard(interaction);
        case 'mycontests': return await handleMyContests(interaction);
        case 'refresh': return await handleRefreshCommand(interaction);
        case 'resolve': return await handleResolveCommand(interaction);
        case 'leaderboard': return await handleLeaderboardCommand(interaction);
        case 'setup': return await handleSetup(interaction);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'link_profile_modal') {
        return await handleLinkProfileModalSubmit(interaction);
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
    }

    if (interaction.isButton()) {
      return await handleButton(interaction);
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

  // Start auto-resolve timer (first run after 1 minute to let bot settle)
  setTimeout(safeRunAutoResolve, 60_000);
  nextResolveCheck = new Date(Date.now() + 60_000);
  console.log(`   Auto-resolve: first check in 1 minute, then every 12h`);
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
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  if (resolveTimer) clearTimeout(resolveTimer);
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
