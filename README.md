# 🥈 Silver Ops - Personal Trading Dashboard

A **100% serverless and free** trading dashboard for monitoring the Silver market (XAG/USD) with a focus on short-selling strategy.

![Dashboard Preview](https://via.placeholder.com/800x400/0d1117/c0c0c0?text=Silver+Ops+Dashboard)

## 🏗️ Architecture

| Component | Technology | Cost |
|-----------|------------|------|
| Backend Automation | GitHub Actions (cron job) | Free |
| Database | JSON file in repo (Git Scraping) | Free |
| Frontend Hosting | GitHub Pages | Free |
| API Proxy | Cloudflare Worker (optional) | Free tier |

## 📁 Project Structure

```
silver-ops/
├── .github/
│   └── workflows/
│       └── hourly_scrape.yml    # Cron job: fetch macro data every 2 hours
├── scripts/
│   └── fetch_macro.js           # Node.js data fetcher
├── data/
│   └── history.json             # Historical data storage
├── worker/
│   └── binance-proxy.js         # Cloudflare Worker script (optional)
├── css/
│   └── style.css                # Dark mode financial UI
├── js/
│   └── app.js                   # Frontend logic
├── index.html                   # Main dashboard page
├── package.json
└── README.md
```

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/yourusername/silver-ops.git
cd silver-ops
npm install
```

### 2. Test Locally

```bash
# Test data fetcher (dry run)
npm test

# Run actual fetch
npm run fetch

# Serve frontend locally
npx serve .
```

### 3. Deploy to GitHub Pages

1. Push to GitHub
2. Go to **Settings** → **Pages**
3. Set Source to "Deploy from a branch"
4. Select `main` branch and `/ (root)` folder
5. Your dashboard will be at: `https://<username>.github.io/silver-ops/`

### 4. Enable GitHub Actions

1. Go to **Actions** tab in your repository
2. Enable workflows if prompted
3. The scraper will run automatically every 2 hours
4. You can also trigger manually via "Run workflow"

## 📊 Data Sources

| Data Point | Primary Source | Update Frequency |
|------------|---------------|------------------|
| CME Inventory (Registered/Eligible) | CME Group Excel Report | Daily |
| Open Interest | Yahoo Finance (SI=F) | Real-time |
| Real-time Price | Binance Futures | 3 seconds |
| Long/Short Ratio | Binance Futures | 3 seconds |
| Funding Rate | Binance Futures | 8 hours |

## 📈 Strategy Levels

The dashboard is configured for a silver short-selling strategy:

| Level | Price | Action |
|-------|-------|--------|
| **Short Zone** | $32.50 - $33.50 | Enter short positions |
| **Stop Loss** | $34.50 | Exit if breached |
| **Target** | $28.00 | Take profit |

Modify these levels in [js/app.js](js/app.js):

```javascript
const CONFIG = {
  LEVELS: {
    SHORT_ZONE: [32.50, 33.50],
    STOP_LOSS: 34.50,
    TARGET: 28.00
  }
};
```

## 🎯 Signal System

The dashboard shows a trading signal based on 4 conditions:

1. ✅ Price in Short Zone ($32.50 - $33.50)
2. ✅ Crowded Long (Long/Short Ratio > 2.5)
3. ✅ Positive Funding Rate
4. ✅ High Sell Pressure (Ask/Bid > 1.2)

| Conditions Met | Signal |
|----------------|--------|
| 3+ including price | 🔴 **SHORT** |
| 2+ | 🟡 **PREPARE** |
| < 2 | ⚪ **WAIT** |

## 🌐 Cloudflare Worker Setup (Optional)

For mobile devices (to bypass CORS), deploy the Cloudflare Worker:

1. Go to [workers.cloudflare.com](https://workers.cloudflare.com/)
2. Create a new Worker
3. Copy contents of [worker/binance-proxy.js](worker/binance-proxy.js)
4. Deploy and get your URL
5. Update `CONFIG.PROXY_BASE` in [js/app.js](js/app.js):

```javascript
const CONFIG = {
  PROXY_BASE: 'https://your-worker.your-subdomain.workers.dev',
  // ...
};
```

## 📱 Features

- **Real-time Binance Data**: Price, Open Interest, Funding Rate, Long/Short Ratio
- **COMEX Inventory Chart**: Historical registered inventory vs open interest
- **Signal System**: Automated trading signal based on multiple conditions
- **Dark Mode UI**: Professional financial dashboard design
- **Mobile Responsive**: Works on all devices
- **Offline Support**: Demo mode when API unavailable

## 🔧 Configuration

### Environment Variables

None required - everything runs client-side or via GitHub Actions.

### Customization

| File | What to Modify |
|------|----------------|
| [js/app.js](js/app.js) | Strategy levels, alert thresholds, refresh interval |
| [css/style.css](css/style.css) | Colors, layout, animations |
| [.github/workflows/hourly_scrape.yml](.github/workflows/hourly_scrape.yml) | Scrape frequency |

## ⚠️ Known Limitations

1. **Binance Symbol**: `XAGUSDT` may not be available on Binance Futures. The dashboard falls back to demo mode if unavailable.

2. **CME Data**: The CME Excel format may change. If fetching fails, check the parsing logic in [scripts/fetch_macro.js](scripts/fetch_macro.js).

3. **CORS**: Direct Binance API calls require a CORS browser extension on desktop, or use the Cloudflare Worker proxy.

4. **Rate Limits**: 
   - GitHub Actions: 2000 minutes/month (free tier)
   - Cloudflare Workers: 100,000 requests/day (free tier)
   - Binance API: 1200 requests/minute

## 📋 Data Schema

Each entry in `data/history.json`:

```json
{
  "timestamp": "2025-01-28T14:00:00Z",
  "source": "cme",
  "registered_oz": 30567890,
  "eligible_oz": 267543210,
  "total_oz": 298111100,
  "comex_oi": 145000,
  "fetch_status": {
    "cme": "success",
    "yahoo": "success"
  }
}
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

MIT License - feel free to use for personal trading.

## ⚠️ Disclaimer

**This is a personal trading tool. Not financial advice.**

- Past performance does not guarantee future results
- Trading silver futures involves substantial risk of loss
- Only trade with capital you can afford to lose
- Always do your own research

---

Built with ❤️ for silver traders | Data: CME Group, Binance, Yahoo Finance
