/**
 * API Server — Dashboard REST Endpoints (DCA Bot)
 */
import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';
import { log }             from './logger.js';
import { getCurrentPrice } from './bitget.js';
import { getStats, getActiveDeals, getClosedDeals, getTrendStatus, getPendingEntries, getPendingLimitEntries, getActivePositions, getClosedPositions } from './state.js';
import { config, saveConfig } from './config.js';
import { analyzeTrend } from './trendMonitor.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
// Prioritas: DASHBOARD_PORT (kalau di-set eksplisit) > PORT (Railway auto-inject
// utk service dgn public networking) > 3001 (default dev lokal).
const PORT       = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || '3001');
const API_SECRET = process.env.DASHBOARD_SECRET || '';

let _callbacks = {};
export function setApiCallbacks(cb) { _callbacks = cb; }

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Secret',
  });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 400) { json(res, { ok: false, error: msg }, status); }

function serveDashboard(res) {
  try {
    const filePath = path.join(__dirname, 'dashboard.html');
    const html = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Gagal load dashboard.html: ${e.message}`);
  }
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

function checkAuth(req) {
  if (!API_SECRET) return true;
  return req.headers['x-secret'] === API_SECRET;
}

function tailLog(lines = 150) {
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const logFile = path.join(__dirname, 'logs', `dca-${today}.log`);
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-lines);
  } catch { return []; }
}

async function handle(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const route  = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Secret' });
    res.end(); return;
  }

  // Serve dashboard.html langsung di root — buka URL Railway = langsung liat dashboard.
  if ((route === '/' || route === '/dashboard') && method === 'GET') {
    serveDashboard(res);
    return;
  }

  if (method === 'POST' && !checkAuth(req)) { err(res, 'Unauthorized', 401); return; }

  if (route === '/api/status' && method === 'GET') {
    const stats = getStats();
    const deals = getActiveDeals();
    const feePct = config.trading.takerFeePercent ?? 0.1; // dipakai utk estimasi fee jual (belum tereksekusi, jadi belum pasti)
    const enriched = {};
    for (const [sym, d] of Object.entries(deals)) {
      const price = await getCurrentPrice(sym).catch(() => null);
      const buyFeeUsdt = d.buyFeeUsdt || 0;
      let pnlPct = null, pnlUsdt = null, grossPnlUsdt = null, estSellFeeUsdt = null;
      if (price) {
        grossPnlUsdt   = (price - d.avgPrice) * d.totalQty;
        estSellFeeUsdt = (price * d.totalQty) * (feePct / 100); // ESTIMASI — fee jual pasti baru diketahui setelah order tereksekusi
        pnlUsdt        = grossPnlUsdt - buyFeeUsdt - estSellFeeUsdt;
        pnlPct          = d.totalSpent > 0 ? (pnlUsdt / d.totalSpent) * 100 : 0;
      }
      enriched[sym] = {
        ...d, currentPrice: price, pnlPct, pnlUsdt, grossPnlUsdt, buyFeeUsdt, estSellFeeUsdt,
        trendStatus: getTrendStatus(sym),
      };
    }

    // Manual Position (DILUAR DCA) — enrichment PnL live sama pola dgn deal DCA di atas.
    const positions = getActivePositions();
    const enrichedPositions = {};
    for (const [sym, p] of Object.entries(positions)) {
      const price = await getCurrentPrice(sym).catch(() => null);
      const buyFeeUsdt = p.buyFeeUsdt || 0;
      let pnlPct = null, pnlUsdt = null, grossPnlUsdt = null, estSellFeeUsdt = null;
      if (price) {
        grossPnlUsdt   = (price - p.avgPrice) * p.totalQty;
        estSellFeeUsdt = (price * p.totalQty) * (feePct / 100);
        pnlUsdt        = grossPnlUsdt - buyFeeUsdt - estSellFeeUsdt;
        pnlPct         = p.totalSpent > 0 ? (pnlUsdt / p.totalSpent) * 100 : 0;
      }
      enrichedPositions[sym] = { ...p, currentPrice: price, pnlPct, pnlUsdt, grossPnlUsdt, buyFeeUsdt, estSellFeeUsdt };
    }

    json(res, {
      ok: true,
      stats,
      deals: enriched,
      positions: enrichedPositions,
      pendingEntries: getPendingEntries(),
      pendingLimitEntries: getPendingLimitEntries(),
      config: { dca: config.dca, trading: config.trading, position: config.position, isDryRun: process.env.DRY_RUN === 'true' },
      serverTime: new Date().toISOString(),
    });
    return;
  }

  if (route === '/api/history' && method === 'GET') {
    // ?limit= opsional — default 200, dinaikkan dari 100 supaya perhitungan
    // PnL Harian di dashboard tidak kepotong kalau history sudah panjang.
    // Dibatasi max 2000 biar tidak berat kalau ada yang iseng minta limit gede.
    const requested = parseInt(url.searchParams.get('limit') || '200');
    const limit = Math.min(Math.max(requested || 200, 1), 2000);
    json(res, { ok: true, deals: getClosedDeals(limit) });
    return;
  }

  if (route === '/api/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('n') || '150');
    json(res, { ok: true, logs: tailLog(n) });
    return;
  }

  if (route.startsWith('/api/price/') && method === 'GET') {
    const symbol = route.split('/').pop().toUpperCase();
    const price  = await getCurrentPrice(symbol).catch(() => null);
    json(res, { ok: true, symbol, price });
    return;
  }

  // Analisa tren fresh (live), TIDAK menimpa status tersimpan yang dipakai
  // background loop utk deteksi perubahan — murni utk tampilan "cek sekarang".
  if (route.startsWith('/api/trend/') && method === 'GET') {
    const symbol = route.split('/').pop().toUpperCase();
    try {
      const result = await analyzeTrend(symbol);
      if (!result) { err(res, `Data candle ${symbol} tidak cukup utk analisa tren`); return; }
      json(res, { ok: true, symbol, ...result });
    } catch (e) { err(res, e.message); }
    return;
  }

  // Status pool profit compounding — polling ringan dari dashboard.
  if (route === '/api/compound/status' && method === 'GET') {
    try { json(res, { ok: true, ..._callbacks.compoundStatus() }); }
    catch (e) { err(res, e.message); }
    return;
  }

  // Terapkan compounding sekarang (pakai seluruh pool yang terkumpul).
  if (route === '/api/compound/apply' && method === 'POST') {
    try { json(res, await _callbacks.compoundNow()); }
    catch (e) { err(res, e.message); }
    return;
  }

  if (route === '/api/config' && method === 'GET') { json(res, { ok: true, config }); return; }

  if (route === '/api/config' && method === 'POST') {
    const body = await readBody(req);
    try { saveConfig(body); json(res, { ok: true, config }); }
    catch (e) { err(res, e.message); }
    return;
  }

  if (route === '/api/start' && method === 'POST') {
    const { symbol, price } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    const parsedPrice = (price !== undefined && price !== null && price !== '') ? parseFloat(price) : null;
    if (parsedPrice !== null && (!(parsedPrice > 0))) { err(res, 'price tidak valid'); return; }
    try { json(res, await _callbacks.startDeal(symbol.toUpperCase(), parsedPrice)); }
    catch (e) { err(res, e.message); }
    return;
  }

  // Entry manual tambahan ke deal DCA yang SUDAH AKTIF — budget bebas, market
  // buy sekarang juga, di luar kuota Safety Order.
  if (route === '/api/deal/add-entry' && method === 'POST') {
    const { symbol, budget } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    const parsedBudget = parseFloat(budget);
    if (!(parsedBudget > 0)) { err(res, 'budget tidak valid'); return; }
    try { json(res, await _callbacks.addManualDealEntry(symbol.toUpperCase(), parsedBudget)); }
    catch (e) { err(res, e.message); }
    return;
  }

  // Batalkan entry yang lagi pending (nunggu syarat Entry Filter).
  if (route === '/api/cancel-entry' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, _callbacks.cancelPendingEntry(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  // Batalkan limit order yang lagi nunggu fill (base order belum kefill).
  if (route === '/api/cancel-limit' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, await _callbacks.cancelPendingLimitEntry(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  if (route === '/api/close' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, await _callbacks.closeDealManual(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  // Close TANPA eksekusi order — user sudah jual sendiri di luar bot.
  // PnL deal ini TIDAK dihitung ke statistik/compounding (lihat state.js -> untrackDeal).
  if (route === '/api/untrack' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, await _callbacks.closeDealUntrack(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  // Bekukan TP sementara — SO & SL tetap jalan normal.
  if (route === '/api/hold' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, _callbacks.holdTP(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  // Aktifkan lagi TP normal.
  if (route === '/api/resume' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, _callbacks.resumeTP(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  // ── Manual Position (DILUAR DCA) ────────────────────────────────────────
  if (route === '/api/position/add' && method === 'POST') {
    const { symbol, budget } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    const parsedBudget = parseFloat(budget);
    if (!(parsedBudget > 0)) { err(res, 'budget tidak valid'); return; }
    try { json(res, await _callbacks.addPosition(symbol.toUpperCase(), parsedBudget)); }
    catch (e) { err(res, e.message); }
    return;
  }

  if (route === '/api/position/close' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, await _callbacks.closePositionManual(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  if (route === '/api/position/history' && method === 'GET') {
    const requested = parseInt(url.searchParams.get('limit') || '200');
    const limit = Math.min(Math.max(requested || 200, 1), 2000);
    json(res, { ok: true, positions: getClosedPositions(limit) });
    return;
  }

  json(res, { ok: false, error: 'Route tidak ditemukan' }, 404);
}

export function startApiServer(callbacks) {
  setApiCallbacks(callbacks);
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); } catch (e) { err(res, e.message, 500); }
  });
  server.listen(PORT, () => {
    log('api_server', `✅ Dashboard API DCA berjalan di http://localhost:${PORT} (buka "/" utk lihat dashboard)`);
  });
  return server;
}