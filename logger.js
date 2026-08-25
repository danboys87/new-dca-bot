import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR   = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

export function log(category, message) {
  const level = category.includes('error') ? 'error'
    : category.includes('warn') ? 'warn' : 'info';
  if (LEVELS[level] < currentLevel) return;
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${category.toUpperCase().padEnd(12)}] ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, `dca-${ts.slice(0, 10)}.log`), line + '\n');
}

export function logTrade(action) {
  const ts   = new Date().toISOString();
  const sign = action.side === 'buy' ? '🟢 BUY' : '🔴 SELL';
  fs.appendFileSync(
    path.join(LOG_DIR, `trades-${ts.slice(0, 10)}.jsonl`),
    JSON.stringify({ ts, ...action }) + '\n'
  );
  log('trade', `${sign} ${action.symbol} | qty=${action.qty} | price=${action.price} | tag=${action.tag || '-'}`);
}
