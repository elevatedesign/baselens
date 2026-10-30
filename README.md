# BaseLens

Pay-per-call **Base** (chain 8453) on-chain reads for AI agents. No account and no API key: call a URL, get `402 Payment Required`, pay the quoted amount in **USDC on Base**, and retry. The same data is available as a remote [MCP](https://modelcontextprotocol.io) server.

Live service: [https://baselens-api.vercel.app](https://baselens-api.vercel.app)

Payments settle to `0x50F806C7E473322484bc91FF628380a3b12366f9` on Base, in native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). Prices are `$0.001`–`$0.004` per call. Responses are read-only chain facts, not financial advice and not an audit.

## Paid HTTP endpoints

Every paid route is `GET`. Arguments are query parameters. A call without a payment header returns HTTP 402 with the x402 requirements (`scheme: exact`, `network: eip155:8453`).

| Method and path | Price | Query | What you get |
| --- | --- | --- | --- |
| `GET /v1/address` | $0.002 | `address` (required) | EOA vs contract vs EIP-7702, ETH balance, nonce, code size, and native USDC balance at the latest block. |
| `GET /v1/erc20-balance` | $0.002 | `token`, `address` (both required) | ERC-20 balance for any Base token, raw and human-readable, plus symbol and decimals. |
| `GET /v1/token` | $0.003 | `token` (required) | Name, symbol, decimals, total supply, code size, `owner()`, EIP-1967 / ZeppelinOS proxy implementation, and plain-language notes (upgradeable, owner renounced). |
| `GET /v1/tx` | $0.003 | `hash` (required) | Transaction summary: status, block time, from/to, value, total fee (including the L1 fee), and decoded ERC-20 `Transfer` events. Useful for confirming a payment landed. |
| `GET /v1/gas` | $0.001 | none | Base fee, gas price, suggested EIP-1559 max fee and priority fee (gwei), block fullness, and the cost of a plain ETH transfer. |
| `GET /v1/name` | $0.001 | `name` or `address` | Forward-resolve a Basename (`name.base.eth`) or ENS name, or reverse-resolve an address to its primary name. Includes the avatar text record. |
| `GET /v1/price` | $0.003 | `token` (required) | On-chain USDC price of 1 whole token from Uniswap v3 on Base (direct USDC pool, or via WETH, best fee tier). No third-party price API. |
| `GET /v1/transfers` | $0.004 | `address` (required). Optional: `tokens` (comma-separated, max 5, default USDC), `blocks` (100–30000, default 10000), `limit` (≤200, default 50) | Recent ERC-20 transfers in and out of an address, newest first. |
| `GET /v1/contract` | $0.003 | `address` (required) | Contract, code size, `owner()`, proxy implementation, and whether the source (and implementation) is verified on [Sourcify](https://sourcify.dev). |

Example (this returns 402 until you pay):

```bash
curl -i "https://baselens-api.vercel.app/v1/gas"
curl -i "https://baselens-api.vercel.app/v1/name?name=jesse.base.eth"
```

Worked examples for every route are also in [`routes.js`](routes.js) and on [`/llms.txt`](https://baselens-api.vercel.app/llms.txt).

## Free routes

| Path | Purpose |
| --- | --- |
| `GET /free/gas` | Truncated gas sample so you can see the output shape before paying. The full reading is `GET /v1/gas` ($0.001). |
| `GET /health` | `{ ok, service, payTo, network, facilitator }`. `facilitator` is `payai` or `cdp`. |
| `GET /` | Short HTML index of the endpoints. |
| `GET /icon.png` | Service icon (`public/icon.png`, served by Vercel’s static file handling). |
| `POST /a2a` | Minimal [A2A](https://a2a-protocol.org) JSON-RPC `message/send`. Returns the free gas sample when you ask about gas, plus a catalog of paid skills with their HTTP and MCP names. Paid data itself is served over x402 HTTP or MCP. |
| `GET /a2a` | Redirects to `/.well-known/agent-card.json`. |

## How agents pay (x402)

BaseLens speaks [x402](https://x402.org) **v2**, scheme `exact`, network `eip155:8453` (Base mainnet).

1. The client requests the resource.
2. The server responds `402` with a `PAYMENT-REQUIRED` header (and a JSON body) quoting the USDC amount, asset, and `payTo`.
3. The client signs an EIP-3009 `transferWithAuthorization` for that exact amount of USDC on Base. The paying wallet needs the USDC; the facilitator submits the authorization, so the wallet does not broadcast the transaction itself.
4. The client retries the same request with a `PAYMENT-SIGNATURE` header.
5. The facilitator verifies and settles. The success response includes a `PAYMENT-RESPONSE` receipt.

The paying wallet is any EVM account that holds USDC on Base. Do not commit the private key. Cap spend in the client if you run this unattended. Each call is a fresh payment; there is no session or stored balance.

The v2 client packages are `@x402/fetch` and `@x402/axios` (successors of the v1 packages `x402-fetch` and `x402-axios`). Use the v2 packages against this server.

### Fetch

```bash
npm install @x402/fetch @x402/evm viem
```

```js
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
});

const response = await fetchWithPayment("https://baselens-api.vercel.app/v1/gas");
console.log(await response.json());
// receipt: response.headers.get("PAYMENT-RESPONSE")
```

### Axios

```bash
npm install @x402/axios @x402/evm axios viem
```

```js
import axios from "axios";
import { wrapAxiosWithPaymentFromConfig } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const api = wrapAxiosWithPaymentFromConfig(axios.create(), {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
});

const { data } = await api.get("https://baselens-api.vercel.app/v1/address", {
  params: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
});
console.log(data);
```

## MCP

Remote Streamable HTTP MCP endpoint:

```
https://baselens-api.vercel.app/mcp
```

Registry server name (see [`server.json`](server.json)):

```
app.vercel.baselens-api/baselens
```

Paid tools use [x402-over-MCP](https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md): the client sends the payment payload in `_meta["x402/payment"]` and receives the settlement in `_meta["x402/payment-response"]`. `POST` JSON-RPC to `/mcp`. The server is stateless (`GET` and `DELETE` return 405).

| Tool | Price | Same data as |
| --- | --- | --- |
| `base_address` | $0.002 | `GET /v1/address` |
| `base_erc20_balance` | $0.002 | `GET /v1/erc20-balance` |
| `base_token` | $0.003 | `GET /v1/token` |
| `base_tx` | $0.003 | `GET /v1/tx` |
| `base_gas` | $0.001 | `GET /v1/gas` |
| `base_name` | $0.001 | `GET /v1/name` |
| `base_price` | $0.003 | `GET /v1/price` |
| `base_transfers` | $0.004 | `GET /v1/transfers` |
| `base_contract` | $0.003 | `GET /v1/contract` |
| `base_free_gas_sample` | free | Truncated `/free/gas` |
| `base_catalog` | free | Tool list with prices, inputs, and HTTP URLs |

Claude Desktop and Cursor can attach the remote URL and call the two free tools. Paid tools return a payment-required error until the client attaches an x402 payment. An x402-aware MCP client (`@x402/mcp`) does that automatically.

### Claude Desktop

Add this to `claude_desktop_config.json` (Claude Desktop with remote MCP support):

```json
{
  "mcpServers": {
    "baselens": {
      "url": "https://baselens-api.vercel.app/mcp"
    }
  }
}
```

### Cursor

Add this to `~/.cursor/mcp.json` (or the project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "baselens": {
      "url": "https://baselens-api.vercel.app/mcp"
    }
  }
}
```

### Paying MCP client

```bash
npm install @x402/mcp @x402/evm @modelcontextprotocol/sdk viem
```

```js
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const client = createx402MCPClient({
  name: "baselens-caller",
  version: "1.0.0",
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => {
    console.log("paying", paymentRequired.accepts[0].amount, "USDC atomic units");
    return true;
  },
});

await client.connect(
  new StreamableHTTPClientTransport(new URL("https://baselens-api.vercel.app/mcp")),
);

const sample = await client.callTool("base_free_gas_sample", {});
const priced = await client.callTool("base_price", {
  token: "0x4200000000000000000000000000000000000006",
});
console.log(sample.content, priced.content);
```

## Discovery

| URL | What it is |
| --- | --- |
| [`/llms.txt`](https://baselens-api.vercel.app/llms.txt) | Plain-text endpoint list for agents. |
| [`/openapi.json`](https://baselens-api.vercel.app/openapi.json) | OpenAPI 3.1 description of the paid routes, including `x-x402` price, network, and `payTo`. |
| [`/.well-known/x402`](https://baselens-api.vercel.app/.well-known/x402) | x402 resource discovery document. |
| [`/.well-known/agent-card.json`](https://baselens-api.vercel.app/.well-known/agent-card.json) | A2A agent card (also at `/.well-known/agent.json`). |
| [`/server.json`](https://baselens-api.vercel.app/server.json) | MCP registry server card. Also at `/.well-known/mcp/server.json`. The copy in this repo is [`server.json`](server.json). |
| [`/.well-known/mcp/server-card.json`](https://baselens-api.vercel.app/.well-known/mcp/server-card.json) | Tool list, input schemas, and the note that paid tools settle via `_meta["x402/payment"]`. |

Bazaar discovery extensions are attached to each paid route, so facilitators that index the [x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) can list them when the Coinbase CDP facilitator is enabled (see environment variables).

## Self-hosting

Requires Node.js 24.x (`engines` in `package.json`) and outbound HTTPS to public Base and Ethereum RPC endpoints, Uniswap v3’s Quoter on Base, and Sourcify (for `/v1/contract`).

```bash
git clone https://github.com/elevatedesign/baselens.git
cd baselens
npm install
npm start          # node server.js, listens on $PORT or 3409
curl -s localhost:3409/health
```

`index.js` builds the Express app and is the module Vercel runs. `server.js` only calls `listen` for a local or VPS process. Paid routes read public RPCs at request time (`https://base-rpc.publicnode.com`, `https://mainnet.base.org`, `https://base.drpc.org`, with Ethereum mainnet for ENS and Basenames).

`check-payments.mjs` lists USDC transfers into the `payTo` address (any sender, not only BaseLens settlements):

```bash
node check-payments.mjs            # from block 53289500
node check-payments.mjs 53300000   # from a later block
```

## Deploy to Vercel

Vercel runs Express with no extra config when `index.js` default-exports the app. `public/` is served as static files (`/icon.png`). `express.static()` is not used.

1. Import this repository in the [Vercel dashboard](https://vercel.com/new), or from the repo root run `npx vercel`.
2. Leave the framework on Express / Other. There is no build step. Set the Node.js version to 24.x so it matches `package.json`.
3. Optionally set the environment variables below, then deploy.
4. The public production deployment is [https://baselens-api.vercel.app](https://baselens-api.vercel.app).

On Vercel the app is one Fluid Compute function. `/v1/transfers` can scan up to ~30,000 blocks, so give the function enough duration if you raise the default timeout.

## Environment variables

| Variable | Required | Effect |
| --- | --- | --- |
| `PORT` | no | Listen port for `node server.js`. Default `3409`. Ignored on Vercel. |
| `CDP_API_KEY_ID` | no | Together with the secret, switches the x402 facilitator from PayAI to Coinbase CDP. |
| `CDP_API_KEY_SECRET` | no | Coinbase CDP API key secret. Both CDP variables must be set; either one alone keeps the PayAI facilitator. |

With neither CDP variable set, BaseLens uses the keyless [PayAI](https://facilitator.payai.network) facilitator (`@payai/facilitator`). Setting **both** `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` calls `createFacilitatorConfig` from `@coinbase/x402` and the facilitator becomes Coinbase CDP, which indexes resources into the Coinbase x402 Bazaar. `GET /health` reports the active facilitator as `payai` or `cdp`.

Do not commit key values. `.env*` is gitignored.

## Layout

```
index.js              Express app: x402 middleware, routes, discovery, A2A
server.js             Local listener
routes.js             Prices, descriptions, and discovery examples
mcp.js                Streamable HTTP MCP at /mcp
lib/chain.js          viem reads against Base (and Ethereum for names)
server.json           MCP registry manifest
public/icon.png       Icon served at /icon.png on Vercel
check-payments.mjs    List USDC received by the payTo address
```

## License

[MIT](LICENSE) © 2026 Elevate Design NW
