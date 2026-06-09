const express = require('express');
const https = require('https');
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('./db_cache');

const app = express();
const PORT = process.env.PORT || 3001;

const APIKEY = 'xwsSRQmdxSo198IQgoO0rzDt8Qinmalmq2kt';
const TG3D_BASE = 'https://api.tg3ds.com';

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const cache = new Map();
const CACHE_TTL = 60_000;
const MAX_API_RECORDS = 50000;

function tg3dRequest(url) {
  return new Promise((resolve, reject) => {
    const REQ_TIMEOUT = 15_000;
    const req = https.get(url, { timeout: REQ_TIMEOUT }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('API request timeout after ' + REQ_TIMEOUT + 'ms')); });
    req.on('error', reject);
  });
}

async function fetchScanRecordsPage(limit, offset) {
  const url = TG3D_BASE + '/api/v1/scan_records?apikey=' + APIKEY + '&limit=' + limit + '&offset=' + offset;
  const { status, body } = await tg3dRequest(url);
  if (status !== 200) throw new Error('API error ' + status + ': ' + JSON.stringify(body));
  return body;
}

async function fetchMeasurements(tid, pose) {
  const p = pose || 'I';
  const url = TG3D_BASE + '/api/v1/scan_records/' + tid + '/size_xt?apikey=' + APIKEY + '&pose=' + p;
  try {
    const { status, body } = await tg3dRequest(url);
    if (status !== 200) return null;
    return body.measurement || null;
  } catch { return null; }
}

// measurement cache to avoid repeated fetches
const measureCache = new Map();
const MEASURE_CACHE_TTL = 300_000;
async function fetchMeasurementsCached(tid) {
  const cached = measureCache.get(tid);
  if (cached && Date.now() - cached.ts < MEASURE_CACHE_TTL) return cached.data;
  const data = await fetchMeasurements(tid);
  measureCache.set(tid, { ts: Date.now(), data });
  return data;
}

// batch-fetch measurements concurrently with a limit
async function fetchMeasurementsBatch(tids, concurrency) {
  concurrency = concurrency || 10;
  const results = {};
  let idx = 0;
  async function worker() {
    while (idx < tids.length) {
      const i = idx++;
      results[tids[i]] = await fetchMeasurementsCached(tids[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tids.length) }, () => worker());
  await Promise.all(workers);
  return results;
}


// ---- Incremental sync: fetch only records newer than latest in DB ----
async function syncScanRecords(targetMaxRecords) {
  targetMaxRecords = targetMaxRecords || 50000;
  const latestFetchedAt = db.getLatestFetchedAt();
  if (latestFetchedAt === 0) {
    console.log('[sync] No cache found, fetching recent records...');
    const end = new Date();
    const start = new Date(end); start.setFullYear(start.getFullYear() - 1);
    return syncRange(start, end, targetMaxRecords);
  }

  // We have cache - only fetch records newer than latest cached
  const latestRow = db.getLatestCreatedAt();
  if (!latestRow) {
    console.log('[sync] No records in cache, fetching recent...');
    const end = new Date();
    const start = new Date(end); start.setFullYear(start.getFullYear() - 1);
    return syncRange(start, end, targetMaxRecords);
  }

  const latestDate = new Date(latestRow.created_at);
  const now = new Date();
  console.log('[sync] Latest cached record:', latestRow.created_at);
  console.log('[sync] Fetching newer records...');

  let added = 0;
  let offset = 0;
  let done = false;

  while (!done && added < targetMaxRecords) {
    let data;
    try {
      data = await fetchScanRecordsPage(100, offset);
    } catch (err) {
      if (err.message && err.message.includes('Retry later')) {
        console.log('[sync] Rate limited, waiting 5s...');
        await new Promise(r => setTimeout(r, 5000));
        try { data = await fetchScanRecordsPage(100, offset); }
        catch (e2) { console.error('[sync] Retry failed:', e2.message); break; }
      } else {
        console.error('[sync] Fetch failed:', err.message);
        break;
      }
    }

    const records = data.records || [];
    if (records.length === 0) break;

    let newRecords = [];
    let oldestInPage = null;

    for (const rec of records) {
      const recDate = new Date(rec.created_at);
      if (!oldestInPage || recDate < oldestInPage) oldestInPage = recDate;
      if (recDate <= latestDate) { done = true; break; }
      newRecords.push(rec);
    }

    if (newRecords.length > 0) {
      db.saveScanRecords(newRecords);
      added += newRecords.length;
      console.log('[sync] Added ' + newRecords.length + ' (total: ' + added + ')');
    }

    offset += 100;
    if (offset >= (data.total || 0)) done = true;
    if (oldestInPage && oldestInPage <= latestDate) done = true;
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('[sync] Complete. Added ' + added + ' new records.');
  return added;
}

async function syncRange(startDate, endDate, maxRecords) {
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  let offset = 0;
  let allRecords = [];
  let done = false;

  while (!done && allRecords.length < maxRecords) {
    let data;
    try {
      data = await fetchScanRecordsPage(100, offset);
    } catch (err) {
      if (err.message && err.message.includes('Retry later')) {
        console.log('[sync-range] Rate limited, waiting 5s...');
        await new Promise(r => setTimeout(r, 5000));
        try { data = await fetchScanRecordsPage(100, offset); }
        catch (e2) { console.error('[sync-range] Retry failed:', e2.message); break; }
      } else {
        console.error('[sync-range] Fetch failed:', err.message);
        break;
      }
    }

    const records = data.records || [];
    if (records.length === 0) break;

    for (const rec of records) {
      const ca = new Date(rec.created_at).getTime();
      if (ca > endMs) continue;
      if (ca < startMs) { done = true; break; }
      allRecords.push(rec);
    }

    offset += 100;
    if (offset >= (data.total || 0)) done = true;
    await new Promise(r => setTimeout(r, 200));
  }

  if (allRecords.length > 0) {
    db.saveScanRecords(allRecords);
    console.log('[sync-range] Cached ' + allRecords.length + ' records');
  }
  return allRecords.length;
}
const MEASURE_FILTERS = {
  chest: 'Chest Circumference',
  underbust: 'F Under Bust Circumference B',
  thinWaist: 'Thinnest Waist Circumference',
  belly: 'Belly Circumference',
  highHip: 'High Hip Circumference',
  lowHip: 'Low Hip Circumference',
  thighL: 'Left Thigh Circumference',
  thighR: 'Right Thigh Circumference',
};

function matchMeasurementRanges(measurements, filters) {
  if (!measurements) return false;
  for (const [key, field] of Object.entries(MEASURE_FILTERS)) {
    const min = filters[key + 'Min'];
    const max = filters[key + 'Max'];
    if (min == null && max == null) continue;
    const val = measurements[field];
    if (val == null) return false;
    if (min != null && val < min) return false;
    if (max != null && val > max) return false;
  }
  return true;
}

// shared: scan records by date range + basic filters
async function scanRecordsByDateRange(startDate, endDate, filters) {
  filters = filters || {};
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  const PAGE_SIZE = 100;
  let offset = 0;
  let matched = [];
  let done = false;

  while (!done) {
    const data = await fetchScanRecordsPage(PAGE_SIZE, offset);
    const records = data.records || [];
    if (records.length === 0) break;

    for (const rec of records) {
      const ca = new Date(rec.created_at).getTime();
      if (ca > endMs) continue;
      if (ca < startMs) { done = true; break; }

      if (filters.userId) {
        const q = filters.userId.toLowerCase();
        const matchId = (rec.user_id || '').toLowerCase().includes(q);
        const matchName = (rec.user?.nick_name || '').toLowerCase().includes(q);
        const matchReal = (rec.real_name || '').toLowerCase().includes(q);
        if (!matchId && !matchName && !matchReal) continue;
      }
      if (filters.store) {
        const sn = (rec.scanner?.store?.name || '').toLowerCase();
        if (!sn.includes(filters.store.toLowerCase())) continue;
      }

      matched.push(rec);
    }
    offset += PAGE_SIZE;
    if (offset >= (data.total || 0)) done = true;
  }
  return matched;
}

// ---- API 1: Store summary (dedup) ----
app.get('/api/scan-summary', async (req, res) => {
  try {
    const startDate = new Date(req.query.start);
    const endDate = new Date(req.query.end);
    endDate.setHours(23, 59, 59, 999);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format.' });
    }

    const cacheKey = 'summary:' + req.query.start + ':' + req.query.end;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return res.json(cached.data);

    const records = await scanRecordsByDateRange(startDate, endDate);

    const storeUserDays = {};
    for (const rec of records) {
      const storeName = rec.scanner?.store?.name || '(unknown)';
      if (!storeUserDays[storeName]) storeUserDays[storeName] = new Set();
      storeUserDays[storeName].add(rec.created_at.slice(0, 10) + '_' + rec.user_id);
    }

    const sorted = Object.entries(storeUserDays)
      .map(function(e) { return { store: e[0], count: e[1].size }; })
      .sort(function(a, b) { return b.count - a.count; });

    const result = {
      start: req.query.start, end: req.query.end,
      totalScanRecords: records.length,
      uniqueVisits: sorted.reduce(function(s, x) { return s + x.count; }, 0),
      stores: sorted
    };
    cache.set(cacheKey, { ts: Date.now(), data: result });
    res.json(result);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- API 2: Store summary export ----
app.get('/api/scan-summary/export', async (req, res) => {
  try {
    let stores = [];
    if (req.query.data) {
      stores = JSON.parse(req.query.data);
    } else {
      const resp = await fetch('http://localhost:' + PORT + '/api/scan-summary?start=' + req.query.start + '&end=' + req.query.end);
      const summary = await resp.json();
      stores = summary.stores || [];
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TG Scan Dashboard';
    const ws = wb.addWorksheet('store_stats');
    ws.columns = [
      { header: 'rank', key: 'rank', width: 8 },
      { header: 'store', key: 'store', width: 24 },
      { header: 'count', key: 'count', width: 18 },
    ];

    const hRow = ws.getRow(1);
    hRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C5CE7' } };
    hRow.alignment = { horizontal: 'center', vertical: 'middle' };

    stores.forEach(function(s, i) { ws.addRow({ rank: i + 1, store: s.store, count: s.count }); });

    ws.addRow([]);
    var total = stores.reduce(function(s, x) { return s + x.count; }, 0);
    ws.addRow({ rank: '', store: 'Total', count: total });
    ws.lastRow.font = { bold: true };

    var fn = encodeURIComponent('store_stats_' + req.query.start + '_' + req.query.end + '.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + fn);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- API 3: Member search with measurements ----
app.get('/api/scan-members', async (req, res) => {
  try {
    const startDate = new Date(req.query.start);
    const endDate = new Date(req.query.end);
    endDate.setHours(23, 59, 59, 999);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format.' });
    }

    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    const filters = {};
    if (req.query.userId) filters.userId = req.query.userId;
    if (req.query.store) filters.store = req.query.store;

    const measureFilters = {};
    for (const key of Object.keys(MEASURE_FILTERS)) {
      const min = req.query[key + 'Min'];
      const max = req.query[key + 'Max'];
      if (min) measureFilters[key + 'Min'] = parseFloat(min);
      if (max) measureFilters[key + 'Max'] = parseFloat(max);
    }
    const hasMeasureFilters = Object.keys(measureFilters).length > 0;

    // Fetch scan records from DB cache only
    let allRecords = [];
    let candidates = [];
    let totalChecked = 0;
    const dbRecords = db.getRecordsByDateRange(req.query.start, req.query.end + 'T23:59:59.999Z');
    if (dbRecords.length > 0) {
      allRecords = dbRecords.map(function(r) { return JSON.parse(r.raw_json); });
    }
    // Apply basic filters
    for (const rec of allRecords) {
      totalChecked++;
      if (filters.userId) {
        const q = filters.userId.toLowerCase();
        if (!(rec.user_id || '').toLowerCase().includes(q) &&
            !(rec.user?.nick_name || '').toLowerCase().includes(q) &&
            !(rec.real_name || '').toLowerCase().includes(q)) continue;
      }
      if (filters.store) {
        const sn = (rec.scanner?.store?.name || '').toLowerCase();
        if (!sn.includes(filters.store.toLowerCase())) continue;
      }
      candidates.push(rec);
      if (candidates.length >= MAX_API_RECORDS) break;
    }

    // Fetch measurements (check DB first, API for missing)
    const tids = candidates.map(function(r) { return r.tid; });
    let measurementsMap = {};
    if (hasMeasureFilters || candidates.length <= 100) {
      measurementsMap = db.getMeasurementsByTids(tids);
      const missingTids = tids.filter(function(t) { return !(t in measurementsMap); });
      if (missingTids.length > 0) {
        const freshMeas = await fetchMeasurementsBatch(missingTids, 10);
        db.saveMeasurements(freshMeas);
        Object.assign(measurementsMap, freshMeas);
      }
    }

    // Build results
    const results = [];
    for (const rec of candidates) {
      const measurements = measurementsMap[rec.tid] || null;
      if (hasMeasureFilters && !matchMeasurementRanges(measurements, measureFilters)) continue;
      results.push({
        tid: rec.tid,
        userId: rec.user_id,
        nickName: rec.user?.nick_name || '',
        createdAt: rec.created_at,
        updatedAt: rec.updated_at,
        store: rec.scanner?.store?.name || '',
        scanner: rec.scanner?.name || '',
        accuracyScore: rec.accuracy_score,
        realName: rec.real_name || '',
        measurements: measurements,
        hasMeasurements: !!measurements,
      });
    }

    res.json({
      start: req.query.start,
      end: req.query.end,
      totalRecords: results.length,
      totalChecked: totalChecked,
      includeMeasurements: true,
      records: results
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ---- API 4: Member export ----
app.get('/api/scan-members/export', async (req, res) => {
  try {
    var url = 'http://localhost:' + PORT + '/api/scan-members?start=' + req.query.start + '&end=' + req.query.end;
    if (req.query.userId) url += '&userId=' + encodeURIComponent(req.query.userId);
    if (req.query.store) url += '&store=' + encodeURIComponent(req.query.store);
    for (const key of Object.keys(MEASURE_FILTERS)) {
      const min = req.query[key + 'Min'];
      const max = req.query[key + 'Max'];
      if (min) url += '&' + key + 'Min=' + min;
      if (max) url += '&' + key + 'Max=' + max;
    }

    const resp = await fetch(url);
    const data = await resp.json();
    const records = data.records || [];

    if (records.length === 0) {
      return res.status(404).json({ error: 'No data to export' });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TG Scan Dashboard';

    const ws1 = wb.addWorksheet('records');
    ws1.columns = [
      { header: 'userId', key: 'userId', width: 14 },
      { header: 'name', key: 'nickName', width: 14 },
      { header: 'store', key: 'store', width: 16 },
      { header: 'date', key: 'createdAt', width: 20 },
      { header: 'accuracy', key: 'accuracyScore', width: 10 },
      { header: 'scanner', key: 'scanner', width: 18 },
];
    const h1 = ws1.getRow(1);
    h1.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    h1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C5CE7' } };
    records.forEach(function(r) {
      ws1.addRow({
        userId: r.userId, nickName: r.nickName, store: r.store,
        createdAt: r.createdAt, accuracyScore: r.accuracyScore,
        scanner: r.scanner
      });
    });

    if (records.some(function(r) { return r.measurements; })) {
      const ws2 = wb.addWorksheet('measurements');
      const m = records.find(function(r) { return r.measurements; })?.measurements || {};
      const measureKeys = Object.keys(m).sort();
      ws2.columns = [
        { header: 'userId', key: 'userId', width: 14 },
        { header: 'name', key: 'nickName', width: 14 },
      ].concat(measureKeys.map(function(k) { return { header: k, key: k, width: 14 }; }));
      const h2 = ws2.getRow(1);
      h2.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      h2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B894' } };
      ws2.views = [{ state: 'frozen', xSplit: 2 }];

      records.forEach(function(r) {
        if (!r.measurements) return;
        const row = { userId: r.userId, nickName: r.nickName };
        for (const k of measureKeys) {
          const v = r.measurements[k];
          row[k] = v != null ? (typeof v === 'number' ? +v.toFixed(2) : v) : '';
        }
        ws2.addRow(row);
      });
    }

    var fn = encodeURIComponent('member_data_' + req.query.start + '_' + req.query.end + '.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + fn);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ---- API 5: Manual sync trigger ----
app.get("/api/sync", async (req, res) => {
  try {
    const maxRecords = parseInt(req.query.max) || 50000;
    res.json({ status: "syncing", maxRecords: maxRecords });
    const count = await syncScanRecords(maxRecords);
    console.log("[api/sync] Sync completed: " + count + " records added");
  } catch (err) {
    console.error("[api/sync] Error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, function() {
  console.log('Server running at http://localhost:' + PORT);

  // Background warmup: pre-cache recent 7 days so first user query is fast
  // Warmup: sync latest records on startup
  (async function warmupCache() {
    try {
      console.log("[warmup] Running initial sync...");
      const count = await syncScanRecords();
      console.log("[warmup] Initial sync complete, added " + count + " records");
    } catch (err) {
      console.error("[warmup] Error:", err.message);
    }
  })();
});
