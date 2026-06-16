// Component types for Discord Components v2
export const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  RoleSelect: 6,
  ChannelSelect: 8,
  Section: 9,
  TextDisplay: 10,
  Thumbnail: 11,
  MediaGallery: 12,
  Separator: 14,
  File: 16,
  Container: 17,
};

// Button styles
export const ButtonStyle = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
  Link: 5,
};

// Colors (decimal)
export const Colors = {
  Pending: 0x3498db,    // Blue
  Verified: 0xf39c12,   // Yellow/amber — verified ownership, awaiting rating
  Hit: 0x2ecc71,        // Green
  Fail: 0xe74c3c,       // Red
  Admin: 0x9b59b6,      // Purple
  Leaderboard: 0xf1c40f, // Gold
  Stats: 0x3498db,      // Blue
  Gold: 0xffd700,
  Silver: 0xc0c0c0,
  Bronze: 0xcd7f32,
};

// Point values
export const Points = {
  Star0: 0,
  Star1: 1,
  Star2: 3,
  Star3: 5,
  HitBonus: 10,
  TweetBonus: 1,
};

// Prediction statuses
export const Status = {
  PendingVerification: 'pending_verification',
  PendingReview: 'pending_review',
  Rated: 'rated',
  Hit: 'hit',
  Fail: 'fail',
};

// Default categories (used if none configured via /setup)
export const DefaultCategories = ['DeFi', 'NFTs', 'L1-L2', 'Gaming', 'Macro'];

// A prediction is "rated" once it has a star value — including 0. Because 0 is
// falsy in JS, never test `prediction.star_rating` for truthiness; use this.
export function isRated(prediction) {
  return prediction != null && prediction.star_rating != null;
}

export function starPoints(stars) {
  return [Points.Star0, Points.Star1, Points.Star2, Points.Star3][stars] ?? 0;
}

// Visual for a star value. 0 = low-effort, shown with a distinct badge so it can
// never be mistaken for an unrated prediction. null/undefined = not yet rated.
export function renderStars(stars) {
  if (stars == null) return '—';
  if (stars <= 0) return '🚫 0★';
  return '⭐'.repeat(stars) + '☆'.repeat(3 - stars);
}

export function weightedStarRating(adminStars, communityAvg) {
  const admin = Math.max(0, Math.min(3, adminStars ?? 0));
  // 0★ is a deliberate low-effort call — community votes can't rescue it.
  if (admin === 0) return 0;
  if (!communityAvg || communityAvg === 0) return admin;
  const community = Math.max(0, Math.min(3, communityAvg));
  const weighted = admin * 0.7 + community * 0.3;
  return Math.max(1, Math.min(3, Math.round(weighted)));
}

export function totalPoints(stars, outcome, hasTweet = false) {
  // Low-effort (0★) submissions earn nothing — no quality, hit, or tweet points.
  if (!stars || stars <= 0) return 0;
  const base = starPoints(stars);
  const hitBonus = outcome === 'hit' ? Points.HitBonus : 0;
  const tweetBonus = outcome === 'hit' && hasTweet ? Points.TweetBonus : 0;
  return base + hitBonus + tweetBonus;
}

export function statusLabel(status) {
  switch (status) {
    case Status.PendingVerification: return '🟡 Pending Verification';
    case Status.PendingReview: return '🔵 Pending Review';
    case Status.Rated: return '🔵 Rated — Awaiting Outcome';
    case Status.Hit: return '🟢 Prediction Hit';
    case Status.Fail: return '🔴 Prediction Failed';
    default: return '⚪ Unknown';
  }
}

export function statusColor(status) {
  switch (status) {
    case Status.PendingVerification: return Colors.Verified;
    case Status.PendingReview: return Colors.Pending;
    case Status.Rated: return Colors.Pending;
    case Status.Hit: return Colors.Hit;
    case Status.Fail: return Colors.Fail;
    default: return Colors.Pending;
  }
}
