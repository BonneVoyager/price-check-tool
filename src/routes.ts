/**
 * Route analysis helpers.
 *
 * The `path` field in a quote/swap response is deeply nested because OpenOcean
 * splits one order across several DEXes *in parallel*, and each of those
 * parallel legs can itself be a *sequence* of hops:
 *
 *   path
 *    └─ routes[]        parallel splits of the input amount (percentage each)
 *        └─ subRoutes[] sequential hops for that split (A->B, then B->C)
 *            └─ dexes[] the venues serving that one hop (split again)
 *
 * These helpers flatten it into something you can print or render.
 */

import type { OoPath, OoQuote } from "./types.ts";
import { fromBaseUnits } from "./openocean.ts";

export interface FlatHop {
  /** Which parallel split this belongs to (0-indexed). */
  routeIndex: number;
  /** Share of the *total* input amount taken by this split. */
  routePercentage: number;
  /** Position within the split's sequence of hops. */
  hopIndex: number;
  from: string;
  to: string;
  /** Venues serving this hop, with their share of the hop. */
  venues: { dex: string; percentage: number }[];
}

/** Flatten the nested path into one row per hop. */
export function flattenPath(path: OoPath | undefined): FlatHop[] {
  if (!path?.routes?.length) return [];

  const hops: FlatHop[] = [];
  path.routes.forEach((route, routeIndex) => {
    route.subRoutes?.forEach((sub, hopIndex) => {
      hops.push({
        routeIndex,
        routePercentage: route.percentage,
        hopIndex,
        from: sub.from,
        to: sub.to,
        venues: (sub.dexes ?? []).map((d) => ({
          dex: d.dex ?? d.id,
          percentage: d.percentage,
        })),
      });
    });
  });
  return hops;
}

/** Every distinct DEX touched by the route. */
export function dexesUsed(path: OoPath | undefined): string[] {
  const seen = new Set<string>();
  for (const hop of flattenPath(path)) {
    for (const v of hop.venues) seen.add(v.dex);
  }
  return [...seen].sort();
}

/**
 * True when the order is split across multiple venues or hops — i.e. the
 * aggregator actually did something a single-pool swap could not.
 */
export function isSplitRoute(path: OoPath | undefined): boolean {
  const hops = flattenPath(path);
  return hops.length > 1 || hops.some((h) => h.venues.length > 1);
}

/**
 * Compare the aggregated `outAmount` against the best single DEX from the
 * `dexes` array, so you can see what routing bought you.
 *
 * Returns null when the response carried no `dexes` list (only /quote has it).
 */
export function routingAdvantage(quote: OoQuote): {
  bestSingleDex: string;
  bestSingleOut: string;
  aggregatedOut: string;
  improvementPct: number;
} | null {
  const candidates = (quote.dexes ?? []).filter(
    (d) => !d.error && d.swapAmount && d.swapAmount !== "0",
  );
  if (!candidates.length) return null;

  const best = candidates.reduce((a, b) =>
    BigInt(b.swapAmount) > BigInt(a.swapAmount) ? b : a,
  );

  const decimals = quote.outToken?.decimals ?? 18;
  const bestOut = BigInt(best.swapAmount);
  const aggregated = BigInt(quote.outAmount ?? "0");

  // Percentage gain of the aggregated route over the best single venue.
  // Scaled by 10_000 to keep 2 decimal places in integer math.
  const improvementPct =
    bestOut === 0n
      ? 0
      : Number(((aggregated - bestOut) * 10_000n) / bestOut) / 100;

  return {
    bestSingleDex: best.dexCode,
    bestSingleOut: fromBaseUnits(best.swapAmount, decimals),
    aggregatedOut: fromBaseUnits(quote.outAmount ?? "0", decimals),
    improvementPct,
  };
}

/** Render the route as an indented tree for terminal output. */
export function formatRouteTree(quote: OoQuote): string {
  const hops = flattenPath(quote.path);
  if (!hops.length) {
    return "  (no path returned — usually means a direct 1-hop single-pool swap)";
  }

  const lines: string[] = [];
  let currentRoute = -1;
  for (const hop of hops) {
    if (hop.routeIndex !== currentRoute) {
      currentRoute = hop.routeIndex;
      lines.push(`  ├─ split ${hop.routeIndex + 1}: ${hop.routePercentage}% of input`);
    }
    const venues = hop.venues
      .map((v) => `${v.dex}${v.percentage < 100 ? ` (${v.percentage}%)` : ""}`)
      .join(" + ");
    lines.push(`  │   hop ${hop.hopIndex + 1}: ${shorten(hop.from)} → ${shorten(hop.to)}  via ${venues}`);
  }
  return lines.join("\n");
}

function shorten(addr: string): string {
  if (!addr?.startsWith("0x") || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
