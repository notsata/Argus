'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const { version: APP_VERSION } = require('./package.json');

// Simple in-memory rate limiter (per key, per minute)
const _rlBuckets = {};
function _rateLimit(key, max) {
  const now = Date.now();
  if (!_rlBuckets[key]) _rlBuckets[key] = [];
  _rlBuckets[key] = _rlBuckets[key].filter(t => now - t < 60000);
  if (_rlBuckets[key].length >= max) return false;
  _rlBuckets[key].push(now);
  return true;
}

// Yahoo Finance fetch with 10-second timeout
function _yFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
}

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
// Key is set by electron-main.js via ARGUS_CRYPTO_KEY (64 hex chars = 32 bytes).
// Falls back to plain JSON when the key isn't present (dev/non-Electron runs).
function _getKey() {
  const hex = process.env.ARGUS_CRYPTO_KEY || '';
  const buf = Buffer.from(hex, 'hex');
  return buf.length === 32 ? buf : null;
}

function encryptJSON(obj) {
  const key = _getKey();
  const text = JSON.stringify(obj, null, 2);
  if (!key) return text;
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  // Format: iv_hex:authtag_hex:ciphertext_hex  (all hex — no colons inside)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptJSON(raw) {
  const key = _getKey();
  if (key) {
    // Try encrypted format first; fall through to plain JSON on any failure
    try {
      const parts = raw.split(':');
      if (parts.length === 3) {
        const iv      = Buffer.from(parts[0], 'hex');
        const tag     = Buffer.from(parts[1], 'hex');
        const enc     = Buffer.from(parts[2], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
        return JSON.parse(dec.toString('utf8'));
      }
    } catch { /* fall through */ }
  }
  return JSON.parse(raw); // plain JSON (existing files before encryption was added)
}

// ── Data directory ────────────────────────────────────────────────────────────
const isPkg    = typeof process.pkg !== 'undefined';
const DATA_DIR = process.env.ARGUS_DATA_DIR ||
                 (isPkg ? path.dirname(process.execPath) : __dirname);
const HOLDINGS_FILE  = path.join(DATA_DIR, 'argus-holdings.json');
const SNAPSHOTS_FILE = path.join(DATA_DIR, 'argus-snapshots.json');
const ALERTS_FILE    = path.join(DATA_DIR, 'argus-alerts.json');

// ── Holdings ──────────────────────────────────────────────────────────────────
function loadHoldings() {
  try {
    if (fs.existsSync(HOLDINGS_FILE)) {
      const data = decryptJSON(fs.readFileSync(HOLDINGS_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch { /* first run */ }
  return [];
}
function saveHoldings(arr) {
  fs.writeFileSync(HOLDINGS_FILE, encryptJSON(arr), 'utf8');
}
let HOLDINGS = loadHoldings();

// ── Snapshots ─────────────────────────────────────────────────────────────────
function loadSnapshots() {
  try {
    if (fs.existsSync(SNAPSHOTS_FILE))
      return decryptJSON(fs.readFileSync(SNAPSHOTS_FILE, 'utf8')) || [];
  } catch {}
  return [];
}
function saveSnapshotForToday(summary) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const entry = { date: today, totalValue: summary.totalValue, totalGain: summary.totalGain,
                    totalGainPct: summary.totalGainPct, totalCostBasis: summary.totalCostBasis };
    // Dedup: keep last entry per date, then upsert today
    const byDate = {};
    loadSnapshots().forEach(s => { byDate[s.date] = s; });
    byDate[today] = entry;
    const snaps = Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
    fs.writeFileSync(SNAPSHOTS_FILE, encryptJSON(snaps.slice(-365)), 'utf8');
  } catch (e) { console.warn('Snapshot save error:', e.message); }
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE))
      return decryptJSON(fs.readFileSync(ALERTS_FILE, 'utf8')) || [];
  } catch {}
  return [];
}
function saveAlerts(arr) {
  fs.writeFileSync(ALERTS_FILE, encryptJSON(arr), 'utf8');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Yahoo Finance auth ────────────────────────────────────────────────────────
let _cookie = null;
let _crumb  = null;

async function getYahooAuth() {
  if (_cookie && _crumb) return;
  const cookieRes = await _yFetch('https://fc.yahoo.com/', {
    redirect: 'manual', headers: { 'User-Agent': UA },
  });
  const raw = cookieRes.headers.get('set-cookie') || '';
  _cookie = raw.split(/,(?=[^ ].*?=)/).map(c => c.split(';')[0].trim()).join('; ');
  const crumbRes = await _yFetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': _cookie },
  });
  _crumb = (await crumbRes.text()).trim();
  if (!_crumb || _crumb.startsWith('<')) {
    _cookie = null; _crumb = null;
    throw new Error('Could not obtain Yahoo Finance crumb. Try again in a moment.');
  }
  console.log('Yahoo Finance auth OK.');
}

async function fetchYahooQuotes(symbols) {
  await getYahooAuth();
  const buildUrl = () =>
    `https://query1.finance.yahoo.com/v7/finance/quote` +
    `?symbols=${encodeURIComponent(symbols.join(','))}` +
    `&crumb=${encodeURIComponent(_crumb)}` +
    `&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,` +
    `fiftyTwoWeekHigh,fiftyTwoWeekLow,earningsTimestamp,earningsTimestampStart,` +
    `earningsTimestampEnd,epsForwardAnnual,epsTrailingTwelveMonths,longName,shortName`;
  let res = await _yFetch(buildUrl(), { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
  if (res.status === 401) {
    // Token expired — re-auth once and retry
    _cookie = null; _crumb = null;
    await getYahooAuth();
    res = await _yFetch(buildUrl(), { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
  }
  if (!res.ok) { _cookie = null; _crumb = null; throw new Error(`Yahoo Finance HTTP ${res.status}`); }
  const json = await res.json();
  const results = json?.quoteResponse?.result;
  if (!Array.isArray(results)) throw new Error('Unexpected Yahoo Finance response shape');
  return results;
}

// ── App version ───────────────────────────────────────────────────────────────
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));

// ── Setup status ──────────────────────────────────────────────────────────────
app.get('/api/setup-status', (_req, res) => {
  res.json({ configured: HOLDINGS.length > 0, count: HOLDINGS.length });
});

// ── Save portfolio ────────────────────────────────────────────────────────────
app.post('/api/setup', (req, res) => {
  const raw = req.body?.holdings;
  if (!Array.isArray(raw) || raw.length === 0)
    return res.status(400).json({ error: 'holdings array required' });
  const validated = raw.map(h => ({
    symbol:    String(h.symbol || '').toUpperCase().replace(/[^A-Z0-9.^-]/g, '').slice(0, 12),
    name:      String(h.name   || h.symbol || '').trim().slice(0, 80),
    shares:    Math.max(0, parseFloat(h.shares)    || 0),
    costBasis: Math.max(0, parseFloat(h.costBasis) || 0),
    sector:    String(h.sector || 'Other').replace(/[<>"'&]/g, '').trim().slice(0, 40),
    drip:      Boolean(h.drip) || false,
    flagColor: h.flagColor || null,
    weight:    0,
  })).filter(h => h.symbol && h.shares > 0);
  if (validated.length === 0)
    return res.status(400).json({ error: 'No valid holdings provided' });
  HOLDINGS = validated;
  saveHoldings(validated);
  _portfolioHistoryCache = null; // invalidate on holdings change
  res.json({ success: true, count: validated.length });
});

// ── Reset portfolio ───────────────────────────────────────────────────────────
app.delete('/api/setup', (_req, res) => {
  if (!_rateLimit('reset', 5)) return res.status(429).json({ error: 'Too many requests' });
  HOLDINGS = [];
  try { fs.unlinkSync(HOLDINGS_FILE); } catch {}
  res.json({ success: true });
});

// ── Toggle DRIP per holding ───────────────────────────────────────────────────
app.patch('/api/holdings/:symbol/drip', (req, res) => {
  const sym = String(req.params.symbol).toUpperCase().replace(/[^A-Z0-9.^-]/g, '').slice(0, 12);
  if (!sym) return res.status(400).json({ error: 'invalid symbol' });
  const { drip } = req.body;
  if (typeof drip !== 'boolean') return res.status(400).json({ error: 'drip must be boolean' });
  const idx = HOLDINGS.findIndex(h => h.symbol === sym);
  if (idx === -1) return res.status(404).json({ error: 'holding not found' });
  HOLDINGS[idx].drip = drip;
  saveHoldings(HOLDINGS);
  _portfolioHistoryCache = null;
  res.json({ success: true, symbol: sym, drip });
});

// ── Set flag color per holding ────────────────────────────────────────────────
const _validFlags = new Set(['red','orange','yellow','green','blue','purple','cyan']);
app.patch('/api/holdings/:symbol/flag', (req, res) => {
  const sym = String(req.params.symbol).toUpperCase().replace(/[^A-Z0-9.^-]/g, '').slice(0, 12);
  if (!sym) return res.status(400).json({ error: 'invalid symbol' });
  const { flagColor } = req.body;
  if (flagColor !== null && flagColor !== undefined && !_validFlags.has(flagColor))
    return res.status(400).json({ error: 'invalid flagColor' });
  const idx = HOLDINGS.findIndex(h => h.symbol === sym);
  if (idx === -1) return res.status(404).json({ error: 'holding not found' });
  HOLDINGS[idx].flagColor = flagColor || null;
  saveHoldings(HOLDINGS);
  res.json({ success: true, symbol: sym, flagColor: HOLDINGS[idx].flagColor });
});

// ── Static holdings ───────────────────────────────────────────────────────────
app.get('/api/holdings', (_req, res) => res.json({ holdings: HOLDINGS }));

// ── Live prices + auto-snapshot ───────────────────────────────────────────────
app.post('/api/prices', async (_req, res) => {
  if (HOLDINGS.length === 0)
    return res.status(400).json({ error: 'No holdings configured' });
  try {
    const symbols  = HOLDINGS.map(h => h.symbol);
    const quotes   = await fetchYahooQuotes(symbols);
    const bySymbol = Object.fromEntries(quotes.map(q => [q.symbol, q]));
    let totalValue = 0, totalDailyPnL = 0, totalCostBasis = 0;
    const enriched = HOLDINGS.map(h => {
      const q = bySymbol[h.symbol];
      if (!q?.regularMarketPrice) {
        console.warn(`No price for ${h.symbol}`);
        const costVal = h.shares * h.costBasis;
        return { ...h, currentValue: costVal, dailyPnL: 0, costValue: costVal,
                 totalGain: 0, totalGainPct: 0, portfolioWeight: 0 };
      }
      const price        = q.regularMarketPrice;
      const change       = q.regularMarketChange        || 0;
      const changePct    = q.regularMarketChangePercent || 0;
      const currentValue = h.shares * price;
      const dailyPnL     = h.shares * change;
      const costValue    = h.shares * h.costBasis;
      totalValue     += currentValue;
      totalDailyPnL  += dailyPnL;
      totalCostBasis += costValue;
      return {
        ...h, price, change, changePct,
        high52: q.fiftyTwoWeekHigh || null, low52: q.fiftyTwoWeekLow || null,
        currentValue, dailyPnL, costValue,
        totalGain:    currentValue - costValue,
        totalGainPct: costValue ? ((currentValue / costValue) - 1) * 100 : 0,
        earningsTs:      q.earningsTimestamp      || null,
        earningsTsStart: q.earningsTimestampStart || null,
        earningsTsEnd:   q.earningsTimestampEnd   || null,
        epsForward:      q.epsForwardAnnual        || null,
        epsTrailing:     q.epsTrailingTwelveMonths || null,
      };
    });
    const holdings = enriched.map(h => ({
      ...h, portfolioWeight: totalValue ? (h.currentValue / totalValue) * 100 : 0,
    }));
    const summary = {
      totalValue, totalDailyPnL,
      totalDailyPnLPct: totalValue ? (totalDailyPnL / (totalValue - totalDailyPnL)) * 100 : 0,
      totalCostBasis,
      totalGain:    totalValue - totalCostBasis,
      totalGainPct: totalCostBasis ? ((totalValue / totalCostBasis) - 1) * 100 : 0,
      asOf: new Date().toISOString(),
    };
    if (totalValue > 0) saveSnapshotForToday(summary);
    res.json({ holdings, summary });
  } catch (err) {
    console.error('Prices error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Single-symbol quote ───────────────────────────────────────────────────────
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const sym = String(req.params.symbol).toUpperCase().replace(/[^A-Z0-9.^-]/g, '').slice(0, 12);
    if (!sym) return res.status(400).json({ error: 'invalid symbol' });
    const quotes = await fetchYahooQuotes([sym]);
    const q      = quotes[0];
    if (!q?.regularMarketPrice) return res.status(404).json({ error: 'Symbol not found' });
    res.json({
      symbol: q.symbol, price: q.regularMarketPrice,
      change: q.regularMarketChange || 0, changePct: q.regularMarketChangePercent || 0,
      name: q.longName || q.shortName || sym,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Technical indicators ──────────────────────────────────────────────────────
function calcIndicators(closes) {
  const prices = closes.filter(p => p != null);
  const n = prices.length;
  if (n < 2) return null;
  const last  = prices[n - 1];
  const ma50  = n >= 50  ? prices.slice(-50).reduce((s,p)=>s+p,0)/50   : null;
  const ma200 = n >= 200 ? prices.slice(-200).reduce((s,p)=>s+p,0)/200 : null;
  let rsi = null;
  if (n >= 15) {
    const slice = prices.slice(-15);
    let gains = 0, losses = 0;
    for (let i = 1; i < slice.length; i++) {
      const d = slice[i] - slice[i-1];
      if (d > 0) gains += d; else losses -= d;
    }
    const avgG = gains / 14, avgL = losses / 14;
    rsi = avgL === 0 ? 100 : +(100 - 100/(1+avgG/avgL)).toFixed(1);
  }
  return {
    price: +last.toFixed(4),
    ma50: ma50 ? +ma50.toFixed(4) : null, ma200: ma200 ? +ma200.toFixed(4) : null, rsi,
    pctFromMa50:  ma50  ? +((last-ma50) /ma50 *100).toFixed(2) : null,
    pctFromMa200: ma200 ? +((last-ma200)/ma200*100).toFixed(2) : null,
  };
}

app.post('/api/technicals', async (req, res) => {
  try {
    const raw = req.body?.symbols;
    if (!Array.isArray(raw) || raw.length === 0)
      return res.status(400).json({ error: 'symbols array required' });
    if (raw.length > 50)
      return res.status(400).json({ error: 'too many symbols (max 50)' });
    const symbols = raw.map(s => String(s).toUpperCase().replace(/[^A-Z0-9.^-]/g, '').slice(0, 12)).filter(Boolean);
    if (symbols.length === 0)
      return res.status(400).json({ error: 'no valid symbols provided' });
    await getYahooAuth();
    const results = await Promise.all(symbols.map(async sym => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y&crumb=${encodeURIComponent(_crumb)}`;
        const r   = await _yFetch(url, { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
        if (!r.ok) { if (r.status===401){_cookie=null;_crumb=null;} throw new Error(`HTTP ${r.status}`); }
        const json   = await r.json();
        const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
        if (!closes?.length) throw new Error('no price data');
        return { symbol: sym, ...calcIndicators(closes) };
      } catch(e) { return { symbol: sym, error: e.message }; }
    }));
    res.json({ technicals: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Market Heatmap ────────────────────────────────────────────────────────────
const HEATMAP_SECTORS = [
  { sector: 'Technology',       symbols: ['AAPL','MSFT','NVDA','AVGO','ORCL','ADBE','CSCO','AMD','INTC','CRM'] },
  { sector: 'Financials',       symbols: ['BRK-B','JPM','V','MA','BAC','WFC','GS','MS','C','AXP'] },
  { sector: 'Health Care',      symbols: ['LLY','UNH','ABBV','MRK','TMO','ABT','DHR','BMY','AMGN','MDT'] },
  { sector: 'Consumer Disc.',   symbols: ['AMZN','TSLA','HD','MCD','NKE','SBUX','TJX','LOW','BKNG','CMG'] },
  { sector: 'Communication',    symbols: ['META','GOOGL','GOOG','NFLX','DIS','CMCSA','T','VZ','CHTR','TMUS'] },
  { sector: 'Industrials',      symbols: ['GE','CAT','RTX','HON','UNP','BA','UPS','LMT','DE','MMM'] },
  { sector: 'Consumer Staples', symbols: ['WMT','PG','KO','PEP','COST','PM','MO','MDLZ','CL','KHC'] },
  { sector: 'Energy',           symbols: ['XOM','CVX','COP','SLB','EOG','MPC','PSX','OXY','VLO','KMI'] },
  { sector: 'Real Estate',      symbols: ['PLD','AMT','EQIX','CCI','SPG','WELL','DLR','PSA','EQR','AVB'] },
  { sector: 'Utilities',        symbols: ['NEE','DUK','SO','D','AEP','EXC','SRE','ED','PCG','XEL'] },
  { sector: 'Materials',        symbols: ['LIN','APD','SHW','FCX','NEM','ECL','DOW','NUE','ALB','MOS'] },
];

app.get('/api/heatmap', async (_req, res) => {
  try {
    const allSymbols = HEATMAP_SECTORS.flatMap(s => s.symbols);
    const quotes     = await fetchYahooQuotes(allSymbols);
    const bySymbol   = Object.fromEntries(quotes.map(q => [q.symbol, q]));
    const sectors    = HEATMAP_SECTORS.map(s => ({
      sector: s.sector,
      stocks: s.symbols.map(sym => {
        const q = bySymbol[sym];
        return { symbol: sym, name: q?.longName||q?.shortName||sym,
                 price: q?.regularMarketPrice??null, changePct: q?.regularMarketChangePercent??null };
      }),
    }));
    res.json({ sectors, asOf: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Portfolio Snapshots ───────────────────────────────────────────────────────
app.get('/api/snapshots', (_req, res) => {
  res.json({ snapshots: loadSnapshots() });
});

// ── News (5-min cache) ────────────────────────────────────────────────────────
let _newsCache = null;
let _newsCacheTs = 0;

app.get('/api/news', async (_req, res) => {
  if (HOLDINGS.length === 0) return res.json({ articles: [] });
  if (_newsCache && (Date.now() - _newsCacheTs) < 5 * 60 * 1000) return res.json(_newsCache);
  try {
    const symbols = HOLDINGS.slice(0, 8).map(h => h.symbol);
    const results = await Promise.all(symbols.map(async sym => {
      try {
        const r    = await _yFetch(
          `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&newsCount=4&quotesCount=0`,
          { headers: { 'User-Agent': UA } }
        );
        const json = await r.json();
        return (json.news || []).map(a => ({
          symbol: sym, title: a.title, link: a.link,
          publisher: a.publisher, time: a.providerPublishTime,
        }));
      } catch { return []; }
    }));
    const seen = new Set();
    const articles = results.flat()
      .filter(a => { if (!a.link || seen.has(a.link)) return false; seen.add(a.link); return true; })
      .sort((a, b) => b.time - a.time)
      .slice(0, 25);
    const payload = { articles, asOf: new Date().toISOString() };
    _newsCache = payload; _newsCacheTs = Date.now();
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Price Alerts ──────────────────────────────────────────────────────────────
app.get('/api/alerts', (_req, res) => res.json({ alerts: loadAlerts() }));

app.post('/api/alerts', (req, res) => {
  const { symbol, targetPrice, direction } = req.body;
  if (!symbol || !targetPrice || !direction)
    return res.status(400).json({ error: 'symbol, targetPrice, direction required' });
  if (!['above', 'below'].includes(direction))
    return res.status(400).json({ error: 'direction must be "above" or "below"' });
  const sym = String(symbol).toUpperCase().replace(/[^A-Z0-9.^-]/g, '').slice(0, 12);
  if (!sym) return res.status(400).json({ error: 'invalid symbol' });
  const price = parseFloat(targetPrice);
  if (isNaN(price) || price <= 0) return res.status(400).json({ error: 'targetPrice must be a positive number' });
  const alerts = loadAlerts();
  const id = Date.now().toString();
  alerts.push({
    id, symbol: sym, targetPrice: price, direction,
    createdAt: new Date().toISOString(),
  });
  saveAlerts(alerts);
  res.json({ success: true, id });
});

app.delete('/api/alerts/:id', (req, res) => {
  saveAlerts(loadAlerts().filter(a => a.id !== req.params.id));
  res.json({ success: true });
});

// ── Benchmark: SPY + QQQ 1-year daily closes ──────────────────────────────────
app.get('/api/benchmark', async (_req, res) => {
  try {
    await getYahooAuth();
    const results = await Promise.all(['SPY', 'QQQ'].map(async sym => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1y&crumb=${encodeURIComponent(_crumb)}`;
      const r   = await _yFetch(url, { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json       = await r.json();
      const result     = json?.chart?.result?.[0];
      const timestamps = result?.timestamp || [];
      const closes     = result?.indicators?.quote?.[0]?.close || [];
      return {
        symbol: sym,
        data: timestamps
          .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().split('T')[0], close: closes[i] }))
          .filter(d => d.close != null),
      };
    }));
    res.json({ benchmarks: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Market Overview ticker ────────────────────────────────────────────────────
const MARKET_SYMBOLS = [
  { sym: 'ES=F',    label: 'S&P Futures'       },
  { sym: 'YM=F',    label: 'Dow Futures'        },
  { sym: 'NQ=F',    label: 'Nasdaq Futures'     },
  { sym: 'RTY=F',   label: 'Russell 2000 Futures'},
  { sym: '^VIX',    label: 'VIX'               },
  { sym: 'GC=F',    label: 'Gold'              },
  { sym: 'BTC-USD', label: 'Bitcoin USD'       },
  { sym: 'CL=F',    label: 'Crude Oil'         },
];
let _marketCache = null;
let _marketCacheTs = 0;

app.get('/api/market-overview', async (_req, res) => {
  if (_marketCache && (Date.now() - _marketCacheTs) < 5 * 60 * 1000)
    return res.json(_marketCache);
  try {
    const syms   = MARKET_SYMBOLS.map(m => m.sym);
    const quotes = await fetchYahooQuotes(syms);
    const bySymbol = Object.fromEntries(quotes.map(q => [q.symbol, q]));
    const items = MARKET_SYMBOLS.map(({ sym, label }) => {
      const q = bySymbol[sym];
      return {
        sym, label,
        price:     q?.regularMarketPrice             ?? null,
        change:    q?.regularMarketChange            ?? null,
        changePct: q?.regularMarketChangePercent     ?? null,
      };
    });
    const payload = { items, asOf: new Date().toISOString() };
    _marketCache = payload; _marketCacheTs = Date.now();
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Historical portfolio value (1-year daily closes) ─────────────────────────
let _portfolioHistoryCache = null;
let _portfolioHistoryCacheTs = 0;
const PORTFOLIO_HISTORY_TTL = 60 * 60 * 1000; // 1 hour

app.get('/api/portfolio-history', async (_req, res) => {
  if (_portfolioHistoryCache && (Date.now() - _portfolioHistoryCacheTs) < PORTFOLIO_HISTORY_TTL)
    return res.json(_portfolioHistoryCache);
  if (HOLDINGS.length === 0) return res.json({ history: [] });
  try {
    await getYahooAuth();

    // Fetch 1-year daily closes + dividend events for every holding in parallel
    const holdingData = await Promise.all(HOLDINGS.map(async h => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(h.symbol)}` +
                    `?interval=1d&range=1y&events=dividends&crumb=${encodeURIComponent(_crumb)}`;
        const r = await _yFetch(url, { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
        if (!r.ok) { if (r.status === 401) { _cookie = null; _crumb = null; } throw new Error(`HTTP ${r.status}`); }
        const json       = await r.json();
        const result     = json?.chart?.result?.[0];
        const timestamps = result?.timestamp || [];
        const closes     = result?.indicators?.quote?.[0]?.close || [];
        const prices     = {};
        timestamps.forEach((ts, i) => {
          if (closes[i] != null) prices[new Date(ts * 1000).toISOString().split('T')[0]] = closes[i];
        });
        const divRaw   = result?.events?.dividends || {};
        const dividends = Object.values(divRaw)
          .map(d => ({ date: new Date(d.date * 1000).toISOString().split('T')[0], amount: d.amount }))
          .sort((a, b) => a.date < b.date ? -1 : 1);
        return { symbol: h.symbol, shares: h.shares, costBasis: h.costBasis, drip: h.drip || false, prices, dividends };
      } catch (e) {
        console.warn('[portfolio-history]', h.symbol + ':', e.message);
        return { symbol: h.symbol, shares: h.shares, costBasis: h.costBasis, drip: h.drip || false, prices: {}, dividends: [] };
      }
    }));

    // Build DRIP share schedules: for each DRIP holding replay dividend events
    // to compute cumulative shares owned after each reinvestment.
    holdingData.forEach(h => {
      if (!h.drip || !h.dividends.length) { h.shareSchedule = null; return; }
      const priceDates = Object.keys(h.prices).sort();
      let running = h.shares;
      const schedule = [{ date: '0000-00-00', shares: running }];
      for (const div of h.dividends) {
        const pd = priceDates.find(d => d >= div.date);
        if (!pd) continue;
        const price = h.prices[pd];
        if (!price || price <= 0) continue;
        running += (running * div.amount) / price;
        schedule.push({ date: pd, shares: running });
      }
      h.shareSchedule = schedule;
    });

    // Union of all dates that appear in any holding's price history
    const allDates = new Set();
    holdingData.forEach(h => Object.keys(h.prices).forEach(d => allDates.add(d)));
    const sortedDates = Array.from(allDates).sort();

    const totalCostBasis = HOLDINGS.reduce((s, h) => s + h.shares * h.costBasis, 0);

    const history = sortedDates.map(date => {
      let totalValue = 0;
      holdingData.forEach(h => {
        let shares = h.shares;
        if (h.drip && h.shareSchedule) {
          for (const s of h.shareSchedule) {
            if (s.date <= date) shares = s.shares;
            else break;
          }
        }
        totalValue += shares * (h.prices[date] ?? h.costBasis);
      });
      const totalGain = totalValue - totalCostBasis;
      return {
        date,
        totalValue:     +totalValue.toFixed(2),
        totalCostBasis: +totalCostBasis.toFixed(2),
        totalGain:      +totalGain.toFixed(2),
        totalGainPct:   totalCostBasis ? +((totalGain / totalCostBasis) * 100).toFixed(4) : 0,
      };
    });

    // Summarise DRIP activity per holding for the client
    const dripStats = {};
    holdingData.forEach(h => {
      if (h.drip && h.shareSchedule && h.shareSchedule.length > 1) {
        const last = h.shareSchedule[h.shareSchedule.length - 1];
        dripStats[h.symbol] = {
          count:       h.dividends.length,
          extraShares: +(last.shares - h.shares).toFixed(6),
        };
      }
    });

    const payload = { history, dripStats, asOf: new Date().toISOString() };
    _portfolioHistoryCache = payload;
    _portfolioHistoryCacheTs = Date.now();
    res.json(payload);
  } catch (err) {
    console.error('[portfolio-history]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Dividend income (2-year history for growth comparison) ────────────────────
let _dividendsCache    = null;
let _dividendsCacheTs  = 0;
const DIVIDENDS_TTL    = 60 * 60 * 1000; // 1 hour

app.get('/api/dividends', async (_req, res) => {
  if (_dividendsCache && (Date.now() - _dividendsCacheTs) < DIVIDENDS_TTL)
    return res.json(_dividendsCache);
  if (HOLDINGS.length === 0) return res.json({ holdings: [], summary: {} });
  try {
    await getYahooAuth();

    const now        = Date.now();
    const oneYearAgo = new Date(now - 365 * 864e5).toISOString().split('T')[0];
    const twoYrsAgo  = new Date(now - 730 * 864e5).toISOString().split('T')[0];

    // Fetch current quotes for price/yield calc alongside dividend history
    const quotes    = await fetchYahooQuotes(HOLDINGS.map(h => h.symbol));
    const bySymbol  = Object.fromEntries(quotes.map(q => [q.symbol, q]));

    const holdingDivs = await Promise.all(HOLDINGS.map(async h => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(h.symbol)}` +
                    `?interval=1d&range=2y&events=dividends&crumb=${encodeURIComponent(_crumb)}`;
        const r   = await _yFetch(url, { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
        if (!r.ok) { if (r.status === 401) { _cookie = null; _crumb = null; } throw new Error(`HTTP ${r.status}`); }
        const json = await r.json();
        const divRaw = json?.chart?.result?.[0]?.events?.dividends || {};
        const divs   = Object.values(divRaw)
          .map(d => ({ date: new Date(d.date * 1000).toISOString().split('T')[0], amount: d.amount }))
          .sort((a, b) => a.date < b.date ? -1 : 1);

        const trailing = divs.filter(d => d.date >= oneYearAgo);
        const prior    = divs.filter(d => d.date >= twoYrsAgo && d.date < oneYearAgo);
        const trailingSum = trailing.reduce((s, d) => s + d.amount, 0);
        const priorSum    = prior   .reduce((s, d) => s + d.amount, 0);

        // Frequency from average interval between trailing dividends
        let frequency = null;
        if (trailing.length >= 2) {
          let totalDays = 0;
          for (let i = 1; i < trailing.length; i++)
            totalDays += (new Date(trailing[i].date) - new Date(trailing[i-1].date)) / 864e5;
          const avg = totalDays / (trailing.length - 1);
          frequency = avg < 40 ? 'monthly' : avg < 100 ? 'quarterly' : avg < 200 ? 'semi-annual' : 'annual';
        } else if (divs.length >= 1) {
          frequency = 'annual';
        }

        // Estimate next ex-dividend date
        let nextEstDate = null;
        if (trailing.length > 0 && frequency) {
          const lastMs = new Date(trailing[trailing.length - 1].date + 'T12:00:00Z').getTime();
          const step   = { monthly: 30, quarterly: 91, 'semi-annual': 182, annual: 365 }[frequency];
          nextEstDate  = new Date(lastMs + step * 864e5).toISOString().split('T')[0];
        }

        // Quarterly income buckets (last 8 quarters, actual shares)
        const quarterlyIncome = {};
        divs.forEach(d => {
          const dt = new Date(d.date + 'T12:00:00Z');
          const qk = `${dt.getUTCFullYear()}-Q${Math.ceil((dt.getUTCMonth() + 1) / 3)}`;
          quarterlyIncome[qk] = (quarterlyIncome[qk] || 0) + d.amount * h.shares;
        });

        const price = bySymbol[h.symbol]?.regularMarketPrice || null;
        return {
          symbol: h.symbol, name: h.name, shares: h.shares, drip: h.drip || false, price,
          trailingAnnualDiv: +trailingSum.toFixed(4),
          priorAnnualDiv:    +priorSum   .toFixed(4),
          annualIncome:      +(trailingSum * h.shares).toFixed(2),
          yield:  (price && trailingSum) ? +((trailingSum / price) * 100).toFixed(2) : null,
          growth: (priorSum > 0 && trailingSum > 0) ? +((trailingSum - priorSum) / priorSum * 100).toFixed(2) : null,
          frequency, nextEstDate,
          dividends: divs, quarterlyIncome,
        };
      } catch (e) {
        console.warn('[dividends]', h.symbol + ':', e.message);
        return { symbol: h.symbol, name: h.name, shares: h.shares, drip: h.drip || false,
                 price: null, trailingAnnualDiv: 0, priorAnnualDiv: 0, annualIncome: 0,
                 yield: null, growth: null, frequency: null, nextEstDate: null,
                 dividends: [], quarterlyIncome: {} };
      }
    }));

    const totalAnnualIncome = holdingDivs.reduce((s, h) => s + h.annualIncome, 0);
    const totalValue = HOLDINGS.reduce((s, h) => {
      const price = bySymbol[h.symbol]?.regularMarketPrice || h.costBasis;
      return s + h.shares * price;
    }, 0);
    const growthVals  = holdingDivs.filter(h => h.growth !== null).map(h => h.growth);
    const avgGrowth   = growthVals.length ? growthVals.reduce((s, g) => s + g, 0) / growthVals.length : null;
    const payingCount = holdingDivs.filter(h => h.trailingAnnualDiv > 0).length;

    // Merge all quarterly buckets for the portfolio chart
    const portfolioQuarterly = {};
    holdingDivs.forEach(h => {
      Object.entries(h.quarterlyIncome).forEach(([qk, inc]) => {
        portfolioQuarterly[qk] = (portfolioQuarterly[qk] || 0) + inc;
      });
    });

    const payload = {
      holdings: holdingDivs,
      summary: {
        totalAnnualIncome: +totalAnnualIncome.toFixed(2),
        portfolioYield:    totalValue > 0 ? +((totalAnnualIncome / totalValue) * 100).toFixed(2) : 0,
        avgGrowth:         avgGrowth !== null ? +avgGrowth.toFixed(2) : null,
        payingCount, totalCount: HOLDINGS.length,
        quarterlyIncome: portfolioQuarterly,
      },
    };
    _dividendsCache = payload; _dividendsCacheTs = Date.now();
    res.json(payload);
  } catch (err) {
    console.error('[dividends]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  Argus  →  http://localhost:${PORT}`);
  console.log(`  Holdings file      →  ${HOLDINGS_FILE}`);
  console.log(`  Holdings loaded    →  ${HOLDINGS.length} positions\n`);
});
