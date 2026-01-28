/**
 * Silver Ops - Macro Data Fetcher
 * 
 * Fetches CME Silver inventory and Open Interest data
 * Uses Git Scraping pattern - only saves when data changes
 * 
 * Dependencies: axios, cheerio, xlsx
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const XLSX = require('xlsx');
const cheerio = require('cheerio');

// ============================================
// Configuration
// ============================================
const SOURCES = {
  // CME Silver Stocks Report (Excel)
  CME_INVENTORY: 'https://www.cmegroup.com/delivery_reports/Silver_stocks.xls',
  
  // MarketWatch Silver Futures (for Open Interest)
  MARKETWATCH_SI: 'https://www.marketwatch.com/investing/future/si00'
};

const DATA_FILE = path.join(__dirname, '..', 'data', 'history.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Browser-like headers to avoid blocking
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.google.com/',
  'Upgrade-Insecure-Requests': '1'
};

// ============================================
// Task A: CME Inventory Fetcher (Excel)
// ============================================
async function fetchCMEInventory() {
  console.log('📊 Fetching CME Silver Inventory...');
  
  const response = await axios.get(SOURCES.CME_INVENTORY, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      ...BROWSER_HEADERS,
      'Accept': 'application/vnd.ms-excel,application/octet-stream,*/*',
      'Referer': 'https://www.cmegroup.com/'
    }
  });
  
  const workbook = XLSX.read(response.data, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  
  // Parse CME Silver Stocks Excel format
  let registered = 0;
  let eligible = 0;
  let foundData = false;
  
  // Look for TOTAL row or aggregate data
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    
    const rowStr = row.join(' ').toUpperCase();
    
    // Look for TOTAL or GRAND TOTAL row
    if (rowStr.includes('TOTAL') || rowStr.includes('GRAND')) {
      // CME format typically: [Warehouse, Registered, Eligible, Total]
      const numbers = row.filter(cell => typeof cell === 'number' && cell > 0);
      
      if (numbers.length >= 2) {
        registered = numbers[0];
        eligible = numbers[1];
        foundData = true;
        console.log(`  Found totals row at index ${i}: Registered=${registered}, Eligible=${eligible}`);
        break;
      }
    }
  }
  
  // Alternative parsing: look for specific column headers
  if (!foundData) {
    let headerRow = -1;
    let regCol = -1;
    let eligCol = -1;
    
    for (let i = 0; i < Math.min(data.length, 20); i++) {
      const row = data[i];
      if (!row) continue;
      
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j] || '').toUpperCase();
        if (cell.includes('REGISTERED')) {
          regCol = j;
          headerRow = i;
        }
        if (cell.includes('ELIGIBLE')) {
          eligCol = j;
          headerRow = i;
        }
      }
      
      if (regCol >= 0 && eligCol >= 0) break;
    }
    
    if (headerRow >= 0 && regCol >= 0) {
      for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i];
        if (!row) continue;
        
        const regVal = parseFloat(row[regCol]) || 0;
        const eligVal = parseFloat(row[eligCol]) || 0;
        
        if (regVal > 0) registered += regVal;
        if (eligVal > 0) eligible += eligVal;
      }
      
      if (registered > 0 || eligible > 0) {
        foundData = true;
        console.log(`  Parsed columns: Registered=${registered}, Eligible=${eligible}`);
      }
    }
  }
  
  if (!foundData) {
    console.log('  Sheet structure (first 10 rows):');
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      console.log(`    Row ${i}: ${JSON.stringify(data[i])}`);
    }
    throw new Error('Could not parse CME Excel structure');
  }
  
  return { registered, eligible };
}

// ============================================
// Task B: MarketWatch Open Interest Scraper (Cheerio)
// ============================================
async function fetchMarketWatchOI() {
  console.log('📈 Fetching MarketWatch Open Interest...');
  
  try {
    const response = await axios.get(SOURCES.MARKETWATCH_SI, {
      timeout: 20000,
      headers: BROWSER_HEADERS
    });
    
    const $ = cheerio.load(response.data);
    
    // MarketWatch uses .kv__item structure for key-value pairs
    // Look for "Open Interest" label and extract the value
    let openInterest = null;
    
    // Method 1: Look in .intraday__data .kv__item
    $('.intraday__data .kv__item, .kv__item').each((i, elem) => {
      const label = $(elem).find('.kv__label, .label').text().trim();
      const value = $(elem).find('.kv__value, .value, .kv__primary').text().trim();
      
      if (label.toLowerCase().includes('open interest')) {
        // Parse value like "155,000" or "155K"
        let numStr = value.replace(/,/g, '');
        let num = parseFloat(numStr);
        
        if (numStr.toUpperCase().endsWith('K')) {
          num = parseFloat(numStr) * 1000;
        } else if (numStr.toUpperCase().endsWith('M')) {
          num = parseFloat(numStr) * 1000000;
        }
        
        if (num > 0) {
          openInterest = Math.round(num);
          console.log(`  Found OI via .kv__item: ${openInterest.toLocaleString()} contracts`);
        }
      }
    });
    
    // Method 2: Search all list items and table cells
    if (!openInterest) {
      $('li, tr, dd').each((i, elem) => {
        const text = $(elem).text();
        if (text.toLowerCase().includes('open interest')) {
          // Extract number from text
          const match = text.match(/open\s*interest[:\s]*([0-9,]+(?:\.[0-9]+)?[KMB]?)/i);
          if (match) {
            let numStr = match[1].replace(/,/g, '');
            let num = parseFloat(numStr);
            
            if (numStr.toUpperCase().endsWith('K')) num *= 1000;
            else if (numStr.toUpperCase().endsWith('M')) num *= 1000000;
            
            if (num > 10000) { // Sanity check
              openInterest = Math.round(num);
              console.log(`  Found OI via text search: ${openInterest.toLocaleString()} contracts`);
            }
          }
        }
      });
    }
    
    // Method 3: Look for data attributes or JSON-LD
    if (!openInterest) {
      const scriptTags = $('script[type="application/ld+json"], script').text();
      const oiMatch = scriptTags.match(/"openInterest"[:\s]*"?([0-9,]+)"?/i) ||
                      scriptTags.match(/openInterest[:\s]*([0-9,]+)/i);
      if (oiMatch) {
        const num = parseInt(oiMatch[1].replace(/,/g, ''));
        if (num > 10000) {
          openInterest = num;
          console.log(`  Found OI via script data: ${openInterest.toLocaleString()} contracts`);
        }
      }
    }
    
    if (openInterest) {
      console.log(`  ✅ Open Interest: ${openInterest.toLocaleString()} contracts`);
      return { openInterest };
    }
    
    throw new Error('Open Interest not found on MarketWatch page');
    
  } catch (err) {
    console.error(`  MarketWatch OI fetch failed: ${err.message}`);
    throw err;
  }
}

// ============================================
// Main Function
// ============================================
async function main() {
  console.log('🥈 Silver Ops - Macro Data Fetcher');
  console.log('====================================');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('');
  
  // 1. Read existing history
  let history = [];
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    history = JSON.parse(data);
    console.log(`📂 Loaded ${history.length} existing records`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('📂 No history file found, starting fresh');
      const dataDir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    } else {
      console.error('Error reading history:', err.message);
    }
  }
  
  const lastEntry = history.length > 0 ? history[history.length - 1] : null;
  if (lastEntry) {
    console.log(`📅 Last entry: ${lastEntry.timestamp}`);
  }
  console.log('');
  
  // 2. Initialize new data record
  const newData = {
    timestamp: new Date().toISOString(),
    source: 'cme',
    registered_oz: null,
    eligible_oz: null,
    total_oz: null,
    comex_oi: null,
    fetch_status: {}
  };
  
  // ============================================
  // Task A: Fetch CME Inventory (Critical)
  // ============================================
  try {
    const cmeData = await fetchCMEInventory();
    newData.registered_oz = cmeData.registered;
    newData.eligible_oz = cmeData.eligible;
    newData.total_oz = cmeData.registered + cmeData.eligible;
    newData.fetch_status.cme = 'success';
    console.log(`  ✅ CME: Registered=${newData.registered_oz.toLocaleString()} oz, Eligible=${newData.eligible_oz.toLocaleString()} oz`);
  } catch (err) {
    console.error(`  ❌ CME fetch failed: ${err.message}`);
    newData.fetch_status.cme = 'failed';
  }
  console.log('');
  
  // ============================================
  // Task B: Fetch Open Interest (Nice-to-have)
  // ============================================
  try {
    const oiData = await fetchMarketWatchOI();
    newData.comex_oi = oiData.openInterest;
    newData.fetch_status.marketwatch = 'success';
  } catch (err) {
    // Don't crash - OI is supplementary data
    console.log('  ℹ️  MarketWatch OI unavailable. Proceeding with CME inventory only.');
    newData.fetch_status.marketwatch = 'failed';
    
    // Preserve previous OI if available
    if (lastEntry && lastEntry.comex_oi) {
      newData.comex_oi = lastEntry.comex_oi;
      console.log(`  ℹ️  Using previous OI value: ${lastEntry.comex_oi.toLocaleString()}`);
    }
  }
  console.log('');
  
  // ============================================
  // 3. Smart Save: Only save if data changed
  // ============================================
  if (lastEntry) {
    const isSame = (
      lastEntry.registered_oz === newData.registered_oz &&
      lastEntry.eligible_oz === newData.eligible_oz &&
      lastEntry.comex_oi === newData.comex_oi
    );
    
    if (isSame) {
      console.log('📊 Data unchanged from last entry. Skipping save.');
      printSummary(newData);
      return;
    }
  }
  
  // 4. Save new data
  if (DRY_RUN) {
    console.log('🔍 DRY RUN - Would save:');
    console.log(JSON.stringify(newData, null, 2));
  } else {
    // Only save if we have at least CME inventory data
    if (newData.fetch_status.cme === 'success') {
      history.push(newData);
      
      // Keep only last 365 days of data (max ~4380 entries at 2hr intervals)
      const maxEntries = 4380;
      if (history.length > maxEntries) {
        history = history.slice(-maxEntries);
      }
      
      fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2));
      console.log(`💾 Saved new entry. Total records: ${history.length}`);
    } else {
      console.log('⚠️  CME fetch failed. Not saving incomplete data.');
    }
  }
  
  printSummary(newData);
}

// ============================================
// Summary Printer
// ============================================
function printSummary(data) {
  console.log('');
  console.log('====================================');
  console.log('Summary:');
  console.log(`  Registered: ${data.registered_oz?.toLocaleString() || 'N/A'} oz`);
  console.log(`  Eligible: ${data.eligible_oz?.toLocaleString() || 'N/A'} oz`);
  console.log(`  Total: ${data.total_oz?.toLocaleString() || 'N/A'} oz`);
  console.log(`  Open Interest: ${data.comex_oi?.toLocaleString() || 'N/A'}`);
  console.log('====================================');
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
