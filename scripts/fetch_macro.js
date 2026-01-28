/**
 * Silver Ops - Macro Data Fetcher
 * 
 * Fetches CME Silver inventory and Open Interest data
 * Uses Git Scraping pattern - only saves when data changes
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const XLSX = require('xlsx');

// ============================================
// Configuration
// ============================================
const SOURCES = {
  // CME Silver Stocks Report (Excel)
  CME_INVENTORY: 'https://www.cmegroup.com/delivery_reports/Silver_stocks.xls',
  
  // CFTC COT Report (Fallback, updated weekly on Fridays)
  CFTC_COT: 'https://www.cftc.gov/dea/newcot/deafut.txt'
};

const DATA_FILE = path.join(__dirname, '..', 'data', 'history.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ============================================
// CME Data Fetcher
// ============================================
async function fetchCME() {
  console.log('📊 Fetching CME Silver Inventory...');
  
  const response = await axios.get(SOURCES.CME_INVENTORY, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/vnd.ms-excel,application/octet-stream,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.cmegroup.com/'
    }
  });
  
  const workbook = XLSX.read(response.data, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  
  // Parse CME Silver Stocks Excel format
  // The format typically has headers and totals rows
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
      // Find numeric values in the row
      const numbers = row.filter(cell => typeof cell === 'number' && cell > 0);
      
      if (numbers.length >= 2) {
        // Usually: Registered, Eligible (in troy ounces)
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
      // Sum all numeric values in the registered/eligible columns
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
    // Log sheet structure for debugging
    console.log('  Sheet structure (first 10 rows):');
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      console.log(`    Row ${i}: ${JSON.stringify(data[i])}`);
    }
    throw new Error('Could not parse CME Excel structure');
  }
  
  return { registered, eligible };
}

// ============================================
// Yahoo Finance Fetcher (Open Interest)
// ============================================
async function fetchYahoo() {
  console.log('📈 Fetching Yahoo Finance Open Interest...');
  
  try {
    // Dynamic import for ES module
    const yahooFinance = require('yahoo-finance2').default;
    
    // Fetch Silver Futures (SI=F)
    const quote = await yahooFinance.quote('SI=F');
    
    if (quote && quote.openInterest) {
      console.log(`  Open Interest: ${quote.openInterest}`);
      return { openInterest: quote.openInterest };
    }
    
    // Try quoteSummary as fallback
    const summary = await yahooFinance.quoteSummary('SI=F', {
      modules: ['price', 'summaryDetail']
    });
    
    const oi = summary?.summaryDetail?.openInterest || 
               summary?.price?.openInterest || 
               null;
    
    console.log(`  Open Interest (summary): ${oi}`);
    return { openInterest: oi };
    
  } catch (err) {
    console.error('  Yahoo Finance error:', err.message);
    throw err;
  }
}

// ============================================
// CFTC COT Report Parser (Fallback)
// ============================================
async function fetchCFTC() {
  console.log('📋 Fetching CFTC COT Report (fallback)...');
  
  const response = await axios.get(SOURCES.CFTC_COT, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
  });
  
  const lines = response.data.split('\n');
  
  // Look for Silver entries (CFTC code: 084691)
  // Format is fixed-width, Silver is typically labeled
  for (const line of lines) {
    if (line.includes('SILVER') || line.includes('084691')) {
      // Parse COT data - format varies by report type
      // This is simplified; actual parsing depends on exact format
      const parts = line.split(/\s+/);
      
      // Open Interest is typically early in the record
      for (let i = 0; i < parts.length; i++) {
        const num = parseInt(parts[i]);
        if (num > 100000 && num < 500000) {
          // Likely Open Interest (contracts)
          console.log(`  Found OI in COT: ${num}`);
          return { openInterest: num };
        }
      }
    }
  }
  
  throw new Error('Could not find Silver data in COT report');
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
      // Ensure data directory exists
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
  
  // 2. Fetch new data
  const newData = {
    timestamp: new Date().toISOString(),
    source: 'cme',
    registered_oz: null,
    eligible_oz: null,
    total_oz: null,
    comex_oi: null,
    fetch_status: {}
  };
  
  // 2a. Try CME Inventory
  try {
    const cmeData = await fetchCME();
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
  
  // 2b. Try Yahoo Finance for Open Interest
  try {
    const yahooData = await fetchYahoo();
    newData.comex_oi = yahooData.openInterest;
    newData.fetch_status.yahoo = 'success';
    console.log(`  ✅ Yahoo: Open Interest=${newData.comex_oi?.toLocaleString() || 'N/A'}`);
  } catch (err) {
    console.error(`  ❌ Yahoo fetch failed: ${err.message}`);
    newData.fetch_status.yahoo = 'failed';
    
    // Try CFTC as fallback (weekly data)
    try {
      const cftcData = await fetchCFTC();
      newData.comex_oi = cftcData.openInterest;
      newData.fetch_status.cftc = 'success';
      console.log(`  ✅ CFTC (fallback): Open Interest=${newData.comex_oi?.toLocaleString()}`);
    } catch (cftcErr) {
      console.error(`  ❌ CFTC fallback failed: ${cftcErr.message}`);
      newData.fetch_status.cftc = 'failed';
    }
  }
  console.log('');
  
  // 3. Check if all fetches failed
  const allFailed = newData.fetch_status.cme === 'failed' && 
                    newData.fetch_status.yahoo === 'failed' &&
                    newData.fetch_status.cftc !== 'success';
  
  if (allFailed) {
    console.log('⚠️  All data fetches failed. Recording failure entry.');
    // Still save the entry to track fetch attempts
  }
  
  // 4. Compare with last entry (skip if data unchanged)
  if (lastEntry) {
    const isSame = (
      lastEntry.registered_oz === newData.registered_oz &&
      lastEntry.eligible_oz === newData.eligible_oz &&
      lastEntry.comex_oi === newData.comex_oi
    );
    
    if (isSame) {
      console.log('✨ No data change detected. Skipping save.');
      console.log('');
      console.log('Summary:');
      console.log(`  Registered: ${newData.registered_oz?.toLocaleString() || 'N/A'} oz`);
      console.log(`  Eligible: ${newData.eligible_oz?.toLocaleString() || 'N/A'} oz`);
      console.log(`  Total: ${newData.total_oz?.toLocaleString() || 'N/A'} oz`);
      console.log(`  Open Interest: ${newData.comex_oi?.toLocaleString() || 'N/A'}`);
      process.exit(0);
    }
  }
  
  // 5. Append and save (unless dry run)
  if (DRY_RUN) {
    console.log('🔍 DRY RUN - Would save:');
    console.log(JSON.stringify(newData, null, 2));
  } else {
    history.push(newData);
    fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2));
    console.log('💾 New data saved to history.json');
  }
  
  console.log('');
  console.log('====================================');
  console.log('Summary:');
  console.log(`  Registered: ${newData.registered_oz?.toLocaleString() || 'N/A'} oz`);
  console.log(`  Eligible: ${newData.eligible_oz?.toLocaleString() || 'N/A'} oz`);
  console.log(`  Total: ${newData.total_oz?.toLocaleString() || 'N/A'} oz`);
  console.log(`  Open Interest: ${newData.comex_oi?.toLocaleString() || 'N/A'}`);
  console.log('====================================');
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
