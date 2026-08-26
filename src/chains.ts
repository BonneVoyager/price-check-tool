/**
 * Chain registry.
 *
 * OpenOcean has no chain-list endpoint (every plausible path 404s, and their own
 * app hardcodes the list in its bundle), so this table is static. It was
 * verified by probing `/v4/{code}/tokenList` for every candidate code — the 42
 * below all returned a live token list.
 *
 * `code` is what goes in the v4 URL path: /v4/{code}/quote. NOT the numeric
 * chain id. `id` is the EVM chain id, for cross-checking a connected wallet;
 * null for non-EVM chains.
 *
 * `nativeSymbol` matters more than it looks: several chains (polygon, avax, and
 * every non-EVM chain) do NOT include their native coin in `tokenList`, yet the
 * sentinel address still works for swaps. The server injects a synthetic native
 * entry using this symbol so those coins remain selectable. Verified: a
 * POL->USDC and AVAX->USDC quote both succeed via the sentinel.
 */

export interface ChainInfo {
  code: string;
  name: string;
  id: number | null;
  nativeSymbol: string;
  /** false for Solana/Sui/Aptos/Near, whose addresses aren't 0x-hex. */
  evm: boolean;
}

/** EVM sentinel for a chain's native coin. Case-insensitive when comparing. */
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** Solana's native mint (wrapped SOL), used where the EVM sentinel doesn't apply. */
export const SOL_NATIVE = "So11111111111111111111111111111111111111112";

export function isNativeAddress(addr: string): boolean {
  const a = (addr ?? "").toLowerCase();
  return a === NATIVE.toLowerCase() || a === SOL_NATIVE.toLowerCase();
}

/**
 * Ordered roughly by how much you'd actually use them (token-list size, which
 * tracks liquidity), so the dropdown's top entries are the useful ones.
 */
export const CHAINS: ChainInfo[] = [
  { code: "eth", name: "Ethereum", id: 1, nativeSymbol: "ETH", evm: true },
  { code: "bsc", name: "BNB Chain", id: 56, nativeSymbol: "BNB", evm: true },
  { code: "base", name: "Base", id: 8453, nativeSymbol: "ETH", evm: true },
  { code: "arbitrum", name: "Arbitrum One", id: 42161, nativeSymbol: "ETH", evm: true },
  { code: "polygon", name: "Polygon", id: 137, nativeSymbol: "POL", evm: true },
  { code: "optimism", name: "Optimism", id: 10, nativeSymbol: "ETH", evm: true },
  { code: "avax", name: "Avalanche", id: 43114, nativeSymbol: "AVAX", evm: true },
  { code: "solana", name: "Solana", id: null, nativeSymbol: "SOL", evm: false },
  { code: "fantom", name: "Fantom", id: 250, nativeSymbol: "FTM", evm: true },
  { code: "sonic", name: "Sonic", id: 146, nativeSymbol: "S", evm: true },
  { code: "linea", name: "Linea", id: 59144, nativeSymbol: "ETH", evm: true },
  { code: "scroll", name: "Scroll", id: 534352, nativeSymbol: "ETH", evm: true },
  { code: "zksync", name: "zkSync Era", id: 324, nativeSymbol: "ETH", evm: true },
  { code: "mantle", name: "Mantle", id: 5000, nativeSymbol: "MNT", evm: true },
  { code: "blast", name: "Blast", id: 81457, nativeSymbol: "ETH", evm: true },
  { code: "mode", name: "Mode", id: 34443, nativeSymbol: "ETH", evm: true },
  { code: "manta", name: "Manta Pacific", id: 169, nativeSymbol: "ETH", evm: true },
  { code: "bera", name: "Berachain", id: 80094, nativeSymbol: "BERA", evm: true },
  { code: "sei", name: "Sei", id: 1329, nativeSymbol: "SEI", evm: true },
  { code: "hyperevm", name: "HyperEVM", id: 999, nativeSymbol: "HYPE", evm: true },
  { code: "monad", name: "Monad", id: 143, nativeSymbol: "MON", evm: true },
  { code: "cronos", name: "Cronos", id: 25, nativeSymbol: "CRO", evm: true },
  { code: "celo", name: "Celo", id: 42220, nativeSymbol: "CELO", evm: true },
  { code: "xdai", name: "Gnosis (xDai)", id: 100, nativeSymbol: "XDAI", evm: true },
  { code: "kava", name: "Kava", id: 2222, nativeSymbol: "KAVA", evm: true },
  { code: "metis", name: "Metis", id: 1088, nativeSymbol: "METIS", evm: true },
  { code: "aurora", name: "Aurora", id: 1313161554, nativeSymbol: "ETH", evm: true },
  { code: "moonriver", name: "Moonriver", id: 1285, nativeSymbol: "MOVR", evm: true },
  { code: "harmony", name: "Harmony", id: 1666600000, nativeSymbol: "ONE", evm: true },
  { code: "okex", name: "OKX Chain", id: 66, nativeSymbol: "OKT", evm: true },
  { code: "telos", name: "Telos", id: 40, nativeSymbol: "TLOS", evm: true },
  { code: "flare", name: "Flare", id: 14, nativeSymbol: "FLR", evm: true },
  { code: "rootstock", name: "Rootstock", id: 30, nativeSymbol: "rBTC", evm: true },
  { code: "polygon_zkevm", name: "Polygon zkEVM", id: 1101, nativeSymbol: "ETH", evm: true },
  { code: "opbnb", name: "opBNB", id: 204, nativeSymbol: "BNB", evm: true },
  { code: "ape", name: "ApeChain", id: 33139, nativeSymbol: "APE", evm: true },
  { code: "gravity", name: "Gravity", id: 1625, nativeSymbol: "G", evm: true },
  { code: "plume", name: "Plume", id: 98866, nativeSymbol: "PLUME", evm: true },
  { code: "tac", name: "TAC", id: 239, nativeSymbol: "TAC", evm: true },
  { code: "sui", name: "Sui", id: null, nativeSymbol: "SUI", evm: false },
  { code: "aptos", name: "Aptos", id: null, nativeSymbol: "APT", evm: false },
  { code: "near", name: "NEAR", id: null, nativeSymbol: "NEAR", evm: false },
  /**
   * Starknet. NOT served by OpenOcean's /v4 endpoints — it's here so the
   * Starknet-native aggregators (AVNU, Fibrous) have a chain to attach to.
   * Its addresses are felt252 hex, not 20-byte EVM addresses, which is why
   * `evm: false` matters: adapters keyed on EVM assumptions opt out via
   * supports() rather than sending a malformed request.
   */
  { code: "starknet", name: "Starknet", id: null, nativeSymbol: "ETH", evm: false },
  /**
   * Stellar. Also not an OpenOcean chain — added for WOWMAX (and Soroswap once
   * a key is configured). Its assets are not addresses at all: the native coin
   * is the literal string `native`, and everything else is `CODE:ISSUER`, e.g.
   * `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`. All
   * balances use 7 decimals (stroops).
   *
   * WOWMAX addresses it by the synthetic chain id 100000148, which is theirs
   * alone — Stellar has no EVM chain id, so `id` stays null here.
   */
  { code: "stellar", name: "Stellar", id: null, nativeSymbol: "XLM", evm: false },
];

export function findChain(code: string): ChainInfo | undefined {
  return CHAINS.find((c) => c.code === code);
}

/** Stellar's native asset is the literal string "native", not an address. */
export const STELLAR_NATIVE = "native";

/** The address to use for a chain's native coin. */
export function nativeAddressFor(chain: ChainInfo): string {
  if (chain.evm) return NATIVE;
  if (chain.code === "solana") return SOL_NATIVE;
  if (chain.code === "stellar") return STELLAR_NATIVE;
  return NATIVE;
}
