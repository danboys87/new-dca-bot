/**
 * Position Engine — Manual Entry + Trailing Stop (DILUAR DCA)
 *
 * Beda dari DCA (dcaEngine.js):
 *  - Entry SEPENUHNYA manual — user yang menentukan kapan & berapa besar tiap
 *    entry (TIDAK ada logic priceDeviationPercent/safetyOrderVolumeScale
 *    otomatis, tidak ada trigger harga turun sekian % dari order terakhir).
 *    Entry bisa dilakukan berkali-kali, kapan saja, di harga berapa saja,
 *    selama posisi masih aktif.
 *  - TIDAK ada Take Profit tetap — exit HANYA lewat Trailing Stop, Stop Loss
 *    tetap, atau close manual.
 *
 * Alur:
 *  1. Entry pertama → buka posisi baru. Stop Loss tetap (basis avgPrice)
 *     langsung aktif dari awal.
 *  2. Entry tambahan (opsional, kapan saja) → avgPrice/qty di-recalculate,
 *     SL ikut bergeser mengikuti avgPrice baru. Status trailing (kalau sudah
 *     aktif) TIDAK direset oleh entry tambahan.
 *  3. Trailing Stop BELUM aktif sampai harga naik `trailingActivationPercent`%
 *     dari avgPrice. Sebelum titik ini tercapai, satu-satunya proteksi adalah
 *     Stop Loss tetap.
 *  4. Begitu titik aktivasi tercapai, trailing AKTIF dan bot mulai "mengikuti"
 *     harga tertinggi (peakPrice) yang tercapai sejak saat itu.
 *  5. Selama trailing aktif, kalau harga turun `trailingStopPercent`% dari
 *     peakPrice, posisi ditutup (trailing stop hit) — mengunci profit.
 *  6. Stop Loss tetap berlaku SEPANJANG WAKTU (sebelum maupun sesudah
 *     trailing aktif) — proteksi kalau harga anjlok duluan sebelum sempat
 *     naik ke titik aktivasi trailing.
 */

export function calcSlPrice(avgPrice, stopLossPercent) {
  if (!stopLossPercent || stopLossPercent <= 0) return null;
  return avgPrice * (1 - stopLossPercent / 100);
}

export function calcTrailingActivationPrice(avgPrice, trailingActivationPercent) {
  return avgPrice * (1 + trailingActivationPercent / 100);
}

export function calcTrailingStopPrice(peakPrice, trailingStopPercent) {
  return peakPrice * (1 - trailingStopPercent / 100);
}

/**
 * Recompute avgPrice/totalQty/totalSpent/slPrice dari daftar entries.
 * Dipanggil dari executor.js setelah entry baru masuk (sama seperti pola
 * recalcDeal() di dcaEngine.js utk DCA). Position object di-mutate & dikembalikan.
 */
export function recalcPosition(position) {
  const totalQty   = position.entries.reduce((s, e) => s + e.qty, 0);
  const totalSpent = position.entries.reduce((s, e) => s + e.qty * e.price, 0);

  position.totalQty   = totalQty;
  position.totalSpent = totalSpent;
  position.avgPrice   = totalQty > 0 ? totalSpent / totalQty : null;
  position.slPrice    = calcSlPrice(position.avgPrice, position.stopLossPercent);

  // Kalau trailing sudah aktif, trailingStopPrice tetap dihitung ulang (basis
  // peakPrice yang ada — TIDAK berubah karena entry tambahan, cuma dipastikan
  // konsisten di objek yang sama).
  if (position.trailingActive && position.peakPrice !== null) {
    position.trailingStopPrice = calcTrailingStopPrice(position.peakPrice, position.trailingStopPercent);
  }

  return position;
}

/**
 * Evaluasi 1 posisi aktif terhadap harga sekarang. Return salah satu:
 *   { action: 'stop_loss', price }
 *   { action: 'activate_trailing', peakPrice }
 *   { action: 'update_peak', peakPrice }
 *   { action: 'trailing_stop', price }
 *   { action: 'hold' }
 */
export function evaluatePosition(position, currentPrice) {
  // SL tetap berlaku SEPANJANG WAKTU — sebelum maupun sesudah trailing aktif.
  if (position.slPrice !== null && currentPrice <= position.slPrice) {
    return { action: 'stop_loss', price: currentPrice };
  }

  if (!position.trailingActive) {
    const activationPrice = calcTrailingActivationPrice(position.avgPrice, position.trailingActivationPercent);
    if (currentPrice >= activationPrice) {
      return { action: 'activate_trailing', peakPrice: currentPrice };
    }
    return { action: 'hold' };
  }

  // Trailing sudah aktif — cek rekor baru atau trailing stop hit.
  if (currentPrice > position.peakPrice) {
    return { action: 'update_peak', peakPrice: currentPrice };
  }

  const trailingStopPrice = calcTrailingStopPrice(position.peakPrice, position.trailingStopPercent);
  if (currentPrice <= trailingStopPrice) {
    return { action: 'trailing_stop', price: currentPrice };
  }

  return { action: 'hold' };
}
