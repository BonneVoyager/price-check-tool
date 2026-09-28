/**
 * Token list fetching, normalisation and caching.
 *
 * Two quirks in the raw /tokenList data that this module papers over:
 *
 * 1. NATIVE COIN MISSING. polygon, avax and every non-EVM chain omit their
 *    native coin from the list, even though the sentinel address swaps fine.
 *    We inject a synthetic entry so it stays selectable.
 *
 * 2. SENTINEL SQUATTERS. On eth, FOUR tokens claim an address that lowercases
 *    to the native sentinel (ELK, ETH, ASKO, ETHV) — only the exact-case
 *    `0xEeeeeEee…EEeE` one is the real native coin. Naively taking the first
 *    lowercase match hands you `ELK` instead of `ETH`. We de-dupe so the real
 *    native always wins.
 */

import { CHAIN_MARKS } from "./chain-marks.ts";
import {
  findChain,
  isNativeAddress,
  nativeAddressFor,
  type ChainInfo,
} from "./chains.ts";
import { getTokenList } from "./openocean.ts";
import type { OoToken } from "./types.ts";

export interface UiToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
  /** USD price as a number, when the API supplied one. */
  usd?: number;
  /** True for the chain's gas coin. */
  isNative: boolean;
  /** API marks ~20 popular tokens per chain; we surface these first. */
  isHot: boolean;
}



/**
 * DefiLlama chain icons, keyed by their own chain slug.
 *
 * Added because the previous two tiers both failed for a cluster of newer
 * chains. The token-list tier has nothing for chains OpenOcean doesn't serve,
 * and the CoinCap symbol tier 404s for their native tickers — verified:
 * `mon`, `xdai`, `plume`, `tac` and `g` all return a 404 HTML page, not an
 * image. DefiLlama keys by CHAIN rather than ticker, which is the right shape
 * for this, and covers 42/44 (only Gravity misses; Starknet has an inline mark).
 *
 * Slugs are NOT our codes — `xdai`→`gnosis`, `hyperevm`→`hyperliquid`,
 * `okex`→`okexchain`, and two contain a space (`zksync era`, `polygon zkevm`),
 * so the value is URL-encoded.
 */
const LLAMA_CHAIN_SLUG: Record<string, string> = {
  eth: "ethereum", bsc: "bsc", base: "base", arbitrum: "arbitrum",
  polygon: "polygon", optimism: "optimism", avax: "avalanche",
  solana: "solana", fantom: "fantom", sonic: "sonic", linea: "linea",
  scroll: "scroll", zksync: "zksync era", mantle: "mantle", blast: "blast",
  mode: "mode", manta: "manta", bera: "berachain", sei: "sei",
  hyperevm: "hyperliquid", monad: "monad", cronos: "cronos", celo: "celo",
  xdai: "gnosis", kava: "kava", metis: "metis", aurora: "aurora",
  moonriver: "moonriver", harmony: "harmony", okex: "okexchain",
  telos: "telos", flare: "flare", rootstock: "rootstock",
  polygon_zkevm: "polygon zkevm", opbnb: "opbnb", ape: "apechain",
  gravity: "gravity", plume: "plume", tac: "tac", sui: "sui",
  aptos: "aptos", near: "near", starknet: "starknet", stellar: "stellar",
};

function llamaChainIcon(chainCode: string): string | undefined {
  const slug = LLAMA_CHAIN_SLUG[chainCode];
  if (!slug) return undefined;
  return `https://icons.llamao.fi/icons/chains/rsz_${encodeURIComponent(slug)}.jpg`;
}

/**
 * Fallback icon by SYMBOL, for tokens whose source list carries no icon URL.
 *
 * Seeded chains (Stellar, Starknet) have no OpenOcean token list at all, so
 * every one of their tokens rendered as a letter circle. CoinCap's asset icons
 * are a plain URL keyed by lowercase symbol — no API, no key, no rate limit to
 * manage — and cover the majors we care about (verified in-browser: XLM, SUI,
 * APT, NEAR, STRK, BTC, ETH, USDC, USDT, WBTC, XRP, PYUSD all load; AQUA, EURC,
 * SHX, yXLM do not).
 *
 * A miss is harmless: the URL 404s, the <img> onerror fires, and the letter
 * circle comes back — exactly the state these tokens were in before. So this is
 * strictly additive, which is why it's fine to guess by symbol.
 *
 * CoinGecko was the alternative but its API needs a per-coin lookup and throttles
 * hard without a key; this needs neither.
 */
const SYMBOL_ICON_BASE = "https://assets.coincap.io/assets/icons";

/** Symbols we know CoinCap does NOT have, so we skip the doomed request. */
const NO_SYMBOL_ICON = new Set(["AQUA", "EURC", "SHX", "YXLM", "USDX", "USDGLO", "USDP", "SUSD", "VELO"]);

export function symbolIconUrl(symbol: string): string | undefined {
  const s = (symbol ?? "").trim();
  // Wrapped y-assets and long-tail Stellar anchors aren't on CoinCap.
  if (!s || !/^[A-Za-z0-9]{2,8}$/.test(s)) return undefined;
  if (NO_SYMBOL_ICON.has(s.toUpperCase())) return undefined;
  return `${SYMBOL_ICON_BASE}/${s.toLowerCase()}@2x.png`;
}

/** In-memory cache — token lists change rarely and are up to ~660 entries. */
const cache = new Map<string, { at: number; tokens: UiToken[] }>();
const TTL_MS = 10 * 60 * 1000;

function toUi(t: OoToken & { hot?: unknown; usd?: string }, native: boolean): UiToken {
  const usd = t.usd !== undefined && t.usd !== null ? Number(t.usd) : undefined;
  return {
    address: t.address,
    symbol: t.symbol ?? "?",
    name: t.name ?? "",
    decimals: Number(t.decimals ?? 18),
    icon: t.icon || symbolIconUrl(t.symbol ?? ""),
    usd: Number.isFinite(usd) ? usd : undefined,
    isNative: native,
    isHot: t.hot !== null && t.hot !== undefined && t.hot !== "",
  };
}

/**
 * Sort: native first, then hot tokens, then by USD price as a rough liquidity
 * proxy, then alphabetically. Keeps the useful tokens at the top of a 600-entry
 * list without needing a separate liquidity feed.
 */
function sortTokens(a: UiToken, b: UiToken): number {
  if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
  if (a.isHot !== b.isHot) return a.isHot ? -1 : 1;
  const au = a.usd ?? -1;
  const bu = b.usd ?? -1;
  if (au !== bu) return bu - au;
  return a.symbol.localeCompare(b.symbol);
}

/**
 * Chains OpenOcean's /tokenList does NOT serve, so the picker has something to
 * show. Only needed where a non-OpenOcean aggregator brought the chain in.
 */
const SEED_TOKENS: Record<string, UiToken[]> = {
  stellar: [
    { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, isNative: true, isHot: true },
    { address: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", symbol: "USDC", name: "USDC", decimals: 7, isNative: false, isHot: true },
    { address: "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA", symbol: "AQUA", name: "AQUA", decimals: 7, isNative: false, isHot: true },
    { address: "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2", symbol: "EURC", name: "EURC", decimals: 7, isNative: false, isHot: true },
    { address: "yXLM:GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55", symbol: "yXLM", name: "yXLM", decimals: 7, isNative: false, isHot: true },
    { address: "XRP:GBXRPL45NPHCVMFFAYZVUVFFVKSIZ362ZXFP7I2ETNQ3QKZMFLPRDTD5", symbol: "XRP", name: "XRP", decimals: 7, isNative: false, isHot: true },
    { address: "SHX:GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH", symbol: "SHX", name: "SHX", decimals: 7, isNative: false, isHot: true },
    { address: "BTC:GDPJALI4AZKUU2W426U5WKMAT6CN3AJRPIIRYR2YM54TL2GDWO5O2MZM", symbol: "BTC", name: "BTC", decimals: 7, isNative: false, isHot: true },
    { address: "ETH:GBFXOHVAS43OIWNIO7XLRJAHT3BICFEIKOJLZVXNT572MISM4CMGSOCC", symbol: "ETH", name: "ETH", decimals: 7, isNative: false, isHot: true },
    { address: "PYUSD:GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5", symbol: "PYUSD", name: "PYUSD", decimals: 7, isNative: false, isHot: true },
  ],
  /**
   * Sui. Coin types are `pkg::module::TYPE`, not addresses. Decimals confirmed
   * against Aftermath's coin-metadata endpoint.
   */
  sui: [
    { address: "0x2::sui::SUI", symbol: "SUI", name: "Sui", decimals: 9, isNative: true, isHot: true },
    { address: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false, isHot: true },
    { address: "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT", symbol: "USDT", name: "Tether USD", decimals: 6, isNative: false, isHot: true },
    { address: "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS", symbol: "CETUS", name: "Cetus", decimals: 9, isNative: false, isHot: true },
    { address: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", symbol: "WAL", name: "Walrus", decimals: 9, isNative: false, isHot: true },
  ],
  /** Aptos. Coin types plus newer fungible-asset object addresses. */
  aptos: [
    { address: "0x1::aptos_coin::AptosCoin", symbol: "APT", name: "Aptos Coin", decimals: 8, isNative: true, isHot: true },
    { address: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b", symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false, isHot: true },
    { address: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b", symbol: "USDT", name: "Tether USD", decimals: 6, isNative: false, isHot: true },
  ],
  /**
   * TON. Jetton addresses are base64url (`EQ…`). The native coin is the literal
   * "native" — STON.fi has no pool for it and substitutes wrapped pTON, which
   * the adapter handles.
   */
  ton: [
    { address: "native", symbol: "TON", name: "Toncoin", decimals: 9, isNative: true, isHot: true },
    { address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", symbol: "USDT", name: "Tether USD", decimals: 6, isNative: false, isHot: true },
    { address: "EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav", symbol: "tsTON", name: "Tonstakers TON", decimals: 9, isNative: false, isHot: true },
    { address: "EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO", symbol: "STON", name: "STON", decimals: 9, isNative: false, isHot: true },
  ],
  /**
   * Osmosis. Assets are DENOMS, not addresses — `uosmo`, `ibc/<hash>`, or
   * `factory/<addr>/<sub>`. Verified against sqsprod.osmosis.zone/tokens/metadata.
   */
  osmosis: [
    { address: "uosmo", symbol: "OSMO", name: "Osmosis", decimals: 6, isNative: true, isHot: true },
    { address: "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC", symbol: "USDC", name: "USDC (alloyed)", decimals: 6, isNative: false, isHot: true },
    { address: "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", symbol: "ATOM", name: "Cosmos Hub Atom", decimals: 6, isNative: false, isHot: true },
    { address: "factory/osmo1em6xs47hd82806f5cxgyufguxrrc7l0aqx7nzzptjuqgswczk8csavdxek/alloyed/allBTC", symbol: "BTC", name: "Bitcoin (alloyed)", decimals: 8, isNative: false, isHot: true },
  ],
  /**
   * Chains with a single native coin and no token contracts. The address IS the
   * symbol — these are matched by symbol upstream (1Click's natives carry no
   * contractAddress). Decimals verified against 1Click's /v0/tokens.
   */
  bitcoin: [
    { address: "BTC", symbol: "BTC", name: "Bitcoin", decimals: 8, isNative: true, isHot: true },
  ],
  doge: [
    { address: "DOGE", symbol: "DOGE", name: "Dogecoin", decimals: 8, isNative: true, isHot: true },
  ],
  litecoin: [
    { address: "LTC", symbol: "LTC", name: "Litecoin", decimals: 8, isNative: true, isHot: true },
  ],
  bitcoincash: [
    { address: "BCH", symbol: "BCH", name: "Bitcoin Cash", decimals: 8, isNative: true, isHot: true },
  ],
  zcash: [
    { address: "ZEC", symbol: "ZEC", name: "Zcash", decimals: 8, isNative: true, isHot: true },
  ],
  dash: [
    { address: "DASH", symbol: "DASH", name: "Dash", decimals: 8, isNative: true, isHot: true },
  ],
  cardano: [
    { address: "ADA", symbol: "ADA", name: "Cardano", decimals: 6, isNative: true, isHot: true },
  ],
  xrp: [
    { address: "XRP", symbol: "XRP", name: "XRP", decimals: 6, isNative: true, isHot: true },
  ],
  tron: [
    { address: "TRX", symbol: "TRX", name: "Tron", decimals: 6, isNative: true, isHot: true },
    { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", symbol: "USDT", name: "Tether USD", decimals: 6, isNative: false, isHot: true },
  ],
  starknet: [
    { address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", symbol: "ETH", name: "Ether", decimals: 18, isNative: true, isHot: true },
    { address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8", symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false, isHot: true },
    { address: "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8", symbol: "USDT", name: "Tether USD", decimals: 6, isNative: false, isHot: true },
    { address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", symbol: "STRK", name: "Starknet Token", decimals: 18, isNative: false, isHot: true },
    { address: "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac", symbol: "WBTC", name: "Wrapped BTC", decimals: 8, isNative: false, isHot: true },
  ],
};

export async function loadTokens(chainCode: string): Promise<UiToken[]> {
  const hit = cache.get(chainCode);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tokens;

  const chain = findChain(chainCode);
  if (!chain) throw new Error(`Unknown chain "${chainCode}"`);

  const seeded = SEED_TOKENS[chainCode];
  if (seeded) {
    // Seeded chains have no upstream icons at all; fill them in by symbol.
    const withIcons = seeded.map((t) => ({
      ...t,
      icon: t.icon || symbolIconUrl(t.symbol),
    }));
    cache.set(chainCode, { at: Date.now(), tokens: withIcons });
    return withIcons;
  }

  const raw = await getTokenList(chainCode);
  const tokens = normalise(raw, chain);

  cache.set(chainCode, { at: Date.now(), tokens });
  return tokens;
}

/** Exported for testing without a network call. */
export function normalise(raw: OoToken[], chain: ChainInfo): UiToken[] {
  const nativeAddr = nativeAddressFor(chain);

  // Keep only the genuine native entry: exact-case sentinel match, or failing
  // that, the one whose symbol matches the chain's known native symbol. This is
  // what stops ELK/ASKO/ETHV from being mistaken for ETH.
  const isRealNative = (t: OoToken) =>
    t.address === nativeAddr ||
    (isNativeAddress(t.address) &&
      (t.symbol ?? "").toUpperCase() === chain.nativeSymbol.toUpperCase());

  const out: UiToken[] = [];
  let sawNative = false;

  for (const t of raw ?? []) {
    if (!t?.address || !t?.symbol) continue;

    if (isNativeAddress(t.address)) {
      // Drop squatters; keep the one true native.
      if (!isRealNative(t) || sawNative) continue;
      sawNative = true;
      out.push(toUi(t, true));
      continue;
    }
    out.push(toUi(t, false));
  }

  // Chains whose list omits native (polygon, avax, non-EVM): synthesise it.
  if (!sawNative) {
    out.push({
      address: nativeAddr,
      symbol: chain.nativeSymbol,
      name: `${chain.name} native coin`,
      decimals: 18,
      icon: symbolIconUrl(chain.nativeSymbol),
      isNative: true,
      isHot: true,
    });
  }

  return out.sort(sortTokens);
}

/**
 * Chain logo, resolved in two tiers.
 *
 * 1. A built-in brand mark (CHAIN_MARKS), for chains the token list cannot
 *    distinguish. Every ETH-native L2 resolves to its local WETH token, and
 *    those all use the generic ETH diamond — so Base, Arbitrum, Optimism,
 *    Linea, Scroll, zkSync, Blast, Mode, Manta, Aurora and Polygon zkEVM would
 *    otherwise render as eleven identical icons. Inline SVG data URIs, so
 *    there's no CDN to rot and no build asset to break.
 *
 * 2. Otherwise the token list: a chain's native coin and its wrapped twin share
 *    a logo (the Polygon mark IS the wPOL icon). Native first, then wrapped —
 *    26 of 42 chains have no icon on the bare native entry (often because we
 *    synthesised it) while the wrapped ERC-20 always does. That fallback is
 *    what takes token-derived coverage from 16/42 to 42/42.
 *
 * Cached per chain, so repeat lookups across /api/chainIcons calls are free.
 */
const iconCache = new Map<string, string | null>();

export async function chainIcon(chain: ChainInfo): Promise<string | null> {
  if (iconCache.has(chain.code)) return iconCache.get(chain.code) ?? null;

  const mark = CHAIN_MARKS[chain.code];
  if (mark) {
    iconCache.set(chain.code, mark);
    return mark;
  }

  // DefiLlama keys by chain, so it covers newer chains whose native TICKER the
  // symbol tier can't find (MON, XDAI, PLUME, TAC, G all 404 on CoinCap).
  const llama = llamaChainIcon(chain.code);
  if (llama) {
    iconCache.set(chain.code, llama);
    return llama;
  }

  let icon: string | null = null;
  try {
    const tokens = await loadTokens(chain.code);
    const sym = chain.nativeSymbol.toUpperCase();
    // e.g. ETH -> ETH, WETH;  POL -> POL, WPOL;  rBTC -> RBTC, WRBTC
    const candidates = [sym, `W${sym}`];
    for (const want of candidates) {
      const hit = tokens.find((t) => t.symbol.toUpperCase() === want && t.icon);
      if (hit?.icon) {
        icon = hit.icon;
        break;
      }
    }
  } catch {
    // A chain whose token list fails just falls back to initials in the UI.
    icon = null;
  }

  iconCache.set(chain.code, icon);
  return icon;
}

/**
 * CHAINS decorated with logo URLs.
 *
 * Chains with a built-in mark resolve instantly; the rest need a token-list
 * fetch, so those run in small batches. Firing all 30 at once made the whole
 * response exceed Bun.serve's 10s idleTimeout on a cold cache.
 */
export async function chainsWithIcons(
  chains: ChainInfo[],
  /**
   * Wall-clock budget. Past this we stop starting new upstream lookups and
   * return what we have, so the endpoint can't hang near a platform timeout.
   * Chains that miss out keep letter initials and resolve on a later request
   * (their token lists are cached by then, so the next call is fast).
   */
  budgetMs = 8000,
) {
  const out: (ChainInfo & { icon: string | null })[] = [];
  const started = Date.now();
  const BATCH = 8;

  for (let i = 0; i < chains.length; i += BATCH) {
    const slice = chains.slice(i, i + BATCH);

    // Built-in marks are free (no fetch), so never skip those on budget.
    const overBudget = Date.now() - started > budgetMs;
    const done = await Promise.all(
      slice.map(async (c) => {
        if (CHAIN_MARKS[c.code]) return { ...c, icon: CHAIN_MARKS[c.code]! };
        if (overBudget && !iconCache.has(c.code)) return { ...c, icon: null };
        return { ...c, icon: await chainIcon(c) };
      }),
    );
    out.push(...done);
  }
  return out;
}

/**
 * Resolve user input to an address: a 0x/base58 address passes through, a
 * symbol is matched case-insensitively against the chain's list.
 */
export function resolveToken(
  tokens: UiToken[],
  input: string,
): UiToken | undefined {
  const v = (input ?? "").trim();
  if (!v) return undefined;

  const byAddress = tokens.find(
    (t) => t.address.toLowerCase() === v.toLowerCase(),
  );
  if (byAddress) return byAddress;

  const up = v.toUpperCase();
  // Prefer an exact symbol hit; hot/native sort order breaks ties sensibly.
  return tokens.find((t) => t.symbol.toUpperCase() === up);
}
