// ── Referral integration ────────────────────────────────────
//
// Talks to the standalone upshot-referral web server, which owns the referral
// DB and the public invites site. This module is the Discord half: it tracks
// which invite a new member used and reports it via /api/referral-used.
//
// As of the v2.1 cutover (2026-08) the bot does NOT credit referrals. The
// server's sweeper does that automatically once a referee qualifies (linked
// profile + pack + activity), so the old "tap Verify" panel is now just a
// signpost to the invites site. Qualification data reaches the server through
// the pushes in referralPush.js, not through this file.
//
// Env vars consumed (all optional — missing config disables the feature):
//   REFERRAL_API_URL          e.g. http://127.0.0.1:3002
//   REFERRAL_API_SECRET       must match BOT_API_SECRET on the web server
//   REFERRAL_GUILD_ID         guild whose invites we track (defaults to first guild)
//   REFERRAL_VERIFY_CHANNEL   channel where the Verify panel lives

import {
  Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} from 'discord.js';

// NOTE: the pack-ownership check that used to live here is gone with the v1
// verify flow — the referral server's sweeper now evaluates that itself from
// the wallet the bot pushes via /api/bot/wallet-linked.

// Kept only so stale panels still in the channel (or pinned elsewhere) route to
// the "moved" notice instead of dead-ending. Nothing posts this button anymore.
const VERIFY_BUTTON_ID = 'upshot_verify_account';

const PANEL_TITLE = 'Referrals Are Automatic Now';
// v1's title. postVerifyPanel matches on BOTH so the existing "press Verify"
// panel gets edited in place at boot rather than left sitting above a new one.
const LEGACY_PANEL_TITLE = 'Verify Your Upshot Profile';

// Public invites site. REFERRAL_API_URL happens to be the same public origin
// today, but it's the API base by contract and could be an internal address —
// a Discord link button with a non-https URL makes the whole panel post fail,
// so fall back to the known public site rather than risking that.
const DEFAULT_INVITES_URL = 'https://upshotinvites.hazypi.xyz';

const cachedInvites = new Map();          // code -> uses

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

// Returns the Response on success or a sentinel { networkError: true, path }
// when the call couldn't reach the referral server at all. Callers can
// distinguish "server down" from "server returned 4xx/5xx".
async function apiFetch(path, init = {}) {
  const base = getReferralApiUrl();
  const secret = getReferralApiSecret();
  if (!base || !secret) return null;
  const headers = {
    ...(init.headers || {}),
    'X-Bot-Secret': secret,
  };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${base}${path}`, { ...init, headers });
  } catch (err) {
    console.error(`[referral] fetch ${path} failed (${base} unreachable):`, err.message);
    return { networkError: true, path, message: err.message };
  }
}

// ── Verify panel ────────────────────────────────────────────

function buildVerifyEmbed() {
  return new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setDescription(
      '**Welcome to the Upshot community!**\n\n' +
      'There\'s no Verify button anymore — referrals are credited **automatically**.\n\n' +
      'To qualify, just:\n' +
      '**1.** Link your Upshot profile — either on the invites site below, or right here by tapping **📇 My Cards** on the **Upshot Predictions** panel.\n' +
      '**2.** Own **at least one Pack** on Upshot. Grab one at [upshot.cards](https://upshot.cards) — you don\'t have to open it, you just need to own it.\n\n' +
      'That\'s it. You\'ll be credited within ~15 minutes of qualifying, and you can track your progress — plus grab your own invite link to start referring — on the site.'
    )
    .setColor(0xFF6B35);
}

// The public invites site, for the panel's link button and the "moved" notice.
function getInvitesSiteUrl() {
  const explicit = env('REFERRAL_BASE_URL');
  if (explicit && /^https:\/\//i.test(explicit)) return explicit;
  const api = getReferralApiUrl();
  if (api && /^https:\/\//i.test(api)) return api;
  return DEFAULT_INVITES_URL;
}

function buildVerifyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Open the invites site')
      .setStyle(ButtonStyle.Link)
      .setURL(getInvitesSiteUrl())
      .setEmoji('🔗')
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
    // Match the v1 title too: the old "press Verify" panel must be EDITED into
    // the new one, not left in the channel above a second post telling people
    // the opposite.
    const existing = messages.find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      (m.embeds[0].title === PANEL_TITLE || m.embeds[0].title === LEGACY_PANEL_TITLE)
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
    if (res?.networkError) {
      console.warn(`[referral] referral server unreachable — invite from ${member.user.tag} via ${usedInvite.code} not recorded`);
    } else if (res && !res.ok) {
      console.error(`[referral] /api/referral-used returned ${res.status}`);
    }
  } catch (err) {
    console.error('[referral] member-join handling failed:', err.message);
  }
}

// ── Stale Verify button ─────────────────────────────────────
//
// v1's "tap Verify to get credited" flow is retired: the referral server now
// credits automatically via its sweeper once the referee qualifies, and
// POST /api/verify-account no longer credits anything (it answers
// { verified:false, moved:true }). The bot no longer calls it at all.
//
// The button is no longer rendered anywhere, but old panel messages can linger
// — pinned, in another channel, or if the boot-time panel edit failed — so a
// press must land somewhere sensible rather than silently failing.
async function handleVerifyButton(interaction) {
  if (!interaction.isButton() || interaction.customId !== VERIFY_BUTTON_ID) return false;

  const site = getInvitesSiteUrl();
  await interaction.reply({
    content:
      '✅ **No need to verify anymore — referrals are automatic.**\n\n' +
      `Just link your Upshot profile (here via **📇 My Cards**, or on the site) and own at least one Pack. You'll be credited within ~15 minutes of qualifying.\n\n` +
      `Track your progress and grab your own invite link: ${site}`,
    flags: 64,
  }).catch(() => {});
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
