import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'user-config.json');

function load() {
  const base = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (process.env.BASE_ORDER)   base.dca.baseOrderSize          = parseFloat(process.env.BASE_ORDER);
  if (process.env.SO_SIZE)      base.dca.safetyOrderSize         = parseFloat(process.env.SO_SIZE);
  if (process.env.MAX_SO)       base.dca.maxSafetyOrders         = parseInt(process.env.MAX_SO);
  if (process.env.TP)           base.dca.takeProfitPercent       = parseFloat(process.env.TP);
  if (process.env.SL)           base.dca.stopLossPercent         = parseFloat(process.env.SL);
  if (process.env.MAX_DEALS)    base.trading.maxActiveDeals      = parseInt(process.env.MAX_DEALS);
  if (process.env.CHECK_INTERVAL_SEC) base.trading.checkIntervalSec = parseInt(process.env.CHECK_INTERVAL_SEC);

  return base;
}

export let config = load();

export function saveConfig(updates) {
  const merged = deepMerge(load(), updates);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  config = merged;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
