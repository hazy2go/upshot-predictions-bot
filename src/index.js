import {
  Client, GatewayIntentBits, Events,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import 'dotenv/config';

import {
  linkUpshot, getUpshotProfile,
  createPrediction, getPrediction, updatePrediction, deletePrediction,
  countUserDailyPredictions, getUserStats, getLeaderboard,
  getLeaderboardMessageId, setLeaderboardMessageId,
  getAwaitingImagePredictions,
} from './database.js';

import {
  buildPredictionCard, buildAdminCard,
  buildLeaderboard, buildStatsCard, buildDeleteConfirm,
} from './components.js';

import { downloadAndSave, getAttachmentBuilders } from './images.js';

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

const MAX_DAILY = parseInt(process.env.MAX_DAILY_PREDICTIONS || '3', 10);
const IMAGE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// In-memory tracker for pending image uploads.
// On restart, the bot checks DB for stale entries (see ClientReady handler).
// Map<userId, { predictionId, channelId, guildId, timeout }>
const pendingImageUploads = new Map();

// ── Helpers ──────────────────────────────────────────────────

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function currentMonthLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function isAdmin(member) {
  return member.roles.cache.has(process.env.ADMIN_ROLE_ID);
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

async function postPredictionToFeed(prediction) {
  const profile = getUpshotProfile(prediction.author_id);
  const channel = await safeGetChannel(process.env.PREDICTIONS_CHANNEL_ID);
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

async function postToAdminReview(prediction) {
  const profile = getUpshotProfile(prediction.author_id);
  const channel = await safeGetChannel(process.env.ADMIN_REVIEW_CHANNEL_ID);
  if (!channel) return null;

  const payload = buildAdminCard(prediction, profile?.upshot_url);

  // Attach image files from disk for the admin MediaGallery
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

async function syncPredictionEmbeds(predictionId) {
  const prediction = getPrediction(predictionId);
  if (!prediction) return;

  const profile = getUpshotProfile(prediction.author_id);

  // Update public embed (no files — text only)
  if (prediction.embed_message_id) {
    const channel = await safeGetChannel(process.env.PREDICTIONS_CHANNEL_ID);
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

  // Update admin embed (re-attach images from disk every time)
  if (prediction.admin_message_id) {
    const channel = await safeGetChannel(process.env.ADMIN_REVIEW_CHANNEL_ID);
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

async function refreshLeaderboard(guildId) {
  const entries = getLeaderboard(currentMonthKey());
  const payload = buildLeaderboard(entries, currentMonthLabel());
  const channel = await safeGetChannel(process.env.LEADERBOARD_CHANNEL_ID);
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
      ephemeral: true,
    });
  }

  const todayCount = countUserDailyPredictions(interaction.user.id);
  if (todayCount >= MAX_DAILY) {
    return interaction.reply({
      content: `❌ You've reached the daily limit of **${MAX_DAILY}** predictions. Try again tomorrow.`,
      ephemeral: true,
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
        .setLabel(`Category (${Categories.join(' / ')})`)
        .setPlaceholder(Categories.join(' / '))
        .setStyle(TextInputStyle.Short)
        .setMaxLength(20)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description — your full reasoning')
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
        .setLabel('Tweet link (optional — skip if uploading images)')
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
      ephemeral: true,
    });
  }

  linkUpshot(interaction.user.id, url);

  await interaction.reply({
    content: `✅ Upshot profile linked!\n🔗 ${url}\n\nYou can now submit predictions with \`/predict\`.`,
    ephemeral: true,
  });
}

async function handleMyStats(interaction) {
  const stats = getUserStats(interaction.user.id, currentMonthKey());
  const payload = buildStatsCard(stats, interaction.user.id, currentMonthLabel());
  await interaction.reply({ ...payload, ephemeral: true });
}

async function handleLeaderboardCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  await refreshLeaderboard(interaction.guildId);
  await interaction.editReply({ content: '✅ Leaderboard refreshed.' });
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
      ephemeral: true,
    });
  }

  // Validate deadline format
  const deadlineMatch = deadline.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!deadlineMatch) {
    return interaction.reply({
      content: '❌ Invalid deadline format. Use DD/MM/YYYY.',
      ephemeral: true,
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
      ephemeral: true,
    });
    await postPredictionToFeed(prediction);
    await postToAdminReview(prediction);
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
      ephemeral: true,
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

  await postPredictionToFeed(updated);
  await postToAdminReview(updated);
  await refreshLeaderboard(pending.guildId).catch(() => {});
}

async function handleEditModalSubmit(interaction) {
  const predictionId = parseInt(interaction.customId.split(':')[1], 10);
  const prediction = getPrediction(predictionId);

  if (!prediction || prediction.author_id !== interaction.user.id) {
    return interaction.reply({ content: '❌ Not found or not yours.', ephemeral: true });
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
  await syncPredictionEmbeds(predictionId);
  await interaction.reply({ content: '✅ Prediction updated.', ephemeral: true });
}

async function handleStarsModalSubmit(interaction) {
  const predictionId = parseInt(interaction.customId.split(':')[1], 10);
  const starsInput = interaction.fields.getTextInputValue('stars').trim();
  const stars = parseInt(starsInput, 10);

  if (![1, 2, 3].includes(stars)) {
    return interaction.reply({ content: '❌ Stars must be 1, 2, or 3.', ephemeral: true });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.reply({ content: '❌ Prediction not found.', ephemeral: true });
  }

  const pts = starPoints(stars);
  updatePrediction(predictionId, {
    star_rating: stars,
    total_points: prediction.outcome === 'hit' ? pts + 10 : pts,
    status: prediction.outcome ? prediction.status : Status.Rated,
    rated_by: interaction.user.id,
  });

  await syncPredictionEmbeds(predictionId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});
  await interaction.reply({
    content: `⭐ Rated **#${String(predictionId).padStart(4, '0')}** — ${stars} star${stars > 1 ? 's' : ''} (${pts} pts)`,
    ephemeral: true,
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
      return interaction.reply({ content: '❓ Unknown action.', ephemeral: true });
  }
}

async function handleEditButton(interaction, predictionId) {
  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.reply({ content: '❌ Prediction not found.', ephemeral: true });
  }
  if (prediction.author_id !== interaction.user.id) {
    return interaction.reply({ content: '❌ You can only edit your own predictions.', ephemeral: true });
  }
  if (![Status.PendingVerification, Status.PendingReview].includes(prediction.status)) {
    return interaction.reply({ content: '❌ This prediction can no longer be edited.', ephemeral: true });
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
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', ephemeral: true });

  if (prediction.ownership_verified) {
    return interaction.reply({ content: '✅ Already verified.', ephemeral: true });
  }

  updatePrediction(predictionId, {
    ownership_verified: 1,
    verified_by: interaction.user.id,
    verified_at: new Date().toISOString(),
    status: Status.PendingReview,
  });

  await syncPredictionEmbeds(predictionId);
  await interaction.reply({
    content: `✅ Ownership verified for **#${String(predictionId).padStart(4, '0')}**. Ready for star rating.`,
    ephemeral: true,
  });
}

async function handleAssignStars(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', ephemeral: true });

  if (!prediction.ownership_verified) {
    return interaction.reply({ content: '❌ Verify ownership first.', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`stars_modal:${predictionId}`)
    .setTitle(`Rate Prediction #${String(predictionId).padStart(4, '0')}`);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('stars')
        .setLabel('Stars (1, 2, or 3) — 1pt / 3pts / 5pts')
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
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Not found.', ephemeral: true });

  if (prediction.outcome) {
    return interaction.reply({ content: `❌ Already resolved as **${prediction.outcome}**.`, ephemeral: true });
  }

  if (!prediction.star_rating) {
    return interaction.reply({ content: '❌ Assign stars first.', ephemeral: true });
  }

  const pts = totalPoints(prediction.star_rating, outcome);
  const status = outcome === 'hit' ? Status.Hit : Status.Fail;

  updatePrediction(predictionId, {
    outcome,
    total_points: pts,
    status,
    resolved_by: interaction.user.id,
  });

  await syncPredictionEmbeds(predictionId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});

  const emoji = outcome === 'hit' ? '🟢' : '🔴';
  await interaction.reply({
    content: `${emoji} **#${String(predictionId).padStart(4, '0')}** marked as **${outcome}** — ${pts} pts total`,
    ephemeral: true,
  });
}

async function handleDeleteButton(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) return interaction.reply({ content: '❌ Already deleted.', ephemeral: true });

  await interaction.reply(buildDeleteConfirm(predictionId));
}

async function handleConfirmDelete(interaction, predictionId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  const prediction = getPrediction(predictionId);
  if (!prediction) {
    return interaction.update({ content: '❌ Already deleted.', components: [] });
  }

  // Delete public embed
  if (prediction.embed_message_id) {
    const channel = await safeGetChannel(process.env.PREDICTIONS_CHANNEL_ID);
    if (channel) {
      const msg = await safeGetMessage(channel, prediction.embed_message_id);
      if (msg) { try { await msg.delete(); } catch { /* ok */ } }
    }
  }

  // Delete admin embed
  if (prediction.admin_message_id) {
    const channel = await safeGetChannel(process.env.ADMIN_REVIEW_CHANNEL_ID);
    if (channel) {
      const msg = await safeGetMessage(channel, prediction.admin_message_id);
      if (msg) { try { await msg.delete(); } catch { /* ok */ } }
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
  await postPredictionToFeed(prediction);
  await postToAdminReview(prediction);
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
    const reply = { content: '❌ Something went wrong. Please try again.', ephemeral: true };
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
  console.log(`   Predictions: ${process.env.PREDICTIONS_CHANNEL_ID}`);
  console.log(`   Admin review: ${process.env.ADMIN_REVIEW_CHANNEL_ID}`);
  console.log(`   Leaderboard: ${process.env.LEADERBOARD_CHANNEL_ID}`);
  console.log(`   Admin role: ${process.env.ADMIN_ROLE_ID}`);
  console.log(`   Daily limit: ${MAX_DAILY}/user`);

  // Handle predictions that were awaiting images when the bot last went offline.
  // If they've been waiting > 5 min, post them without images.
  const stale = getAwaitingImagePredictions(IMAGE_UPLOAD_TIMEOUT_MS);
  if (stale.length > 0) {
    console.log(`   Recovering ${stale.length} stale prediction(s) from before restart...`);
    for (const pred of stale) {
      updatePrediction(pred.id, { status: Status.PendingVerification });
      const updated = getPrediction(pred.id);
      if (!updated.embed_message_id) {
        await postPredictionToFeed(updated);
        await postToAdminReview(updated);
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
