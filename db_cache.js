const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'data', 'scan_cache.db');
const fs = require('fs');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
var db = new Database(dbPath);

// WAL mode for faster concurrent reads
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS scan_records (
    tid TEXT PRIMARY KEY,
    user_id TEXT,
    nick_name TEXT,
    real_name TEXT,
    created_at TEXT,
    updated_at TEXT,
    store_name TEXT,
    scanner_name TEXT,
    accuracy_score REAL,
    tag_list TEXT,
    raw_json TEXT,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS measurements (
    tid TEXT PRIMARY KEY,
    data_json TEXT,
    fetched_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_scan_records_created_at ON scan_records(created_at);
  CREATE INDEX IF NOT EXISTS idx_scan_records_store ON scan_records(store_name);
  CREATE INDEX IF NOT EXISTS idx_scan_records_user ON scan_records(user_id);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '[]',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

// Ensure region_mappings table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS region_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_name TEXT NOT NULL,
    store_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(manager_name, store_name)
  );
`);

// ---- Users ----
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Seed default admin account
const adminUsername = '0981069796';
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
if (!adminExists) {
  db.prepare('INSERT INTO users (name, username, password_hash, permissions, is_admin, created_at) VALUES (?,?,?,?,?,?)')
    .run('管理员', adminUsername, hashPassword('0981069796'), JSON.stringify(['store_summary','members','sync','access_control','region']), 1, Date.now());
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
}

function getAllUsers() {
  return db.prepare('SELECT id, name, username, permissions, is_admin, created_at FROM users ORDER BY id').all();
}

function createUser(name, username, password, permissions, isAdmin) {
  const ph = hashPassword(password);
  return db.prepare('INSERT INTO users (name, username, password_hash, permissions, is_admin, created_at) VALUES (?,?,?,?,?,?)')
    .run(name, username, ph, JSON.stringify(permissions || []), isAdmin ? 1 : 0, Date.now());
}

function updateUser(id, name, username, password, permissions, isAdmin) {
  const user = getUserById(id);
  if (!user) return false;
  const ph = password ? hashPassword(password) : user.password_hash;
  db.prepare('UPDATE users SET name=?, username=?, password_hash=?, permissions=?, is_admin=? WHERE id=?')
    .run(name, username, ph, JSON.stringify(permissions || []), isAdmin ? 1 : 0, Number(id));
  return true;
}

function deleteUser(id) {
  const user = getUserById(id);
  if (!user || user.is_admin) return false; // cannot delete admin
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(id));
  return true;
}

function verifyPassword(username, password) {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (user.password_hash !== hashPassword(password)) return null;
  return { id: user.id, name: user.name, username: user.username, permissions: JSON.parse(user.permissions || '[]'), is_admin: !!user.is_admin };
}

// ---- Scan Records ----

const insertRecord = db.prepare(`
  INSERT OR REPLACE INTO scan_records (tid, user_id, nick_name, real_name, created_at, updated_at, store_name, scanner_name, accuracy_score, tag_list, raw_json, fetched_at)
  VALUES (@tid, @userId, @nickName, @realName, @createdAt, @updatedAt, @storeName, @scannerName, @accuracyScore, @tagList, @rawJson, @fetchedAt)
`);

const insertManyRecords = db.transaction((records) => {
  for (const r of records) insertRecord.run(r);
});

function saveScanRecords(records) {
  const now = Date.now();
  const rows = records.map(rec => ({
    tid: rec.tid,
    userId: rec.user_id || '',
    nickName: rec.user?.nick_name || '',
    realName: rec.real_name || '',
    createdAt: rec.created_at || '',
    updatedAt: rec.updated_at || '',
    storeName: rec.scanner?.store?.name || '',
    scannerName: rec.scanner?.name || '',
    accuracyScore: rec.accuracy_score || 0,
    tagList: JSON.stringify(rec.tag_list || []),
    rawJson: JSON.stringify(rec),
    fetchedAt: now,
  }));
  insertManyRecords(rows);
}

function getRecordsByDateRange(startDate, endDate) {
  return db.prepare(`
    SELECT * FROM scan_records
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at DESC
  `).all(startDate, endDate);
}

function getLatestFetchedAt() {
  const row = db.prepare(`SELECT MAX(fetched_at) as max FROM scan_records`).get();
  return row ? row.max : 0;
}

function getLatestCreatedAt() {
  const row = db.prepare(`SELECT MAX(created_at) as created_at FROM scan_records`).get();
  return row || null;
}

// ---- Measurements ----

const insertMeasurement = db.prepare(`
  INSERT OR REPLACE INTO measurements (tid, data_json, fetched_at)
  VALUES (@tid, @dataJson, @fetchedAt)
`);

const insertManyMeasurements = db.transaction((rows) => {
  for (const r of rows) insertMeasurement.run(r);
});

function saveMeasurements(measurementsMap) {
  const now = Date.now();
  const rows = Object.entries(measurementsMap).map(([tid, data]) => ({
    tid,
    dataJson: JSON.stringify({ poseA: data.poseA || null, poseI: data.poseI || null }),
    fetchedAt: now,
  }));
  if (rows.length > 0) insertManyMeasurements(rows);
}

function getMeasurementsByTids(tids) {
  if (tids.length === 0) return {};
  const placeholders = tids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT tid, data_json FROM measurements WHERE tid IN (${placeholders})`).all(...tids);
  const map = {};
  for (const row of rows) {
    var raw = JSON.parse(row.data_json);
    // New format: { poseA: ..., poseI: ... } - merge for display
    if (raw && (raw.poseA || raw.poseI)) {
      var merged = {};
      if (raw.poseI) Object.assign(merged, raw.poseI);
      if (raw.poseA) {
        var chestFields = ['Chest Circumference', 'F Under Bust Circumference B'];
        for (var key of Object.keys(raw.poseA)) {
          if (chestFields.indexOf(key) !== -1 && raw.poseI && raw.poseI[key] != null) {
            merged[key] = raw.poseI[key];
          } else {
            merged[key] = raw.poseA[key];
          }
        }
      }
      map[row.tid] = merged;
    } else {
      // Old format: directly stored merged data
      map[row.tid] = raw;
    }
  }
  return map;
}

function clearAllMeasurements() {
  db.prepare('DELETE FROM measurements').run();
}

// ---- Region Mappings ----

function getAllRegionMappings() {
  return db.prepare('SELECT * FROM region_mappings ORDER BY manager_name, store_name').all();
}

function addRegionMapping(managerName, storeName) {
  try {
    db.prepare('INSERT INTO region_mappings (manager_name, store_name, created_at) VALUES (?, ?, ?)')
      .run(managerName.trim(), storeName.trim(), Date.now());
    return true;
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return false;
    throw e;
  }
}

function deleteRegionMapping(id) {
  db.prepare('DELETE FROM region_mappings WHERE id = ?').run(Number(id));
}

function getStoreManagerMap() {
  // Returns { store_name -> manager_name } lookup
  const rows = db.prepare('SELECT store_name, manager_name FROM region_mappings').all();
  const map = {};
  for (const row of rows) {
    map[row.store_name] = row.manager_name;
  }
  return map;
}

function getAllManagers() {
  return db.prepare('SELECT DISTINCT manager_name FROM region_mappings ORDER BY manager_name').all();
}

function getMappingsByManager(managerName) {
  return db.prepare('SELECT * FROM region_mappings WHERE manager_name = ? ORDER BY store_name').all(managerName);
}

// ---- Close / Reopen ----

function close() {
  db.close();
}

function reopen() {
  db.close();
  db = new Database(dbPath);
  return db;
}

module.exports = {
  saveScanRecords,
  getRecordsByDateRange,
  getLatestFetchedAt,
  getLatestCreatedAt,
  saveMeasurements,
  getMeasurementsByTids,
  clearAllMeasurements,
  close,
  reopen,
  // Users
  verifyPassword,
  getUserByUsername,
  getUserById,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  // Region Mappings
  getAllRegionMappings,
  addRegionMapping,
  deleteRegionMapping,
  getStoreManagerMap,
  getAllManagers,
  getMappingsByManager,
};
