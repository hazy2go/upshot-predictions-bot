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
  getConfig, setConfig, getAllConfig,
  getCategories, addCategory, removeCategory,
  resetUser, resetAllUsers,
} from './database.js';

import {
  buildPredictionCard, buildAdminCard,
  buildLeaderboard, buildStatsCard, buildDeleteConfirm,
} from './components.js';

import { downloadAndSave, getAttachmentBuilders } from './images.js';
import { commands } from './commands.js';

import {
  Status, DefaultCategories, starPoints, totalPoints,
} from './constants.js';

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

// ── Helpers ──────────────────────────────────────────────────

function getCategoryList(guildId) {
  return getCategories(guildId) || DefaultCategories;
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

  // Attach image files from disk for MediaGallery
  const files = prediction.images?.length > 0
    ? getAttachmentBuilders(prediction.id, prediction.images)
    : [];

  try {
    const msg = await channel.send({ ...payload, files });
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

  // Update public embed (re-attach images from disk)
  if (prediction.embed_message_id) {
    const channelId = getPredictionsChannelId(guildId);
    if (channelId) {
      const channel = await safeGetChannel(channelId);
      if (channel) {
        const msg = await safeGetMessage(channel, prediction.embed_message_id);
        if (msg) {
          try {
            const payload = buildPredictionCard(prediction, profile?.upshot_url);
            const files = prediction.images?.length > 0
              ? getAttachmentBuilders(prediction.id, prediction.images)
              : [];
            await msg.edit({ ...payload, files });
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

// Temporary storage for attachments between command → modal flow
// Map<userId, { imageUrls: string[], tweetUrl: string|null, guildId: string }>
const pendingSubmissions = new Map();

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

  // Grab attachments and tweet URL from command options
  const imageUrls = [];
  for (const key of ['image1', 'image2', 'image3']) {
    const att = interaction.options.getAttachment(key);
    if (att && att.contentType?.startsWith('image/')) {
      imageUrls.push(att.url);
    }
  }
  // Store attachments temporarily — they'll be retrieved when the modal is submitted
  pendingSubmissions.set(interaction.user.id, {
    imageUrls,
    guildId: interaction.guildId,
  });

  // Auto-clear after 5 min if modal is never submitted
  setTimeout(() => pendingSubmissions.delete(interaction.user.id), 5 * 60 * 1000);

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
        .setPlaceholder(getCategoryList(interaction.guildId).join(' / '))
        .setStyle(TextInputStyle.Short)
        .setMaxLength(30)
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
        .setLabel('Tweet URL (optional — +1 bonus point on hit)')
        .setPlaceholder('https://x.com/... or https://twitter.com/...')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(280)
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
    case 'view': {
      const cfg = getAllConfig(guildId);
      const cats = getCategoryList(guildId);
      const lines = [
        '**Current Configuration**',
        '',
        `**Predictions channel:** ${cfg.predictions_channel ? `<#${cfg.predictions_channel}>` : '`not set (using .env)`'}`,
        `**Admin review channel:** ${cfg.admin_channel ? `<#${cfg.admin_channel}>` : '`not set (using .env)`'}`,
        `**Leaderboard channel:** ${cfg.leaderboard_channel ? `<#${cfg.leaderboard_channel}>` : '`not set (using .env)`'}`,
        `**Admin role:** ${cfg.admin_role ? `<@&${cfg.admin_role}>` : '`not set (using .env)`'}`,
        `**Max daily predictions:** ${cfg.max_daily || '`not set (default: 3)`'}`,
        `**Categories:** ${cats.join(', ')}`,
      ];
      return interaction.reply({ content: lines.join('\n'), flags: ['Ephemeral'] });
    }
  }
}

// ── Modal submits ───────────────────────────────────────────

async function handlePredictModalSubmit(interaction) {
  // Retrieve attachments stored during /predict command
  const pending = pendingSubmissions.get(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: '❌ Submission expired. Please run `/predict` again.',
      flags: ['Ephemeral'],
    });
  }
  pendingSubmissions.delete(interaction.user.id);

  const title = interaction.fields.getTextInputValue('title');
  const category = interaction.fields.getTextInputValue('category').trim();
  const description = interaction.fields.getTextInputValue('description');
  const deadline = interaction.fields.getTextInputValue('deadline');
  const rawTweetUrl = interaction.fields.getTextInputValue('tweet_url')?.trim() || null;

  // Fuzzy match category — tolerates typos
  const categories = getCategoryList(interaction.guildId);
  const matchedCategory = matchCategory(category, categories);
  if (!matchedCategory) {
    return interaction.reply({
      content: `❌ Couldn't match "**${category}**" to a category.\nAvailable: ${categories.join(', ')}`,
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

  // Defer — downloading images + posting to channels takes time
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const { imageUrls, guildId } = pending;
  const proofType = tweetUrl ? 'tweet' : (imageUrls.length > 0 ? 'images' : 'none');

  // Download images to disk immediately (URLs expire)
  let filenames = [];
  if (imageUrls.length > 0) {
    // Create a temp prediction ID for download, then update
    const prediction = createPrediction({
      authorId: interaction.user.id,
      title,
      category: matchedCategory,
      description,
      deadline: deadlineFormatted,
      proofType,
      tweetUrl,
      images: [],
      status: Status.PendingVerification,
    });

    filenames = await downloadAndSave(prediction.id, imageUrls);
    updatePrediction(prediction.id, { images: filenames });
    const updated = getPrediction(prediction.id);

    await postPredictionToFeed(updated, guildId).catch(e => console.error('Feed post failed:', e.message));
    await postToAdminReview(updated, guildId).catch(e => console.error('Admin post failed:', e.message));
    await refreshLeaderboard(guildId).catch(() => {});

    const imgCount = filenames.length;
    const proofNote = tweetUrl ? ` and tweet proof` : '';
    await interaction.editReply({
      content: `✅ Prediction **#${String(prediction.id).padStart(4, '0')}** submitted with ${imgCount} card image${imgCount > 1 ? 's' : ''}${proofNote}! Now in the review queue.`,
    });
  } else {
    // No images — tweet proof or no proof
    const prediction = createPrediction({
      authorId: interaction.user.id,
      title,
      category: matchedCategory,
      description,
      deadline: deadlineFormatted,
      proofType,
      tweetUrl,
      images: [],
      status: Status.PendingVerification,
    });

    await postPredictionToFeed(prediction, guildId).catch(e => console.error('Feed post failed:', e.message));
    await postToAdminReview(prediction, guildId).catch(e => console.error('Admin post failed:', e.message));
    await refreshLeaderboard(guildId).catch(() => {});

    const proofNote = tweetUrl ? ' with tweet proof' : '';
    await interaction.editReply({
      content: `✅ Prediction **#${String(prediction.id).padStart(4, '0')}** submitted${proofNote}! Now in the review queue.`,
    });
  }
}

/**
 * Called when the image upload window expires.
 * Posts the prediction without images.
 */
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

  const hasTweet = !!prediction.tweet_url;
  const pts = totalPoints(stars, prediction.outcome, hasTweet);
  updatePrediction(predictionId, {
    star_rating: stars,
    total_points: pts,
    status: prediction.outcome ? prediction.status : Status.Rated,
    rated_by: interaction.user.id,
  });

  await syncPredictionEmbeds(predictionId, interaction.guildId);
  await refreshLeaderboard(interaction.guildId).catch(() => {});
  await interaction.editReply({
    content: `⭐ Rated **#${String(predictionId).padStart(4, '0')}** — ${stars} star${stars > 1 ? 's' : ''} (${pts} pts)`,
    flags: ['Ephemeral'],
  });
}

// ── Button handlers ─────────────────────────────────────────

async function handleButton(interaction) {
  const [action, idStr] = interaction.customId.split(':');
  const predictionId = parseInt(idStr, 10);

  switch (action) {
    case 'read_more':
      return handleReadMore(interaction, predictionId);
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

  updatePrediction(predictionId, {
    ownership_verified: 1,
    verified_by: interaction.user.id,
    verified_at: new Date().toISOString(),
    status: Status.PendingReview,
  });

  await syncPredictionEmbeds(predictionId, interaction.guildId);
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

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const hasTweet = !!prediction.tweet_url;
  const pts = totalPoints(prediction.star_rating, outcome, hasTweet);
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
  await interaction.editReply({
    content: `${emoji} **#${String(predictionId).padStart(4, '0')}** marked as **${outcome}** — ${pts} pts total`,
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

});

client.login(process.env.DISCORD_TOKEN);
