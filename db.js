const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const MEDIA_TTL_DAYS = 2;

let db;

function init(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      groupName     TEXT    NOT NULL,
      author        TEXT    NOT NULL,
      body          TEXT    NOT NULL,
      timestamp     INTEGER NOT NULL,
      media_type    TEXT,
      media_data    TEXT,
      location_data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp DESC);
  `);

  // Geçiş: eski DB'ye eksik kolonları ekle
  const cols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  if (!cols.includes('media_type'))    db.exec('ALTER TABLE messages ADD COLUMN media_type TEXT');
  if (!cols.includes('media_data'))    db.exec('ALTER TABLE messages ADD COLUMN media_data TEXT');
  if (!cols.includes('location_data')) db.exec('ALTER TABLE messages ADD COLUMN location_data TEXT');
  if (!cols.includes('contact_id'))    db.exec('ALTER TABLE messages ADD COLUMN contact_id TEXT');
  if (!cols.includes('chat_id'))       db.exec('ALTER TABLE messages ADD COLUMN chat_id TEXT');

  purgeOldMedia();
  return db;
}

function purgeOldMedia() {
  const cutoff = Math.floor(Date.now() / 1000) - MEDIA_TTL_DAYS * 86400;
  const result = db.prepare(
    'UPDATE messages SET media_data = NULL, media_type = NULL WHERE timestamp < ? AND media_data IS NOT NULL'
  ).run(cutoff);
  if (result.changes > 0)
    console.log(`[db] ${result.changes} eski medya temizlendi`);
}

function insert(groupName, author, body, timestamp, media = null, location = null, contactId = null, chatId = null) {
  db.prepare(`
    INSERT INTO messages (groupName, author, body, timestamp, media_type, media_data, location_data, contact_id, chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    groupName, author, body, timestamp,
    media?.mimetype ?? null,
    media?.data     ?? null,
    location        ? JSON.stringify(location) : null,
    contactId       ?? null,
    chatId          ?? null
  );
}

function getRecent(limit = 100) {
  return db
    .prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?')
    .all(limit)
    .reverse()
    .map(row => ({
      groupName:  row.groupName,
      author:     row.author,
      body:       row.body,
      timestamp:  row.timestamp,
      contactId:  row.contact_id  || null,
      chatId:     row.chat_id     || null,
      media:      row.media_type && row.media_data
                    ? { mimetype: row.media_type, data: row.media_data }
                    : null,
      location:   row.location_data ? JSON.parse(row.location_data) : null,
    }));
}

module.exports = { init, insert, getRecent, purgeOldMedia };
