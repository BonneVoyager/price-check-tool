/**
 * Dev server + thin proxy to the OpenOcean API.
 *
 * Why proxy instead of calling OpenOcean from the browser directly?
 *   1. CORS — open-api.openocean.finance does not reliably send
 *      Access-Control-Allow-Origin, so browser fetches can fail.
 *   2. The WAF is friendlier to server-side calls than to XHR from a page.
 *   3. It lets us echo back the exact upstream URL, which makes the UI a
 *      genuine learning tool rather than a black box.
 *
 * Uses Bun.serve's `routes` — no express, no cors package.
 */

import { CHAINS, findChain } from "./chains.ts";
import {
  getGasPrice,
  getQuote,
  getSwapQuote,
  getAllowance,
  OpenOceanError,
  BASE_URL,
} from "./openocean.ts";
import { chainsWithIcons, loadTokens, resolveToken } from "./tokens.ts";
import { dexesUsed, flattenPath, isSplitRoute, routingAdvantage } from "./routes.ts";
import type { OoQuote, OoSwap } from "./types.ts";

const PORT = Number(process.env.PORT ?? 3000);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Turn any thrown value into a useful JSON error for the frontend. */
function errorResponse(err: unknown) {
  if (err instanceof OpenOceanError) {
    return json({ error: err.message, upstreamStatus: err.status, body: err.body }, 502);
  }
  return json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

/** Reconstruct the upstream URL so the UI can display exactly what we called. */
function upstreamUrl(chain: string, endpoint: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return `${BASE_URL}/${chain}/${endpoint}${qs ? `?${qs}` : ""}`;
}

/**
 * Resolve in/out token inputs (symbol OR address) against the live token list,
 * so the frontend can send "USDC" and never hardcode an address. Returns the
 * resolved addresses plus the token records, for decimals on the way back.
 */
async function resolveTokens(chain: string, inRaw: string, outRaw: string) {
  const tokens = await loadTokens(chain);
  const inTok = resolveToken(tokens, inRaw);
  const outTok = resolveToken(tokens, outRaw);

  // Unknown symbols are a user error worth naming; an unrecognised 0x address
  // is still passed through, since the list doesn't cover every valid token.
  const unknown: string[] = [];
  if (!inTok && !inRaw.startsWith("0x")) unknown.push(inRaw);
  if (!outTok && !outRaw.startsWith("0x")) unknown.push(outRaw);

  return {
    inAddress: inTok?.address ?? inRaw,
    outAddress: outTok?.address ?? outRaw,
    inTok,
    outTok,
    unknown,
  };
}

/** Attach the derived route analysis to a quote/swap response. */
function withAnalysis(data: OoQuote | OoSwap) {
  return {
    ...data,
    _analysis: {
      dexesUsed: dexesUsed(data.path),
      isSplitRoute: isSplitRoute(data.path),
      hops: flattenPath(data.path),
      advantage: routingAdvantage(data),
    },
  };
}

const server = Bun.serve({
  port: PORT,
  // A cold /api/chainIcons fans out to ~30 upstream token lists; the 10s
  // default would time the response out before they all land.
  idleTimeout: 30,
  routes: {
    /**
     * Read from disk per request rather than baking a Response at startup —
     * otherwise editing index.html does nothing until the server restarts,
     * which is a confusing way to lose ten minutes.
     */
    "/": async () =>
      new Response(Bun.file("public/index.html"), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      }),

    /**
     * Chain list. Icons are resolved from token lists, which means 42 upstream
     * fetches on a cold cache — too slow to block the page on. So this returns
     * immediately without icons, and the UI fills them in from /api/chainIcons.
     */
    "/api/chains": () => json(CHAINS),

    /**
     * Chain logos, resolved lazily so the picker can render instantly and
     * upgrade initials to real icons when this resolves. Warm cache: instant.
     */
    "/api/chainIcons": async () => {
      try {
        const withIcons = await chainsWithIcons(CHAINS);
        const map: Record<string, string> = {};
        for (const c of withIcons) if (c.icon) map[c.code] = c.icon;
        return json(map);
      } catch (err) {
        return errorResponse(err);
      }
    },

    /**
     * Normalised token list for the UI: native coin first, then the API's
     * "hot" tokens, then by USD price. Cached server-side for 10 minutes.
     */
    "/api/tokens": async (req) => {
      const chain = new URL(req.url).searchParams.get("chain") ?? "bsc";
      try {
        const tokens = await loadTokens(chain);
        return json({
          url: upstreamUrl(chain, "tokenList", {}),
          chain,
          count: tokens.length,
          tokens,
        });
      } catch (err) {
        return errorResponse(err);
      }
    },

    "/api/gasPrice": async (req) => {
      const chain = new URL(req.url).searchParams.get("chain") ?? "bsc";
      try {
        return json({ url: upstreamUrl(chain, "gasPrice", {}), data: await getGasPrice(chain) });
      } catch (err) {
        return errorResponse(err);
      }
    },

    "/api/allowance": async (req) => {
      const p = new URL(req.url).searchParams;
      const chain = p.get("chain") ?? "bsc";
      const account = p.get("account") ?? "";
      const inTokenAddress = p.get("inTokenAddress") ?? "";
      if (!account || !inTokenAddress) {
        return json({ error: "account and inTokenAddress are required" }, 400);
      }
      try {
        const data = await getAllowance(chain, { account, inTokenAddress });
        return json({ url: upstreamUrl(chain, "allowance", { account, inTokenAddress }), data });
      } catch (err) {
        return errorResponse(err);
      }
    },

    /** Price only. No wallet needed. Includes the per-DEX comparison. */
    "/api/quote": async (req) => {
      const p = new URL(req.url).searchParams;
      const chain = p.get("chain") ?? "bsc";
      const inRaw = p.get("in") ?? p.get("inTokenAddress") ?? "";
      const outRaw = p.get("out") ?? p.get("outTokenAddress") ?? "";
      const amount = p.get("amount") ?? "";

      if (!inRaw || !outRaw || !amount) {
        return json({ error: "in, out and amount are required" }, 400);
      }
      try {
        const r = await resolveTokens(chain, inRaw, outRaw);
        if (r.unknown.length) {
          return json({ error: `Unknown token(s) on ${chain}: ${r.unknown.join(", ")}` }, 400);
        }
        const params = {
          inTokenAddress: r.inAddress,
          outTokenAddress: r.outAddress,
          amount,
          gasPrice: p.get("gasPrice") ?? "3",
          slippage: p.get("slippage") ?? "1",
        };
        const data = await getQuote(chain, params);
        return json({
          url: upstreamUrl(chain, "quote", params),
          resolved: { in: r.inTok, out: r.outTok },
          data: withAnalysis(data),
        });
      } catch (err) {
        return errorResponse(err);
      }
    },

    /** Executable route: adds calldata. Requires `account`. */
    "/api/swap": async (req) => {
      const p = new URL(req.url).searchParams;
      const chain = p.get("chain") ?? "bsc";
      const inRaw = p.get("in") ?? p.get("inTokenAddress") ?? "";
      const outRaw = p.get("out") ?? p.get("outTokenAddress") ?? "";
      const account = p.get("account") ?? "";

      if (!account) {
        return json({ error: "account is required for /swap — use /quote for price-only" }, 400);
      }
      try {
        const r = await resolveTokens(chain, inRaw, outRaw);
        if (r.unknown.length) {
          return json({ error: `Unknown token(s) on ${chain}: ${r.unknown.join(", ")}` }, 400);
        }
        const params = {
          inTokenAddress: r.inAddress,
          outTokenAddress: r.outAddress,
          amount: p.get("amount") ?? "",
          gasPrice: p.get("gasPrice") ?? "3",
          slippage: p.get("slippage") ?? "1",
          account,
        };
        const data = await getSwapQuote(chain, params);
        return json({
          url: upstreamUrl(chain, "swap", params),
          resolved: { in: r.inTok, out: r.outTok },
          data: withAnalysis(data),
        });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  OpenOcean playground → http://localhost:${server.port}\n`);
