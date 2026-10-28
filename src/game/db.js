// SQLite persistence using Node's built-in node:sqlite module.
//
// Villages are the hot path: the simulation tick mutates all of them every
// 200ms. To keep that cheap, villages live in an in-memory cache (JSON
// fields pre-parsed) and dirty rows are flushed to disk in batches.
// Everything else (settings, players, movements, reports) is written
// through immediately.
//
// Note: node:sqlite statements are objects with .all()/.get()/.run()
// methods — never store one under a same-named key and call it.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SAVE_DIR = path.join(__dirname, '..', '..', 'save');
const DB_FILE = path.join(SAVE_DIR, 'tribalconquest.db');

fs.mkdirSync(SAVE_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);

// WAL mode + busy timeout: keeps the game resilient if another process
// (e.g. a backup tool or a dev script) briefly touches the save file.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 3000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY,
    name       TEXT,
    color      TEXT,
    is_human   INTEGER DEFAULT 0,
    difficulty TEXT
  );
  CREATE TABLE IF NOT EXISTS villages (
    id          INTEGER PRIMARY KEY,
    owner_id    INTEGER,           -- NULL = barbarian
    x           INTEGER,
    y           INTEGER,
    name        TEXT,
    loyalty     REAL DEFAULT 100,
    buildings   TEXT,              -- JSON {type: level}
    res         TEXT,              -- JSON {wood, clay, iron, wheat}
    build_queue TEXT,              -- JSON [{type, level, start, end}]
    train_queue TEXT,              -- JSON [{unit, count, start, end}]
    troops      TEXT,              -- JSON {unit: count}
    scout_data  TEXT               -- JSON {playerId: {troops, at}}
  );
  CREATE TABLE IF NOT EXISTS movements (
    id          INTEGER PRIMARY KEY,
    player_id   INTEGER,
    from_id     INTEGER,
    to_id       INTEGER,
    kind        TEXT,              -- attack | raid | scout | return
    units       TEXT,              -- JSON {unit: count}
    depart      REAL,
    arrive      REAL,
    loot        TEXT,              -- JSON {wood, clay, iron} (return legs only)
    note        TEXT
  );
  CREATE TABLE IF NOT EXISTS reports (
    id        INTEGER PRIMARY KEY,
    player_id INTEGER,
    kind      TEXT,                -- battle | scout | incoming | conquest | info
    title     TEXT,
    body      TEXT,
    meta      TEXT,                -- JSON {attacker_id, defender_id, from_id, to_id}
    at        REAL,
    read      INTEGER DEFAULT 0
  );
`);

function parse(v) { return v ? JSON.parse(v) : null; }
function json(v) { return JSON.stringify(v); }

// ---- settings -------------------------------------------------
const settingGet = db.prepare('SELECT value FROM settings WHERE key = ?');
const settingSet = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
function getSetting(key, fallback = null) {
  const row = settingGet.get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  settingSet.run(key, json(value));
}

// ---- players --------------------------------------------------
const playerAll = db.prepare('SELECT * FROM players ORDER BY id');
const playerGet = db.prepare('SELECT * FROM players WHERE id = ?');
const playerInsert = db.prepare('INSERT INTO players (name, color, is_human, difficulty) VALUES (?, ?, ?, ?)');
function players() { return playerAll.all(); }
function getPlayer(id) { return playerGet.get(id); }
function addPlayer(name, color, isHuman, difficulty) {
  const r = playerInsert.run(name, color, isHuman ? 1 : 0, difficulty);
  return Number(r.lastInsertRowid);
}

// ---- villages (cached, flushed in batches) --------------------
const villageAll = db.prepare('SELECT * FROM villages');
const villageGet = db.prepare('SELECT * FROM villages WHERE id = ?');
const villageInsert = db.prepare(
  'INSERT INTO villages (owner_id, x, y, name, loyalty, buildings, res, build_queue, train_queue, troops, scout_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const villageUpdate = db.prepare(
  'UPDATE villages SET owner_id = ?, name = ?, loyalty = ?, buildings = ?, res = ?, build_queue = ?, train_queue = ?, troops = ?, scout_data = ? WHERE id = ?'
);

// cache: id -> village row with JSON fields already parsed
let vCache = null;
const vDirty = new Set();

function parseVillageRow(r) {
  return {
    ...r,
    buildings: parse(r.buildings) || {},
    res: parse(r.res) || { wood: 0, clay: 0, iron: 0, wheat: 0 },
    build_queue: parse(r.build_queue) || [],
    train_queue: parse(r.train_queue) || [],
    troops: parse(r.troops) || {},
    scout_data: parse(r.scout_data) || {},
  };
}
function ensureVCache() {
  if (vCache === null) {
    vCache = new Map();
    for (const r of villageAll.all()) vCache.set(r.id, parseVillageRow(r));
  }
}
function villages() {
  ensureVCache();
  return [...vCache.values()];
}
function getVillage(id) {
  ensureVCache();
  return vCache.get(id);
}
function addVillage(ownerId, x, y, name, buildings, res) {
  const r = villageInsert.run(
    ownerId === null ? null : ownerId, x, y, name, 100,
    json(buildings), json(res), '[]', '[]', '{}', '{}'
  );
  ensureVCache();
  const v = parseVillageRow(villageGet.get(Number(r.lastInsertRowid)));
  vCache.set(v.id, v);
  vDirty.add(v.id);
  return v.id;
}
function saveVillage(v) {
  ensureVCache();
  vCache.set(v.id, v);
  vDirty.add(v.id);
}
function flushVillages() {
  if (!vDirty.size) return;
  for (const id of vDirty) {
    const v = vCache.get(id);
    if (!v) continue;
    villageUpdate.run(
      v.owner_id === null ? null : v.owner_id, v.name, v.loyalty,
      json(v.buildings), json(v.res), json(v.build_queue), json(v.train_queue), json(v.troops), json(v.scout_data),
      v.id
    );
  }
  vDirty.clear();
}
function invalidateVillageCache() {
  vCache = null;
  vDirty.clear();
}
// Wipes all world tables (used by world generation).
function resetWorld() {
  for (const t of ['settings', 'players', 'villages', 'movements', 'reports']) {
    db.exec(`DELETE FROM ${t}`);
  }
  invalidateVillageCache();
}

// ---- movements ------------------------------------------------
const movementAll = db.prepare('SELECT * FROM movements');
const movementInsert = db.prepare(
  'INSERT INTO movements (player_id, from_id, to_id, kind, units, depart, arrive, loot, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const movementDelete = db.prepare('DELETE FROM movements WHERE id = ?');
function movements() { return movementAll.all(); }
function addMovement(playerId, fromId, toId, kind, units, depart, arrive, loot, note) {
  const r = movementInsert.run(playerId, fromId, toId, kind, json(units), depart, arrive, loot ? json(loot) : null, note);
  return Number(r.lastInsertRowid);
}
function deleteMovement(id) { movementDelete.run(id); }

// ---- reports --------------------------------------------------
const reportForPlayer = db.prepare('SELECT * FROM reports WHERE player_id = ? ORDER BY id DESC');
const reportInsert = db.prepare('INSERT INTO reports (player_id, kind, title, body, meta, at, read) VALUES (?, ?, ?, ?, ?, ?, 0)');
const reportMarkAll = db.prepare('UPDATE reports SET read = 1 WHERE player_id = ?');
const reportUnreadCount = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE player_id = ? AND read = 0');
const reportRecent = db.prepare('SELECT * FROM reports WHERE player_id = ? AND kind IN (?, ?, ?) AND at >= ?');
function reportsFor(playerId) { return reportForPlayer.all(playerId); }
function addReport(playerId, kind, title, body, meta) {
  const r = reportInsert.run(playerId, kind, title, body, meta ? json(meta) : null, getSetting('game_time', 0));
  return Number(r.lastInsertRowid);
}
function markReportsRead(playerId) { reportMarkAll.run(playerId); }
function unreadCount(playerId) { return reportUnreadCount.get(playerId).n; }
function recentAttackReports(playerId, since) {
  return reportRecent.all(playerId, 'battle', 'incoming', 'conquest', since);
}

module.exports = {
  db, parse, json,
  getSetting, setSetting,
  players, getPlayer, addPlayer,
  villages, getVillage, addVillage, saveVillage, flushVillages, invalidateVillageCache, resetWorld,
  movements, addMovement, deleteMovement,
  reportsFor, addReport, markReportsRead, unreadCount, recentAttackReports,
};
