# Candidate sources to add

Every entry below was probed live from this machine on 2026-08-28. Status codes
and CORS headers are what the API actually returned, not what its docs claim.
Nothing here is a guess — anything I could not verify is in the last section,
marked as such.

The bar for "implementable here": a plain REST/JSON-RPC quote endpoint (no SDK —
this project has zero runtime dependencies), keyless or a free self-service key,
and it must return an output amount we can rank on.

---

## Tier 1 — keyless, CORS-open, verified working

Implement these first. No key to obtain, no proxy needed, browser-callable.

| # | Source | Kind | Ecosystem | Same/Cross |
|---|---|---|---|---|
| 1 | **deBridge DLN** | intent bridge | 20+ EVM + Solana | cross |
| 2 | **Across** | optimistic bridge | EVM L2s | cross |
| 3 | **Symbiosis** | cross-chain aggregator | EVM + non-EVM | cross |
| 4 | **Raydium** | Solana AMM | Solana | same |
| 5 | **Aftermath** | Sui aggregator | Sui | same |
| 6 | **swap.coffee** | TON aggregator | TON | same |
| 7 | **Osmosis SQS** | Cosmos router | Osmosis | same |
| 8 | **Binance / Coinbase ticker** | CEX mid-price | — | reference |

### 1. deBridge DLN — the strongest single addition

```
GET https://dln.debridge.finance/v1.0/dln/order/quote
  ?srcChainId=1&srcChainTokenIn=0x0000…0000&srcChainTokenInAmount=1000000000000000000
  &dstChainId=8453&dstChainTokenOut=0x8335…913&prependOperatingExpenses=false
```

Verified `200`, `access-control-allow-origin: *`, no key. Output at
`estimation.dstChainTokenOut.amount`. **Native token is the zero address**, not
our `0xEeee…` sentinel — it rejects `0xEeee…` with `INVALID_QUERY_PARAMETERS`.

Why it matters: a large independent intent/solver network we don't have, and one
of the few that covers **EVM ↔ Solana**. It also refuses same-chain quotes
outright (`SAME_SOURCE_AND_DESTINATION_CHAINS`), so it is cross-chain only.

### 2. Across — the canonical fast L2 bridge

```
GET https://app.across.to/api/suggested-fees
  ?inputToken=0xA0b8…eB48&outputToken=0x8335…913
  &originChainId=1&destinationChainId=8453&amount=1000000000
```

Verified `200`, CORS `*`, no key. Gives a direct `outputAmount`
(999896576 = 999.896576 USDC on 1000 in), plus `estimatedFillTimeSec` (2s).

Note we'd be **double-counting**: LI.FI and 0x already route over Across. Worth
adding anyway as the direct source — it shows whether the aggregators are
marking up the underlying bridge, which is exactly the kind of thing this tool
exists to reveal. Tag it clearly.

### 3. Symbiosis

```
POST https://api.symbiosis.finance/crosschain/v2/quote
{ tokenAmountIn: {address, amount, chainId, decimals},
  tokenOut: {address, chainId, decimals}, from, to, slippage }
```

Verified `200`, CORS `*`, no key. Required fields confirmed from their live
OpenAPI at `/crosschain/openapi.json` (`tokenAmountIn`, `tokenOut`, `from`,
`to`, `slippage`). Also exposes `/v1/chains`, `/v1/tokens`, `/v2/quotes`.

### 4. Raydium — Solana's Uniswap-V3 equivalent

```
GET https://transaction-v1.raydium.io/compute/swap-base-in
  ?inputMint=So111…112&outputMint=EPjF…Dt1v&amount=1000000000&slippageBps=100&txVersion=V0
```

Verified `200`, CORS `*`, no key. This is the Solana analogue of our Uniswap V3
adapter: a direct AMM read rather than a routing opinion, so it's a **control**
for Jupiter/Titan the way Uniswap V3 is for the EVM aggregators.

### 5. Aftermath — Sui

```
POST https://aftermath.finance/api/router/trade-route
{ coinInType: "0x2::sui::SUI", coinOutType: "0x…::usdc::USDC", coinInAmount: "1000000000" }
```

Verified `200`, CORS `*`, no key. Returns routes across Cetus and other Sui
pools. **Sui is an ecosystem we currently do not cover at all.**

### 6. swap.coffee — TON

```
POST https://backend.swap.coffee/v1/route
{ input_token: {blockchain:"ton", address:"native"},
  output_token: {blockchain:"ton", address:"EQCx…_sDs"}, input_amount: 10 }
```

Verified `200`, CORS `*`, no key. **TON is another entirely uncovered
ecosystem.** Note `input_amount` is human-readable, not base units.

### 7. Osmosis SQS — Cosmos

```
GET https://sqsprod.osmosis.zone/router/quote
  ?tokenIn=1000000uosmo&tokenOutDenom=ibc/498A…A6E4
```

Verified `200`, CORS `*`, no key. Amount and denom are **concatenated** in
`tokenIn`. Opens up Cosmos/IBC, which we don't touch.

### 8. CEX mid-price reference (Binance + Coinbase)

```
GET https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT   → {"price":"2497.42"}
GET https://api.coinbase.com/v2/prices/ETH-USD/spot              → {"amount":"2497.235"}
```

Both verified `200`, CORS `*`, keyless. Kraken works too but sends **no** CORS
header (proxy only).

This is a different *kind* of row and worth calling out: every source we have is
a router, so there is no independent answer to "is this whole set mispriced?".
A CEX mid gives one. It must be rendered as a **reference, not a rankable
quote** — it's a spot mid with no size, slippage or gas, so ranking it against
executable routes would be misleading. Suggest a separate line above the table.

---

## Tier 2 — free self-service key, or needs the proxy

| Source | Kind | Blocker |
|---|---|---|
| **1inch** | EVM aggregator | free key at portal.1inch.dev; `401 Unauthorized` without |
| **Panora** | Aptos aggregator | free key; `401 API key is required` |
| **OKX DEX** | multi-chain aggregator | needs `OK-ACCESS-KEY`; free self-service |
| **Skip Go** | Cosmos/IBC cross-chain | keyless and verified `200`, but **no CORS header** → proxy |
| **Kraken ticker** | CEX reference | keyless, no CORS → proxy |
| **STON.fi** | TON DEX | endpoint live (`400` on my test addresses); needs correct raw jetton addresses |

**1inch** is the most notable gap in the whole list — the best-known EVM
aggregator and we don't have it. The key is self-service and free.

**Skip Go** verified working:
`POST https://api.skip.build/v2/fungible/route` returned `200` with
`amount_out`, keyless. Only the missing CORS header stands in the way, and we
already have proxy machinery for exactly this.

---

## Tier 3 — gated, needs a relationship

| Source | What's needed |
|---|---|
| **Hashflow** | `403` — RFQ taker access requires an agreement |
| **Clipper** | `403 Missing Authentication Token` |
| **Socket / Bungee** | Bungee API returns `410 deprecated`; Socket V3 returns `401` — key required |
| **LayerZero VT** (Stargate successor) | old Stargate API `410`; new `transfer.layerzero-api.com/v1/quotes` returns `401` |
| **Squid** | `/v2/route` `404` on GET; integrator id required |
| **Rango** | `403` from this IP even with their public demo key |
| **Native.org** | DNS did not resolve |
| **Everclear** | Cloudflare `530` |
| **HyperSwap** | Cloudflare challenge (`Just a moment…`) |

---

## Needs checking from your machine, not this sandbox

**Odos** — every endpoint, including `/health` and `/info/chains`, returns
Cloudflare **530** from here. That is the same IP-reputation pattern that got
fly.trade rejected earlier, so this is probably *our* sandbox IP rather than
Odos being down. Odos is a serious aggregator and a real gap — worth retrying
from your machine or from Vercel before writing it off:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.odos.xyz/info/chains
```

Same caveat for **Firebird** and **Titan** (DNS failed here), and **Magpie**
(`403` HTML, likely the same Cloudflare treatment).

---

## Not worth adding

- **Cetus (Sui)** — Aftermath already routes *through* Cetus pools, so adding it
  separately mostly duplicates. Add only if you want the direct-pool control.
- **DeDust (TON)** — `/v2/pools` works but it's a pool-list endpoint, not a
  quote endpoint; we'd have to price the AMM ourselves. swap.coffee already
  aggregates DeDust.
- **Orca (Sui/Solana)** — the `/v1/quote` response was an echo of request
  headers, not a quote; no usable quote endpoint found.
- **Meteora** — `404` on the documented path; pool data only, no router.
- **Stargate / Bungee** — both formally deprecated in favour of key-gated
  successors (see Tier 3).

---

## Suggested order

1. **deBridge DLN** — biggest genuinely new liquidity, EVM↔Solana, zero friction.
2. **1inch** — the most conspicuous absence; costs one free key.
3. **Symbiosis** + **Across** — keyless cross-chain, immediate breadth.
4. **Raydium** — makes the Solana comparison honest (control vs aggregator).
5. **CEX mid-price row** — cheap, and the only thing here that can tell you the
   entire panel is off.
6. **Aftermath / swap.coffee / Osmosis** — three new ecosystems (Sui, TON,
   Cosmos), all keyless, if breadth matters more than depth.

A caution worth keeping in mind: several of these overlap what we already query
(Across sits under LI.FI and 0x; deBridge and Relay both appear inside 0x's
bridge list). More rows is not automatically more information — the venue tags
need to keep that visible, or the table starts implying more independent
agreement than actually exists.
