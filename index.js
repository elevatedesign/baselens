import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { facilitator as payai } from "@payai/facilitator";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import * as chain from "./lib/chain.js";
import { SITE, PAY_TO, NETWORK, SERVICE, PAID } from "./routes.js";
import { mountMcp, toolName } from "./mcp.js";

// CDP facilitator (indexes into Coinbase x402 Bazaar) when CDP keys are configured; PayAI (keyless) otherwise.
const useCdp = !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
const facilitatorConfig = useCdp ? createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET) : payai;

const app = express();
app.disable("x-powered-by");
const paidPaths = new Set(PAID.map((p) => p.path));
app.use((req, _res, next) => { if (req.method === "HEAD" && paidPaths.has(req.path)) req.method = "GET"; next(); });
app.use((req, res, next) => { res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Mcp-Session-Id"); res.setHeader("access-control-allow-headers", "*"); if (req.method === "OPTIONS") return res.status(204).end(); next(); });

const units = (price) => String(Math.round(parseFloat(price.replace("$", "")) * 1e6));
const routes = {};
for (const p of PAID) {
  routes[`GET ${p.path}`] = {
    accepts: { scheme: "exact", price: p.price, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 },
    resource: SITE + p.path, description: p.description, mimeType: "application/json", serviceName: SERVICE, tags: p.tags, iconUrl: SITE + "/icon.png",
    extensions: { ...declareDiscoveryExtension({ input: p.input, inputSchema: p.inputSchema, output: { example: p.output } }) },
    unpaidResponseBody: () => ({ contentType: "application/json", body: { x402Version: 2, error: "payment_required", resource: { url: SITE + p.path, description: p.description, mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: NETWORK, amount: units(p.price), maxAmountRequired: units(p.price), asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, resource: SITE + p.path, description: p.description, mimeType: "application/json", maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }],
      price: p.price + " USDC on Base", docs: SITE + "/", example: p.output } }),
  };
}
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorConfig)).register(NETWORK, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
app.use(paymentMiddleware(routes, resourceServer));
mountMcp(app, resourceServer, express);

const wrap = (fn) => async (req, res) => { try { res.json(await fn(req.query)); } catch (e) { res.status(400).json({ error: String(e?.shortMessage || e?.message || e) }); } };
for (const p of PAID) app.get(p.path, wrap(chain[p.fn]));

// Free sample so humans/agents can see the output shape before paying.
app.get("/free/gas", wrap(async () => { const g = await chain.gas(); return { block: g.block, baseFeeGwei: g.baseFeeGwei, full: `${SITE}/v1/gas (x402, $0.001 USDC)` }; }));

const list = PAID.map((p) => `- GET ${SITE}${p.path} — ${p.price} USDC (Base) — ${p.description}\n  example: ${SITE}${p.path}?${new URLSearchParams(p.input)}`).join("\n");
const llms = `# ${SERVICE}\n\n> Pay-per-call Base (chain 8453) on-chain reads for AI agents over x402. No account, no API key: call the URL, get HTTP 402, pay the quoted USDC on Base, retry with the payment header. Prices $0.001–$0.004.\n\n## Endpoints\n${list}\n\n## MCP (remote, Streamable HTTP)\n- ${SITE}/mcp — same tools (base_address, base_price, base_transfers, …) with x402-over-MCP payments, plus free base_free_gas_sample and base_catalog.\n\n## Free\n- GET ${SITE}/free/gas — sample\n- GET ${SITE}/.well-known/agent.json — agent card\n- GET ${SITE}/openapi.json\n- GET ${SITE}/.well-known/x402\n\nData: live reads from public Base RPC nodes at the latest block. Read-only facts, not financial advice. Operated by Project Alpha (autonomous agent).\n`;
app.get("/llms.txt", (_q, r) => r.type("text/plain").send(llms));
app.get("/", (_q, r) => r.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${SERVICE}: pay-per-call Base on-chain data for AI agents (x402)</title><meta name="description" content="Base address, ERC-20 balance, token price, recent transfers, Basename/ENS resolve, contract verification, tx summaries and gas over x402 and MCP. $0.001–$0.004 USDC per call, no API key."><link rel="icon" href="/icon.png"><style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#111}code,pre{background:#f3f4f6;border-radius:6px;padding:2px 6px}pre{padding:12px;overflow:auto}</style></head><body><h1>${SERVICE}</h1><p>Pay-per-call <b>Base</b> on-chain reads for AI agents, over <a href="https://x402.org">x402</a>. No signup, no API key: request a URL, receive <code>402 Payment Required</code>, pay the quoted USDC on Base, and retry.</p><h2>Endpoints</h2><ul>${PAID.map((p) => `<li><code>GET ${p.path}</code> · <b>${p.price}</b> · ${p.description}</li>`).join("")}</ul><h2>MCP</h2><p>Remote MCP server (Streamable HTTP): <code>${SITE}/mcp</code>. Paid tools settle via x402-over-MCP (e.g. <code>@x402/mcp</code> client); <code>base_free_gas_sample</code> and <code>base_catalog</code> are free.</p><pre>{ "mcpServers": { "baselens": { "url": "${SITE}/mcp" } } }</pre><p>Free sample: <a href="/free/gas">/free/gas</a> · <a href="/openapi.json">openapi.json</a> · <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/agent.json">agent card</a></p><p style="color:#555">Live reads from public Base RPC nodes. Read-only facts, not financial advice. Operated by Project Alpha, an autonomous agent.</p></body></html>`));
app.get("/openapi.json", (_q, r) => r.json({ openapi: "3.1.0", info: { title: SERVICE, version: "1.1.0", description: "Pay-per-call Base on-chain reads over x402 (USDC on Base).", contact: { name: "BaseLens", email: "alphaops@mail.grokbot.com" } }, servers: [{ url: SITE }],
  paths: Object.fromEntries(PAID.map((p) => [p.path, { get: { summary: p.description, parameters: Object.entries(p.inputSchema.properties || {}).map(([n, s]) => ({ name: n, in: "query", required: (p.inputSchema.required || []).includes(n), schema: { type: "string" }, description: s.description })),
    responses: { 200: { description: "OK", content: { "application/json": { example: p.output } } }, 402: { description: `Payment required: ${p.price} USDC on Base (x402)` } }, "x-x402": { price: p.price, network: NETWORK, payTo: PAY_TO } } }])) }));
app.get("/.well-known/x402", (_q, r) => r.json({ version: 1, resources: PAID.map((p) => SITE + p.path), ownershipProofs: [] }));

const agentCard = {
  protocolVersion: "0.3.0", name: SERVICE, description: "Pay-per-call Base (chain 8453) on-chain data for AI agents: address snapshot, ERC-20 balances, token facts and USDC price, recent transfers, Basename/ENS resolution, contract verification, transaction summaries and gas. x402 USDC micropayments, no API key.",
  url: SITE + "/a2a", preferredTransport: "JSONRPC", version: "1.1.0", iconUrl: SITE + "/icon.png", documentationUrl: SITE + "/llms.txt",
  provider: { organization: "Project Alpha (autonomous agent)", url: SITE },
  capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: "https://github.com/coinbase/x402", description: "x402 payments (USDC on Base)", required: true, params: { network: NETWORK, payTo: PAY_TO } }] },
  defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
  additionalInterfaces: [{ url: SITE + "/a2a", transport: "JSONRPC" }],
  mcp: { url: SITE + "/mcp", transport: "streamable-http" }, openapi: SITE + "/openapi.json",
  skills: PAID.map((p) => ({ id: toolName(p), name: p.path, description: `${p.description} Price ${p.price} USDC.`, tags: p.tags, examples: [`${SITE}${p.path}?${new URLSearchParams(p.input)}`] })),
  x402: { network: NETWORK, asset: "USDC", payTo: PAY_TO, resources: PAID.map((p) => ({ url: SITE + p.path, price: p.price })) },
};

// Minimal A2A JSON-RPC endpoint: free gas sample and catalog; paid data is served over x402 HTTP or MCP (links in the reply).
app.post("/a2a", express.json({ limit: "64kb" }), async (req, res) => {
  const { id = null, method, params } = req.body || {};
  if (method !== "message/send") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Only message/send is supported. Paid data: " + SITE + "/llms.txt" } });
  const parts = params?.message?.parts || [];
  const wantText = parts.map((p) => p.text || "").join(" ").toLowerCase();
  const data = parts.find((p) => p.kind === "data")?.data || {};
  let out;
  if (data.skill === "base_free_gas_sample" || /\bgas\b/.test(wantText)) { const g = await chain.gas().catch(() => null); out = { freeGasSample: g && { block: g.block, baseFeeGwei: g.baseFeeGwei } }; }
  const catalog = PAID.map((p) => ({ skill: toolName(p), price: p.price + " USDC (Base, x402)", http: `${SITE}${p.path}?${new URLSearchParams(p.input)}`, mcpTool: toolName(p) }));
  res.json({ jsonrpc: "2.0", id, result: { kind: "message", role: "agent", messageId: "bl-" + Date.now(), contextId: params?.message?.contextId,
    parts: [{ kind: "text", text: `BaseLens serves paid Base on-chain data over x402 HTTP (${SITE}/llms.txt) and MCP (${SITE}/mcp). Call an http URL below, pay the 402 in USDC on Base, retry.` }, { kind: "data", data: { ...out, catalog } }] } });
});
app.get("/a2a", (_q, r) => r.redirect(302, "/.well-known/agent-card.json"));
app.get(["/.well-known/agent.json", "/.well-known/agent-card.json"], (_q, r) => r.json(agentCard));
const mcpServerJson = { $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", name: "app.vercel.baselens-api/baselens", title: "BaseLens", description: "Base on-chain data for agents: balances, prices, transfers, Basenames, contracts. x402 pay-per-call.", version: "1.1.0", websiteUrl: SITE, remotes: [{ type: "streamable-http", url: SITE + "/mcp" }] };
app.get(["/server.json", "/.well-known/mcp/server.json"], (_q, r) => r.json(mcpServerJson));
const serverCard = { serverInfo: { name: "baselens", title: "BaseLens", version: "1.1.0" }, description: mcpServerJson.description, transport: { type: "streamable-http", url: SITE + "/mcp" }, authentication: { required: false, note: "No auth. Paid tools settle per call via x402 (USDC on Base) in _meta[\"x402/payment\"]." },
  tools: [...PAID.map((p) => ({ name: toolName(p), description: `${p.description} Costs ${p.price} USDC on Base via x402.`, inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(p.inputSchema.properties || {}).map(([k, v]) => [k, { type: "string", description: v.description }])), required: p.inputSchema.required || [] } })),
    { name: "base_free_gas_sample", description: "Free sample: latest Base block number and base fee (gwei).", inputSchema: { type: "object", properties: {} } },
    { name: "base_catalog", description: "Free: lists every BaseLens tool with price, inputs and the equivalent x402 HTTP URL.", inputSchema: { type: "object", properties: {} } }] };
app.get("/.well-known/mcp/server-card.json", (_q, r) => r.json(serverCard));
app.get("/.well-known/mcp-registry-auth", (_q, r) => r.type("text/plain").send("v=MCPv1; k=ed25519; p=mHso3W5Wtpx95H2aDgZxJE3tXjCnOaPYJRs5WddwdtM="));
app.get("/robots.txt", (_q, r) => r.type("text/plain").send("User-agent: *\nAllow: /\n"));
app.get("/health", (_q, r) => r.json({ ok: true, service: SERVICE, payTo: PAY_TO, network: NETWORK, facilitator: useCdp ? "cdp" : "payai" }));
export default app;
