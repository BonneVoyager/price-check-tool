# OpenOcean v4 Playground

Zero runtime dependencies. TypeScript + Bun, vanilla HTML/CSS/JS frontend, no build step.
Only devDependency is `@types/bun`.

```bash
bun install
bun run dev          # → http://localhost:3000
```

Static site, no backend: `bun run build` emits `public/app.js` and the page
talks to OpenOcean directly. See [Deploying to Vercel](#deploying-to-vercel).

The UI follows your OS appearance — dark is the default, light is a full re-map.
There's no in-app toggle; switch it in System Settings › Appearance (macOS) and
the page updates on reload. (To force one, override the `:root` tokens in
`public/index.html` and delete the `prefers-color-scheme` block.)

---

## Which route should you use?

This is the question the playground is built to answer. There are two endpoints
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

Two consequences for this playground:

- `/api/quote` and `/api/swap` pass any unrecognised `0x…` address straight
  through, and only reject unknown *symbols* (which are genuinely unresolvable).
- The token picker offers a pasted address as an **unlisted** entry, so the UI
  isn't more restrictive than the API it demonstrates.

A failed quote on a valid-looking address means no route, not a rejected token —
an address that isn't a contract at all returns the same generic
`code: 500 "Quote api error"` as a real token with no liquidity, so check the
contract exists before assuming the token is unsupported.

**Chain icons.** The API has no chain-logo field, and OpenOcean's own app uses
hashed build assets (`/img/sonic.2305224a.svg`) that break on their next deploy.
So logos resolve in two tiers, served from `/api/chainIcons`:

1. [src/chain-marks.ts](src/chain-marks.ts) holds inline-SVG brand marks for the
   12 chains the token list *cannot* distinguish. Every ETH-native L2 resolves to
   its own local WETH token — distinct URLs, but all the generic ETH diamond — so
   Base, Arbitrum, Optimism, Linea, Scroll, zkSync, Blast, Mode, Manta, Aurora
   and Polygon zkEVM would otherwise render as eleven identical rows. Data URIs,
   so there's no CDN to rot and nothing to rate-limit.
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
