/**
 * State — menyimpan deal DCA aktif & history
 */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.RAILWAY_ENVIRONMENT
  ? '/tmp/dca-state.json'
  : path.join(__dirname, 'state.json');

function loadLocal() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (!s.pendingReopens)     s.pendingReopens     = {}; // backward-compat state.json lama
      if (!s.trendStatus)        s.trendStatus        = {}; // backward-compat state.json lama
      if (!s.pendingEntries)     s.pendingEntries     = {}; // backward-compat state.json lama
      if (!s.pendingLimitEntries) s.pendingLimitEntries = {}; // backward-compat state.json lama
      if (!s.positions)          s.positions          = {}; // backward-compat state.json lama — Manual Position (di luar DCA)
      if (!s.closedPositions)    s.closedPositions    = []; // backward-compat state.json lama
      if (s.compoundingPool === undefined)    s.compoundingPool    = 0;
      if (s.compoundingNotified === undefined) s.compoundingNotified = false;
      return s;
    }
  } catch (err) {
    log('state_error', `Gagal baca state: ${err.message}`);
  }
  return {
    deals: {}, closedDeals: [], totalPnlUsdt: 0, pendingReopens: {}, trendStatus: {},
    compoundingPool: 0, compoundingNotified: false, pendingEntries: {}, pendingLimitEntries: {},
    positions: {}, closedPositions: [],
  };
}

function saveLocal(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log('state_error', `Gagal simpan state: ${err.message}`);
  }
}

let _state = loadLocal();

export function hasActiveDeal(symbol) { return !!_state.deals[symbol]; }
export function getDeal(symbol)       { return _state.deals[symbol] || null; }
export function getActiveDeals()      { return _state.deals; }
export function getActiveSymbols()    { return Object.keys(_state.deals); }

export function startDeal(symbol, { qty, price, budget, orderId, feeUsdt = 0 }) {
  const deal = {
    symbol,
    status:            'active',
    baseOrderPrice:    price,
    avgPrice:          price,
    totalQty:          qty,
    totalSpent:        qty * price,
    safetyOrdersFilled: 0,
    nextSOPrice:       null,
    nextSOSize:        null,
    tpPrice:           null,
    slPrice:           null,
    tpHold:            false, // TP Hold — kalau true, TP dilewati sementara (SO & SL tetap jalan normal)
    buyFeeUsdt:        feeUsdt, // akumulasi fee BELI (base order + semua SO), dalam USDT
    openedAt:          new Date().toISOString(),
    orders: [
      { tag: 'base', qty, price, budget, orderId, fee: feeUsdt, filledAt: new Date().toISOString() },
    ],
  };
  _state.deals[symbol] = deal;
  saveLocal(_state);
  log('state', `📂 Deal dibuka: ${symbol} @ ${price} budget=${budget}${feeUsdt ? ` fee=${feeUsdt.toFixed(4)} USDT` : ''}`);
  return deal;
}

export function addSafetyOrderFill(symbol, { step, qty, price, budget, orderId, feeUsdt = 0 }) {
  const deal = _state.deals[symbol];
  if (!deal) return null;
  deal.orders.push({ tag: `so${step}`, qty, price, budget, orderId, fee: feeUsdt, filledAt: new Date().toISOString() });
  deal.buyFeeUsdt = (deal.buyFeeUsdt || 0) + feeUsdt;
  saveLocal(_state);
  log('state', `➕ SO${step} terisi: ${symbol} @ ${price} budget=${budget}${feeUsdt ? ` fee=${feeUsdt.toFixed(4)} USDT` : ''}`);
  return deal;
}

export function updateDealCalc(symbol, patch) {
  const deal = _state.deals[symbol];
  if (!deal) return null;
  Object.assign(deal, patch);
  saveLocal(_state);
  return deal;
}

/**
 * TP Hold — bekukan sementara logic Take Profit utk 1 deal. Selama hold aktif,
 * SO & SL TETAP jalan normal seperti biasa; cuma TP yang dilewati. Dipakai kalau
 * user mau nunggu kenaikan lebih tinggi dari target TP normal sebelum jual.
 */
export function setTpHold(symbol, hold) {
  const deal = _state.deals[symbol];
  if (!deal) return null;
  deal.tpHold = !!hold;
  saveLocal(_state);
  log('state', `${hold ? '⏸' : '▶'} TP Hold ${hold ? 'diaktifkan' : 'dinonaktifkan'}: ${symbol}`);
  return deal;
}

/**
 * Close deal DENGAN harga exit asli (TP/SL/Manual Close via bot).
 * pnlUsdt hasil deal ini SENGAJA ditambahkan ke compoundingPool — itu "profit"
 * (atau rugi, kalau negatif) yang jadi basis fitur compounding.
 *
 * pnlUsdt SEKARANG SUDAH DIKURANGI FEE (beli semua order + jual) — fee beli
 * diakumulasi tiap kali order terisi (lihat startDeal/addSafetyOrderFill),
 * fee jual (feeUsdt param) datang dari closeDealMarket() di executor.js.
 * pnlPct sekarang dihitung sebagai ROI terhadap modal (totalSpent), BUKAN
 * cuma selisih harga murni — supaya representatif dgn pnlUsdt yang net-fee.
 */
export function closeDeal(symbol, { exitPrice, reason, feeUsdt: sellFeeUsdt = 0 }) {
  const deal = _state.deals[symbol];
  if (!deal) return null;

  const grossPnlUsdt = (exitPrice - deal.avgPrice) * deal.totalQty;
  const buyFeeUsdt    = deal.buyFeeUsdt || 0;
  const totalFeeUsdt  = buyFeeUsdt + sellFeeUsdt;
  const pnlUsdt = grossPnlUsdt - totalFeeUsdt;
  const pnlPct  = deal.totalSpent > 0 ? (pnlUsdt / deal.totalSpent) * 100 : 0;

  const closed = {
    ...deal,
    status:    'closed',
    exitPrice,
    closedAt:  new Date().toISOString(),
    reason,
    grossPnlUsdt, // PnL SEBELUM dikurangi fee — disimpan utk referensi/transparansi
    buyFeeUsdt,
    sellFeeUsdt,
    totalFeeUsdt,
    pnlUsdt,       // PnL BERSIH — sudah dikurangi fee beli + jual
    pnlPct,        // ROI bersih terhadap modal (totalSpent), sudah termasuk fee
  };

  _state.closedDeals.push(closed);
  _state.totalPnlUsdt = (_state.totalPnlUsdt || 0) + pnlUsdt;
  _state.compoundingPool = (_state.compoundingPool || 0) + pnlUsdt;
  delete _state.deals[symbol];
  saveLocal(_state);

  log('state', `📁 Deal ditutup: ${symbol} @ ${exitPrice} | PnL=${pnlPct.toFixed(2)}% (${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT) | reason=${reason}`);
  return closed;
}

/**
 * Untrack — dipakai kalau user JUAL SENDIRI di luar bot (manual di app exchange).
 * BEDA dari closeDeal(): tidak ada exitPrice/eksekusi order, dan PnL SENGAJA
 * tidak dihitung/ditambahkan ke totalPnlUsdt ATAU compoundingPool — supaya statistik
 * & compounding bot tetap murni mencerminkan performa keputusan OTOMATIS bot sendiri.
 */
export function untrackDeal(symbol) {
  const deal = _state.deals[symbol];
  if (!deal) return null;

  const closed = {
    ...deal,
    status:    'closed',
    exitPrice: null,
    closedAt:  new Date().toISOString(),
    reason:    'manual_untracked',
    pnlUsdt:   null,
    pnlPct:    null,
  };

  _state.closedDeals.push(closed);
  // totalPnlUsdt & compoundingPool SENGAJA TIDAK diubah di sini.
  delete _state.deals[symbol];
  saveLocal(_state);

  log('state', `📁 Deal di-untrack (manual, di luar bot): ${symbol} | SO terpakai=${deal.safetyOrdersFilled} | PnL TIDAK dihitung ke statistik/compounding`);
  return closed;
}

// ── Auto Reopen scheduling ──────────────────────────────────────────────────
/**
 * retryCount: dipakai internal buat batasi berapa kali auto-reopen boleh
 * dicoba ulang kalau gagal karena error transient (network/timeout dll).
 * Default 0 saat dijadwalkan pertama kali (bukan hasil retry).
 */
export function schedulePendingReopen(symbol, closedAt, cooldownMin, retryCount = 0) {
  _state.pendingReopens[symbol] = { readyAt: closedAt + cooldownMin * 60 * 1000, closedAt, retryCount };
  saveLocal(_state);
}

export function clearPendingReopen(symbol) {
  delete _state.pendingReopens[symbol];
  saveLocal(_state);
}

export function getPendingReopens() { return _state.pendingReopens; }

// ── Pending Entries (dipakai entryFilter.js — entry baru yang nunggu syarat EMA) ─
export function schedulePendingEntry(symbol, price = null) {
  _state.pendingEntries[symbol] = { requestedAt: Date.now(), price };
  saveLocal(_state);
}

export function clearPendingEntry(symbol) {
  delete _state.pendingEntries[symbol];
  saveLocal(_state);
}

export function getPendingEntries() { return _state.pendingEntries; }
export function hasPendingEntry(symbol) { return !!_state.pendingEntries[symbol]; }

// ── Pending Limit Entries (base order dipasang sbg LIMIT order, nunggu fill) ─
export function schedulePendingLimitEntry(symbol, info) {
  _state.pendingLimitEntries[symbol] = info;
  saveLocal(_state);
}

export function clearPendingLimitEntry(symbol) {
  delete _state.pendingLimitEntries[symbol];
  saveLocal(_state);
}

export function getPendingLimitEntries() { return _state.pendingLimitEntries; }
export function hasPendingLimitEntry(symbol) { return !!_state.pendingLimitEntries[symbol]; }

// ── Trend status (dipakai trendMonitor.js) ──────────────────────────────────
export function getTrendStatus(symbol) {
  return _state.trendStatus?.[symbol] || null;
}

export function setTrendStatus(symbol, status) {
  if (!_state.trendStatus) _state.trendStatus = {};
  _state.trendStatus[symbol] = status;
  saveLocal(_state);
}

// ── Compounding pool (dipakai compounding.js) ───────────────────────────────
export function getCompoundingPool() { return _state.compoundingPool || 0; }

export function resetCompoundingPool() {
  _state.compoundingPool = 0;
  saveLocal(_state);
}

export function getCompoundingNotified() { return !!_state.compoundingNotified; }

export function setCompoundingNotified(val) {
  _state.compoundingNotified = !!val;
  saveLocal(_state);
}

export function getStats() {
  return {
    activeDeals: Object.keys(_state.deals).length,
    closedCount: _state.closedDeals.length,
    totalPnlUsdt: _state.totalPnlUsdt || 0,
  };
}

export function getClosedDeals(limit = 50) {
  return _state.closedDeals.slice(-limit).reverse();
}

// ── Manual Position (DILUAR DCA) — entry manual + trailing stop ────────────
// State SEPENUHNYA terpisah dari _state.deals — 1 symbol bisa punya DCA deal
// DAN Manual Position sekaligus tanpa saling mengganggu.

export function hasActivePosition(symbol) { return !!_state.positions[symbol]; }
export function getPosition(symbol)       { return _state.positions[symbol] || null; }
export function getActivePositions()      { return _state.positions; }
export function getActivePositionSymbols(){ return Object.keys(_state.positions); }

/**
 * Buka posisi manual baru (entry pertama). stopLossPercent/trailingActivationPercent/
 * trailingStopPercent "dikunci" saat posisi dibuka (dari config.position saat itu) —
 * ganti config setelahnya TIDAK mempengaruhi posisi yang sudah berjalan.
 */
export function startPosition(symbol, { qty, price, budget, orderId, feeUsdt = 0, stopLossPercent, trailingActivationPercent, trailingStopPercent }) {
  const position = {
    symbol,
    status: 'active',
    totalQty: qty,
    totalSpent: qty * price,
    avgPrice: price,
    buyFeeUsdt: feeUsdt,
    stopLossPercent,
    slPrice: null, // dihitung lewat recalcPosition() di executor.js
    trailingActivationPercent,
    trailingStopPercent,
    trailingActive: false,
    peakPrice: null,
    trailingStopPrice: null,
    openedAt: new Date().toISOString(),
    entries: [
      { qty, price, budget, orderId, fee: feeUsdt, filledAt: new Date().toISOString() },
    ],
  };
  _state.positions[symbol] = position;
  saveLocal(_state);
  log('state', `🚀 Position dibuka: ${symbol} @ ${price} budget=${budget}`);
  return position;
}

/**
 * Entry tambahan MANUAL — kapan saja, harga apa saja (hasil beli aktual).
 * avgPrice/qty/SL di-recalculate di executor.js (recalcPosition), yang juga
 * ME-RESET status trailing (aktif/peak) — lihat recalcPosition() di
 * positionEngine.js utk alasannya.
 */
export function addPositionEntry(symbol, { qty, price, budget, orderId, feeUsdt = 0 }) {
  const position = _state.positions[symbol];
  if (!position) return null;
  position.entries.push({ qty, price, budget, orderId, fee: feeUsdt, filledAt: new Date().toISOString() });
  position.buyFeeUsdt = (position.buyFeeUsdt || 0) + feeUsdt;
  saveLocal(_state);
  log('state', `➕ Entry tambahan: ${symbol} @ ${price} budget=${budget}`);
  return position;
}

export function updatePositionCalc(symbol, patch) {
  const position = _state.positions[symbol];
  if (!position) return null;
  Object.assign(position, patch);
  saveLocal(_state);
  return position;
}

/**
 * Aktifkan trailing stop pertama kali (harga baru saja nyentuh titik aktivasi).
 */
export function activatePositionTrailing(symbol, peakPrice, trailingStopPrice) {
  const position = _state.positions[symbol];
  if (!position) return null;
  position.trailingActive = true;
  position.peakPrice = peakPrice;
  position.trailingStopPrice = trailingStopPrice;
  saveLocal(_state);
  log('state', `🔔 Trailing Stop AKTIF: ${symbol} @ peak=${peakPrice}`);
  return position;
}

/**
 * Update peakPrice begitu harga bikin rekor baru (trailing sudah aktif).
 */
export function updatePositionPeak(symbol, peakPrice, trailingStopPrice) {
  const position = _state.positions[symbol];
  if (!position) return null;
  position.peakPrice = peakPrice;
  position.trailingStopPrice = trailingStopPrice;
  saveLocal(_state);
  return position;
}

/**
 * Close posisi manual (Stop Loss, Trailing Stop, atau Close manual via user).
 */
export function closePosition(symbol, { exitPrice, reason, feeUsdt: sellFeeUsdt = 0 }) {
  const position = _state.positions[symbol];
  if (!position) return null;

  const grossPnlUsdt = (exitPrice - position.avgPrice) * position.totalQty;
  const buyFeeUsdt    = position.buyFeeUsdt || 0;
  const totalFeeUsdt  = buyFeeUsdt + sellFeeUsdt;
  const pnlUsdt = grossPnlUsdt - totalFeeUsdt;
  const pnlPct  = position.totalSpent > 0 ? (pnlUsdt / position.totalSpent) * 100 : 0;

  const closed = {
    ...position,
    status: 'closed',
    exitPrice,
    closedAt: new Date().toISOString(),
    reason,
    grossPnlUsdt,
    buyFeeUsdt,
    sellFeeUsdt,
    totalFeeUsdt,
    pnlUsdt,
    pnlPct,
  };

  _state.closedPositions.push(closed);
  delete _state.positions[symbol];
  saveLocal(_state);

  log('state', `📁 Position ditutup: ${symbol} @ ${exitPrice} | PnL=${pnlPct.toFixed(2)}% (${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT) | reason=${reason}`);
  return closed;
}

export function getClosedPositions(limit = 50) {
  return _state.closedPositions.slice(-limit).reverse();
}

export function getPositionStats() {
  return {
    activePositions: Object.keys(_state.positions).length,
    closedCount: _state.closedPositions.length,
    totalPnlUsdt: _state.closedPositions.reduce((s, p) => s + (p.pnlUsdt || 0), 0),
  };
}

export function reload() { _state = loadLocal(); }
