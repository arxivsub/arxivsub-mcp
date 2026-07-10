// Smoke test: connect to the built server over stdio, list tools, and exercise
// the no-key onboarding path. Does NOT use a real API key.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { PATH: process.env.PATH ?? "" }, // deliberately NO ARXIVSUB_SKILL_KEY
});

const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\n=== tools/list -> ${tools.length} tools ===`);
for (const t of tools) {
  const props = Object.keys(t.inputSchema?.properties ?? {});
  const required = t.inputSchema?.required ?? [];
  console.log(`- ${t.name}(${props.map((p) => (required.includes(p) ? p + "*" : p)).join(", ")})`);
}

console.log(`\n=== tools/call search_papers WITHOUT a key (onboarding path) ===`);
const res = await client.callTool({
  name: "search_papers",
  arguments: { query: "diffusion models" },
});
console.log("isError:", res.isError);
console.log("text:\n" + res.content.map((c) => c.text).join("\n"));

await client.close();
console.log("\n=== smoke test done ===");
process.exit(0);
