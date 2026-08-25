/**
 * Types for the OpenOcean v4 API.
 *
 * Hand-written from the docs + observed responses:
 *   https://docs.openocean.finance/docs/overview/transaction-example
 *
 * Every v4 response is wrapped in { code, data }. `code: 200` means success;
 * anything else puts a human-readable string in the top-level `error`/`message`.
 */

export interface OoEnvelope<T> {
  code: number;
  data: T;
  error?: string;
  message?: string;
}

/** A token as returned by /tokenList. */
export interface OoToken {
  id?: number;
  code?: string;
  name: string;
  address: string;
  decimals: number;
  symbol: string;
  icon?: string;
  chain?: string;
  /** Present on some chains; USD price as a string. */
  usd?: string;
}

/** /gasPrice — shape differs between EIP-1559 and legacy chains. */
export interface OoGasPrice {
  standard?: number | string | OoGasTier;
  fast?: number | string | OoGasTier;
  instant?: number | string | OoGasTier;
  /** Legacy chains sometimes return a single value under `gasPrice`. */
  gasPrice?: number | string;
  without_decimals?: Record<string, string>;
}

export interface OoGasTier {
  maxPriorityFeePerGas?: string;
  maxFeePerGas?: string;
  legacyGasPrice?: string;
}

/**
 * One hop / venue in the computed route.
 *
 * NOTE: the `path` object is the interesting part for route analysis. OpenOcean
 * splits an order across DEXes, so `routes` is a list of parallel sub-routes,
 * each with its own percentage of the input amount.
 */
export interface OoPath {
  from: string;
  to: string;
  parts: number;
  routes: OoRoute[];
}

export interface OoRoute {
  parts: number;
  percentage: number;
  subRoutes: OoSubRoute[];
}

export interface OoSubRoute {
  from: string;
  to: string;
  parts: number;
  dexes: OoDexShare[];
}

export interface OoDexShare {
  dex: string;
  id: string;
  parts: number;
  percentage: number;
  /** Some responses include the fee tier for concentrated-liquidity pools. */
  fee?: number | string;
}

/** GET /v4/{chain}/quote */
export interface OoQuote {
  inToken: OoToken;
  outToken: OoToken;
  /** Base units (wei-like), as a decimal string. */
  inAmount: string;
  outAmount: string;
  estimatedGas: string | number;
  /** Percentage as a string, e.g. "-0.15". Absent on some chains. */
  price_impact?: string;
  path?: OoPath;
  /** Per-DEX comparison list; only returned by /quote, never by /swap_quote. */
  dexes?: OoDexQuote[];
  save?: number;
  isProxy?: boolean;
}

/** An individual DEX's standalone output, used to show what routing saved. */
export interface OoDexQuote {
  dexIndex: number;
  dexCode: string;
  swapAmount: string;
  /** Only present when the DEX cannot serve the pair. */
  error?: string;
}

/**
 * GET /v4/{chain}/swap  (a.k.a. swap_quote in v3)
 *
 * Superset of the quote response plus the signable transaction fields.
 */
export interface OoSwap extends OoQuote {
  /** Router contract to send the tx to. */
  to: string;
  /** The connected wallet. */
  from: string;
  /** Native-token value in base units; "0" for ERC-20 -> * swaps. */
  value: string;
  /** ABI-encoded calldata. */
  data: string;
  gasPrice: string;
  /** Worst-case output after slippage, in base units. */
  minOutAmount?: string;
  chainId?: number;
}

/** GET /v4/{chain}/allowance — returns an array, one entry per token queried. */
export interface OoAllowance {
  symbol?: string;
  /** Raw allowance in base units. */
  allowance: string;
  raw?: string;
}
