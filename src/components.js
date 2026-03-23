import {
  ComponentType as CT, ButtonStyle, Colors,
  statusLabel, statusColor, starPoints, Status,
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

// ── Prediction card (public #predictions) ────────────────────
//
// Public cards do NOT include images — images are proof for admin
// review only. The public card shows a verification badge instead.
// This avoids Discord CDN URL expiration on long-lived messages.

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
  children.push(text(`${prediction.category} · <@${prediction.author_id}> · ${profileLink} · Deadline: ${prediction.deadline}`));

  // Description (truncated for feed)
  const desc = prediction.description.length > 280
    ? prediction.description.slice(0, 280) + '...'
    : prediction.description;
  children.push(text(desc));

  // Proof indicators (text only — no images in public feed)
  const proofParts = [];
  if (prediction.ownership_verified) {
    proofParts.push('✅ Card ownership verified');
  }
  if (prediction.tweet_url) {
    proofParts.push(`📎 [Tweet Proof](${prediction.tweet_url})`);
  }
  if (prediction.proof_type === 'images' && prediction.images?.length > 0) {
    proofParts.push(`🖼 ${prediction.images.length} card image${prediction.images.length > 1 ? 's' : ''} submitted`);
  }
  if (proofParts.length > 0) {
    children.push(text(proofParts.join(' · ')));
  }

  children.push(separator());

  // Points display (if rated)
  if (prediction.star_rating) {
    const stars = '⭐'.repeat(prediction.star_rating) + '☆'.repeat(3 - prediction.star_rating);
    let pointsLine = `${stars} ${starPoints(prediction.star_rating)} pts`;

    if (prediction.outcome === 'hit') {
      pointsLine = `${stars} **${prediction.total_points} pts awarded** (+${starPoints(prediction.star_rating)} quality, +10 hit bonus)`;
    } else if (prediction.outcome === 'fail') {
      pointsLine = `${stars} **${prediction.total_points} pts awarded** (quality only)`;
    }

    children.push(text(pointsLine));
  }

  // Footer
  const id = String(prediction.id).padStart(4, '0');
  const date = prediction.created_at?.split('T')[0] || prediction.created_at?.split(' ')[0] || '';
  children.push(text(`-# ID \`#${id}\` · ${date}`));

  // Edit button (only for pending states)
  if ([Status.PendingVerification, Status.PendingReview].includes(prediction.status)) {
    children.push(actionRow(
      button(`edit_prediction:${prediction.id}`, '✏ Edit', ButtonStyle.Secondary)
    ));
  }

  return {
    components: [container(color, children)],
    flags: 1 << 15,
  };
}

// ── Admin review card (#admin-review) ────────────────────────
//
// Admin cards DO include images via attachment:// protocol.
// The actual files are attached using AttachmentBuilder when
// sending/editing the message (handled by index.js).

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

  // Card images — uses attachment:// protocol referencing attached files
  if (prediction.images && prediction.images.length > 0) {
    children.push(mediaGallery(prediction.images));
  }

  // Tweet proof
  if (prediction.tweet_url) {
    children.push(text(`📎 [Tweet Proof](${prediction.tweet_url})`));
  }

  children.push(separator());

  // Status info
  const label = statusLabel(prediction.status);
  let statusInfo = `**Status:** ${label}`;
  if (prediction.star_rating) {
    const stars = '⭐'.repeat(prediction.star_rating) + '☆'.repeat(3 - prediction.star_rating);
    statusInfo += ` · **Rating:** ${stars} (${starPoints(prediction.star_rating)} pts)`;
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

  if (prediction.ownership_verified && !prediction.star_rating) {
    buttons.push(button(`assign_stars:${prediction.id}`, '⭐ Assign Stars', ButtonStyle.Primary));
  }

  if (prediction.star_rating && !prediction.outcome) {
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

export function buildLeaderboard(entries, monthLabel) {
  const children = [];

  children.push(text(`## 🏆 ${monthLabel} Leaderboard`));
  children.push(text('-# Monthly standings · Rewards distributed at month end'));
  children.push(separator());

  if (entries.length === 0) {
    children.push(text('*No rated predictions this month yet.*'));
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    const top3 = entries.slice(0, 3);

    for (let i = 0; i < top3.length; i++) {
      const e = top3[i];
      const hitRate = e.resolved > 0 ? Math.round((e.hits / e.resolved) * 100) : 0;
      children.push(text(
        `${medals[i]} **<@${e.author_id}>** — **${e.total_points}** pts · ${e.prediction_count} pred · ${hitRate}% hit`
      ));
    }

    if (entries.length > 3) {
      children.push(separator(0));

      for (let i = 3; i < entries.length; i++) {
        const e = entries[i];
        const hitRate = e.resolved > 0 ? Math.round((e.hits / e.resolved) * 100) : 0;
        children.push(text(
          `\`#${i + 1}\` <@${e.author_id}> · ${e.prediction_count} pred · ${hitRate}% hit · **${e.total_points}** pts`
        ));
      }
    }
  }

  children.push(separator());
  children.push(text('-# Updated in real-time · `/predict` to submit · `/mystats` for your stats'));

  return {
    components: [container(Colors.Leaderboard, children)],
    flags: 1 << 15,
  };
}

// ── Personal stats ───────────────────────────────────────────

export function buildStatsCard(stats, userId, monthLabel) {
  const children = [];

  children.push(text(`## 📊 Your Stats — ${monthLabel}`));
  children.push(separator());

  const hitRate = stats.resolved > 0 ? Math.round((stats.hits / stats.resolved) * 100) : 0;
  const avgRating = stats.avg_rating ? stats.avg_rating.toFixed(1) : '—';

  children.push(text([
    `**Total Points:** ${stats.total_points || 0}`,
    `**Predictions:** ${stats.prediction_count || 0}`,
    `**Hit Rate:** ${hitRate}% (${stats.hits || 0}/${stats.resolved || 0} resolved)`,
    `**Avg Quality:** ${avgRating} ⭐`,
    `**Rank:** ${stats.rank ? `#${stats.rank} of ${stats.total_entries}` : 'Unranked'}`,
  ].join('\n')));

  children.push(separator());
  children.push(text('-# Points = quality stars (1/3/5) + hit bonus (+10)'));

  return {
    components: [container(Colors.Stats, children)],
    flags: 1 << 15,
  };
}

// ── Delete confirmation ──────────────────────────────────────

export function buildDeleteConfirm(predictionId) {
  return {
    components: [
      container(Colors.Fail, [
        text('**⚠️ Confirm Deletion**'),
        text('This will permanently remove this prediction from the database and delete the public embed.'),
        actionRow(
          button(`confirm_delete:${predictionId}`, 'Yes, Delete', ButtonStyle.Danger),
          button(`cancel_delete:${predictionId}`, 'Cancel', ButtonStyle.Secondary),
        ),
      ]),
    ],
    flags: (1 << 15) | (1 << 6),
  };
}
