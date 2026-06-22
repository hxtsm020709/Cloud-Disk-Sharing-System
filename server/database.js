const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    phone TEXT,
    vip_type TEXT,
    vip_expire_date TEXT,
    cookie_encrypted TEXT NOT NULL,
    cookie_status TEXT DEFAULT 'unknown',
    cookie_updated_at TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    is_deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS share_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    account_id INTEGER NOT NULL,
    expire_hours INTEGER NOT NULL,
    expire_at TEXT NOT NULL,
    use_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_link_id INTEGER,
    account_id INTEGER,
    action TEXT,
    ip_address TEXT,
    user_agent TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);
`;

async function init() {
  const SQL = await initSqlJs();
  const dbDir = path.dirname(config.dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(config.dbPath)) {
    const buffer = fs.readFileSync(config.dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  db.run(SCHEMA);

  // 增量迁移：为旧表增加 max_uses 列
  try { db.run("ALTER TABLE share_links ADD COLUMN max_uses INTEGER DEFAULT 20"); } catch(e) { /* 列已存在 */ }
  try { db.run("ALTER TABLE share_links ADD COLUMN is_pool INTEGER DEFAULT 0"); } catch(e) { /* 列已存在 */ }
  try { db.run("ALTER TABLE share_links ADD COLUMN first_used_at TEXT"); } catch(e) { /* 列已存在 */ }
  // 已有使用记录的旧链接：用创建时间作为 first_used_at
  try { db.run("UPDATE share_links SET first_used_at = created_at WHERE use_count > 0 AND first_used_at IS NULL"); } catch(e) {}
  try { db.run("ALTER TABLE accounts ADD COLUMN is_paused INTEGER DEFAULT 0"); } catch(e) { /* 列已存在 */ }
  try { db.run("ALTER TABLE share_links ADD COLUMN display_number INTEGER"); } catch(e) { /* 列已存在 */ }
  // 为旧链接补填编号（按创建时间从1开始）
  try {
    const unnumbered = db.all('SELECT id FROM share_links WHERE display_number IS NULL ORDER BY created_at ASC');
    if (unnumbered.length > 0) {
      const used = new Set(db.all('SELECT display_number FROM share_links WHERE display_number IS NOT NULL').map(r => r.display_number));
      let next = 1;
      for (const row of unnumbered) {
        while (used.has(next)) next++;
        db.run('UPDATE share_links SET display_number = ? WHERE id = ?', [next, row.id]);
        used.add(next);
      }
      console.log(`[migration] 已为 ${unnumbered.length} 条旧链接补填展示编号`);
    }
  } catch(e) { /* 静默跳过 */ }

  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.dbPath, buffer);
}

function getDb() {
  if (!db) throw new Error('数据库未初始化，请先调用 init()');
  return db;
}

function run(sql, params = []) {
  const database = getDb();
  database.run(sql, params);
  save();
}

function get(sql, params = []) {
  const database = getDb();
  const stmt = database.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const database = getDb();
  const results = [];
  const stmt = database.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function getSetting(key, defaultValue = '') {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

function getAllSettings() {
  const rows = all('SELECT * FROM settings ORDER BY key');
  const map = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

module.exports = { init, getDb, run, get, all, save, getSetting, setSetting, getAllSettings };
