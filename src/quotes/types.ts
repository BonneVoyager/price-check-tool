/**
 * Multi-aggregator comparison: the shared contract.
 *
 * Every aggregator gets an adapter that normalises its wire format into
 * `NormalQuote`. Two design rules matter here:
 *
 * 1. NOT ALL SOURCES SUPPORT ALL CHAINS OR TOKENS. An adapter declares what it
 *    covers via `supports()`, and the runner turns a "no" into an explicit
 *    `unsupported` outcome rather than a failed request. The UI shows that as a
 *    quiet, non-alarming row — a source that legitimately can't serve a pair is
 *    NOT an error, and must not look like one.
 *
 * 2. NOT EVM-ONLY. Nothing here assumes 0x addresses or numeric chain ids.
 *    Chains are identified by our own `ChainInfo`, and each adapter maps that
 *    to whatever its API wants (path segment, numeric id, slug). Solana/Sui/
 *    Aptos/NEAR flow through unchanged; an adapter that can't handle them just
 *    reports `unsupported`.
 */

import type { ChainInfo } from "../chains.ts";

/** A venue/protocol the route passes through, normalised across sources. */
export interface NormalVenue {
  name: string;
  /** Share of the order, 0-100, when the source reports it. */
  percentage?: number;
}

/** One aggregator's answer to a quote request. */
export interface NormalQuote {
  /** Adapter id, e.g. "openocean". */
  source: string;
  /** Human-facing name, e.g. "OpenOcean". */
  label: string;
  /** Output in BASE UNITS, as a decimal string. */
  outAmount: string;
  /** Decimals of the output token, so the UI can format without guessing. */
  outDecimals: number;
  /** Worst-case output after slippage, base units, when provided. */
  minOutAmount?: string;
  estimatedGas?: string;
  /** Percentage string as the source reports it, e.g. "-0.12". */
  priceImpact?: string;
  venues: NormalVenue[];
  /** The exact upstream URL, so the UI stays a learning tool. */
  url: string;
  /** Wall-clock latency in ms, measured by the runner. */
  ms: number;
  /** True when this source can also hand back signable calldata. */
  canExecute: boolean;
  /**
   * How the price was obtained:
   *  - "api"     — an aggregator routing ACROSS venues (the default)
   *  - "venue"   — a single protocol pricing its OWN pools
   *  - "onchain" — a "venue" read straight from a contract via RPC, no API
   *  - "rfq"     — a market maker quoting a firm price
   *  - "intent"  — a solver auction; the price is a bid, not a route
   *
   * Surfaced as a tag in the UI, because it changes how much a number means:
   * a single venue is a baseline the aggregators should be beating, an intent
   * bid may not materialise, and an RFQ is firm but only for that taker.
   *
   * "venue" vs "onchain" is a narrower distinction than it looks: both price one
   * protocol's own liquidity, and they differ only in whether we read the chain
   * ourselves or ask that protocol's API. `onchain` is the stronger claim — no
   * third party is in the path at all — so it is reserved for adapters that
   * genuinely do `eth_call`. Tagging a vendor's HTTP quote as `onchain` would
   * overstate it, which is a mistake this file made for five sources.
   */
  kind?: "api" | "venue" | "onchain" | "rfq" | "intent";
}

/** Why a source produced no quote. Distinguishes "can't" from "broke". */
export type QuoteFailureKind =
  | "unsupported" // adapter declared it doesn't cover this chain/pair
  | "no-route" // supported, but no liquidity path found
  | "error" // network, auth, malformed response
  | "timeout";

export interface QuoteFailure {
  source: string;
  label: string;
  kind: QuoteFailureKind;
  message: string;
  url?: string;
  ms: number;
}

export type QuoteOutcome =
  | ({ ok: true } & NormalQuote)
  | ({ ok: false } & QuoteFailure);

/** What the UI asks for. Amounts are human-readable at this boundary. */
export interface QuoteRequest {
  /**
   * Source chain.
   *
   * `chain` is kept as an alias for `fromChain` so the 17 same-chain adapters
   * (and 70+ `req.chain` references) work unchanged — rewriting them all to
   * support a feature only 3 sources have would be a large, risky diff for no
   * behavioural gain. Same-chain is simply `fromChain === toChain`, which is
   * how `isCrossChain()` decides, so there is no parallel code path.
   */
  chain: ChainInfo;
  /** Source chain — same object as `chain`. */
  fromChain: ChainInfo;
  /** Destination chain. Equal to `fromChain` for a same-chain swap. */
  toChain: ChainInfo;
  inToken: { address: string; decimals: number; symbol: string };
  outToken: { address: string; decimals: number; symbol: string };
  /** Human-readable, e.g. "1.5". Adapters convert as their API requires. */
  amount: string;
  /** Percent, 1 = 1%. */
  slippage: string;
  /** Gwei. Only meaningful on EVM chains; adapters may ignore it. */
  gasPrice?: string;
  /** Optional wallet, needed by sources that only quote with an address. */
  account?: string;
}

/** True when the request bridges chains rather than swapping within one. */
export function isCrossChain(req: QuoteRequest): boolean {
  return req.fromChain.code !== req.toChain.code;
}

export interface QuoteAdapter {
  id: string;
  label: string;
  /**
   * Set on the three sources that can bridge (LI.FI, Relay, NEAR Intents).
   * The runner rejects a cross-chain request for everything else up front, so
   * a same-chain adapter never has to think about it.
   */
  crossChain?: boolean;
  /** Short note for the UI: what this source is, in a few words. */
  blurb: string;
  /**
   * Can this adapter serve the request? Return a reason string when not, so
   * the UI can explain *why* a source is sitting out.
   */
  supports(req: QuoteRequest): true | string;
  /** Perform the quote. Throws on failure; the runner classifies it. */
  quote(req: QuoteRequest, signal: AbortSignal): Promise<NormalQuote>;
}

/** Thrown by adapters when the API explicitly reports no route. */
export class NoRouteError extends Error {
  constructor(message = "No route found") {
    super(message);
    this.name = "NoRouteError";
  }
}
