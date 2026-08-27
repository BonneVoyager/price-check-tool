/**
 * Server-side proxy for the two sources a browser cannot reach directly.
 *
 * Runs as a Vercel Function on the Vercel deployment. The GitHub Pages build
 * calls it cross-origin; if it's unreachable, those two sources simply sit out
 * and the other 18 still quote (see PROXY_BASE in src/quotes/proxy.ts).
 *
 * Why each target needs a hop:
 *
 *  - OPENOCEAN: its Cloudflare rule is an ORIGIN ALLOWLIST. `vercel.app` is on
 *    it, `github.io` and `localhost` are not — measured, and no client-side
 *    header changes it (every referrerPolicy 403s from a blocked origin). A
 *    server request also gets to set `Referer`, which browsers forbid from JS.
 *
 *  - ZEROX: `api.0x.org` sends no `access-control-allow-origin` at all (its
 *    OPTIONS preflight 401s with no CORS headers), so a browser fetch fails
 *    regardless of the key. It is a server-side API by design. Keeping the key
 *    here also means it never ships to the client.
 *
 * Deliberately a strict allowlist, not an open relay: `target` selects from a
 * fixed table and only named query params are forwarded upstream. An open proxy
 * on a public URL would be abused.
 */

/** Upstream targets. Adding one means adding it here, not passing a URL in. */
const TARGETS = {
  openocean: {
    build(p: URLSearchParams) {
      const chain = p.get("chain") || "eth";
      const endpoint = p.get("endpoint") === "swap" ? "swap" : "quote";
      const qs = new URLSearchParams({
        inTokenAddress: p.get("in") ?? "",
        outTokenAddress: p.get("out") ?? "",
        amount: p.get("amount") ?? "1",
        gasPrice: p.get("gasPrice") ?? "3",
        slippage: p.get("slippage") ?? "1",
      });
      const account = p.get("account");
      if (endpoint === "swap" && account) qs.set("account", account);
      return {
        url: `https://open-api.openocean.finance/v4/${encodeURIComponent(chain)}/${endpoint}?${qs}`,
        headers: {
          accept: "application/json",
          // The header the WAF wants and a browser may not set.
          referer: "https://app.openocean.finance/",
          "user-agent": "price-check-tool/1.0",
        } as Record<string, string>,
      };
    },
  },

  zerox: {
    build(p: URLSearchParams) {
      const key = process.env.ZEROX_API_KEY ?? "";
      if (!key) throw new Error("ZEROX_API_KEY is not set on the proxy");
      const qs = new URLSearchParams({
        chainId: p.get("chainId") ?? "1",
        sellToken: p.get("sellToken") ?? "",
        buyToken: p.get("buyToken") ?? "",
        sellAmount: p.get("sellAmount") ?? "",
      });
      const taker = p.get("taker");
      if (taker) qs.set("taker", taker);
      const bps = p.get("slippageBps");
      if (bps) qs.set("slippageBps", bps);
      return {
        url: `https://api.0x.org/swap/allowance-holder/price?${qs}`,
        headers: {
          accept: "application/json",
          "0x-api-key": key,
          "0x-version": "v2",
        } as Record<string, string>,
      };
    },
  },

  /**
   * 0x Cross-Chain API — a DIFFERENT endpoint from the swap one above, with
   * different parameter names (originChain/destinationChain, originAddress).
   *
   * Unlike `/swap`, this endpoint IS CORS-open, so the browser could call it
   * directly — but only by shipping the API key in the bundle. It goes through
   * the proxy for the same reason the swap target does: to keep the key
   * server-side.
   */
  zeroxCross: {
    build(p: URLSearchParams) {
      const key = process.env.ZEROX_API_KEY ?? "";
      if (!key) throw new Error("ZEROX_API_KEY is not set on the proxy");
      const qs = new URLSearchParams({
        originChain: p.get("originChain") ?? "",
        destinationChain: p.get("destinationChain") ?? "",
        sellToken: p.get("sellToken") ?? "",
        buyToken: p.get("buyToken") ?? "",
        sellAmount: p.get("sellAmount") ?? "",
        originAddress: p.get("originAddress") ?? "",
        // Required enum: "price" ranks by output, which is what we compare on.
        sortQuotesBy: "price",
      });
      const dest = p.get("destinationAddress");
      if (dest) qs.set("destinationAddress", dest);
      return {
        url: `https://api.0x.org/cross-chain/quotes?${qs}`,
        headers: {
          accept: "application/json",
          "0x-api-key": key,
        } as Record<string, string>,
      };
    },
  },
} satisfies Record<
  string,
  { build(p: URLSearchParams): { url: string; headers: Record<string, string> } }
>;

type TargetName = keyof typeof TARGETS;

/** Same headers on every reply, so a cross-origin caller can always read it. */
const CORS = {
  // Public read-only price data; any origin may call it.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
} as const;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

/**
 * Web-standard handler.
 *
 * Vercel's Node runtime expects EITHER an object with a `fetch` method (the Web
 * Standard export) or a Node-style `(req, res)` function — a bare
 * `export default function(req: Request)` is read as the latter and breaks at
 * runtime, because `req` arrives as an IncomingMessage, not a Request.
 * So the logic lives in `handle` and is exported as `{ fetch }`.
 */
async function handle(req: Request): Promise<Response> {
  // Preflight — some callers send one even for a simple GET.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "GET") {
    return json({ error: "Only GET is supported" }, 405);
  }

  const params = new URL(req.url).searchParams;
  const target = params.get("target") as TargetName | null;

  if (!target || !(target in TARGETS)) {
    return json(
      { error: `Unknown target. Expected one of: ${Object.keys(TARGETS).join(", ")}` },
      400,
    );
  }

  let built: { url: string; headers: Record<string, string> };
  try {
    built = TARGETS[target].build(params);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  try {
    // Bound the upstream call so a hanging API can't hold the function open —
    // but keep it under vercel.json's maxDuration and above the client's own
    // per-source timeout, so the client decides when to give up, not us.
    const upstream = await fetch(built.url, {
      headers: built.headers,
      signal: AbortSignal.timeout(25_000),
    });
    const text = await upstream.text();

    // Pass the body through untouched — the adapters already parse these
    // shapes, and rewriting here would mean two places to keep in sync.
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        // Short shared cache: prices move, but this smooths repeat clicks and
        // keeps us further from any upstream rate limit.
        "cache-control": "public, s-maxage=5, stale-while-revalidate=10",
        ...CORS,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: `Upstream request failed: ${msg}` }, 502);
  }
}

export default { fetch: handle };

// Also export named HTTP methods, which Vercel accepts, so the shape is
// unambiguous regardless of which convention the runtime picks up.
export const GET = handle;
export const OPTIONS = handle;
