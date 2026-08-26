/**
 * Local dev server. NOT used in production.
 *
 * In production this app is pure static hosting: Vercel serves public/ from its
 * CDN and the page calls OpenOcean directly from the browser. No function.
 *
 * Locally that direct call half-works: `tokenList` and `gasPrice` return 200,
 * but `/quote` and `/swap` are 403 — Cloudflare rejects a
 * `http://localhost:3000` Referer while accepting an `https://…vercel.app` one.
 * So for dev only, we proxy those two through this server, which sets the
 * Referer that the CLI already uses. Same reason the old proxy existed; it just
 * isn't needed once deployed.
 *
 * The page tries direct-first and falls back to /api/* when that 403s, so the
 * production build has no dependency on any of this.
 */

import { getQuote, getSwapQuote } from "./src/openocean.ts";

const ROOT = new URL("./public/", import.meta.url);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 30,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- dev-only fallback for the Referer-gated endpoints -----------------
    if (path === "/api/quote" || path === "/api/swap") {
      const p = url.searchParams;
      const chain = p.get("chain") ?? "bsc";
      const base = {
        inTokenAddress: p.get("in") ?? "",
        outTokenAddress: p.get("out") ?? "",
        amount: p.get("amount") ?? "",
        gasPrice: p.get("gasPrice") ?? "3",
        slippage: p.get("slippage") ?? "1",
      };
      try {
        const data =
          path === "/api/swap"
            ? await getSwapQuote(chain, { ...base, account: p.get("account") ?? "" })
            : await getQuote(chain, base);
        return json(data);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    }

    // --- static files ------------------------------------------------------
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const file = Bun.file(new URL(rel, ROOT));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
});

console.log(`\n  Price Check Tool → http://localhost:${server.port}\n`);
