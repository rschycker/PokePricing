/**
 * Pokemon Card Price Lookup
 * Express server that proxies the PokemonPriceTracker API (TCGplayer market
 * pricing) and serves a search UI. The API key stays server-side.
 *
 * Env vars:
 *   PPT_API_KEY  - PokemonPriceTracker API key (https://www.pokemonpricetracker.com/api-keys)
 *   PORT         - provided by Upsun / defaults to 3000 locally
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

// Pull condition prices out of an object whose keys may be condition names.
function extractConditions(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  let found = false;
  for (const code of CONDITIONS) {
    for (const alias of CONDITION_ALIASES[code]) {
      const key = Object.keys(obj).find((k) => k.toLowerCase().replace(/[\s_-]/g, '') === alias.replace(/[\s_-]/g, ''));
      if (key !== undefined) {
        const n = toNumber(obj[key]);
        if (n !== null) {
          out[code] = n;
          found = true;
        }
        break;
      }
    }
  }
  return found ? out : null;
}

/**
 * Normalize a raw card object from the API into a stable shape for the UI.
 * Defensive: the prices payload may be flat ({market, low, mid, high}),
 * condition-keyed, nested under `conditions`, or keyed by printing/variant
 * (normal / holofoil / reverseHolofoil).
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
    image: raw.image ?? raw.imageUrl ?? raw.images?.small ?? raw.images?.large ?? null,
    tcgPlayerUrl: raw.tcgPlayerId
      ? `https://www.tcgplayer.com/product/${raw.tcgPlayerId}`
      : null,
    lastUpdated: raw.lastPriceUpdate ?? raw.updatedAt ?? null,
    variants: [],
  };

  const conditionSources = [prices.conditions, prices.byCondition, prices];
  let conditions = null;
  for (const src of conditionSources) {
    conditions = extractConditions(src);
    if (conditions) break;
  }

  const flatMarket = toNumber(prices.market ?? prices.marketPrice ?? raw.marketPrice);
  const flatLow = toNumber(prices.low ?? prices.lowPrice ?? raw.lowPrice);

  // Detect printing/variant-keyed prices (normal, holofoil, reverseHolofoil, 1stEdition...)
  const variantKeys = Object.keys(prices).filter((k) =>
    /^(normal|holofoil|reverse|reverseholofoil|1st|first|unlimited)/i.test(k.replace(/[\s_-]/g, ''))
  );

  if (variantKeys.length > 0) {
    for (const vk of variantKeys) {
      const v = prices[vk];
      card.variants.push({
        printing: vk,
        market: toNumber(v),
        low: toNumber(v?.low),
        conditions: extractConditions(v?.conditions ?? v),
      });
    }
  }

  if (card.variants.length === 0) {
    card.variants.push({
      printing: raw.printing ?? 'Standard',
      market: flatMarket,
      low: flatLow,
      conditions,
    });
  }

  return card;
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
    const url = `${API_BASE}/cards?search=${encodeURIComponent(q)}&limit=12`;
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
