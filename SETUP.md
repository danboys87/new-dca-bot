# 🚀 DCA Bot (Safety Order, ala 3Commas) — Bitget Spot

Bot terpisah dari bot UTBot — standalone project. Semua parameter DCA
(initial order, jumlah safety order, TP, SL) diatur di `user-config.json`.

## Cara Kerja

1. **Base Order (initial order)** — dibeli begitu deal dibuka (manual via
   `/startdca SYMBOL`, dashboard, atau API).
2. **Safety Order** — beli tambahan otomatis tiap harga turun
   `priceDeviationPercent`% dari order terakhir, sampai `maxSafetyOrders`
   habis. Ukuran & jarak tiap SO bisa di-scale (`safetyOrderVolumeScale`,
   `safetyOrderStepScale`) — set `1` kalau mau flat, tidak scaling.
3. **Take Profit** — jual semua saat harga naik `takeProfitPercent`% dari
   basis. Basis diatur lewat `takeProfitBasis`:
   - `"average"` → dari harga rata-rata SEMUA order yang sudah terisi
   - `"base"` → tetap dari harga base order (initial) saja
4. **Stop Loss** (opsional, `stopLossEnabled`) — jual semua kalau harga
   jatuh `stopLossPercent`% dari basis (`stopLossBasis`: sama seperti TP).
   ⚠️ **SL baru AKTIF setelah semua safety order (`maxSafetyOrders`) habis
   terpakai.** Selama masih ada slot SO tersisa, harga turun akan memicu
   SO berikutnya, bukan SL — SL hanya melindungi deal yang sudah
   "fully loaded" (semua modal sudah masuk, tidak ada SO lagi yang bisa
   menahan average price turun lebih jauh).

## Setup

```bash
cd dca-bot-bitget
cp .env.example .env      # isi API key Bitget, dll
npm install
```

Edit `.env`:
```env
BITGET_API_KEY=...
BITGET_SECRET_KEY=...
BITGET_PASSPHRASE=...
DRY_RUN=true               # true = simulasi dulu, wajib tes sebelum live
TELEGRAM_BOT_TOKEN=...      # opsional
TELEGRAM_CHAT_ID=...
DASHBOARD_PORT=3001
CHECK_INTERVAL_SEC=30
```

Edit `user-config.json` sesuai strategi kamu — ini pusat semua settingan:

```json
{
  "trading": {
    "maxActiveDeals": 5,
    "checkIntervalSec": 30
  },
  "dca": {
    "baseOrderSize": 20,
    "safetyOrderSize": 20,
    "maxSafetyOrders": 5,
    "priceDeviationPercent": 2.5,
    "safetyOrderVolumeScale": 1.5,
    "safetyOrderStepScale": 1.2,
    "takeProfitPercent": 3,
    "takeProfitBasis": "average",
    "stopLossEnabled": true,
    "stopLossPercent": 15,
    "stopLossBasis": "average"
  }
}
```

## Jalankan

```bash
npm run dev     # DRY RUN — simulasi, tidak kirim order asli
npm start        # live trading (pastikan .env DRY_RUN=false)
```

Bot akan:
- Buka REPL interaktif (`status`, `start SYMBOL`, `close SYMBOL`)
- Nyalain dashboard API di `http://localhost:3001` → buka `dashboard.html`
  di browser, set API URL ke situ
- Nyalain Telegram polling kalau `TELEGRAM_BOT_TOKEN` diisi

## Membuka Deal

Tidak ada screener otomatis di bot ini — kamu yang menentukan kapan &
pair apa yang di-DCA (bisa manual, bisa dari sinyal eksternal via API).

- **Dashboard**: ketik symbol → "Buka Deal"
- **Telegram**: `/startdca BTCUSDT`
- **REPL**: `start BTCUSDT`
- **API**: `POST /api/start { "symbol": "BTCUSDT" }`

Tutup deal manual kapan saja (market sell semua):
- Dashboard tombol "Close", Telegram `/closedca SYMBOL`, REPL `close SYMBOL`,
  atau `POST /api/close`.

## Perintah Telegram

```
/startdca SYMBOL   — buka deal baru
/closedca SYMBOL   — tutup deal manual
/deals             — lihat semua deal aktif + PnL
/stats             — ringkasan total PnL
/config            — lihat setting DCA aktif
```

## Catatan Penting

- **Selalu tes di `DRY_RUN=true` dulu** sebelum live — cek apakah jarak SO,
  TP, SL sesuai ekspektasi kamu untuk pair yang mau dipakai.
- Kalau `maxSafetyOrders` habis dan harga terus turun tanpa SL aktif,
  deal akan tetap terbuka menunggu harga balik ke TP — pastikan modal
  yang dialokasikan (base + semua safety order) memang siap "nyangkut".
- `checkIntervalSec` menentukan seberapa cepat bot bereaksi ke pergerakan
  harga — makin kecil makin presisi tapi makin sering hit API Bitget.
- File state disimpan di `state.json` (deal aktif) — kalau bot restart,
  deal yang sedang berjalan tetap kebaca dari sini.
