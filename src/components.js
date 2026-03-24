import {
  ComponentType as CT, ButtonStyle, Colors, Points,
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
  children.push(actionRow(
    button('panel_predict', '🔮 Make a Prediction', ButtonStyle.Primary),
  ));

  return {
    components: [container(Colors.Leaderboard, children)],
    flags: 1 << 15,
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
  children.push(text(`${prediction.category} · <@${prediction.author_id}> · ${profileLink} · Deadline: ${prediction.deadline}`));

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
  if (prediction.ownership_check === 'verified') {
    proofParts.push('🤖 API: card ownership confirmed');
  }
  if (prediction.tweet_url) {
    proofParts.push(`📎 [Tweet Proof](${prediction.tweet_url})`);
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
      const parts = [`+${starPoints(prediction.star_rating)} quality`, '+10 hit bonus'];
      if (prediction.tweet_url) parts.push(`+${Points.TweetBonus} tweet bonus`);
      pointsLine = `${stars} **${prediction.total_points} pts awarded** (${parts.join(', ')})`;
    } else if (prediction.outcome === 'fail') {
      pointsLine = `${stars} **${prediction.total_points} pts awarded** (quality only)`;
    }

    children.push(text(pointsLine));
  }

  // Footer
  const id = String(prediction.id).padStart(4, '0');
  const date = prediction.created_at?.split('T')[0] || prediction.created_at?.split(' ')[0] || '';
  children.push(text(`-# ID \`#${id}\` · ${date}`));

  // Action buttons
  const btns = [];
  if (prediction.description.length > 280) {
    btns.push(button(`read_more:${prediction.id}`, '📖 Read More', ButtonStyle.Secondary));
  }
  if ([Status.PendingVerification, Status.PendingReview].includes(prediction.status)) {
    btns.push(button(`edit_prediction:${prediction.id}`, '✏ Edit', ButtonStyle.Secondary));
  }
  if (btns.length > 0) {
    children.push(actionRow(...btns));
  }

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
  if (prediction.ownership_check === 'verified') {
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
  children.push(text('-# Points = quality stars (1/3/5) + hit bonus (+10) + tweet bonus (+1)'));

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
