// Real end-to-end probe: search -> follow the first result to its neighbours,
// through the actual MCP server -> gateway -> DB. Run with YOUR key:
//
//   ARXIVSUB_SKILL_KEY=xxx node probe.mjs "your query" [locations...]
//
// The key stays in your shell env and is never printed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const query = process.argv[2] || "diffusion models";
const locations = process.argv.slice(3);
if (locations.length === 0) locations.push("arxiv");

if (!process.env.ARXIVSUB_SKILL_KEY) {
  console.error("Set ARXIVSUB_SKILL_KEY first: ARXIVSUB_SKILL_KEY=xxx node probe.mjs \"query\"");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { PATH: process.env.PATH ?? "", ARXIVSUB_SKILL_KEY: process.env.ARXIVSUB_SKILL_KEY },
});
const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
await client.connect(transport);

const parse = (res) => JSON.parse(res.content.map((c) => c.text).join(""));

console.log(`\n=== search_papers query="${query}" locations=${JSON.stringify(locations)} ===`);
const s = await client.callTool({
  name: "search_papers",
  arguments: { query, locations, limit: 5 },
});
if (s.isError) {
  console.log("ERROR:", s.content.map((c) => c.text).join(""));
  await client.close();
  process.exit(1);
}
const sd = parse(s);
console.log(`total_papers=${sd.total_papers}, quota_remaining=${sd.quota_remaining}`);
for (const p of sd.papers.slice(0, 5)) {
  console.log(`  [${p.source}/${p.conference} ${p.year ?? ""}] ${p.title}`);
  console.log(`     ${p.first_author} (${p.first_aff}) | code: ${p.github_url ? "yes" : "no"}`);
}

const seed = sd.papers[0];
if (seed) {
  const type = seed.source === "arxiv" ? "paper" : "ciiina";
  console.log(`\n=== find_similar_papers type=${type} id=${seed.id} ===`);
  const r = await client.callTool({
    name: "find_similar_papers",
    arguments: { item_type: type, item_id: seed.id, limit: 5 },
  });
  if (r.isError) {
    console.log("ERROR:", r.content.map((c) => c.text).join(""));
  } else {
    const rd = parse(r);
    console.log(`total_similar=${rd.total_similar}, quota_remaining=${rd.quota_remaining}`);
    for (const p of rd.papers.slice(0, 5)) {
      console.log(`  [${p.conference} ${p.year ?? ""}] ${p.title}`);
    }
  }
}

await client.close();
console.log("\n=== probe done ===");
process.exit(0);
