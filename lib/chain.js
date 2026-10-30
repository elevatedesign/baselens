import { createPublicClient, http, fallback, isAddress, getAddress, formatUnits, formatEther, parseAbi, erc20Abi, isHash } from "viem";
import { base } from "viem/chains";

const RPCS = ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"];
export const client = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { timeout: 8000, retryCount: 1 }))) });
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZOS_IMPL = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function addr(v, name = "address") {
  const s = String(v || "").trim();
  if (!isAddress(s, { strict: false })) throw new Error(`${name} must be a 0x-prefixed 20-byte hex address`);
  return getAddress(s.toLowerCase());
}
const tryRead = async (p) => { try { return await p; } catch { return null; } };

async function tokenMeta(token) {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    tryRead(client.readContract({ address: token, abi: erc20Abi, functionName: "name" })),
    tryRead(client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })),
    tryRead(client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
    tryRead(client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" })),
  ]);
  return { name, symbol, decimals: decimals == null ? null : Number(decimals), totalSupplyRaw: totalSupply == null ? null : totalSupply.toString(), totalSupply: totalSupply != null && decimals != null ? formatUnits(totalSupply, Number(decimals)) : null };
}

export async function addressSummary(q) {
  const a = addr(q.address);
  const [block, bal, nonce, code, usdc] = await Promise.all([
    client.getBlockNumber(), client.getBalance({ address: a }), client.getTransactionCount({ address: a }),
    client.getCode({ address: a }), tryRead(client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] })),
  ]);
  const codeSize = code ? (code.length - 2) / 2 : 0;
  return { chain: "base", chainId: 8453, block: Number(block), address: a, type: codeSize > 0 ? (code.startsWith("0xef0100") ? "eip7702-delegated-eoa" : "contract") : "eoa",
    codeSizeBytes: codeSize, ethBalance: formatEther(bal), ethBalanceWei: bal.toString(), nonce, usdcBalance: usdc == null ? null : formatUnits(usdc, 6) };
}

export async function erc20Balance(q) {
  const token = addr(q.token, "token"), a = addr(q.address);
  const [block, raw, meta] = await Promise.all([client.getBlockNumber(), client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] }), tokenMeta(token)]);
  return { chain: "base", chainId: 8453, block: Number(block), token, symbol: meta.symbol, decimals: meta.decimals, address: a, balanceRaw: raw.toString(), balance: meta.decimals == null ? null : formatUnits(raw, meta.decimals) };
}

export async function tokenInfo(q) {
  const token = addr(q.token, "token");
  const [block, code, meta, implSlot, zosSlot, owner] = await Promise.all([
    client.getBlockNumber(), client.getCode({ address: token }), tokenMeta(token),
    tryRead(client.getStorageAt({ address: token, slot: EIP1967_IMPL })),
    tryRead(client.getStorageAt({ address: token, slot: ZOS_IMPL })),
    tryRead(client.readContract({ address: token, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" })),
  ]);
  const codeSize = code ? (code.length - 2) / 2 : 0;
  const slot = [implSlot, zosSlot].find((x) => x && BigInt(x) !== 0n);
  const impl = slot ? getAddress("0x" + slot.slice(-40)) : null;
  const notes = [];
  if (!codeSize) notes.push("No contract code at this address (not a token).");
  if (meta.decimals == null) notes.push("decimals() did not respond: may not be an ERC-20.");
  if (impl) notes.push("Upgradeable proxy (EIP-1967/ZeppelinOS slot): logic can be changed by its admin.");
  if (owner && owner !== "0x0000000000000000000000000000000000000000") notes.push("Has a non-zero owner(): owner may hold privileged functions.");
  if (owner === "0x0000000000000000000000000000000000000000") notes.push("owner() is the zero address (ownership renounced or never set).");
  return { chain: "base", chainId: 8453, block: Number(block), token, isContract: codeSize > 0, codeSizeBytes: codeSize, ...meta, owner, proxyImplementation: impl, notes,
    disclaimer: "Read-only on-chain facts, not investment advice or a safety guarantee." };
}

export async function txSummary(q) {
  const hash = String(q.hash || "").trim();
  if (!isHash(hash)) throw new Error("hash must be a 0x-prefixed 32-byte transaction hash");
  const [tx, rc] = await Promise.all([client.getTransaction({ hash }), tryRead(client.getTransactionReceipt({ hash }))]);
  const out = { chain: "base", chainId: 8453, hash, status: rc ? rc.status : "pending", blockNumber: tx.blockNumber == null ? null : Number(tx.blockNumber), from: tx.from, to: tx.to, valueEth: formatEther(tx.value),
    nonce: tx.nonce, input4byte: tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null, contractCreated: rc?.contractAddress || null };
  if (rc) {
    const fee = rc.gasUsed * (rc.effectiveGasPrice ?? 0n) + (rc.l1Fee ?? 0n);
    Object.assign(out, { gasUsed: rc.gasUsed.toString(), effectiveGasPriceGwei: rc.effectiveGasPrice == null ? null : formatUnits(rc.effectiveGasPrice, 9), feeEth: formatEther(fee), logCount: rc.logs.length });
    const transfers = rc.logs.filter((l) => l.topics[0] === TRANSFER && l.topics.length === 3).slice(0, 25);
    const metas = {};
    for (const l of transfers) metas[l.address] ??= await tokenMeta(getAddress(l.address));
    out.erc20Transfers = transfers.map((l) => { const m = metas[l.address]; const raw = BigInt(l.data === "0x" ? 0 : l.data);
      return { token: getAddress(l.address), symbol: m.symbol, from: getAddress("0x" + l.topics[1].slice(26)), to: getAddress("0x" + l.topics[2].slice(26)), amountRaw: raw.toString(), amount: m.decimals == null ? null : formatUnits(raw, m.decimals) }; });
    if (rc.blockNumber) { const b = await client.getBlock({ blockNumber: rc.blockNumber }); out.timestamp = new Date(Number(b.timestamp) * 1000).toISOString(); }
  }
  return out;
}

export async function gas() {
  const [block, fees, gp] = await Promise.all([client.getBlock(), tryRead(client.estimateFeesPerGas()), client.getGasPrice()]);
  return { chain: "base", chainId: 8453, block: Number(block.number), timestamp: new Date(Number(block.timestamp) * 1000).toISOString(), baseFeeGwei: block.baseFeePerGas == null ? null : formatUnits(block.baseFeePerGas, 9),
    gasPriceGwei: formatUnits(gp, 9), maxFeePerGasGwei: fees ? formatUnits(fees.maxFeePerGas, 9) : null, maxPriorityFeePerGasGwei: fees ? formatUnits(fees.maxPriorityFeePerGas, 9) : null,
    gasUsedRatio: Number(block.gasUsed) / Number(block.gasLimit), simpleTransferCostEth: formatEther(gp * 21000n) };
}

// ---------- v1.1 endpoints ----------
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
const l1 = createPublicClient({ chain: mainnet, transport: fallback(["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com"].map((u) => http(u, { timeout: 8000, retryCount: 1 }))) });

// Name <-> address: ENS (.eth) and Basenames (.base.eth) via the ENS Universal Resolver (CCIP-read for Basenames).
export async function resolveName(q) {
  const input = String(q.name || q.address || "").trim();
  if (!input) throw new Error("pass ?name=jesse.base.eth or ?address=0x…");
  if (isAddress(input, { strict: false })) {
    const a = getAddress(input.toLowerCase());
    const [ens, basename] = await Promise.all([
      tryRead(l1.getEnsName({ address: a })),
      tryRead(l1.getEnsName({ address: a, coinType: 2147492101n })), // ENSIP-11 coinType for Base (0x80000000 | 8453)
    ]);
    return { query: a, type: "reverse", address: a, primaryName: ens, basePrimaryName: basename, note: "Primary names are only returned when forward resolution matches." };
  }
  const name = normalize(input);
  const [ethAddr, baseAddr, avatar] = await Promise.all([
    tryRead(l1.getEnsAddress({ name })),
    tryRead(l1.getEnsAddress({ name, coinType: 2147492101n })),
    tryRead(l1.getEnsText({ name, key: "avatar" })),
  ]);
  const fix = (x) => (x ? getAddress(x) : null);
  return { query: input, type: "forward", name, address: fix(baseAddr || ethAddr), baseAddress: fix(baseAddr), ethereumAddress: fix(ethAddr), avatar, resolved: !!(baseAddr || ethAddr) };
}

// Spot price in USDC from Uniswap v3 on Base (QuoterV2, on-chain, no third-party API). Tries direct USDC pools then via WETH.
const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", WETH = "0x4200000000000000000000000000000000000006";
const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"]);
async function bestQuote(tokenIn, tokenOut, amountIn) {
  const outs = await Promise.all([100, 500, 3000, 10000].map(async (fee) => {
    const r = await tryRead(client.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] }));
    return r ? { fee, out: r.result[0] } : null;
  }));
  return outs.filter(Boolean).sort((a, b) => (b.out > a.out ? 1 : -1))[0] || null;
}
export async function tokenPrice(q) {
  const token = addr(q.token, "token");
  const meta = await tokenMeta(token);
  if (meta.decimals == null) throw new Error("token does not expose decimals(): not an ERC-20?");
  const block = Number(await client.getBlockNumber());
  if (token === USDC) return { chain: "base", chainId: 8453, block, token, symbol: meta.symbol, priceUsdc: "1", route: "identity" };
  const one = 10n ** BigInt(meta.decimals);
  const direct = await bestQuote(token, USDC, one);
  let route = null, priceUsdc = null;
  if (direct) { route = `uniswap-v3 ${meta.symbol}→USDC fee ${direct.fee}`; priceUsdc = formatUnits(direct.out, 6); }
  if (token !== WETH) {
    const toWeth = await bestQuote(token, WETH, one);
    if (toWeth && toWeth.out > 0n) {
      const wethUsdc = await bestQuote(WETH, USDC, toWeth.out);
      if (wethUsdc && (!direct || wethUsdc.out > direct.out)) { route = `uniswap-v3 ${meta.symbol}→WETH (fee ${toWeth.fee})→USDC (fee ${wethUsdc.fee})`; priceUsdc = formatUnits(wethUsdc.out, 6); }
    }
  }
  return { chain: "base", chainId: 8453, block, token, symbol: meta.symbol, decimals: meta.decimals, priceUsdc, route, priced: priceUsdc != null,
    note: "Executable quote for selling 1 whole token on Uniswap v3 (includes pool fee and price impact). Thin pools give unreliable prices. Not financial advice." };
}

const logsClient = createPublicClient({ chain: base, transport: fallback([http("https://base-rpc.publicnode.com", { timeout: 20000, retryCount: 2 })], { retryCount: 0 }) });
// Recent ERC-20 transfers in/out of an address for up to 5 tokens (default: USDC) over the last N blocks (default 10,000 ≈ 5.5h, max 30,000 ≈ 17h).
export async function recentTransfers(q) {
  const a = addr(q.address);
  const tokens = String(q.tokens || q.token || USDC).split(",").map((t) => t.trim()).filter(Boolean).slice(0, 5).map((t) => addr(t, "token"));
  const span = Math.min(Math.max(parseInt(q.blocks || "10000", 10) || 10000, 100), 30000);
  const head = await client.getBlockNumber();
  const from = head - BigInt(span) + 1n;
  const topicAddr = "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const limit = Math.min(parseInt(q.limit || "50", 10) || 50, 200);
  // Walk backwards from the head, newest first; stop once `limit` transfers are collected. Halve the window when the RPC caps results.
  const seen = new Set(), logs = [];
  let to = head, win = 5000n, scannedFrom = head + 1n, calls = 0;
  while (to >= from && logs.length < limit && calls < 24) {
    const f = to - win + 1n < from ? from : to - win + 1n;
    const mk = (topics) => ({ address: tokens, fromBlock: "0x" + f.toString(16), toBlock: "0x" + to.toString(16), topics });
    try {
      calls += 2;
      const [i1, o1] = await Promise.all([logsClient.request({ method: "eth_getLogs", params: [mk([TRANSFER, null, topicAddr])] }), logsClient.request({ method: "eth_getLogs", params: [mk([TRANSFER, topicAddr])] })]);
      for (const l of [...i1, ...o1]) { const k = l.transactionHash + l.logIndex; if (l.topics.length === 3 && !seen.has(k)) { seen.add(k); logs.push(l); } }
      scannedFrom = f; to = f - 1n;
    } catch (e) {
      if (win <= 50n) throw e;
      win = win / 4n;
    }
  }
  logs.sort((x, y) => Number(BigInt(y.blockNumber) - BigInt(x.blockNumber)) || parseInt(y.logIndex, 16) - parseInt(x.logIndex, 16));
  const top = logs.slice(0, limit);
  const metas = Object.fromEntries(await Promise.all(tokens.map(async (t) => [t.toLowerCase(), await tokenMeta(t)])));
  const transfers = top.map((l) => {
    const m = metas[l.address.toLowerCase()], raw = BigInt(l.data === "0x" ? 0 : l.data);
    const fromA = getAddress("0x" + l.topics[1].slice(26)), toA = getAddress("0x" + l.topics[2].slice(26));
    return { block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, direction: toA === a ? "in" : "out", token: getAddress(l.address), symbol: m.symbol, from: fromA, to: toA, amountRaw: raw.toString(), amount: m.decimals == null ? null : formatUnits(raw, m.decimals) };
  });
  return { chain: "base", chainId: 8453, address: a, tokens, scannedFromBlock: Number(scannedFrom), toBlock: Number(head), maxLookbackBlocks: span, totalFound: logs.length, returned: transfers.length, transfers,
    note: "ERC-20 Transfer events for the requested tokens only (default USDC; no native ETH)." };
}

// Contract check: code, proxy, owner, and verified-source status from Sourcify (public, open data).
export async function contractCheck(q) {
  const a = addr(q.address);
  const [block, code, implSlot, zosSlot, owner] = await Promise.all([
    client.getBlockNumber(), client.getCode({ address: a }),
    tryRead(client.getStorageAt({ address: a, slot: EIP1967_IMPL })), tryRead(client.getStorageAt({ address: a, slot: ZOS_IMPL })),
    tryRead(client.readContract({ address: a, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" })),
  ]);
  const codeSize = code ? (code.length - 2) / 2 : 0;
  const slot = [implSlot, zosSlot].find((x) => x && BigInt(x) !== 0n);
  const impl = slot ? getAddress("0x" + slot.slice(-40)) : null;
  const sourcify = async (x) => {
    try {
      const r = await fetch(`https://sourcify.dev/server/v2/contract/8453/${x}?fields=compilation`, { signal: AbortSignal.timeout(6000) });
      if (r.status === 404) return { verified: false };
      if (!r.ok) return { verified: null, error: `sourcify ${r.status}` };
      const j = await r.json();
      return { verified: true, match: j.match || j.runtimeMatch || null, name: j.compilation?.name || null, compiler: j.compilation?.compilerVersion || null, url: `https://repo.sourcify.dev/8453/${x}` };
    } catch (e) { return { verified: null, error: "sourcify unreachable" }; }
  };
  const [src, implSrc] = await Promise.all([codeSize ? sourcify(a) : null, impl ? sourcify(impl) : null]);
  const notes = [];
  if (!codeSize) notes.push("No code: this is an EOA or an undeployed address.");
  else if (code.startsWith("0xef0100")) notes.push("EIP-7702 delegated EOA.");
  if (src && src.verified === false) notes.push("Source not verified on Sourcify (it may still be verified on Basescan).");
  if (impl) notes.push("Upgradeable proxy: the implementation can be swapped by its admin.");
  if (owner && owner !== "0x0000000000000000000000000000000000000000") notes.push("Has owner(): privileged functions may exist.");
  return { chain: "base", chainId: 8453, block: Number(block), address: a, isContract: codeSize > 0, codeSizeBytes: codeSize, owner, proxyImplementation: impl, sourcify: src, implementationSourcify: implSrc, notes,
    disclaimer: "Read-only facts, not a security audit." };
}
