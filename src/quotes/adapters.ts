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

import { CHAINS, NATIVE, TON_NATIVE, type ChainInfo } from "../chains.ts";
import {
  ENSO_API_KEY,
  ONEINCH_API_KEY,
  PANORA_API_KEY,
  SOROSWAP_API_KEY,
  ZEROX_API_KEY,
} from "./keys.ts";
import { contractIdForAsset, isStellarAsset } from "./soroban.ts";
import { proxyAvailable, proxyUrl } from "./proxy.ts";
import { getQuote, toBaseUnits } from "../openocean.ts";
import {
  NoRouteError,
  isCrossChain,
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
const OPENOCEAN_EXCLUDES = new Set(["starknet", "stellar"]);
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
      if (!gated) throw new NoRouteError(msg);

      // The WAF rejects the ORIGIN, and no client-side header can change it.
      // Measured, from real origins:
      //   vercel.app          -> 200
      //   github.io  (https)  -> 403   <- NOT an http/https thing
      //   localhost / file:   -> 403
      // Every referrerPolicy (no-referrer / origin / unsafe-url) is 403 from a
      // blocked origin, and v3/quote and v4/swap are blocked the same way, so
      // this is an allowlist on their side rather than anything we can satisfy.
      // gasPrice and tokenList stay open, which is why only quoting breaks.
      const loc = (globalThis as { location?: { hostname?: string; protocol?: string } })
        .location;
      const host = loc?.hostname ?? "";
      const isFile = loc?.protocol === "file:";
      const isLocal = host === "localhost" || host === "127.0.0.1";

      // `bun run dev` proxies /quote for exactly this reason. The single-file
      // build has no server behind it, so there is nothing to fall back to —
      // detect that instead of fetching /api/quote and failing on the HTML.
      let proxied: Record<string, any> | null = null;
      if (isLocal) {
        try {
          const res = await fetch(
            `/api/quote?${qs({
              chain: req.chain.code,
              in: req.inToken.address,
              out: req.outToken.address,
              amount: req.amount,
              gasPrice: params.gasPrice,
              slippage: params.slippage,
            })}`,
            { signal },
          );
          if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
            proxied = (await res.json()) as Record<string, any>;
          }
        } catch {
          // No dev proxy here (e.g. the single-file build on a plain server).
        }
      }

      // Second fallback: the server-side proxy. Same origin on the Vercel
      // deployment, cross-origin from GitHub Pages. If it's unreachable this
      // stays null and the source reports itself unavailable — Pages keeps
      // working with the other 18 sources.
      if (!proxied && (await proxyAvailable())) {
        try {
          const res = await fetch(
            proxyUrl("openocean", {
              chain: req.chain.code,
              endpoint: "quote",
              in: req.inToken.address,
              out: req.outToken.address,
              amount: req.amount,
              gasPrice: params.gasPrice,
              slippage: params.slippage,
            }),
            { signal },
          );
          if (res.ok) {
            const body = (await res.json()) as Record<string, any>;
            // The proxy passes the upstream envelope through untouched.
            if (body?.code === 200 && body.data) proxied = body.data;
          }
        } catch {
          // Proxy down mid-request; fall through to the message below.
        }
      }

      if (!proxied) {
        throw new NoRouteError(
          isLocal || isFile
            ? "OpenOcean's WAF blocks local origins — run `bun run dev` to proxy it"
            : `OpenOcean's WAF blocks this origin (${host}) and the proxy is unreachable`,
        );
      }
      d = proxied;
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

/**
 * Velora Delta cross-chain: `GET api.velora.xyz/v2/quote` with `mode=DELTA`.
 *
 * `chainId` is the source and `destChainId` the destination. The output lives at
 * `delta.route.destination.output.amount` — there is no flat `destAmount` field
 * on this response, and `route.bridge.protocol` names the bridge it chose
 * (observed: Relay, Across).
 *
 * Needs no API key and sends `access-control-allow-origin: *`, so unlike 0x's
 * cross-chain endpoint this one needs no proxy at all.
 */
async function veloraCrossQuote(
  req: QuoteRequest,
  signal: AbortSignal,
): Promise<NormalQuote> {
  const url =
    `https://api.velora.xyz/v2/quote?` +
    qs({
      chainId: req.fromChain.id ?? undefined,
      destChainId: req.toChain.id ?? undefined,
      mode: "DELTA",
      srcToken: req.inToken.address,
      destToken: req.outToken.address,
      amount: toBaseUnits(req.amount, req.inToken.decimals),
      srcDecimals: req.inToken.decimals,
      destDecimals: req.outToken.decimals,
      side: "SELL",
      userAddress: req.account || PLACEHOLDER_TAKER,
    });

  const { json } = await getJson(url, signal);
  const delta = json.delta;
  const out = delta?.route?.destination?.output?.amount;
  if (!out) {
    throw new NoRouteError(json.error ?? json.message ?? "no delta route");
  }

  return {
    source: "paraswap",
    label: "ParaSwap",
    kind: "intent",
    outAmount: String(out),
    outDecimals: req.outToken.decimals,
    venues: dedupeVenues([delta.route?.bridge?.protocol]),
    url,
    ms: 0,
    canExecute: false,
  };
}

const paraswap: QuoteAdapter = {
  id: "paraswap",
  label: "ParaSwap",
  blurb: "EVM only, Velora/ParaSwap network",
  // Velora (ParaSwap's successor brand) bridges via Delta on a separate v2
  // endpoint. No API key and CORS-open, so it works in the browser directly.
  crossChain: true,

  supports(req) {
    for (const c of isCrossChain(req) ? [req.fromChain, req.toChain] : [req.chain]) {
      if (!c.evm) return `${c.name} is not EVM`;
      if (c.id == null || !PARASWAP_CHAINS.has(c.id)) return `${c.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    if (isCrossChain(req)) return veloraCrossQuote(req, signal);
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

/**
 * Non-EVM chain ids LI.FI accepts. Solana is `1151111081099710` (SVM), which
 * `GET /v1/chains` only reveals with `?chainTypes=EVM,SVM` — the default
 * response is EVM-only, which is why this looked unsupported at first.
 */
const LIFI_NON_EVM: Record<string, number> = {
  solana: 1151111081099710,
};

/** A funded Solana account, for sources that require a same-VM address. */
const SOL_PLACEHOLDER = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
/** A real funded Stellar account, for APIs that validate the address format. */
const STELLAR_PLACEHOLDER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const lifi: QuoteAdapter = {
  id: "lifi",
  label: "LI.FI",
  blurb: "Meta-aggregator, also bridges cross-chain",
  crossChain: true,

  supports(req) {
    // Both ends must be addressable, since either may be the bridge target.
    for (const c of [req.fromChain, req.toChain]) {
      if (!c.evm && !LIFI_NON_EVM[c.code]) return `${c.name} not covered`;
      if (c.evm && c.id == null) return `${c.name} has no chain id`;
    }
    return true;
  },

  async quote(req, signal) {
    const fromAmount = toBaseUnits(req.amount, req.inToken.decimals);
    const fromId = LIFI_NON_EVM[req.fromChain.code] ?? req.fromChain.id ?? undefined;
    const toId = LIFI_NON_EVM[req.toChain.code] ?? req.toChain.id ?? undefined;
    // fromAddress must match the SOURCE chain's VM — an EVM address on Solana
    // is rejected outright. toAddress follows the DESTINATION's, and LI.FI
    // defaults it to fromAddress when omitted, which breaks any EVM->non-EVM
    // bridge ("Invalid toAddress: 0x00...01"). So set it explicitly per side.
    const fallbackAddr = req.fromChain.evm ? ZERO_ADDR : SOL_PLACEHOLDER;
    const toFallback = req.toChain.evm ? ZERO_ADDR : SOL_PLACEHOLDER;
    // A user-supplied account is only valid on a side whose VM matches it, so
    // keep the placeholder for the other side rather than reusing it blindly.
    const accountIsEvm = /^0x[0-9a-fA-F]{40}$/.test(req.account ?? "");
    const url =
      `https://li.quest/v1/quote?` +
      qs({
        fromChain: fromId,
        toChain: toId,
        fromToken: req.inToken.address,
        toToken: req.outToken.address,
        fromAmount,
        fromAddress:
          (accountIsEvm === req.fromChain.evm ? req.account : "") || fallbackAddr,
        toAddress:
          (accountIsEvm === req.toChain.evm ? req.account : "") || toFallback,
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
  headers?: Record<string, string>,
): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
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
    const raw = String(
      json.description ?? json.message ?? json.errorType ?? `HTTP ${res.status}`,
    );
    // Several of these APIs return multi-line diagnostics; the first line is
    // the actual reason and the rest is context that would blow out the table.
    throw new NoRouteError(raw.split("\n")[0]!.trim());
  }
  return json;
}

// ---------------------------------------------------------------------------
// CoW Swap — intent/batch-auction based, so its number includes a solver fee.
// ---------------------------------------------------------------------------

/**
 * CoW's per-network API slugs. NOT our chain codes: `xdai`→`xdai`,
 * `arbitrum`→`arbitrum_one`, `avax`→`avalanche`.
 *
 * BNB Chain is deliberately absent — CoW has no deployment there, and
 * `api.cow.fi/bsc/...` returns an HTML 404 (its `/version` endpoint 404s too).
 * Listing it produced a red "Non-JSON response (HTTP 404)" error on every BSC
 * comparison, which looked like a broken integration rather than a chain CoW
 * simply doesn't serve. Each slug below was verified with a live quote.
 */
const COW_CHAINS: Record<string, string> = {
  eth: "mainnet",
  xdai: "xdai",
  arbitrum: "arbitrum_one",
  base: "base",
  polygon: "polygon",
  avax: "avalanche",
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
      kind: "intent",
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
      kind: "rfq",
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

/**
 * Relay's own chain ids for non-EVM networks, from GET /chains (each carries a
 * `vmType`). It also serves Bitcoin, XRP, TON, Tron and Eclipse; only Solana is
 * wired here because it's the one our registry has tokens for.
 */
const RELAY_NON_EVM: Record<string, number> = {
  solana: 792703809,
};

/**
 * Relay denotes a chain's native coin with that chain's own zero-ish address,
 * not our sentinel. On Solana that's 32 "1"s — NOT the wrapped-SOL mint, which
 * it rejects.
 */
const RELAY_NATIVE: Record<string, string> = {
  solana: "11111111111111111111111111111111",
};

const relay: QuoteAdapter = {
  id: "relay",
  label: "Relay",
  blurb: "Cross-chain router (same-chain too)",
  crossChain: true,

  supports(req) {
    for (const c of [req.fromChain, req.toChain]) {
      if (!c.evm && !RELAY_NON_EVM[c.code]) return `${c.name} not covered`;
      if (c.evm && c.id == null) return `${c.name} has no chain id`;
    }
    return true;
  },

  async quote(req, signal) {
    const url = "https://api.relay.link/quote";
    const originId = RELAY_NON_EVM[req.fromChain.code] ?? req.fromChain.id;
    const destId = RELAY_NON_EVM[req.toChain.code] ?? req.toChain.id;
    // Native sentinel -> Relay's per-chain native address, resolved per SIDE:
    // EVM uses the zero address, Solana 32 "1"s (its System Program id).
    const nativeFor = (c: typeof req.fromChain) =>
      RELAY_NATIVE[c.code] ?? "0x0000000000000000000000000000000000000000";
    const isNativeFor = (addr: string, c: typeof req.fromChain) =>
      isNativeSentinel(addr) ||
      (!c.evm && addr.toLowerCase().startsWith("so1111"));

    // `user` is on the ORIGIN chain; `recipient` on the destination, which may
    // be a different VM entirely.
    const user =
      req.account || (req.fromChain.evm ? PLACEHOLDER_TAKER : SOL_PLACEHOLDER);
    const recipient = req.toChain.evm ? PLACEHOLDER_TAKER : SOL_PLACEHOLDER;

    const json = await postJson(
      url,
      {
        user,
        recipient: req.account || recipient,
        originChainId: originId,
        destinationChainId: destId,
        originCurrency: isNativeFor(req.inToken.address, req.fromChain)
          ? nativeFor(req.fromChain)
          : req.inToken.address,
        destinationCurrency: isNativeFor(req.outToken.address, req.toChain)
          ? nativeFor(req.toChain)
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
 * 1Click validates `recipient` against the DESTINATION chain's address format
 * (and `refundTo` against the ORIGIN's), so an EVM address on Solana fails with
 * "recipient is not
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
  // TON is fussy: the all-zero UQ/EQ address and several real wallets are all
  // rejected as "recipient is not valid". This one is accepted for both TON
  // assets (GRAM and USDT), verified by probing — so it is a working value, not
  // a canonical zero address.
  ton: "EQD2NmD_lH5f5u1Kj3KfGyTvhZSX0Eg6qp2a5IQUKXxOG21n",
  // Stellar additionally requires the recipient to hold a TRUSTLINE for the
  // destination asset, so no placeholder works for non-native destinations —
  // see the note in the adapter.
  stellar: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  // Bitcoin: 1Click validates refundTo against the ORIGIN chain's format, and
  // any valid BTC form is accepted — bech32, P2PKH and P2SH all quoted
  // identically when probed, so the well-known bech32 example is used.
  btc: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  doge: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
  ltc: "LhyLNfBkoKshT7R8Pce6vkB9T2cP2o84hx",
  bch: "qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy",
  zec: "t1KDGuBpNTgqcnJhVvLGoKPjKrnCFxfCwvL",
  dash: "Xx4dYKgz3Zcv6kheaqog3fynaKWjbahb6b",
  cardano: "addr1qy2jt0qpqz2z2z9zx5w4xemekkce7yderz53kjue53lpqv90lkfa9sgrfjuz6uvt4uqtrqhl2kj0a9lnr9ndzutx32gqleeckv",
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
  stellar: "stellar",
  // Non-EVM/UTXO chains. 1Click covers 35 blockchains; these are the ones we
  // also carry as chains, verified against /v0/tokens. Their native coins have
  // NO contractAddress, which findOneClickAsset already handles.
  bitcoin: "btc",
  hyperevm: "hypercore",
  doge: "doge",
  litecoin: "ltc",
  bitcoincash: "bch",
  zcash: "zec",
  dash: "dash",
  cardano: "cardano",
};

interface OneClickAsset {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  /** null/absent for the chain's native coin. */
  contractAddress?: string | null;
}

/**
 * Registry cache, with a short TTL rather than once-per-session.
 *
 * The list is NOT stable: it was 186 assets one day and 98 the next, with USDC
 * disappearing from Solana and Stellar in between. Caching it for the lifetime
 * of the page meant a fetch during a shrunken window kept the tool wrong until
 * a manual reload. 5 minutes keeps the fan-out cheap while letting the list
 * recover on its own.
 */
const ONECLICK_TTL_MS = 5 * 60 * 1000;
let oneClickAssets: { at: number; p: Promise<OneClickAsset[]> } | null = null;

function loadOneClickAssets(signal: AbortSignal): Promise<OneClickAsset[]> {
  if (oneClickAssets && Date.now() - oneClickAssets.at < ONECLICK_TTL_MS) {
    return oneClickAssets.p;
  }
  const p = (async () => {
    const { json } = await getJson(`${ONECLICK_BASE}/tokens`, signal);
    // This endpoint returns a bare array, not an envelope.
    return (Array.isArray(json) ? json : []) as OneClickAsset[];
  })().catch((err) => {
    oneClickAssets = null; // allow an immediate retry after a failure
    throw err;
  });
  oneClickAssets = { at: Date.now(), p };
  return p;
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
  const isNative =
    isNativeSentinel(token.address) ||
    addr.startsWith("so1111") ||
    addr === "native"; // Stellar's native asset

  // Stellar: our addresses are `native` or `CODE:ISSUER`, but 1Click stores the
  // bare ISSUER in contractAddress (and nothing for XLM). Match on the issuer
  // half, falling back to symbol.
  if (chainKey === "stellar" && !isNative) {
    const [code, issuer] = token.address.split(":");
    const hit =
      (issuer &&
        onChain.find(
          (a) => a.contractAddress?.toUpperCase() === issuer.toUpperCase(),
        )) ||
      onChain.find((a) => a.symbol.toUpperCase() === (code ?? "").toUpperCase());
    if (hit) return hit;
  }

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
  crossChain: true,

  supports(req) {
    for (const c of [req.fromChain, req.toChain]) {
      if (!ONECLICK_CHAINS[c.code]) return `${c.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    // Each side resolves against ITS OWN chain — that's what makes bridging work.
    const fromKey = ONECLICK_CHAINS[req.fromChain.code]!;
    const toKey = ONECLICK_CHAINS[req.toChain.code]!;
    const assets = await loadOneClickAssets(signal);

    const from = findOneClickAsset(assets, fromKey, req.inToken);
    const to = findOneClickAsset(assets, toKey, req.outToken);
    if (!from || !to) {
      const missing = !from ? req.inToken.symbol : req.outToken.symbol;
      const missingChain = !from ? req.fromChain : req.toChain;
      const chainKey = !from ? fromKey : toKey;
      // "not in the registry" rather than "not bridgeable": 1Click's asset list
      // is volatile — it went from 186 assets to 98 between two runs, dropping
      // USDC from Solana (7 assets left) and from Stellar (1 left) entirely.
      // The pair may well work again later, and a listed pair on the same chain
      // still quotes fine, so this is not a permanent property of the token.
      const listed = assets.filter((a) => a.blockchain === chainKey).length;
      // Distinguish "this token isn't listed" from "the registry itself is
      // degraded". Observed live: the list collapsed 186 -> 98 -> 2 assets
      // within an hour, and /quote then rejected assetIds it had just accepted
      // ("tokenIn is not valid"). Blaming the token there would be wrong.
      throw new NoRouteError(
        assets.length < 20
          ? `NEAR Intents' asset registry is degraded (${assets.length} assets total) — try again later`
          : `${missing} not in NEAR Intents' list for ${missingChain.name} (${listed} listed there)`,
      );
    }
    if (from.assetId === to.assetId) throw new NoRouteError("Same asset both sides");

    // Recipient must match the DESTINATION chain's address format; refundTo the
    // origin's. On a same-chain swap these are the same thing.
    const taker =
      req.account || ONECLICK_PLACEHOLDER[toKey] || PLACEHOLDER_TAKER;
    const refundTo =
      req.account || ONECLICK_PLACEHOLDER[fromKey] || PLACEHOLDER_TAKER;
    // Deadline must be in the future; 30 min is well inside any quote's life.
    const deadline = new Date(Date.now() + 30 * 60_000).toISOString();

    const url = `${ONECLICK_BASE}/quote`;
    // Initialised so the retry loop below can leave it unset on a double
    // failure without TypeScript losing track of it.
    let json: Record<string, any> = {};
    /**
     * One retry on 1Click's INTERNAL broker timeout.
     *
     * Their API fronts a message broker, and under load it gives up talking to
     * its own exchange service:
     *   Failed to receive response within timeout of 25000ms for exchange
     *   "1Click-API:api-exchange" and routing key "quote"
     *
     * That is their infrastructure, not our request — the same body succeeds on
     * the next call. Measured p50 363ms but max 10.5s on a 20-call run, so the
     * latency is spiky enough that one retry converts most of these into a
     * quote. Retried ONCE only: a source that is genuinely struggling should
     * not hold up the other 33, and the runner has its own timeout above this.
     */
    const isBrokerTimeout = (m: string) =>
      /Failed to receive response within timeout/i.test(m) &&
      /1Click-API|api-exchange/i.test(m);

    const body = () => ({
          // dry: true = price only, nothing committed and no deposit address.
          dry: true,
          // Stellar deposits are identified by transaction memo, not a unique
          // address, and 1Click rejects SIMPLE for a stellar origin outright
          // ("Incorrect depositMode for originAsset from stellar chain").
          depositMode: fromKey === "stellar" ? "MEMO" : "SIMPLE",
          swapType: "EXACT_INPUT",
          slippageTolerance: Math.round(Number(req.slippage || "1") * 100),
          originAsset: from.assetId,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: to.assetId,
          amount: toBaseUnits(req.amount, from.decimals),
          // Origin-chain format, verified by probe: an EVM refundTo on an
          // eth->solana quote is accepted while a Solana one is rejected.
          refundTo,
          refundType: "ORIGIN_CHAIN",
          recipient: taker,
          recipientType: "DESTINATION_CHAIN",
          deadline,
    });

    // Two attempts, then give up. Written as a loop so the success path below
    // is shared rather than duplicated into the retry branch.
    let lastBrokerMsg = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        json = await postJson(url, body(), signal);
        // A broker timeout can arrive as a normal body OR as a thrown non-2xx,
        // so both places have to recognise it.
        const m = String(json.message ?? "");
        if (isBrokerTimeout(m)) {
          lastBrokerMsg = m;
          continue;
        }
        lastBrokerMsg = "";
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isBrokerTimeout(msg)) {
          lastBrokerMsg = msg;
          continue;
        }
        // Stellar requires the RECIPIENT to already hold a trustline for the
        // destination asset — a chain-level rule, not a liquidity problem. A
        // placeholder address can never satisfy it, so say what would.
        if (/trustline/i.test(msg)) {
          throw new NoRouteError(
            "Recipient needs a Stellar trustline for this asset — set Account",
          );
        }
        throw err;
      }
    }

    // Both attempts hit their broker. Say whose fault it is: "no route" would
    // imply the pair is unsupported, which is not what happened.
    if (lastBrokerMsg) {
      throw new NoRouteError(
        "NEAR Intents' broker timed out twice — their service is busy, try again",
      );
    }

    const q = json.quote;
    if (!q?.amountOut) {
      const msg = String(json.message ?? "no quote returned");
      // Stellar-specific: the recipient must already hold a trustline for the
      // destination asset, so a placeholder address can't be quoted against.
      // Real integrations pass the user's own account, which normally has one.
      if (/trustline/i.test(msg)) {
        throw new NoRouteError(
          req.account
            ? "Recipient has no trustline for the destination asset"
            : "Stellar needs an account with a trustline — fill in Account",
        );
      }
      throw new NoRouteError(msg.split("\n")[0]!);
    }

    return {
      source: "near-intents",
      label: "NEAR Intents",
      kind: "intent",
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
  // Same endpoint bridges: add destinationChainId + receiver and it routes
  // across chains, combining a bridge leg with a swap leg.
  crossChain: true,

  supports(req) {
    // Both sides must be EVM chains Enso covers — the route is expressed as
    // EVM addresses on both, so a non-EVM side cannot be represented.
    for (const c of isCrossChain(req) ? [req.fromChain, req.toChain] : [req.chain]) {
      if (!c.evm) return `${c.name} is not EVM`;
      if (c.id == null || !ENSO_CHAINS.has(c.id)) return `${c.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    // Enso rejects the zero address and precompiles as fromAddress, so a real
    // funded EOA stands in when the user hasn't supplied one.
    const cross = isCrossChain(req);
    const url =
      `https://api.enso.finance/api/v1/shortcuts/route?` +
      qs({
        chainId: req.fromChain.id ?? undefined,
        // Only sent when bridging: Enso 400s with "receiver is required when
        // destinationChainId is set", so the two travel together.
        destinationChainId: cross ? req.toChain.id ?? undefined : undefined,
        receiver: cross ? req.account || PLACEHOLDER_TAKER : undefined,
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

/**
 * Chains the 0x CROSS-CHAIN API covers, from `GET /cross-chain/sources`.
 *
 * A different (larger) set from ZEROX_CHAINS above: the swap API and the
 * cross-chain API are separate products with separate coverage. Non-EVM
 * destinations are addressed by NAME rather than the pseudo chain-ids the
 * sources endpoint reports (999999999991 = Solana), because names are stable
 * and self-documenting.
 */
const ZEROX_CROSS_EVM = new Set([
  1, 10, 56, 130, 137, 143, 146, 480, 999, 2741, 4217, 4663, 5000, 8453, 9745,
  42161, 43114, 57073, 59144, 80094, 534352,
]);
/** Non-EVM chains the cross-chain API accepts, by our chain code. */
const ZEROX_CROSS_NAMES: Record<string, string> = { solana: "solana" };

/** The `originChain`/`destinationChain` value for one of our chains. */
function zeroxCrossChainId(chain: ChainInfo): string | undefined {
  const named = ZEROX_CROSS_NAMES[chain.code];
  if (named) return named;
  if (chain.id != null && ZEROX_CROSS_EVM.has(chain.id)) return String(chain.id);
  return undefined;
}

/**
 * 0x Cross-Chain API: `GET /cross-chain/quotes`.
 *
 * Separate endpoint and parameter names from the same-chain swap API
 * (originChain/destinationChain/originAddress, and a REQUIRED `sortQuotesBy`
 * enum of "price" | "speed"). It returns a `quotes[]` array of competing bridge
 * routes; sorting by price means quotes[0] is the best output, which is what we
 * rank on.
 *
 * It aggregates 16 bridges, several of which we already quote directly
 * (`relay`, `near_intents`), so a 0x win here may be the same underlying route
 * a dedicated source found. The venue tags name the bridge so that is visible
 * rather than hidden.
 */
async function zeroxCrossQuote(
  req: QuoteRequest,
  signal: AbortSignal,
  inBrowser: boolean,
): Promise<NormalQuote> {
  const params = {
    originChain: zeroxCrossChainId(req.fromChain),
    destinationChain: zeroxCrossChainId(req.toChain),
    sellToken: req.inToken.address,
    buyToken: req.outToken.address,
    sellAmount: toBaseUnits(req.amount, req.inToken.decimals),
    // Must match the ORIGIN chain's VM; the destination address must match the
    // destination's, so a single account cannot serve both across VMs.
    originAddress: req.fromChain.evm
      ? req.account || PLACEHOLDER_TAKER
      : SOL_PLACEHOLDER,
    destinationAddress: req.toChain.evm ? PLACEHOLDER_TAKER : SOL_PLACEHOLDER,
  };

  let json: Record<string, any>;
  let url: string;

  if (inBrowser) {
    // This endpoint IS CORS-open, unlike /swap — but calling it directly would
    // mean shipping the API key in the bundle, so it goes through the proxy for
    // the same reason the swap target does.
    if (!(await proxyAvailable())) {
      throw new NoRouteError("0x needs the proxy (API key) — proxy unreachable");
    }
    url = proxyUrl("zeroxCross", params);
    const res = await fetch(url, { signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new NoRouteError(body?.error ?? `proxy returned ${res.status}`);
    }
    json = (await res.json()) as Record<string, any>;
  } else {
    const key = ZEROX_API_KEY;
    if (!key) throw new NoRouteError("Set ZEROX_API_KEY in .env to use 0x");
    url = `https://api.0x.org/cross-chain/quotes?` + qs({ ...params, sortQuotesBy: "price" });
    json = (await getJson(url, signal, { "0x-api-key": key })).json;
  }

  const best = json.quotes?.[0];
  if (!best?.buyAmount) {
    // `liquidityAvailable: false` is a clean no-route, not an error.
    throw new NoRouteError(
      json.liquidityAvailable === false
        ? "no bridge route for this pair"
        : json.message ?? json.reason ?? "no route",
    );
  }

  // steps[] describes swap/bridge legs; the bridge name is the interesting part.
  const bridges = (best.steps ?? [])
    .map((st: any) => st?.bridge ?? st?.provider ?? st?.source)
    .filter(Boolean);

  return {
    source: "zerox",
    label: "0x",
    kind: "api",
    outAmount: String(best.buyAmount),
    outDecimals: req.outToken.decimals,
    minOutAmount: best.minBuyAmount ? String(best.minBuyAmount) : undefined,
    estimatedGas: best.gasCosts?.gasLimit ? String(best.gasCosts.gasLimit) : undefined,
    venues: dedupeVenues(bridges.length ? bridges : ["cross-chain"]),
    url,
    ms: 0,
    canExecute: false,
  };
}

const zerox: QuoteAdapter = {
  id: "zerox",
  label: "0x",
  blurb: "No CORS — via proxy in the browser",
  // 0x has a separate Cross-Chain API aggregating 16 bridges.
  crossChain: true,

  supports(req) {
    // In a browser this only works through the proxy (0x sends no CORS at all),
    // but whether the proxy is up is an async question — so allow it here and
    // let quote() report unavailability. That keeps supports() synchronous and
    // side-effect free, which the runner relies on.
    if (isCrossChain(req)) {
      // The cross-chain product has its own coverage, including Solana.
      if (!zeroxCrossChainId(req.fromChain)) {
        return `${req.fromChain.name} not covered for bridging`;
      }
      if (!zeroxCrossChainId(req.toChain)) {
        return `${req.toChain.name} not covered for bridging`;
      }
      return true;
    }
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (req.chain.id == null || !ZEROX_CHAINS.has(req.chain.id)) {
      return `${req.chain.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    const inBrowser = typeof window !== "undefined";

    if (isCrossChain(req)) return zeroxCrossQuote(req, signal, inBrowser);
    const params = {
      chainId: req.chain.id ?? undefined,
      sellToken: req.inToken.address,
      buyToken: req.outToken.address,
      sellAmount: toBaseUnits(req.amount, req.inToken.decimals),
      taker: req.account || PLACEHOLDER_TAKER,
      slippageBps: Math.round(Number(req.slippage || "1") * 100),
    };

    let json: Record<string, any>;
    let url: string;

    if (inBrowser) {
      // `api.0x.org` sends no access-control-allow-origin, so the browser can
      // never call it directly however valid the key. The proxy holds the key
      // server-side, which also keeps it out of the bundle.
      if (!(await proxyAvailable())) {
        throw new NoRouteError("0x needs the proxy (no CORS) — proxy unreachable");
      }
      url = proxyUrl("zerox", params as Record<string, string | number | undefined>);
      const res = await fetch(url, { signal });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new NoRouteError(body?.error ?? `proxy returned ${res.status}`);
      }
      json = (await res.json()) as Record<string, any>;
    } else {
      // CLI: no CORS to worry about, call it directly with the local key.
      const key = ZEROX_API_KEY;
      if (!key) throw new NoRouteError("Set ZEROX_API_KEY in .env to use 0x");
      url =
        `https://api.0x.org/swap/allowance-holder/price?` + qs(params);
      json = (await getJson(url, signal, {
        "0x-api-key": key,
        "0x-version": "v2",
      })).json;
    }

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
      kind: "onchain",
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

// ---------------------------------------------------------------------------
// WOWMAX — reimplemented from their SDK source, no dependency.
//
// Ported by hand from wowmax-exchange/wowmax-sdk (src/index.ts) so the project
// keeps zero runtime dependencies. Only two things were needed from it:
//   - base URL `https://api-gateway.wowmax.exchange`
//   - `GET /chains/{chainId}/quote?from&to&amount[&account]`
//
// UNIT ASYMMETRY (documented in their own SDK): the request `amount` is
// HUMAN-READABLE while `amountOut` comes back in BASE UNITS. Same trap as
// OpenOcean, and it bites the same way.
//
// Stellar is addressed by WOWMAX's synthetic chain id 100000148, and its assets
// are `native` or `CODE:ISSUER` rather than addresses — which is exactly why
// this adapter maps chains through a table instead of assuming `chain.id`.
// ---------------------------------------------------------------------------

const WOWMAX_BASE = "https://api-gateway.wowmax.exchange";

/** WOWMAX's synthetic chain id for Stellar (not an EVM chain id). */
const WOWMAX_STELLAR_ID = 100000148;

/** Our chain code -> the chain id WOWMAX expects in the path. */
const WOWMAX_CHAINS: Record<string, number> = {
  eth: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  avax: 43114,
  fantom: 250,
  sonic: 146,
  linea: 59144,
  scroll: 534352,
  zksync: 324,
  mantle: 5000,
  bera: 80094,
  stellar: WOWMAX_STELLAR_ID,
};

/**
 * Chains WOWMAX's BRIDGE api covers — a much narrower set than its swap API,
 * from `GET /crosschain/v0/bridge/chains`: ["bsc","stellar","eth"].
 *
 * Narrow, but it is the only source here that bridges EVM <-> Stellar.
 */
const WOWMAX_BRIDGE_CHAINS = new Set(["eth", "bsc", "stellar"]);

/**
 * WOWMAX bridge aggregator: `POST /crosschain/v0/bridge/quote`.
 *
 * Undocumented in their marketing and absent from the SDK; found in the live
 * OpenAPI spec at api-gateway.wowmax.exchange/docs-json, whose entry declares
 * no request body, so the field names came from probing the API itself.
 *
 * Two things make it unlike every other adapter here:
 *  - Tokens are SYMBOLS ("USDT"), not addresses. Passing an address returns an
 *    empty result set with per-bridge rejection reasons.
 *  - It returns a RANKED array of competing bridges in `merged[]`, so
 *    `merged[0]` is their pick (observed: axelar, squid, near-intents).
 *
 * Because it is symbol-keyed it cannot quote an arbitrary/unlisted token, so
 * the adapter requires a symbol on both sides.
 */
async function wowmaxBridgeQuote(
  req: QuoteRequest,
  signal: AbortSignal,
): Promise<NormalQuote> {
  const url = "https://api-gateway.wowmax.exchange/crosschain/v0/bridge/quote";
  // Sender/recipient must each match their own chain's address format.
  const addrFor = (chain: ChainInfo) =>
    chain.code === "stellar" ? STELLAR_PLACEHOLDER : PLACEHOLDER_TAKER;

  const json = await postJson(
    url,
    {
      fromChain: req.fromChain.code,
      fromToken: req.inToken.symbol,
      amount: req.amount,
      toChain: req.toChain.code,
      toToken: req.outToken.symbol,
      sender: req.account || addrFor(req.fromChain),
      recipient: req.account || addrFor(req.toChain),
    },
    signal,
  );

  const best = json.merged?.[0];
  if (!best?.amountOut) {
    throw new NoRouteError("no bridge quoted this pair");
  }

  return {
    source: "wowmax",
    label: "WOWMAX",
    // amountOut is a DECIMAL string here, not base units, unlike the swap API.
    outAmount: toBaseUnits(String(best.amountOut), req.outToken.decimals),
    outDecimals: req.outToken.decimals,
    venues: dedupeVenues([best.bridge]),
    url,
    ms: 0,
    canExecute: false,
  };
}

const wowmax: QuoteAdapter = {
  id: "wowmax",
  label: "WOWMAX",
  blurb: "EVM + Stellar aggregator",
  // Separate bridge-aggregator API; the only EVM <-> Stellar route here.
  crossChain: true,

  supports(req) {
    if (isCrossChain(req)) {
      for (const c of [req.fromChain, req.toChain]) {
        if (!WOWMAX_BRIDGE_CHAINS.has(c.code)) {
          return `${c.name} not on WOWMAX's bridge (eth, bsc, stellar only)`;
        }
      }
      // Symbol-keyed API: an unlisted token pasted as an address has the
      // placeholder label, which would silently quote the wrong asset.
      for (const t of [req.inToken, req.outToken]) {
        if (!t.symbol || t.symbol.startsWith("0x") || /\s/.test(t.symbol)) {
          return "Bridge needs a listed token symbol";
        }
      }
      return true;
    }
    if (!WOWMAX_CHAINS[req.chain.code]) return `${req.chain.name} not covered`;
    return true;
  },

  async quote(req, signal) {
    if (isCrossChain(req)) return wowmaxBridgeQuote(req, signal);
    const chainId = WOWMAX_CHAINS[req.chain.code]!;
    const url =
      `${WOWMAX_BASE}/chains/${chainId}/quote?` +
      qs({
        from: req.inToken.address,
        to: req.outToken.address,
        // Human-readable, per their SDK — do NOT convert to base units.
        amount: req.amount,
        account: req.account || undefined,
      });

    const { json } = await getJson(url, signal);
    if (!json.amountOut || json.amountOut === "0") {
      throw new NoRouteError(json.message ?? json.error ?? "no route");
    }

    // Venue names live in routes[].swaps[].market.name.
    const names: string[] = [];
    for (const r of json.routes ?? []) {
      for (const sw of r?.swaps ?? []) {
        const n = sw?.market?.name ?? sw?.market?.id;
        if (n) names.push(n);
      }
    }

    return {
      source: "wowmax",
      label: "WOWMAX",
      // amountOut IS base units, despite amount going in human-readable.
      outAmount: String(json.amountOut),
      outDecimals: json.to?.decimals ?? req.outToken.decimals,
      estimatedGas:
        json.gasUnitsConsumed != null && Number(json.gasUnitsConsumed) > 0
          ? String(json.gasUnitsConsumed)
          : undefined,
      priceImpact:
        json.priceImpact != null && Number(json.priceImpact) !== 0
          ? String(json.priceImpact)
          : undefined,
      venues: dedupeVenues(names),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Soroswap — Stellar's main aggregator (routes Soroswap, Phoenix, Aquarius and
// the classic SDEX).
//
// Requires a free API key from api.soroswap.finance/login; without one every
// request is 403 Forbidden. Rather than show a permanent error row, the adapter
// declares itself unsupported until `SOROSWAP_API_KEY` is set — then it works
// with no other change.
//
// Note it addresses assets by SOROBAN CONTRACT ID (C…), not the `CODE:ISSUER`
// form WOWMAX and the rest of Stellar use, so a small mapping table is needed.
// ---------------------------------------------------------------------------

const soroswap: QuoteAdapter = {
  id: "soroswap",
  label: "Soroswap",
  blurb: "Stellar aggregator (needs free key)",

  supports(req) {
    if (req.chain.code !== "stellar") return "Stellar only";
    if (!SOROSWAP_API_KEY) {
      return "Set SOROSWAP_API_KEY — free key from api.soroswap.finance/login";
    }
    // Any classic asset works now that the contract id is derived rather than
    // looked up, so this only rejects genuinely malformed input.
    if (!isStellarAsset(req.inToken.address)) {
      return `${req.inToken.symbol} is not a classic Stellar asset`;
    }
    if (!isStellarAsset(req.outToken.address)) {
      return `${req.outToken.symbol} is not a classic Stellar asset`;
    }
    return true;
  },

  async quote(req, signal) {
    // Soroswap only accepts Soroban contract ids; the classic CODE:ISSUER form
    // is rejected as "Invalid Stellar address". Its /api/tokens list is empty
    // for mainnet, so derive the id instead of looking it up. See soroban.ts.
    const [assetIn, assetOut] = await Promise.all([
      contractIdForAsset(req.inToken.address),
      contractIdForAsset(req.outToken.address),
    ]);
    const url = "https://api.soroswap.finance/quote?network=mainnet";

    const json = await postJson(
      url,
      {
        assetIn,
        assetOut,
        amount: toBaseUnits(req.amount, req.inToken.decimals),
        tradeType: "EXACT_IN",
        protocols: ["soroswap", "phoenix", "aqua", "sdex"],
        slippageBps: Math.round(Number(req.slippage || "1") * 100),
      },
      signal,
      { Authorization: `Bearer ${SOROSWAP_API_KEY}` },
    );

    if (!json.amountOut) throw new NoRouteError(json.message ?? "no route");

    // Venue names live in routePlan[].swapInfo.protocol; `platform` names the
    // one it settled on (e.g. "sdex" for the classic Stellar order book).
    const protocols = (json.routePlan ?? []).map(
      (r: any) => r?.swapInfo?.protocol,
    );

    return {
      source: "soroswap",
      label: "Soroswap",
      outAmount: String(json.amountOut),
      outDecimals: req.outToken.decimals,
      minOutAmount: json.otherAmountThreshold
        ? String(json.otherAmountThreshold)
        : undefined,
      priceImpact:
        json.priceImpactPct != null && Number(json.priceImpactPct) !== 0
          ? String(json.priceImpactPct)
          : undefined,
      venues: dedupeVenues(protocols.length ? protocols : [json.platform]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};


// ---------------------------------------------------------------------------
// deBridge DLN — intent/solver bridge. Cross-chain ONLY: it rejects a
// same-chain quote with SAME_SOURCE_AND_DESTINATION_CHAINS.
//
// Native token is the ZERO address here, not our 0xEeee… sentinel, which it
// rejects outright as INVALID_QUERY_PARAMETERS.
// ---------------------------------------------------------------------------

/** DLN chain ids. EVM chains use their own id; Solana has a DLN-specific one. */
const DLN_CHAINS: Record<string, number> = {
  eth: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  avax: 43114,
  linea: 59144,
  bera: 80094,
  sonic: 146,
  cronos: 25,
  gravity: 1625,
  metis: 1088,
  fantom: 250,
  // DLN's internal id for Solana, not a real EVM chain id.
  solana: 7565164,
};

const debridge: QuoteAdapter = {
  id: "debridge",
  label: "deBridge",
  blurb: "DLN solver network (cross-chain only)",
  crossChain: true,

  supports(req) {
    if (!isCrossChain(req)) return "Bridge only — same-chain not quoted";
    for (const c of [req.fromChain, req.toChain]) {
      if (!DLN_CHAINS[c.code]) return `${c.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    // DLN wants the zero address for a native coin on every chain.
    const addr = (chain: ChainInfo, token: { address: string }) => {
      if (chain.evm && token.address.toLowerCase() === NATIVE.toLowerCase()) {
        return "0x0000000000000000000000000000000000000000";
      }
      return token.address;
    };

    const url =
      `https://dln.debridge.finance/v1.0/dln/order/quote?` +
      qs({
        srcChainId: DLN_CHAINS[req.fromChain.code],
        srcChainTokenIn: addr(req.fromChain, req.inToken),
        srcChainTokenInAmount: toBaseUnits(req.amount, req.inToken.decimals),
        dstChainId: DLN_CHAINS[req.toChain.code],
        dstChainTokenOut: addr(req.toChain, req.outToken),
        prependOperatingExpenses: "false",
      });

    const { json } = await getJson(url, signal);
    const out = json.estimation?.dstChainTokenOut?.amount;
    if (!out) {
      throw new NoRouteError(json.errorMessage ?? json.errorId ?? "no route");
    }

    return {
      source: "debridge",
      label: "deBridge",
      kind: "intent",
      outAmount: String(out),
      outDecimals: json.estimation.dstChainTokenOut.decimals ?? req.outToken.decimals,
      venues: dedupeVenues(["DLN"]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Across — optimistic bridge. Note LI.FI and 0x already route OVER Across, so
// this row is deliberately a duplicate: it shows whether those aggregators are
// marking up the underlying bridge.
//
// Same-token only — it bridges an asset to its counterpart, it does not swap.
// ---------------------------------------------------------------------------

const ACROSS_CHAINS: Record<string, number> = {
  eth: 1,
  optimism: 10,
  polygon: 137,
  base: 8453,
  arbitrum: 42161,
  linea: 59144,
  scroll: 534352,
  zksync: 324,
  blast: 81457,
  mode: 34443,
  bsc: 56,
  sonic: 146,
  ink: 57073,
  unichain: 130,
};

const across: QuoteAdapter = {
  id: "across",
  label: "Across",
  blurb: "Optimistic bridge (same asset only)",
  crossChain: true,

  supports(req) {
    if (!isCrossChain(req)) return "Bridge only — same-chain not quoted";
    for (const c of [req.fromChain, req.toChain]) {
      if (!ACROSS_CHAINS[c.code]) return `${c.name} not covered`;
    }
    // Across moves an asset across chains; it has no swap leg, so a different
    // symbol on each side is not something it can quote.
    if (req.inToken.symbol.toUpperCase() !== req.outToken.symbol.toUpperCase()) {
      return `Bridges the same asset only (${req.inToken.symbol}→${req.inToken.symbol})`;
    }
    return true;
  },

  async quote(req, signal) {
    const url =
      `https://app.across.to/api/suggested-fees?` +
      qs({
        inputToken: req.inToken.address,
        outputToken: req.outToken.address,
        originChainId: ACROSS_CHAINS[req.fromChain.code],
        destinationChainId: ACROSS_CHAINS[req.toChain.code],
        amount: toBaseUnits(req.amount, req.inToken.decimals),
      });

    const { json } = await getJson(url, signal);
    if (json.isAmountTooLow) {
      throw new NoRouteError("amount below Across' minimum");
    }
    if (!json.outputAmount) {
      throw new NoRouteError(json.message ?? "no fee quote");
    }

    return {
      source: "across",
      label: "Across",
      outAmount: String(json.outputAmount),
      outDecimals: req.outToken.decimals,
      venues: dedupeVenues(["Across"]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Symbiosis — cross-chain aggregator. Body shape taken from their live OpenAPI
// at api.symbiosis.finance/crosschain/openapi.json (required: tokenAmountIn,
// tokenOut, from, to, slippage).
// ---------------------------------------------------------------------------

const SYMBIOSIS_CHAINS: Record<string, number> = {
  eth: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  avax: 43114,
  linea: 59144,
  scroll: 534352,
  zksync: 324,
  mantle: 5000,
  blast: 81457,
  bera: 80094,
  sonic: 146,
  cronos: 25,
  metis: 1088,
  xdai: 100,
  sei: 1329,
};

const symbiosis: QuoteAdapter = {
  id: "symbiosis",
  label: "Symbiosis",
  blurb: "Cross-chain aggregator",
  crossChain: true,

  supports(req) {
    if (!isCrossChain(req)) return "Bridge only — same-chain not quoted";
    for (const c of [req.fromChain, req.toChain]) {
      if (!SYMBIOSIS_CHAINS[c.code]) return `${c.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    const url = "https://api.symbiosis.finance/crosschain/v2/quote";
    const taker = req.account || PLACEHOLDER_TAKER;
    const json = await postJson(
      url,
      {
        tokenAmountIn: {
          address: req.inToken.address.toLowerCase() === NATIVE.toLowerCase()
            ? ""
            : req.inToken.address,
          amount: toBaseUnits(req.amount, req.inToken.decimals),
          chainId: SYMBIOSIS_CHAINS[req.fromChain.code],
          decimals: req.inToken.decimals,
        },
        tokenOut: {
          address: req.outToken.address.toLowerCase() === NATIVE.toLowerCase()
            ? ""
            : req.outToken.address,
          chainId: SYMBIOSIS_CHAINS[req.toChain.code],
          decimals: req.outToken.decimals,
        },
        from: taker,
        to: taker,
        slippage: Math.round(Number(req.slippage || "1") * 100),
      },
      signal,
    );

    const out = json.tokenAmountOut?.amount ?? json.amountOut;
    if (!out) throw new NoRouteError(json.message ?? "no route");

    return {
      source: "symbiosis",
      label: "Symbiosis",
      outAmount: String(out),
      outDecimals: json.tokenAmountOut?.decimals ?? req.outToken.decimals,
      venues: dedupeVenues([json.inTradeType, json.outTradeType]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Raydium — Solana's largest AMM, read directly. This is the Solana analogue of
// the Uniswap V3 adapter: a pool price rather than a routing opinion, so it acts
// as the CONTROL that Jupiter/OpenOcean should be beating.
// ---------------------------------------------------------------------------

const raydium: QuoteAdapter = {
  id: "raydium",
  label: "Raydium",
  blurb: "Solana AMM, direct read",

  supports(req) {
    if (req.chain.code !== "solana") return "Solana only";
    return true;
  },

  async quote(req, signal) {
    const url =
      `https://transaction-v1.raydium.io/compute/swap-base-in?` +
      qs({
        inputMint: req.inToken.address,
        outputMint: req.outToken.address,
        amount: toBaseUnits(req.amount, req.inToken.decimals),
        slippageBps: Math.round(Number(req.slippage || "1") * 100),
        txVersion: "V0",
      });

    const { json } = await getJson(url, signal);
    const d = json.data;
    if (!json.success || !d?.outputAmount) {
      throw new NoRouteError(json.msg ?? "no route");
    }

    return {
      source: "raydium",
      label: "Raydium",
      kind: "onchain",
      outAmount: String(d.outputAmount),
      outDecimals: req.outToken.decimals,
      minOutAmount: d.otherAmountThreshold ? String(d.otherAmountThreshold) : undefined,
      priceImpact: d.priceImpactPct != null ? String(d.priceImpactPct) : undefined,
      venues: dedupeVenues(
        (d.routePlan ?? []).map((r: any) => r?.poolId ? "Raydium pool" : undefined),
      ),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Aftermath — Sui aggregator, routing over Cetus/Turbos/etc. Sui coin types are
// `pkg::module::TYPE`, not addresses.
// ---------------------------------------------------------------------------

const aftermath: QuoteAdapter = {
  id: "aftermath",
  label: "Aftermath",
  blurb: "Sui aggregator",

  supports(req) {
    if (req.chain.code !== "sui") return "Sui only";
    // Sui coin types always contain `::`; an EVM address here means the token
    // picker and chain are out of step.
    for (const t of [req.inToken, req.outToken]) {
      if (!t.address.includes("::")) return `${t.symbol} is not a Sui coin type`;
    }
    return true;
  },

  async quote(req, signal) {
    const url = "https://aftermath.finance/api/router/trade-route";
    const json = await postJson(
      url,
      {
        coinInType: req.inToken.address,
        coinOutType: req.outToken.address,
        coinInAmount: toBaseUnits(req.amount, req.inToken.decimals),
      },
      signal,
    );

    // `coinOut.amount` is the total across all routes; routes[0] is only one
    // leg of a split, so taking it would understate the quote.
    //
    // Aftermath serialises BigInts with a trailing "n" — the amount arrives as
    // the string "7570648n", not "7570648". Left as-is it parses to NaN and the
    // row vanishes from the ranking without ever reporting a failure, so strip
    // it rather than trusting the JSON to be plain numeric.
    const raw = json.coinOut?.amount ?? json.routes?.[0]?.coinOut?.amount;
    const out = raw != null ? String(raw).replace(/n$/, "") : undefined;
    if (!out || !/^\d+$/.test(out)) {
      throw new NoRouteError(json.message ?? "no route");
    }

    return {
      source: "aftermath",
      label: "Aftermath",
      outAmount: out,
      outDecimals: req.outToken.decimals,
      venues: dedupeVenues(
        (json.routes?.[0]?.paths ?? []).map((p: any) => p?.protocolName),
      ),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// swap.coffee — TON aggregator. Amounts here are HUMAN-READABLE decimals, not
// base units, unlike almost everything else in this file.
// ---------------------------------------------------------------------------

const swapCoffee: QuoteAdapter = {
  id: "swapcoffee",
  label: "swap.coffee",
  blurb: "TON aggregator",

  supports(req) {
    if (req.chain.code !== "ton") return "TON only";
    return true;
  },

  async quote(req, signal) {
    const url = "https://backend.swap.coffee/v1/route";
    const asset = (addr: string) => ({
      blockchain: "ton",
      address: addr === TON_NATIVE ? "native" : addr,
    });

    const json = await postJson(
      url,
      {
        input_token: asset(req.inToken.address),
        output_token: asset(req.outToken.address),
        // Human-readable, NOT base units.
        input_amount: Number(req.amount),
        max_slippage: Number(req.slippage || "1") / 100,
      },
      signal,
    );

    const out = json.output_amount ?? json.paths?.[0]?.output_amount;
    if (out == null) throw new NoRouteError(json.error ?? "no route");

    return {
      source: "swapcoffee",
      label: "swap.coffee",
      // Decimal out -> base units, so ranking compares like with like.
      outAmount: toBaseUnits(String(out), req.outToken.decimals),
      outDecimals: req.outToken.decimals,
      venues: dedupeVenues(
        (json.paths ?? []).map((p: any) => p?.dex ?? p?.provider),
      ),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// STON.fi — TON DEX. Two quirks worth knowing:
//  - The endpoint is POST but takes its params in the QUERY STRING.
//  - There is no pool for bare TON; it routes through wrapped pTON, so a
//    native-TON side has to be substituted.
// ---------------------------------------------------------------------------

/** STON.fi's canonical pTON wrapper, used wherever a native-TON side appears. */
const STONFI_PTON = "EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsBc_DhVfRRtOEffLez";

const stonfi: QuoteAdapter = {
  id: "stonfi",
  label: "STON.fi",
  blurb: "TON DEX",

  supports(req) {
    if (req.chain.code !== "ton") return "TON only";
    return true;
  },

  async quote(req, signal) {
    const addr = (a: string) => (a === TON_NATIVE ? STONFI_PTON : a);
    // Params go in the query string even though the method is POST.
    const url =
      `https://api.ston.fi/v1/swap/simulate?` +
      qs({
        offer_address: addr(req.inToken.address),
        ask_address: addr(req.outToken.address),
        units: toBaseUnits(req.amount, req.inToken.decimals),
        slippage_tolerance: String(Number(req.slippage || "1") / 100),
      });

    const res = await fetch(url, { method: "POST", signal });
    const text = await res.text();
    let json: Record<string, any>;
    try {
      json = JSON.parse(text);
    } catch {
      throw new NoRouteError(`Non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok || !json.ask_units) {
      // Their errors arrive as a bare JSON string like "1010: Could not find
      // pool address for …" — surface the useful half.
      const msg = typeof json === "string" ? json : json.error ?? `HTTP ${res.status}`;
      throw new NoRouteError(String(msg).replace(/^\d+:\s*/, "").slice(0, 90));
    }

    return {
      source: "stonfi",
      label: "STON.fi",
      kind: "onchain",
      outAmount: String(json.ask_units),
      outDecimals: req.outToken.decimals,
      minOutAmount: json.min_ask_units ? String(json.min_ask_units) : undefined,
      priceImpact: json.price_impact != null ? String(json.price_impact) : undefined,
      venues: dedupeVenues(["STON.fi"]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Osmosis SQS — the Cosmos/IBC router. Assets are denoms (`uosmo`,
// `ibc/<hash>`, `factory/…`), and the input amount is CONCATENATED with its
// denom in a single param: `tokenIn=1000000uosmo`.
// ---------------------------------------------------------------------------

const osmosis: QuoteAdapter = {
  id: "osmosis",
  label: "Osmosis",
  blurb: "Cosmos router (SQS)",

  supports(req) {
    if (req.chain.code !== "osmosis") return "Osmosis only";
    return true;
  },

  async quote(req, signal) {
    const amount = toBaseUnits(req.amount, req.inToken.decimals);
    const url =
      `https://sqsprod.osmosis.zone/router/quote?` +
      qs({
        // Amount and denom are one value, not two params.
        tokenIn: `${amount}${req.inToken.address}`,
        tokenOutDenom: req.outToken.address,
      });

    const { json } = await getJson(url, signal);
    if (!json.amount_out) throw new NoRouteError(json.message ?? "no route");

    return {
      source: "osmosis",
      label: "Osmosis",
      kind: "onchain",
      outAmount: String(json.amount_out),
      outDecimals: req.outToken.decimals,
      priceImpact: json.price_impact != null ? String(json.price_impact) : undefined,
      venues: dedupeVenues(["Osmosis"]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Panora — Aptos aggregator. Its amounts are DECIMAL strings on both sides, so
// the request takes a human amount and the response needs converting back.
// ---------------------------------------------------------------------------

const panora: QuoteAdapter = {
  id: "panora",
  label: "Panora",
  blurb: "Aptos aggregator",

  supports(req) {
    if (req.chain.code !== "aptos") return "Aptos only";
    if (!PANORA_API_KEY) return "Set PANORA_API_KEY";
    return true;
  },

  async quote(req, signal) {
    const url =
      `https://api.panora.exchange/swap?` +
      qs({
        chainId: 1,
        fromTokenAddress: req.inToken.address,
        toTokenAddress: req.outToken.address,
        // Human-readable, not base units.
        fromTokenAmount: req.amount,
        toWalletAddress: req.account || "0x1",
        slippagePercentage: req.slippage || "1",
      });

    const res = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": PANORA_API_KEY, accept: "application/json" },
      signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    const best = json.quotes?.[0];
    if (!res.ok || !best?.toTokenAmount) {
      throw new NoRouteError(json.message ?? `HTTP ${res.status}`);
    }

    const decimals = json.toToken?.decimals ?? req.outToken.decimals;
    return {
      source: "panora",
      label: "Panora",
      outAmount: toBaseUnits(String(best.toTokenAmount), decimals),
      outDecimals: decimals,
      minOutAmount: best.minToTokenAmount
        ? toBaseUnits(String(best.minToTokenAmount), decimals)
        : undefined,
      priceImpact:
        best.priceImpact != null && Number(best.priceImpact) !== 0
          ? String(best.priceImpact)
          : undefined,
      venues: dedupeVenues([best.dexName ?? "Panora"]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// 1inch — the best-known EVM aggregator. Server-side only: api.1inch.dev sends
// no CORS headers and the key must not ship to the browser, so this goes
// through the proxy exactly like 0x does.
// ---------------------------------------------------------------------------

const ONEINCH_CHAINS = new Set([
  1, 56, 137, 42161, 10, 8453, 43114, 100, 250, 324, 59144, 8217, 1101, 534352,
  146, 130, 43111, 80094,
]);

const oneinch: QuoteAdapter = {
  id: "oneinch",
  label: "1inch",
  blurb: "No CORS — via proxy in the browser",

  supports(req) {
    if (!req.chain.evm) return `${req.chain.name} is not EVM`;
    if (req.chain.id == null || !ONEINCH_CHAINS.has(req.chain.id)) {
      return `${req.chain.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    const inBrowser = typeof window !== "undefined";
    const params = {
      chainId: req.chain.id ?? undefined,
      src: req.inToken.address,
      dst: req.outToken.address,
      amount: toBaseUnits(req.amount, req.inToken.decimals),
      includeProtocols: "true",
    };

    let json: Record<string, any>;
    let url: string;

    if (inBrowser) {
      if (!(await proxyAvailable())) {
        throw new NoRouteError("1inch needs the proxy (no CORS) — proxy unreachable");
      }
      url = proxyUrl("oneinch", params);
      const res = await fetch(url, { signal });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new NoRouteError(body?.error ?? `proxy returned ${res.status}`);
      }
      json = (await res.json()) as Record<string, any>;
    } else {
      if (!ONEINCH_API_KEY) {
        throw new NoRouteError("Set ONEINCH_API_KEY in .env (portal.1inch.dev)");
      }
      const { chainId, ...rest } = params;
      url = `https://api.1inch.dev/swap/v6.1/${chainId}/quote?` + qs(rest);
      json = (await getJson(url, signal, {
        Authorization: `Bearer ${ONEINCH_API_KEY}`,
      })).json;
    }

    const out = json.dstAmount ?? json.toAmount;
    if (!out) throw new NoRouteError(json.description ?? json.error ?? "no route");

    return {
      source: "oneinch",
      label: "1inch",
      outAmount: String(out),
      outDecimals: req.outToken.decimals,
      venues: dedupeVenues(
        (json.protocols ?? []).flat(2).map((p: any) => p?.name),
      ),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Fly (formerly Magpie) — same-chain AND cross-chain, keyless on the public
// host. `api.fly.trade` needs no key; `api.magpiefi.xyz` is the authenticated
// host and would need a Discord ticket, so we deliberately use the public one.
//
// An earlier attempt at fly.trade was dropped after it 403'd under fan-out
// load. The public aggregator host answers fine; if it starts rate-limiting
// again the adapter degrades to a normal error row rather than breaking others.
//
// Chains are named, not numbered.
// ---------------------------------------------------------------------------

const FLY_NETWORKS: Record<string, string> = {
  eth: "ethereum",
  bsc: "bsc",
  polygon: "polygon",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  avax: "avalanche",
  linea: "linea",
  scroll: "scroll",
  zksync: "zksync",
  mantle: "mantle",
  blast: "blast",
  bera: "berachain",
  sonic: "sonic",
  xdai: "gnosis",
  fantom: "fantom",
  cronos: "cronos",
  moonriver: "moonriver",
};

const fly: QuoteAdapter = {
  id: "fly",
  label: "Fly",
  blurb: "Magpie aggregator (keyless public host)",
  crossChain: true,

  supports(req) {
    for (const c of isCrossChain(req) ? [req.fromChain, req.toChain] : [req.chain]) {
      if (!FLY_NETWORKS[c.code]) return `${c.name} not covered`;
    }
    return true;
  },

  async quote(req, signal) {
    const cross = isCrossChain(req);
    const taker = req.account || PLACEHOLDER_TAKER;
    const slip = String(Number(req.slippage || "1") / 100);
    const amount = toBaseUnits(req.amount, req.inToken.decimals);

    // The two endpoints take DIFFERENT parameter names for the same things:
    // same-chain wants `network` + `sellAmount` + `slippage`, cross-chain wants
    // `fromNetwork`/`toNetwork` + `slippageIn`/`slippageOut`.
    const url = cross
      ? `https://api.fly.trade/aggregator/quote-in?` +
        qs({
          fromNetwork: FLY_NETWORKS[req.fromChain.code],
          toNetwork: FLY_NETWORKS[req.toChain.code],
          fromTokenAddress: req.inToken.address,
          toTokenAddress: req.outToken.address,
          sellAmount: amount,
          slippageIn: slip,
          slippageOut: slip,
          fromAddress: taker,
          toAddress: taker,
          gasless: "false",
        })
      : `https://api.fly.trade/aggregator/quote?` +
        qs({
          network: FLY_NETWORKS[req.chain.code],
          fromTokenAddress: req.inToken.address,
          toTokenAddress: req.outToken.address,
          sellAmount: amount,
          slippage: slip,
          fromAddress: taker,
          toAddress: taker,
          gasless: "false",
        });

    const { json } = await getJson(url, signal);
    if (!json.amountOut) {
      throw new NoRouteError(json.message ?? json.error ?? "no route");
    }

    return {
      source: "fly",
      label: "Fly",
      outAmount: String(json.amountOut),
      outDecimals: req.outToken.decimals,
      venues: dedupeVenues(
        (json.fees ?? []).some((f: any) => f?.type === "bridge")
          ? ["Fly bridge"]
          : ["Fly"],
      ),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Chainflip — native cross-chain AMM. The only source here that quotes native
// BITCOIN, which no aggregator in the set can reach.
//
// Assets are named by (chain, ticker), not by address: `srcChain=Ethereum&
// srcAsset=ETH`. That means it can only quote assets it lists, so the adapter
// maps by symbol and declines anything unlisted rather than guessing.
// ---------------------------------------------------------------------------

const CHAINFLIP_CHAINS: Record<string, string> = {
  eth: "Ethereum",
  arbitrum: "Arbitrum",
  solana: "Solana",
  bitcoin: "Bitcoin",
  polkadot: "Polkadot",
  base: "Base",
};

/** Assets Chainflip supports, per chain, keyed by our symbol. */
const CHAINFLIP_ASSETS: Record<string, Set<string>> = {
  Ethereum: new Set(["ETH", "USDC", "USDT", "FLIP"]),
  Arbitrum: new Set(["ETH", "USDC"]),
  Solana: new Set(["SOL", "USDC"]),
  Bitcoin: new Set(["BTC"]),
  Polkadot: new Set(["DOT"]),
  Base: new Set(["ETH", "USDC"]),
};

const chainflip: QuoteAdapter = {
  id: "chainflip",
  label: "Chainflip",
  blurb: "Native cross-chain AMM (incl. BTC)",
  crossChain: true,

  supports(req) {
    if (!isCrossChain(req)) return "Bridge only — same-chain not quoted";
    for (const [chain, token] of [
      [req.fromChain, req.inToken],
      [req.toChain, req.outToken],
    ] as const) {
      const name = CHAINFLIP_CHAINS[chain.code];
      if (!name) return `${chain.name} not covered`;
      // Symbol-keyed: it has no notion of an arbitrary token address.
      if (!CHAINFLIP_ASSETS[name]?.has(token.symbol.toUpperCase())) {
        return `${token.symbol} not listed on Chainflip ${name}`;
      }
    }
    return true;
  },

  async quote(req, signal) {
    const url =
      `https://chainflip-swap.chainflip.io/v2/quote?` +
      qs({
        srcChain: CHAINFLIP_CHAINS[req.fromChain.code],
        srcAsset: req.inToken.symbol.toUpperCase(),
        destChain: CHAINFLIP_CHAINS[req.toChain.code],
        destAsset: req.outToken.symbol.toUpperCase(),
        amount: toBaseUnits(req.amount, req.inToken.decimals),
      });

    const { json } = await getJson(url, signal);
    // The response is an ARRAY of quote types (REGULAR, DCA); take the best.
    const list: any[] = Array.isArray(json) ? json : [json];
    const best = list
      .filter((q) => q?.egressAmount)
      .sort((a, b) => (BigInt(b.egressAmount) > BigInt(a.egressAmount) ? 1 : -1))[0];
    if (!best) {
      throw new NoRouteError((json as any).message ?? "no route");
    }

    return {
      source: "chainflip",
      label: "Chainflip",
      outAmount: String(best.egressAmount),
      outDecimals: req.outToken.decimals,
      // Their own warning flag is worth surfacing rather than discarding.
      priceImpact: best.lowLiquidityWarning ? "low liquidity" : undefined,
      venues: dedupeVenues(["Chainflip"]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Cetus — Sui's largest DEX, read via its router. Independent of Aftermath, so
// the two cross-check each other on Sui.
// ---------------------------------------------------------------------------

const cetus: QuoteAdapter = {
  id: "cetus",
  label: "Cetus",
  blurb: "Sui DEX router",

  supports(req) {
    if (req.chain.code !== "sui") return "Sui only";
    for (const t of [req.inToken, req.outToken]) {
      if (!t.address.includes("::")) return `${t.symbol} is not a Sui coin type`;
    }
    return true;
  },

  async quote(req, signal) {
    const url =
      `https://api-sui.cetus.zone/router_v2/find_routes?` +
      qs({
        from: req.inToken.address,
        target: req.outToken.address,
        amount: toBaseUnits(req.amount, req.inToken.decimals),
        by_amount_in: "true",
        depth: 3,
      });

    const { json } = await getJson(url, signal);
    const out = json.data?.amount_out;
    if (json.code !== 200 || !out) {
      throw new NoRouteError(json.msg ?? "no route");
    }

    return {
      source: "cetus",
      label: "Cetus",
      kind: "onchain",
      outAmount: String(out),
      outDecimals: req.outToken.decimals,
      venues: dedupeVenues(["Cetus"]),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// DFlow — Solana aggregator. The public `dev-quote-api` host is keyless; the
// production host (`quote-api.dflow.net`) 403s without a key.
//
// Its response is Jupiter-shaped, which makes the mapping trivial.
// ---------------------------------------------------------------------------

const dflow: QuoteAdapter = {
  id: "dflow",
  label: "DFlow",
  blurb: "Solana aggregator (public host)",

  supports(req) {
    if (req.chain.code !== "solana") return "Solana only";
    return true;
  },

  async quote(req, signal) {
    const url =
      `https://dev-quote-api.dflow.net/quote?` +
      qs({
        inputMint: req.inToken.address,
        outputMint: req.outToken.address,
        amount: toBaseUnits(req.amount, req.inToken.decimals),
        slippageBps: Math.round(Number(req.slippage || "1") * 100),
      });

    const { json } = await getJson(url, signal);
    if (!json.outAmount) throw new NoRouteError(json.error ?? "no route");

    return {
      source: "dflow",
      label: "DFlow",
      outAmount: String(json.outAmount),
      outDecimals: req.outToken.decimals,
      minOutAmount: json.otherAmountThreshold ? String(json.otherAmountThreshold) : undefined,
      priceImpact:
        json.priceImpactPct != null && Number(json.priceImpactPct) !== 0
          ? String(json.priceImpactPct)
          : undefined,
      venues: dedupeVenues(
        (json.routePlan ?? []).map((r: any) => r?.swapInfo?.label),
      ),
      url,
      ms: 0,
      canExecute: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Ekubo — Starknet AMM. Everything is in the PATH, not query params:
//   /{chainId}/{amount}/{tokenIn}/{tokenOut}
// and the chain id is the decimal form of Starknet's felt id.
// ---------------------------------------------------------------------------

/** Decimal form of Starknet mainnet's chain id (SN_MAIN as a felt). */
const EKUBO_STARKNET_ID = "23448594291968334";

const ekubo: QuoteAdapter = {
  id: "ekubo",
  label: "Ekubo",
  blurb: "Starknet AMM",

  supports(req) {
    if (req.chain.code !== "starknet") return "Starknet only";
    return true;
  },

  async quote(req, signal) {
    const amount = toBaseUnits(req.amount, req.inToken.decimals);
    const url =
      `https://prod-api-quoter.ekubo.org/${EKUBO_STARKNET_ID}/${amount}/` +
      `${req.inToken.address}/${req.outToken.address}`;

    const { json } = await getJson(url, signal);
    const out = json.total_calculated;
    if (!out) throw new NoRouteError(json.message ?? "no route");

    return {
      source: "ekubo",
      label: "Ekubo",
      kind: "onchain",
      outAmount: String(out),
      outDecimals: req.outToken.decimals,
      venues: dedupeVenues(["Ekubo"]),
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
  wowmax,
  soroswap,
  // Added later: bridges first, then per-ecosystem sources.
  debridge,
  across,
  symbiosis,
  oneinch,
  raydium,
  aftermath,
  swapCoffee,
  stonfi,
  osmosis,
  panora,
  fly,
  chainflip,
  cetus,
  dflow,
  ekubo,
];

export function adapterById(id: string) {
  return ADAPTERS.find((a) => a.id === id);
}

export type { ChainInfo };
