const express = require('express');
const https = require('https');
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('./db_cache');
const auth = require('./auth');
var __syncCanceled = false;
var __syncTotal = 0;
var __measSyncState = { running: false, cancel: false, total: 0, done: 0 };

const app = express();
const PORT = process.env.PORT || 3001;

const APIKEY = 'xwsSRQmdxSo198IQgoO0rzDt8Qinmalmq2kt';
const TG3D_BASE = 'https://api.tg3ds.com';

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.use(express.json());
// ---- Auth ----
app.post('/api/login', function(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Please enter username and password' });
  const user = db.verifyPassword(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const token = auth.generateToken();
  auth.tokens.set(token, { user, expires: Date.now() + 24 * 60 * 60 * 1000 });
  res.json({ token, user });
});

app.get('/api/session', auth.requireAuth, function(req, res) {
  const user = db.getUserByUsername(req.user.username);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user: { id: user.id, name: user.name, username: user.username, permissions: JSON.parse(user.permissions || '[]'), is_admin: !!user.is_admin } });
});

app.post('/api/logout', auth.requireAuth, function(req, res) {
  const token = req.headers['x-auth-token'];
  auth.tokens.delete(token);
  res.json({ success: true });
});

// ---- User Management ----
app.get('/api/users', auth.requireAuth, auth.requirePermission('access_control'), function(req, res) {
  try {
    const users = db.getAllUsers();
    const result = users.map(function(u) { return { ...u, permissions: JSON.parse(u.permissions || '[]') }; });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth.requireAuth, auth.requirePermission('access_control'), function(req, res) {
  try {
    const { name, username, password, permissions, is_admin } = req.body || {};
    if (!name || !username || !password) return res.status(400).json({ error: 'Name, username, and password are required' });
    const existing = db.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'Username already exists' });
    db.createUser(name, username, password, permissions || [], !!is_admin);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', auth.requireAuth, auth.requirePermission('access_control'), function(req, res) {
  try {
    const id = Number(req.params.id);
    const { name, username, password, permissions, is_admin } = req.body || {};
    if (!name || !username) return res.status(400).json({ error: 'Name and username are required' });
    const existing = db.getUserByUsername(username);
    if (existing && existing.id !== id) return res.status(409).json({ error: 'Username already exists' });
    const ok = db.updateUser(id, name, username, password || null, permissions || [], !!is_admin);
    if (!ok) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth.requireAuth, auth.requirePermission('access_control'), function(req, res) {
  try {
    const id = Number(req.params.id);
    const user = db.getUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_admin) return res.status(400).json({ error: 'Cannot delete admin account' });
    db.deleteUser(id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


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

  // Full merge: all fields from both poses, keep chest/underbust from pose I
  const merged = {};
  if (poseI) Object.assign(merged, poseI);
  if (poseA) {
    for (const key of Object.keys(poseA)) {
      if (CHEST_UNDERBUST_FIELDS.includes(key) && poseI && poseI[key] != null) {
        merged[key] = poseI[key];
      } else {
        merged[key] = poseA[key];
      }
    }
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
app.get('/api/scan-summary', auth.requireAuth, auth.requirePermission('store_summary'), async (req, res) => {
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
app.get('/api/scan-summary/export', auth.requireAuth, auth.requirePermission('store_summary'), async (req, res) => {
  try {
    let stores = [];
    if (req.query.data) {
      stores = JSON.parse(req.query.data);
    } else {
      const resp = await fetch('http://localhost:' + PORT + '/api/scan-summary?start=' + req.query.start + '&end=' + req.query.end, {headers:{'x-auth-token': req.headers['x-auth-token'] || ''}});
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
app.get('/api/scan-members', auth.requireAuth, auth.requirePermission('members'), async (req, res) => {
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
    if (req.query.tag) filters.tag = req.query.tag;

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
      if (filters.tag) {
        const q = filters.tag.toLowerCase();
        const tags = rec.tag_list || [];
        const match = tags.some(function(t) { return t.toLowerCase().includes(q); });
        if (!match) continue;
      }
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
app.get('/api/scan-members/export', auth.requireAuth, auth.requirePermission('members'), async (req, res) => {
  try {
    var url = 'http://localhost:' + PORT + '/api/scan-members?start=' + req.query.start + '&end=' + req.query.end;
    if (req.query.userId) url += '&userId=' + encodeURIComponent(req.query.userId);
    if (req.query.store) url += '&store=' + encodeURIComponent(req.query.store);
    if (req.query.tag) url += '&tag=' + encodeURIComponent(req.query.tag);
    for (const key of Object.keys(MEASURE_FILTERS)) {
      const min = req.query[key + 'Min'];
      const max = req.query[key + 'Max'];
      if (min) url += '&' + key + 'Min=' + min;
      if (max) url += '&' + key + 'Max=' + max;
    }

    const resp = await fetch(url, {headers:{'x-auth-token': req.headers['x-auth-token'] || ''}});
    const data = await resp.json();
    const records = data.records || [];

    if (records.length === 0) {
      return res.status(404).json({ error: 'No data to export' });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TG Scan Dashboard';

    // Determine measurement columns from first record with measurements
    const isFullExport = req.query.full === 'true';
    const firstWithMeas = records.find(function(r) { return r.measurements; });
    var measureKeys = [];
    if (isFullExport && firstWithMeas) {
      var allKeys = Object.keys(firstWithMeas.measurements).sort();
      measureKeys = [];
      allKeys.forEach(function(k) {
        var label = MEASURE_LABELS[k] || k;
        var suffix = CHEST_UNDERBUST_FIELDS.indexOf(k) !== -1 ? ' (I)' : ' (A)';
        measureKeys.push({ key: k, label: label + suffix });
      });
    } else if (firstWithMeas) {
      var wanted = Object.keys(MEASURE_LABELS);
      var filtered = Object.keys(firstWithMeas.measurements).filter(function(k) { return wanted.indexOf(k) !== -1; }).sort();
      measureKeys = [];
      filtered.forEach(function(k) {
        var label = MEASURE_LABELS[k] || k;
        var suffix = CHEST_UNDERBUST_FIELDS.indexOf(k) !== -1 ? ' (I)' : ' (A)';
        measureKeys.push({ key: k, label: label + suffix });
      });
    }

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
    measureKeys.forEach(function(mk) {
      colDefs.push({ header: mk.label, key: mk.key, width: 16 });
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
        measureKeys.forEach(function(mk) {
          var v = r.measurements[mk.key];
          row[mk.key] = v != null ? (typeof v === 'number' ? +v.toFixed(1) : v) : '';
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
app.get('/api/sync', auth.requireAuth, auth.requirePermission('sync'), async function(req, res) {
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
app.get('/api/sync-cancel', auth.requireAuth, auth.requirePermission('sync'), function(req, res) {
  __syncCanceled = true;
  res.json({ success: true, message: 'Sync canceled' });
});

// Check sync status
app.get('/api/sync-status', auth.requireAuth, auth.requirePermission('sync'), function(req, res) {
  res.json({ running: !__syncCanceled, totalFetched: __syncTotal });
});



// Measurement cache sync
app.get('/api/sync-measurements', auth.requireAuth, auth.requirePermission('sync'), async function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (__measSyncState.running) return res.json({ success: false, error: 'Already running' });
  __measSyncState = { running: true, cancel: false, total: 0, done: 0 };
  try {
    // Date range from query params (default: all)
    var start = req.query.start || '2000-01-01';
    var end = (req.query.end || '2099-12-31') + 'T23:59:59.999Z';
    var allRecs = db.getRecordsByDateRange(start, end);
    // Sort newest first
    allRecs.sort(function(a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    var allTids = allRecs.map(function(r) { return r.tid; });
    var existing = db.getMeasurementsByTids(allTids);
    // Force re-sync: clear all cached measurements so both poses are saved fresh
    if (req.query.force === 'true') {
      db.clearAllMeasurements();
      existing = {};
    }
    var todo = allTids.filter(function(t) { return !existing[t]; });
    // Apply limit to pending records only (not pre-filtered)
    var limit = parseInt(req.query.limit) || 0;
    if (limit > 0) todo = todo.slice(0, limit);
    __measSyncState.total = todo.length;
    if (todo.length === 0) {
      __measSyncState.running = false;
      return res.json({ success: true, total: 0, completed: 0, message: 'All measurements already cached' });
    }
    res.json({ success: true, total: todo.length, started: true });
    // Background sync
    setImmediate(async function() {
      for (var i = 0; i < todo.length; i++) {
        if (__measSyncState.cancel) { break; }
        var pid = todo[i];
        var poseA = await fetchMeasurements(pid, 'A');
        await new Promise(function(r) { setTimeout(r, 1000); });
        var poseI = await fetchMeasurements(pid, 'I');
        if (poseA || poseI) {
          // Save both pose A and pose I data separately
          var save = {}; save[pid] = { poseA: poseA, poseI: poseI };
          // (merge logic is now handled in getMeasurementsByTids for display)
          db.saveMeasurements(save);
        }
        __measSyncState.done = i + 1;
        if ((i + 1) % 20 === 0 && global.gc) global.gc();
      }
      __measSyncState.running = false;
      console.log('[meas-sync] Complete: ' + __measSyncState.done + '/' + __measSyncState.total);
    });
  } catch (err) {
    __measSyncState.running = false;
    console.error('[meas-sync] Error:', err.message);
  }
});

app.get('/api/sync-measurements-cancel', auth.requireAuth, auth.requirePermission('sync'), function(req, res) {
  __measSyncState.cancel = true;
  res.json({ success: true });
});

app.get('/api/sync-measurements-status', auth.requireAuth, auth.requirePermission('sync'), function(req, res) {
  res.json({
    running: __measSyncState.running,
    total: __measSyncState.total,
    done: __measSyncState.done,
    pct: __measSyncState.total > 0 ? Math.round(__measSyncState.done / __measSyncState.total * 100) : 0
  });
});
// Debug: check seed.db status
app.get('/api/debug', auth.requireAuth, function(req, res) {
  var info = {}
  var seedPath = path.join(__dirname, 'seed.db');
  info.seedExists = require('fs').existsSync(seedPath);
  if (info.seedExists) {
    info.seedSize = require('fs').statSync(seedPath).size;
  }
  info.recordCount = 0;
  try {
    var mdb = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'scan_cache.db'));
    var cnt = mdb.prepare('SELECT COUNT(*) as c FROM scan_records').get();
    info.recordCount = cnt ? cnt.c : -1;
    mdb.close();
  } catch(e) { info.recordError = e.message; }
  res.json(info);
});

// Download scan_cache.db as a backup file
app.get('/api/db-download', auth.requireAuth, auth.requirePermission('sync'), function(req, res) {
  var dbPath = path.join(__dirname, 'data', 'scan_cache.db');
  var fn = 'scan_cache_backup_' + new Date().toISOString().slice(0,10) + '.db';
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '"');
  require('fs').createReadStream(dbPath).pipe(res);
});


// ---- Region Mappings ----

app.get('/api/region-mappings', auth.requireAuth, auth.requirePermission('region'), function(req, res) {
  try {
    var mappings = db.getAllRegionMappings();
    res.json(mappings);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/region-mappings', auth.requireAuth, auth.requirePermission('region'), function(req, res) {
  try {
    var manager_name = req.body.manager_name;
    var store_name = req.body.store_name;
    if (!manager_name || !store_name) return res.status(400).json({ error: '请填写负责人名称与门市名称' });
    var ok = db.addRegionMapping(manager_name, store_name);
    if (!ok) return res.status(409).json({ error: '该负责人与门市对应已存在' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/region-mappings/:id', auth.requireAuth, auth.requirePermission('region'), function(req, res) {
  try {
    db.deleteRegionMapping(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- Region Statistics ----

app.get('/api/region-stats', auth.requireAuth, auth.requirePermission('region'), async function(req, res) {
  try {
    var start = req.query.start;
    var end = req.query.end;
    if (!start || !end) return res.status(400).json({ error: '请选择日期范围' });
    var storeManagerMap = db.getStoreManagerMap();
    var records = db.getRecordsByDateRange(start, end + 'T23:59:59.999Z');
    var managerData = {};
    var unassignedRecords = 0;
    var unassignedUnique = new Set();
    for (var i = 0; i < records.length; i++) {
      var rec = JSON.parse(records[i].raw_json);
      var storeName = rec.scanner?.store?.name || '(unknown)';
      var managerName = storeManagerMap[storeName] || null;
      var dayKey = rec.created_at.slice(0, 10) + '_' + rec.user_id;
      if (managerName) {
        if (!managerData[managerName]) managerData[managerName] = { manager: managerName, stores: {}, totalRecords: 0, uniqueVisits: new Set() };
        var md = managerData[managerName];
        md.totalRecords++;
        md.uniqueVisits.add(dayKey);
        if (!md.stores[storeName]) md.stores[storeName] = { store: storeName, count: 0, visits: new Set() };
        md.stores[storeName].count++;
        md.stores[storeName].visits.add(dayKey);
      } else {
        unassignedRecords++;
        unassignedUnique.add(dayKey);
      }
    }
    var result = [];
    var keys = Object.keys(managerData).sort();
    for (var j = 0; j < keys.length; j++) {
      var md = managerData[keys[j]];
      var storeList = Object.keys(md.stores).sort().map(function(sk) {
        var sd = md.stores[sk];
        return { store: sd.store, scanRecords: sd.count, uniqueVisits: sd.visits.size };
      });
      result.push({ manager: md.manager, totalRecords: md.totalRecords, uniqueVisits: md.uniqueVisits.size, stores: storeList });
    }
    res.json({ start: start, end: end, managers: result, totalRecords: records.length, unassignedRecords: unassignedRecords, unassignedUniqueVisits: unassignedUnique.size });
  } catch(e) {
    console.error('Region stats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Region Stats Export ----

app.get('/api/region-stats/export', auth.requireAuth, auth.requirePermission('region'), async function(req, res) {
  try {
    var resp = await fetch('http://localhost:' + PORT + '/api/region-stats?start=' + req.query.start + '&end=' + req.query.end, {headers:{'x-auth-token': req.headers['x-auth-token']}});
    var data = await resp.json();
    var managers = data.managers || [];
    if (managers.length === 0 && data.unassignedRecords === 0) return res.status(404).json({ error: 'No data' });
    var wb = new ExcelJS.Workbook();
    wb.creator = 'TG Scan Dashboard';
    var ws = wb.addWorksheet('region_stats');
    ws.columns = [{header:'负责人',key:'manager',width:16},{header:'门市',key:'store',width:20},{header:'扫描次数',key:'records',width:12},{header:'不重复到访',key:'visits',width:14}];
    var hRow = ws.getRow(1);
    hRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C5CE7' } };
    hRow.alignment = { horizontal: 'center', vertical: 'middle' };
    for (var i = 0; i < managers.length; i++) {
      var mgr = managers[i];
      for (var s = 0; s < mgr.stores.length; s++) {
        ws.addRow({ manager: mgr.manager, store: mgr.stores[s].store, records: mgr.stores[s].scanRecords, visits: mgr.stores[s].uniqueVisits });
      }
      ws.addRow({ manager: mgr.manager + ' 小计', store: '', records: mgr.totalRecords, visits: mgr.uniqueVisits });
      ws.lastRow.font = { bold: true };
      ws.addRow({});
    }
    if (data.unassignedRecords > 0) ws.addRow({ manager: '未设定负责人', store: '', records: data.unassignedRecords, visits: data.unassignedUniqueVisits });
    var fn = encodeURIComponent('region_stats_' + req.query.start + '_' + req.query.end + '.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + fn);
    await wb.xlsx.write(res);
    res.end();
  } catch(e) {
    console.error('Region export error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, function() {
  console.log('Server running at http://localhost:' + PORT);
  // Restore seed data if DB is empty, then wait for manual sync
  try {
    var Database = require('better-sqlite3');
    var seedPath = path.join(__dirname, "seed.db");
    if (require('fs').existsSync(seedPath)) {
      var mdb = new Database(path.join(__dirname, 'data', 'scan_cache.db'));
      var cnt = mdb.prepare('SELECT COUNT(*) as c FROM scan_records').get();
      if (cnt && cnt.c === 0) {
        console.log('[startup] DB empty, importing from seed.db...');
        var sdb = new Database(seedPath, { readonly: true });
        var rows = sdb.prepare('SELECT * FROM scan_records').all();
        var meas = sdb.prepare('SELECT * FROM measurements').all();
        sdb.close();
        var insRec = mdb.prepare('INSERT OR IGNORE INTO scan_records (tid, user_id, nick_name, real_name, created_at, updated_at, store_name, scanner_name, accuracy_score, tag_list, raw_json, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        var txnRec = mdb.transaction(function(rows) { for (var i = 0; i < rows.length; i++) { var r = rows[i]; insRec.run(r.tid, r.user_id, r.nick_name, r.real_name, r.created_at, r.updated_at, r.store_name, r.scanner_name, r.accuracy_score, r.tag_list, r.raw_json, r.fetched_at); } });
        txnRec(rows);
        var insMeas = mdb.prepare('INSERT OR IGNORE INTO measurements (tid, data_json, fetched_at) VALUES (?,?,?)');
        var txnMeas = mdb.transaction(function(rows) { for (var i = 0; i < rows.length; i++) { var m = rows[i]; insMeas.run(m.tid, m.data_json, m.fetched_at); } });
        txnMeas(meas);
        mdb.close();
        mdb.close();
        db.reopen();
        console.log('[startup] Seed imported: ' + rows.length + ' records, ' + meas.length + ' measurements');
      } else {
        mdb.close();
      }
    }
  } catch (e) {
    console.log('[startup] Seed restore skipped:', e.message);
  }
  console.log('[startup] Server ready. Click sync button to fetch data from API.');
  // Original warmup code (commented out):
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
