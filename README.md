# Price Check Tool

Compare swap quotes across **19 sources** — aggregators, DEX routers, RFQ market
makers, solver networks and a direct on-chain pool read — on one pair, side by
side, across **44 chains** (EVM, Solana, Sui, Aptos, NEAR, Starknet, Stellar).

Zero runtime dependencies. TypeScript + Bun, vanilla HTML/CSS/JS frontend.
Only devDependency is `@types/bun`.

```bash
bun install
bun run dev          # → http://localhost:3000
```

Static site, no backend: `bun run build` emits `public/app.js` and the page
calls every source directly from the browser. See
[Deploying to Vercel](#deploying-to-vercel).

It started as an OpenOcean v4 playground, which is why the OpenOcean client is
still the most thoroughly documented part below — the `/quote` vs `/swap`
sections are about that one API, while
[Comparing aggregators](#comparing-aggregators) covers all 19.

The UI follows your OS appearance — dark is the default, light is a full re-map.
There's no in-app toggle; switch it in System Settings › Appearance (macOS) and
the page updates on reload. (To force one, override the `:root` tokens in
`public/index.html` and delete the `prefers-color-scheme` block.)

---

## Which route should you use?

This is the question the OpenOcean client is built to answer. There are two endpoints
that both compute a route, and picking the wrong one is the usual first stumble.

| | `GET /v4/{chain}/quote` | `GET /v4/{chain}/swap` |
|---|---|---|
| Needs a wallet? | **No** | **Yes** (`account`) |
| Returns calldata? | No | Yes — `to`, `data`, `value`, `gasPrice` |
| Returns `dexes[]` comparison? | **Yes** | No |
| Cost | Cheap | Heavier (simulates + builds tx) |
| Use it for | Price display, refreshing, venue comparison | The actual swap the user signs |

**The rule:** poll `quote` while the user types or a price ticker refreshes.
Call `swap` once, at the moment they click Swap, and sign exactly what it returns.

Both recompute the route server-side, so `swap`'s `outAmount` can drift slightly
from a `quote` taken seconds earlier. **Always display the number from the
`swap` response** in the final confirmation — not the older quote — or your UI
will show a figure that differs from what the user actually receives.

`swap_quote` is the **v3** name for this endpoint. In v4 it is just `swap`.
Ported v3 code is the most common source of confusion here.

### Full flow

```
tokenList  →  gasPrice  →  allowance  →  [approve tx]  →  quote  →  swap  →  sign & send
             (feed into            (skip for native coin)   (display)  (execute)
              quote/swap)
```

`allowance` and `approve` apply only to ERC-20 inputs. Swapping the native coin
(BNB/ETH) needs no approval — use the sentinel address
`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.

---

## The amount gotcha

The one that costs the most debugging time:

- **Request** `amount` is **human-readable**. 1.5 USDC → `amount=1.5`, *not* `1500000`.
- **Response** `inAmount`/`outAmount` are **base units**. 1.5 USDC comes back as `"1500000"`.

You scale on the way out but not on the way in. v3 took base units for both,
so ported code is typically off by a factor of 10^decimals. Use `toBaseUnits`
and `fromBaseUnits` in [src/openocean.ts](src/openocean.ts) rather than
hand-rolling it.

Also note `gasPrice` is in **GWEI**, not wei, and `slippage` is a percent
where `1` means 1%.

Heads-up for later: OpenOcean's newer docs mention `amount`/`gasPrice` being
superseded by `amountDecimals`/`gasPriceDecimals` (which take base units, ending
the asymmetry above). `amount`/`gasPrice` still work today — everything here is
verified against them — but if a future response looks off by 10^decimals,
that migration is the first thing to check.

---

## Reading the route

The `path` object is nested because OpenOcean splits one order across venues
*in parallel*, and each parallel leg can itself be a *sequence* of hops:

```
path
 └─ routes[]        parallel splits of the input   (percentage each)
     └─ subRoutes[] sequential hops for that split (A→B, then B→C)
         └─ dexes[] venues serving that one hop    (split again)
```

[src/routes.ts](src/routes.ts) flattens this: `flattenPath`, `dexesUsed`,
`isSplitRoute`, `routingAdvantage` (aggregated output vs. the best single
venue), and `formatRouteTree`. The server attaches all of it as `_analysis` on
every quote/swap response, and the UI renders it as split bars.

An absent `path` is normal — it usually means a direct single-pool swap.

---

## Chains and tokens

Both are discovered rather than hardcoded, so you can explore anything the API
actually supports.

**Chains (42).** There is no chain-list endpoint — every plausible path 404s,
and OpenOcean's own app hardcodes its list. So [src/chains.ts](src/chains.ts) is
a static table, but one built by probing `/v4/{code}/tokenList` for every
candidate code; all 42 returned a live list. `bun run chains` prints them.
Chains are keyed by **string code** in the URL (`eth`, `bsc`, `polygon_zkevm`),
never numeric chain id. Includes non-EVM: Solana, Sui, Aptos, NEAR.

**Tokens.** Pulled live from `/tokenList` per chain, cached 10 min server-side,
and exposed at `/api/tokens?chain=X`. The frontend gives you a searchable
dropdown (symbol, name, or address) with icons, live USD prices, and
native/hot badges. `quote` and `swap` accept a symbol *or* an address — the
server resolves it against the live list.

Two quirks [src/tokens.ts](src/tokens.ts) handles, both found by inspecting real
responses:

- **Native coin missing.** `polygon`, `avax` and every non-EVM chain omit their
  native coin from `tokenList`, even though the sentinel address swaps fine
  (verified: POL→USDC and AVAX→USDC both quote). A synthetic entry is injected
  so the gas coin stays selectable.
- **Sentinel squatters.** On `eth`, *four* tokens hold an address that
  lowercases to the native sentinel — ELK, ETH, ASKO, ETHV. Only the
  exact-case `0xEeeeeEee…EEeE` one is really ETH. Match case-insensitively and
  take the first hit and you get **ELK** instead of ETH. The squatters are kept
  as ordinary tokens; only the native slot is de-duped.

Solana uses `So1111…1112` for native, not the EVM sentinel.

**tokenList is a display list, not a whitelist.** OpenOcean quotes *any* token
with routable liquidity — the list is only what their UI chooses to show. Proven
empirically, since the docs never state it either way:

| Token | In its chain's `tokenList`? | `/quote` | `/swap` calldata |
|---|---|---|---|
| OHM (eth) | **no** | ✅ 1 OHM → 18.09 USDC via UniswapV3 | ✅ 3850-char calldata |
| HOOK (bsc) | **no** | ✅ routed across 4 venues | — |

The API reads `symbol` and `decimals` straight from the contract: OHM came back
with its non-standard **9** decimals, which no local list supplied. So the real
constraint is *routable liquidity*, not membership.

Two consequences here:

- `/api/quote` and `/api/swap` pass any unrecognised `0x…` address straight
  through, and only reject unknown *symbols* (which are genuinely unresolvable).
- The token picker offers a pasted address as an **unlisted** entry, so the UI
  isn't more restrictive than the API it demonstrates.

A failed quote on a valid-looking address means no route, not a rejected token —
an address that isn't a contract at all returns the same generic
`code: 500 "Quote api error"` as a real token with no liquidity, so check the
contract exists before assuming the token is unsupported.

**Chain icons resolve in three tiers**, in [src/tokens.ts](src/tokens.ts):

1. a built-in inline mark from [src/chain-marks.ts](src/chain-marks.ts) (15 of them);
2. otherwise **DefiLlama by chain slug** —
   `icons.llamao.fi/icons/chains/rsz_{slug}.jpg`, keyless;
3. otherwise the chain's native/wrapped token icon from OpenOcean's list.

Tier 2 was added after tier 3 and the symbol fallback both failed for a cluster
of newer chains. Keying by **ticker** doesn't work for them — `mon`, `xdai`,
`plume`, `tac` and `g` all return a 404 HTML page on CoinCap, not an image —
whereas DefiLlama keys by *chain*, which is the right shape, and covers 42/44.
Its slugs are not our codes (`xdai`→`gnosis`, `hyperevm`→`hyperliquid`,
`okex`→`okexchain`) and two contain a space (`zksync era`, `polygon zkevm`), so
the slug is URL-encoded.

**Gravity** is the one chain with no icon anywhere — no DefiLlama entry, and its
`G` ticker is too short to be unique on any symbol CDN — so it gets an inline
mark. Result: 44/44 chains render an icon, verified in-browser with no scrolling.

**Token icons resolve in three tiers** too:

1. the `icon` URL from OpenOcean's `tokenList`, when there is one;
2. otherwise **CoinCap by symbol** — `assets.coincap.io/assets/icons/{sym}@2x.png`,
   a plain keyless URL with no API call and nothing to rate-limit;
3. otherwise the letter circle.

Tier 2 exists because seeded chains (Stellar, Starknet) have no OpenOcean token
list at all, so *every* token showed initials. Verified in-browser: XLM, USDC,
XRP, BTC, ETH, PYUSD, SUI, APT, NEAR, STRK, USDT, WBTC all load; AQUA, EURC,
SHX and yXLM don't exist there and are listed in `NO_SYMBOL_ICON` so we skip a
request we know will 404.

Guessing by symbol is safe *because* the fallback is graceful — a miss 404s, the
`onerror` handler swaps in the letter circle, and you're back to the previous
behaviour. CoinGecko was the alternative, but it needs a per-coin API lookup and
throttles hard without a key; this needs neither.

**Don't lazy-load the picker icons.** They were `loading="lazy"`, which looked
harmless but broke: both pickers are ~292px scroll containers holding 44 chains
or 80+ tokens, and rows below the fold never loaded — so chains near the end of
the list (Gravity, TAC, Sui, Aptos, NEAR) permanently showed letter initials as
if they had no icon. Scrolling a *nested* scroller doesn't reliably trigger the
load either. At 21px, and with most marks being inline data URIs, eager loading
costs nothing worth optimising. Verified: 44/44 chains and 80/80 tokens load
with no scrolling.

**Chain icons.** The API has no chain-logo field, and OpenOcean's own app uses
hashed build assets (`/img/sonic.2305224a.svg`) that break on their next deploy.
So logos resolve in two tiers, served from `/api/chainIcons`:

1. [src/chain-marks.ts](src/chain-marks.ts) holds inline-SVG brand marks for 14
   chains, added for two different reasons. Twelve are chains the token list
   *cannot distinguish*. Every ETH-native L2 resolves to
   its own local WETH token — distinct URLs, but all the generic ETH diamond — so
   Base, Arbitrum, Optimism, Linea, Scroll, zkSync, Blast, Mode, Manta, Aurora
   and Polygon zkEVM would otherwise render as eleven identical rows. Data URIs,
   so there's no CDN to rot and nothing to rate-limit.

   **Starknet and Stellar** are there for the opposite reason: not ambiguous but
   *absent*. OpenOcean serves neither chain, so the token-list tier below has
   nothing at all to derive a logo from and they fell through to letter
   initials. Any future chain added for a non-OpenOcean aggregator will need a
   mark here for the same reason.
2. The other 30 come from the token list: a chain's native coin and its wrapped
   twin share a logo (the Polygon mark *is* the wPOL icon). Native first, then
   wrapped — 26 of 42 chains have no icon on the bare native entry, so that
   fallback is what lifts token-derived coverage from 16/42 to 42/42.

The picker renders letter initials immediately and upgrades to icons when the
lookup lands, so a cold cache never blocks first paint.

Tokens are sorted native → hot (the API's `hot` flag marks ~20 popular tokens
per chain) → USD price → alphabetical, which keeps the useful entries at the top
of a 659-entry list without a separate liquidity feed.

## CLI

```bash
bun run quote  -- --chain bsc --in BNB --out USDT --amount 1
bun run swap   -- --chain bsc --in BNB --out USDT --amount 1 --account 0xYourAddress
bun run tokens -- --chain eth --filter USD --limit 50
bun run chains
bun run gas    -- --chain bsc
```

Token args take any symbol or address from the chain's live list; an unknown
symbol suggests near-matches.

---

## Layout

```
src/openocean.ts  API client + decimal helpers (the amount rules live here)
src/routes.ts     route flattening & analysis
src/types.ts      response types
src/chains.ts     42 chain codes (probe-verified)
src/chain-marks.ts inline SVG brand marks for look-alike chains
src/tokens.ts     live token lists, normalisation, icons, symbol resolution
src/browser.ts    browser entrypoint, bundled to public/app.js
src/quotes/       multi-aggregator comparison (types, adapters, runner)
static.ts         local dev server (static files + dev-only proxy)
src/cli.ts        terminal client
public/index.html frontend (single file, no build)
```

The frontend calls OpenOcean **directly from the browser** — CORS is fine and the
browser's own `Referer` satisfies the WAF. The UI still shows the exact upstream
URL for every call, rebuilt client-side. Local dev proxies `/quote` and `/swap`
only, because a `localhost` Referer is rejected; see
[Deploying to Vercel](#deploying-to-vercel).

---

## Shareable links

Every input is in the query string, so a link reproduces exactly what you're
looking at:

```
?chain=eth&from=ETH&to=USDC&amount=2.5&slippage=0.5&gas=7&account=0x…
```

Cross-chain adds `toChain`; everything else is identical:

```
?chain=eth&toChain=solana&from=ETH&to=USDC&amount=0.5
```

| Param | Notes |
|---|---|
| `chain` | **source** chain code (`eth`, `bsc`, `polygon_zkevm`, `stellar`) |
| `toChain` | destination chain — omit for a same-chain swap |
| `from` / `to` | **symbol or address** — `from=ETH` or `from=0x64aa…` |
| `amount`, `slippage`, `gas` | numbers; `slippage` is percent, `gas` gwei |
| `account` | optional, only used by `/swap` |

Design decisions worth knowing:

- **The URL reflects the UI; it is never a second source of truth.** Read once at
  boot, rewritten after any change. Writing during restore would race the async
  token load and persist half-applied state.
- **`replaceState`, not `pushState`** — sharing a link shouldn't fill the back
  button with one entry per keystroke.
- **Defaults are omitted.** A fresh page is `?chain=eth&from=ETH&to=USDC`, so a
  shared link shows only what you actually changed. `toChain` is written only
  when it differs from `chain`, so same-chain links are exactly as short as they
  were before cross-chain existed — and old links without it still work.
- **Symbols are preferred over addresses** for readability — except for an
  unlisted token, whose "symbol" is the placeholder `Custom token` and would
  resolve to nothing on reload, so those carry the address instead.
- **Bad input falls back rather than failing.** `?chain=notachain&from=NOPE`
  loads Ethereum with defaults; `amount=abc`, `slippage=-5` and `gas=0` are
  rejected (non-numeric or non-positive) so a truncated link can't forward
  garbage to 19 APIs. The URL then self-cleans.

Works identically on both deployments — the logic is bundled, not server-side.

---

## Cross-chain

Pick a different **To chain** and the same Compare button prices a bridge.
`ETH` on Ethereum → `USDC` on Solana is one comparison, not a different mode.

Three of the 19 sources bridge — **LI.FI**, **Relay** and **NEAR Intents**. The
other 16 report `Same-chain only — cannot bridge` as a neutral support gap, the
same treatment a chain they don't cover gets. Verified live in both directions
across VMs (EVM→SVM, SVM→EVM, EVM→Stellar).

### `chain` is an alias, not a third field

`QuoteRequest` carries `fromChain` and `toChain`, and keeps `chain` as a derived
alias for the source. That's deliberate: the 16 same-chain adapters and their
~70 `req.chain` references needed no edit, and same-chain is simply
`fromChain.code === toChain.code` rather than a flag that could disagree with
the chains. `compareQuotes()` accepts either shape and normalises.

The cross-chain gate runs *before* each adapter's own `supports()`, so a
non-bridging source never issues a request it cannot serve.

### Both token lists, both chains

Token lists are per-side (`TOKENS.in` / `TOKENS.out`), each with **its own
generation counter** — the two chains load concurrently and neither can
invalidate the other. That matters because the earlier single-list race is what
sent EVM addresses to a Stellar endpoint; here the two sides are structurally
incapable of sharing a list.

Flip swaps the two lists in memory rather than refetching, so reversing a
cross-chain pair is instant.

### The To chain follows the From chain — until you split them

Changing the source chain also moves the destination **only while the two were
in step**. So a same-chain switch stays one click, while a deliberate
cross-chain pair is never silently collapsed. Once they match again, `toChain`
drops back out of the URL.

### Two placeholder bugs this surfaced

Both only appear when the destination VM differs from the source, which is why
same-chain testing never caught them:

- **LI.FI** defaults `toAddress` to `fromAddress` when it's omitted, so an
  EVM→Solana quote failed with `Invalid toAddress: 0x00…01`. Now set explicitly
  per side, and a user-supplied account is only applied to the side whose VM
  actually matches it.
- **NEAR Intents** was sending the destination-format address as `refundTo`.
  A direct probe of `/v0/quote` settled which side it belongs to: on
  `eth → solana`, an EVM `refundTo` is accepted and a Solana one is rejected —
  so `refundTo` follows the **origin** and only `recipient` follows the
  destination. A comment in the file claimed both followed the destination; it
  was wrong, and is now corrected.

`/quote` and `/swap` are OpenOcean-only and single-chain, so they refuse a
cross-chain pair outright and point at Compare instead of quoting the source
chain and returning a price for a swap you didn't ask for.

---

## Comparing aggregators

**Compare all sources** fans one request out to every adapter and ranks the
answers. It exists because a single aggregator's quote is unfalsifiable — you
only learn whether a route is good by asking someone else.

| Source | Coverage | Notes |
|---|---|---|
| OpenOcean | 42 chains, EVM + Solana/Sui/Aptos/NEAR | executes |
| KyberSwap | 19 EVM chains | quote only here |
| ParaSwap | 11 EVM chains | quote only here |
| CoW Swap | 7 EVM chains | batch auction; output is **net of fee** |
| Bebop | 9 EVM chains | RFQ from market makers |
| Relay | EVM **+ Solana** (cross-chain router) | used same-chain |
| LI.FI | EVM **+ Solana** (meta-aggregator) | also bridges |
| NEAR Intents | 35 chains incl. BTC/XRP/ADA/DOGE/TON | 1Click API |
| Enso | 14 EVM chains | **API key** (public in bundle) |
| 0x | 13 EVM chains | **CLI only** — no CORS |
| Uniswap V3 | 5 EVM chains | **direct pool read**, not an aggregator |
| Sushi | 13 EVM chains | own router API |
| DODO | 12 EVM chains | own router; `useSource` often names another aggregator |
| Balancer | 8 EVM chains | GraphQL SOR, weighted pools |
| WOWMAX | 14 EVM chains **+ Stellar** | ported from their SDK, no dependency |
| Soroswap | Stellar | routes Soroswap/Phoenix/Aquarius/SDEX; API key |
| Jupiter | Solana | executes |
| AVNU | Starknet | hex amounts |
| Fibrous | Starknet | also Scroll/Base |

Eleven of the thirteen are **keyless and CORS-open from a browser**, verified
from the deployed origin. Enso needs a key but does send CORS headers, so it
works in the browser. 0x needs a key *and* sends no CORS headers, so it runs in
the CLI only. Excluded after testing, with the reason:

| Rejected | Why |
|---|---|
| Odos | CORS-blocked from the browser |
| Magpie, Rango | `403` Cloudflare challenge |
| Socket/Bungee | `401` — API key required |
| Squid | `x-integrator-id` header required |
| Firebird, Swing | host unreachable |
| Curve | pool data only, no quote endpoint |
| Velora | ParaSwap rebranded — same API, already covered |
| 1inch, OKX DEX | `401` — API key required, none supplied |
| Odos | CORS-blocked (`Failed to fetch`); its edge also 530s server-side |
| Titan, 7K, Omniston | host unreachable / timed out |
| DFlow | `403` |
| Ekubo | no public quote path found (404 on every candidate) |
| Cetus, DeDust, STON.fi | reachable, but pool/asset endpoints — not quote APIs |

Enso is the instructive one: server-side probing said yes, the browser said no.
Anything added here has to be checked from the *deployed origin*, not a terminal.

### Not EVM-locked

Chains are identified by our own `ChainInfo`, never by assuming a `0x` address or
a numeric chain id. Each adapter maps that to whatever its API wants — a path
slug (Kyber), a numeric `network` (ParaSwap), a mint address (Jupiter), a
felt252 hex address with **hex-encoded amounts** (AVNU).

Three ecosystems now compare, and adding one needed no change to the runner or
the UI:

```
1 WETH → USDC (Ethereum)     1 SOL → USDC (Solana)      1 ETH → USDC (Starknet)
★ KyberSwap 2449.400  best   ★ Jupiter    95.795  best   ★ Fibrous  2465.756  best
  ParaSwap  2449.400 -0.000%   OpenOcean  95.733 -0.065%   AVNU     2445.985 -0.802%
  OpenOcean 2449.379 -0.001%   – 8 others: not this chain  – 8 others: not this chain
  CoW Swap  2449.060 -0.014%
  Relay     2447.943 -0.059%
  LI.FI     2443.519 -0.240%
  Bebop     2424.956 -0.998%
```

**Starknet is the proof.** OpenOcean doesn't serve it at all, so it was added to
the registry purely for AVNU and Fibrous — and it reports
"Starknet not on OpenOcean v4" rather than failing. Chains OpenOcean's
`/tokenList` can't serve get a small seed list in `SEED_TOKENS` so the picker
still works.

### The chain-switch race (fixed)

Worth recording because it produced a bug report from an upstream team rather
than a visible error here.

`loadTokensFor()` had no guard against overlapping calls. Token lists range from
instant (5 seeded entries for Stellar) to ~660 fetched, so switching chains
quickly let a **slow load resolve after a newer one** and stamp its tokens over
the current chain. Reproduced deterministically: pick Polygon, wait 60ms, pick
Stellar → chain reads "Stellar" while the tokens are `POL` / `0xEeee…` and the
note says "97 tokens on polygon".

Every adapter then forwarded those EVM addresses. WOWMAX's Stellar endpoint got
`from=0xa0b8…` and returned a Cloudflare 502; their team added `invalid_asset`
handling for a request we should never have sent.

Two fixes, deliberately layered:

1. **A generation counter** in `loadTokensFor()` — each call takes a sequence
   number and does nothing if a newer switch has started. Fixes the cause.
2. **An address-shape check** in [src/quotes/run.ts](src/quotes/run.ts), applied
   once before the fan-out: an EVM `0x…` address on a non-EVM chain (or the
   reverse) is rejected with one clear message and **zero upstream requests**.
   A backstop, so any future state bug can't send malformed requests to 19 APIs.

### Stellar

Added as a chain (`stellar`), and it is unlike every other entry: assets are not
addresses at all. The native coin is the literal string **`native`**, everything
else is **`CODE:ISSUER`** (e.g.
`USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`), and all
balances use **7 decimals** (stroops). `nativeAddressFor()` and `SEED_TOKENS`
handle both; OpenOcean doesn't serve Stellar, so it declares itself unsupported.

Two Stellar aggregators exist. Only one is usable without registration:

- **WOWMAX** — works keyless and CORS-open. Verified: 100 XLM → 17.93 USDC.
- **Soroswap** — Stellar's main aggregator, routing Soroswap, Phoenix, Aquarius
  and the classic SDEX order book. Needs a free key from
  `api.soroswap.finance/login`; one is committed in
  [src/quotes/keys.ts](src/quotes/keys.ts) and **it is public** (see the API-key
  section — Soroswap is CORS-open, so the key ships in `app.js`). Override with
  `SOROSWAP_API_KEY` in `.env`, or restrict it by origin in their dashboard.

  Two things to know about its wire format: it answers **HTTP 201**, not 200,
  and it addresses assets by **Soroban contract id** (`C…`) rather than the
  `CODE:ISSUER` form the rest of Stellar uses. See below.

Measured: 100 XLM → 17.993 USDC from both, agreeing to 6 decimals.

#### Deriving Soroban contract ids

Soroswap rejects the classic `CODE:ISSUER` form outright (`Invalid Stellar
address`), so it needs a contract id. This was originally a hand-written table
of three assets, which meant **7 of the 10 seeded Stellar assets — and every
pasted one — failed** with "No Soroban contract id known for this asset" without
a request ever being made.

Its own `/api/tokens` can't fill the gap: the endpoint exists and returns 200,
but the **mainnet** asset list is empty (only testnet is populated).

The fix is that these ids aren't arbitrary. Every classic asset has a
deterministic Stellar Asset Contract address — `SHA-256` of an XDR preimage —
so [src/quotes/soroban.ts](src/quotes/soroban.ts) computes it for *any* asset
and the table is gone. StrKey is base32 + CRC16-XModem, short enough to
implement directly rather than add `@stellar/stellar-base` as a dependency.

The preimage is `ENVELOPE_TYPE_CONTRACT_ID · networkID ·
CONTRACT_ID_PREIMAGE_FROM_ASSET · asset`. The value worth calling out is
`ENVELOPE_TYPE_CONTRACT_ID = **8**` — my first attempt assumed 2 (which is
`ENVELOPE_TYPE_TX`) and produced well-formed, checksum-valid, entirely wrong
ids. That failure mode is why the implementation is pinned to three test
vectors whose ids were already known good:

| Asset | Contract id |
|---|---|
| `native` | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |
| `USDC:GA5ZSE…` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| `AQUA:GBNZIL…` | `CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK` |

Also note the code length picks the union arm: ≤4 chars is `ALPHANUM4`, longer
is `ALPHANUM12`, so 5-character codes like `PYUSD` take the 12-byte padding.

Verified against the live API after the change — XLM→USDC/EURC/AQUA/yXLM/XRP/
SHX/BTC/PYUSD all quote, where all but USDC previously refused. A pasted `C…`
id passes through unchanged, and malformed input is still rejected in
`supports()` before any request goes out.

#### Soroswap picks the wrong SDEX path on large trades

Not our bug, but worth knowing before trusting its number on a big order.

100,000 `USDC` → `PYUSD` returns **4.20** from Soroswap against **59,305** from
WOWMAX. The two agree to four decimals at 20,000 (19992.1555 vs 19992.1554), so
this is size-dependent, not a mapping error.

Querying Stellar Horizon's `strict-send` endpoint directly — no Soroswap in the
path — shows why:

| | destination_amount | hops |
|---|---|---|
| `record[0]` | 3,184.07 | 1 (via XLM) |
| `record[1]` | **4.1998** | 0 (direct) |

Soroswap returns `record[1]`. The **direct** USDC/PYUSD order book holds only
about 4 PYUSD of depth, so above ~20,000 it flatlines — 50k, 80k and 100k all
return ~4.199, an output that ignores the input size entirely. WOWMAX routes via
XLM and keeps scaling. Soroswap's `rawTrade` is Horizon's own response, which
confirms it is faithfully reporting the worse of the two paths rather than
mis-parsing anything.

Its `priceImpactPct` is unusable at these sizes too (2,381,986 for the 100k
quote), so the ranking ignores it.

The UI now names this rather than averaging it in: when the best and worst
quotes differ by 10x or more, `outlierWarning()` says "Soroswap returned 14,121x
less than WOWMAX" and **omits** the percentages, because "+99.993% over" and a
"1411967% spread" read like a bug in the tool. Below 10x, the normal spread is
shown as before.

### Source-kind tags

The comparison table tags **how** a price was obtained, which is orthogonal to
who provided it and changes how much the number means:

| Tag | Meaning |
|---|---|
| `onchain` | read straight from the contract via RPC — no third-party API in the path. Ground truth for that pool. Currently only **Uniswap V3**. |
| `intent` | a solver auction; the price is a *bid* that may not materialise (**CoW Swap**, **NEAR Intents**). |
| `RFQ` | a market maker's firm price, but only for that taker (**Bebop**). |
| *(no tag)* | a plain aggregator/router HTTP API — the default everything else is compared against. |

Set per adapter via `kind` on the returned quote, so a new source declares its
own nature rather than the UI hardcoding a list.

### WOWMAX without the dependency

Ported by hand from
[wowmax-sdk/src/index.ts](https://github.com/wowmax-exchange/wowmax-sdk/blob/main/src/index.ts)
to keep the project dependency-free. Only two things were needed: the base URL
`https://api-gateway.wowmax.exchange` and
`GET /chains/{chainId}/quote?from&to&amount`.

Two details worth keeping:

- **Stellar is chain id `100000148`** — a synthetic id WOWMAX invented, since
  Stellar has no EVM chain id. That's why the adapter maps chains through a
  table rather than using `chain.id`.
- **Same unit asymmetry as OpenOcean**, documented in their own SDK: the request
  `amount` is human-readable, but `amountOut` comes back in base units.

### Unit gotchas in the newer adapters

Three different conventions, all normalised inside the adapters:

| Source | `amount` in | output |
|---|---|---|
| Sushi | base units | `assumedAmountOut`, base units |
| DODO | base units | `resAmount`, **human-readable number** |
| Balancer | **human-readable** | `returnAmount`, **human-readable** |

DODO and Balancer both round-trip through `toBaseUnits` so the runner can rank
them against everyone else. Balancer also answers `"0"` rather than erroring
when no pool path exists, which would otherwise rank as a real (terrible) quote —
the adapter turns that into `no-route`.

### Uniswap V3 is the control, not a competitor

Every other source is an aggregator. Uniswap V3 is here as a **baseline**: the
raw single-pool price with no routing, which is what the aggregators should be
beating. It makes their value measurable instead of assumed.

Both Uniswap HTTP APIs are gated — `trade-api.gateway.uniswap.org` returns 401
and `api.uniswap.org/v1/quote` returns 409 `ACCESS_DENIED` — so this reads
**QuoterV2 on-chain** via `eth_call` on a public RPC. No key, and arguably more
honest than their API anyway. All fee tiers (0.01/0.05/0.3/1%) go out in one
batched JSON-RPC request and the best pool wins; the winning tier is shown as
the venue.

RPC note: `publicnode.com` and `drpc.org` send CORS headers; `llamarpc.com` and
`1rpc.io` do **not**, and `rpc.ankr.com` now requires auth. The adapter tries
its list in order.

What the baseline actually reveals:

| Trade | Uniswap V3 vs best aggregator |
|---|---|
| 1 ETH → USDC (eth) | **tied to 4 decimal places** — everyone routes to the same pool |
| 500 ETH → USDC | **no quote** — no single pool absorbs it; routing is doing real work |
| 1 POL → USDC (polygon) | −4.4% — routing genuinely wins |
| 100 LINK → DAI | no usable route (see below) |

**The thin-pool guard.** QuoterV2 will happily quote a near-empty pool rather
than reverting: 100 LINK → DAI came back as **1.3 DAI** from a dead 0.3% pool,
against ~1126 elsewhere. That's a real number, not a decimals bug — but showing
it as a quote would look like a 99% loss and be worse than useless. So the
adapter re-quotes at 1/1000th the size and, if the full trade moves the price
more than 90% off that marginal rate, reports no usable route instead.

### API keys in a static app

Two sources need keys, and a browser-only app cannot hide either. `app.js` is
public: anything in it is visible in DevTools and to anyone who fetches the file.

- **Enso** works from the browser, so its key is compiled into the bundle and
  is **public by necessity**. Fine for a local tool on a free tier; for anything
  metered, restrict the key by allowed origin in Enso's dashboard, or move the
  call behind a server route.
- **0x** sends no `access-control-allow-origin` header at all — its OPTIONS
  preflight 401s with no CORS headers — so the browser can *never* call it,
  whatever the key. Its key is therefore **not** in the bundle: it's read from
  `.env` (gitignored, auto-loaded by Bun) and used only by the CLI.

```bash
echo 'ZEROX_API_KEY=your-key' >> .env
bun run compare -- --chain eth --in ETH --out USDC --amount 1
```

Without it, 0x reports `Set ZEROX_API_KEY in .env to use 0x` rather than failing
silently. In the browser it always reports
`0x blocks browser requests (no CORS) — CLI only`.

Keeping the literal out of `keys.ts` is what actually removes it from the
bundle. A `--define` dead branch still left the string in the minified output —
verified — so absence is the only reliable method.

### Relay and LI.FI do support Solana

Both originally reported "needs non-EVM ids", which was a placeholder I wrote
rather than a limitation — and it was wrong. Both work; each needed one lookup:

- **LI.FI** uses chain id **`1151111081099710`** for Solana. `GET /v1/chains`
  returns EVM-only by default, which is what made it look unsupported —
  `?chainTypes=EVM,SVM` reveals it.
- **Relay** uses **`792703809`**, from `GET /chains` (each entry carries a
  `vmType`). It also lists Bitcoin, XRP, TON, Tron and Eclipse.

Two things had to be right beyond the chain id, or both 400:

- **`fromAddress`/`user` must match the chain's VM.** An EVM placeholder address
  on Solana is rejected, so a real Solana account stands in.
- **Relay's native coin is the chain's own zero-ish address**, not our sentinel
  and not the wrapped-SOL mint: on Solana it's `1111…1111` (32 ones, the System
  Program id).

Solana went from 2 quoting sources to 4:

```
★ Jupiter   97.843  best      Relay   97.787  -0.058%
  OpenOcean 97.789 -0.056%    LI.FI   97.603  -0.246%
```

Starknet and Stellar now say plainly "not covered" for these two, rather than
implying a mapping exists.

**Verified beyond SOL.** All four Solana sources quote arbitrary SPL pairs in
both directions, not just native-in:

| Pair | Quoting | Spread |
|---|---|---|
| USDC → USDT | 5 (incl. NEAR Intents) | 0.14% |
| JUP → USDC | 4 | 0.25% |
| USDC → JUP | 4 | 0.67% |
| TRUMP → USDC | 5 | 0.31% |
| MSOL → USDC | 4 | 0.21% |
| JITOSOL → SOL | 4 | 0.25% |
| BONK → USDC (10M) | 4 | 0.25% |

NEAR Intents sits out where its own registry lacks the token (JUP, MSOL, BONK),
which is a coverage gap rather than a mapping bug — its listed pairs quote.

**Dust amounts.** `1 BONK` (5 decimals, ~$0.00002) into 6-decimals USDC produces
an output of ~8 base units, and the table showed "-38%" and "-77%" differences
that were pure rounding. The same pair at 10M BONK spreads 0.25%. The verdict
now detects that (<10,000 base units of output) and says the percentages are
noise, instead of presenting quantisation as a ranking.



### NEAR Intents uses the 1Click API

Worth documenting because the obvious endpoint is the wrong one.

`solver-relay-v2.chaindefuser.com/rpc` has a `quote` method that looks right and
validates its params — but returns `result: null` for every pair, because it
expects a *signed intent published into a live auction*, not a read-only price
check. Everything reported "No solver bid on this intent", which looked like
thin liquidity and was actually the wrong API.

The right one is **1Click**:

- `GET https://1click.chaindefuser.com/v0/tokens` — 186 assets across 35 chains
- `POST https://1click.chaindefuser.com/v0/quote` with `dry: true` — a firm
  price with nothing committed and no deposit address issued

Mapping is by **address, not symbol**: each asset carries a `contractAddress`
matching the chain's real token address, and a **null `contractAddress` means
that chain's native coin**. Two exceptions found by testing:

- **NEAR** has no null-address entry — its native is listed as the wrapped
  `wNEAR` contract, so the resolver falls back to the `W`-prefixed symbol.
- **`recipient` is validated against the destination chain's address format**,
  so an EVM address on Solana fails with "recipient is not valid". Per-chain
  placeholder addresses are used; `dry: true` means nothing is ever sent to them.

**Stellar** needs two further rules, both found by testing:

- `depositMode` must be **`MEMO`**, not `SIMPLE` — Stellar deposits are keyed by
  transaction memo rather than a unique address, and 1Click rejects SIMPLE for a
  stellar origin outright (`Incorrect depositMode for originAsset from stellar
  chain`). Every other chain still uses `SIMPLE`.
- The **recipient must already hold a trustline** for the destination asset.
  That's a Stellar protocol rule, not a liquidity condition, so no placeholder
  can satisfy it for a non-native destination — the adapter reports "Recipient
  needs a Stellar trustline for this asset — set Account" rather than a phantom
  routing failure.

Its Stellar asset ids also don't follow the `contractAddress` convention above:
1Click stores only the bare **issuer** (and nothing for XLM), while our
addresses are `native` / `CODE:ISSUER`, so the resolver matches on the issuer
half. 1Click covers exactly XLM and USDC there.

Coverage is the widest of any source here — 35 chains including Bitcoin, XRP,
Cardano, Dogecoin, TON, Tron, Stellar, Aptos, Sui and Starknet. On NEAR it is
currently the **only** source that quotes at all.

### Timeouts

Four values, layered so the client is always the one that decides to give up:

| Where | Value |
|---|---|
| per-source, in the runner | **30s** |
| proxy → upstream fetch | 25s |
| Vercel function `maxDuration` | 30s |
| proxy health probe | 4s |

The per-source timeout was 12s, which cut off WOWMAX at ~15s on a request that
would have succeeded. Measured latency is normally **sub-second** (0.4–1.1s
across Stellar and EVM pairs), so a slow response means a cold start or
transient upstream slowness — the case worth waiting out.

Waiting is cheap here because the fan-out is parallel and rows stream as they
land: measured, the fastest source renders at ~190ms while the slowest finishes
at ~2.2s. One slow source delays only its own row. The cost of cutting early is
a missing quote that reads as a broken integration; the cost of waiting is a
single pending row.

The proxy's upstream fetch stays *below* the client timeout (25s < 30s) so the
client, not the proxy, owns the decision — and `maxDuration` stays above its own
fetch so the function isn't killed mid-request.

### Support gaps are not errors

The design rule that shapes the UI: a source that *can't* serve a pair must not
look broken. `supports()` is checked **before** any request, so an unsupported
combination costs no network time and renders as a greyed row with a plain
reason — "Solana is not EVM". Genuine failures get a red badge instead, and the
four kinds are distinguished:

- `unsupported` — adapter doesn't cover this chain (neutral)
- `no-route` — supported, but no liquidity path (neutral)
- `error` — HTTP/WAF/parse failure (red)
- `timeout` — no answer in 12s (red)

A transport error carrying a 403 is classified `error`, not `no-route`, so a
blocked request never masquerades as an illiquid pair.

Rows **stream** as each source answers, so one slow API never holds up the table.
Ranking compares human-scaled values, not raw base units, because sources
sometimes disagree on a token's decimals.

Measured examples:

```
1 ETH → USDC on Ethereum        10 SOL → USDC on Solana
★ ParaSwap   2450.157  best     ★ Jupiter    962.384  best
  OpenOcean  2450.105  -0.002%    OpenOcean  961.792  -0.062%
  KyberSwap  2450.067  -0.004%    – KyberSwap  [n/a] not EVM
  LI.FI      2444.215  -0.243%    – ParaSwap   [n/a] not EVM
```

From the terminal:

```bash
bun run compare -- --chain eth --in ETH --out USDC --amount 1
```

Caveats worth keeping in mind: quotes are indicative and move between blocks, so
re-running reshuffles near-ties. Gas and each source's own fees are **not**
deducted, so the ranking is gross output, not net. KyberSwap and ParaSwap are
quote-only here — both can execute, but each needs a second call to build
calldata that this tool doesn't make.

---

## Two deployments, one optional proxy

| | URL | Role |
|---|---|---|
| **Vercel** | `openocean-playground.vercel.app` | hosts `/api/proxy` **and** uses it |
| **GitHub Pages** | `bonnevoyager.github.io/price-check-tool/` | static; uses Vercel's proxy *if reachable* |

Two sources cannot be called from a browser at all, for different reasons:

- **OpenOcean** — its Cloudflare rule is an **origin allowlist**. `vercel.app`
  is on it; `github.io` and `localhost` are not, and no client-side header
  changes that.
- **0x** — `api.0x.org` sends no `access-control-allow-origin` whatsoever, so a
  browser fetch fails however valid the key.

[api/proxy.ts](api/proxy.ts) fixes both with a server-side hop: it sets the
`Referer` a browser may not set, holds the 0x key server-side, and returns CORS
headers so a cross-origin page can read the reply.

**Pages degrades gracefully by design.** [src/quotes/proxy.ts](src/quotes/proxy.ts)
probes the proxy once (4s timeout, cached 60s). If it answers, both sources
quote; if it doesn't, they report themselves unavailable and the other 18 quote
exactly as before. Verified both ways:

```
proxy up   → 11 sources quoting, including 0x (a first for the browser)
proxy down → 9 sources quoting; OpenOcean and 0x say "proxy unreachable"
```

So if the Vercel side ever disappears, Pages keeps working — no redeploy, no
code change.

### Security notes

The proxy is a **strict allowlist, not an open relay**: `target` selects from a
fixed table (`openocean`, `zerox`) and only named params are forwarded. Passing
an arbitrary URL is rejected — an open proxy on a public URL would be abused.

It also **improves** key handling: `ZEROX_API_KEY` now lives only in Vercel's
env vars, so it is no longer in the browser bundle at all (verified: 0
occurrences in both `public/app.js` and `dist/index.html`).

### Deploying it

The function needs one env var on Vercel:

```
ZEROX_API_KEY = <your 0x key>
```

Set it under **Settings → Environment Variables**. Without it the `zerox` target
returns a clear error and the source sits out; everything else is unaffected.

---

## Single file / GitHub Pages

```bash
bun run build:single      # → dist/index.html
```

One 94 KB file with the JS bundle inlined. No second request, no server, so it
works on GitHub Pages, any static host, or opened straight off disk.

A [workflow](.github/workflows/pages.yml) builds and publishes it on every push
to `main`. To turn it on: **Settings → Pages → Source: GitHub Actions**. Nothing
else to configure — no env vars, no base-path rewriting (every asset is inlined
or absolute).

Two things the inlining has to get right, or the page loads and silently does
nothing:

- **The `import` must go.** `public/index.html` does
  `import { OO } from "./app.js"` inside `<script type="module">`; there's no
  module to import from once the code is in the same file. The bundle already
  assigns `window.OO`, so the single-file build rewrites that line to read the
  global instead.
- **The bundle's trailing `export{…}` must go.** An `export` outside a module is
  a syntax error, and an inline classic `<script>` is not a module.

[build-single.ts](build-single.ts) does both and hard-fails if either pattern
stops matching, rather than emitting a page that looks fine and is dead.

This is also why the single-file build works from `file://` while the normal one
doesn't: `<script type="module">` obeys CORS, so a module import from a
`file://` page is blocked. An inline script isn't.

Verified over a plain static server: one request, `/app.js` 404s (nothing
external is needed), 44/44 chain icons load, and a full 19-source comparison
runs.

---

## Deploying to Vercel

**This is a static site — there is no server to run.** The page calls OpenOcean
directly from the browser, so Vercel just serves files from its CDN.

[vercel.json](vercel.json):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "bun run build",
  "outputDirectory": "public"
}
```

Import the repo at [vercel.com/new](https://vercel.com/new) and click Deploy —
leave **Application Preset** on `Other` and leave every build field blank
(`vercel.json` supplies them). Or:

```bash
bunx vercel --prod
```

`bun run build` bundles `src/browser.ts` into `public/app.js` (~10 KB) with
`bun build`, so the browser and the CLI share the exact same modules. No
environment variables — the OpenOcean API takes no key.

### Why there's no proxy any more

The original server existed on two assumptions, both of which turned out to be
false when tested against a real deployed origin:

- *"CORS blocks browser calls."* It doesn't. `open-api.openocean.finance`
  answers cross-origin requests with `200` and JSON.
- *"The WAF needs a `Referer` we can't set from JS."* We can't set it — it's a
  forbidden header — but we don't need to. The browser sends its own
  automatically, and that satisfies the gate.

Verified from `https://…vercel.app`: `quote`, `swap`, `tokenList` and `gasPrice`
all return 200 directly from page JS.

### The one local-dev wrinkle

Cloudflare accepts an `https://…vercel.app` Referer but **rejects
`http://localhost:3000`**. So in local dev the direct call to `/quote` and
`/swap` returns 403, while `tokenList`/`gasPrice` still work.

`bun run dev` therefore starts [static.ts](static.ts), which serves `public/`
*and* proxies just those two endpoints with the Referer set. The page tries
direct first and only falls back when it sees a 403, so production never uses
the fallback — and there's nothing to deploy for it.

| | Production (Vercel) | Local `bun run dev` |
|---|---|---|
| static files | Vercel CDN | `static.ts` |
| `tokenList`, `gasPrice` | direct from browser | direct from browser |
| `quote`, `swap` | direct from browser | via dev proxy (403 otherwise) |

### Caveat

The CLI (`bun run quote`, `tokens`, `chains`) is a local tool and doesn't
deploy. It sets the `Referer` explicitly, which is why it works from a terminal.

---

## OpenOcean's WAF is an origin allowlist

Follow-up to the Referer finding below, and it supersedes part of it. Cloudflare
in front of `/quote` and `/swap` doesn't just want *a* Referer — it allowlists
specific origins, and nothing sent from a browser can talk it round.

Measured from real deployed origins:

| Origin | `/quote` | `gasPrice`, `tokenList` |
|---|---|---|
| `openocean-playground.vercel.app` | **200** | 200 |
| `bonnevoyager.github.io` (https!) | **403** | 200 |
| `http://localhost` | **403** | 200 |
| `file://` | **403** | 200 |

So it is **not** an http-vs-https distinction — a plain GitHub Pages site over
https is blocked while a Vercel one is not. Also checked and ruled out: every
`referrerPolicy` (`no-referrer`, `origin`, `unsafe-url`) is 403 from a blocked
origin, and `v3/quote` and `v4/swap` are blocked identically. `gasPrice` and
`tokenList` stay open, which is why only *quoting* breaks and the token picker
keeps working.

**Consequence:** on GitHub Pages, OpenOcean sits out and the other 18 sources
quote normally. The adapter says
`OpenOcean's WAF blocks this origin (…) — needs a proxy or an allowlisted domain`
and is classified `no-route` (neutral grey), not a red error, because it's a
known limitation rather than a fault.

To get OpenOcean quoting on a static host you need a server-side hop — a Vercel
Function, or `bun run dev`, which already proxies `/quote` locally for this
reason.

---

## The Referer requirement (undocumented)

**`/quote` and `/swap` return HTTP 403 with a Cloudflare "Just a moment..." HTML
page unless the request carries a `Referer` header.** `/gasPrice` and
`/tokenList` are not guarded — which is what makes this so confusing: half your
integration works, and the half that fails does so with a JSON parse error
rather than an auth error.

Narrowed down empirically:

| Request | Result |
|---|---|
| `/gasPrice`, `/tokenList` — no headers | 200 JSON |
| `/quote` — no headers | **403 HTML** |
| `/quote` — `Origin` only | **403 HTML** |
| `/quote` — `Referer` only | 200 JSON |

It is not IP reputation (the same machine gets 200 on `gasPrice`), not the query
string (`/quote` with zero params still 403s), not the path name, and not the API
version (v3 `swap_quote` behaves identically). A browser page on an
`openocean.finance` origin sends `Referer` automatically, which is why their own
app works and the docs never mention it.

`WAF_HEADERS` in [src/openocean.ts](src/openocean.ts) sets it. If you port this
code and drop that header, `/quote` breaks while `/gasPrice` keeps working.

Other hosts, for the record: `ethapi.openocean.finance` is decommissioned
("This chain is no longer supported" for every chain), and
`proapi.openocean.finance` serves market/CEX routes, not swaps. `open-api` is
still correct for the swap API.

Verified live end-to-end: CLI `quote`/`swap` on bsc, eth, base and solana (real
calldata against router `0x6352a56c…`), token lists across chains, the server
proxy, and the frontend.

Docs: <https://docs.openocean.finance/docs/overview/transaction-example>
