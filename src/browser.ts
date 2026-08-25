/**
 * Browser entrypoint — the whole app, no server.
 *
 * The proxy this replaced existed for two assumed reasons, both since
 * disproven by testing against a deployed origin:
 *
 *   1. "CORS blocks browser calls."  It doesn't. open-api.openocean.finance
 *      answers cross-origin requests with 200 + JSON.
 *   2. "The WAF needs a Referer we can't set from JS."  We can't set it — the
 *      browser forbids it — but we don't need to: the browser sends its own
 *      Referer automatically, which is exactly what the WAF wants.
 *
 * So this is a static site: no function, no cold start, no proxy hop. The
 * modules below are the same ones the CLI uses, bundled for the browser.
 */

import { CHAINS, findChain, type ChainInfo } from "./chains.ts";
import { CHAIN_MARKS } from "./chain-marks.ts";
import {
  getGasPrice,
  getQuote,
  getSwapQuote,
  BASE_URL,
  OpenOceanError,
} from "./openocean.ts";
import { chainIcon, loadTokens, resolveToken, type UiToken } from "./tokens.ts";
import { dexesUsed, flattenPath, isSplitRoute, routingAdvantage } from "./routes.ts";
import type { OoQuote, OoSwap } from "./types.ts";

/** Same `_analysis` shape the server used to attach, computed client-side. */
export function analyse(data: OoQuote | OoSwap) {
  return {
    dexesUsed: dexesUsed(data.path),
    isSplitRoute: isSplitRoute(data.path),
    hops: flattenPath(data.path),
    advantage: routingAdvantage(data),
  };
}

/** Rebuild the upstream URL for display, matching the old server response. */
export function upstreamUrl(
  chain: string,
  endpoint: string,
  params: Record<string, string>,
) {
  const qs = new URLSearchParams(params).toString();
  return `${BASE_URL}/${chain}/${endpoint}${qs ? `?${qs}` : ""}`;
}

/**
 * Chain icons. On the server this was one endpoint that resolved all 42 up
 * front; in the browser we resolve lazily per chain so nothing blocks paint,
 * and built-in marks are free.
 */
export async function iconFor(chain: ChainInfo) {
  return chainIcon(chain);
}

/** Everything the page needs, on one namespace. */
export const OO = {
  CHAINS,
  CHAIN_MARKS,
  findChain,
  loadTokens,
  resolveToken,
  getQuote,
  getSwapQuote,
  getGasPrice,
  analyse,
  upstreamUrl,
  iconFor,
  OpenOceanError,
};

// Exposed for the inline script in index.html. Typed as `unknown` here because
// `typeof OO` would re-infer the literal shape and clash with itself.
(window as unknown as Record<string, unknown>).OO = OO;

export type { UiToken, ChainInfo };
