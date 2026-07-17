<<<<<<< HEAD
# PokePricing
=======
# PokePrice Lookup

Search Pokemon cards and see current TCGplayer market pricing by condition (Near Mint → Damaged). Node.js + Express, deployed on [Upsun](https://upsun.com), pricing from the [PokemonPriceTracker API](https://www.pokemonpricetracker.com/api-reference).

Note: TCGplayer no longer issues public API keys, so this app uses PokemonPriceTracker, which mirrors TCGplayer pricing daily.

## How it works

- `server.js` proxies `GET /api/search?q=<name>` to `https://www.pokemonpricetracker.com/api/v2/cards?search=...` — your API key never reaches the browser.
- Responses are cached in memory for 6 hours (upstream prices update daily; free tier = 100 credits/day).
- `public/index.html` is the search UI.
- **Demo mode:** without `PPT_API_KEY` set, the app serves sample data so you can test the UI.
- The price normalizer in `server.js` handles several possible response shapes (flat market price, condition-keyed, or per-printing). After adding your key, run one search and check the server logs/output — if condition rows show "—", inspect the raw API response and adjust `normalizeCard()` to match (it's one small function).

## Run locally

```bash
npm install
PPT_API_KEY=your_key npm start   # omit PPT_API_KEY for demo mode
# open http://localhost:3000
```

## Deploy to Upsun with your GitHub repo

### 1. Push this code to your repo

```bash
cd pokemon-price-lookup
git init && git add -A && git commit -m "Pokemon card price lookup app"
git remote add origin git@github.com:YOUR_USER/YOUR_REPO.git
git push -u origin main
```

### 2. Create the Upsun project

Via [Upsun Console](https://console.upsun.com): **Create project → Connect repository → GitHub**, authorize the Upsun GitHub App, and pick your repo. This sets up the integration automatically (pushes deploy, PRs get preview environments).

Or via CLI:

```bash
upsun project:create --title pokemon-price-lookup --region <region>
upsun integration:add --type github \
  --repository YOUR_USER/YOUR_REPO \
  --token <github-personal-access-token> \
  --base-url https://github.com
```

The GitHub token needs `repo` and `admin:repo_hook` scopes.

### 3. Set your API key (sensitive, not in git)

Get a free key at [pokemonpricetracker.com/api-keys](https://www.pokemonpricetracker.com/api-keys), then:

```bash
upsun variable:create env:PPT_API_KEY --value 'YOUR_KEY' --sensitive true --level project
upsun environment:redeploy
```

### 4. Open the site

```bash
upsun url
```

Every push to `main` now auto-deploys; every PR gets its own preview URL.
>>>>>>> 4650928 (Pokemon card price lookup app with Upsun config)
