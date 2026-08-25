/**
 * Zero-dependency OpenOcean v4 client.
 *
 * Base URL:  https://open-api.openocean.finance/v4/{chain}/{endpoint}
 *
 * ---------------------------------------------------------------------------
 * THE AMOUNT GOTCHA (read this before debugging a wrong number)
 * ---------------------------------------------------------------------------
 * v4 `quote` / `swap` take `amount` as a HUMAN-READABLE decimal string, NOT
 * base units. To swap 1.5 USDC you send `amount=1.5`, never `amount=1500000`.
 *
 * The RESPONSE, however, is in base units: `outAmount` for a 6-decimals token
 * comes back as "1500000". So you scale on the way out but not on the way in.
 * This asymmetry is the single most common v4 integration bug. `toBaseUnits`
 * and `fromBaseUnits` below exist so you never hand-roll it.
 *
 * (v3 was the opposite — it took base units. Ported v3 code is the usual
 * source of amounts that are off by 10^decimals.)
 */

import type {
  OoAllowance,
  OoEnvelope,
  OoGasPrice,
  OoQuote,
  OoSwap,
  OoToken,
} from "./types.ts";

export const BASE_URL = "https://open-api.openocean.finance/v4";

/**
 * Sentinel address OpenOcean uses for a chain's native coin (ETH, BNB, ...).
 * Pass this as in/outTokenAddress to swap the gas token itself.
 */
export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export class OpenOceanError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "OpenOceanError";
  }
}

/** Drop undefined/null/"" so we never send `&slippage=undefined`. */
function toQuery(params: Record<string, string | number | undefined | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  return q.toString();
}

/**
 * Cloudflare guards the /quote and /swap paths with a rule that rejects
 * requests carrying no `Referer`, serving an HTML "Just a moment..." challenge
 * with HTTP 403. /gasPrice and /tokenList are NOT guarded, which is what makes
 * the failure so confusing — half your integration works.
 *
 * Verified empirically: `Referer` alone flips the same URL from 403 to 200.
 * An `Origin` header alone does NOT work, and the client IP is irrelevant.
 * A browser page on an openocean.finance origin sends this automatically,
 * which is why the docs never mention it.
 *
 * We send a User-Agent too, purely so the traffic is identifiable rather than
 * anonymous — it isn't required to pass.
 */
const IN_BROWSER = typeof window !== "undefined";

/**
 * `Referer` and `User-Agent` are FORBIDDEN HEADERS in browsers — the fetch spec
 * makes them unsettable from JS, and passing them can also push a simple GET
 * into a CORS preflight for no benefit. In a browser we send only `accept` and
 * let the page's own Referer satisfy the WAF (verified: /quote, /swap,
 * /tokenList and /gasPrice all return 200 from a deployed origin).
 *
 * Server-side (CLI, or any non-browser runtime) there is no automatic Referer,
 * so we must set it explicitly or /quote and /swap 403.
 */
const WAF_HEADERS: Record<string, string> = IN_BROWSER
  ? { accept: "application/json, text/plain, */*" }
  : {
      accept: "application/json, text/plain, */*",
      referer: "https://app.openocean.finance/",
      "user-agent": "openocean-playground/1.0 (+bun)",
    };

async function request<T>(
  chain: string,
  endpoint: string,
  params: Record<string, string | number | undefined | null> = {},
): Promise<T> {
  const qs = toQuery(params);
  const url = `${BASE_URL}/${chain}/${endpoint}${qs ? `?${qs}` : ""}`;

  const res = await fetch(url, { headers: WAF_HEADERS });

  // Cloudflare fronts this API and serves an HTML challenge to clients it
  // doesn't like. Detect that explicitly — otherwise it surfaces as a baffling
  // "Unexpected token '<'" JSON parse error.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const text = await res.text();
    const looksLikeChallenge =
      text.includes("Just a moment") || text.includes("cf-browser-verification");
    throw new OpenOceanError(
      looksLikeChallenge
        ? `Cloudflare blocked /${endpoint} (HTTP ${res.status}) and returned an HTML ` +
          "challenge instead of JSON. This endpoint requires a Referer header — " +
          "check that WAF_HEADERS in src/openocean.ts is still being sent."
        : `Expected JSON from ${endpoint}, got ${contentType || "unknown"} (HTTP ${res.status}).`,
      res.status,
      text.slice(0, 400),
    );
  }

  const json = (await res.json()) as OoEnvelope<T>;

  // v4 can return HTTP 200 with a non-200 `code` in the envelope, so check both.
  if (!res.ok || (json.code !== undefined && json.code !== 200)) {
    const detail =
      json.error ?? json.message ?? `code ${json.code} (HTTP ${res.status})`;
    throw new OpenOceanError(
      `OpenOcean ${endpoint} failed: ${detail}`,
      res.status,
      json,
    );
  }

  return json.data;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** All tokens OpenOcean indexes for a chain. */
export function getTokenList(chain: string) {
  return request<OoToken[]>(chain, "tokenList");
}

/**
 * Recommended gas price tiers, in GWEI.
 *
 * Feed the result straight back into `quote`/`swap` as `gasPrice` — those
 * endpoints also expect GWEI, not wei.
 */
export function getGasPrice(chain: string) {
  return request<OoGasPrice>(chain, "gasPrice");
}

/** How much of `inTokenAddress` the router is already approved to spend. */
export function getAllowance(
  chain: string,
  params: { account: string; inTokenAddress: string },
) {
  return request<OoAllowance[]>(chain, "allowance", params);
}

export interface QuoteParams {
  inTokenAddress: string;
  outTokenAddress: string;
  /** HUMAN-READABLE units. "1.5", not "1500000". See the note at the top. */
  amount: string | number;
  /** GWEI. */
  gasPrice: string | number;
  /** Percent: 1 = 1%. */
  slippage?: string | number;
  /** Restrict routing to these DEX ids (comma-separated). */
  enabledDexIds?: string;
  /** Exclude these DEX ids (comma-separated). */
  disabledDexIds?: string;
}

/**
 * Price discovery. Returns the best `outAmount`, the chosen `path`, and a
 * `dexes` array of per-venue quotes.
 *
 * Use this for display and for comparing venues. It does NOT return calldata,
 * and it does not require a wallet address.
 */
export function getQuote(chain: string, params: QuoteParams) {
  return request<OoQuote>(chain, "quote", { ...params });
}

export interface SwapParams extends QuoteParams {
  /** Wallet that will sign and send. Required — this is what /quote lacks. */
  account: string;
  /** Optional referrer address for fee sharing. */
  referrer?: string;
}

/**
 * The executable route: everything `quote` returns, plus `to`, `data`, `value`
 * and `gasPrice` ready to sign.
 *
 * This is the endpoint you actually swap with. Because it recomputes the route
 * at call time, its `outAmount` can differ slightly from a `quote` taken a
 * moment earlier — always show the user the number from THIS response.
 */
export function getSwapQuote(chain: string, params: SwapParams) {
  return request<OoSwap>(chain, "swap", { ...params });
}

// ---------------------------------------------------------------------------
// Decimal helpers (no bignumber.js — native BigInt is enough)
// ---------------------------------------------------------------------------

/** "1.5" + 6 decimals -> "1500000". Truncates excess precision. */
export function toBaseUnits(amount: string, decimals: number): string {
  const [whole = "0", frac = ""] = amount.trim().split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return BigInt(combined || "0").toString();
}

/** "1500000" + 6 decimals -> "1.5". Trims trailing zeros. */
export function fromBaseUnits(base: string | number, decimals: number): string {
  const s = BigInt(base ?? 0).toString();
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
