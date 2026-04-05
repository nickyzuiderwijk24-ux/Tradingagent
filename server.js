/**
 * TRADE.AGENT — Backend Server
 * 
 * Fetches real market data from:
 *   - Yahoo Finance (stocks & forex)
 *   - CoinGecko (crypto)
 * 
 * Run:  npm install && npm start
 * Runs on http://localhost:3001
 */

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// ─── Helpers ──────────────────────────────────────────────

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// Simple in-memory cache (5-minute TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Yahoo Finance (Stocks & Forex) ──────────────────────

const FOREX_MAP = {
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
  "USD/JPY": "USDJPY=X",
  "AUD/USD": "AUDUSD=X",
  "USD/CAD": "USDCAD=X",
  "USD/CHF": "USDCHF=X",
  "NZD/USD": "NZDUSD=X",
  "EUR/GBP": "EURGBP=X",
  "EUR/JPY": "EURJPY=X",
  "GBP/JPY": "GBPJPY=X",
};

async function fetchYahooQuote(symbol) {
  const cacheKey = `yahoo:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Yahoo Finance v8 API (public, no key needed)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d&includePrePost=false`;

  const data = await fetchJSON(url, {
    "User-Agent": "Mozilla/5.0 (compatible; TradingAgent/1.0)",
  });

  const result = data.chart?.result?.[0];
  if (!result) throw new Error(`No data found for ${symbol}`);

  const meta = result.meta;
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const volumes = result.indicators?.quote?.[0]?.volume || [];

  // Clean up null values
  const history = closes.map((c) => (c !== null ? c : undefined)).filter(Boolean);
  const totalVolume = volumes.filter(Boolean);

  const current = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose;
  const change = current - prevClose;
  const changePct = (change / prevClose) * 100;

  // Calculate period changes
  const weekAgo = history.length >= 6 ? history[history.length - 6] : history[0];
  const monthAgo = history.length >= 22 ? history[history.length - 22] : history[0];
  const weekChange = ((current - weekAgo) / weekAgo) * 100;
  const monthChange = ((current - monthAgo) / monthAgo) * 100;

  const output = {
    symbol: meta.symbol,
    name: meta.shortName || meta.symbol,
    currency: meta.currency || "USD",
    price: current,
    change,
    changePct,
    weekChange,
    monthChange,
    high52w: meta.fiftyTwoWeekHigh || Math.max(...history),
    low52w: meta.fiftyTwoWeekLow || Math.min(...history),
    volume: totalVolume.length ? totalVolume[totalVolume.length - 1] : 0,
    marketCap: null, // chart endpoint doesn't return this
    history,
    source: "yahoo_finance",
  };

  setCache(cacheKey, output);
  return output;
}

async function fetchYahooSearch(query) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`;
  const data = await fetchJSON(url, {
    "User-Agent": "Mozilla/5.0 (compatible; TradingAgent/1.0)",
  });
  return (data.quotes || []).map((q) => ({
    symbol: q.symbol,
    name: q.shortname || q.longname || q.symbol,
    type: q.quoteType,
    exchange: q.exchange,
  }));
}

// ─── CoinGecko (Crypto) ─────────────────────────────────

const CRYPTO_ID_MAP = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  ada: "cardano",
  doge: "dogecoin",
  xrp: "ripple",
  dot: "polkadot",
  avax: "avalanche-2",
  matic: "matic-network",
  link: "chainlink",
  uni: "uniswap",
  atom: "cosmos",
  near: "near",
  apt: "aptos",
  sui: "sui",
  bnb: "binancecoin",
  ltc: "litecoin",
  shib: "shiba-inu",
  arb: "arbitrum",
  op: "optimism",
};

function resolveCryptoId(input) {
  const lower = input.toLowerCase().trim();
  return CRYPTO_ID_MAP[lower] || lower;
}

async function fetchCoinGecko(coinId) {
  const cacheKey = `coingecko:${coinId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Fetch current data + 90 days of history in parallel
  const [coinData, chartData] = await Promise.all([
    fetchJSON(
      `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`
    ),
    fetchJSON(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=90&interval=daily`
    ),
  ]);

  const market = coinData.market_data;
  const history = chartData.prices.map((p) => p[1]);

  const current = market.current_price.usd;
  const prevClose = history.length >= 2 ? history[history.length - 2] : current;
  const weekAgo = history.length >= 8 ? history[history.length - 8] : history[0];
  const monthAgo = history.length >= 31 ? history[history.length - 31] : history[0];

  const output = {
    symbol: coinData.symbol.toUpperCase(),
    name: coinData.name,
    currency: "USD",
    price: current,
    change: current - prevClose,
    changePct: ((current - prevClose) / prevClose) * 100,
    weekChange: ((current - weekAgo) / weekAgo) * 100,
    monthChange: ((current - monthAgo) / monthAgo) * 100,
    high52w: market.ath?.usd || Math.max(...history),
    low52w: market.atl?.usd || Math.min(...history),
    volume: market.total_volume?.usd || 0,
    marketCap: market.market_cap?.usd || null,
    history,
    source: "coingecko",
    extra: {
      rank: coinData.market_cap_rank,
      ath: market.ath?.usd,
      ath_change_pct: market.ath_change_percentage?.usd,
      circulating_supply: market.circulating_supply,
      total_supply: market.total_supply,
    },
  };

  setCache(cacheKey, output);
  return output;
}

async function searchCoinGecko(query) {
  const data = await fetchJSON(
    `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`
  );
  return (data.coins || []).slice(0, 5).map((c) => ({
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    rank: c.market_cap_rank,
    thumb: c.thumb,
  }));
}

// ─── News / Sentiment (via Yahoo Finance) ────────────────

async function fetchNews(symbol, assetType) {
  const cacheKey = `news:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    // Yahoo Finance news endpoint
    const query = assetType === "crypto" ? `${symbol} cryptocurrency` : symbol;
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=8`;
    const data = await fetchJSON(url, {
      "User-Agent": "Mozilla/5.0 (compatible; TradingAgent/1.0)",
    });

    const articles = (data.news || []).map((n) => ({
      headline: n.title,
      source: n.publisher || "Unknown",
      url: n.link,
      timestamp: n.providerPublishTime
        ? new Date(n.providerPublishTime * 1000).toISOString()
        : null,
      // Basic sentiment heuristic (the AI agent will do deeper analysis)
      sentiment: estimateSentiment(n.title),
    }));

    setCache(cacheKey, articles);
    return articles;
  } catch (err) {
    console.error(`News fetch failed for ${symbol}:`, err.message);
    return [];
  }
}

function estimateSentiment(headline) {
  const lower = headline.toLowerCase();
  const bullWords = ["surge", "rally", "gain", "rise", "jump", "soar", "bullish", "upgrade",
    "beat", "record", "high", "growth", "profit", "strong", "boost", "outperform", "buy"];
  const bearWords = ["crash", "drop", "fall", "plunge", "decline", "bearish", "downgrade",
    "loss", "weak", "sell", "risk", "concern", "fear", "cut", "miss", "slump", "low"];

  const bullScore = bullWords.filter((w) => lower.includes(w)).length;
  const bearScore = bearWords.filter((w) => lower.includes(w)).length;

  if (bullScore > bearScore) return "bullish";
  if (bearScore > bullScore) return "bearish";
  return "neutral";
}

// ─── API Routes ──────────────────────────────────────────

// GET /api/market/:type/:symbol — fetch market data
app.get("/api/market/:type/:symbol", async (req, res) => {
  const { type, symbol } = req.params;

  try {
    let data;

    if (type === "crypto") {
      const coinId = resolveCryptoId(symbol);
      data = await fetchCoinGecko(coinId);
      data.type = "crypto";
    } else if (type === "forex") {
      const yahooSymbol = FOREX_MAP[symbol.toUpperCase()] || `${symbol.replace("/", "")}=X`;
      data = await fetchYahooQuote(yahooSymbol);
      data.type = "forex";
    } else {
      // Stocks
      data = await fetchYahooQuote(symbol.toUpperCase());
      data.type = "stocks";
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error(`Market data error [${type}/${symbol}]:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/news/:type/:symbol — fetch news
app.get("/api/news/:type/:symbol", async (req, res) => {
  const { type, symbol } = req.params;

  try {
    const articles = await fetchNews(symbol, type);
    res.json({ success: true, data: articles });
  } catch (err) {
    console.error(`News error [${symbol}]:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/search/:type?q=query — search for symbols
app.get("/api/search/:type", async (req, res) => {
  const { type } = req.params;
  const query = req.query.q;

  if (!query) return res.status(400).json({ success: false, error: "Missing ?q= parameter" });

  try {
    let results;
    if (type === "crypto") {
      results = await searchCoinGecko(query);
    } else {
      results = await fetchYahooSearch(query);
    }
    res.json({ success: true, data: results });
  } catch (err) {
    console.error(`Search error [${type}/${query}]:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), cacheSize: cache.size });
});

// ─── Start ───────────────────────────────────────────────

// SPA catch-all — serve index.html for non-API routes
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  }
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║          TRADE.AGENT — Backend           ║
║                                          ║
║   Running on http://localhost:${PORT}       ║
║                                          ║
║   Endpoints:                             ║
║   GET /api/market/:type/:symbol          ║
║   GET /api/news/:type/:symbol            ║
║   GET /api/search/:type?q=...            ║
║   GET /api/health                        ║
╚══════════════════════════════════════════╝
  `);
});
