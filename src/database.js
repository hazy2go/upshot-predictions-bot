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
`);

// ── Migrations (add columns to existing tables) ─────────────
try { db.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE predictions ADD COLUMN card_id TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE predictions ADD COLUMN card_image TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE predictions ADD COLUMN ownership_check TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE predictions ADD COLUMN community_star_avg REAL'); } catch { /* already exists */ }

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

export function getUserPredictions(authorId, monthKey) {
  const rows = db.prepare(
    'SELECT * FROM predictions WHERE author_id = ? AND month_key = ? ORDER BY created_at DESC'
  ).all(authorId, monthKey);
  return rows.map(r => ({ ...r, images: JSON.parse(r.images) }));
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
      SUM(total_points) as total_points,
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

export function hasUnresolvedPredictionForCard(cardId) {
  const row = db.prepare(
    "SELECT id, author_id FROM predictions WHERE card_id = ? AND outcome IS NULL LIMIT 1"
  ).get(cardId);
  return row || null;
}

export function getUserStats(authorId, monthKey) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as prediction_count,
      SUM(total_points) as total_points,
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

export function getPendingPredictions() {
  const rows = db.prepare(
    "SELECT * FROM predictions WHERE status IN ('pending_verification', 'pending_review', 'rated') ORDER BY created_at ASC"
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

/**
 * Find predictions stuck in 'awaiting_images' state longer than the timeout.
 * Used on bot startup to recover from restarts during image upload windows.
 */
export function getAwaitingImagePredictions(timeoutMs) {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const rows = db.prepare(
    "SELECT * FROM predictions WHERE status = 'awaiting_images' AND created_at < ?"
  ).all(cutoff);
  return rows.map(r => ({ ...r, images: JSON.parse(r.images) }));
}

/**
 * Mark a prediction as no longer awaiting images (used for timeout recovery).
 */
export function markImageTimeout(id) {
  db.prepare("UPDATE predictions SET status = 'pending_verification' WHERE id = ? AND status = 'awaiting_images'").run(id);
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

export default db;
