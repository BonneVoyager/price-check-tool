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
  /**
   * 1inch — `api.1inch.dev` sends no CORS headers, and the key is a personal
   * one from portal.1inch.dev, so both reasons point at the proxy.
   *
   * The chain id is a PATH segment here, not a query param.
   */
  oneinch: {
    build(p: URLSearchParams) {
      const key = process.env.ONEINCH_API_KEY ?? "";
      if (!key) throw new Error("ONEINCH_API_KEY is not set on the proxy");
      const chainId = p.get("chainId") ?? "1";
      if (!/^\d+$/.test(chainId)) throw new Error("bad chainId");
      const qs = new URLSearchParams({
        src: p.get("src") ?? "",
        dst: p.get("dst") ?? "",
        amount: p.get("amount") ?? "",
        includeProtocols: "true",
      });
      return {
        url: `https://api.1inch.dev/swap/v6.1/${chainId}/quote?${qs}`,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${key}`,
        } as Record<string, string>,
      };
    },
  },
  /**
   * NEAR Intents (1Click) — POST, unlike every other target.
   *
   * The hop exists ONLY to keep the JWT server-side: 1Click is CORS-open and
   * explicitly allows `x-api-key` from a browser. But the key is worth hiding
   * because it changes the price — an unauthenticated quote silently carries a
   * 0.2% platform fee inside `amountOut`.
   *
   * The body is REBUILT here from named params rather than forwarded, so this
   * stays an allowlist and not a relay: a caller cannot reach an arbitrary
   * upstream or smuggle extra fields in.
   */
  oneclick: {
    build(p: URLSearchParams) {
      const key = process.env.ONECLICK_API_KEY ?? "";
      if (!key) throw new Error("ONECLICK_API_KEY is not set on the proxy");

      const need = (n: string) => {
        const v = p.get(n);
        if (!v) throw new Error(`missing ${n}`);
        return v;
      };
      const slippage = Number(p.get("slippageTolerance") ?? "100");
      if (!Number.isFinite(slippage) || slippage < 0 || slippage > 10_000) {
        throw new Error("bad slippageTolerance");
      }
      const depositMode = p.get("depositMode") === "MEMO" ? "MEMO" : "SIMPLE";

      return {
        url: `https://1click.chaindefuser.com/v0/quote`,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": key,
        } as Record<string, string>,
        body: JSON.stringify({
          // Price-only. The proxy must never be able to commit a real swap, so
          // `dry` is hardcoded rather than taken from the caller.
          dry: true,
          depositMode,
          swapType: "EXACT_INPUT",
          slippageTolerance: Math.round(slippage),
          originAsset: need("originAsset"),
          depositType: "ORIGIN_CHAIN",
          destinationAsset: need("destinationAsset"),
          amount: need("amount"),
          refundTo: need("refundTo"),
          refundType: "ORIGIN_CHAIN",
          recipient: need("recipient"),
          recipientType: "DESTINATION_CHAIN",
          deadline: need("deadline"),
        }),
      };
    },
  },
  /**
   * Haiku — POST, and needed for CORS rather than for a key: api.haiku.trade
   * sends no access-control headers at all (its preflight 500s), so a browser
   * cannot reach it directly. It currently answers unauthenticated.
   *
   * Rebuilt server-side from named params, like the other POST target, so the
   * caller cannot smuggle a different intent through.
   */
  haiku: {
    build(p: URLSearchParams) {
      const need = (n: string) => {
        const v = p.get(n);
        if (!v) throw new Error(`missing ${n}`);
        return v;
      };
      const slippage = Number(p.get("slippage") ?? "0.01");
      if (!Number.isFinite(slippage) || slippage < 0 || slippage > 1) {
        throw new Error("bad slippage");
      }
      const key = process.env.HAIKU_API_KEY ?? "";
      return {
        url: "https://api.haiku.trade/v1/quote",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          // Only sent if one is configured; the endpoint works without it today.
          ...(key ? { "api-key": key } : {}),
        } as Record<string, string>,
        body: JSON.stringify({
          intent: {
            slippage,
            receiver: need("receiver"),
            inputPositions: {
              [`${need("fromChain")}:${need("fromToken").toLowerCase()}`]:
                need("amount"),
            },
            targetWeights: {
              [`${need("toChain")}:${need("toToken").toLowerCase()}`]: 1,
            },
          },
        }),
      };
    },
  },
  /**
   * Pegaroute — GET, proxied purely to keep the API key server-side.
   *
   * The key is environment-scoped (a stagenet key is rejected by the production
   * host), so PEGAROUTE_BASE travels with it and both are read from env here.
   */
  pegaroute: {
    build(p: URLSearchParams) {
      const key = process.env.PEGAROUTE_API_KEY ?? "";
      if (!key) throw new Error("PEGAROUTE_API_KEY is not set on the proxy");
      const base =
        process.env.PEGAROUTE_BASE ?? "https://stagenet-app.pegaroute.com/api";
      const need = (n: string) => {
        const v = p.get(n);
        if (!v) throw new Error(`missing ${n}`);
        return v;
      };
      const qs = new URLSearchParams({
        fromChain: need("fromChain"),
        fromToken: need("fromToken"),
        toChain: need("toChain"),
        toToken: need("toToken"),
        amount: need("amount"),
      });
      for (const opt of ["senderAddress", "destinationAddress"]) {
        const v = p.get(opt);
        if (v) qs.set(opt, v);
      }
      return {
        url: `${base}/quote?${qs}`,
        headers: {
          accept: "application/json",
          "X-API-Key": key,
        } as Record<string, string>,
      };
    },
  },
} satisfies Record<
  string,
  {
    build(p: URLSearchParams): {
      url: string;
      headers: Record<string, string>;
      body?: string;
    };
  }
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

  let built: { url: string; headers: Record<string, string>; body?: string };
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
      // A target that builds a body is a POST; the rest stay GETs.
      method: built.body ? "POST" : "GET",
      headers: built.headers,
      body: built.body,
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
