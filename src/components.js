import {
  ComponentType as CT, ButtonStyle, Colors, Points,
  statusLabel, statusColor, starPoints, weightedStarRating, Status,
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
    button('panel_help:0', '❓ How It Works', ButtonStyle.Secondary),
  ));

  return {
    components: [container(Colors.Leaderboard, children)],
    flags: 1 << 15,
  };
}

// ── Help pages (ephemeral, paginated) ─────────────────────────

const helpPages = [
  // Page 1 — Getting Started
  [
    '## Getting Started',
    '',
    '**1. Link your Upshot profile**',
    'Click "Make a Prediction" — if it\'s your first time, you\'ll be asked to paste your Upshot profile URL.',
    '',
    '**How to get your profile URL:**',
    'Go to [upshot.cards](https://upshot.cards), click **View Profile** (top-right), then copy the URL from your browser or click **Share Profile**.',
    '',
    '**2. Submit a prediction**',
    'Fill out the form with your title, description, card URL, and optionally a tweet link.',
    '',
    'The bot automatically pulls the card image and deadline from Upshot, and verifies you own the card.',
  ].join('\n'),

  // Page 2 — Card URL & Tweet
  [
    '## Submitting Your Card',
    '',
    '**How to get your card URL:**',
    'On [upshot.cards](https://upshot.cards), click any card you own to open it, then copy the URL from your browser or click the **Share** button.',
    '',
    '**What happens after you submit:**',
    '- The bot fetches the card image and deadline automatically',
    '- It checks if your wallet actually owns the card',
    '- Your prediction is posted to the feed and sent for admin review',
    '',
    '**Tweet URL (optional)**',
    'Link a tweet about your prediction for a **+1 bonus point** if it hits. Must be from twitter.com or x.com.',
  ].join('\n'),

  // Page 3 — Points & Community Voting
  [
    '## Points & Community Voting',
    '',
    '**Admin rates quality (1-3 stars)**',
    '⭐ 1 star = 1 pt · ⭐⭐ 2 stars = 3 pts · ⭐⭐⭐ 3 stars = 5 pts',
    '',
    '**Community voting**',
    'Every prediction has vote buttons — rate others\' predictions 1-3 stars! You can\'t vote on your own. The final quality rating is:',
    '- **70% admin** + **30% community average**',
    '- You can change your vote at any time',
    '',
    '**Outcome Bonuses**',
    '🟢 Prediction hits = **+10 pts**',
    '📎 Tweet linked + hit = **+1 pt**',
    '🔴 Prediction fails = quality pts only',
    '',
    '-# Example: admin 3⭐, community avg 2⭐ → weighted 3⭐ (5pts) + hit (10) + tweet (1) = **16 pts**',
  ].join('\n'),

  // Page 4 — Rules & Tips
  [
    '## Rules & Tips',
    '',
    '- **1 prediction per day** — make it count',
    '- **Edit window** — you can edit within 1 hour of submitting',
    '- **Leaderboard** — resets monthly, top predictors earn rewards',
    '- **Card required** — every prediction must be backed by an Upshot card you own',
    '- **Auto-resolve** — outcomes are checked automatically via the Upshot API every 12h',
    '',
    '**Quick links**',
    '`/predict` — Submit via command',
    '`/mystats` — Check your stats and rank',
    '`/link-upshot` — Update your profile link',
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
  const children = [];
  children.push(text('## 🏅 Your Active Contests'));
  children.push(separator());

  for (let i = 0; i < contests.length; i++) {
    const c = contests[i];
    const lineupCount = c.lineups.length;
    const bestRank = Math.min(...c.lineups.map(l => l.rank));
    children.push(text(`**${c.contestName}**\n${lineupCount} lineup${lineupCount > 1 ? 's' : ''} · Best rank: #${bestRank}`));
  }

  children.push(separator());

  // One button per contest (max 5 per row)
  const btns = contests.map((c, i) =>
    button(`contest_select:${i}:0`, c.contestName.length > 40 ? c.contestName.slice(0, 37) + '...' : c.contestName, ButtonStyle.Primary)
  );
  for (let i = 0; i < btns.length; i += 5) {
    children.push(actionRow(...btns.slice(i, i + 5)));
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
    if (prediction.star_rating) {
      const effective = weightedStarRating(prediction.star_rating, prediction.community_star_avg);
      const adminStars = '⭐'.repeat(prediction.star_rating);
      children.push(text(`${communityLine} · Admin: ${adminStars} · Weighted: **${effective}**/3`));
    } else {
      children.push(text(communityLine));
    }
  }

  // Points display (if rated)
  if (prediction.star_rating) {
    const effective = weightedStarRating(prediction.star_rating, prediction.community_star_avg);
    const stars = '⭐'.repeat(effective) + '☆'.repeat(3 - effective);
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
  if (prediction.star_rating) {
    const effective = weightedStarRating(prediction.star_rating, prediction.community_star_avg);
    const stars = '⭐'.repeat(prediction.star_rating) + '☆'.repeat(3 - prediction.star_rating);
    statusInfo += ` · **Admin:** ${stars} · **Weighted:** ${effective}/3 (${starPoints(effective)} pts)`;
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
    buttons.push(button(`check_resolve:${prediction.id}`, '🔍 Check Resolution', ButtonStyle.Primary));
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
