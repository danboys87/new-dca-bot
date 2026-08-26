/**
 * Telegram Notifications — DCA Bot
 */
import { log } from './logger.js';
import { config } from './config.js';

const getToken  = () => process.env.TELEGRAM_BOT_TOKEN;
const getChatId = () => process.env.TELEGRAM_CHAT_ID;
const getBase   = () => { const t = getToken(); return t ? `https://api.telegram.org/bot${t}` : null; };

export function isEnabled() { return !!(getToken() && getChatId()); }

async function send(text) {
  if (!isEnabled()) return;
  try {
    await fetch(`${getBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: getChatId(), text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    log('telegram_error', `Gagal kirim: ${err.message}`);
  }
}

function slLabel(deal) {
  if (deal.slPrice) return deal.slPrice.toFixed(6);
  return deal.nextSOPrice !== null ? 'belum aktif (masih ada slot SO)' : '—';
}

function tpLabel(deal) {
  if (deal.tpPriceBase != null && deal.tpPriceAverage != null) {
    return `${deal.tpPrice?.toFixed(6)} (base: ${deal.tpPriceBase.toFixed(6)} | avg: ${deal.tpPriceAverage.toFixed(6)})`;
  }
  return deal.tpPrice?.toFixed(6) ?? '—';
}

export async function notifyDealOpened(deal) {
  await send(
    `🟢 <b>Deal Dibuka</b> — ${deal.symbol}\n` +
    `Base order: ${deal.orders[0].qty} @ ${deal.orders[0].price} (${deal.orders[0].budget} USDT)\n` +
    `TP: ${tpLabel(deal)} | SL: ${slLabel(deal)}\n` +
    `SO berikutnya @ ${deal.nextSOPrice?.toFixed(6) ?? '—'}`
  );
}

export async function notifySafetyOrder(deal, step) {
  await send(
    `➕ <b>Safety Order ${step} Terisi</b> — ${deal.symbol}\n` +
    `Avg price baru: ${deal.avgPrice.toFixed(6)} | Total qty: ${deal.totalQty}\n` +
    `TP baru: ${tpLabel(deal)} | SL: ${slLabel(deal)}\n` +
    `SO berikutnya @ ${deal.nextSOPrice?.toFixed(6) ?? '(kuota SO habis — SL sekarang aktif)'}`
  );
}

export async function notifyDealClosed(closed) {
  const emoji = closed.pnlPct >= 0 ? '🟢' : '🔴';
  const sign  = closed.pnlPct >= 0 ? '+' : '';
  const labels = { take_profit: '🎯 Take Profit', stop_loss: '🛑 Stop Loss', manual_close: '🖐 Manual Close' };
  const feeLine = closed.totalFeeUsdt
    ? `Fee: ${closed.totalFeeUsdt.toFixed(4)} USDT (beli ${closed.buyFeeUsdt.toFixed(4)} + jual ${closed.sellFeeUsdt.toFixed(4)}) — sudah dipotong dari PnL\n`
    : '';
  await send(
    `${emoji} <b>Deal Ditutup</b> — ${closed.symbol}\n` +
    `📌 ${labels[closed.reason] || closed.reason}\n` +
    `Avg entry: ${closed.avgPrice.toFixed(6)} → Exit: ${closed.exitPrice.toFixed(6)}\n` +
    `PnL: ${sign}${closed.pnlPct.toFixed(2)}% (${sign}${closed.pnlUsdt.toFixed(2)} USDT)\n` +
    feeLine +
    `Safety order terpakai: ${closed.safetyOrdersFilled}`
  );
}

/**
 * Notif utk mode "Manual Sell" (untrack) — TIDAK ada eksekusi order dari bot,
 * dan PnL SENGAJA tidak dihitung/ditampilkan karena tidak dicatat di statistik.
 */
export async function notifyDealUntracked(closed) {
  await send(
    `🖐 <b>Deal Ditandai Selesai (Manual Sell)</b> — ${closed.symbol}\n` +
    `Dijual sendiri di luar bot — bot TIDAK mengeksekusi order apapun.\n` +
    `Avg entry: ${closed.avgPrice.toFixed(6)} | Safety order terpakai: ${closed.safetyOrdersFilled}\n` +
    `<i>⚠️ PnL deal ini TIDAK dihitung ke statistik/Total PnL/compounding.</i>`
  );
}

export async function notifyError(message) { await send(`⚠️ <b>DCA Bot Error</b>\n${message}`); }

export async function notifyStartup(dryRun, cfg) {
  await send(
    `🚀 <b>DCA Bot Aktif</b>\n` +
    `Mode: ${dryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}\n` +
    `Base order: ${cfg.dca.baseOrderSize} USDT | Safety order: ${cfg.dca.safetyOrderSize} USDT x${cfg.dca.maxSafetyOrders}\n` +
    `Deviasi SO: ${cfg.dca.priceDeviationPercent}% | TP: ${cfg.dca.takeProfitPercent}% (basis: ${cfg.dca.takeProfitBasis})\n` +
    `SL: ${cfg.dca.stopLossEnabled ? cfg.dca.stopLossPercent + '% (basis: ' + cfg.dca.stopLossBasis + ')' : 'nonaktif'}\n` +
    `Max deal bersamaan: ${cfg.trading.maxActiveDeals}`
  );
}

// ── Trend Monitor (informatif saja — tidak mempengaruhi SO/TP/SL) ──────────
const trendLabel = { bullish: '📈 Bullish', bearish: '📉 Bearish', netral: '➖ Netral/Sideways' };

export async function notifyTrendChange(symbol, prevStatus, newStatus, price, timeframe) {
  await send(
    `🔔 <b>Perubahan Tren</b>${timeframe ? ` (${timeframe.toUpperCase()})` : ''} — ${symbol}\n` +
    `${trendLabel[prevStatus] || prevStatus} → <b>${trendLabel[newStatus] || newStatus}</b>\n` +
    `Harga sekarang: ${price}\n` +
    `<i>Info saja — SO/TP/SL tetap jalan seperti biasa.</i>`
  );
}

// ── Entry Filter (AKTIF memblokir entry baru — beda dari Trend Monitor) ────
export async function notifyEntryPending(symbol, filter) {
  await send(
    `⏸ <b>Entry Ditunda</b> — ${symbol}\n` +
    `Harga ${filter.price} masih di bawah EMA${filter.period} (${filter.ema.toFixed(6)}) @ ${filter.timeframe.toUpperCase()}.\n` +
    `Bot akan otomatis buka deal begitu harga naik ke atas EMA.\n` +
    `<i>Ketik /cancelentry ${symbol} kalau mau batalkan.</i>`
  );
}

export async function notifyEntryCancelled(symbol) {
  await send(`🚫 <b>Entry Dibatalkan</b> — ${symbol}\nPending entry dihapus, tidak akan dibuka otomatis.`);
}

// ── Limit Order Entry (base order dipasang sbg limit, nunggu fill) ─────────
export async function notifyLimitOrderPlaced(symbol, price, qty) {
  await send(
    `📝 <b>Limit Order Ditempatkan</b> — ${symbol}\n` +
    `Beli ${qty} @ ${price}\n` +
    `Menunggu order terisi (fill)...\n` +
    `<i>Ketik /cancellimit ${symbol} kalau mau batalkan.</i>`
  );
}

export async function notifyLimitOrderCancelled(symbol, price, reason) {
  await send(
    `🚫 <b>Limit Order Dibatalkan</b> — ${symbol}\n` +
    `Order beli @ ${price} dibatalkan.\n` +
    `Alasan: ${reason}`
  );
}

// ── Compounding ──────────────────────────────────────────────────────────
export async function notifyCompoundingAvailable(pool, threshold) {
  await send(
    `💰 <b>Profit Siap Di-Compound</b>\n` +
    `Pool terkumpul: +${pool.toFixed(2)} USDT (threshold: ${threshold} USDT)\n` +
    `Base Order saat ini: ${config.dca.baseOrderSize} USDT | Safety Order: ${config.dca.safetyOrderSize} USDT\n\n` +
    `Ketik <b>/compound apply</b> utk terapkan sekarang, atau biarkan pool terus bertambah dulu.`
  );
}

export async function notifyCompoundingApplied(result) {
  await send(
    `✅ <b>Compounding Diterapkan</b>\n` +
    `Profit dipakai: +${result.pool.toFixed(2)} USDT\n` +
    `Base Order: ${result.oldBase} → <b>${result.newBase}</b> USDT\n` +
    `Safety Order: ${result.oldSO} → <b>${result.newSO}</b> USDT\n` +
    `<i>Berlaku utk deal baru berikutnya.</i>`
  );
}