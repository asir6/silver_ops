/**
 * Silver Ops - Frontend Application
 * 
 * Real-time trading dashboard for XAG/USD short-selling strategy
 */

// ============================================
// Configuration
// ============================================
const CONFIG = {
    // Cloudflare Worker proxy for Binance API (bypasses CORS)
    CORS_PROXY: 'https://silver-ops-proxy.liu-huan-arthur.workers.dev',

    // Binance Futures API
    BINANCE_FUTURES: 'https://fapi.binance.com',

    // Binance symbol for silver
    SYMBOL: 'XAGUSDT',

    // Refresh interval in milliseconds (30 seconds to avoid Binance rate limits)
    REFRESH_INTERVAL: 30000,

    // Strategy levels (in USD per oz)
    LEVELS: {
        SHORT_ZONE: [32.50, 33.50],
        STOP_LOSS: 34.50,
        TARGET: 28.00
    },

    // Alert thresholds
    ALERTS: {
        LS_RATIO_HIGH: 2.5,
        SELL_PRESSURE_HIGH: 1.2,
        FUNDING_POSITIVE: 0
    }
};

// ============================================
// State Management
// ============================================
let state = {
    connected: false,
    lastPrice: null,
    lastOI: null,
    history: [],
    chart: null,
    refreshTimer: null,
    symbolAvailable: null
};

// ============================================
// Utility Functions
// ============================================
function formatNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return '--';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

function formatPrice(num) {
    if (num === null || num === undefined || isNaN(num)) return '--';
    return '$' + parseFloat(num).toFixed(4);
}

function formatPercent(num) {
    if (num === null || num === undefined || isNaN(num)) return '--';
    const val = parseFloat(num);
    const sign = val >= 0 ? '+' : '';
    return sign + val.toFixed(2) + '%';
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function setConnectionStatus(connected, message = '') {
    const statusEl = document.getElementById('connection-status');
    state.connected = connected;

    if (connected) {
        statusEl.textContent = '🟢 Live';
        statusEl.className = 'status-badge connected';
    } else {
        statusEl.textContent = message || '🔴 Offline';
        statusEl.className = 'status-badge disconnected';
    }
}

function updateLastRefresh() {
    document.getElementById('last-update').textContent =
        'Last refresh: ' + new Date().toLocaleTimeString();
}

// ============================================
// Binance Futures API Functions
// ============================================
function getApiUrl(path) {
    // Use CORS proxy if configured, otherwise direct (may fail due to CORS)
    if (CONFIG.CORS_PROXY) {
        return `${CONFIG.CORS_PROXY}${path}`;
    }
    return `${CONFIG.BINANCE_FUTURES}${path}`;
}

async function fetchBinanceData() {
    const symbol = CONFIG.SYMBOL;

    try {
        // Fetch multiple endpoints in parallel
        const [priceRes, oiRes, lsRes, fundingRes, depthRes, ticker24hRes] = await Promise.all([
            fetch(getApiUrl(`/fapi/v1/ticker/price?symbol=${symbol}`)).catch(() => null),
            fetch(getApiUrl(`/fapi/v1/openInterest?symbol=${symbol}`)).catch(() => null),
            fetch(getApiUrl(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`)).catch(() => null),
            fetch(getApiUrl(`/fapi/v1/fundingRate?symbol=${symbol}&limit=1`)).catch(() => null),
            fetch(getApiUrl(`/fapi/v1/depth?symbol=${symbol}&limit=50`)).catch(() => null),
            fetch(getApiUrl(`/fapi/v1/ticker/24hr?symbol=${symbol}`)).catch(() => null)
        ]);

        // Parse responses
        const price = priceRes?.ok ? await priceRes.json() : null;
        const oi = oiRes?.ok ? await oiRes.json() : null;
        const ls = lsRes?.ok ? await lsRes.json() : null;
        const funding = fundingRes?.ok ? await fundingRes.json() : null;
        const depth = depthRes?.ok ? await depthRes.json() : null;
        const ticker24h = ticker24hRes?.ok ? await ticker24hRes.json() : null;

        // Debug: Log raw API responses
        console.log('📊 Binance API Responses:', {
            price,
            oi,
            ls,
            funding,
            depth: depth ? { bids: depth.bids?.length, asks: depth.asks?.length } : null,
            ticker24h
        });

        // Check if we got any data at all
        if (!price && !oi && !ls && !funding && !ticker24h) {
            console.error('All API requests failed - likely CORS or network issue');
            console.log('💡 To fix: Deploy Cloudflare Worker from worker/binance-proxy.js');
            console.log('   Then set CONFIG.CORS_PROXY to your worker URL');
            setConnectionStatus(false, '🔴 CORS Error');
            showNoData();
            return;
        }

        // Calculate order book pressure (Ask/Bid ratio)
        let sellPressure = null;
        if (depth?.bids && depth?.asks && depth.bids.length > 0 && depth.asks.length > 0) {
            const bidSum = depth.bids.reduce((sum, [p, q]) => sum + parseFloat(p) * parseFloat(q), 0);
            const askSum = depth.asks.reduce((sum, [p, q]) => sum + parseFloat(p) * parseFloat(q), 0);
            sellPressure = bidSum > 0 ? (askSum / bidSum) : null;
        }

        // Get price change from 24h ticker
        let priceChange = null;
        if (ticker24h?.priceChangePercent) {
            priceChange = parseFloat(ticker24h.priceChangePercent);
        }

        // Calculate OI change (only if we have previous OI)
        let oiChange = null;
        const currentOI = oi?.openInterest ? parseFloat(oi.openInterest) : null;
        if (state.lastOI && currentOI) {
            oiChange = ((currentOI - state.lastOI) / state.lastOI) * 100;
        }

        // Calculate Open Interest in USDT (OI contracts * price)
        let oiValue = null;
        const currentPrice = price?.price ? parseFloat(price.price) : null;
        if (currentOI && currentPrice) {
            oiValue = currentOI * currentPrice;
        }

        // Calculate annualized funding rate (funding is charged 3x per day)
        let fundingAnnualized = null;
        if (funding?.[0]?.fundingRate) {
            fundingAnnualized = parseFloat(funding[0].fundingRate) * 100 * 3 * 365;
        }

        // Get Long/Short ratio
        let lsRatio = null;
        if (ls && Array.isArray(ls) && ls.length > 0 && ls[0]?.longShortRatio) {
            lsRatio = parseFloat(ls[0].longShortRatio);
        }

        const data = {
            price: currentPrice,
            priceChange: priceChange,
            oi: oiValue,  // OI in USDT value
            oiChange: oiChange,
            lsRatio: lsRatio,
            funding: fundingAnnualized,
            sellPressure: sellPressure,
            volume: ticker24h?.quoteVolume ? parseFloat(ticker24h.quoteVolume) : null
        };

        console.log('📈 Processed data:', data);

        // Update state for next comparison
        if (currentPrice) state.lastPrice = currentPrice;
        if (currentOI) state.lastOI = currentOI;

        // Update UI
        updateBinanceUI(data);
        updateSignals(data);
        setConnectionStatus(true);
        updateLastRefresh();

    } catch (error) {
        console.error('Binance fetch error:', error);
        setConnectionStatus(false, '🔴 API Error');
        showNoData();
    }
}

async function checkSymbolAvailability() {
    try {
        const response = await fetch(getApiUrl(`/fapi/v1/ticker/price?symbol=${CONFIG.SYMBOL}`));
        if (response.ok) {
            const data = await response.json();
            if (data.price) {
                console.log(`✅ Symbol ${CONFIG.SYMBOL} available on Binance Futures, price: $${data.price}`);
                return true;
            }
        }
        console.warn(`⚠️ Symbol ${CONFIG.SYMBOL} not available or CORS blocked`);
        return false;
    } catch (error) {
        console.error('Failed to check symbol (likely CORS):', error);
        return false;
    }
}

function showNoData() {
    // Display N/A when API is unavailable - NO FAKE DATA
    const emptyData = {
        price: null,
        priceChange: null,
        oi: null,
        oiChange: null,
        lsRatio: null,
        funding: null,
        sellPressure: null,
        volume: null
    };

    updateBinanceUI(emptyData);
    updateSignals(emptyData);

    // Mark as offline
    document.getElementById('connection-status').textContent = '🔴 Offline';
    document.getElementById('connection-status').className = 'status-badge disconnected';
}

function updateBinanceUI(data) {
    // Price
    const priceEl = document.getElementById('price');
    const currentPriceEl = document.getElementById('current-price');
    priceEl.textContent = data.price ? formatPrice(data.price) : 'N/A';
    currentPriceEl.textContent = data.price ? formatPrice(data.price) : 'N/A';

    // Price change
    const priceChangeEl = document.getElementById('price-change');
    if (data.priceChange !== null && data.priceChange !== undefined) {
        priceChangeEl.textContent = formatPercent(data.priceChange);
        priceChangeEl.className = 'change ' + (data.priceChange >= 0 ? 'positive' : 'negative');
    } else {
        priceChangeEl.textContent = '--';
        priceChangeEl.className = 'change';
    }

    // Open Interest
    const oiEl = document.getElementById('oi');
    oiEl.textContent = data.oi ? formatNumber(data.oi) + ' USDT' : 'N/A';
    const oiChangeEl = document.getElementById('oi-change');
    if (data.oiChange !== null && data.oiChange !== undefined) {
        oiChangeEl.textContent = formatPercent(data.oiChange);
        oiChangeEl.className = 'change ' + (data.oiChange >= 0 ? 'positive' : 'negative');
    } else {
        oiChangeEl.textContent = '--';
        oiChangeEl.className = 'change';
    }

    // Long/Short Ratio
    const lsEl = document.getElementById('ls-ratio');
    lsEl.textContent = data.lsRatio ? data.lsRatio.toFixed(2) : 'N/A';
    if (data.lsRatio && data.lsRatio > CONFIG.ALERTS.LS_RATIO_HIGH) {
        lsEl.classList.add('alert-high');
    } else {
        lsEl.classList.remove('alert-high');
    }

    // Funding Rate
    const fundingEl = document.getElementById('funding');
    if (data.funding !== null && data.funding !== undefined) {
        fundingEl.textContent = formatPercent(data.funding);
        fundingEl.className = 'value ' + (data.funding >= 0 ? 'positive' : 'negative');
    } else {
        fundingEl.textContent = 'N/A';
        fundingEl.className = 'value';
    }

    // Sell Pressure
    const pressureEl = document.getElementById('sell-pressure');
    pressureEl.textContent = data.sellPressure ? data.sellPressure.toFixed(2) : 'N/A';
    if (data.sellPressure && data.sellPressure > CONFIG.ALERTS.SELL_PRESSURE_HIGH) {
        pressureEl.classList.add('alert-bearish');
    } else {
        pressureEl.classList.remove('alert-bearish');
    }

    // Volume
    const volumeEl = document.getElementById('volume');
    volumeEl.textContent = data.volume ? formatNumber(data.volume) + ' USDT' : 'N/A';

    // Price position indicator
    updatePricePosition(data.price);
}

function updatePricePosition(price) {
    if (!price) return;

    const priceEl = document.getElementById('price');
    const currentPriceEl = document.getElementById('current-price');
    const positionEl = document.getElementById('price-position');
    const [zoneMin, zoneMax] = CONFIG.LEVELS.SHORT_ZONE;

    let position = '';
    let className = '';

    if (price >= zoneMin && price <= zoneMax) {
        position = '🎯 IN SHORT ZONE';
        className = 'in-zone';
    } else if (price > CONFIG.LEVELS.STOP_LOSS) {
        position = '⚠️ Above Stop Loss!';
        className = 'danger';
    } else if (price < CONFIG.LEVELS.TARGET) {
        position = '✅ Below Target';
        className = 'target-reached';
    } else if (price > zoneMax) {
        position = `${(price - zoneMax).toFixed(2)} above zone`;
        className = 'above-zone';
    } else {
        position = `${(zoneMin - price).toFixed(2)} below zone`;
        className = 'below-zone';
    }

    positionEl.textContent = position;
    positionEl.className = 'hint ' + className;

    currentPriceEl.className = 'value ' + className;
    priceEl.className = 'value ' + className;
}

function updateSignals(data) {
    let signalCount = 0;
    const signals = [];

    // Signal 1: Price in Short Zone
    const signal1 = document.getElementById('signal-price');
    if (data.price >= CONFIG.LEVELS.SHORT_ZONE[0] && data.price <= CONFIG.LEVELS.SHORT_ZONE[1]) {
        signal1.querySelector('.indicator').textContent = '🟢';
        signal1.classList.add('active');
        signalCount++;
        signals.push('price');
    } else {
        signal1.querySelector('.indicator').textContent = '⚪';
        signal1.classList.remove('active');
    }

    // Signal 2: Crowded Long
    const signal2 = document.getElementById('signal-ls');
    if (data.lsRatio > CONFIG.ALERTS.LS_RATIO_HIGH) {
        signal2.querySelector('.indicator').textContent = '🟢';
        signal2.classList.add('active');
        signalCount++;
        signals.push('ls');
    } else {
        signal2.querySelector('.indicator').textContent = '⚪';
        signal2.classList.remove('active');
    }

    // Signal 3: Positive Funding
    const signal3 = document.getElementById('signal-funding');
    if (data.funding > CONFIG.ALERTS.FUNDING_POSITIVE) {
        signal3.querySelector('.indicator').textContent = '🟢';
        signal3.classList.add('active');
        signalCount++;
        signals.push('funding');
    } else {
        signal3.querySelector('.indicator').textContent = '⚪';
        signal3.classList.remove('active');
    }

    // Signal 4: High Sell Pressure
    const signal4 = document.getElementById('signal-pressure');
    if (data.sellPressure > CONFIG.ALERTS.SELL_PRESSURE_HIGH) {
        signal4.querySelector('.indicator').textContent = '🟢';
        signal4.classList.add('active');
        signalCount++;
        signals.push('pressure');
    } else {
        signal4.querySelector('.indicator').textContent = '⚪';
        signal4.classList.remove('active');
    }

    // Overall Signal
    const resultEl = document.getElementById('signal-result');
    if (signalCount >= 3 && signals.includes('price')) {
        resultEl.textContent = '🔴 SHORT';
        resultEl.className = 'value signal-short';
    } else if (signalCount >= 2) {
        resultEl.textContent = '🟡 PREPARE';
        resultEl.className = 'value signal-prepare';
    } else {
        resultEl.textContent = '⚪ WAIT';
        resultEl.className = 'value signal-wait';
    }
}

// ============================================
// Macro History Chart
// ============================================
async function loadMacroHistory() {
    try {
        const response = await fetch('data/history.json');
        if (!response.ok) throw new Error('Failed to load history');

        state.history = await response.json();
        console.log(`Loaded ${state.history.length} historical records`);

        renderHistoryTable();
        renderMacroChart();

    } catch (error) {
        console.error('Failed to load macro history:', error);
        document.getElementById('history-tbody').innerHTML =
            '<tr><td colspan="6" class="error">Failed to load data</td></tr>';
    }
}

function renderHistoryTable() {
    const tbody = document.getElementById('history-tbody');

    if (state.history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No data yet. Waiting for first scrape...</td></tr>';
        return;
    }

    // Show most recent entries first
    const recentData = [...state.history].reverse().slice(0, 10);

    tbody.innerHTML = recentData.map(entry => {
        const statusIcons = [];
        if (entry.fetch_status?.cme === 'success') statusIcons.push('✅ CME');
        if (entry.fetch_status?.cme === 'failed') statusIcons.push('❌ CME');
        if (entry.fetch_status?.yahoo === 'success') statusIcons.push('✅ Yahoo');
        if (entry.fetch_status?.yahoo === 'failed') statusIcons.push('❌ Yahoo');

        return `
      <tr>
        <td>${formatDate(entry.timestamp)}</td>
        <td>${entry.registered_oz ? formatNumber(entry.registered_oz) : '--'}</td>
        <td>${entry.eligible_oz ? formatNumber(entry.eligible_oz) : '--'}</td>
        <td>${entry.total_oz ? formatNumber(entry.total_oz) : '--'}</td>
        <td>${entry.comex_oi ? formatNumber(entry.comex_oi) : '--'}</td>
        <td class="status">${statusIcons.join(' ')}</td>
      </tr>
    `;
    }).join('');
}

function renderMacroChart(days = 30) {
    const ctx = document.getElementById('macro-chart').getContext('2d');

    if (state.history.length === 0) {
        return;
    }

    // Filter data by date range
    let filteredData = state.history;
    if (days !== 'all') {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        filteredData = state.history.filter(d => new Date(d.timestamp) >= cutoff);
    }

    if (filteredData.length === 0) {
        filteredData = state.history.slice(-days);
    }

    const labels = filteredData.map(d => {
        const date = new Date(d.timestamp);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    const registered = filteredData.map(d => d.registered_oz ? d.registered_oz / 1000000 : null);
    const oi = filteredData.map(d => d.comex_oi);

    // Destroy existing chart
    if (state.chart) {
        state.chart.destroy();
    }

    state.chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Registered Inventory (M oz)',
                    data: registered,
                    backgroundColor: 'rgba(192, 192, 192, 0.7)',
                    borderColor: 'rgba(192, 192, 192, 1)',
                    borderWidth: 1,
                    yAxisID: 'y',
                    order: 2
                },
                {
                    label: 'Open Interest',
                    data: oi,
                    type: 'line',
                    borderColor: 'rgba(255, 206, 86, 1)',
                    backgroundColor: 'rgba(255, 206, 86, 0.2)',
                    pointBackgroundColor: 'rgba(255, 206, 86, 1)',
                    pointRadius: 3,
                    fill: false,
                    yAxisID: 'y1',
                    tension: 0.1,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            scales: {
                x: {
                    ticks: {
                        color: '#8b949e',
                        maxTicksLimit: 10
                    },
                    grid: {
                        color: 'rgba(139, 148, 158, 0.1)'
                    }
                },
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Inventory (Million oz)',
                        color: '#8b949e'
                    },
                    ticks: {
                        color: '#8b949e'
                    },
                    grid: {
                        color: 'rgba(139, 148, 158, 0.1)'
                    }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: {
                        display: true,
                        text: 'Open Interest',
                        color: '#8b949e'
                    },
                    ticks: {
                        color: '#8b949e'
                    },
                    grid: {
                        drawOnChartArea: false
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(33, 38, 45, 0.95)',
                    titleColor: '#e6edf3',
                    bodyColor: '#e6edf3',
                    borderColor: 'rgba(139, 148, 158, 0.3)',
                    borderWidth: 1
                },
                annotation: {
                    annotations: {
                        criticalLine: {
                            type: 'line',
                            yMin: 30,
                            yMax: 30,
                            yScaleID: 'y',
                            borderColor: '#f85149',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            label: {
                                display: true,
                                content: 'Critical: 30M oz',
                                backgroundColor: '#f85149',
                                color: '#fff',
                                font: {
                                    size: 11
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}

// ============================================
// Event Handlers
// ============================================
function setupEventListeners() {
    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', () => {
        fetchBinanceData();
        loadMacroHistory();
    });

    // Chart range buttons
    document.querySelectorAll('.chart-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            const range = e.target.dataset.range;
            renderMacroChart(range === 'all' ? 'all' : parseInt(range));
        });
    });

    // Keyboard shortcut for refresh
    document.addEventListener('keydown', (e) => {
        if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            fetchBinanceData();
            loadMacroHistory();
        }
    });
}

// ============================================
// Initialize
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🥈 Silver Ops Dashboard initializing...');

    // Update strategy level display
    document.getElementById('short-zone-value').textContent =
        `$${CONFIG.LEVELS.SHORT_ZONE[0]} - $${CONFIG.LEVELS.SHORT_ZONE[1]}`;
    document.getElementById('stop-loss-value').textContent =
        `$${CONFIG.LEVELS.STOP_LOSS}`;
    document.getElementById('target-value').textContent =
        `$${CONFIG.LEVELS.TARGET}`;

    // Setup event listeners
    setupEventListeners();

    // Load macro history
    await loadMacroHistory();

    // Check symbol availability and start real-time updates
    const symbolAvailable = await checkSymbolAvailability();

    if (symbolAvailable) {
        // Start real-time updates
        fetchBinanceData();
        state.refreshTimer = setInterval(fetchBinanceData, CONFIG.REFRESH_INTERVAL);
    } else {
        // Show N/A if symbol not available - NO FAKE DATA
        console.log('Symbol not available on Binance Futures');
        showNoData();
        setConnectionStatus(false, '🔴 Unavailable');
    }

    console.log('✅ Dashboard initialized');
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
    }
});
