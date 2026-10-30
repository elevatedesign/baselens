// Lists USDC (Base) transfers into the BaseLens payTo since launch block. Usage: node check-payments.mjs [fromBlock]
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { base } from "viem/chains";
const c = createPublicClient({ chain: base, transport: http("https://base-rpc.publicnode.com") });
const to = "0x50F806C7E473322484bc91FF628380a3b12366f9", head = await c.getBlockNumber();
const ev = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
let n = 0;
for (let b = BigInt(process.argv[2] || 53289500); b <= head; b += 5000n) {
  const e = b + 4999n > head ? head : b + 4999n;
  for (const l of await c.getLogs({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", event: ev, args: { to }, fromBlock: b, toBlock: e })) {
    n++; console.log(l.blockNumber, l.transactionHash, l.args.from, formatUnits(l.args.value, 6), "USDC");
  }
}
console.log(`head ${head}, ${n} USDC transfers in (any source, includes non-BaseLens deposits)`);
