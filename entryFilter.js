/**
 * Entry Filter — OPSIONAL, default OFF. Beda dari trendMonitor.js (yang cuma
 * informatif buat deal yang SUDAH berjalan), modul ini AKTIF MEMBLOKIR
 * pembukaan deal BARU (base order) kalau syarat EMA belum terpenuhi.
 *
 * Cara kerja: harga symbol harus berada DI ATAS EMA(entryFilterEmaPeriod) di
 * timeframe entryFilterTimeframe. Kalau belum, deal ditaruh "pending" — bot
 * akan cek ulang tiap loop, dan otomatis buka deal begitu syarat terpenuhi.
 *
 * Fail-open: kalau data candle gak cukup/API error, entry TETAP diizinkan
 * (bukan diblokir) — supaya gangguan data sesaat gak bikin entry nyangkut
 * pending selamanya. Kejadian ini dicatat sebagai warning di log.
 */
import { computeEmaSignal } from './trendMonitor.js';
import { config } from './config.js';
import { log } from './logger.js';

export async function checkEntryAllowed(symbol) {
  const t = config.trading;
  if (!t.entryFilterEnabled) return { allowed: true };

  const period    = t.entryFilterEmaPeriod ?? 9;
  const timeframe = t.entryFilterTimeframe ?? '5min';

  const signal = await computeEmaSignal(symbol, timeframe, period);
  if (!signal) {
    log('entry_filter_warn', `Data candle ${symbol} tidak cukup utk cek entry filter — entry diizinkan (fail-open)`);
    return { allowed: true };
  }

  return {
    allowed: signal.aboveEma,
    price:   signal.price,
    ema:     signal.ema,
    period,
    timeframe,
  };
}
