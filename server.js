const express = require('express');
const https = require('https');
const path = require('path');
const ExcelJS = require('exceljs');
var db = require('./db_cache');
var __syncCanceled = false;
var __syncTotal = 0;

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
        catch (e) {
            // Handle non-JSON responses like rate-limit 'Retry later'
            const text = data.trim();
            if (text === 'Retry later') {
              resolve({ status: 429, body: { error: 'Retry later' } });
            } else {
              reject(new Error('Parse error: ' + text.slice(0, 200)));
            }
          }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('API request timeout after ' + REQ_TIMEOUT + 'ms')); });
    req.on('error', reject);
  });
}

async function fetchScanRecordsPage(limit, offset) {
  const url = TG3D_BASE + '/api/v1/scan_records?apikey=' + APIKEY + '&limit=' + limit + '&offset=' + offset;
  const { status, body } = await tg3dRequest(url);
  if (status === 429) throw new Error('Retry later');
  if (status !== 200) throw new Error('API error ' + status + ': ' + JSON.stringify(body));
  return body;
}

async function fetchMeasurements(tid, pose) {
  const p = pose || 'I';
  const url = TG3D_BASE + '/api/v1/scan_records/' + tid + '/size_xt?apikey=' + APIKEY + '&pose=' + p;
  for (var retry = 0; retry < 3; retry++) {
    try {
      const { status, body } = await tg3dRequest(url);
      if (status === 429) {
        await new Promise(function(r) { setTimeout(r, 3000 * (retry + 1)); });
        continue;
      }
      if (status !== 200) return null;
      return body.measurement || null;
    } catch {
      await new Promise(function(r) { setTimeout(r, 1000); });
    }
  }
  return null;
}

// Fields that should use pose=I (chest/underbust) with pose=A fallback
const CHEST_UNDERBUST_FIELDS = ['Chest Circumference', 'F Under Bust Circumference B'];

// Fetch measurements: other fields use pose=A, chest/underbust use pose=I (fallback to A)
async function fetchMergedMeasurements(tid) {
  // Sequential: pose=A first, wait 2s (API limit 1 req/sec), then pose=I
  const poseA = await fetchMeasurements(tid, 'A');
  await new Promise(function(r) { setTimeout(r, 1000); });
  const poseI = await fetchMeasurements(tid, 'I');

  if (!poseA && !poseI) return null;
  if (!poseA) return poseI;
  if (!poseI) return poseA;

  // Start with pose=A as base (most fields come from here)
  const merged = { ...poseA };
  // Override chest/underbust with pose=I, fallback to pose=A
  for (const field of CHEST_UNDERBUST_FIELDS) {
    merged[field] = poseI[field] != null ? poseI[field] : (poseA[field] != null ? poseA[field] : null);
  }
  return merged;
}

// In-memory cache for merged measurements
const measureCache = new Map();
const MEASURE_CACHE_TTL = 300_000;
async function fetchMergedMeasurementsCached(tid) {
  const cached = measureCache.get(tid);
  if (cached && Date.now() - cached.ts < MEASURE_CACHE_TTL) return cached.data;
  const data = await fetchMergedMeasurements(tid);
  measureCache.set(tid, { ts: Date.now(), data });
  return data;
}

// batch-fetch merged measurements concurrently
async function fetchMergedMeasurementsBatch(tids, concurrency) {
  concurrency = concurrency || 1;
  const results = {};
  let idx = 0;
  async function worker() {
    while (idx < tids.length) {
      const i = idx++;
      const tid = tids[i];
      // Skip if already in DB cache
      const existing = db.getMeasurementsByTids([tid]);
      if (existing[tid]) {
        results[tid] = existing[tid];
        continue;
      }
      results[tid] = await fetchMergedMeasurementsCached(tid);
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
    if (__syncCanceled) { console.log('[sync-range] Cancel requested, stopping'); break; }
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

  __syncTotal = allRecords.length;
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
  armL: 'Left Upper Arm Circumference',
  armR: 'Right Upper Arm Circumference',
  calfL: 'Left Calf Circumference',
  calfR: 'Right Calf Circumference',
  nspL: 'Left NSP to Apex Length',
  nspR: 'Right NSP to Apex Length',
};

// Chinese labels for measurement fields in export
const MEASURE_LABELS = {
  'Chest Circumference': '胸圍',
  'F Under Bust Circumference B': '胸下圍',
  'Left Breast Volume': '左右胸大小(左)',
  'Right Breast Volume': '左右胸大小(右)',
  'Left Upper Arm Circumference': '上臂圍(左)',
  'Right Upper Arm Circumference': '上臂圍(右)',
  'Belly Circumference': '中腰圍',
  'Thinnest Waist Circumference': '最細腰圍',
  'High Hip Circumference': '上臀圍',
  'Low Hip Circumference': '下臀圍',
  'Left Thigh Circumference': '大腿圍(左)',
  'Right Thigh Circumference': '大腿圍(右)',
  'Left Mid Thigh Circumference': '中大腿圍(左)',
  'Right Mid Thigh Circumference': '中大腿圍(右)',
  'Left Calf Circumference': '小腿圍(左)',
  'Right Calf Circumference': '小腿圍(右)',
  'C19 Left Shorts Circumference': '短褲腳寬(左)',
  'C19 Right Shorts Circumference': '短褲腳寬(右)',
  'Left NSP to Apex Length': '頸肩至乳尖(左)',
  'Right NSP to Apex Length': '頸肩至乳尖(右)',
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
    try {
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
    } catch (apiErr) {
      console.error('[summary] API fetch failed, partial results:', apiErr.message);
      break;
    }
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

    // Use DB cache only (API data loaded via sync)
    var dbRecords = db.getRecordsByDateRange(req.query.start, req.query.end + 'T23:59:59.999Z');
    var records = dbRecords.map(function(r) { return JSON.parse(r.raw_json); });

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

        // Read measurements from DB cache only (no API calls during query)
    const tids = candidates.map(function(r) { return r.tid; });
    var measurementsMap = db.getMeasurementsByTids(tids);
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
        tagList: rec.tag_list || [],
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

    // Determine measurement columns from first record with measurements
    const firstWithMeas = records.find(function(r) { return r.measurements; });
    const measureKeys = firstWithMeas ? Object.keys(firstWithMeas.measurements).sort() : [];

    // Build column definitions matching the web table
    const colDefs = [
      { header: '會員編號', key: 'userId', width: 14 },
      { header: '姓名', key: 'nickName', width: 14 },
      { header: '門市', key: 'store', width: 16 },
      { header: '掃描日期', key: 'createdAt', width: 22 },
      { header: '精準度', key: 'accuracyScore', width: 10 },
      { header: '掃描器', key: 'scanner', width: 18 },
    ];
    // Add measurement columns with Chinese labels
    measureKeys.forEach(function(k) {
      colDefs.push({ header: MEASURE_LABELS[k] || k, key: k, width: 16 });
    });

    const ws = wb.addWorksheet('members');
    ws.columns = colDefs;

    const hRow = ws.getRow(1);
    hRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C5CE7' } };
    hRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

    records.forEach(function(r) {
      var row = {
        userId: r.userId,
        nickName: r.nickName,
        store: r.store,
        createdAt: r.createdAt ? new Date(r.createdAt).toLocaleString('zh-TW') : '',
        accuracyScore: r.accuracyScore != null ? r.accuracyScore + '%' : '',
        scanner: r.scanner,
      };
      // Add measurement values
      if (r.measurements) {
        measureKeys.forEach(function(k) {
          var v = r.measurements[k];
          row[k] = v != null ? (typeof v === 'number' ? +v.toFixed(1) : v) : '';
        });
      }
      ws.addRow(row);
    });

    var fn = encodeURIComponent('member_export_' + req.query.start + '_' + req.query.end + '.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + fn);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual sync endpoint - supports date range via ?start=&end= params
app.get('/api/sync', async function(req, res) {
  try {
    __syncCanceled = false;
    __syncTotal = 0;
    var start = req.query.start;
    var end = req.query.end;
    if (start && end) {
      // Date range sync - fetch all records in the specified period
      var sd = new Date(start);
      var ed = new Date(end);
      ed.setHours(23, 59, 59, 999);
      var count = await syncRange(sd, ed, 50000);
      res.json({ success: true, newRecords: count, mode: 'daterange' });
    } else {
      // Incremental sync - only fetch newer than latest cached
      var count = await syncScanRecords();
      res.json({ success: true, newRecords: count, mode: 'incremental' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Cancel running sync
app.get('/api/sync-cancel', function(req, res) {
  __syncCanceled = true;
  res.json({ success: true, message: 'Sync canceled' });
});

// Check sync status
app.get('/api/sync-status', function(req, res) {
  res.json({ running: !__syncCanceled, totalFetched: __syncTotal });
});

app.listen(PORT, function() {
  console.log('Server running at http://localhost:' + PORT);
  // Restore DB from seed if Volume is empty
  (function restoreSeed() {
    var fs = require("fs");
    var seedPath = path.join(__dirname, 'seed.db');
    var dbPath = path.join(__dirname, 'data', 'scan_cache.db');
    if (fs.existsSync(seedPath)) {
      var count = db.prepare('SELECT COUNT(*) as c FROM scan_records').get();
      if (!count || count.c === 0) {
        console.log('[startup] DB empty, restoring from seed.db...');
        try { db.close(); } catch(e) {}
        var src = fs.readFileSync(seedPath);
        fs.writeFileSync(dbPath, src);
        delete require.cache[require.resolve('./db_cache')];
        db = require('./db_cache');
        console.log('[startup] Seed restored (' + fs.statSync(seedPath).size + ' bytes)');
      }
    }
  })();

  // Warmup disabled by default - use sync button to trigger API calls
  // Only restore from seed if Volume is empty (handled above)
  console.log("[startup] Warmup disabled. Click sync button to fetch data from API.");
  //
  // Original warmup code preserved below for reference:
  /*
  (async function warmupCache() {
    try {
      console.log("[warmup] Running sync (records + measurements)...");
      var count = await syncScanRecords();
      console.log("[warmup] Scan records cached:", count, "new records");
      console.log("[warmup] Starting measurement pre-cache...");
      setImmediate(async function preCacheMeas() {
        var allRecs = db.getRecordsByDateRange('2000-01-01', '2099-12-31');
        var allTids = allRecs.map(function(r) { return r.tid; });
        var existing = db.getMeasurementsByTids(allTids);
        var todo = allTids.filter(function(t) { return !existing[t]; });
        console.log("[warmup] Need to cache", todo.length, "measurements");

        // Free memory before starting
        if (global.gc) global.gc();

        for (var i = 0; i < todo.length; i++) {
          // Fetch without memory cache - use raw fetchMergedMeasurements directly
          var pid = todo[i];
          var poseA = await fetchMeasurements(pid, 'A');
          await new Promise(function(r) { setTimeout(r, 1000); });
          var poseI = await fetchMeasurements(pid, 'I');

          if (poseA || poseI) {
            var merged = poseA ? { ...poseA } : {};
            if (poseI) {
              for (var fi = 0; fi < CHEST_UNDERBUST_FIELDS.length; fi++) {
                var f = CHEST_UNDERBUST_FIELDS[fi];
                merged[f] = poseI[f] != null ? poseI[f] : (merged[f] != null ? merged[f] : null);
              }
            }
            var save = {}; save[pid] = merged;
            db.saveMeasurements(save);
          }

          // Free memory every 50 records
          if ((i + 1) % 50 === 0) {
            if (global.gc) global.gc();
            console.log("[warmup] Cached", (i + 1), "/", todo.length, "measurements");
          }
        }
        console.log("[warmup] Measurement pre-cache complete");
      });
    } catch (err) {
      console.error("[warmup] Error:", err.message);
    }
  })();
  */
});
