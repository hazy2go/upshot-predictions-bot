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
    linked_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id           TEXT NOT NULL,
    title               TEXT NOT NULL,
    category            TEXT NOT NULL,
    description         TEXT NOT NULL,
    deadline            TEXT NOT NULL,
    proof_type          TEXT NOT NULL DEFAULT 'images',   -- 'images' | 'tweet'
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
`);

// ── User queries ────────────────────────────────────────────

export function linkUpshot(discordId, upshotUrl) {
  const stmt = db.prepare(`
    INSERT INTO users (discord_id, upshot_url)
    VALUES (?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET upshot_url = excluded.upshot_url, linked_at = datetime('now')
  `);
  return stmt.run(discordId, upshotUrl);
}

export function getUpshotProfile(discordId) {
  return db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
}

// ── Prediction CRUD ─────────────────────────────────────────

export function createPrediction({ authorId, title, category, description, deadline, proofType, tweetUrl, images, status }) {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const initialStatus = status || 'pending_verification';

  const stmt = db.prepare(`
    INSERT INTO predictions (author_id, title, category, description, deadline, proof_type, tweet_url, images, status, month_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(authorId, title, category, description, deadline, proofType, tweetUrl || null, JSON.stringify(images || []), initialStatus, monthKey);
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

// ── Reset functions ──────────────────────────────────────────

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

export function removeCategory(guildId, category) {
  const current = getCategories(guildId) || [];
  const filtered = current.filter(c => c.toLowerCase() !== category.toLowerCase());
  setCategories(guildId, filtered);
  return filtered;
}

export default db;
