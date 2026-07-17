/**
 * Pokemon Card Price Lookup
 * Express server that proxies the PokemonPriceTracker API (TCGplayer market
 * pricing) and serves a search UI. The API key stays server-side.
 *
 * Env vars:
 *   PPT_API_KEY  - PokemonPriceTracker API key (https://www.pokemonpricetracker.com/api-keys)
 *   PORT         - provided by Upsun / defaults to 3000 locally
 *
 * Condition prices come from PokemonPriceTracker's prices.variants, which
 * mirror TCGplayer's per-condition market prices (derived from recent sales).
 * Conditions with no recent sales/listings have no price and render as "—".
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PPT_API_KEY || '';
const API_BASE = 'https://www.pokemonpricetracker.com/api/v2';

// Prices update daily upstream, so cache aggressively to conserve API credits
// (free tier = 100 credits/day).
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  cache.delete(key);
  return null;
}

function cacheSet(key, value) {
  if (cache.size > 500) cache.clear(); // crude memory cap
  cache.set(key, { at: Date.now(), value });
}

/* ----------------------------- Normalization ----------------------------- */

// Canonical condition order used by TCGplayer.
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DM'];
const CONDITION_ALIASES = {
  NM: ['nm', 'near_mint', 'nearmint', 'near mint'],
  LP: ['lp', 'lightly_played', 'lightlyplayed', 'lightly played'],
  MP: ['mp', 'moderately_played', 'moderatelyplayed', 'moderately played'],
  HP: ['hp', 'heavily_played', 'heavilyplayed', 'heavily played'],
  DM: ['dm', 'dmg', 'damaged'],
};

function toNumber(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  if (v && typeof v === 'object') {
    // e.g. { market: 12.5, low: 10, ... } or { price: 12.5 }
    return toNumber(v.market ?? v.marketPrice ?? v.price ?? v.mid ?? v.value);
  }
  return null;
}

// Map a condition label like "Near Mint Holofoil" or "lightly_played" to a
// canonical code. Matches by prefix so printing suffixes are ignored.
function conditionCode(label) {
  const norm = String(label).toLowerCase().replace(/[\s_-]/g, '');
  for (const code of CONDITIONS) {
    if (CONDITION_ALIASES[code].some((a) => norm.startsWith(a.replace(/[\s_-]/g, '')))) {
      return code;
    }
  }
  return null;
}

// Pull condition prices out of an object whose keys are condition labels,
// e.g. { "Near Mint Holofoil": { price: 20.77 }, "Lightly Played Holofoil": {...} }
function extractConditions(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  let found = false;
  for (const [key, val] of Object.entries(obj)) {
    const code = conditionCode(key);
    if (!code) continue;
    const n = toNumber(val);
    if (n !== null && out[code] === undefined) {
      out[code] = n;
      found = true;
    }
  }
  return found ? out : null;
}

/**
 * Normalize a raw card object from the API into a stable shape for the UI.
 *
 * Live /api/v2/cards shape (verified 2026-07):
 *   prices: {
 *     market, low, sellers, primaryPrinting, lastUpdated,
 *     variants: { "<Printing>": { "<Condition> <Printing>": { price, ... }, ... } }
 *   }
 *   variants: { "<Printing>": { printing, marketPrice, lowPrice, conditionUsed } }
 *   imageCdnUrl400 / imageUrl, tcgPlayerUrl, printingsAvailable
 */
function normalizeCard(raw) {
  const prices = raw.prices || raw.price || {};

  const card = {
    id: raw.tcgPlayerId ?? raw.id ?? null,
    name: raw.name ?? 'Unknown card',
    set: raw.setName ?? raw.set ?? '',
    number: raw.cardNumber ?? raw.number ?? '',
    totalSetNumber: raw.totalSetNumber ?? null,
    rarity: raw.rarity ?? '',
    image: raw.imageCdnUrl400 ?? raw.imageUrl ?? raw.image ?? raw.images?.small ?? raw.images?.large ?? null,
    tcgPlayerUrl: raw.tcgPlayerUrl ?? (raw.tcgPlayerId
      ? `https://www.tcgplayer.com/product/${raw.tcgPlayerId}`
      : null),
    lastUpdated: prices.lastUpdated ?? raw.lastPriceUpdate ?? raw.updatedAt ?? null,
    variants: [],
  };

  const flatMarket = toNumber(prices.market ?? prices.marketPrice ?? raw.marketPrice);
  const flatLow = toNumber(prices.low ?? prices.lowPrice ?? raw.lowPrice);

  // Primary shape: prices.variants keyed by printing, each holding
  // condition-labeled price objects. raw.variants carries per-printing
  // market/low summary.
  const priceVariants = prices.variants && typeof prices.variants === 'object' ? prices.variants : {};
  const summaryVariants = raw.variants && typeof raw.variants === 'object' ? raw.variants : {};
  const printings = [...new Set([...Object.keys(priceVariants), ...Object.keys(summaryVariants)])];

  for (const printing of printings) {
    const live = extractConditions(priceVariants[printing]);
    const summary = summaryVariants[printing] || {};
    const isPrimary = printing === prices.primaryPrinting;
    const market = toNumber(summary.marketPrice) ?? (isPrimary ? flatMarket : null) ?? live?.NM ?? null;
    card.variants.push({
      printing,
      market,
      low: toNumber(summary.lowPrice) ?? (isPrimary ? flatLow : null),
      conditions: live,
    });
  }

  // Fallbacks for older/other shapes: condition keys directly on prices
  // or a flat market price only.
  if (card.variants.length === 0) {
    card.variants.push({
      printing: prices.primaryPrinting ?? raw.printing ?? 'Standard',
      market: flatMarket,
      low: flatLow,
      conditions: extractConditions(prices.conditions ?? prices.byCondition ?? prices),
    });
  }

  card.history = parseHistory(raw);
  card.graded = parseGraded(raw);

  return card;
}

/* ----------------------- History & graded-sale parsing --------------------- */

function toMillis(v) {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  return 0;
}

// Compute 7/30-day % change from a price history payload (shape-tolerant).
function parseHistory(raw) {
  const h = raw.priceHistory ?? raw.history ?? null;
  let points = Array.isArray(h) ? h
    : Array.isArray(h?.data) ? h.data
    : Array.isArray(h?.points) ? h.points
    : Array.isArray(h?.prices) ? h.prices
    : null;
  // PPT live shape: { conditions: { "Near Mint": { history: [{date, market, volume}] }, ... } }
  // Use Near Mint history for the trend; fall back to the first condition present.
  if (!points && h?.conditions && typeof h.conditions === 'object') {
    const keys = Object.keys(h.conditions);
    const nmKey = keys.find((k) => conditionCode(k) === 'NM') ?? keys[0];
    points = h.conditions[nmKey]?.history;
  }
  if (!points || points.length < 2) return null;

  const norm = points
    .map((pt) => ({
      t: toMillis(pt.date ?? pt.t ?? pt.timestamp ?? pt.day),
      p: toNumber(pt.price ?? pt.p ?? pt.market ?? pt.marketPrice ?? pt.value),
    }))
    .filter((x) => x.p !== null && x.t > 0)
    .sort((a, b) => a.t - b.t);
  if (norm.length < 2) return null;

  const latest = norm[norm.length - 1];
  const changeOver = (days) => {
    const cutoff = latest.t - days * 86400000;
    const past = norm.find((x) => x.t >= cutoff) ?? norm[0];
    if (!past || past.p === 0 || past.t === latest.t) return null;
    return Math.round(((latest.p - past.p) / past.p) * 1000) / 10;
  };
  return { change7d: changeOver(7), change30d: changeOver(30), dataPoints: norm.length };
}

// Extract graded eBay sales data, grouped by grading company and grade.
// Live shape: ebay.salesByGrade = { psa10: {count, averagePrice, medianPrice,
// marketPrice7Day, marketTrend, lastSaleDate, smartMarketPrice: {price}, ...} }
// Individual sold listings, when present, are picked up from any array field.
function parseGraded(raw) {
  const e = raw.ebay ?? raw.ebayData ?? null;
  if (!e || typeof e !== 'object') return null;
  const src = e.salesByGrade ?? e.grades ?? e.graded ?? e;
  if (!src || typeof src !== 'object') return null;

  const gradeKey = /^(psa|cgc|bgs|sgc|tag)[\s_-]?(\d+(?:[._]\d)?)$/i;
  const companies = {};

  for (const [k, v] of Object.entries(src)) {
    const m = k.match(gradeKey);
    if (!m || !v || typeof v !== 'object') continue;
    const company = m[1].toUpperCase();
    const grade = m[2].replace('_', '.');

    // Any array of per-sale records, whatever it's called.
    const salesArr = [v.recentSales, v.sales, v.soldListings, v.listings, v.salesHistory, v.recentSoldListings]
      .find(Array.isArray) ?? null;
    const recentSales = salesArr
      ? salesArr
          .map((s) => ({
            date: s.date ?? s.soldDate ?? s.endDate ?? s.saleDate ?? null,
            price: toNumber(s.price ?? s.soldPrice ?? s.totalPrice ?? s.amount ?? s),
            title: s.title ?? null,
            url: s.url ?? s.link ?? s.itemUrl ?? s.ebayUrl ?? null,
          }))
          .filter((s) => s.price !== null)
          .sort((a, b) => toMillis(b.date) - toMillis(a.date))
          .slice(0, 10)
      : null;

    (companies[company] ??= {})[grade] = {
      price: toNumber(v.smartMarketPrice) ?? toNumber(v.marketPrice7Day) ?? toNumber(v.averagePrice) ?? toNumber(v.medianPrice),
      average: toNumber(v.averagePrice),
      median: toNumber(v.medianPrice),
      market7d: toNumber(v.marketPrice7Day),
      count: v.count ?? v.salesCount ?? null,
      trend: v.marketTrend ?? null,
      lastSale: v.lastSaleDate ?? null,
      recentSales,
    };
  }

  return Object.keys(companies).length ? companies : null;
}

/* -------------------------------- Demo data ------------------------------- */
// Used when PPT_API_KEY is not set, so the app is testable end-to-end.

const DEMO_CARDS = [
  {
    tcgPlayerId: '88098',
    name: 'Charizard (Demo Data)',
    setName: 'Base Set',
    cardNumber: '4',
    totalSetNumber: '102',
    rarity: 'Holo Rare',
    printing: 'Holofoil (Unlimited)',
    prices: { market: 425.0, low: 300.0, conditions: { near_mint: 425.0, lightly_played: 340.11, moderately_played: 262.5, heavily_played: 191.25, damaged: 127.5 } },
    priceHistory: [
      { date: new Date(Date.now() - 30 * 86400000).toISOString(), price: 401.5 },
      { date: new Date(Date.now() - 7 * 86400000).toISOString(), price: 418.0 },
      { date: new Date().toISOString(), price: 425.0 },
    ],
    ebay: {
      salesByGrade: {
        psa10: {
          count: 408, averagePrice: 1450.0, medianPrice: 1500.0, marketPrice7Day: 1475.0, marketTrend: 'up', lastSaleDate: new Date().toISOString(),
          smartMarketPrice: { price: 1462.5 },
          recentSales: Array.from({ length: 10 }, (_, i) => ({
            date: new Date(Date.now() - i * 2 * 86400000).toISOString(),
            price: Math.round((1500 - i * 12.5) * 100) / 100,
            title: `Charizard Base Set PSA 10 (demo sale ${i + 1})`,
          })),
        },
        psa9: { count: 544, averagePrice: 620.0, medianPrice: 615.0, marketPrice7Day: 628.0, marketTrend: 'down', smartMarketPrice: { price: 622.0 } },
        bgs9: { count: 33, averagePrice: 540.0, medianPrice: 535.0, marketPrice7Day: null, smartMarketPrice: null },
        cgc10: { count: 57, averagePrice: 890.0, medianPrice: 900.0, marketPrice7Day: 905.0, smartMarketPrice: { price: 898.0 } },
      },
    },
    lastPriceUpdate: new Date().toISOString(),
  },
  {
    tcgPlayerId: '477013',
    name: 'Charizard ex (Demo Data)',
    setName: 'Obsidian Flames',
    cardNumber: '125',
    totalSetNumber: '197',
    rarity: 'Double Rare',
    printing: 'Holofoil',
    prices: { market: 24.5, low: 19.99, conditions: { near_mint: 24.5, lightly_played: 21.32, moderately_played: 17.15, heavily_played: 12.25, damaged: 7.35 } },
    lastPriceUpdate: new Date().toISOString(),
  },
  {
    tcgPlayerId: '42346',
    name: 'Pikachu (Demo Data)',
    setName: 'Jungle',
    cardNumber: '60',
    totalSetNumber: '64',
    rarity: 'Common',
    printing: 'Normal',
    prices: { market: 3.2, low: 1.5, conditions: { near_mint: 3.2, lightly_played: 2.56, moderately_played: 1.92, heavily_played: 1.28, damaged: 0.8 } },
    lastPriceUpdate: new Date().toISOString(),
  },
];

/* --------------------------------- Routes -------------------------------- */

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, demoMode: !API_KEY });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) {
    return res.status(400).json({ error: 'Enter at least 2 characters.' });
  }

  // Demo mode: no API key configured.
  if (!API_KEY) {
    const results = DEMO_CARDS.filter((c) =>
      c.name.toLowerCase().includes(q.toLowerCase())
    ).map(normalizeCard);
    return res.json({
      demoMode: true,
      note: 'PPT_API_KEY is not set — showing sample data. Add your PokemonPriceTracker API key to get live TCGplayer prices.',
      results: results.length ? results : DEMO_CARDS.map(normalizeCard),
    });
  }

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    // includeHistory/includeEbay require the paid API plan (3 credits per card).
    const url = `${API_BASE}/cards?search=${encodeURIComponent(q)}&limit=12&includeHistory=true&includeEbay=true&days=30`;
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (upstream.status === 429) {
      return res.status(429).json({ error: 'Rate limit reached on the pricing API. Try again in a minute (free tier: 100 credits/day).' });
    }
    if (upstream.status === 401) {
      return res.status(502).json({ error: 'Pricing API rejected the API key. Check PPT_API_KEY.' });
    }
    if (!upstream.ok) {
      return res.status(502).json({ error: `Pricing API error (HTTP ${upstream.status}).` });
    }

    const body = await upstream.json();
    const rawCards = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
    const payload = {
      demoMode: false,
      results: rawCards.map(normalizeCard),
      creditsRemaining: upstream.headers.get('X-RateLimit-Daily-Remaining'),
    };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('Search failed:', err);
    res.status(502).json({ error: 'Could not reach the pricing API.' });
  }
});

app.listen(PORT, () => {
  console.log(`Pokemon price lookup listening on port ${PORT}${API_KEY ? '' : ' (DEMO MODE — set PPT_API_KEY for live prices)'}`);
});
