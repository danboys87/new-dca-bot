/**
 * Executor — eksekusi order ke Bitget Spot (base order, safety order, close deal)
 */
import { placeOrder, getOrder, getAssetBalance, getCurrentPrice, cancelOrder, extractFeeUsdt, getSymbolInfo, roundDownToPrecision } from './bitget.js';
import { log, logTrade } from './logger.js';
import {
  startDeal, addSafetyOrderFill, addManualDealEntry, updateDealCalc, closeDeal, getDeal,
  hasActivePosition, startPosition, addPositionEntry, updatePositionCalc, closePosition, getPosition,
  migrateDealToPosition,
} from './state.js';
import { recalcDeal } from './dcaEngine.js';
import { recalcPosition } from './positionEngine.js';
import { config } from './config.js';

const isDryRun = process.env.DRY_RUN === 'true';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Estimasi qty & bulatkan budget SESUAI precision ASLI dari Bitget utk
 * symbol ini (bukan tebakan berdasar harga) — dipakai sebelum market/limit
 * buy. quotePrecision menentukan berapa desimal yang boleh dikirim sebagai
 * `size` utk MARKET BUY (size = jumlah USDT, bukan qty koin!). Kalau
 * dilanggar, Bitget nolak order dengan error 40808 (checkBDScale).
 */
async function calcQuantity(symbol, budget) {
  const price = await getCurrentPrice(symbol);
  if (!price || price <= 0) throw new Error(`Harga tidak valid untuk ${symbol}`);

  const info = await getSymbolInfo(symbol);
  const roundedBudget = roundDownToPrecision(budget, info.quotePrecision);
  if (roundedBudget <= 0) throw new Error(`Budget ${budget} terlalu kecil utk precision ${symbol} (quotePrecision=${info.quotePrecision})`);

  const qty = roundDownToPrecision(roundedBudget / price, info.quantityPrecision);
  return { price, qty, budget: roundedBudget, info };
}

async function marketBuy(symbol, budget) {
  const { price: refPrice, qty, budget: roundedBudget } = await calcQuantity(symbol, budget);
  if (qty <= 0) throw new Error(`Quantity <= 0 untuk ${symbol}`);

  if (isDryRun) {
    // Dry run: tidak ada order asli → fee disimulasikan pakai config.trading.takerFeePercent
    // (default 0.1%), dihitung dari budget (USDT yang "dibelanjakan").
    const feePct  = config.trading.takerFeePercent ?? 0.1;
    const feeUsdt = roundedBudget * (feePct / 100);
    log('executor', `[DRY RUN] BUY ${symbol} qty=${qty} @ ${refPrice} (fee simulasi ${feeUsdt.toFixed(4)} USDT)`);
    return { price: refPrice, qty, orderId: `dryrun_${Date.now()}`, feeUsdt };
  }

  const usdtBalance = await getAssetBalance('USDT');
  const available    = parseFloat(usdtBalance?.available || 0);
  const needed        = roundedBudget + (config.trading.gasReserve ?? 3);
  if (available < needed) throw new Error(`Saldo USDT tidak cukup: ${available} < ${needed}`);

  // size utk market BUY = jumlah USDT (quote), dibulatkan sesuai quotePrecision symbol ini.
  const order   = await placeOrder({ symbol, side: 'buy', orderType: 'market', size: roundedBudget });
  const orderId = order?.orderId;
  if (!orderId) throw new Error('Tidak ada orderId dari API');

  await sleep(1500);
  const detail    = await getOrder(orderId, symbol).catch(() => null);
  const fillPrice = detail ? parseFloat(detail.priceAvg || detail.fillPrice || refPrice) : refPrice;
  const fillQty   = detail ? parseFloat(detail.baseVolume || detail.fillSize || qty) : qty;

  const baseAsset = symbol.replace(config.trading.quoteAsset || 'USDT', '');
  const feeUsdt = detail
    ? extractFeeUsdt(detail, { quoteAsset: config.trading.quoteAsset || 'USDT', baseAsset, fillPrice })
    : 0;

  return { price: fillPrice, qty: fillQty, orderId, feeUsdt };
}

async function marketSellAll(symbol, quantity) {
  const currentPrice = await getCurrentPrice(symbol);
  if (!currentPrice) throw new Error(`Tidak bisa ambil harga ${symbol}`);

  if (isDryRun) {
    const feePct  = config.trading.takerFeePercent ?? 0.1;
    const feeUsdt = (currentPrice * quantity) * (feePct / 100);
    log('executor', `[DRY RUN] SELL ${symbol} qty=${quantity} @ ${currentPrice} (fee simulasi ${feeUsdt.toFixed(4)} USDT)`);
    return { price: currentPrice, qty: quantity, feeUsdt };
  }

  const info      = await getSymbolInfo(symbol);
  const baseAsset = symbol.replace(config.trading.quoteAsset || 'USDT', '');
  const tokenBal  = await getAssetBalance(baseAsset);
  const available = parseFloat(tokenBal?.available || 0);
  // size utk market SELL = qty koin (base), dibulatkan sesuai quantityPrecision symbol ini
  // (BUKAN hardcode 2 desimal seperti sebelumnya — itu salah utk banyak pair).
  const sellQty   = roundDownToPrecision(Math.min(quantity, available), info.quantityPrecision);
  if (sellQty <= 0) throw new Error(`Saldo ${baseAsset} tidak cukup: ${available}`);

  const order   = await placeOrder({ symbol, side: 'sell', orderType: 'market', size: sellQty });
  const orderId = order?.orderId;
  await sleep(1500);
  const detail    = await getOrder(orderId, symbol).catch(() => null);
  const fillPrice = detail ? parseFloat(detail.priceAvg || currentPrice) : currentPrice;

  const feeUsdt = detail
    ? extractFeeUsdt(detail, { quoteAsset: config.trading.quoteAsset || 'USDT', baseAsset, fillPrice })
    : 0;

  return { price: fillPrice, qty: sellQty, feeUsdt };
}

// ── Public API ──────────────────────────────────────────────────────────────


export async function openDeal(symbol) {
  const budget = config.dca.baseOrderSize;
  log('executor', `🚀 Membuka deal ${symbol} | base order = ${budget} USDT`);
  const { price, qty, orderId, feeUsdt } = await marketBuy(symbol, budget);

  const deal = startDeal(symbol, { qty, price, budget, orderId, feeUsdt });
  recalcDeal(deal, config.dca);
  updateDealCalc(symbol, deal);

  logTrade({ side: 'buy', symbol, qty, price, tag: 'base' });
  return deal;
}

export async function fillSafetyOrder(symbol, step, budget) {
  log('executor', `➕ SO${step} ${symbol} | budget=${budget.toFixed(2)} USDT`);
  const { price, qty, orderId, feeUsdt } = await marketBuy(symbol, budget);

  let deal = addSafetyOrderFill(symbol, { step, qty, price, budget, orderId, feeUsdt });
  deal = recalcDeal(deal, config.dca);
  updateDealCalc(symbol, deal);

  logTrade({ side: 'buy', symbol, qty, price, tag: `so${step}` });
  return deal;
}

/**
 * Entry MANUAL tambahan ke deal DCA yang sudah aktif — budget BEBAS, market
 * order SEKARANG JUGA (tidak nunggu harga turun ke nextSOPrice). Di luar
 * kuota Safety Order — lihat state.js:addManualDealEntry() utk alasannya.
 */
export async function addManualEntryToDeal(symbol, budget) {
  log('executor', `✋ Entry manual ${symbol} | budget=${budget.toFixed(2)} USDT (di luar kuota SO)`);
  const { price, qty, orderId, feeUsdt } = await marketBuy(symbol, budget);

  let deal = addManualDealEntry(symbol, { qty, price, budget, orderId, feeUsdt });
  deal = recalcDeal(deal, config.dca);
  updateDealCalc(symbol, deal);

  logTrade({ side: 'buy', symbol, qty, price, tag: 'manual' });
  return deal;
}

/**
 * Pasang BASE ORDER sebagai LIMIT buy (bukan market) — dipakai kalau
 * config.trading.entryOrderType === 'limit', ATAU kalau user kasih harga
 * spesifik saat start deal (lihat startDeal() di index.js). Deal BELUM
 * aktif di sini — baru difinalisasi lewat finalizeBaseOrder() setelah
 * order-nya kefill (lihat processPendingLimitOrders() di index.js).
 *
 * explicitPrice: kalau diisi, dipakai APA ADANYA sebagai harga limit order
 * (harga persis yang diminta user) — tidak dihitung dari offset %.
 * Kalau kosong/null, fallback ke cara lama: offset % di bawah harga sekarang
 * (config.trading.entryLimitOffsetPercent).
 */
export async function openDealLimit(symbol, explicitPrice = null) {
  const budget = config.dca.baseOrderSize;
  const info   = await getSymbolInfo(symbol);

  let limitPrice;
  if (explicitPrice !== null && explicitPrice !== undefined) {
    limitPrice = explicitPrice;
    if (!(limitPrice > 0)) throw new Error(`Harga limit order tidak valid: ${explicitPrice}`);
  } else {
    const offsetPct    = config.trading.entryLimitOffsetPercent ?? 0.1;
    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error(`Harga tidak valid untuk ${symbol}`);
    // Limit buy dipasang sedikit DI BAWAH harga sekarang (offsetPct%) — supaya
    // tidak langsung match seperti market order, nunggu harga turun sedikit dulu.
    limitPrice = currentPrice * (1 - offsetPct / 100);
  }
  // price utk LIMIT order harus sesuai pricePrecision symbol ini (beda dari
  // quotePrecision yang dipakai market buy) — kalau tidak, Bitget nolak juga.
  limitPrice = roundDownToPrecision(limitPrice, info.pricePrecision);

  // size utk LIMIT BUY = qty koin (base), BUKAN budget USDT seperti market buy.
  const qty = roundDownToPrecision(budget / limitPrice, info.quantityPrecision);
  if (qty <= 0) throw new Error(`Quantity <= 0 untuk ${symbol}`);

  log('executor', `📝 Pasang limit buy ${symbol} qty=${qty} @ ${limitPrice}${explicitPrice ? ' (harga manual)' : ` (offset -${config.trading.entryLimitOffsetPercent ?? 0.1}%)`}`);

  if (isDryRun) {
    return { orderId: `dryrun_limit_${Date.now()}`, price: limitPrice, qty, budget };
  }

  const usdtBalance = await getAssetBalance('USDT');
  const available    = parseFloat(usdtBalance?.available || 0);
  const needed        = budget + (config.trading.gasReserve ?? 3);
  if (available < needed) throw new Error(`Saldo USDT tidak cukup: ${available} < ${needed}`);

  const order   = await placeOrder({ symbol, side: 'buy', orderType: 'limit', size: qty, price: limitPrice });
  const orderId = order?.orderId;
  if (!orderId) throw new Error('Tidak ada orderId dari API');

  return { orderId, price: limitPrice, qty, budget };
}

/**
 * Cek apakah limit order base order sudah terisi. Dipanggil berkala dari
 * processPendingLimitOrders() di index.js selama menunggu fill.
 */
export async function checkLimitOrderFilled(orderId, symbol) {
  if (isDryRun) return { filled: false }; // dry run: limit order tidak pernah fill sendiri, biarkan timeout yang membatalkan

  const detail = await getOrder(orderId, symbol).catch(() => null);
  if (!detail) return { filled: false };

  const status = detail.status || detail.state;
  const filled = status === 'filled' || status === 'full_fill';
  if (!filled) return { filled: false };

  const fillPrice = parseFloat(detail.priceAvg || detail.fillPrice);
  const baseAsset  = symbol.replace(config.trading.quoteAsset || 'USDT', '');
  const feeUsdt    = extractFeeUsdt(detail, { quoteAsset: config.trading.quoteAsset || 'USDT', baseAsset, fillPrice });

  return {
    filled: true,
    price: fillPrice,
    qty:   parseFloat(detail.baseVolume || detail.fillSize),
    feeUsdt,
  };
}

/**
 * Batalkan limit order base order yang belum (atau sudah tidak akan) terisi —
 * dipanggil baik oleh timeout otomatis maupun pembatalan manual dari user.
 */
export async function cancelPendingLimitOrder(orderId, symbol) {
  if (isDryRun) {
    log('executor', `[DRY RUN] Cancel limit order ${symbol} orderId=${orderId}`);
    return;
  }
  try {
    await cancelOrder(orderId, symbol);
  } catch (e) {
    log('executor_error', `Gagal cancel limit order ${symbol}: ${e.message}`);
  }
}

/**
 * Finalisasi deal setelah limit order base order terisi — sama seperti
 * openDeal() tapi price/qty sudah diketahui dari hasil fill (bukan
 * marketBuy() baru), dipanggil dari processPendingLimitOrders().
 */
export function finalizeBaseOrder(symbol, { qty, price, budget, orderId, feeUsdt = 0 }) {
  const deal = startDeal(symbol, { qty, price, budget, orderId, feeUsdt });
  recalcDeal(deal, config.dca);
  updateDealCalc(symbol, deal);

  logTrade({ side: 'buy', symbol, qty, price, tag: 'base' });
  return deal;
}

export async function closeDealMarket(symbol, reason) {
  const deal = getDeal(symbol);
  if (!deal) throw new Error(`Deal ${symbol} tidak ditemukan`);

  log('executor', `🔻 Menutup deal ${symbol} | reason=${reason} | qty=${deal.totalQty}`);
  const { price, qty, feeUsdt } = await marketSellAll(symbol, deal.totalQty);

  logTrade({ side: 'sell', symbol, qty, price, tag: reason });
  return closeDeal(symbol, { exitPrice: price, reason, feeUsdt });
}

// ── Manual Position (DILUAR DCA) — entry manual + trailing stop ────────────
// Reuse marketBuy()/marketSellAll() yang sama dgn DCA (market order biasa di
// Bitget) — bedanya cuma di state yang disimpan & logic exit-nya.

/**
 * Entry manual — kalau belum ada posisi aktif utk symbol ini, buka posisi baru
 * (pakai default SL/trailing dari config.position). Kalau sudah ada, jadi
 * entry TAMBAHAN (avgPrice di-recalculate; status trailing DIRESET — lihat
 * recalcPosition() di positionEngine.js utk alasannya).
 */
export async function openOrAddPosition(symbol, budget) {
  log('executor', `${hasActivePosition(symbol) ? '➕ Entry tambahan' : '🚀 Membuka'} position ${symbol} | budget=${budget} USDT`);
  const { price, qty, orderId, feeUsdt } = await marketBuy(symbol, budget);

  let position;
  if (hasActivePosition(symbol)) {
    position = addPositionEntry(symbol, { qty, price, budget, orderId, feeUsdt });
  } else {
    const pc = config.position || {};
    position = startPosition(symbol, {
      qty, price, budget, orderId, feeUsdt,
      stopLossPercent:            pc.stopLossPercent ?? 10,
      trailingActivationPercent:  pc.trailingActivationPercent ?? 3,
      trailingStopPercent:        pc.trailingStopPercent ?? 2,
    });
  }
  recalcPosition(position);
  updatePositionCalc(symbol, position);

  logTrade({ side: 'buy', symbol, qty, price, tag: 'position' });
  return position;
}

export async function closePositionMarket(symbol, reason) {
  const position = getPosition(symbol);
  if (!position) throw new Error(`Position ${symbol} tidak ditemukan`);

  log('executor', `🔻 Menutup position ${symbol} | reason=${reason} | qty=${position.totalQty}`);
  const { price, qty, feeUsdt } = await marketSellAll(symbol, position.totalQty);

  logTrade({ side: 'sell', symbol, qty, price, tag: `position_${reason}` });
  return closePosition(symbol, { exitPrice: price, reason, feeUsdt });
}

/**
 * Pindahkan deal DCA aktif ke Manual Position — TIDAK ADA transaksi ke
 * Bitget sama sekali (murni perubahan internal state). SL/trailing pakai
 * default dari config.position SAAT INI (dikunci begitu migrasi terjadi,
 * sama seperti Manual Position baru pada umumnya).
 */
export function migrateDealToManualPosition(symbol) {
  const pc = config.position || {};
  const position = migrateDealToPosition(symbol, {
    stopLossPercent:            pc.stopLossPercent ?? 10,
    trailingActivationPercent:  pc.trailingActivationPercent ?? 3,
    trailingStopPercent:        pc.trailingStopPercent ?? 2,
  });
  if (!position) throw new Error(`Gagal migrate ${symbol} — deal tidak ditemukan atau ${symbol} sudah punya Manual Position aktif`);

  recalcPosition(position);
  updatePositionCalc(symbol, position);

  log('executor', `🔀 ${symbol} dipindahkan dari deal DCA ke Manual Position | avg=${position.avgPrice.toFixed(6)} qty=${position.totalQty} | SL baru=${position.slPrice?.toFixed(6) ?? '—'}`);
  return position;
}
