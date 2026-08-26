/**
 * One adapter per aggregator.
 *
 * Each owns three things: which chains it covers, how to build its request, and
 * how to read its response. Everything else is the runner's job.
 *
 * Verified keyless + CORS-open from a deployed https origin (2026-08):
 * OpenOcean, ParaSwap, KyberSwap, LI.FI all return 200 from browser JS.
 * 1inch and 0x are deliberately absent — both answer 401 without an API key,
 * which would force a server and undo the static build.
 */

import { CHAINS, type ChainInfo } from "../chains.ts";
import { ENSO_API_KEY, ZEROX_API_KEY } from "./keys.ts";
import { getQuote, toBaseUnits } from "../openocean.ts";
import {
  NoRouteError,
  type NormalQuote,
  type NormalVenue,
  type QuoteAdapter,
  type QuoteRequest,
} from "./types.ts";

/** Strip undefined/empty params so we never send `&x=undefined`. */
function qs(params: Record<string, string | number | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    p.set(k, String(v));
  }
  return p.toString();
}

async function getJson(
  url: string,
  signal: AbortSignal,
  headers?: Record<string, string>,
) {
  const res = await fetch(url, {
    signal,
    headers: { accept: "application/json", ...headers },
  });
  const text = await res.text();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Cloudflare/WAF challenge pages are HTML; say so instead of a parse error.
    const challenge = /just a moment|cf-browser-verification/i.test(text);
    throw new Error(
      challenge
        ? `Blocked by the API's bot protection (HTTP ${res.status})`
        : `Non-JSON response (HTTP ${res.status})`,
    );
  }
  return { res, json: json as Record<string, any> };
}


/**
 * Bebop requires EIP-55 checksummed addresses and rejects lowercase outright.
 *
 * OpenOcean's token list returns addresses LOWERCASED, and computing a checksum
 * needs keccak-256, which neither Bun nor the browser exposes (SHA-3 uses
 * different padding) — and this project ships no dependencies. So Bebop is
 * limited to pairs we hold checksummed constants for: the wrapped natives below
 * plus CHECKSUMMED_TOKENS. Anything else declares itself unsupported instead of
 * firing a request that is guaranteed to fail.
 */

/** Hand-checksummed majors, so Bebop can quote the pairs people actually test. */
const CHECKSUMMED_TOKENS: Record<string, Record<string, string>> = {
  eth: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  },
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  arbitrum: {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  polygon: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
};

/** Return a checksummed form when we know one, else null. */
function checksummed(chainCode: string, addr: string): string | null {
  if (/[A-F]/.test(addr)) return addr; // already mixed-case
  const known = CHECKSUMMED_TOKENS[chainCode]?.[addr.toLowerCase()];
  return known ?? null;
}

/** Wrapped-native address per chain, for sources that reject the native token. */
const WRAPPED_NATIVE: Record<string, string> = {
  eth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  base: "0x4200000000000000000000000000000000000006",
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  optimism: "0x4200000000000000000000000000000000000006",
  avax: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  xdai: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
  scroll: "0x5300000000000000000000000000000000000004",
  blast: "0x4300000000000000000000000000000000000004",
};

/** true when this is the EVM native sentinel. */
const isNativeSentinel = (a: string) =>
  a.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * Some sources (CoW, Bebop, Relay) can't quote the raw native coin and need the
 * wrapped ERC-20 instead. Swap it in where we know the wrapper.
 */
function wrapIfNative(chainCode: string, addr: string): string | null {
  if (!isNativeSentinel(addr)) return addr;
  return WRAPPED_NATIVE[chainCode] ?? null;
}

const dedupeVenues = (names: (string | undefined)[]): NormalVenue[] => {
  const seen = new Set<string>();
  for (const n of names) if (n) seen.add(n);
  return [...seen].map((name) => ({ name }));
};

// ---------------------------------------------------------------------------
// OpenOcean — the incumbent. Widest chain coverage incl. non-EVM.
// ---------------------------------------------------------------------------

/**
 * Chains OpenOcean's /v4 does NOT serve. Everything else in the registry was
 * verified against its tokenList, so an exclusion list stays smaller and won't
 * silently drop a chain when the registry grows.
 */
const OPENOCEAN_EXCLUDES = new Set(["starknet"]);
const OPENOCEAN_CHAINS = new Set(
  CHAINS.filter((c) => !OPENOCEAN_EXCLUDES.has(c.code)).map((c) => c.code),
);

const openocean: QuoteAdapter = {
  id: "openocean",
  label: "OpenOcean",
  blurb: "42 chains, EVM + Solana/Sui/Aptos/NEAR",

  supports(req) {
    // The registry's original 42 all came from probing OpenOcean, but chains
    // added later for other aggregators (Starknet) are NOT served by /v4.
    if (!OPENOCEAN_CHAINS.has(req.chain.code)) {
      return `${req.chain.name} not on OpenOcean v4`;
    }
    return true;
  },

  async quote(req, signal) {
    // NOTE: OpenOcean is the only source here taking a HUMAN-READABLE amount.
    const params = {
      inTokenAddress: req.inToken.address,
      outTokenAddress: req.outToken.address,
      amount: req.amount,
      gasPrice: req.gasPrice || "3",
      slippage: req.slippage || "1",
    };
    const url = `https://open-api.openocean.finance/v4/${req.chain.code}/quote?${qs(params)}`;

    // Routed through getQuote(), not raw fetch: that client sets the Referer
    // that /quote requires off-browser (and correctly omits it in-browser,
    // where it's a forbidden header). Bypassing it 403s in the CLI.
    //
    // On localhost the browser's own Referer is http://localhost, which the WAF
    // rejects — so retry via the dev proxy, exactly as the single-quote path
    // does. Deployed over https the direct call succeeds and this never runs.
    let d: Record<string, any>;
    try {
      d = (await getQuote(req.chain.code, params)) as unknown as Record<string, any>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const gated = /403|Cloudflare/i.test(msg);
      const loc = (globalThis as { location?: { hostname?: string } }).location;
      const canProxy = loc?.hostname === "localhost";

      if (!gated || !canProxy) throw new NoRouteError(msg);

      const proxied = `/api/quote?${qs({
        chain: req.chain.code,
        in: req.inToken.address,
        out: req.outToken.address,
        amount: req.amount,
        gasPrice: params.gasPrice,
        slippage: params.slippage,
      })}`;
      const res = await fetch(proxied, { signal });
      const body = (await res.json()) as Record<string, any>;
      if (!res.ok) throw new NoRouteError(body?.error ?? "dev proxy failed");
      d = body;
    }

    // Flatten the nested path into a venue list.
    const names: string[] = [];
    for (const r of d.path?.routes ?? []) {
      for (const s of r.subRoutes ?? []) {
        for (const x of s.dexes ?? []) names.push(x.dex ?? x.id);
      }
    }

    return {
      source: "openocean",
      label: "OpenOcean",
      outAmount: String(d.outAmount ?? "0"),
      outDecimals: d.outToken?.decimals ?? req.outToken.decimals,
      estimatedGas: d.estimatedGas != null ? String(d.estimatedGas) : undefined,
      priceImpact: d.price_impact,
      venues: dedupeVenues(names),
      url,
      ms: 0,
      canExecute: true,
    };
  },
};

// ---------------------------------------------------------------------------
// KyberSwap — EVM only; chain is a name in the URL path.
// ---------------------------------------------------------------------------

/** Kyber's path slugs, which differ from our codes. */
const KYBER_CHAINS: Record<string, string> = {
  eth: "ethereum",
  bsc: "bsc",
  polygon: "polygon",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  avax: "avalanche",
  fantom: "fantom",
  linea: "linea",
  scroll: "scroll",
  mantle: "mantle",
  blast: "blast",
  zksync: "zksync",
  sonic: "sonic",
  bera: "berachain",
  xdai: "gnosis",
  cronos: "cronos",
  polygon_zkevm: "polygon-zkevm",
  hyperevm: "hyperevm",
};

const kyberswap: QuoteAdapter = {
  id: "kyberswap",
  label: "KyberSwap",
  blurb: "EVM only, strong same-chain routing",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (!KYBER_CHAINS[req.chain.code]) return `${req.chain.name} not covered`;
    return true;
  },

  async quote(req, signal) {
    const slug = KYBER_CHAINS[req.chain.code]!;
    const amountIn = toBaseUnits(req.amount, req.inToken.decimals);
    const url =
      `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes?` +
      qs({
        tokenIn: req.inToken.address,
        tokenOut: req.outToken.address,
        amountIn,
      });

    const { json } = await getJson(url, signal);
    // Kyber signals success with code 0.
    if (json.code !== 0 || !json.data?.routeSummary) {
      throw new NoRouteError(json.message ?? `code ${json.code}`);
    }
    const s = json.data.routeSummary;

    const names: string[] = [];
    for (const leg of s.route ?? []) {
      for (const hop of leg ?? []) if (hop?.exchange) names.push(hop.exchange);
    }

    return {
      source: "kyberswap",
      label: "KyberSwap",
      outAmount: String(s.amountOut ?? "0"),
      outDecimals: req.outToken.decimals,
      estimatedGas: s.gas != null ? String(s.gas) : undefined,
      venues: dedupeVenues(names),
      url,
      ms: 0,
      // Executable, but calldata needs a second POST to /route/build.
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// ParaSwap — EVM only; chain is a numeric `network` query param.
// ---------------------------------------------------------------------------

const PARASWAP_CHAINS = new Set([
  1, 56, 137, 42161, 10, 8453, 43114, 250, 59144, 1101, 146,
]);

const paraswap: QuoteAdapter = {
  id: "paraswap",
  label: "ParaSwap",
  blurb: "EVM only, Velora/ParaSwap network",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (req.chain.id == null || !PARASWAP_CHAINS.has(req.chain.id)) {
      return `${req.chain.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    const amount = toBaseUnits(req.amount, req.inToken.decimals);
    const url =
      `https://api.paraswap.io/prices?` +
      qs({
        srcToken: req.inToken.address,
        destToken: req.outToken.address,
        amount,
        srcDecimals: req.inToken.decimals,
        destDecimals: req.outToken.decimals,
        side: "SELL",
        network: req.chain.id ?? undefined,
      });

    const { json } = await getJson(url, signal);
    const pr = json.priceRoute;
    if (!pr?.destAmount) {
      throw new NoRouteError(json.error ?? "no priceRoute");
    }

    const names: string[] = [];
    for (const route of pr.bestRoute ?? []) {
      for (const swap of route.swaps ?? []) {
        for (const e of swap.swapExchanges ?? []) if (e?.exchange) names.push(e.exchange);
      }
    }

    return {
      source: "paraswap",
      label: "ParaSwap",
      outAmount: String(pr.destAmount),
      outDecimals: pr.destDecimals ?? req.outToken.decimals,
      estimatedGas: pr.gasCost != null ? String(pr.gasCost) : undefined,
      venues: dedupeVenues(names),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// LI.FI — meta-aggregator. Needs an address, and quotes cross-chain too.
// ---------------------------------------------------------------------------

/** Placeholder when the user hasn't supplied a wallet — LI.FI requires one. */
const ZERO_ADDR = "0x0000000000000000000000000000000000000001";

const lifi: QuoteAdapter = {
  id: "lifi",
  label: "LI.FI",
  blurb: "Meta-aggregator, also bridges cross-chain",

  supports(req) {
    // LI.FI covers Solana too, but keyed by its own ids; restrict to what we
    // can address confidently rather than guessing a mapping.
    if (!req.chain.evm) return `${req.chain.name} needs LI.FI's non-EVM ids`;
    if (req.chain.id == null) return `${req.chain.name} has no chain id`;
    return true;
  },

  async quote(req, signal) {
    const fromAmount = toBaseUnits(req.amount, req.inToken.decimals);
    const url =
      `https://li.quest/v1/quote?` +
      qs({
        fromChain: req.chain.id ?? undefined,
        toChain: req.chain.id ?? undefined,
        fromToken: req.inToken.address,
        toToken: req.outToken.address,
        fromAmount,
        fromAddress: req.account || ZERO_ADDR,
        slippage: Number(req.slippage || "1") / 100,
      });

    const { json } = await getJson(url, signal);
    const est = json.estimate;
    if (!est?.toAmount) {
      throw new NoRouteError(json.message ?? "no estimate");
    }

    return {
      source: "lifi",
      label: "LI.FI",
      outAmount: String(est.toAmount),
      outDecimals: json.action?.toToken?.decimals ?? req.outToken.decimals,
      minOutAmount: est.toAmountMin ? String(est.toAmountMin) : undefined,
      estimatedGas: est.gasCosts?.[0]?.estimate
        ? String(est.gasCosts[0].estimate)
        : undefined,
      venues: dedupeVenues([json.toolDetails?.name ?? json.tool]),
      url,
      ms: 0,
      canExecute: true,
    };
  },
};

// ---------------------------------------------------------------------------
// Jupiter — Solana only. Proves the comparison isn't EVM-bound: adding a
// non-EVM source needs no change to the runner or the UI, just an adapter that
// says `supports()` for its own chain.
//
// Host note: the documented `quote-api.jup.ag/v6` host no longer resolves;
// `lite-api.jup.ag/swap/v1` is the current keyless endpoint (verified 2026-08).
// ---------------------------------------------------------------------------

const jupiter: QuoteAdapter = {
  id: "jupiter",
  label: "Jupiter",
  blurb: "Solana's main aggregator",

  supports(req) {
    if (req.chain.code !== "solana") return "Solana only";
    return true;
  },

  async quote(req, signal) {
    const amount = toBaseUnits(req.amount, req.inToken.decimals);
    const url =
      `https://lite-api.jup.ag/swap/v1/quote?` +
      qs({
        inputMint: req.inToken.address,
        outputMint: req.outToken.address,
        amount,
        // Jupiter takes slippage in basis points, not percent.
        slippageBps: Math.round(Number(req.slippage || "1") * 100),
      });

    const { json } = await getJson(url, signal);
    if (!json.outAmount) {
      throw new NoRouteError(json.error ?? json.message ?? "no route");
    }

    const names = (json.routePlan ?? []).map(
      (p: any) => p?.swapInfo?.label ?? p?.swapInfo?.ammKey,
    );

    return {
      source: "jupiter",
      label: "Jupiter",
      outAmount: String(json.outAmount),
      outDecimals: req.outToken.decimals,
      minOutAmount: json.otherAmountThreshold
        ? String(json.otherAmountThreshold)
        : undefined,
      priceImpact:
        json.priceImpactPct != null
          ? (Number(json.priceImpactPct) * 100).toFixed(4)
          : undefined,
      venues: dedupeVenues(names),
      url,
      ms: 0,
      canExecute: true,
    };
  },
};


// ---------------------------------------------------------------------------
// Shared: sources that need a real taker address.
//
// Several APIs reject the zero address (and Enso rejects "precompile or null"
// outright). A well-known funded EOA is used purely as a quote placeholder —
// nothing is signed or sent, and the UI's own account field overrides it.
// ---------------------------------------------------------------------------
const PLACEHOLDER_TAKER = "0x28C6c06298d514Db089934071355E5743bf21d60";

/** POST helper: several of these APIs are POST-only. */
async function postJson(
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new NoRouteError(
      json.description ?? json.message ?? json.errorType ?? `HTTP ${res.status}`,
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// CoW Swap — intent/batch-auction based, so its number includes a solver fee.
// ---------------------------------------------------------------------------

const COW_CHAINS: Record<string, string> = {
  eth: "mainnet",
  xdai: "xdai",
  arbitrum: "arbitrum_one",
  base: "base",
  polygon: "polygon",
  avax: "avalanche",
  bsc: "bsc",
};

const cow: QuoteAdapter = {
  id: "cow",
  label: "CoW Swap",
  blurb: "Batch auctions, MEV-protected",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (!COW_CHAINS[req.chain.code]) return `${req.chain.name} not covered`;
    return true;
  },

  async quote(req, signal) {
    const net = COW_CHAINS[req.chain.code]!;
    // CoW cannot sell/buy the raw native coin — it only trades ERC-20s.
    const sell = wrapIfNative(req.chain.code, req.inToken.address);
    const buy = wrapIfNative(req.chain.code, req.outToken.address);
    if (!sell || !buy) throw new NoRouteError("Native coin needs its wrapped form here");

    const url = `https://api.cow.fi/${net}/api/v1/quote`;
    const json = await postJson(
      url,
      {
        sellToken: sell,
        buyToken: buy,
        from: req.account || PLACEHOLDER_TAKER,
        kind: "sell",
        sellAmountBeforeFee: toBaseUnits(req.amount, req.inToken.decimals),
      },
      signal,
    );
    const q = json.quote;
    if (!q?.buyAmount) throw new NoRouteError(json.description ?? "no quote");

    return {
      source: "cow",
      label: "CoW Swap",
      // buyAmount is already net of CoW's fee — comparable to the others'
      // gross output only loosely. Called out in the UI footnote.
      outAmount: String(q.buyAmount),
      outDecimals: req.outToken.decimals,
      estimatedGas: q.gasAmount != null ? String(q.gasAmount) : undefined,
      venues: [{ name: "CoW Protocol solvers" }],
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Bebop — RFQ / professional market makers. Keys output by token address.
// ---------------------------------------------------------------------------

const BEBOP_CHAINS: Record<string, string> = {
  eth: "ethereum",
  arbitrum: "arbitrum",
  polygon: "polygon",
  base: "base",
  bsc: "bsc",
  optimism: "optimism",
  scroll: "scroll",
  taiko: "taiko",
  blast: "blast",
};

const bebop: QuoteAdapter = {
  id: "bebop",
  label: "Bebop",
  blurb: "RFQ from market makers",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (!BEBOP_CHAINS[req.chain.code]) return `${req.chain.name} not covered`;
    return true;
  },

  async quote(req, signal) {
    const net = BEBOP_CHAINS[req.chain.code]!;
    // Bebop rejects the native sentinel; use the wrapped ERC-20.
    const sellRaw = wrapIfNative(req.chain.code, req.inToken.address);
    const buyRaw = wrapIfNative(req.chain.code, req.outToken.address);
    if (!sellRaw || !buyRaw) throw new NoRouteError("Native coin needs its wrapped form here");

    const sell = checksummed(req.chain.code, sellRaw);
    const buy = checksummed(req.chain.code, buyRaw);
    if (!sell || !buy) {
      throw new NoRouteError(
        "Needs a checksummed address; not known for this token",
      );
    }

    const url =
      `https://api.bebop.xyz/router/${net}/v1/quote?` +
      qs({
        sell_tokens: sell,
        buy_tokens: buy,
        sell_amounts: toBaseUnits(req.amount, req.inToken.decimals),
        taker_address: req.account || PLACEHOLDER_TAKER,
        approval_type: "Standard",
      });

    const { json } = await getJson(url, signal);
    const route = json.routes?.[0];
    const buyTokens = route?.quote?.buyTokens ?? {};
    // Output is keyed by token address, with unpredictable casing. Match the
    // address we actually SENT (possibly the wrapped one), not the requested.
    const entry = Object.entries(buyTokens).find(
      ([addr]) => addr.toLowerCase() === buy.toLowerCase(),
    )?.[1] as { amount?: string; decimals?: number } | undefined;

    if (!entry?.amount) throw new NoRouteError(json.error?.message ?? "no route");

    return {
      source: "bebop",
      label: "Bebop",
      outAmount: String(entry.amount),
      outDecimals: entry.decimals ?? req.outToken.decimals,
      priceImpact:
        route.quote.priceImpact != null
          ? String(route.quote.priceImpact)
          : undefined,
      venues: [{ name: route.type ?? "Bebop RFQ" }],
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Relay — cross-chain router; here used same-chain so it's comparable.
// ---------------------------------------------------------------------------

const relay: QuoteAdapter = {
  id: "relay",
  label: "Relay",
  blurb: "Cross-chain router (same-chain too)",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} needs Relay's non-EVM ids`;
    if (req.chain.id == null) return `${req.chain.name} has no chain id`;
    return true;
  },

  async quote(req, signal) {
    const url = "https://api.relay.link/quote";
    const json = await postJson(
      url,
      {
        user: req.account || PLACEHOLDER_TAKER,
        originChainId: req.chain.id,
        destinationChainId: req.chain.id,
        // Relay denotes the native coin with the zero address.
        originCurrency: isNativeSentinel(req.inToken.address)
          ? "0x0000000000000000000000000000000000000000"
          : req.inToken.address,
        destinationCurrency: isNativeSentinel(req.outToken.address)
          ? "0x0000000000000000000000000000000000000000"
          : req.outToken.address,
        amount: toBaseUnits(req.amount, req.inToken.decimals),
        tradeType: "EXACT_INPUT",
      },
      signal,
    );
    const outAmt = json.details?.currencyOut?.amount;
    if (!outAmt) throw new NoRouteError(json.message ?? "no route");

    return {
      source: "relay",
      label: "Relay",
      outAmount: String(outAmt),
      outDecimals:
        json.details?.currencyOut?.currency?.decimals ?? req.outToken.decimals,
      minOutAmount: json.details?.currencyOut?.minimumAmount
        ? String(json.details.currencyOut.minimumAmount)
        : undefined,
      priceImpact: json.details?.totalImpact?.percent,
      venues: [{ name: "Relay" }],
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// AVNU — Starknet. Amounts are HEX strings, not decimal.
// ---------------------------------------------------------------------------

const avnu: QuoteAdapter = {
  id: "avnu",
  label: "AVNU",
  blurb: "Starknet aggregator",

  supports(req) {
    if (req.chain.code !== "starknet") return "Starknet only";
    return true;
  },

  async quote(req, signal) {
    // AVNU takes and returns 0x-hex amounts.
    const sellHex = "0x" + BigInt(toBaseUnits(req.amount, req.inToken.decimals)).toString(16);
    const url =
      `https://starknet.api.avnu.fi/swap/v2/quotes?` +
      qs({
        sellTokenAddress: req.inToken.address,
        buyTokenAddress: req.outToken.address,
        sellAmount: sellHex,
      });

    const { json } = await getJson(url, signal);
    const q = Array.isArray(json) ? json[0] : undefined;
    if (!q?.buyAmount) throw new NoRouteError("no quote");

    const names = (q.routes ?? []).map((r: any) => r?.name);
    return {
      source: "avnu",
      label: "AVNU",
      outAmount: BigInt(q.buyAmount).toString(),
      outDecimals: req.outToken.decimals,
      venues: dedupeVenues(names),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Fibrous — Starknet (also Scroll/Base, but Starknet is the interesting one).
// ---------------------------------------------------------------------------

const fibrous: QuoteAdapter = {
  id: "fibrous",
  label: "Fibrous",
  blurb: "Starknet + Scroll aggregator",

  supports(req) {
    if (req.chain.code !== "starknet") return "Starknet only";
    return true;
  },

  async quote(req, signal) {
    const amountHex = "0x" + BigInt(toBaseUnits(req.amount, req.inToken.decimals)).toString(16);
    const url =
      `https://api.fibrous.finance/starknet/route?` +
      qs({
        amount: amountHex,
        tokenInAddress: req.inToken.address,
        tokenOutAddress: req.outToken.address,
      });

    const { json } = await getJson(url, signal);
    if (!json.success || !json.outputAmount) {
      throw new NoRouteError(json.message ?? "no route");
    }

    const names: string[] = [];
    const walk = (n: any) => {
      if (!n) return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (n.protocol_name ?? n.protocolName) names.push(n.protocol_name ?? n.protocolName);
      if (n.swaps) walk(n.swaps);
      if (n.route) walk(n.route);
    };
    walk(json.route);

    return {
      source: "fibrous",
      label: "Fibrous",
      outAmount: String(json.outputAmount),
      outDecimals: json.outputToken?.decimals ?? req.outToken.decimals,
      estimatedGas: json.estimatedGasUsed ? String(json.estimatedGasUsed) : undefined,
      venues: dedupeVenues(names),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};


// ---------------------------------------------------------------------------
// NEAR Intents — via the 1Click API.
//
// IMPORTANT: this uses `1click.chaindefuser.com`, NOT the `solver-relay` JSON-RPC.
// The solver-relay `quote` method returned `result: null` for every pair tried
// (ETH/USDC, SOL/USDC, NEAR/USDC) — that endpoint expects a signed intent
// published into a live auction, so a bare read-only quote gets no bid. 1Click
// is the quote-and-execute API layered on top, and `dry: true` returns a firm
// price with no commitment.
//
// Mapping is by ADDRESS, not symbol: each 1Click asset carries a
// `contractAddress` matching the chain's real token address, and a **null
// contractAddress means the chain's native coin**. That's far more reliable
// than the symbol matching the previous attempt used.
//
// Coverage is the widest of any source here — 35 chains including Bitcoin, XRP,
// Cardano, Dogecoin, TON, Tron, Stellar, Aptos, Sui and Starknet.
// ---------------------------------------------------------------------------

const ONECLICK_BASE = "https://1click.chaindefuser.com/v0";

/**
 * 1Click validates `recipient`/`refundTo` against the DESTINATION chain's
 * address format, so an EVM address on Solana fails with "recipient is not
 * valid". These are well-known public addresses used purely as quote
 * placeholders — `dry: true` means nothing is ever sent to them.
 */
const ONECLICK_PLACEHOLDER: Record<string, string> = {
  sol: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  near: "relay.tg",
  aptos: "0x1",
  sui: "0x0000000000000000000000000000000000000000000000000000000000000002",
  starknet: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  tron: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC",
  ton: "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
};

/** Our chain code -> 1Click's `blockchain` value. */
const ONECLICK_CHAINS: Record<string, string> = {
  eth: "eth",
  bsc: "bsc",
  base: "base",
  arbitrum: "arb",
  polygon: "pol",
  optimism: "op",
  avax: "avax",
  xdai: "gnosis",
  scroll: "scroll",
  monad: "monad",
  bera: "bera",
  solana: "sol",
  aptos: "aptos",
  sui: "sui",
  near: "near",
  starknet: "starknet",
  ton: "ton",
  tron: "tron",
};

interface OneClickAsset {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  /** null/absent for the chain's native coin. */
  contractAddress?: string | null;
}

/** Registry is ~186 entries and stable; fetch once per session. */
let oneClickAssets: Promise<OneClickAsset[]> | null = null;
function loadOneClickAssets(signal: AbortSignal): Promise<OneClickAsset[]> {
  oneClickAssets ??= (async () => {
    const { json } = await getJson(`${ONECLICK_BASE}/tokens`, signal);
    // This endpoint returns a bare array, not an envelope.
    return (Array.isArray(json) ? json : []) as OneClickAsset[];
  })().catch((err) => {
    oneClickAssets = null; // allow a later retry
    throw err;
  });
  return oneClickAssets;
}

/**
 * Resolve one of our tokens to a 1Click assetId.
 *
 * Native coins are matched by the ABSENCE of contractAddress; everything else
 * by case-insensitive address equality. Symbol is only a last resort, for
 * chains whose address formats differ from ours (Sui/Aptos type strings).
 */
function findOneClickAsset(
  assets: OneClickAsset[],
  chainKey: string,
  token: { address: string; symbol: string },
): OneClickAsset | undefined {
  const onChain = assets.filter((a) => a.blockchain === chainKey);
  const addr = token.address.toLowerCase();
  const isNative = isNativeSentinel(token.address) || addr.startsWith("so1111");

  if (isNative) {
    const nativeEntry = onChain.find((a) => !a.contractAddress);
    if (nativeEntry) return nativeEntry;
    // NEAR is the exception: its "native" is listed as the wrapped wNEAR
    // contract, so there is no entry without a contractAddress.
    const wrapped = onChain.find(
      (a) => a.symbol.toUpperCase() === `W${token.symbol.toUpperCase()}`,
    );
    if (wrapped) return wrapped;
  }

  return (
    onChain.find((a) => a.contractAddress?.toLowerCase() === addr) ??
    onChain.find((a) => a.symbol.toUpperCase() === token.symbol.toUpperCase())
  );
}

const nearIntents: QuoteAdapter = {
  id: "near-intents",
  label: "NEAR Intents",
  blurb: "1Click solver network, 35 chains",

  supports(req) {
    if (!ONECLICK_CHAINS[req.chain.code]) return `${req.chain.name} not covered`;
    return true;
  },

  async quote(req, signal) {
    const chainKey = ONECLICK_CHAINS[req.chain.code]!;
    const assets = await loadOneClickAssets(signal);

    const from = findOneClickAsset(assets, chainKey, req.inToken);
    const to = findOneClickAsset(assets, chainKey, req.outToken);
    if (!from || !to) {
      const missing = !from ? req.inToken.symbol : req.outToken.symbol;
      throw new NoRouteError(`${missing} not bridgeable via NEAR Intents`);
    }
    if (from.assetId === to.assetId) throw new NoRouteError("Same asset both sides");

    // Recipient must match the destination chain's address format.
    const taker =
      req.account ||
      ONECLICK_PLACEHOLDER[chainKey] ||
      PLACEHOLDER_TAKER;
    // Deadline must be in the future; 30 min is well inside any quote's life.
    const deadline = new Date(Date.now() + 30 * 60_000).toISOString();

    const url = `${ONECLICK_BASE}/quote`;
    const json = await postJson(
      url,
      {
        // dry: true = price only, nothing committed and no deposit address.
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: Math.round(Number(req.slippage || "1") * 100),
        originAsset: from.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: to.assetId,
        amount: toBaseUnits(req.amount, from.decimals),
        refundTo: taker,
        refundType: "ORIGIN_CHAIN",
        recipient: taker,
        recipientType: "DESTINATION_CHAIN",
        deadline,
      },
      signal,
    );

    const q = json.quote;
    if (!q?.amountOut) {
      throw new NoRouteError(json.message ?? "no quote returned");
    }

    return {
      source: "near-intents",
      label: "NEAR Intents",
      outAmount: String(q.amountOut),
      outDecimals: to.decimals,
      minOutAmount: q.minAmountOut ? String(q.minAmountOut) : undefined,
      venues: [{ name: "NEAR solver network" }],
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Enso — route engine. Needs a key, and DOES work from the browser.
// ---------------------------------------------------------------------------

const ENSO_CHAINS = new Set([1, 56, 137, 42161, 10, 8453, 43114, 100, 59144, 324, 5000, 534352, 81457, 146]);

const enso: QuoteAdapter = {
  id: "enso",
  label: "Enso",
  blurb: "Route engine (API key, public)",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (req.chain.id == null || !ENSO_CHAINS.has(req.chain.id)) {
      return `${req.chain.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    // Enso rejects the zero address and precompiles as fromAddress, so a real
    // funded EOA stands in when the user hasn't supplied one.
    const url =
      `https://api.enso.finance/api/v1/shortcuts/route?` +
      qs({
        chainId: req.chain.id ?? undefined,
        fromAddress: req.account || PLACEHOLDER_TAKER,
        tokenIn: req.inToken.address,
        tokenOut: req.outToken.address,
        amountIn: toBaseUnits(req.amount, req.inToken.decimals),
        slippage: Math.round(Number(req.slippage || "1") * 100),
      });

    const { json } = await getJson(url, signal, {
      Authorization: `Bearer ${ENSO_API_KEY}`,
    });
    if (!json.amountOut) {
      throw new NoRouteError(json.message ?? json.error ?? "no route");
    }

    return {
      source: "enso",
      label: "Enso",
      outAmount: String(json.amountOut),
      outDecimals: req.outToken.decimals,
      minOutAmount: json.minAmountOut ? String(json.minAmountOut) : undefined,
      estimatedGas: json.gas != null ? String(json.gas) : undefined,
      priceImpact:
        json.priceImpact != null ? String(json.priceImpact / 100) : undefined,
      venues: dedupeVenues(
        (json.route ?? []).map((r: any) => r?.protocol ?? r?.action),
      ),
      url,
      ms: 0,
      canExecute: true,
    };
  },
};

// ---------------------------------------------------------------------------
// 0x — CLI / server only.
//
// `api.0x.org` sends NO `access-control-allow-origin` header (its OPTIONS
// preflight 401s with no CORS headers at all), so a browser fetch always fails
// with "Failed to fetch" regardless of the key. Rather than show every user a
// permanent red error row, the adapter declares itself unsupported in a browser
// and quotes normally from the CLI, where CORS doesn't apply.
// ---------------------------------------------------------------------------

const ZEROX_CHAINS = new Set([1, 56, 137, 42161, 10, 8453, 43114, 59144, 534352, 5000, 81457, 146, 480]);

const zerox: QuoteAdapter = {
  id: "zerox",
  label: "0x",
  blurb: "Server-side only (no CORS)",

  supports(req) {
    if (typeof window !== "undefined") {
      return "0x blocks browser requests (no CORS) — CLI only";
    }
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (req.chain.id == null || !ZEROX_CHAINS.has(req.chain.id)) {
      return `${req.chain.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    const key = ZEROX_API_KEY;
    if (!key) throw new NoRouteError("Set ZEROX_API_KEY in .env to use 0x");

    const url =
      `https://api.0x.org/swap/allowance-holder/price?` +
      qs({
        chainId: req.chain.id ?? undefined,
        sellToken: req.inToken.address,
        buyToken: req.outToken.address,
        sellAmount: toBaseUnits(req.amount, req.inToken.decimals),
        taker: req.account || PLACEHOLDER_TAKER,
        slippageBps: Math.round(Number(req.slippage || "1") * 100),
      });

    const { json } = await getJson(url, signal, {
      "0x-api-key": key,
      "0x-version": "v2",
    });
    if (!json.buyAmount) {
      throw new NoRouteError(json.reason ?? json.message ?? "no route");
    }

    return {
      source: "zerox",
      label: "0x",
      outAmount: String(json.buyAmount),
      outDecimals: req.outToken.decimals,
      minOutAmount: json.minBuyAmount ? String(json.minBuyAmount) : undefined,
      estimatedGas: json.gas != null ? String(json.gas) : undefined,
      venues: dedupeVenues((json.route?.fills ?? []).map((f: any) => f?.source)),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Uniswap V3 — direct on-chain read, no aggregator, no API key.
//
// Both Uniswap HTTP APIs are gated (`trade-api.gateway.uniswap.org` → 401,
// `api.uniswap.org/v1/quote` → 409 ACCESS_DENIED), so instead of an API this
// adapter calls QuoterV2 on-chain via `eth_call` on a public RPC. That is
// arguably the more honest baseline anyway: it's the raw pool price with no
// routing, which is exactly what the aggregators should be beating.
//
// It quotes SINGLE-HOP only, trying every fee tier and keeping the best pool.
// A pair with no direct pool (needing e.g. TOKEN→WETH→USDC) reports no route —
// correctly, since that hop IS the routing an aggregator would add.
// ---------------------------------------------------------------------------

/** QuoterV2 per chain. Base uses a different deployment address. */
const UNI_QUOTER: Record<string, string> = {
  eth: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  arbitrum: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  optimism: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  polygon: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  base: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
};

/**
 * CORS-open public RPCs, in preference order. Verified from a browser:
 * publicnode and drpc send CORS headers; llamarpc and 1rpc.io do NOT.
 */
const UNI_RPCS: Record<string, string[]> = {
  eth: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  arbitrum: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  optimism: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
  polygon: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  base: ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
};

/** V3 fee tiers, in basis-points-of-a-percent (500 = 0.05%). */
const UNI_FEES = [100, 500, 3000, 10000];

const abiWord = (hex: string) =>
  hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** quoteExactInputSingle((tokenIn,tokenOut,amountIn,fee,sqrtPriceLimitX96)) */
function encodeQuoteCall(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
): string {
  return (
    "0xc6a5026a" +
    abiWord(tokenIn) +
    abiWord(tokenOut) +
    abiWord(amountIn.toString(16)) +
    abiWord(fee.toString(16)) +
    abiWord("0")
  );
}

const uniswap: QuoteAdapter = {
  id: "uniswap",
  label: "Uniswap V3",
  blurb: "Direct pool read, no routing",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (!UNI_QUOTER[req.chain.code]) return `${req.chain.name} not covered`;
    // The Quoter needs ERC-20s; the native sentinel has no pool.
    if (
      isNativeSentinel(req.inToken.address) &&
      !WRAPPED_NATIVE[req.chain.code]
    ) {
      return "No wrapped-native address known";
    }
    return true;
  },

  async quote(req, signal) {
    const chainCode = req.chain.code;
    const quoter = UNI_QUOTER[chainCode]!;
    // Pools hold wrapped tokens, so map the native sentinel to WETH/WPOL/etc.
    const tokenIn = wrapIfNative(chainCode, req.inToken.address)!;
    const tokenOut = wrapIfNative(chainCode, req.outToken.address)!;
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      throw new NoRouteError("Same token both sides");
    }

    const amountIn = BigInt(toBaseUnits(req.amount, req.inToken.decimals));

    // One batched JSON-RPC request for all fee tiers — one round trip.
    const batch = UNI_FEES.map((fee, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "eth_call",
      params: [{ to: quoter, data: encodeQuoteCall(tokenIn, tokenOut, amountIn, fee) }, "latest"],
    }));

    const rpcs = UNI_RPCS[chainCode] ?? [];
    let results: any[] | null = null;
    let usedRpc = "";

    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
        });
        const json = await res.json();
        if (Array.isArray(json)) {
          results = json;
          usedRpc = rpc;
          break;
        }
      } catch {
        // Try the next RPC — one being down or CORS-blocked isn't fatal.
      }
    }
    if (!results) throw new Error("No public RPC responded");

    // A tier with no pool reverts, which comes back as "0x" or an error entry.
    let best = 0n;
    let bestFee = 0;
    for (const r of results) {
      const raw = r?.result;
      if (typeof raw !== "string" || raw === "0x" || raw.length < 66) continue;
      const out = BigInt("0x" + raw.slice(2, 66));
      if (out > best) {
        best = out;
        bestFee = UNI_FEES[r.id] ?? 0;
      }
    }
    if (best === 0n) {
      throw new NoRouteError("No direct V3 pool for this pair");
    }

    // A pool can exist but hold almost nothing, and QuoterV2 will happily
    // return a catastrophic price rather than reverting — e.g. 100 LINK -> 1.3
    // DAI from a near-empty 0.3% pool. Surfacing that as a real quote would be
    // worse than useless: it looks like a 99% loss against every other source.
    // So compare against the pool's own marginal rate at a tiny size and bail
    // when the trade moves the price by more than 90%.
    const probeIn = amountIn / 1000n;
    if (probeIn > 0n) {
      const probeCall = {
        jsonrpc: "2.0",
        id: 0,
        method: "eth_call",
        params: [
          { to: quoter, data: encodeQuoteCall(tokenIn, tokenOut, probeIn, bestFee) },
          "latest",
        ],
      };
      try {
        const res = await fetch(usedRpc, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify([probeCall]),
        });
        const arr = await res.json();
        const raw = Array.isArray(arr) ? arr[0]?.result : undefined;
        if (typeof raw === "string" && raw !== "0x" && raw.length >= 66) {
          const probeOut = BigInt("0x" + raw.slice(2, 66));
          // Expected output if price held: probeOut * 1000.
          const expected = probeOut * 1000n;
          if (expected > 0n && best * 10n < expected) {
            throw new NoRouteError(
              "Direct pool too thin for this size (>90% price impact)",
            );
          }
        }
      } catch (err) {
        if (err instanceof NoRouteError) throw err;
        // Probe failure is not fatal — keep the quote we already have.
      }
    }

    return {
      source: "uniswap",
      label: "Uniswap V3",
      outAmount: best.toString(),
      outDecimals: req.outToken.decimals,
      venues: [{ name: `V3 ${(bestFee / 10_000).toFixed(2)}% pool` }],
      url: `${usedRpc} → QuoterV2.quoteExactInputSingle (fee ${bestFee})`,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Sushi — its own router API. Note `amount` is base units and the reply's
// `assumedAmountOut` is what to compare (there's also a `tx` for execution).
// ---------------------------------------------------------------------------

const SUSHI_CHAINS = new Set([1, 56, 137, 42161, 10, 8453, 43114, 250, 100, 59144, 534352, 146, 81457]);

const sushi: QuoteAdapter = {
  id: "sushi",
  label: "Sushi",
  blurb: "SushiSwap router API",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (req.chain.id == null || !SUSHI_CHAINS.has(req.chain.id)) {
      return `${req.chain.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    const url =
      `https://api.sushi.com/swap/v7/${req.chain.id}?` +
      qs({
        tokenIn: req.inToken.address,
        tokenOut: req.outToken.address,
        amount: toBaseUnits(req.amount, req.inToken.decimals),
        maxSlippage: Number(req.slippage || "1") / 100,
        sender: req.account || PLACEHOLDER_TAKER,
      });

    const { json } = await getJson(url, signal);
    if (json.status !== "Success" || !json.assumedAmountOut) {
      throw new NoRouteError(json.status ?? json.message ?? "no route");
    }

    // `tokens` is a lookup table; tokenTo indexes into it for real decimals.
    const outTok = json.tokens?.[json.tokenTo];

    return {
      source: "sushi",
      label: "Sushi",
      outAmount: String(json.assumedAmountOut),
      outDecimals: outTok?.decimals ?? req.outToken.decimals,
      estimatedGas: json.gasSpent != null ? String(json.gasSpent) : undefined,
      priceImpact:
        json.priceImpact != null
          ? (Number(json.priceImpact) * 100).toFixed(4)
          : undefined,
      venues: [{ name: "Sushi router" }],
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// DODO — its own router, but note `useSource` in the reply often names another
// aggregator (OKX, BinanceWallet), so treat it as a meta-source rather than a
// pure DEX. `resAmount` is HUMAN-READABLE, unlike almost everything else here.
// ---------------------------------------------------------------------------

const DODO_CHAINS = new Set([1, 56, 137, 42161, 10, 8453, 43114, 324, 1101, 59144, 5000, 534352]);

/** DODO's public demo key, as published in their docs. */
const DODO_KEY = "a37546505892e1a952";

const dodo: QuoteAdapter = {
  id: "dodo",
  label: "DODO",
  blurb: "DODO router (aggregates others)",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (req.chain.id == null || !DODO_CHAINS.has(req.chain.id)) {
      return `${req.chain.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    const url =
      `https://api.dodoex.io/route-service/developer/getdodoroute?` +
      qs({
        chainId: req.chain.id ?? undefined,
        deadLine: Math.floor(Date.now() / 1000) + 600,
        apikey: DODO_KEY,
        slippage: req.slippage || "1",
        source: "dodoV2AndMixWasm",
        fromTokenAddress: req.inToken.address,
        toTokenAddress: req.outToken.address,
        fromAmount: toBaseUnits(req.amount, req.inToken.decimals),
        userAddr: req.account || PLACEHOLDER_TAKER,
        estimateGas: "false",
      });

    const { json } = await getJson(url, signal);
    const d = json.data;
    if (json.status !== 200 || d?.resAmount == null) {
      throw new NoRouteError(json.data ?? json.message ?? `status ${json.status}`);
    }

    // resAmount is a human-readable NUMBER; scale it back to base units so the
    // runner can rank it alongside everyone else.
    const decimals = d.targetDecimals ?? req.outToken.decimals;
    const outAmount = toBaseUnits(String(d.resAmount), decimals);

    return {
      source: "dodo",
      label: "DODO",
      outAmount,
      outDecimals: decimals,
      estimatedGas: d.gasLimit != null ? String(d.gasLimit) : undefined,
      priceImpact:
        d.priceImpact != null ? (Number(d.priceImpact) * 100).toFixed(4) : undefined,
      venues: [{ name: d.useSource ? `via ${d.useSource}` : "DODO" }],
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Balancer — GraphQL SOR. Takes a HUMAN-READABLE swapAmount and returns a
// HUMAN-READABLE returnAmount, so no base-unit conversion either way.
// ---------------------------------------------------------------------------

/** Balancer's GraphQL chain enum, keyed by our chain code. */
const BALANCER_CHAINS: Record<string, string> = {
  eth: "MAINNET",
  base: "BASE",
  arbitrum: "ARBITRUM",
  polygon: "POLYGON",
  optimism: "OPTIMISM",
  avax: "AVALANCHE",
  xdai: "GNOSIS",
  sonic: "SONIC",
};

const balancer: QuoteAdapter = {
  id: "balancer",
  label: "Balancer",
  blurb: "Balancer SOR (weighted pools)",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (!BALANCER_CHAINS[req.chain.code]) return `${req.chain.name} not covered`;
    return true;
  },

  async quote(req, signal) {
    const chainEnum = BALANCER_CHAINS[req.chain.code]!;
    // Native coin has no Balancer pool; use the wrapped form.
    const tokenIn = wrapIfNative(req.chain.code, req.inToken.address);
    const tokenOut = wrapIfNative(req.chain.code, req.outToken.address);
    if (!tokenIn || !tokenOut) {
      throw new NoRouteError("Native coin needs its wrapped form here");
    }

    const query = `query {
      sorGetSwapPaths(
        chain: ${chainEnum}
        swapType: EXACT_IN
        swapAmount: "${req.amount}"
        tokenIn: "${tokenIn.toLowerCase()}"
        tokenOut: "${tokenOut.toLowerCase()}"
      ) { returnAmount routes { share } }
    }`;

    const url = "https://api-v3.balancer.fi/";
    const json = await postJson(url, { query }, signal);
    const sor = json.data?.sorGetSwapPaths;
    const human = sor?.returnAmount;

    // Balancer answers "0" when no pool path exists, rather than erroring.
    if (!human || Number(human) === 0) {
      throw new NoRouteError("No Balancer pool path for this pair");
    }

    const routeCount = sor.routes?.length ?? 0;
    return {
      source: "balancer",
      label: "Balancer",
      outAmount: toBaseUnits(String(human), req.outToken.decimals),
      outDecimals: req.outToken.decimals,
      venues: [
        { name: routeCount > 1 ? `${routeCount} pools` : "Balancer pool" },
      ],
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

/** Registry order = display order before ranking. */
export const ADAPTERS: QuoteAdapter[] = [
  openocean,
  kyberswap,
  paraswap,
  cow,
  bebop,
  enso,
  zerox,
  relay,
  lifi,
  nearIntents,
  jupiter,
  avnu,
  fibrous,
  uniswap,
  sushi,
  dodo,
  balancer,
];

export function adapterById(id: string) {
  return ADAPTERS.find((a) => a.id === id);
}

export type { ChainInfo };
