const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'scan_cache.db');
const fs = require('fs');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(dbPath);

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
`);

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
    dataJson: JSON.stringify(data),
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
    map[row.tid] = JSON.parse(row.data_json);
  }
  return map;
}

function close() {
  db.close();
}

module.exports = {
  saveScanRecords,
  getRecordsByDateRange,
  getLatestFetchedAt,
  saveMeasurements,
  getMeasurementsByTids,
  close,
};
