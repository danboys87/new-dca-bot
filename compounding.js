/**
 * Compounding — OPSIONAL, default-nya MANUAL (bukan otomatis).
 *
 * Tiap deal yang closed via bot (Take Profit, Stop Loss, atau Close (Sell) manual)
 * pnlUsdt-nya dikumpulkan ke "pool" (lihat state.js -> closeDeal()). Begitu pool
 * mencapai `compoundingThresholdUsdt`, user dikasih notifikasi/opsi utk menerapkan
 * compounding: Base Order + Safety Order size di-scale PROPORSIONAL (rasio antar
 * order tetap sama seperti sekarang), memakai SELURUH pool yang terkumpul saat itu.
 * Pool lalu direset ke 0.
 *
 * Kalau `compoundingAutoApply: true` di config, langsung diterapkan otomatis
 * begitu threshold tercapai (tanpa perlu konfirmasi manual).
 *
 * PENTING: deal yang ditutup lewat "Manual Sell" (untrackDeal) TIDAK berkontribusi
 * ke pool ini — konsisten dgn kebijakan PnL yang sudah ada (lihat state.js).
 */
import { config, saveConfig } from './config.js';
import { getCompoundingPool, resetCompoundingPool } from './state.js';
import { log } from './logger.js';

function totalSODeployed(d) {
  const { safetyOrderSize, safetyOrderVolumeScale, maxSafetyOrders } = d;
  if (!safetyOrderVolumeScale || safetyOrderVolumeScale === 1) return safetyOrderSize * maxSafetyOrders;
  // Deret geometri: SO1 + SO1*scale + SO1*scale^2 + ... (maxSafetyOrders suku)
  return safetyOrderSize * (Math.pow(safetyOrderVolumeScale, maxSafetyOrders) - 1) / (safetyOrderVolumeScale - 1);
}

/**
 * Status compounding saat ini — dipakai Telegram /compound & dashboard.
 */
export function getCompoundingStatus() {
  const pool      = getCompoundingPool();
  const t         = config.trading;
  const threshold = t.compoundingThresholdUsdt ?? 10;
  return {
    pool,
    threshold,
    ready:     pool >= threshold,
    enabled:   t.compoundingEnabled ?? false,
    autoApply: t.compoundingAutoApply ?? false,
    currentBaseOrderSize:   config.dca.baseOrderSize,
    currentSafetyOrderSize: config.dca.safetyOrderSize,
  };
}

/**
 * Terapkan compounding: Base Order & Safety Order size di-scale proporsional
 * berdasar SELURUH pool yang terkumpul saat ini (bukan cuma sebesar threshold),
 * lalu pool direset ke 0.
 */
export function applyCompounding() {
  const pool = getCompoundingPool();
  if (pool <= 0) return { ok: false, error: 'Belum ada profit terkumpul utk di-compound' };

  const d = config.dca;
  const totalBudget = d.baseOrderSize + totalSODeployed(d);
  const factor = (totalBudget + pool) / totalBudget;

  const oldBase = d.baseOrderSize;
  const oldSO   = d.safetyOrderSize;
  const newBase = Math.round(oldBase * factor * 100) / 100;
  const newSO   = Math.round(oldSO * factor * 100) / 100;

  saveConfig({ dca: { baseOrderSize: newBase, safetyOrderSize: newSO } });
  resetCompoundingPool();

  log('compounding', `💰 Compounding diterapkan: pool=${pool.toFixed(2)} USDT | Base ${oldBase}→${newBase} | SO ${oldSO}→${newSO}`);
  return { ok: true, pool, oldBase, newBase, oldSO, newSO };
}
