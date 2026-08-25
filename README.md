# OpenOcean v4 Playground

Zero runtime dependencies. TypeScript + Bun, vanilla HTML/CSS/JS frontend, no build step.
Only devDependency is `@types/bun`.

```bash
bun install
bun run dev          # → http://localhost:3000
```

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
src/server.ts     Bun.serve proxy + static host
src/cli.ts        terminal client
public/index.html frontend (single file, no build)
```

The frontend calls the API **through the local server**, not directly:
`open-api.openocean.finance` doesn't reliably send CORS headers, and the proxy
also lets the UI show you the exact upstream URL for every call.

---

## Deploying to Vercel

Vercel runs `Bun.serve()` directly via its Bun framework preset, so this deploys
essentially as-is — no rewrite to serverless handlers, no `/api` directory, no
Express shim.

**There is no "Bun" entry in the Framework Preset dropdown, and you don't need
one.** The preset is detected from files in the repo; the dashboard will show
**Other**, which is correct. Leave it alone.

Detection requires all four of these (all already true here):

| Requirement | This repo |
|---|---|
| `bunVersion` in `vercel.json` | `"1.4.x"` |
| a text `bun.lock` (not the legacy binary `bun.lockb`) | present |
| entrypoint at `server.ts` or `src/server.ts` | [src/server.ts](src/server.ts) |
| `Bun.serve()` called once at module top level | yes |

So [vercel.json](vercel.json) is just:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "bunVersion": "1.4.x"
}
```

Deploy by importing the repo at [vercel.com/new](https://vercel.com/new), or:

```bash
bunx vercel --prod
```

No environment variables — the OpenOcean API takes no key.

### If it deploys as a static site instead of running the server

That means detection failed. Check, in order: `bun.lock` is committed (not
gitignored, and not `bun.lockb`); `bunVersion` is in `vercel.json`; and
`src/server.ts` exists at exactly that path. Moving the file to `server.ts` in
the project root also satisfies the preset.

### Don't add a `functions` block for this

`functions` globs match source files that *become* functions — normally
`api/**`. Under the framework preset, `src/server.ts` is consumed by the preset
rather than discovered as a function, so a `functions: { "src/server.ts": … }`
entry can match nothing and fail the build. Set function memory/duration in the
project dashboard instead, if you ever need to.

### Three things that had to change for serverless

- **`Bun.file` path.** The `/` route read `"public/index.html"` relative to the
  process cwd. That works locally and 404s in production, because the function
  doesn't run from the repo root. Now resolved against `import.meta.url`.
- **HTTP caching.** The token and icon caches are plain in-process `Map`s, which
  live only as long as a warm instance — every cold start would re-fetch
  upstream. `/api/chains` and `/api/chainIcons` send `s-maxage=3600`,
  `/api/tokens` 600s, so Vercel's CDN absorbs the repeats. `/api/quote` and
  `/api/swap` deliberately send **no** cache header: those are live prices.
- **A time budget on icon resolution.** A cold `/api/chainIcons` fans out to ~30
  token lists (~4s). It now stops starting new lookups after 8s and returns what
  resolved; the rest keep initials and fill in on a later request. That keeps the
  endpoint inside the default duration limit instead of needing a raised one.

### Caveats

- **The CLI won't run on Vercel** — `bun run quote` and friends are local-only
  tools. Only the web app deploys.
- **The `Referer` header still matters.** It's set server-side in
  `WAF_HEADERS`, so it works from Vercel exactly as locally. If you ever move
  these calls into the browser, they'll start 403ing.

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
