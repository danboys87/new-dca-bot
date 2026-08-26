/**
 * DCA Bot — Safety Order style (ala 3Commas) — Bitget Spot
 * Standalone project, terpisah dari bot UTBot.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import readline from 'readline';
import { log }              from './logger.js';
import { config, saveConfig } from './config.js';
import { testConnection, getCurrentPrice } from './bitget.js';
import {
  getActiveSymbols, getDeal, getActiveDeals, getStats, getClosedDeals, hasActiveDeal,
  schedulePendingReopen, clearPendingReopen, getPendingReopens, untrackDeal, setTpHold,
  getCompoundingNotified, setCompoundingNotified,
  schedulePendingEntry, clearPendingEntry, getPendingEntries, hasPendingEntry,
  schedulePendingLimitEntry, clearPendingLimitEntry, getPendingLimitEntries, hasPendingLimitEntry,
} from './state.js';
import { evaluateDeal } from './dcaEngine.js';
import {
  openDeal, openDealLimit, checkLimitOrderFilled, cancelPendingLimitOrder, finalizeBaseOrder,
  fillSafetyOrder, closeDealMarket,
} from './executor.js';
import {
  notifyDealOpened, notifySafetyOrder, notifyDealClosed, notifyDealUntracked, notifyError, notifyStartup,
  notifyCompoundingAvailable, notifyCompoundingApplied, notifyEntryPending, notifyEntryCancelled,
  notifyLimitOrderPlaced, notifyLimitOrderCancelled,
} from './telegram.js';
import { startTelegramPolling, stopTelegramPolling } from './telegramCommands.js';
import { startApiServer } from './apiServer.js';
import { checkAllTrends } from './trendMonitor.js';
import { getCompoundingStatus, applyCompounding } from './compounding.js';
import { checkEntryAllowed } from './entryFilter.js';

const isDryRun = process.env.DRY_RUN === 'true';
const args     = process.argv.slice(2);

// Alasan penolakan gate check (bukan error network) — kalau auto-reopen gagal
// karena salah satu dari ini, JANGAN diulang otomatis (percuma, kondisinya
// gak akan berubah cuma dengan nunggu beberapa menit lagi kecuali situasinya
// sendiri berubah — misal slot baru kosong setelah deal lain closed).
const PERMANENT_REOPEN_REJECTIONS = ['sudah aktif', 'ada di blacklist', 'tidak ada di whitelist', 'Slot deal penuh'];

let _loopBusy = false;
let _loopTimer = null;
let _trendTimer = null;

// ─────────────────────────────────────────────────────────────────────────────
// START / CLOSE DEAL (dipakai oleh Telegram & API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eksekusi buka deal SUNGGUHAN — dipanggil setelah semua gate (active check,
 * max deal, blacklist/whitelist, entry filter) lolos. Cabang sesuai
 * config.trading.entryOrderType:
 *  - 'market' (default): beli langsung di harga pasar, deal langsung aktif.
 *  - 'limit': pasang limit buy, deal BELUM aktif sampai order-nya kefill
 *    (lihat processPendingLimitOrders()).
 */
async function executeStartDeal(symbol, price = null) {
  // Kalau user kasih harga spesifik saat start, PAKSA limit order di harga itu —
  // terlepas dari config.trading.entryOrderType. Kalau tidak, ikut config seperti biasa.
  const orderType = price ? 'limit' : (config.trading.entryOrderType ?? 'market');

  if (orderType === 'limit') {
    try {
      const result = await openDealLimit(symbol, price);
      const { orderId, price: fillPrice, qty, budget } = result;
      schedulePendingLimitEntry(symbol, { orderId, price: fillPrice, qty, budget, placedAt: Date.now() });
      await notifyLimitOrderPlaced(symbol, fillPrice, qty);
      return {
        ok: true,
        pending: true,
        limitOrder: true,
        message: `Limit buy ${symbol} ditempatkan @ ${fillPrice}, menunggu fill`,
      };
    } catch (e) {
      log('executor_error', `Gagal pasang limit order ${symbol}: ${e.message}`);
      await notifyError(`Gagal pasang limit order ${symbol}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  try {
    const deal = await openDeal(symbol);
    await notifyDealOpened(deal);
    return { ok: true, deal };
  } catch (e) {
    log('executor_error', `Buka deal ${symbol} gagal: ${e.message}`);
    await notifyError(`Buka deal ${symbol} gagal: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * price (opsional): kalau diisi, base order dipasang sebagai LIMIT order
 * PERSIS di harga itu (bukan market, dan bukan offset % otomatis).
 */
export async function startDeal(symbol, price = null) {
  if (hasActiveDeal(symbol)) return { ok: false, error: `Deal ${symbol} sudah aktif` };
  if (hasPendingEntry(symbol)) return { ok: true, pending: true, message: `${symbol} sudah dalam antrian pending entry` };
  if (hasPendingLimitEntry(symbol)) return { ok: true, pending: true, message: `${symbol} sudah ada limit order yang nunggu fill` };

  if (price !== null && price !== undefined && !(price > 0)) {
    return { ok: false, error: `Harga tidak valid: ${price}` };
  }

  const active  = getActiveSymbols().length;
  const maxDeal = config.trading.maxActiveDeals ?? 5;
  if (active >= maxDeal) return { ok: false, error: `Slot deal penuh (${active}/${maxDeal})` };

  if (config.blacklist?.includes(symbol)) return { ok: false, error: `${symbol} ada di blacklist` };
  if (config.whitelist?.length && !config.whitelist.includes(symbol)) {
    return { ok: false, error: `${symbol} tidak ada di whitelist` };
  }

  // Entry Filter — opsional, default OFF. Kalau ON dan syarat belum terpenuhi,
  // entry ditunda (pending) bukan ditolak permanen. Harga limit (kalau ada)
  // ikut disimpan supaya tetap dipakai begitu syarat terpenuhi nanti.
  const filter = await checkEntryAllowed(symbol);
  if (!filter.allowed) {
    schedulePendingEntry(symbol, price);
    log('entry_filter', `⏸ Entry ${symbol} pending — harga ${filter.price} < EMA${filter.period} ${filter.timeframe} (${filter.ema.toFixed(6)})`);
    await notifyEntryPending(symbol, filter);
    return {
      ok: true,
      pending: true,
      message: `Entry ${symbol} ditunda, nunggu harga di atas EMA${filter.period} (${filter.timeframe.toUpperCase()})`,
      filter,
    };
  }

  return executeStartDeal(symbol, price);
}

export function cancelPendingEntry(symbol) {
  if (!hasPendingEntry(symbol)) return { ok: false, error: `${symbol} tidak ada di pending entry` };
  clearPendingEntry(symbol);
  notifyEntryCancelled(symbol);
  return { ok: true };
}

/**
 * Batalkan limit order yang masih nunggu fill (dipanggil manual oleh user,
 * beda dari pembatalan otomatis karena timeout di processPendingLimitOrders()).
 */
export async function cancelPendingLimitEntry(symbol) {
  if (!hasPendingLimitEntry(symbol)) return { ok: false, error: `${symbol} tidak ada limit order pending` };
  const info = getPendingLimitEntries()[symbol];
  clearPendingLimitEntry(symbol);
  await cancelPendingLimitOrder(info.orderId, symbol);
  await notifyLimitOrderCancelled(symbol, info.price, 'Dibatalkan manual oleh user');
  return { ok: true };
}

async function processPendingEntries() {
  const pending = getPendingEntries();
  const symbols = Object.keys(pending);
  if (!symbols.length) return;

  const maxDeal = config.trading.maxActiveDeals ?? 5;

  for (const symbol of symbols) {
    if (hasActiveDeal(symbol)) { clearPendingEntry(symbol); continue; } // safety net, seharusnya jarang terjadi

    const active = getActiveSymbols().length;
    if (active >= maxDeal) continue; // slot masih penuh, cek lagi loop berikutnya

    try {
      const filter = await checkEntryAllowed(symbol);
      if (filter.allowed) {
        const savedPrice = pending[symbol]?.price ?? null;
        clearPendingEntry(symbol);
        log('entry_filter', `▶ Entry ${symbol} syarat terpenuhi — membuka deal sekarang`);
        const res = await executeStartDeal(symbol, savedPrice);
        if (!res.ok) log('entry_filter_warn', `Gagal buka pending entry ${symbol}: ${res.error}`);
      }
    } catch (e) {
      log('entry_filter_warn', `Cek pending entry ${symbol} gagal: ${e.message}`);
    }
    await sleep(300); // jaga rate limit Bitget
  }
}

/**
 * Cek semua limit order yang lagi nunggu fill. Kalau sudah terisi, deal
 * difinalisasi (baru sekarang beneran jadi "deal aktif" di state). Kalau
 * belum terisi & sudah lewat entryLimitTimeoutMin, order dibatalkan otomatis.
 */
async function processPendingLimitOrders() {
  const pending = getPendingLimitEntries();
  const symbols = Object.keys(pending);
  if (!symbols.length) return;

  const timeoutMin = config.trading.entryLimitTimeoutMin ?? 15;
  const now = Date.now();

  for (const symbol of symbols) {
    const info = pending[symbol];
    try {
      const result = await checkLimitOrderFilled(info.orderId, symbol);

      if (result.filled) {
        clearPendingLimitEntry(symbol);
        const deal = finalizeBaseOrder(symbol, {
          qty:     result.qty ?? info.qty,
          price:   result.price ?? info.price,
          budget:  info.budget,
          orderId: info.orderId,
          feeUsdt: result.feeUsdt ?? 0,
        });
        log('executor', `✅ Limit order terisi: ${symbol} @ ${deal.avgPrice}`);
        await notifyDealOpened(deal);
        continue;
      }

      const elapsedMin = (now - info.placedAt) / 60000;
      if (elapsedMin >= timeoutMin) {
        clearPendingLimitEntry(symbol);
        await cancelPendingLimitOrder(info.orderId, symbol);
        await notifyLimitOrderCancelled(symbol, info.price, `Tidak terisi dalam ${timeoutMin} menit (timeout otomatis)`);
        log('executor', `⏱️ Limit order ${symbol} dibatalkan — timeout ${timeoutMin} menit tanpa fill`);
      }
    } catch (e) {
      log('executor_error', `Cek limit order ${symbol} gagal: ${e.message}`);
    }
    await sleep(300); // jaga rate limit Bitget
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TP HOLD — bekukan sementara Take Profit utk 1 deal. SO & SL tetap jalan normal.
// ─────────────────────────────────────────────────────────────────────────────
export function holdTP(symbol) {
  if (!hasActiveDeal(symbol)) return { ok: false, error: `Deal ${symbol} tidak aktif` };
  const deal = setTpHold(symbol, true);
  return { ok: true, deal };
}

export function resumeTP(symbol) {
  if (!hasActiveDeal(symbol)) return { ok: false, error: `Deal ${symbol} tidak aktif` };
  const deal = setTpHold(symbol, false);
  return { ok: true, deal };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO REOPEN — bisa di-toggle ON/OFF sewaktu-waktu lewat config.trading.reopenAfterClose
// ─────────────────────────────────────────────────────────────────────────────
function maybeScheduleReopen(closed) {
  const t = config.trading;
  if (!t.reopenAfterClose) return; // fitur OFF → tidak dijadwalkan sama sekali

  const reasons = t.reopenOnReasons ?? ['take_profit'];
  if (!reasons.includes(closed.reason)) return; // reason ini tidak termasuk yang di-reopen

  const cooldownMin = t.cooldownAfterCloseMin ?? 5;
  schedulePendingReopen(closed.symbol, Date.now(), cooldownMin);
  log('reopen', `⏳ ${closed.symbol} dijadwalkan auto-reopen dalam ${cooldownMin} menit (alasan close: ${closed.reason})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPOUNDING — cek status pool tiap ada deal closed (yang punya PnL asli).
// Default MANUAL (kasih notif, tunggu /compound apply). Bisa di-set auto-apply
// lewat config.trading.compoundingAutoApply.
// ─────────────────────────────────────────────────────────────────────────────
async function maybeHandleCompounding() {
  if (!config.trading.compoundingEnabled) return;

  const status = getCompoundingStatus();

  if (!status.ready) {
    if (getCompoundingNotified()) setCompoundingNotified(false); // reset flag kalau pool turun lagi di bawah threshold (misal abis rugi)
    return;
  }

  if (status.autoApply) {
    const result = applyCompounding();
    if (result.ok) {
      await notifyCompoundingApplied(result);
      setCompoundingNotified(false);
    }
    return;
  }

  if (!getCompoundingNotified()) {
    await notifyCompoundingAvailable(status.pool, status.threshold);
    setCompoundingNotified(true); // jangan notif berulang tiap loop, cukup sekali sampai di-apply atau pool turun lagi
  }
}

export async function compoundNow() {
  const result = applyCompounding();
  if (result.ok) {
    await notifyCompoundingApplied(result);
    setCompoundingNotified(false);
  }
  return result;
}

export function compoundStatus() {
  return getCompoundingStatus();
}

/**
 * Proses semua symbol yang lagi menunggu cooldown auto-reopen selesai.
 *
 * Kalau reopen GAGAL karena alasan PERMANEN (blacklist, slot penuh, dst) —
 * tidak diulang, karena percuma dicoba lagi tanpa kondisinya berubah.
 *
 * Kalau reopen GAGAL karena error lain (biasanya network/timeout transient,
 * kayak "getaddrinfo EAI_AGAIN") — dijadwalkan ulang otomatis, sampai maksimal
 * `maxReopenRetries` kali (default 5), dengan jeda `reopenRetryDelayMin` menit
 * (default 2) tiap percobaan. Kalau tetap gagal setelah retry habis, bot
 * berhenti nyoba dan kirim notifikasi supaya user buka manual kalau perlu.
 */
async function processPendingReopens() {
  const pending = getPendingReopens();
  const symbols = Object.keys(pending);
  if (symbols.length === 0) return;

  const maxRetries      = config.trading.maxReopenRetries ?? 5;
  const retryDelayMin   = config.trading.reopenRetryDelayMin ?? 2;
  const now = Date.now();

  for (const symbol of symbols) {
    const info = pending[symbol];
    if (now < info.readyAt) continue; // cooldown/retry-delay belum selesai

    clearPendingReopen(symbol); // dihapus dulu — kalau perlu retry, dijadwalkan ulang di bawah (bukan dibiarkan nyangkut)

    if (!config.trading.reopenAfterClose) {
      log('reopen', `⏭️ Auto-reopen ${symbol} dilewati — fitur sedang OFF saat cooldown selesai`);
      continue;
    }
    if (hasActiveDeal(symbol)) continue; // sudah dibuka manual duluan

    const attemptNo = (info.retryCount ?? 0) + 1;
    log('reopen', `🔁 Cooldown selesai, membuka kembali ${symbol} otomatis... (percobaan ke-${attemptNo})`);

    let res;
    try {
      res = await startDeal(symbol); // ikut lewat entry filter/limit order juga kalau aktif
    } catch (e) {
      res = { ok: false, error: e.message };
    }

    if (res.ok || res.pending) continue; // sukses terbuka, atau masuk antrian pending — selesai, gak perlu retry reopen lagi

    const isPermanent = PERMANENT_REOPEN_REJECTIONS.some(reason => res.error?.includes(reason));
    if (isPermanent) {
      log('reopen_warn', `Auto-reopen ${symbol} dibatalkan (alasan tidak akan berubah): ${res.error}`);
      continue;
    }

    if (attemptNo >= maxRetries) {
      log('reopen_warn', `Auto-reopen ${symbol} menyerah setelah ${maxRetries}x percobaan: ${res.error}`);
      await notifyError(`Auto-reopen ${symbol} gagal ${maxRetries}x berturut-turut (${res.error}). Buka manual kalau masih mau lanjut deal ini.`);
      continue;
    }

    log('reopen_warn', `Gagal auto-reopen ${symbol} (percobaan ke-${attemptNo}): ${res.error} — dijadwalkan ulang dalam ${retryDelayMin} menit`);
    schedulePendingReopen(symbol, Date.now(), retryDelayMin, attemptNo);
  }
}

/**
 * Close manual DENGAN eksekusi market sell asli dari bot.
 */
export async function closeDealManual(symbol) {
  if (!hasActiveDeal(symbol)) return { ok: false, error: `Deal ${symbol} tidak aktif` };
  try {
    const closed = await closeDealMarket(symbol, 'manual_close');
    await notifyDealClosed(closed);
    maybeScheduleReopen(closed);
    await maybeHandleCompounding();
    return { ok: true, closed };
  } catch (e) {
    log('executor_error', `Tutup deal ${symbol} gagal: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Close manual TANPA eksekusi order — dipakai kalau user jual sendiri di luar bot
 * (langsung di app exchange). Bot cuma berhenti mantau deal ini. PnL TIDAK dihitung
 * ke statistik/Total PnL/compounding bot karena tidak ada harga jual asli yang bot tahu.
 */
export async function closeDealUntrack(symbol) {
  if (!hasActiveDeal(symbol)) return { ok: false, error: `Deal ${symbol} tidak aktif` };
  try {
    const closed = untrackDeal(symbol);
    await notifyDealUntracked(closed);
    maybeScheduleReopen(closed); // no-op kecuali user tambahin 'manual_untracked' ke reopenOnReasons
    return { ok: true, closed };
  } catch (e) {
    log('executor_error', `Untrack deal ${symbol} gagal: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN LOOP — cek tiap deal aktif, jalankan SO / TP / SL sesuai dcaEngine
// ─────────────────────────────────────────────────────────────────────────────
async function checkDeals() {
  if (_loopBusy) return;
  _loopBusy = true;
  try {
    const symbols = getActiveSymbols();

    for (const symbol of symbols) {
      const deal = getDeal(symbol);
      if (!deal) continue;

      try {
        const price = await getCurrentPrice(symbol);
        if (!price) continue;

        const decision = evaluateDeal(deal, price, config.dca);

        if (decision.action === 'take_profit' && deal.tpHold) {
          // TP Hold aktif — dilewati sengaja, deal tetap terbuka nunggu di-resume manual.
          log('dca', `⏸ TP hit tapi HOLD aktif: ${symbol} @ ${price} (TP=${deal.tpPrice.toFixed(6)}) — dilewati`);

        } else if (decision.action === 'take_profit') {
          log('dca', `🎯 TP hit: ${symbol} @ ${price} (TP=${deal.tpPrice.toFixed(6)})`);
          const closed = await closeDealMarket(symbol, 'take_profit');
          await notifyDealClosed(closed);
          maybeScheduleReopen(closed);
          await maybeHandleCompounding();

        } else if (decision.action === 'stop_loss') {
          // SL TETAP jalan normal walau TP Hold aktif — hold cuma utk TP, bukan proteksi rugi.
          log('dca', `🛑 SL hit: ${symbol} @ ${price} (SL=${deal.slPrice.toFixed(6)})`);
          const closed = await closeDealMarket(symbol, 'stop_loss');
          await notifyDealClosed(closed);
          maybeScheduleReopen(closed);
          await maybeHandleCompounding();

        } else if (decision.action === 'place_so') {
          log('dca', `➕ SO${decision.step} trigger: ${symbol} @ ${price} (target=${deal.nextSOPrice.toFixed(6)})`);
          const updated = await fillSafetyOrder(symbol, decision.step, decision.size);
          await notifySafetyOrder(updated, decision.step);

        } else {
          const slLog = deal.slPrice ? deal.slPrice.toFixed(6) : (deal.nextSOPrice !== null ? 'belum aktif' : '—');
          const holdLog = deal.tpHold ? ' | ⏸ TP HOLD' : '';
          log('dca',
            `  ${symbol} | price=${price} avg=${deal.avgPrice.toFixed(6)} ` +
            `TP=${deal.tpPrice?.toFixed(6)} SL=${slLog} ` +
            `nextSO=${deal.nextSOPrice?.toFixed(6) ?? 'habis'} | SO ${deal.safetyOrdersFilled}/${config.dca.maxSafetyOrders}${holdLog}`
          );
        }
      } catch (err) {
        log('dca_error', `Evaluasi ${symbol} gagal: ${err.message}`);
      }

      await sleep(300);
    }

    await processPendingReopens();
    await processPendingEntries();
    await processPendingLimitOrders();
  } finally {
    _loopBusy = false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startLoop() {
  stopLoop();
  const sec = config.trading.checkIntervalSec ?? 30;
  log('startup', `Loop cek deal aktif tiap ${sec} detik`);
  _loopTimer = setInterval(checkDeals, sec * 1000);
  checkDeals();
}

function stopLoop() {
  if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TREND LOOP — analisa tren (informatif saja, terpisah dari loop DCA utama)
// ─────────────────────────────────────────────────────────────────────────────
function startTrendLoop() {
  stopTrendLoop();
  const min = config.trading.trendCheckIntervalMin ?? 30;
  log('startup', `Loop analisa tren tiap ${min} menit`);
  _trendTimer = setInterval(() => checkAllTrends(getActiveSymbols()), min * 60 * 1000);
  checkAllTrends(getActiveSymbols());
}

function stopTrendLoop() {
  if (_trendTimer) { clearInterval(_trendTimer); _trendTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
async function showStatus() {
  const stats = getStats();
  const deals = getActiveDeals();

  console.log('\n══════════════════════════════════════');
  console.log('  📊 STATUS DCA BOT');
  console.log('══════════════════════════════════════');
  console.log(`  Mode        : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE'}`);
  console.log(`  Deal aktif  : ${stats.activeDeals}/${config.trading.maxActiveDeals}`);
  console.log(`  Closed      : ${stats.closedCount}`);
  console.log(`  Total PnL   : ${stats.totalPnlUsdt >= 0 ? '+' : ''}${stats.totalPnlUsdt.toFixed(2)} USDT`);

  for (const [symbol, d] of Object.entries(deals)) {
    const price = await getCurrentPrice(symbol).catch(() => null);
    const pnl   = price ? ((price - d.avgPrice) / d.avgPrice * 100) : null;
    console.log(`\n  ${symbol}${d.tpHold ? ' ⏸ TP HOLD' : ''}`);
    console.log(`    avg=${d.avgPrice.toFixed(6)} now=${price ?? '—'} PnL=${pnl !== null ? pnl.toFixed(2) + '%' : '—'}`);
    console.log(`    SO ${d.safetyOrdersFilled}/${config.dca.maxSafetyOrders} | nextSO=${d.nextSOPrice?.toFixed(6) ?? 'habis'}`);
    const slLog = d.slPrice ? d.slPrice.toFixed(6) : (d.nextSOPrice !== null ? 'belum aktif' : '—');
    console.log(`    TP=${d.tpPrice?.toFixed(6)} SL=${slLog}`);
  }

  const pendingEntries = getPendingEntries();
  const pendingEntrySyms = Object.keys(pendingEntries);
  if (pendingEntrySyms.length) {
    console.log('\n  Entry Pending (Entry Filter):');
    for (const s of pendingEntrySyms) {
      const menit = Math.round((Date.now() - pendingEntries[s].requestedAt) / 60000);
      console.log(`    ${s} — nunggu ${menit} menit`);
    }
  }

  const pendingLimits = getPendingLimitEntries();
  const pendingLimitSyms = Object.keys(pendingLimits);
  if (pendingLimitSyms.length) {
    console.log('\n  Limit Order Pending:');
    for (const s of pendingLimitSyms) {
      const menit = Math.round((Date.now() - pendingLimits[s].placedAt) / 60000);
      console.log(`    ${s} — @ ${pendingLimits[s].price} — nunggu ${menit} menit`);
    }
  }

  const pending = getPendingReopens();
  const pendingSyms = Object.keys(pending);
  console.log(`\n  Auto Reopen : ${config.trading.reopenAfterClose ? 'ON' : 'OFF'} (cooldown ${config.trading.cooldownAfterCloseMin ?? 5} menit, max retry ${config.trading.maxReopenRetries ?? 5}x tiap ${config.trading.reopenRetryDelayMin ?? 2}m)`);
  if (pendingSyms.length) {
    console.log('  Menunggu reopen:');
    for (const s of pendingSyms) {
      const sisaMin = Math.max(0, Math.round((pending[s].readyAt - Date.now()) / 60000));
      const retryTag = pending[s].retryCount ? ` (retry ke-${pending[s].retryCount})` : '';
      console.log(`    ${s} — sisa ~${sisaMin} menit${retryTag}`);
    }
  }
  console.log(`  Cek Tren    : EMA${config.trading.trendEmaPeriod ?? 21} @ ${(config.trading.trendTimeframe ?? '1h').toUpperCase()}, tiap ${config.trading.trendCheckIntervalMin ?? 30} menit`);
  console.log(`  Entry Filter: ${config.trading.entryFilterEnabled ? `ON — EMA${config.trading.entryFilterEmaPeriod ?? 9} @ ${(config.trading.entryFilterTimeframe ?? '5min').toUpperCase()}` : 'OFF'}`);
  console.log(`  Entry Order : ${(config.trading.entryOrderType ?? 'market').toUpperCase()}${config.trading.entryOrderType === 'limit' ? ` (offset -${config.trading.entryLimitOffsetPercent ?? 0.1}%, timeout ${config.trading.entryLimitTimeoutMin ?? 15}m)` : ''}`);
  const cs = compoundStatus();
  console.log(`  Compounding : ${cs.enabled ? `pool=${cs.pool.toFixed(2)}/${cs.threshold} USDT ${cs.ready ? '(siap!)' : ''}` : 'OFF'}`);
  console.log('══════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────────
function startREPL() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n[dca-bot] > ' });
  console.log('\n📖 Perintah: status | start SYMBOL [HARGA] | close SYMBOL | untrack SYMBOL | hold SYMBOL | resume SYMBOL | pending | cancelentry SYMBOL | cancellimit SYMBOL | compound [apply] | reopen on/off | stop | help\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const [cmd, arg, arg2] = line.trim().split(/\s+/);
    switch ((cmd || '').toLowerCase()) {
      case 'status': await showStatus(); break;
      case 'start': {
        if (!arg) { console.log('Format: start SYMBOL [HARGA]  (HARGA opsional utk limit order persis di harga itu)'); break; }
        const price = arg2 ? parseFloat(arg2) : null;
        if (arg2 && !(price > 0)) { console.log(`Harga tidak valid: ${arg2}`); break; }
        console.log(await startDeal(arg.toUpperCase(), price));
        break;
      }
      case 'close':
        if (!arg) { console.log('Format: close SYMBOL'); break; }
        console.log(await closeDealManual(arg.toUpperCase())); break;
      case 'untrack':
        if (!arg) { console.log('Format: untrack SYMBOL  (tandai selesai TANPA sell dari bot, PnL tidak dihitung)'); break; }
        console.log(await closeDealUntrack(arg.toUpperCase())); break;
      case 'hold':
        if (!arg) { console.log('Format: hold SYMBOL  (bekukan TP sementara, SO & SL tetap normal)'); break; }
        console.log(holdTP(arg.toUpperCase())); break;
      case 'resume':
        if (!arg) { console.log('Format: resume SYMBOL  (aktifkan lagi TP normal)'); break; }
        console.log(resumeTP(arg.toUpperCase())); break;
      case 'pending':
        console.log({ entryFilter: getPendingEntries(), limitOrders: getPendingLimitEntries() }); break;
      case 'cancelentry':
        if (!arg) { console.log('Format: cancelentry SYMBOL'); break; }
        console.log(cancelPendingEntry(arg.toUpperCase())); break;
      case 'cancellimit':
        if (!arg) { console.log('Format: cancellimit SYMBOL'); break; }
        console.log(await cancelPendingLimitEntry(arg.toUpperCase())); break;
      case 'compound':
        if ((arg || '').toLowerCase() === 'apply') { console.log(await compoundNow()); }
        else { console.log(compoundStatus()); }
        break;
      case 'reopen':
        if (!arg || !['on', 'off'].includes(arg.toLowerCase())) { console.log('Format: reopen on | reopen off'); break; }
        saveConfig({ trading: { reopenAfterClose: arg.toLowerCase() === 'on' } });
        console.log(`🔁 Auto Reopen sekarang: ${config.trading.reopenAfterClose ? 'ON' : 'OFF'}`);
        break;
      case 'stop': stopLoop(); stopTrendLoop(); stopTelegramPolling(); process.exit(0); break;
      case 'help':
        console.log('  status | start SYMBOL [HARGA] | close SYMBOL | untrack SYMBOL | hold SYMBOL | resume SYMBOL | pending | cancelentry SYMBOL | cancellimit SYMBOL | compound [apply] | reopen on/off | stop'); break;
      default: console.log(`❓ Perintah tidak dikenal: "${cmd}"`);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  DCA Bot — Safety Order (ala 3Commas)            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Mode: ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}`);
  console.log('');

  if (!isDryRun) {
    log('startup', 'Mengecek koneksi Bitget API...');
    const conn = await testConnection();
    if (!conn.ok) { log('startup_error', `Koneksi API gagal: ${conn.error}`); process.exit(1); }
    log('startup', `✅ Koneksi OK | ${conn.assets} aset ditemukan`);
  } else {
    log('startup', '🧪 DRY RUN mode - API connection skipped');
  }

  const d = config.dca;
  log('startup', `Config DCA:`);
  log('startup', `  Base order   : ${d.baseOrderSize} USDT`);
  log('startup', `  Safety order : ${d.safetyOrderSize} USDT x${d.safetyOrderVolumeScale} tiap step | max ${d.maxSafetyOrders}`);
  log('startup', `  Deviasi SO   : ${d.priceDeviationPercent}% x${d.safetyOrderStepScale} tiap step`);
  log('startup', `  TP           : ${d.takeProfitPercent}% (basis: ${d.takeProfitBasis})`);
  log('startup', `  SL           : ${d.stopLossEnabled ? d.stopLossPercent + '% (basis: ' + d.stopLossBasis + ')' : 'nonaktif'}`);
  log('startup', `  Max deal     : ${config.trading.maxActiveDeals}`);

  await notifyStartup(isDryRun, config);

  if (args.includes('--list-only')) { await showStatus(); process.exit(0); }

  startLoop();
  startTrendLoop();

  startTelegramPolling({
    startDeal, closeDealManual, closeDealUntrack, holdTP, resumeTP,
    compoundNow, compoundStatus, cancelPendingEntry, cancelPendingLimitEntry,
  });

  startApiServer({
    startDeal, closeDealManual, closeDealUntrack, holdTP, resumeTP,
    compoundNow, compoundStatus, cancelPendingEntry, cancelPendingLimitEntry,
  });

  if (process.stdin.isTTY) startREPL();
  else log('startup', 'Non-TTY mode - berjalan sebagai daemon');
}

main().catch(err => { log('fatal', err.message); process.exit(1); });
