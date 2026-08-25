/**
 * CLI for poking the API from a terminal.
 *
 *   bun run quote  -- --chain bsc --in BNB --out USDT --amount 1
 *   bun run swap   -- --chain bsc --in BNB --out USDT --amount 1 --account 0x...
 *   bun run tokens -- --chain bsc
 *   bun run gas    -- --chain bsc
 *
 * Token symbols resolve via the presets in chains.ts; raw 0x addresses also work.
 */

import { CHAINS } from "./chains.ts";
import {
  getGasPrice,
  getQuote,
  getSwapQuote,
  fromBaseUnits,
  OpenOceanError,
} from "./openocean.ts";
import { loadTokens, resolveToken } from "./tokens.ts";
import { dexesUsed, formatRouteTree, isSplitRoute, routingAdvantage } from "./routes.ts";

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

/**
 * Resolve a symbol or address against the chain's LIVE token list.
 * Suggests near-matches on a miss, since a 400-token list is unguessable.
 */
async function resolve(chainCode: string, value: string) {
  const tokens = await loadTokens(chainCode);
  const hit = resolveToken(tokens, value);
  if (hit) return hit;

  if (value.startsWith("0x")) return { address: value, decimals: 18, symbol: value };

  const up = value.toUpperCase();
  const near = tokens
    .filter((t) => t.symbol.toUpperCase().includes(up) || t.name.toUpperCase().includes(up))
    .slice(0, 8)
    .map((t) => t.symbol);
  const hint = near.length
    ? `Did you mean: ${near.join(", ")}?`
    : `Try \`bun run tokens -- --chain ${chainCode}\` to list what's available.`;
  throw new Error(`Unknown token "${value}" on ${chainCode}. ${hint}`);
}

const [command, ...rest] = Bun.argv.slice(2);
const args = parseArgs(rest);
const chain = args.chain ?? "bsc";

try {
  switch (command) {
    case "tokens": {
      const tokens = await loadTokens(chain);
      const filter = (args.filter ?? args.q ?? "").toUpperCase();
      const shown = filter
        ? tokens.filter(
            (t) =>
              t.symbol.toUpperCase().includes(filter) ||
              t.name.toUpperCase().includes(filter),
          )
        : tokens;
      const limit = Number(args.limit ?? 30);

      console.log(
        `\n${tokens.length} tokens on ${chain}` +
          (filter ? ` — ${shown.length} match "${filter}"` : "") +
          `. Showing ${Math.min(limit, shown.length)}:\n`,
      );
      for (const t of shown.slice(0, limit)) {
        const tag = t.isNative ? "native" : t.isHot ? "hot" : "";
        const usd = t.usd !== undefined ? `$${t.usd}` : "";
        console.log(
          `  ${t.symbol.padEnd(12)} ${t.address.padEnd(44)} ${String(t.decimals).padStart(2)}d ${tag.padEnd(6)} ${usd}`,
        );
      }
      if (shown.length > limit) console.log(`  … ${shown.length - limit} more (--limit N, --filter TEXT)`);
      break;
    }

    case "chains": {
      console.log(`\n${CHAINS.length} chains:\n`);
      for (const c of CHAINS) {
        console.log(
          `  ${c.code.padEnd(15)} ${c.name.padEnd(18)} native=${c.nativeSymbol.padEnd(6)} ${c.evm ? `chainId=${c.id}` : "non-EVM"}`,
        );
      }
      break;
    }

    case "gas": {
      console.log(`\nGas price on ${chain}:\n`);
      console.log(JSON.stringify(await getGasPrice(chain), null, 2));
      break;
    }

    case "quote":
    case "swap": {
      const inTok = await resolve(chain, args.in ?? "");
      const outTok = await resolve(chain, args.out ?? "");
      const amount = args.amount ?? "1";
      const slippage = args.slippage ?? "1";
      const gasPrice = args.gasPrice ?? "3";

      const base = {
        inTokenAddress: inTok.address,
        outTokenAddress: outTok.address,
        amount,
        gasPrice,
        slippage,
      };

      const result =
        command === "swap"
          ? await getSwapQuote(chain, { ...base, account: args.account ?? "" })
          : await getQuote(chain, base);

      const outDecimals = result.outToken?.decimals ?? outTok.decimals ?? 18;
      const inDecimals = result.inToken?.decimals ?? inTok.decimals ?? 18;

      console.log(`\n  ${command.toUpperCase()}  ${chain}`);
      console.log(`  ${"─".repeat(52)}`);
      console.log(`  in      ${fromBaseUnits(result.inAmount, inDecimals)} ${result.inToken?.symbol ?? ""}`);
      console.log(`  out     ${fromBaseUnits(result.outAmount, outDecimals)} ${result.outToken?.symbol ?? ""}`);
      if (result.price_impact) console.log(`  impact  ${result.price_impact}`);
      console.log(`  gas     ${result.estimatedGas}`);

      console.log(`\n  route (${isSplitRoute(result.path) ? "split" : "direct"}):`);
      console.log(formatRouteTree(result));

      const used = dexesUsed(result.path);
      if (used.length) console.log(`\n  DEXes: ${used.join(", ")}`);

      const adv = routingAdvantage(result);
      if (adv) {
        console.log(`\n  vs best single venue (${adv.bestSingleDex}): ${adv.bestSingleOut}`);
        console.log(`  aggregated:  ${adv.aggregatedOut}  (${adv.improvementPct >= 0 ? "+" : ""}${adv.improvementPct}%)`);
      }

      if (command === "swap") {
        const s = result as Awaited<ReturnType<typeof getSwapQuote>>;
        console.log(`\n  tx.to     ${s.to}`);
        console.log(`  tx.value  ${s.value}`);
        console.log(`  tx.data   ${s.data?.slice(0, 66)}…  (${s.data?.length ?? 0} chars)`);
      }
      console.log();
      break;
    }

    default:
      console.log(`
  OpenOcean playground CLI

    bun run quote  -- --chain bsc --in BNB --out USDT --amount 1
    bun run swap   -- --chain bsc --in BNB --out USDT --amount 1 --account 0xYourAddress
    bun run tokens -- --chain bsc [--filter USD] [--limit 50]
    bun run chains
    bun run gas    -- --chain bsc

  Tokens resolve from each chain's live list — any symbol or address works.
  ${CHAINS.length} chains available; run \`bun run chains\` to list them.
`);
  }
} catch (err) {
  if (err instanceof OpenOceanError) {
    console.error(`\n  ✗ ${err.message}\n`);
    if (err.body) console.error(`  upstream: ${JSON.stringify(err.body).slice(0, 300)}\n`);
  } else {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
}
