/**
 * Bitget REST API Client
 * Docs: https://www.bitget.com/api-doc/spot/intro
 */
import crypto from 'crypto';
import axios  from 'axios';
import { log } from './logger.js';

const BASE_URL = 'https://api.bitget.com';

function sign(timestamp, method, requestPath, body, secretKey) {
  const msg = timestamp + method.toUpperCase() + requestPath + (body || '');
  return crypto.createHmac('sha256', secretKey).update(msg).digest('base64');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(method, path, params = {}, body = null, auth = true, _retry = 0) {
  const timestamp   = Date.now().toString();
  let requestPath   = path;

  if (method === 'GET' && Object.keys(params).length > 0) {
    requestPath = `${path}?${new URLSearchParams(params)}`;
  }

  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'locale': 'en-US' };

  if (auth) {
    headers['ACCESS-KEY']        = process.env.BITGET_API_KEY;
    headers['ACCESS-SIGN']       = sign(timestamp, method, requestPath, bodyStr, process.env.BITGET_SECRET_KEY);
    headers['ACCESS-TIMESTAMP']  = timestamp;
    headers['ACCESS-PASSPHRASE'] = process.env.BITGET_PASSPHRASE;
  }

  try {
    const res  = await axios({ method, url: BASE_URL + requestPath, headers, data: body || undefined, timeout: 15000 });
    const data = res.data;
    if (data.code !== '00000' && data.code !== 0) throw new Error(`Bitget API ${data.code}: ${data.msg}`);
    return data.data;
  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    const is5xx     = err.response?.status >= 500;

    if ((isTimeout || is5xx) && _retry < 2) {
      const waitMs = 1000 * (_retry + 1);
      log('bitget_warn', `${isTimeout ? 'Timeout' : `HTTP ${err.response?.status}`} ${path} — retry ${_retry + 1}/2 dalam ${waitMs / 1000}s`);
      await sleep(waitMs);
      return request(method, path, params, body, auth, _retry + 1);
    }

    if (err.response) throw new Error(`Bitget HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    throw err;
  }
}

export async function getTicker(symbol) {
  return request('GET', '/api/v2/spot/market/tickers', { symbol }, null, false);
}

export async function getAllTickers() {
  return request('GET', '/api/v2/spot/market/tickers', {}, null, false);
}

export async function getAccountAssets() {
  return request('GET', '/api/v2/spot/account/assets');
}

export async function getAssetBalance(coin) {
  const assets = await getAccountAssets();
  return Array.isArray(assets) ? (assets.find(a => a.coin === coin) || null) : null;
}

export async function placeOrder({ symbol, side, orderType, size, price }) {
  const body = {
    symbol,
    side,
    orderType,
    force:     'gtc',
    size:      String(size),
    clientOid: `dca_${Date.now()}`,
  };
  // Limit order butuh price eksplisit — market order tidak.
  if (orderType === 'limit' && price !== undefined) {
    body.price = String(price);
  }
  return request('POST', '/api/v2/spot/trade/place-order', {}, body);
}

export async function getOrder(orderId, symbol) {
  return request('GET', '/api/v2/spot/trade/orderInfo', { orderId, symbol });
}

export async function cancelOrder(orderId, symbol) {
  return request('POST', '/api/v2/spot/trade/cancel-order', {}, { orderId, symbol });
}

export async function getCurrentPrice(symbol) {
  const tickers = await getTicker(symbol);
  const t = Array.isArray(tickers) ? tickers[0] : tickers;
  return t ? parseFloat(t.lastPr || t.last) : null;
}

/**
 * Ambil candle/kline spot. granularity: '1min','5min','15min','30min',
 * '1h','4h','6h','12h','1day','3day','1week','1M' dst (lihat docs Bitget v2 spot market candles).
 * Response: array of [timestamp, open, high, low, close, baseVol, quoteVol], terurut ASCENDING (lama → baru).
 */
export async function getCandles(symbol, granularity = '4h', limit = 250) {
  return request('GET', '/api/v2/spot/market/candles', { symbol, granularity, limit }, null, false);
}

export async function testConnection() {
  try {
    const assets = await getAccountAssets();
    return { ok: true, assets: assets?.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
