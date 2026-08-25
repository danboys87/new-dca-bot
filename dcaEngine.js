/**
 * DCA Engine — Safety Order style (ala 3Commas)
 *
 * Alur 1 "deal":
 *  1. Base Order (initial order)   → beli begitu deal dibuka
 *  2. Safety Order 1..N            → beli tambahan tiap harga turun
 *                                     `priceDeviationPercent` dari order TERAKHIR
 *                                     (jarak & size bisa scaling tiap step)
 *  3. Take Profit                  → jual semua saat harga naik X% dari basis
 *                                     (basis: rata-rata / harga initial order)
 *  4. Stop Loss (opsional)         → jual semua kalau harga jatuh terlalu dalam
 *
 * Semua angka (baseOrderSize, safetyOrderSize, maxSafetyOrders,
 * priceDeviationPercent, takeProfitPercent, stopLossPercent, basis TP/SL, dst)
 * diambil dari user-config.json → tidak ada yang hardcode di sini.
 */

/**
 * Hitung deviasi (dalam %) untuk Safety Order ke-`step` (1-indexed).
 * step=1 → priceDeviationPercent
 * step=2 → priceDeviationPercent * stepScale
 * step=3 → priceDeviationPercent * stepScale^2 ... dst (ala 3Commas step scale)
 */
export function calcSODeviationPct(step, cfg) {
  const base  = cfg.priceDeviationPercent ?? 2.5;
  const scale = cfg.safetyOrderStepScale ?? 1;
  return base * Math.pow(scale, step - 1);
}

/**
 * Hitung ukuran (budget USDT) utk Safety Order ke-`step` (1-indexed).
 * step=1 → safetyOrderSize
 * step=2 → safetyOrderSize * volumeScale
 * step=3 → safetyOrderSize * volumeScale^2 ... dst
 */
export function calcSOSize(step, cfg) {
  const base  = cfg.safetyOrderSize ?? cfg.baseOrderSize ?? 20;
  const scale = cfg.safetyOrderVolumeScale ?? 1;
  return base * Math.pow(scale, step - 1);
}

/**
 * Harga trigger utk Safety Order berikutnya, dihitung dari harga fill
 * order TERAKHIR (base order atau SO sebelumnya) — bukan dari average.
 * Ini standar 3Commas: tiap SO menunggu harga turun sekian % dari fill terakhir.
 */
export function calcNextSOPrice(lastFillPrice, nextStep, cfg) {
  const pct = calcSODeviationPct(nextStep, cfg);
  return lastFillPrice * (1 - pct / 100);
}

/**
 * Basis harga untuk TP/SL: 'average' (harga rata-rata semua order terisi)
 * atau 'base' (tetap harga initial order, walau sudah nambah safety order).
 */
export function getBasisPrice(deal, basis) {
  return basis === 'base' ? deal.baseOrderPrice : deal.avgPrice;
}

export function calcTPPrice(deal, cfg) {
  const basis = cfg.takeProfitBasis ?? 'average';
  const pct   = (cfg.takeProfitPercent ?? 3) / 100;

  if (basis === 'both') {
    // TP trigger begitu SALAH SATU tercapai duluan (base ATAU average).
    // avgPrice biasanya <= baseOrderPrice (average turun tiap SO terisi),
    // jadi targetnya = harga TERENDAH di antara keduanya (lebih cepat kena).
    const tpFromBase = deal.baseOrderPrice * (1 + pct);
    const tpFromAvg  = deal.avgPrice * (1 + pct);
    return Math.min(tpFromBase, tpFromAvg);
  }

  const basisPrice = getBasisPrice(deal, basis);
  return basisPrice * (1 + pct);
}

/**
 * SL baru AKTIF setelah semua safety order habis terpakai (deal "fully loaded").
 * Selagi masih ada slot SO tersisa, harga turun = trigger SO berikutnya,
 * bukan SL — SL null (belum berlaku) sampai safetyOrdersFilled >= maxSafetyOrders.
 */
export function calcSLPrice(deal, cfg) {
  if (!cfg.stopLossEnabled) return null;

  const maxSO = cfg.maxSafetyOrders ?? 5;
  if ((deal.safetyOrdersFilled ?? 0) < maxSO) return null; // SO masih tersisa → SL belum berlaku

  const basisPrice = getBasisPrice(deal, cfg.stopLossBasis ?? 'average');
  return basisPrice * (1 - (cfg.stopLossPercent ?? 15) / 100);
}

/**
 * Recompute avgPrice, nextSOPrice, tpPrice, slPrice setelah sebuah order
 * (base atau safety) baru saja terisi. Deal object di-mutate & dikembalikan.
 */
export function recalcDeal(deal, cfg) {
  const totalQty   = deal.orders.reduce((s, o) => s + o.qty, 0);
  const totalSpent = deal.orders.reduce((s, o) => s + o.qty * o.price, 0);

  deal.totalQty   = totalQty;
  deal.totalSpent = totalSpent;
  deal.avgPrice   = totalQty > 0 ? totalSpent / totalQty : null;

  const soFilled = deal.orders.length - 1; // order pertama = base order
  deal.safetyOrdersFilled = soFilled;

  if (soFilled < (cfg.maxSafetyOrders ?? 5)) {
    const lastFill = deal.orders[deal.orders.length - 1].price;
    deal.nextSOPrice = calcNextSOPrice(lastFill, soFilled + 1, cfg);
    deal.nextSOSize  = calcSOSize(soFilled + 1, cfg);
  } else {
    deal.nextSOPrice = null; // sudah habis kuota safety order
    deal.nextSOSize  = null;
  }

  deal.tpPrice = calcTPPrice(deal, cfg);
  deal.slPrice = calcSLPrice(deal, cfg);

  if ((cfg.takeProfitBasis ?? 'average') === 'both') {
    const pct = (cfg.takeProfitPercent ?? 3) / 100;
    deal.tpPriceBase    = deal.baseOrderPrice * (1 + pct);
    deal.tpPriceAverage = deal.avgPrice * (1 + pct);
  } else {
    deal.tpPriceBase    = null;
    deal.tpPriceAverage = null;
  }

  return deal;
}

/**
 * Evaluasi 1 deal aktif terhadap harga sekarang.
 * Return salah satu:
 *   { action: 'take_profit' }
 *   { action: 'stop_loss' }
 *   { action: 'place_so', step, size }
 *   { action: 'hold' }
 */
export function evaluateDeal(deal, currentPrice, cfg) {
  if (deal.tpPrice !== null && currentPrice >= deal.tpPrice) {
    return { action: 'take_profit', price: currentPrice };
  }

  if (deal.slPrice !== null && currentPrice <= deal.slPrice) {
    return { action: 'stop_loss', price: currentPrice };
  }

  if (deal.nextSOPrice !== null && currentPrice <= deal.nextSOPrice) {
    return {
      action: 'place_so',
      step:   deal.safetyOrdersFilled + 1,
      size:   deal.nextSOSize,
      price:  currentPrice,
    };
  }

  return { action: 'hold' };
}
