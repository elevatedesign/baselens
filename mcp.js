// Remote MCP server (Streamable HTTP, stateless) at /mcp. Paid tools use x402-over-MCP (_meta "x402/payment"); two free tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaymentWrapper } from "@x402/mcp";
import { z } from "zod";
import * as chain from "./lib/chain.js";
import { SITE, PAY_TO, NETWORK, SERVICE, PAID } from "./routes.js";

const toolName = (p) => "base_" + p.path.replace("/v1/", "").replace(/-/g, "_");
let wrappers = null;
async function getWrappers(resourceServer) {
  if (wrappers) return wrappers;
  await resourceServer.initialize();
  wrappers = {};
  for (const p of PAID) {
    const accepts = await resourceServer.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: p.price, maxTimeoutSeconds: 120 });
    wrappers[p.path] = createPaymentWrapper(resourceServer, { accepts, resource: { url: `mcp://tool/${toolName(p)}`, description: p.description, mimeType: "application/json" } });
  }
  return wrappers;
}
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });

export async function buildMcp(resourceServer) {
  const w = await getWrappers(resourceServer);
  const server = new McpServer({ name: "baselens", version: "1.1.0", title: "BaseLens: Base on-chain data (x402)" }, { instructions: `${SERVICE}: live Base (chain 8453) on-chain reads. Paid tools cost $0.001–$0.004 USDC on Base via x402 (send the payment in _meta["x402/payment"]; an x402-aware MCP client such as @x402/mcp does this automatically). Free: base_free_gas_sample, base_catalog. HTTP equivalents: ${SITE}/llms.txt` });
  for (const p of PAID) {
    const shape = Object.fromEntries(Object.entries(p.inputSchema.properties || {}).map(([k, v]) => {
      const req = (p.inputSchema.required || []).includes(k);
      const s = z.string().describe(v.description || k);
      return [k, req ? s : s.optional()];
    }));
    server.registerTool(toolName(p), { title: `${p.path} (${p.price} USDC)`, description: `${p.description} Costs ${p.price} USDC on Base via x402.`, inputSchema: shape, annotations: { readOnlyHint: true, openWorldHint: true } },
      w[p.path](async (args) => { try { return text(await chain[p.fn](args || {})); } catch (e) { return { ...text({ error: String(e?.shortMessage || e?.message || e) }), isError: true }; } }));
  }
  server.registerTool("base_free_gas_sample", { title: "Free: Base gas sample", description: "Free sample: latest Base block number and base fee (gwei). Use it to test the connection.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => { const g = await chain.gas(); return text({ block: g.block, baseFeeGwei: g.baseFeeGwei, paidVersion: "base_gas ($0.001)" }); });
  server.registerTool("base_catalog", { title: "Free: BaseLens catalog and prices", description: "Lists every BaseLens tool with price, inputs and the equivalent x402 HTTP URL.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => text({ service: SERVICE, network: NETWORK, payTo: PAY_TO, tools: PAID.map((p) => ({ tool: toolName(p), price: p.price + " USDC", http: SITE + p.path, inputs: p.inputSchema.properties, example: p.input })) }));
  return server;
}

export function mountMcp(app, resourceServer, express) {
  app.post("/mcp", express.json({ limit: "256kb" }), async (req, res) => {
    try {
      const server = await buildMcp(resourceServer);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const na = (_q, r) => r.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. POST JSON-RPC to /mcp (Streamable HTTP, stateless)." }, id: null });
  app.get("/mcp", na); app.delete("/mcp", na);
}
export { toolName };
