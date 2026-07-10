// Supabase edge function: `mcp`
// Remote MCP server (Streamable HTTP) for arXivSub, so it can be added as a
// "custom connector" on claude.ai (URL-only). It is a thin PROTOCOL ADAPTER:
// it speaks MCP JSON-RPC over HTTP and forwards each tool call to the existing
// `agent-skills-gateway` (which does ALL auth / Pro-trial gating / quota). The
// user's skill key travels in the URL query (?key=...), since the connector UI
// only accepts a URL. initialize + tools/list need NO key (so the connector
// connects); only tools/call uses it, and with no key it returns a friendly
// "get a free key" message instead of failing.
//
// Deploy (public, no JWT — same as the gateway):
//   supabase functions deploy mcp --no-verify-jwt
// Connector URL to paste into claude.ai:
//   https://<project>.supabase.co/functions/v1/mcp?key=<ARXIVSUB_SKILL_KEY>

const GATEWAY_URL =
  "https://qtevnmgyobilaanrzidq.supabase.co/functions/v1/agent-skills-gateway";
const SKILLS_URL = "https://arxivsub.comfyai.app/skills";
const PRICING_URL = "https://arxivsub.comfyai.app/pricing";
const SERVER_VERSION = "0.1.1";
const DEFAULT_PROTOCOL = "2025-06-18";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-skill-key, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

const NO_KEY_MESSAGE =
  `No arXivSub API key found. This connector needs your key in its URL.\n\n` +
  `It's free: sign in at ${SKILLS_URL} with email or Google (no credit card) to get ` +
  `your key and a 7-day free trial, then use a connector URL that ends with ` +
  `?key=YOUR_KEY (replacing YOUR_KEY with your actual key).`;

// ---------------------------------------------------------------------------
// Tool schemas (JSON Schema) advertised via tools/list
// ---------------------------------------------------------------------------
const VENUES =
  "arxiv, CVPR, ICCV, ECCV, ICLR, ICML, NeurIPS, AAAI, MICCAI, CoRL, RSS, ACL, EMNLP, ICRA, IROS, IJCAI, SIGGRAPH, 'SIGGRAPH Asia'";

const TOOLS = [
  {
    name: "search_papers",
    description:
      "Search academic papers from arXiv and major AI/CV/ML/robotics/NLP conferences via arXivSub " +
      "(semantic + keyword). Use for 'find papers on X', 'latest research about Y', 'recent conference " +
      "work on Z', or to start a literature review. Returns each paper's 6-part summary, authors + " +
      "affiliations, pdf_url, and github_url when code is available.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        locations: {
          type: "array",
          items: { type: "string" },
          description: `Venues (CASE-SENSITIVE): ${VENUES}. Include 'arxiv' for preprints. Default ['arxiv'].`,
        },
        limit: { type: "integer", description: "Max papers per source (server caps at 100). Default 10." },
        arxiv_days: { type: "integer", description: "Only arXiv papers from the last N days. Default 30." },
        conference_years: {
          type: "array",
          items: { type: "integer" },
          description: "Conference years, e.g. [2024, 2025]. Default: last two years.",
        },
        has_code: { type: "boolean", description: "Only papers that ship a public code repository." },
        language: { type: "string", description: "Summary language, 'en' or 'zh'. Default 'en'." },
      },
      required: ["query"],
    },
  },
  {
    name: "find_similar_papers",
    description:
      "Given ONE paper you already have (from a prior search result), return the most similar papers " +
      "from the same corpus (semantic nearest neighbours), each with the full summary and code link. " +
      "Use for 'more like this', 'related work', or to expand a literature review. Chainable.",
    inputSchema: {
      type: "object",
      properties: {
        item_type: {
          type: "string",
          enum: ["paper", "ciiina"],
          description: "Seed paper's type from its search 'source': 'arxiv'->'paper', 'conferences'->'ciiina'.",
        },
        item_id: { type: "string", description: "Seed paper's arXivSub id (uuid) from a prior search. Never invent one." },
        limit: { type: "integer", description: "How many neighbours (server caps at 20). Default 8." },
        language: { type: "string", description: "Summary language, 'en' or 'zh'. Default 'en'." },
      },
      required: ["item_type", "item_id"],
    },
  },
  {
    name: "research_insight",
    description:
      "Build aggregate pivot statistics over the arXivSub corpora (the website's Custom Chart engine): " +
      "trends, rankings, breakdowns. Returns rows of {dim, breakdown, value} to interpret and visualize. " +
      "Requires Pro or active trial days.",
    inputSchema: {
      type: "object",
      properties: {
        corpus: { type: "string", enum: ["arxiv", "ciiina", "conference"], description: "Default 'arxiv'." },
        dim: {
          type: "string",
          description:
            "REQUIRED axis. arxiv: time:day|week|month|year, keyword, category, affiliation, author, citation_bin. " +
            "ciiina: time:year, keyword, conference, award, affiliation, author, citation_bin.",
        },
        measure: {
          type: "string",
          description: "count_papers (default) | count_authors | count_affiliations | count_keywords | avg_citation | median_citation | award_rate (ciiina).",
        },
        breakdown: { type: ["string", "null"], description: "Optional second split, same value set as dim." },
        filters: { type: "object", description: "search, start_date, end_date, keywords[], categories[], conferences[], publish_years[], awards[], affiliations[]." },
        options: { type: "object", description: "top_n_dim, top_n_breakdown, min_count, show_others, sort." },
      },
      required: ["dim"],
    },
  },
  {
    name: "library_save",
    description:
      "Save (or update) a paper in the user's personal arXivSub library. Idempotent; updates only the " +
      "fields you pass; never duplicates. Cannot delete (done on the website).",
    inputSchema: {
      type: "object",
      properties: {
        item_type: { type: "string", enum: ["paper", "ciiina"], description: "From search 'source': 'arxiv'->'paper', 'conferences'->'ciiina'." },
        item_id: { type: "string", description: "The item's arXivSub id (uuid) from a prior search." },
        note: { type: "string", description: "Optional note (<=2000 chars)." },
        reading_status: { type: "string", enum: ["unread", "reading", "read"], description: "Optional." },
        collection_name: { type: "string", description: "Optional collection; created if missing." },
      },
      required: ["item_type", "item_id"],
    },
  },
  {
    name: "library_list",
    description:
      "List the user's personal arXivSub library (collections + saved items), optionally filtered. " +
      "Use for 'what have I saved', 'show my library', 'what am I reading'.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["unread", "reading", "read"], description: "Filter by reading status." },
        item_type: { type: "string", enum: ["paper", "ciiina"], description: "Filter by type." },
        collection_name: { type: "string", description: "Only items in this collection." },
        limit: { type: "integer", description: "Max items (server caps at 200). Default 100." },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Summary parsing — identical to the arxivsub-mcp stdio server / skill scripts
// ---------------------------------------------------------------------------
function segmentsOf(s: string): string[] {
  const seg = (s || "").split("<SEG>");
  return seg.length === 11 ? seg.slice(1) : seg;
}
function parseSummary(s: string) {
  const c = segmentsOf(s);
  const g = (i: number) => (i < c.length ? c[i].trim() : "");
  if (c.length < 6) {
    return { what_about: (s || "").slice(0, 300), innovations: "", techniques: "", datasets: "", results: "", limitations: "" };
  }
  return { what_about: g(0), innovations: g(1), techniques: g(2), datasets: g(3), results: g(4), limitations: g(5) };
}
function parseSummaryWithAuthors(s: string) {
  const c = segmentsOf(s);
  const g = (i: number) => (i < c.length ? c[i].trim() : "");
  const base = parseSummary(s);
  if (c.length < 6) return { ...base, first_author: "", first_aff: "", last_author: "", last_aff: "" };
  return { ...base, first_author: g(6), first_aff: g(7), last_author: g(8), last_aff: g(9) };
}
function shapeSearchPaper(p: any, source: "arxiv" | "conferences") {
  const authors: any[] = Array.isArray(p.authors) ? p.authors : [];
  const first = authors.find((a) => a && a.is_first_author) || authors[0] || {};
  const last = authors.find((a) => a && a.is_last_author) || authors[authors.length - 1] || {};
  return {
    id: p.id, title: p.title, source,
    conference: p.conference_name ?? "arXiv", year: p.publish_year ?? null,
    arxiv_id: p.arxiv_id ?? null, pdf_url: p.pdf_url ?? null, github_url: p.github_url ?? null,
    first_author: first.name || "", first_aff: first.affiliation || "",
    last_author: last.name || "", last_aff: last.affiliation || "",
    keywords: Array.isArray(p.keywords) ? p.keywords.map((k: any) => k?.name).filter(Boolean) : [],
    ...parseSummary(p.summary_content || ""),
  };
}
function shapeSimilarPaper(p: any, itemType: "paper" | "ciiina") {
  const source = itemType === "paper" ? "arxiv" : "conferences";
  return {
    id: p.id, title: p.title, source,
    conference: p.conference_name ?? "arXiv", year: p.publish_year ?? null,
    pdf_url: p.pdf_url ?? null, github_url: p.github_url ?? null,
    ...parseSummaryWithAuthors(p.summary_content || ""),
  };
}

// ---------------------------------------------------------------------------
// Gateway call (delegates all auth/quota); maps failures to friendly messages
// ---------------------------------------------------------------------------
class ToolError extends Error {}

async function callGateway(body: Record<string, unknown>, key: string): Promise<any> {
  if (!key) throw new ToolError(NO_KEY_MESSAGE);
  let resp: Response;
  try {
    resp = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-skill-key": key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ToolError(`Could not reach arXivSub (${(e as Error)?.message || e}). Try again.`);
  }
  const raw = await resp.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!resp.ok) {
    const msg: string = (data && data.error) || raw || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new ToolError(`Invalid arXivSub API key in the connector URL. Get or copy your key at ${SKILLS_URL}.`);
    if (resp.status === 403 && /quota/i.test(msg)) throw new ToolError(`Your arXivSub daily quota is used up. It resets tomorrow.`);
    if (resp.status === 403) throw new ToolError(`This needs an active arXivSub Pro subscription or free-trial days. Upgrade at ${PRICING_URL}.`);
    throw new ToolError(msg);
  }
  return data;
}

const textResult = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const errorResult = (e: unknown) => ({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });

async function callTool(name: string, args: any, key: string) {
  args = args || {};
  try {
    if (name === "search_papers") {
      const body: Record<string, unknown> = {
        action: "search", query: args.query, language: args.language ?? "en",
        locations: args.locations ?? ["arxiv"], limit: args.limit ?? 10,
      };
      if (args.arxiv_days != null) body.arxiv_days = args.arxiv_days;
      if (args.conference_years != null) body.conference_years = args.conference_years;
      if (args.has_code) body.has_code = true;
      const data = await callGateway(body, key);
      const papers = [
        ...((data?.arxiv as any[]) || []).map((p) => shapeSearchPaper(p, "arxiv")),
        ...((data?.conferences as any[]) || []).map((p) => shapeSearchPaper(p, "conferences")),
      ];
      return textResult({ total_papers: papers.length, quota_remaining: data?.quota_remaining ?? null, papers });
    }
    if (name === "find_similar_papers") {
      const data = await callGateway(
        { action: "similar", item_type: args.item_type, item_id: args.item_id, limit: args.limit ?? 8, language: args.language ?? "en" },
        key
      );
      const papers = ((data?.results as any[]) || []).map((p) => shapeSimilarPaper(p, args.item_type));
      return textResult({ item_type: args.item_type, item_id: args.item_id, total_similar: papers.length, quota_remaining: data?.quota_remaining ?? null, papers });
    }
    if (name === "research_insight") {
      const data = await callGateway(
        { action: "insight", corpus: args.corpus ?? "arxiv", dim: args.dim, measure: args.measure ?? "count_papers", breakdown: args.breakdown ?? null, filters: args.filters ?? {}, options: args.options ?? {} },
        key
      );
      return textResult(data);
    }
    if (name === "library_save") {
      const data = await callGateway(
        { action: "library_save", item_type: args.item_type, item_id: args.item_id, note: args.note ?? null, reading_status: args.reading_status ?? null, collection_name: args.collection_name ?? null },
        key
      );
      return textResult(data);
    }
    if (name === "library_list") {
      const data = await callGateway(
        { action: "library_list", status: args.status ?? null, item_type: args.item_type ?? null, collection_name: args.collection_name ?? null, limit: args.limit ?? 100 },
        key
      );
      return textResult(data);
    }
    throw new ToolError(`Unknown tool: ${name}`);
  } catch (e) {
    return errorResult(e);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------
function rpcResult(id: any, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: any, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }

// Returns a JSON-RPC response object, or null for notifications (no id).
async function handleMessage(msg: any, key: string): Promise<any | null> {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    const clientProto = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: typeof clientProto === "string" ? clientProto : DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "arxivsub", version: SERVER_VERSION },
      instructions: "Search arXiv and top AI/ML/CV/NLP/robotics conference papers, follow related work, run analytics, and manage a personal library.",
    });
  }
  if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) {
    return null; // notification: no response
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    const result = await callTool(params?.name, params?.arguments, key);
    return rpcResult(id, result);
  }
  // resources/prompts not supported
  if (method === "resources/list") return rpcResult(id, { resources: [] });
  if (method === "prompts/list") return rpcResult(id, { prompts: [] });

  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method === "GET") {
    // No server-initiated stream in this stateless adapter.
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST for MCP." } }), {
      status: 405, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (req.method === "DELETE") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: cors });

  const key = new URL(req.url).searchParams.get("key") || req.headers.get("x-agent-skill-key") || "";

  let payload: any;
  try { payload = await req.json(); } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Batch or single
  if (Array.isArray(payload)) {
    const out: any[] = [];
    for (const m of payload) {
      const r = await handleMessage(m, key);
      if (r) out.push(r);
    }
    if (out.length === 0) return new Response(null, { status: 202, headers: cors });
    return new Response(JSON.stringify(out), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  const r = await handleMessage(payload, key);
  if (!r) return new Response(null, { status: 202, headers: cors });

  // Prefer SSE when the client accepts it (matches the reference Streamable-HTTP
  // server, which claude.ai is tested against); fall back to plain JSON.
  const wantsSSE = (req.headers.get("accept") || "").includes("text/event-stream");
  if (wantsSSE) {
    const body = `event: message\ndata: ${JSON.stringify(r)}\n\n`;
    return new Response(body, { headers: { ...cors, "Content-Type": "text/event-stream" } });
  }
  return new Response(JSON.stringify(r), { headers: { ...cors, "Content-Type": "application/json" } });
});
