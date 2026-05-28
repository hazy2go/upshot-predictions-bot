// ── Referral integration ────────────────────────────────────
//
// Talks to the standalone upshot-referral web server, which owns the
// referral DB and the public leaderboard page. This module is the Discord
// half: it tracks which invite a new member used, posts a Verify panel in
// the configured channel, and credits referrals once the new member has
// (a) linked their Upshot profile in this bot and (b) owns ≥1 Pack.
//
// Env vars consumed (all optional — missing config disables the feature):
//   REFERRAL_API_URL          e.g. http://127.0.0.1:3002
//   REFERRAL_API_SECRET       must match BOT_API_SECRET on the web server
//   REFERRAL_GUILD_ID         guild whose invites we track (defaults to first guild)
//   REFERRAL_VERIFY_CHANNEL   channel where the Verify panel lives

import {
  Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} from 'discord.js';

import { getUpshotProfile } from './database.js';
import { extractWallet, getUserPacks } from './api.js';

const VERIFY_BUTTON_ID = 'upshot_verify_account';
const VERIFY_COOLDOWN_MS = 10_000;
const PANEL_TITLE = 'Verify Your Upshot Profile';

const cachedInvites = new Map();          // code -> uses
const verifyButtonCooldowns = new Map();  // userId -> timestamp
const verifyInProgress = new Set();       // userId

function env(key) {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : null;
}

function getReferralApiUrl() { return env('REFERRAL_API_URL'); }
function getReferralApiSecret() { return env('REFERRAL_API_SECRET'); }
function getReferralGuildId() { return env('REFERRAL_GUILD_ID'); }
function getVerifyChannelId() { return env('REFERRAL_VERIFY_CHANNEL'); }

function isEnabled() {
  return !!(getReferralApiUrl() && getReferralApiSecret());
}

async function apiFetch(path, init = {}) {
  const base = getReferralApiUrl();
  const secret = getReferralApiSecret();
  if (!base || !secret) return null;
  const headers = {
    ...(init.headers || {}),
    'X-Bot-Secret': secret,
  };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${path}`, { ...init, headers });
}

// ── Verify panel ────────────────────────────────────────────

function buildVerifyEmbed() {
  return new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setDescription(
      '**Welcome to the Upshot community!**\n\n' +
      'To get your referral credited, you need to:\n' +
      '**1.** Link your Upshot profile with this bot — open the **Upshot Predictions** panel and tap **📇 My Cards**. It\'ll walk you through pasting your profile URL.\n' +
      '**2.** Own **at least one Pack** on Upshot. Grab one at [upshot.cards](https://upshot.cards) — you don\'t have to open it, you just need to own it.\n\n' +
      'When both are done, press **Verify** below.'
    )
    .setColor(0xFF6B35);
}

function buildVerifyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(VERIFY_BUTTON_ID)
      .setLabel('Verify')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🃏')
  );
}

async function postVerifyPanel(client) {
  const channelId = getVerifyChannelId();
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    console.warn(`[referral] verify channel ${channelId} not found or not text-based`);
    return;
  }
  const embed = buildVerifyEmbed();
  const row = buildVerifyRow();
  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const existing = messages.find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      m.embeds[0].title === PANEL_TITLE
    );
    if (existing) {
      await existing.edit({ embeds: [embed], components: [row] });
    } else {
      await channel.send({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error('[referral] failed to post verify panel:', err.message);
  }
}

// ── Invite cache + member-join tracking ─────────────────────

async function cacheInvitesForGuild(guild) {
  try {
    const invites = await guild.invites.fetch();
    invites.forEach(inv => cachedInvites.set(inv.code, inv.uses || 0));
    console.log(`[referral] cached ${cachedInvites.size} invites for ${guild.name}`);
  } catch (err) {
    console.error(`[referral] failed to fetch invites for ${guild.name}:`, err.message);
  }
}

async function onGuildMemberAdd(member) {
  const guildId = getReferralGuildId();
  if (guildId && member.guild.id !== guildId) return;
  if (!isEnabled()) return;

  try {
    const newInvites = await member.guild.invites.fetch();
    let usedInvite = null;
    let ambiguousCount = 0;
    for (const [code, inv] of newInvites) {
      const oldUses = cachedInvites.get(code) || 0;
      if (inv.uses > oldUses) {
        usedInvite = inv;
        ambiguousCount++;
      }
    }
    newInvites.forEach(inv => cachedInvites.set(inv.code, inv.uses || 0));

    if (ambiguousCount > 1) {
      console.warn(`[referral] ${ambiguousCount} invites incremented at once for ${member.user.tag} — race condition`);
    }
    if (!usedInvite) {
      console.log(`[referral] could not determine which invite ${member.user.tag} used`);
      return;
    }

    const res = await apiFetch('/api/referral-used', {
      method: 'POST',
      body: JSON.stringify({
        inviteCode: usedInvite.code,
        newMemberId: member.user.id,
        newMemberTag: member.user.tag,
        inviterId: usedInvite.inviter?.id,
        inviterTag: usedInvite.inviter?.tag,
      }),
    });
    if (res && !res.ok) {
      console.error(`[referral] /api/referral-used returned ${res.status}`);
    }
  } catch (err) {
    console.error('[referral] member-join handling failed:', err.message);
  }
}

// ── Verify button handler ───────────────────────────────────

async function handleVerifyButton(interaction) {
  if (!interaction.isButton() || interaction.customId !== VERIFY_BUTTON_ID) return false;
  if (!isEnabled()) {
    await interaction.reply({ content: 'Referral verification isn\'t configured.', flags: 64 }).catch(() => {});
    return true;
  }

  const userId = interaction.user.id;

  if (verifyInProgress.has(userId)) {
    await interaction.reply({
      content: 'Your verification is already being processed, please wait.',
      flags: 64,
    }).catch(() => {});
    return true;
  }

  const lastPress = verifyButtonCooldowns.get(userId);
  if (lastPress && Date.now() - lastPress < VERIFY_COOLDOWN_MS) {
    const remaining = Math.ceil((VERIFY_COOLDOWN_MS - (Date.now() - lastPress)) / 1000);
    await interaction.reply({
      content: `Please wait ${remaining} seconds before trying again.`,
      flags: 64,
    }).catch(() => {});
    return true;
  }
  verifyButtonCooldowns.set(userId, Date.now());
  verifyInProgress.add(userId);

  try {
    await interaction.deferReply({ flags: 64 });
  } catch {
    verifyInProgress.delete(userId);
    return true;
  }

  try {
    // 1. Pending-referral check
    const pendingRes = await apiFetch(`/api/check-pending/${userId}`);
    if (!pendingRes || !pendingRes.ok) {
      console.error('[referral] check-pending failed:', pendingRes?.status);
      await interaction.editReply({ content: '⚠️ Something went wrong. Please try again later.' });
      return true;
    }
    const pendingData = await pendingRes.json();
    if (!pendingData.hasPending) {
      await interaction.editReply({
        content: '📋 **No pending referral found.** You either weren\'t invited via a tracked link, or your referral has already been credited.',
      });
      return true;
    }

    // 2. Linked-profile check (local DB)
    const profile = getUpshotProfile(userId);
    if (!profile || !profile.upshot_url) {
      await interaction.editReply({
        content: '❌ **Your Upshot profile isn\'t linked yet.**\n\nOpen the **Upshot Predictions** panel in this server, tap **📇 My Cards**, and follow the prompt to paste your profile URL from [upshot.cards](https://upshot.cards). Then come back and press Verify again.',
      });
      return true;
    }

    const wallet = extractWallet(profile.wallet_address) || extractWallet(profile.upshot_url);
    if (!wallet) {
      await interaction.editReply({
        content: '❌ **We couldn\'t read a wallet address from your linked profile.**\n\nRe-link your profile (it should be a `https://upshot.cards/profile/0x…` URL) and try again.',
      });
      return true;
    }

    // 3. Pack ownership check (Upshot API)
    const packs = await getUserPacks(wallet);
    if (!Array.isArray(packs)) {
      await interaction.editReply({
        content: '⚠️ **Couldn\'t reach the Upshot API right now.** Give it a minute and press Verify again.',
      });
      return true;
    }
    const packCount = packs.reduce((sum, p) => sum + (parseInt(p.quantity, 10) || 0), 0);
    if (packCount === 0) {
      await interaction.editReply({
        content: '❌ **You don\'t own any Packs yet.**\n\nGrab at least one Pack at [upshot.cards](https://upshot.cards) — you don\'t have to open it, you just need to own it. Then press Verify again.',
      });
      return true;
    }

    // 4. Credit referral
    const verifyRes = await apiFetch('/api/verify-account', {
      method: 'POST',
      body: JSON.stringify({ newMemberId: userId, upshotWallet: wallet }),
    });
    if (!verifyRes || !verifyRes.ok) {
      console.error('[referral] verify-account failed:', verifyRes?.status);
      await interaction.editReply({ content: '⚠️ Something went wrong. Please try again later.' });
      return true;
    }
    const data = await verifyRes.json();
    if (!data.verified) {
      await interaction.editReply({
        content: '⚠️ Something went wrong while crediting. Please try again later.',
      });
      return true;
    }

    const baseUrl = env('REFERRAL_BASE_URL') || getReferralApiUrl();
    const shortWallet = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
    await interaction.editReply({
      content:
        `✅ **Verified!** Your referral has been credited (linked wallet \`${shortWallet}\`, ${packCount} pack${packCount === 1 ? '' : 's'} owned).\n\n` +
        `Want to earn rewards yourself? Head to **${baseUrl}** to grab your own invite link and start referring.`,
    });
  } catch (err) {
    console.error('[referral] verify handler failed:', err.message);
    await interaction.editReply({
      content: '⚠️ Something went wrong. Please try again later.',
    }).catch(() => {});
  } finally {
    verifyInProgress.delete(userId);
  }
  return true;
}

// ── Wiring ──────────────────────────────────────────────────

export function registerReferralHandlers(client) {
  if (!isEnabled()) {
    console.log('[referral] disabled (set REFERRAL_API_URL + REFERRAL_API_SECRET to enable)');
    return;
  }

  client.once(Events.ClientReady, async () => {
    const guildId = getReferralGuildId();
    const guilds = guildId
      ? [client.guilds.cache.get(guildId)].filter(Boolean)
      : Array.from(client.guilds.cache.values());

    for (const g of guilds) await cacheInvitesForGuild(g);
    await postVerifyPanel(client);
  });

  client.on(Events.GuildMemberAdd, onGuildMemberAdd);

  client.on(Events.InviteCreate, (invite) => {
    cachedInvites.set(invite.code, invite.uses || 0);
  });
  client.on(Events.InviteDelete, (invite) => {
    cachedInvites.delete(invite.code);
  });
}

// Exported so index.js's InteractionCreate handler can delegate to it
// before falling through to its other button routing.
export async function tryHandleReferralInteraction(interaction) {
  return handleVerifyButton(interaction);
}
