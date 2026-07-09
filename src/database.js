import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, '..', 'data', 'predictions.db');

// Ensure data directory exists
import { mkdirSync } from 'fs';
mkdirSync(resolve(__dirname, '..', 'data'), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id       TEXT PRIMARY KEY,
    upshot_url       TEXT NOT NULL,
    wallet_address   TEXT,
    linked_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id           TEXT NOT NULL,
    title               TEXT NOT NULL,
    category            TEXT NOT NULL,
    description         TEXT NOT NULL,
    deadline            TEXT NOT NULL,
    card_id             TEXT,                              -- Upshot card ID (cm...)
    card_image          TEXT,                              -- Arweave image URL
    ownership_check     TEXT,                              -- API pre-check result: 'verified' | 'not_found' | 'error' | NULL
    proof_type          TEXT NOT NULL DEFAULT 'none',      -- 'tweet' | 'none'
    tweet_url           TEXT,
    images              TEXT NOT NULL DEFAULT '[]',        -- JSON array of filenames (saved to disk)
    status              TEXT NOT NULL DEFAULT 'pending_verification',
    star_rating         INTEGER,
    outcome             TEXT,                              -- 'hit' | 'fail' | NULL
    total_points        INTEGER NOT NULL DEFAULT 0,
    ownership_verified  INTEGER NOT NULL DEFAULT 0,
    verified_by         TEXT,
    verified_at         TEXT,
    rated_by            TEXT,
    resolved_by         TEXT,
    embed_message_id    TEXT,
    admin_message_id    TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    month_key           TEXT NOT NULL                      -- e.g. '2026-03'
  );

  CREATE INDEX IF NOT EXISTS idx_predictions_author ON predictions(author_id);
  CREATE INDEX IF NOT EXISTS idx_predictions_month ON predictions(month_key);
  CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions(status);
  -- hasUnresolvedPredictionForCard runs on every new prediction; auto-resolve
  -- sweeps unresolved cards. Both filter by card_id — index it.
  CREATE INDEX IF NOT EXISTS idx_predictions_card ON predictions(card_id);

  CREATE TABLE IF NOT EXISTS bot_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS community_votes (
    prediction_id  INTEGER NOT NULL,
    voter_id       TEXT NOT NULL,
    stars          INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 3),
    voted_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (prediction_id, voter_id),
    FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_votes_prediction ON community_votes(prediction_id);

  -- Each row = one month a user finished in the leaderboard top 10.
  -- A user's tier is COUNT(*) of their rows here (cumulative, stacking).
  -- PK on (discord_id, month_key) makes re-processing a month idempotent.
  CREATE TABLE IF NOT EXISTS tier_awards (
    discord_id  TEXT NOT NULL,
    month_key   TEXT NOT NULL,
    rank        INTEGER NOT NULL,
    awarded_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (discord_id, month_key)
  );

  CREATE INDEX IF NOT EXISTS idx_tier_awards_user ON tier_awards(discord_id);

  -- Pack giveaways (Discord-native, button-entry). Distinct from the on-chain
  -- "Lucky Shots" raffle watcher: these are run by an admin from their own pack
  -- inventory and auto-transferred to the winner(s) when the timer ends.
  CREATE TABLE IF NOT EXISTS giveaways (
    id              TEXT PRIMARY KEY,
    guild_id        TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    message_id      TEXT,                              -- the live embed message
    creator_id      TEXT NOT NULL,                     -- admin who owns the packs
    pack_id         TEXT NOT NULL,
    pack_name       TEXT NOT NULL,
    winners_count   INTEGER NOT NULL DEFAULT 1,
    description     TEXT,
    required_roles  TEXT NOT NULL DEFAULT '[]',        -- JSON: entrant must have ANY of these
    excluded_roles  TEXT NOT NULL DEFAULT '[]',        -- JSON: entrant must have NONE of these
    excluded_users  TEXT NOT NULL DEFAULT '[]',        -- JSON: barred discord ids
    require_prediction INTEGER NOT NULL DEFAULT 0,     -- 1 = must have ≥1 prediction ever
    ends_at         TEXT NOT NULL,                     -- ISO timestamp
    status          TEXT NOT NULL DEFAULT 'live',      -- 'live' | 'drawn' | 'cancelled'
    winner_ids      TEXT NOT NULL DEFAULT '[]',        -- JSON: discord ids drawn
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways(status);

  CREATE TABLE IF NOT EXISTS giveaway_entries (
    giveaway_id  TEXT NOT NULL,
    discord_id   TEXT NOT NULL,
    entered_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (giveaway_id, discord_id),
    FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
  );

  -- Admin-defined achievement badges. A badge is earned by having at least
  -- required_lineups total lineup entries SUMMED across the contests listed in
  -- contest_ids (a JSON array of Upshot contest IDs). The 12h sweep is add-only:
  -- once earned a badge is permanent (see user_badges).
  CREATE TABLE IF NOT EXISTS badge_defs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    emoji             TEXT,                              -- display icon (unicode or <:name:id>)
    description       TEXT,
    contest_ids       TEXT NOT NULL DEFAULT '[]',        -- JSON array of Upshot contest IDs
    required_lineups  INTEGER NOT NULL DEFAULT 1,
    created_by        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Each row = one badge held by one user. UNIQUE keeps the sweep idempotent.
  -- source: 'auto' (granted by the sweep) | 'manual' (admin grant). Deleting a
  -- badge_defs row cascades here, so removing a definition strips it from all
  -- users' stats.
  CREATE TABLE IF NOT EXISTS user_badges (
    discord_id   TEXT NOT NULL,
    badge_id     INTEGER NOT NULL,
    source       TEXT NOT NULL DEFAULT 'auto',
    awarded_by   TEXT,
    awarded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (discord_id, badge_id),
    FOREIGN KEY (badge_id) REFERENCES badge_defs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(discord_id);

  -- Forward-only message activity counter, per guild+user. Discord exposes no
  -- historical message count, so this is populated by the messageCreate listener
  -- from the moment the feature ships — counts/last-seen are "since tracking began".
  -- Used by the /shotcallers monitoring panel to spot members who went AFK.
  CREATE TABLE IF NOT EXISTS message_activity (
    guild_id        TEXT NOT NULL,
    discord_id      TEXT NOT NULL,
    message_count   INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT,
    last_channel_id TEXT,
    PRIMARY KEY (guild_id, discord_id)
  );
`);

// ── Migrations (add columns to existing tables) ─────────────
try { db.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE predictions ADD COLUMN card_id TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE predictions ADD COLUMN card_image TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE predictions ADD COLUMN ownership_check TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE predictions ADD COLUMN community_star_avg REAL'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE giveaways ADD COLUMN require_prediction INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists / table absent */ }

// ── User queries ────────────────────────────────────────────

export function linkUpshot(discordId, upshotUrl, walletAddress = null) {
  const stmt = db.prepare(`
    INSERT INTO users (discord_id, upshot_url, wallet_address)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET upshot_url = excluded.upshot_url, wallet_address = COALESCE(excluded.wallet_address, wallet_address), linked_at = datetime('now')
  `);
  return stmt.run(discordId, upshotUrl, walletAddress);
}

export function getUpshotProfile(discordId) {
  return db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
}

export function getProfileByWallet(walletAddress) {
  return db.prepare('SELECT * FROM users WHERE wallet_address = ?').get(walletAddress);
}

export function getProfileByUrl(upshotUrl) {
  return db.prepare('SELECT * FROM users WHERE upshot_url = ?').get(upshotUrl);
}

export function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY linked_at DESC').all();
}

export function getDbPath() {
  return dbPath;
}

// ── Prediction CRUD ─────────────────────────────────────────

export function createPrediction({ authorId, title, category, description, deadline, proofType, tweetUrl, images, status, cardId, cardImage, ownershipCheck }) {
  // Assign month_key from the deadline so predictions count toward the month they resolve in.
  // Falls back to current month if deadline is missing or 'TBD'.
  let monthKey;
  if (deadline && deadline !== 'TBD' && deadline.match(/^\d{4}-\d{2}/)) {
    monthKey = deadline.slice(0, 7); // 'YYYY-MM'
  } else {
    const now = new Date();
    monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  const initialStatus = status || 'pending_verification';

  const stmt = db.prepare(`
    INSERT INTO predictions (author_id, title, category, description, deadline, proof_type, tweet_url, images, status, month_key, card_id, card_image, ownership_check)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(authorId, title, category, description, deadline, proofType, tweetUrl || null, JSON.stringify(images || []), initialStatus, monthKey, cardId || null, cardImage || null, ownershipCheck || null);
  return getPrediction(result.lastInsertRowid);
}

export function getPrediction(id) {
  const row = db.prepare('SELECT * FROM predictions WHERE id = ?').get(id);
  if (row) row.images = JSON.parse(row.images);
  return row;
}

export function updatePrediction(id, updates) {
  const allowed = [
    'title', 'category', 'description', 'deadline', 'tweet_url', 'images',
    'status', 'star_rating', 'outcome', 'total_points',
    'ownership_verified', 'verified_by', 'verified_at',
    'rated_by', 'resolved_by',
    'embed_message_id', 'admin_message_id', 'proof_type',
    'card_id', 'card_image', 'ownership_check', 'community_star_avg', 'month_key',
  ];

  const entries = Object.entries(updates).filter(([k]) => allowed.includes(k));
  if (entries.length === 0) return;

  // Serialize images if present
  const processedEntries = entries.map(([k, v]) => {
    if (k === 'images' && Array.isArray(v)) return [k, JSON.stringify(v)];
    return [k, v];
  });

  const setClause = processedEntries.map(([k]) => `${k} = ?`).join(', ');
  const values = processedEntries.map(([, v]) => v);

  db.prepare(`UPDATE predictions SET ${setClause} WHERE id = ?`).run(...values, id);
  return getPrediction(id);
}

export function deletePrediction(id) {
  return db.prepare('DELETE FROM predictions WHERE id = ?').run(id);
}


export function countUserDailyPredictions(authorId) {
  const today = new Date().toISOString().split('T')[0];
  return db.prepare(
    "SELECT COUNT(*) as count FROM predictions WHERE author_id = ? AND date(created_at) = ?"
  ).get(authorId, today).count;
}

export function getLeaderboard(monthKey, limit = 20) {
  return db.prepare(`
    SELECT
      author_id,
      SUM(CASE WHEN outcome IS NOT NULL THEN total_points ELSE 0 END) as total_points,
      COUNT(*) as prediction_count,
      SUM(CASE WHEN outcome = 'hit' THEN 1 ELSE 0 END) as hits,
      SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) as fails,
      SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved
    FROM predictions
    WHERE month_key = ? AND star_rating IS NOT NULL
    GROUP BY author_id
    ORDER BY total_points DESC
    LIMIT ?
  `).all(monthKey, limit);
}

// ── Tier awards (top-10 leaderboard tiers) ──────────────────

// Record that `discordId` placed top 10 in `monthKey`. Idempotent: a month is
// only ever counted once per user. Returns true if this was a NEW award.
export function recordTierAward(discordId, monthKey, rank) {
  const res = db.prepare(
    'INSERT OR IGNORE INTO tier_awards (discord_id, month_key, rank) VALUES (?, ?, ?)'
  ).run(discordId, monthKey, rank);
  return res.changes > 0;
}

// A user's tier = how many distinct months they've placed top 10.
export function getUserTier(discordId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tier_awards WHERE discord_id = ?').get(discordId);
  return row?.n ?? 0;
}

// True if this user has ever created a prediction (used by giveaway eligibility).
export function hasAnyPrediction(discordId) {
  return !!db.prepare('SELECT 1 FROM predictions WHERE author_id = ? LIMIT 1').get(discordId);
}

export function hasUnresolvedPredictionForCard(cardId) {
  const row = db.prepare(
    "SELECT id, author_id, title, embed_message_id FROM predictions WHERE card_id = ? AND outcome IS NULL LIMIT 1"
  ).get(cardId);
  return row || null;
}

export function getUserStats(authorId, monthKey) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as prediction_count,
      SUM(CASE WHEN outcome IS NOT NULL THEN total_points ELSE 0 END) as total_points,
      SUM(CASE WHEN outcome = 'hit' THEN 1 ELSE 0 END) as hits,
      SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) as fails,
      SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved,
      AVG(star_rating) as avg_rating
    FROM predictions
    WHERE author_id = ? AND month_key = ?
  `).get(authorId, monthKey);

  // Get rank
  const leaderboard = getLeaderboard(monthKey, 1000);
  const rank = leaderboard.findIndex(e => e.author_id === authorId) + 1;

  return { ...stats, rank: rank || null, total_entries: leaderboard.length };
}

export function getUserMonthScoredPredictions(authorId, monthKey) {
  return db.prepare(`
    SELECT id, title, star_rating, outcome, total_points, deadline, status
    FROM predictions
    WHERE author_id = ? AND month_key = ? AND star_rating IS NOT NULL
    ORDER BY total_points DESC, id DESC
  `).all(authorId, monthKey);
}

export function getPendingVerificationPredictions() {
  const rows = db.prepare(
    "SELECT * FROM predictions WHERE status = 'pending_verification' AND ownership_verified = 0 AND card_id IS NOT NULL ORDER BY created_at ASC"
  ).all();
  return rows.map(r => ({ ...r, images: JSON.parse(r.images) }));
}

export function getUnratedVerifiedPredictions() {
  const rows = db.prepare(
    "SELECT * FROM predictions WHERE status = 'pending_review' AND ownership_verified = 1 AND star_rating IS NULL ORDER BY created_at ASC"
  ).all();
  return rows.map(r => ({ ...r, images: JSON.parse(r.images) }));
}

// Active (unresolved) predictions that already have a star rating — used by
// /setup recheck-all-ratings to re-evaluate the AI rating before they resolve.
export function getRatedActivePredictions() {
  const rows = db.prepare(
    'SELECT * FROM predictions WHERE star_rating IS NOT NULL AND outcome IS NULL ORDER BY created_at ASC'
  ).all();
  return rows.map(r => ({ ...r, images: JSON.parse(r.images) }));
}

export function countUserUnresolved(authorId) {
  return db.prepare(
    "SELECT COUNT(*) as count FROM predictions WHERE author_id = ? AND status = 'rated' AND outcome IS NULL"
  ).get(authorId).count;
}

export function getUserOpenPredictions(authorId) {
  const rows = db.prepare(
    "SELECT * FROM predictions WHERE author_id = ? AND status = 'rated' AND outcome IS NULL ORDER BY created_at DESC"
  ).all(authorId);
  return rows.map(r => ({ ...r, images: JSON.parse(r.images) }));
}

export function getUserUnresolvedPredictions(authorId) {
  const rows = db.prepare(
    "SELECT * FROM predictions WHERE author_id = ? AND outcome IS NULL ORDER BY deadline ASC"
  ).all(authorId);
  return rows.map(r => ({ ...r, images: JSON.parse(r.images) }));
}

export function getUnresolvedRatedPredictions() {
  const rows = db.prepare(
    "SELECT * FROM predictions WHERE status = 'rated' AND outcome IS NULL AND card_id IS NOT NULL ORDER BY created_at ASC"
  ).all();
  return rows.map(r => ({ ...r, images: JSON.parse(r.images) }));
}

export function getResolvedCount() {
  return db.prepare(
    "SELECT COUNT(*) as count FROM predictions WHERE outcome IS NOT NULL"
  ).get().count;
}

export function getUnresolvedCount() {
  return db.prepare(
    "SELECT COUNT(*) as count FROM predictions WHERE status = 'rated' AND outcome IS NULL"
  ).get().count;
}

export function getLeaderboardMessageId(guildId) {
  const row = db.prepare("SELECT value FROM bot_state WHERE key = ?").get(`leaderboard_msg_${guildId}`);
  return row?.value;
}

export function setLeaderboardMessageId(guildId, messageId) {
  db.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(`leaderboard_msg_${guildId}`, messageId);
}

// ── Prediction panels (tracked so layout changes can be re-rendered) ──

export function getPanels(guildId) {
  const row = db.prepare("SELECT value FROM bot_state WHERE key = ?").get(`panels_${guildId}`);
  return row?.value ? JSON.parse(row.value) : [];
}

export function addPanel(guildId, channelId, messageId) {
  const panels = getPanels(guildId).filter(p => p.messageId !== messageId);
  panels.push({ channelId, messageId });
  db.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(`panels_${guildId}`, JSON.stringify(panels));
}

export function removePanel(guildId, messageId) {
  const panels = getPanels(guildId).filter(p => p.messageId !== messageId);
  db.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(`panels_${guildId}`, JSON.stringify(panels));
}

// ── Contest watcher state (which contests we've already announced) ──
// Stored per guild as a JSON map: { _v, [contestId]: { status, announcedLive,
// announcedDone } }. Returns null when never initialized — the watcher uses that
// to seed silently on first run instead of announcing the whole backlog.
export function getContestWatchState(guildId) {
  const row = db.prepare("SELECT value FROM bot_state WHERE key = ?").get(`contests_watch_${guildId}`);
  return row?.value ? JSON.parse(row.value) : null;
}

export function setContestWatchState(guildId, state) {
  db.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(`contests_watch_${guildId}`, JSON.stringify(state));
}

// Lucky Shots (raffle) watcher state — same shape/semantics as the event watcher.
// { [raffleId]: { status, announcedLive, announcedDrawn } }; null until seeded.
export function getRaffleWatchState(guildId) {
  const row = db.prepare("SELECT value FROM bot_state WHERE key = ?").get(`raffles_watch_${guildId}`);
  return row?.value ? JSON.parse(row.value) : null;
}

export function setRaffleWatchState(guildId, state) {
  db.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(`raffles_watch_${guildId}`, JSON.stringify(state));
}

// Store watcher state — { _v, [itemId]: { status, announcedListed } }; null until seeded.
export function getStoreWatchState(guildId) {
  const row = db.prepare("SELECT value FROM bot_state WHERE key = ?").get(`store_watch_${guildId}`);
  return row?.value ? JSON.parse(row.value) : null;
}

export function setStoreWatchState(guildId, state) {
  db.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(`store_watch_${guildId}`, JSON.stringify(state));
}

// ── Pack giveaways ──────────────────────────────────────────

function hydrateGiveaway(row) {
  if (!row) return null;
  return {
    ...row,
    required_roles: JSON.parse(row.required_roles || '[]'),
    excluded_roles: JSON.parse(row.excluded_roles || '[]'),
    excluded_users: JSON.parse(row.excluded_users || '[]'),
    winner_ids: JSON.parse(row.winner_ids || '[]'),
    require_prediction: !!row.require_prediction,
  };
}

export function createGiveaway(g) {
  db.prepare(`
    INSERT INTO giveaways (id, guild_id, channel_id, creator_id, pack_id, pack_name,
      winners_count, description, required_roles, excluded_roles, excluded_users, require_prediction, ends_at)
    VALUES (@id, @guild_id, @channel_id, @creator_id, @pack_id, @pack_name,
      @winners_count, @description, @required_roles, @excluded_roles, @excluded_users, @require_prediction, @ends_at)
  `).run({
    id: g.id,
    guild_id: g.guildId,
    channel_id: g.channelId,
    creator_id: g.creatorId,
    pack_id: g.packId,
    pack_name: g.packName,
    winners_count: g.winnersCount,
    description: g.description || null,
    required_roles: JSON.stringify(g.requiredRoles || []),
    excluded_roles: JSON.stringify(g.excludedRoles || []),
    excluded_users: JSON.stringify(g.excludedUsers || []),
    require_prediction: g.requirePrediction ? 1 : 0,
    ends_at: g.endsAt,
  });
  return getGiveaway(g.id);
}

export function getGiveaway(id) {
  return hydrateGiveaway(db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id));
}

export function setGiveawayMessageId(id, messageId) {
  db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?').run(messageId, id);
}

export function setGiveawayStatus(id, status) {
  db.prepare('UPDATE giveaways SET status = ? WHERE id = ?').run(status, id);
}

export function setGiveawayWinners(id, winnerIds) {
  db.prepare('UPDATE giveaways SET winner_ids = ?, status = ? WHERE id = ?')
    .run(JSON.stringify(winnerIds || []), 'drawn', id);
}

// Live giveaways whose timer has elapsed — the draw sweep picks these up.
export function getDueGiveaways(nowIso) {
  return db.prepare("SELECT * FROM giveaways WHERE status = 'live' AND ends_at <= ?")
    .all(nowIso).map(hydrateGiveaway);
}

export function addGiveawayEntry(giveawayId, discordId) {
  const res = db.prepare(
    'INSERT OR IGNORE INTO giveaway_entries (giveaway_id, discord_id) VALUES (?, ?)'
  ).run(giveawayId, discordId);
  return res.changes > 0; // true = newly entered, false = already in
}

export function getGiveawayEntries(giveawayId) {
  return db.prepare('SELECT discord_id FROM giveaway_entries WHERE giveaway_id = ?')
    .all(giveawayId).map(r => r.discord_id);
}

export function countGiveawayEntries(giveawayId) {
  return db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?')
    .get(giveawayId).n;
}

// ── Config (DB-backed, overrides .env) ──────────────────────

export function getConfig(guildId, key) {
  const row = db.prepare("SELECT value FROM bot_state WHERE key = ?").get(`config_${guildId}_${key}`);
  return row?.value ?? null;
}

export function setConfig(guildId, key, value) {
  db.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(`config_${guildId}_${key}`, String(value));
}

export function getAllConfig(guildId) {
  const rows = db.prepare("SELECT key, value FROM bot_state WHERE key LIKE ?").all(`config_${guildId}_%`);
  const config = {};
  for (const row of rows) {
    const key = row.key.replace(`config_${guildId}_`, '');
    config[key] = row.value;
  }
  return config;
}

// ── Categories ──────────────────────────────────────────────

export function getCategories(guildId) {
  const raw = getConfig(guildId, 'categories');
  return raw ? JSON.parse(raw) : null;
}

export function setCategories(guildId, categories) {
  setConfig(guildId, 'categories', JSON.stringify(categories));
}

export function addCategory(guildId, category) {
  const current = getCategories(guildId) || [];
  if (!current.find(c => c.toLowerCase() === category.toLowerCase())) {
    current.push(category);
    setCategories(guildId, current);
  }
  return current;
}

// ── Community votes ──────────────────────────────────────────

export function upsertCommunityVote(predictionId, voterId, stars) {
  const upsert = db.prepare(`
    INSERT INTO community_votes (prediction_id, voter_id, stars)
    VALUES (?, ?, ?)
    ON CONFLICT(prediction_id, voter_id) DO UPDATE SET stars = excluded.stars, voted_at = datetime('now')
  `);
  const updateAvg = db.prepare(`
    UPDATE predictions
    SET community_star_avg = (SELECT AVG(stars) FROM community_votes WHERE prediction_id = ?)
    WHERE id = ?
  `);
  const txn = db.transaction(() => {
    upsert.run(predictionId, voterId, stars);
    updateAvg.run(predictionId, predictionId);
  });
  try {
    txn();
  } catch (err) {
    console.error('Community vote transaction failed:', err.message);
    throw err;
  }
  return getPrediction(predictionId);
}

export function getCommunityVoteSummary(predictionId) {
  return db.prepare(`
    SELECT COUNT(*) as count, AVG(stars) as avg
    FROM community_votes WHERE prediction_id = ?
  `).get(predictionId);
}

// ── Reset / Delete functions ──────────────────────────────────

export function resetUser(authorId, monthKey) {
  return db.prepare(
    'DELETE FROM predictions WHERE author_id = ? AND month_key = ?'
  ).run(authorId, monthKey);
}

export function resetAllUsers(monthKey) {
  return db.prepare(
    'DELETE FROM predictions WHERE month_key = ?'
  ).run(monthKey);
}

export function deleteLastPrediction(authorId) {
  const last = db.prepare(
    'SELECT id FROM predictions WHERE author_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(authorId);
  if (!last) return { changes: 0, id: null };
  db.prepare('DELETE FROM predictions WHERE id = ?').run(last.id);
  return { changes: 1, id: last.id };
}

export function deleteUserProfile(discordId) {
  return db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);
}

export function deleteAllProfiles() {
  return db.prepare('DELETE FROM users').run();
}

export function removeCategory(guildId, category) {
  const current = getCategories(guildId) || [];
  const filtered = current.filter(c => c.toLowerCase() !== category.toLowerCase());
  setCategories(guildId, filtered);
  return filtered;
}

// ── Badges ──────────────────────────────────────────────────

function hydrateBadgeDef(row) {
  if (!row) return null;
  return { ...row, contest_ids: JSON.parse(row.contest_ids || '[]') };
}

export function createBadgeDef({ name, emoji, description, contestIds, requiredLineups, createdBy }) {
  const res = db.prepare(`
    INSERT INTO badge_defs (name, emoji, description, contest_ids, required_lineups, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    emoji || null,
    description || null,
    JSON.stringify(contestIds || []),
    requiredLineups,
    createdBy || null,
  );
  return getBadgeDef(res.lastInsertRowid);
}

export function getBadgeDef(id) {
  return hydrateBadgeDef(db.prepare('SELECT * FROM badge_defs WHERE id = ?').get(id));
}

export function getAllBadgeDefs() {
  return db.prepare('SELECT * FROM badge_defs ORDER BY created_at DESC').all().map(hydrateBadgeDef);
}

// Cascades to user_badges (FK ON DELETE CASCADE), so awarded badges vanish too.
export function deleteBadgeDef(id) {
  return db.prepare('DELETE FROM badge_defs WHERE id = ?').run(id);
}

// Grant a badge to a user. Idempotent on (discord_id, badge_id): an existing
// row is left untouched (its source is preserved — a manual grant is never
// downgraded to auto). Returns true only if a NEW row was inserted.
export function grantBadge(discordId, badgeId, { source = 'auto', awardedBy = null } = {}) {
  const res = db.prepare(`
    INSERT OR IGNORE INTO user_badges (discord_id, badge_id, source, awarded_by)
    VALUES (?, ?, ?, ?)
  `).run(discordId, badgeId, source, awardedBy);
  return res.changes > 0;
}

export function revokeBadge(discordId, badgeId) {
  return db.prepare('DELETE FROM user_badges WHERE discord_id = ? AND badge_id = ?')
    .run(discordId, badgeId);
}

export function userHasBadge(discordId, badgeId) {
  return !!db.prepare('SELECT 1 FROM user_badges WHERE discord_id = ? AND badge_id = ?')
    .get(discordId, badgeId);
}

// All badge definitions a user currently holds, with award metadata. Ordered by
// when the definition was created so display is stable.
export function getUserBadges(discordId) {
  return db.prepare(`
    SELECT b.*, ub.source, ub.awarded_at
    FROM user_badges ub
    JOIN badge_defs b ON b.id = ub.badge_id
    WHERE ub.discord_id = ?
    ORDER BY b.created_at ASC
  `).all(discordId).map(hydrateBadgeDef);
}

export function countBadgeHolders(badgeId) {
  return db.prepare('SELECT COUNT(*) AS n FROM user_badges WHERE badge_id = ?').get(badgeId).n;
}

// Everyone holding a given badge, newest award first. Each row: discord_id,
// source ('auto'|'manual'), awarded_by, awarded_at.
export function getBadgeHolders(badgeId) {
  return db.prepare(
    'SELECT discord_id, source, awarded_by, awarded_at FROM user_badges WHERE badge_id = ? ORDER BY awarded_at DESC'
  ).all(badgeId);
}

// ── Message activity (forward-only, for /shotcallers) ───────

// Bump a user's message counter and stamp when/where they last spoke. Called on
// every guild message; the first message for a user seeds the row at count 1.
// Also records, once per guild, when tracking began so the panel can be honest
// about the window the counts cover.
export function recordMessage(guildId, discordId, channelId) {
  db.prepare(`
    INSERT INTO message_activity (guild_id, discord_id, message_count, last_message_at, last_channel_id)
    VALUES (?, ?, 1, datetime('now'), ?)
    ON CONFLICT(guild_id, discord_id) DO UPDATE SET
      message_count = message_count + 1,
      last_message_at = datetime('now'),
      last_channel_id = excluded.last_channel_id
  `).run(guildId, discordId, channelId || null);
  db.prepare(
    "INSERT OR IGNORE INTO bot_state (key, value) VALUES (?, datetime('now'))"
  ).run(`msg_tracking_since_${guildId}`);
}

export function getMessageActivity(guildId, discordId) {
  return db.prepare(
    'SELECT * FROM message_activity WHERE guild_id = ? AND discord_id = ?'
  ).get(guildId, discordId) || null;
}

// When message tracking first started for this guild (set on the first recorded
// message). Null until then. Lets the panel state "since <date>" plainly.
export function getMessageTrackingSince(guildId) {
  const row = db.prepare('SELECT value FROM bot_state WHERE key = ?').get(`msg_tracking_since_${guildId}`);
  return row?.value || null;
}

export default db;
