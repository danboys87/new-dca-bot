/**
 * Telegram Command Handler — DCA Bot
 */
import { log } from './logger.js';
import { getStats, getActiveDeals, getDeal, getClosedDeals, getActiveSymbols, getPendingEntries, getPendingLimitEntries, getActivePositions } from './state.js';
import { getCurrentPrice } from './bitget.js';
import { config, saveConfig } from './config.js';
import { analyzeTrend } from './trendMonitor.js';

const getToken  = () => process.env.TELEGRAM_BOT_TOKEN;
const getChatId = () => process.env.TELEGRAM_CHAT_ID;
const getBase   = () => { const t = getToken(); return t ? `https://api.telegram.org/bot${t}` : null; };

let _offset = 0, _polling = false, _pollTimer = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function reply(chatId, text) {
  if (!getBase()) return;
  try {
    await fetch(`${getBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (err) { log('telegram_error', `Reply error: ${err.message}`); }
}

async function getUpdates() {
  if (!getBase()) return [];
  try {
    const res  = await fetch(`${getBase()}/getUpdates?offset=${_offset}&timeout=10&allowed_updates=["message"]`);
    const data = await res.json();
    return data.ok ? data.result : [];
  } catch { return []; }
}

async function buildDealsText() {
  const deals = getActiveDeals();
  const syms  = Object.keys(deals);
  if (!syms.length) return '📭 Tidak ada deal aktif.';

  const feePct = config.trading.takerFeePercent ?? 0.1;
  let text = `📊 <b>Deal Aktif (${syms.length}):</b>\n\n`;
  for (const sym of syms) {
    const d   = deals[sym];
    const cur = await getCurrentPrice(sym).catch(() => null);
    let pnl = null;
    if (cur) {
      const grossPnlUsdt   = (cur - d.avgPrice) * d.totalQty;
      const buyFeeUsdt     = d.buyFeeUsdt || 0;
      const estSellFeeUsdt = (cur * d.totalQty) * (feePct / 100);
      const pnlUsdt        = grossPnlUsdt - buyFeeUsdt - estSellFeeUsdt;
      pnl = d.totalSpent > 0 ? (pnlUsdt / d.totalSpent) * 100 : 0;
    }
    text += `<b>${sym}</b>${d.tpHold ? ' ⏸ <i>TP HOLD</i>' : ''}\n`;
    text += `  Avg: ${d.avgPrice.toFixed(6)} | Now: ${cur ?? '—'} | PnL (net fee): ${pnl !== null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%' : '—'}\n`;
    text += `  SO terpakai: ${d.safetyOrdersFilled}/${config.dca.maxSafetyOrders} | Next SO @ ${d.nextSOPrice?.toFixed(6) ?? 'habis'}\n`;
    const slText = d.slPrice ? d.slPrice.toFixed(6) : (d.nextSOPrice !== null ? 'belum aktif (masih ada SO)' : '—');
    const tpText = (d.tpPriceBase != null && d.tpPriceAverage != null)
      ? `${d.tpPrice?.toFixed(6)} (base: ${d.tpPriceBase.toFixed(6)} | avg: ${d.tpPriceAverage.toFixed(6)})`
      : d.tpPrice?.toFixed(6);
    text += `  TP: ${tpText}${d.tpHold ? ' (⏸ dilewati sementara)' : ''} | SL: ${slText}\n\n`;
  }
  return text;
}

function buildPendingText() {
  const entryPending = getPendingEntries();
  const limitPending  = getPendingLimitEntries();
  const entrySyms = Object.keys(entryPending);
  const limitSyms = Object.keys(limitPending);

  if (!entrySyms.length && !limitSyms.length) return '📭 Tidak ada entry/limit order pending.';

  let text = '';
  if (entrySyms.length) {
    text += `⏸ <b>Entry Pending — Entry Filter (${entrySyms.length}):</b>\n`;
    for (const sym of entrySyms) {
      const menit = Math.round((Date.now() - entryPending[sym].requestedAt) / 60000);
      text += `<b>${sym}</b> — nunggu ${menit} menit\n`;
    }
    text += `Ketik /cancelentry SYMBOL utk batalkan.\n\n`;
  }
  if (limitSyms.length) {
    text += `📝 <b>Limit Order Pending (${limitSyms.length}):</b>\n`;
    for (const sym of limitSyms) {
      const menit = Math.round((Date.now() - limitPending[sym].placedAt) / 60000);
      text += `<b>${sym}</b> @ ${limitPending[sym].price} — nunggu ${menit} menit\n`;
    }
    text += `Ketik /cancellimit SYMBOL utk batalkan.`;
  }
  return text.trim();
}

// ── Trend Monitor helpers ───────────────────────────────────────────────────
const trendLabel = { bullish: '📈 Bullish', bearish: '📉 Bearish', netral: '➖ Netral' };

function buildTrendText(symbol, r) {
  return (
    `<b>${symbol}</b> — ${trendLabel[r.status] || r.status}\n` +
    `Harga: ${r.price}\n` +
    `EMA${r.period}: ${r.ema.toFixed(6)}\n` +
    `Timeframe: ${r.timeframe.toUpperCase()}`
  );
}

async function handleCommand(chatId, text, callbacks) {
  if (String(chatId) !== String(getChatId())) { await reply(chatId, '⛔ Tidak diizinkan.'); return; }

  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const arg   = parts[1]?.toUpperCase();

  log('telegram', `Cmd: ${cmd}${arg ? ' ' + arg : ''}`);

  switch (cmd) {
    case '/startdca': {
      if (!arg) { await reply(chatId, '❓ Format: /startdca SYMBOL [HARGA]\nContoh: /startdca BTCUSDT\nContoh limit order di harga tertentu: /startdca BTCUSDT 60000'); break; }

      const priceArg = parts[2];
      let price = null;
      if (priceArg) {
        price = parseFloat(priceArg);
        if (!(price > 0)) { await reply(chatId, `❓ Harga tidak valid: ${priceArg}`); break; }
      }

      await reply(chatId, price
        ? `⏳ Memasang limit buy ${arg} @ ${price}...`
        : `⏳ Membuka deal DCA ${arg}...`);
      try {
        const res = await callbacks.startDeal(arg, price);
        if (res.pending) await reply(chatId, `⏸ ${res.message}`);
        else await reply(chatId, res.ok ? `✅ Deal ${arg} dibuka.` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/addentry': {
      if (!arg || !parts[2]) { await reply(chatId, '❓ Format: /addentry SYMBOL BUDGET\nContoh: /addentry BTCUSDT 20\n\nEntry manual ke deal DCA yang SUDAH AKTIF, market buy sekarang juga (tidak nunggu harga turun ke Next SO). Budget bebas, DI LUAR kuota Safety Order — tidak mengurangi maxSafetyOrders atau mempercepat aktivasi SL.'); break; }
      const budget = parseFloat(parts[2]);
      if (!(budget > 0)) { await reply(chatId, `❓ Budget tidak valid: ${parts[2]}`); break; }
      await reply(chatId, `⏳ Entry manual ${arg} sebesar ${budget} USDT...`);
      try {
        const res = await callbacks.addManualDealEntry(arg, budget);
        await reply(chatId, res.ok ? `✅ Entry manual ${arg} berhasil. Avg price sekarang: ${res.deal.avgPrice.toFixed(6)}` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/closedca': {
      if (!arg) { await reply(chatId, '❓ Format: /closedca SYMBOL\n(Bot akan eksekusi market sell asli. Kalau kamu sudah jual sendiri di luar bot, pakai /untrack SYMBOL.)'); break; }
      await reply(chatId, `⏳ Menutup deal ${arg} (market sell)...`);
      try {
        const res = await callbacks.closeDealManual(arg);
        await reply(chatId, res.ok ? `✅ Deal ${arg} ditutup.` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/untrack': {
      if (!arg) { await reply(chatId, '❓ Format: /untrack SYMBOL\nDipakai kalau kamu sudah JUAL SENDIRI di luar bot. Bot akan berhenti mantau deal ini TANPA eksekusi order apapun, dan PnL-nya TIDAK dihitung ke statistik.'); break; }
      await reply(chatId, `⏳ Menandai ${arg} selesai (manual, tanpa sell)...`);
      try {
        const res = await callbacks.closeDealUntrack(arg);
        await reply(chatId, res.ok ? `✅ ${arg} ditandai selesai (manual). PnL TIDAK dihitung ke statistik.` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/hold': {
      if (!arg) { await reply(chatId, '❓ Format: /hold SYMBOL\nBekukan Take Profit sementara — deal TIDAK akan dijual walau harga sudah nyentuh TP. Safety Order & Stop Loss tetap jalan normal. Pakai /resume SYMBOL utk balikin ke normal.'); break; }
      try {
        const res = callbacks.holdTP(arg);
        await reply(chatId, res.ok ? `⏸ TP Hold diaktifkan utk ${arg}. TP tidak akan trigger sampai kamu /resume ${arg}.` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/resume': {
      if (!arg) { await reply(chatId, '❓ Format: /resume SYMBOL\nAktifkan lagi TP normal utk deal yang lagi di-hold.'); break; }
      try {
        const res = callbacks.resumeTP(arg);
        await reply(chatId, res.ok ? `▶ TP Hold dinonaktifkan utk ${arg}. TP normal aktif lagi.` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/pending': {
      await reply(chatId, buildPendingText());
      break;
    }

    case '/cancelentry': {
      if (!arg) { await reply(chatId, '❓ Format: /cancelentry SYMBOL'); break; }
      try {
        const res = callbacks.cancelPendingEntry(arg);
        await reply(chatId, res.ok ? `🚫 Pending entry ${arg} dibatalkan.` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/cancellimit': {
      if (!arg) { await reply(chatId, '❓ Format: /cancellimit SYMBOL'); break; }
      try {
        const res = await callbacks.cancelPendingLimitEntry(arg);
        await reply(chatId, res.ok ? `🚫 Limit order ${arg} dibatalkan.` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/deals': {
      await reply(chatId, await buildDealsText());
      break;
    }

    case '/stats': {
      const s = getStats();
      const sign = s.totalPnlUsdt >= 0 ? '+' : '';
      await reply(chatId, `📊 <b>Statistik DCA</b>\n📂 Aktif: ${s.activeDeals}\n✅ Closed: ${s.closedCount}\n💰 Total PnL: ${sign}${s.totalPnlUsdt.toFixed(2)} USDT`);
      break;
    }

    case '/reopen': {
      if (!arg || !['ON', 'OFF'].includes(arg)) {
        const status = config.trading.reopenAfterClose ? 'ON' : 'OFF';
        await reply(chatId, `🔁 Auto Reopen saat ini: <b>${status}</b>\nFormat: /reopen on atau /reopen off`);
        break;
      }
      try {
        saveConfig({ trading: { reopenAfterClose: arg === 'ON' } });
        await reply(chatId, `✅ Auto Reopen sekarang: <b>${arg}</b>${arg === 'ON' ? ` (cooldown ${config.trading.cooldownAfterCloseMin ?? 5} menit)` : ''}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/compound': {
      if (arg === 'APPLY') {
        await reply(chatId, '⏳ Menerapkan compounding...');
        try {
          const res = await callbacks.compoundNow();
          await reply(chatId, res.ok
            ? `✅ <b>Compounding Diterapkan</b>\nProfit dipakai: +${res.pool.toFixed(2)} USDT\nBase Order: ${res.oldBase} → <b>${res.newBase}</b> USDT\nSafety Order: ${res.oldSO} → <b>${res.newSO}</b> USDT`
            : `❌ ${res.error}`);
        } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
        break;
      }

      const status = callbacks.compoundStatus();
      await reply(chatId,
        `💰 <b>Status Compounding</b>\n\n` +
        `Fitur       : ${status.enabled ? `ON${status.autoApply ? ' (auto-apply)' : ' (manual)'}` : 'OFF'}\n` +
        `Pool profit : ${status.pool >= 0 ? '+' : ''}${status.pool.toFixed(2)} USDT\n` +
        `Threshold   : ${status.threshold} USDT\n` +
        `Status      : ${status.ready ? '✅ Siap di-compound' : '⏳ Belum mencapai threshold'}\n` +
        `Base Order saat ini   : ${status.currentBaseOrderSize} USDT\n` +
        `Safety Order saat ini : ${status.currentSafetyOrderSize} USDT\n\n` +
        (status.ready ? `Ketik <b>/compound apply</b> utk terapkan sekarang.` : `Nunggu profit terkumpul dulu.`)
      );
      break;
    }

    case '/trend': {
      if (arg) {
        await reply(chatId, `⏳ Menganalisa tren ${arg}...`);
        try {
          const result = await analyzeTrend(arg);
          await reply(chatId, result ? buildTrendText(arg, result) : `❌ Data candle ${arg} tidak cukup utk analisa.`);
        } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
        break;
      }

      const symbols = getActiveSymbols();
      if (!symbols.length) { await reply(chatId, '📭 Tidak ada deal aktif. Format: /trend SYMBOL utk cek symbol manapun.'); break; }

      await reply(chatId, `⏳ Menganalisa tren ${symbols.length} symbol aktif...`);
      for (const sym of symbols) {
        try {
          const result = await analyzeTrend(sym);
          await reply(chatId, result ? buildTrendText(sym, result) : `❌ ${sym}: data candle tidak cukup`);
        } catch (e) { await reply(chatId, `❌ ${sym}: ${e.message}`); }
        await sleep(300); // jaga rate limit Bitget
      }
      break;
    }

    case '/config': {
      const d = config.dca, t = config.trading;
      const entryOrderText = (t.entryOrderType ?? 'market') === 'limit'
        ? `LIMIT (offset -${t.entryLimitOffsetPercent ?? 0.1}% dari harga sekarang, timeout ${t.entryLimitTimeoutMin ?? 15} menit)`
        : 'MARKET (beli langsung di harga pasar)';
      await reply(chatId,
        `⚙️ <b>Config DCA Saat Ini</b>\n\n` +
        `Base order   : ${d.baseOrderSize} USDT\n` +
        `Safety order : ${d.safetyOrderSize} USDT (x${d.safetyOrderVolumeScale} tiap step)\n` +
        `Max SO       : ${d.maxSafetyOrders}\n` +
        `Deviasi SO   : ${d.priceDeviationPercent}% (x${d.safetyOrderStepScale} tiap step)\n` +
        `TP           : ${d.takeProfitPercent}% (basis: ${d.takeProfitBasis}${d.takeProfitBasis === 'both' ? ' — trigger begitu base ATAU average tercapai duluan' : ''})\n` +
        `SL           : ${d.stopLossEnabled ? d.stopLossPercent + '% (basis: ' + d.stopLossBasis + ', aktif setelah semua SO habis)' : 'nonaktif'}\n` +
        `Max deal     : ${t.maxActiveDeals}\n` +
        `Tipe Entry   : ${entryOrderText}\n` +
        `Auto Reopen  : ${t.reopenAfterClose ? `ON (cooldown ${t.cooldownAfterCloseMin ?? 5} menit, retry max ${t.maxReopenRetries ?? 5}x tiap ${t.reopenRetryDelayMin ?? 2} menit kalau gagal network)` : 'OFF'}\n` +
        `Tren         : EMA${t.trendEmaPeriod ?? 21} @ ${(t.trendTimeframe ?? '1h').toUpperCase()}, cek tiap ${t.trendCheckIntervalMin ?? 30} menit (informatif saja)\n` +
        `Entry Filter : ${t.entryFilterEnabled ? `ON — EMA${t.entryFilterEmaPeriod ?? 9} @ ${(t.entryFilterTimeframe ?? '5min').toUpperCase()} (harga harus di atas EMA)` : 'OFF'}\n` +
        `Compounding  : ${t.compoundingEnabled ? `ON (threshold ${t.compoundingThresholdUsdt ?? 10} USDT${t.compoundingAutoApply ? ', auto-apply' : ', manual'})` : 'OFF'}\n\n` +
        `<i>Edit lewat dashboard atau user-config.json, lalu restart bot.</i>`
      );
      break;
    }

    case '/addposition': {
      if (!arg || !parts[2]) { await reply(chatId, '❓ Format: /addposition SYMBOL BUDGET\nContoh: /addposition BTCUSDT 20\n\nBisa dipanggil berkali-kali di symbol yang sama — tiap panggilan jadi entry TAMBAHAN (avg price di-recalculate).'); break; }
      const budget = parseFloat(parts[2]);
      if (!(budget > 0)) { await reply(chatId, `❓ Budget tidak valid: ${parts[2]}`); break; }
      await reply(chatId, `⏳ Entry ${arg} sebesar ${budget} USDT...`);
      try {
        const res = await callbacks.addPosition(arg, budget);
        await reply(chatId, res.ok ? `✅ Entry ${arg} berhasil. Avg price sekarang: ${res.position.avgPrice.toFixed(6)}` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/closeposition': {
      if (!arg) { await reply(chatId, '❓ Format: /closeposition SYMBOL'); break; }
      await reply(chatId, `⏳ Menutup position ${arg} (market sell)...`);
      try {
        const res = await callbacks.closePositionManual(arg);
        await reply(chatId, res.ok ? `✅ Position ${arg} ditutup.` : `❌ ${res.error}`);
      } catch (e) { await reply(chatId, `❌ Error: ${e.message}`); }
      break;
    }

    case '/positions': {
      const positions = getActivePositions();
      const syms = Object.keys(positions);
      if (!syms.length) { await reply(chatId, '📭 Tidak ada Manual Position aktif.'); break; }

      let text = `📊 <b>Manual Position Aktif (${syms.length}):</b>\n\n`;
      for (const sym of syms) {
        const p = positions[sym];
        const cur = await getCurrentPrice(sym).catch(() => null);
        const pnl = (cur && p.totalSpent > 0) ? (((cur - p.avgPrice) * p.totalQty - (p.buyFeeUsdt || 0)) / p.totalSpent * 100) : null;
        text += `<b>${sym}</b>${p.trailingActive ? ' 🔔 <i>TRAILING</i>' : ''}\n`;
        text += `  Avg: ${p.avgPrice.toFixed(6)} | Now: ${cur ?? '—'} | PnL: ${pnl !== null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%' : '—'}\n`;
        text += `  Entry ke-${p.entries.length} | SL: ${p.slPrice?.toFixed(6) ?? '—'}\n`;
        text += p.trailingActive
          ? `  Peak: ${p.peakPrice.toFixed(6)} | Trailing Stop: ${p.trailingStopPrice.toFixed(6)}\n\n`
          : `  Trailing aktif di atas: ${(p.avgPrice * (1 + p.trailingActivationPercent / 100)).toFixed(6)}\n\n`;
      }
      await reply(chatId, text.trim());
      break;
    }

    case '/help':
    default: {
      await reply(chatId,
        `🤖 <b>DCA Bot — Bantuan</b>\n\n` +
        `/startdca SYMBOL [HARGA] — buka deal baru (base order). Kosongkan HARGA utk market/default; isi HARGA utk limit buy persis di harga itu\n` +
        `/closedca SYMBOL  — tutup deal manual (bot market sell)\n` +
        `/addentry SYMBOL BUDGET — entry manual ke deal DCA aktif, di luar kuota SO\n` +
        `/untrack SYMBOL   — tandai selesai TANPA sell dari bot (kamu sudah jual sendiri di luar bot; PnL tidak dihitung)\n` +
        `/hold SYMBOL      — bekukan TP sementara (SO & SL tetap normal)\n` +
        `/resume SYMBOL    — aktifkan lagi TP normal\n` +
        `/pending          — lihat entry/limit order yang lagi pending\n` +
        `/cancelentry SYMBOL — batalkan pending Entry Filter\n` +
        `/cancellimit SYMBOL — batalkan limit order yang belum fill\n` +
        `/deals            — lihat semua deal aktif\n` +
        `/stats            — ringkasan PnL\n` +
        `/config           — lihat setting DCA saat ini\n` +
        `/trend [SYMBOL]   — cek status tren (kosongkan utk semua deal aktif)\n` +
        `/compound [apply] — cek status profit terkumpul / terapkan compounding\n` +
        `/reopen on|off    — toggle auto-reopen setelah TP\n\n` +
        `<b>Manual Position (di luar DCA):</b>\n` +
        `/addposition SYMBOL BUDGET — entry manual (bisa berkali-kali utk symbol sama)\n` +
        `/closeposition SYMBOL — tutup position manual\n` +
        `/positions — lihat semua Manual Position aktif`
      );
      break;
    }
  }
}

export function startTelegramPolling(callbacks) {
  if (!getToken() || !getChatId()) { log('telegram', 'Telegram tidak dikonfigurasi'); return; }
  if (_polling) return;
  _polling = true;
  log('telegram', '✅ Telegram polling aktif (DCA Bot)');

  async function poll() {
    if (!_polling) return;
    const updates = await getUpdates();
    for (const update of updates) {
      _offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text?.startsWith('/')) continue;
      try { await handleCommand(msg.chat.id, msg.text, callbacks); }
      catch (err) { log('telegram_error', `Handle error: ${err.message}`); }
    }
    if (_polling) _pollTimer = setTimeout(poll, 1000);
  }
  poll();
}

export function stopTelegramPolling() {
  _polling = false;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  log('telegram', 'Polling dihentikan');
}
