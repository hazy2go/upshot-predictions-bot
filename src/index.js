import {
  Client, GatewayIntentBits, Events, Routes,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import 'dotenv/config';

import {
  linkUpshot, getUpshotProfile,
  createPrediction, getPrediction, updatePrediction, deletePrediction,
  countUserDailyPredictions, getUserStats, getLeaderboard,
  getLeaderboardMessageId, setLeaderboardMessageId,
  getAwaitingImagePredictions,
  getConfig, setConfig, getAllConfig,
} from './database.js';

import {
  buildPredictionCard, buildAdminCard,
  buildLeaderboard, buildStatsCard, buildDeleteConfirm,
} from './components.js';

import { downloadAndSave, getAttachmentBuilders } from './images.js';
import { commands } from './commands.js';

import {
  Status, Categories, starPoints, totalPoints,
} from './constants.js';

// ── Client ──────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const IMAGE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// In-memory tracker for pending image uploads.
// On restart, the bot checks DB for stale entries (see ClientReady handler).
// Map<userId, { predictionId, channelId, guildId, timeout }>
const pendingImageUploads = new Map();

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

// ── Helpers ──────────────────────────────────────────────────

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function currentMonthLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
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
// Public prediction cards (in #predictions) have NO image attachments.
// They use text-only proof indicators. This means edits are simple —
// just update the components, no files to manage.
//
// Admin cards (in #admin-review) DO include image attachments via
// attachment:// protocol. On every edit, we re-attach images from disk
// so the MediaGallery URLs remain valid regardless of how old the message is.

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

  const files = prediction.images?.length > 0
    ? getAttachmentBuilders(prediction.id, prediction.images)
    : [];

  try {
    const msg = await channel.send({ ...payload, files });
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

  // Update public embed (no files — text only)
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

  // Update admin embed (re-attach images from disk every time)
  if (prediction.admin_message_id) {
    const channelId = getAdminChannelId(guildId);
    if (channelId) {
      const channel = await safeGetChannel(channelId);
      if (channel) {
        const msg = await safeGetMessage(channel, prediction.admin_message_id);
        if (msg) {
          try {
            const payload = buildAdminCard(prediction, profile?.upshot_url);
            const files = prediction.images?.length > 0
              ? getAttachmentBuilders(prediction.id, prediction.images)
              : [];
            await msg.edit({ ...payload, files });
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

async function handlePredict(interaction) {
  const profile = getUpshotProfile(interaction.user.id);
  if (!profile) {
    return interaction.reply({
      content: '❌ You must link your Upshot profile first.\nRun `/link-upshot` with your profile URL.',
      flags: ['Ephemeral'],
    });
  }

  const maxDaily = getMaxDaily(interaction.guildId);
  const todayCount = countUserDailyPredictions(interaction.user.id);
  if (todayCount >= maxDaily) {
    return interaction.reply({
      content: `❌ You've reached the daily limit of **${maxDaily}** predictions. Try again tomorrow.`,
      flags: ['Ephemeral'],
    });
  }

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
        .setCustomId('category')
        .setLabel('Category')
        .setPlaceholder(Categories.join(' / '))
        .setStyle(TextInputStyle.Short)
        .setMaxLength(20)
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
        .setCustomId('deadline')
        .setLabel('Deadline (DD/MM/YYYY)')
        .setPlaceholder('01/06/2026')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(10)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('tweet_url')
        .setLabel('Tweet link (optional)')
        .setPlaceholder('https://x.com/you/status/...')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
    ),
  );

  await interaction.showModal(modal);
}

async function handleLinkUpshot(interaction) {
  const url = interaction.options.getString('url', true).trim();

  if (!url.startsWith('https://') || !url.includes('upshot')) {
    return interaction.reply({
      content: '❌ Invalid Upshot profile URL. Expected format: `https://upshot.xyz/user/yourname`',
      flags: ['Ephemeral'],
    });
  }

  linkUpshot(interaction.user.id, url);

  await interaction.reply({
    content: `✅ Upshot profile linked!\n🔗 ${url}\n\nYou can now submit predictions with \`/predict\`.`,
    flags: ['Ephemeral'],
  });
}

async function handleMyStats(interaction) {
  const stats = getUserStats(interaction.user.id, currentMonthKey());
  const payload = buildStatsCard(stats, interaction.user.id, currentMonthLabel());
  await interaction.reply({ ...payload, flags: ['Ephemeral'] });
}

async function handleLeaderboardCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });
  await refreshLeaderboard(interaction.guildId);
  await interaction.editReply({ content: '✅ Leaderboard refreshed.' });
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
    case 'view': {
      const cfg = getAllConfig(guildId);
      const lines = [
        '**Current Configuration**',
        '',
        `**Predictions channel:** ${cfg.predictions_channel ? `<#${cfg.predictions_channel}>` : '`not set (using .env)`'}`,
        `**Admin review channel:** ${cfg.admin_channel ? `<#${cfg.admin_channel}>` : '`not set (using .env)`'}`,
        `**Leaderboard channel:** ${cfg.leaderboard_channel ? `<#${cfg.leaderboard_channel}>` : '`not set (using .env)`'}`,
        `**Admin role:** ${cfg.admin_role ? `<@&${cfg.admin_role}>` : '`not set (using .env)`'}`,
        `**Max daily predictions:** ${cfg.max_daily || '`not set (default: 3)`'}`,
      ];
      return interaction.reply({ content: lines.join('\n'), flags: ['Ephemeral'] });
    }
  }
}

// ── Modal submits ───────────────────────────────────────────

async function handlePredictModalSubmit(interaction) {
  const title = interaction.fields.getTextInputValue('title');
  const category = interaction.fields.getTextInputValue('category').trim();
  const description = interaction.fields.getTextInputValue('description');
  const deadline = interaction.fields.getTextInputValue('deadline');
  const tweetUrl = interaction.fields.getTextInputValue('tweet_url')?.trim() || null;

  // Validate category
  const matchedCategory = Categories.find(c => c.toLowerCase() === category.toLowerCase());
  if (!matchedCategory) {
    return interaction.reply({
      content: `❌ Invalid category. Must be one of: ${Categories.join(', ')}`,
      flags: ['Ephemeral'],
    });
  }

  // Validate deadline format
  const deadlineMatch = deadline.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!deadlineMatch) {
    return interaction.reply({
      content: '❌ Invalid deadline format. Use DD/MM/YYYY.',
      flags: ['Ephemeral'],
    });
  }

  const [, dd, mm, yyyy] = deadlineMatch;
  const deadlineFormatted = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;

  const proofType = tweetUrl ? 'tweet' : 'images';

  // Create prediction in DB (status = Status.AwaitingImages if no tweet, else 'pending_verification')
  const initialStatus = tweetUrl ? Status.PendingVerification : Status.AwaitingImages;
  const prediction = createPrediction({
    authorId: interaction.user.id,
    title,
    category: matchedCategory,
    description,
    deadline: deadlineFormatted,
    proofType,
    tweetUrl,
    images: [],
    status: initialStatus,
  });

  if (tweetUrl) {
    // Tweet proof — post immediately
    await interaction.reply({
      content: `✅ Prediction **#${String(prediction.id).padStart(4, '0')}** submitted with tweet proof!\nIt's now in the review queue.`,
      flags: ['Ephemeral'],
    });
    await postPredictionToFeed(prediction, interaction.guildId);
    await postToAdminReview(prediction, interaction.guildId);
    await refreshLeaderboard(interaction.guildId).catch(() => {});
  } else {
    // Image proof — prompt for upload
    await interaction.reply({
      content: [
        `✅ Prediction **#${String(prediction.id).padStart(4, '0')}** saved!`,
        '',
        '📸 **Now upload your card images** as proof of ownership.',
        'Send a message in this channel with your card screenshots attached.',
        `You have **5 minutes**. After that, the prediction will be posted without images.`,
      ].join('\n'),
      flags: ['Ephemeral'],
    });

    // Track pending upload — survives via DB Status.AwaitingImages status on restart
    const timeout = setTimeout(() => finalizePendingUpload(interaction.user.id), IMAGE_UPLOAD_TIMEOUT_MS);
    pendingImageUploads.set(interaction.user.id, {
      predictionId: prediction.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      timeout,
    });
  }
}

/**
 * Called when the image upload window expires.
 * Posts the prediction without images.
 */
async function finalizePendingUpload(userId) {
  const pending = pendingImageUploads.get(userId);
  if (!pending) return;
  pendingImageUploads.delete(userId);

  const prediction = getPrediction(pending.predictionId);
  if (!prediction || prediction.status !== Status.AwaitingImages) return;

  // Move to pending_verification and post
  updatePrediction(prediction.id, { status: Status.PendingVerification });
  const updated = getPrediction(prediction.id);

  await postPredictionToFeed(updated, pending.guildId);
  await postToAdminReview(updated, pending.guildId);
  await refreshLeaderboard(pending.guildId).catch(() => {});
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
  }

  updatePrediction(predictionId, updates);
  await syncPredictionEmbeds(predictionId, interaction.guildId);
  await interaction.reply({ content: '✅ Prediction updated.', flags: ['Ephemeral'] });
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

  const pts = starPoints(stars);
  updatePrediction(predictionId, {
    star_rating: stars,
    total_points: prediction.outcome === 'hit' ? pts + 10 : pts,
    status: prediction.outcome ? prediction.status : Status.Rated,
    rated_by: interaction.user.id,
  });

  await syncPredictionEmbeds(predictionId, interaction.guildId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});
  await interaction.reply({
    content: `⭐ Rated **#${String(predictionId).padStart(4, '0')}** — ${stars} star${stars > 1 ? 's' : ''} (${pts} pts)`,
    flags: ['Ephemeral'],
  });
}

// ── Button handlers ─────────────────────────────────────────

async function handleButton(interaction) {
  const [action, idStr] = interaction.customId.split(':');
  const predictionId = parseInt(idStr, 10);

  switch (action) {
    case 'edit_prediction':
      return handleEditButton(interaction, predictionId);
    case 'verify_ownership':
      return handleVerifyOwnership(interaction, predictionId);
    case 'assign_stars':
      return handleAssignStars(interaction, predictionId);
    case 'mark_hit':
      return handleMarkOutcome(interaction, predictionId, 'hit');
    case 'mark_fail':
      return handleMarkOutcome(interaction, predictionId, 'fail');
    case 'delete_prediction':
      return handleDeleteButton(interaction, predictionId);
    case 'confirm_delete':
      return handleConfirmDelete(interaction, predictionId);
    case 'cancel_delete':
      return interaction.update({
        content: '❌ Deletion cancelled.',
        components: [],
      });
    default:
      return interaction.reply({ content: '❓ Unknown action.', flags: ['Ephemeral'] });
  }
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

async function handleVerifyOwnership(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', flags: ['Ephemeral'] });

  if (prediction.ownership_verified) {
    return interaction.reply({ content: '✅ Already verified.', flags: ['Ephemeral'] });
  }

  updatePrediction(predictionId, {
    ownership_verified: 1,
    verified_by: interaction.user.id,
    verified_at: new Date().toISOString(),
    status: Status.PendingReview,
  });

  await syncPredictionEmbeds(predictionId, interaction.guildId);
  await interaction.reply({
    content: `✅ Ownership verified for **#${String(predictionId).padStart(4, '0')}**. Ready for star rating.`,
    flags: ['Ephemeral'],
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

async function handleMarkOutcome(interaction, predictionId, outcome) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', flags: ['Ephemeral'] });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', flags: ['Ephemeral'] });

  if (prediction.outcome) {
    return interaction.reply({ content: `❌ Already resolved as **${prediction.outcome}**.`, flags: ['Ephemeral'] });
  }

  if (!prediction.star_rating) {
    return interaction.reply({ content: '❌ Assign stars first.', flags: ['Ephemeral'] });
  }

  const pts = totalPoints(prediction.star_rating, outcome);
  const status = outcome === 'hit' ? Status.Hit : Status.Fail;

  updatePrediction(predictionId, {
    outcome,
    total_points: pts,
    status,
    resolved_by: interaction.user.id,
  });

  await syncPredictionEmbeds(predictionId, interaction.guildId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});

  const emoji = outcome === 'hit' ? '🟢' : '🔴';
  await interaction.reply({
    content: `${emoji} **#${String(predictionId).padStart(4, '0')}** marked as **${outcome}** — ${pts} pts total`,
    flags: ['Ephemeral'],
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
    return interaction.update({ content: '❌ Already deleted.', components: [] });
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

  await interaction.update({
    content: `🗑 Prediction **#${String(predictionId).padStart(4, '0')}** deleted.`,
    components: [],
  });
}

// ── Image collection (message listener) ──────────────────────

async function handleMessageForImages(message) {
  if (message.author.bot) return;

  const pending = pendingImageUploads.get(message.author.id);
  if (!pending || pending.channelId !== message.channelId) return;
  if (message.attachments.size === 0) return;

  // Filter image attachments only
  const imageUrls = message.attachments
    .filter(a => a.contentType?.startsWith('image/'))
    .map(a => a.url);

  if (imageUrls.length === 0) return;

  // Clear the timeout — we got images
  clearTimeout(pending.timeout);
  pendingImageUploads.delete(message.author.id);

  // Download images to disk BEFORE anything else (URLs may expire)
  const filenames = await downloadAndSave(pending.predictionId, imageUrls);

  if (filenames.length === 0) {
    await message.reply({
      content: '❌ Failed to save images. Please try submitting again with `/predict`.',
    });
    return;
  }

  // Update prediction: store filenames (not URLs), move to pending_verification
  updatePrediction(pending.predictionId, {
    images: filenames,
    status: Status.PendingVerification,
  });

  const prediction = getPrediction(pending.predictionId);

  // Post to feeds
  await postPredictionToFeed(prediction, pending.guildId);
  await postToAdminReview(prediction, pending.guildId);
  await refreshLeaderboard(pending.guildId).catch(() => {});

  // Confirm to user
  await message.reply({
    content: `📸 ${filenames.length} card image${filenames.length > 1 ? 's' : ''} saved for prediction **#${String(pending.predictionId).padStart(4, '0')}**. Submitted for review!`,
  });
}

// ── Event routing ────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'predict': return await handlePredict(interaction);
        case 'link-upshot': return await handleLinkUpshot(interaction);
        case 'mystats': return await handleMyStats(interaction);
        case 'leaderboard': return await handleLeaderboardCommand(interaction);
        case 'setup': return await handleSetup(interaction);
      }
    }

    if (interaction.isModalSubmit()) {
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
  }
});

client.on(Events.MessageCreate, handleMessageForImages);

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

  // Handle predictions that were awaiting images when the bot last went offline.
  // If they've been waiting > 5 min, post them without images.
  const stale = getAwaitingImagePredictions(IMAGE_UPLOAD_TIMEOUT_MS);
  if (stale.length > 0) {
    console.log(`   Recovering ${stale.length} stale prediction(s) from before restart...`);
    // Use the first guild as fallback for config resolution
    const fallbackGuildId = client.guilds.cache.first()?.id;
    for (const pred of stale) {
      updatePrediction(pred.id, { status: Status.PendingVerification });
      const updated = getPrediction(pred.id);
      if (!updated.embed_message_id) {
        await postPredictionToFeed(updated, fallbackGuildId);
        await postToAdminReview(updated, fallbackGuildId);
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
