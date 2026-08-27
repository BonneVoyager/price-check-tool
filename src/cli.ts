/**
 * CLI for poking the API from a terminal.
 *
 *   bun run quote  -- --chain eth --in ETH --out USDC --amount 1
 *   bun run swap   -- --chain eth --in ETH --out USDC --amount 1 --account 0x...
 *   bun run tokens -- --chain eth
 *   bun run gas    -- --chain eth
 *
 * --chain defaults to `eth`.
 *
 * Token symbols resolve via the presets in chains.ts; raw 0x addresses also work.
 */

import { CHAINS, findChain } from "./chains.ts";
import {
  getGasPrice,
  getQuote,
  getSwapQuote,
  fromBaseUnits,
  OpenOceanError,
} from "./openocean.ts";
import { loadTokens, resolveToken } from "./tokens.ts";
import { dexesUsed, formatRouteTree, isSplitRoute, routingAdvantage } from "./routes.ts";
import { compareQuotes, failures as cmpFailures, rank as cmpRank } from "./quotes/run.ts";

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
const chain = args.chain ?? "eth";

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

    case "compare": {
      // --toChain makes it a cross-chain comparison; without it both sides use
      // --chain, so existing invocations behave exactly as before.
      const toCode = args.toChain ?? chain;
      const chainInfo = findChain(chain);
      const toChainInfo = findChain(toCode);
      if (!chainInfo) throw new Error(`Unknown chain "${chain}"`);
      if (!toChainInfo) throw new Error(`Unknown chain "${toCode}"`);
      // Each token resolves against ITS OWN chain's list.
      const inTok = await resolve(chain, args.in ?? "");
      const outTok = await resolve(toCode, args.out ?? "");
      const amount = args.amount ?? "1";

      const results = await compareQuotes({
        fromChain: chainInfo,
        toChain: toChainInfo,
        inToken: { address: inTok.address, decimals: inTok.decimals ?? 18, symbol: (inTok as any).symbol ?? args.in ?? "" },
        outToken: { address: outTok.address, decimals: outTok.decimals ?? 18, symbol: (outTok as any).symbol ?? args.out ?? "" },
        amount,
        slippage: args.slippage ?? "1",
        gasPrice: args.gasPrice ?? "3",
        account: args.account,
      });

      console.log(
        chainInfo.code === toChainInfo.code
          ? `\n  ${amount} ${args.in} → ${args.out} on ${chainInfo.name}`
          : `\n  ${amount} ${args.in} (${chainInfo.name}) → ${args.out} (${toChainInfo.name})`,
      );
      console.log(`  ${"─".repeat(58)}`);
      for (const r of cmpRank(results)) {
        const tag = r.rank === 1 ? "★" : " ";
        const delta = r.rank === 1 ? "best" : `${r.deltaPct.toFixed(3)}%`;
        console.log(
          `  ${tag} ${String(r.rank)}. ${r.outcome.label.padEnd(11)} ${r.human.toFixed(6).padStart(16)}  ${delta.padStart(8)}  ${String(r.outcome.ms).padStart(5)}ms`,
        );
      }
      for (const f of cmpFailures(results)) {
        console.log(`    –  ${f.label.padEnd(11)} [${f.kind}] ${f.message.slice(0, 46)}`);
      }
      console.log();
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
  Price Check Tool CLI

    bun run quote  -- --chain eth --in ETH --out USDC --amount 1
    bun run swap   -- --chain eth --in ETH --out USDC --amount 1 --account 0xYourAddress
    bun run tokens -- --chain eth [--filter USD] [--limit 50]
    bun run compare -- --chain eth --in ETH --out USDC --amount 1
    bun run compare -- --chain eth --toChain solana --in ETH --out USDC   # cross-chain
    bun run chains
    bun run gas    -- --chain eth

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
