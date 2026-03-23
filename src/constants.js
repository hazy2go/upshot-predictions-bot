// Component types for Discord Components v2
export const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
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
  Star1: 1,
  Star2: 3,
  Star3: 5,
  HitBonus: 10,
};

// Prediction statuses
export const Status = {
  AwaitingImages: 'awaiting_images',
  PendingVerification: 'pending_verification',
  PendingReview: 'pending_review',
  Rated: 'rated',
  Hit: 'hit',
  Fail: 'fail',
};

// Categories
export const Categories = ['DeFi', 'NFTs', 'L1-L2', 'Gaming', 'Macro'];

// MessageFlags for Components v2
export const MESSAGE_FLAGS = {
  IsComponentsV2: 1 << 15,   // 32768
  Ephemeral: 1 << 6,          // 64
};

export function starPoints(stars) {
  return [0, Points.Star1, Points.Star2, Points.Star3][stars] || 0;
}

export function totalPoints(stars, outcome) {
  const base = starPoints(stars);
  const bonus = outcome === 'hit' ? Points.HitBonus : 0;
  return base + bonus;
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
