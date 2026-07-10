#!/usr/bin/env node
/**
 * arxivsub-mcp — Model Context Protocol server for arXivSub.
 *
 * A thin client over the arXivSub agent-skills gateway (the same endpoint the
 * downloadable skill scripts use). It holds the user's ARXIVSUB_SKILL_KEY and
 * exposes the gateway's actions as MCP tools. All auth, quota, and Pro/trial
 * gating happen server-side in the gateway — this process never sees the
 * database or any service-role credential.
 *
 * Tools:
 *   search_papers        — search arXiv + conferences (semantic + keyword)
 *   find_similar_papers  — nearest-neighbour "related work" for a paper
 *   research_insight     — pivot analytics over the corpora (Custom Chart engine)
 *   library_save         — save/update a paper in the personal library
 *   library_list         — list the personal library
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API_URL =
  "https://qtevnmgyobilaanrzidq.supabase.co/functions/v1/agent-skills-gateway";
const SKILLS_URL = "https://arxivsub.comfyai.app/skills";
const PRICING_URL = "https://arxivsub.comfyai.app/pricing";

const NO_KEY_MESSAGE =
  `No arXivSub API key found. arxivsub-mcp needs your ARXIVSUB_SKILL_KEY.\n\n` +
  `It's free: sign in at ${SKILLS_URL} with email or Google (no credit card) to ` +
  `get your key and a 7-day free trial, then add it to this server's config, e.g.:\n\n` +
  `  "arxivsub": {\n` +
  `    "command": "npx",\n` +
  `    "args": ["-y", "arxivsub-mcp"],\n` +
  `    "env": { "ARXIVSUB_SKILL_KEY": "your_key_here" }\n` +
  `  }\n`;

/** A user-facing error whose message is safe to surface directly to the agent. */
class GatewayError extends Error {}

function getApiKey(): string {
  return (process.env.ARXIVSUB_SKILL_KEY || "").trim();
}

/**
 * POST a body to the gateway with the skill key header. Maps non-2xx responses
 * to friendly, actionable GatewayError messages (missing key, invalid key,
 * quota exhausted, trial ended, bad request).
 */
async function callGateway(body: Record<string, unknown>): Promise<any> {
  const key = getApiKey();
  if (!key) throw new GatewayError(NO_KEY_MESSAGE);

  let resp: Response;
  try {
    resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-skill-key": key,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new GatewayError(
      `Could not reach arXivSub (${e instanceof Error ? e.message : String(e)}). ` +
        `This is usually a temporary network issue — try again.`
    );
  }

  const raw = await resp.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!resp.ok) {
    const errMsg: string =
      (data && (data.error as string)) || raw || `HTTP ${resp.status}`;
    if (resp.status === 401) {
      throw new GatewayError(
        `Invalid arXivSub API key. Check ARXIVSUB_SKILL_KEY in this server's ` +
          `config — get or copy your key at ${SKILLS_URL}.`
      );
    }
    if (resp.status === 403 && /quota/i.test(errMsg)) {
      throw new GatewayError(
        `Your arXivSub daily quota is used up. It resets tomorrow — no need to retry today.`
      );
    }
    if (resp.status === 403) {
      throw new GatewayError(
        `This needs an active arXivSub Pro subscription or free-trial days. ` +
          `Your free trial may have ended — you can upgrade at ${PRICING_URL}.`
      );
    }
    throw new GatewayError(errMsg);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Summary parsing — mirrors the bundled skill scripts so tool output matches.
// summary_content is a <SEG>-delimited string. When it has 11 segments the
// first is a duplicated title and is dropped; otherwise the segments are used
// as-is. Layout (0-indexed, after the optional drop):
//   [0] what it's about  [1] innovations  [2] techniques
//   [3] datasets         [4] results      [5] limitations
//   [6] first_author     [7] first_aff    [8] last_author   [9] last_aff
// ---------------------------------------------------------------------------
function segmentsOf(summaryContent: string): string[] {
  const segments = (summaryContent || "").split("<SEG>");
  return segments.length === 11 ? segments.slice(1) : segments;
}

interface SummaryFields {
  what_about: string;
  innovations: string;
  techniques: string;
  datasets: string;
  results: string;
  limitations: string;
}

export function parseSummary(summaryContent: string): SummaryFields {
  const content = segmentsOf(summaryContent);
  const g = (i: number) => (i < content.length ? content[i].trim() : "");
  if (content.length < 6) {
    return {
      what_about: (summaryContent || "").slice(0, 300),
      innovations: "",
      techniques: "",
      datasets: "",
      results: "",
      limitations: "",
    };
  }
  return {
    what_about: g(0),
    innovations: g(1),
    techniques: g(2),
    datasets: g(3),
    results: g(4),
    limitations: g(5),
  };
}

interface AuthorTail {
  first_author: string;
  first_aff: string;
  last_author: string;
  last_aff: string;
}

/** Like parseSummary but also pulls the author tail (segments 6..9) — used by
 *  find_similar_papers, whose rows carry authors inside summary_content rather
 *  than a structured authors[] array. */
export function parseSummaryWithAuthors(
  summaryContent: string
): SummaryFields & AuthorTail {
  const content = segmentsOf(summaryContent);
  const g = (i: number) => (i < content.length ? content[i].trim() : "");
  const base = parseSummary(summaryContent);
  if (content.length < 6) {
    return { ...base, first_author: "", first_aff: "", last_author: "", last_aff: "" };
  }
  return {
    ...base,
    first_author: g(6),
    first_aff: g(7),
    last_author: g(8),
    last_aff: g(9),
  };
}

export function shapeSearchPaper(p: any, source: "arxiv" | "conferences") {
  const authors: any[] = Array.isArray(p.authors) ? p.authors : [];
  const first =
    authors.find((a) => a && a.is_first_author) || authors[0] || {};
  const last =
    authors.find((a) => a && a.is_last_author) ||
    authors[authors.length - 1] ||
    {};
  return {
    id: p.id,
    title: p.title,
    source,
    conference: p.conference_name ?? "arXiv",
    year: p.publish_year ?? null,
    arxiv_id: p.arxiv_id ?? null,
    pdf_url: p.pdf_url ?? null,
    github_url: p.github_url ?? null,
    first_author: first.name || "",
    first_aff: first.affiliation || "",
    last_author: last.name || "",
    last_aff: last.affiliation || "",
    keywords: Array.isArray(p.keywords)
      ? p.keywords.map((k: any) => k?.name).filter(Boolean)
      : [],
    ...parseSummary(p.summary_content || ""),
  };
}

export function shapeSimilarPaper(p: any, itemType: "paper" | "ciiina") {
  const source = itemType === "paper" ? "arxiv" : "conferences";
  return {
    id: p.id,
    title: p.title,
    source,
    conference: p.conference_name ?? "arXiv",
    year: p.publish_year ?? null,
    pdf_url: p.pdf_url ?? null,
    github_url: p.github_url ?? null,
    ...parseSummaryWithAuthors(p.summary_content || ""),
  };
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function textResult(obj: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "arxivsub", version: "0.1.1" });

const VENUES =
  "arxiv, CVPR, ICCV, ECCV, ICLR, ICML, NeurIPS, AAAI, MICCAI, CoRL, RSS, ACL, EMNLP, ICRA, IROS, IJCAI, SIGGRAPH, 'SIGGRAPH Asia'";

server.tool(
  "search_papers",
  "Search academic papers from arXiv and major AI/CV/ML/robotics/NLP conferences via arXivSub " +
    "(semantic + keyword search over a structured, summarized corpus). Use for 'find papers on X', " +
    "'latest research about Y', 'recent conference work on Z', or to start a literature review. " +
    "Returns each paper with a 6-part summary (what it's about, innovations, techniques, datasets, " +
    "results, limitations), authors + affiliations, pdf_url, and github_url when code is available.",
  {
    query: z.string().describe("Natural-language search query, e.g. 'LLM safety alignment'."),
    locations: z
      .array(z.string())
      .optional()
      .describe(
        `Venues to search (CASE-SENSITIVE): ${VENUES}. Include 'arxiv' for arXiv preprints. Default: ['arxiv'].`
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max papers per source (server caps at 100). Default 10."),
    arxiv_days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only arXiv papers from the last N days. Default 30."),
    conference_years: z
      .array(z.number().int())
      .optional()
      .describe("Conference publication years to include, e.g. [2024, 2025]. Default: last two years."),
    has_code: z
      .boolean()
      .optional()
      .describe("If true, only return papers that ship a public code repository (a reproducibility signal)."),
    language: z
      .string()
      .optional()
      .describe("Summary language, 'en' or 'zh'. Default 'en'."),
  },
  async (args) => {
    try {
      const body: Record<string, unknown> = {
        action: "search",
        query: args.query,
        language: args.language ?? "en",
        locations: args.locations ?? ["arxiv"],
        limit: args.limit ?? 10,
      };
      if (args.arxiv_days != null) body.arxiv_days = args.arxiv_days;
      if (args.conference_years != null) body.conference_years = args.conference_years;
      if (args.has_code) body.has_code = true;

      const data = await callGateway(body);
      const papers = [
        ...((data?.arxiv as any[]) || []).map((p) => shapeSearchPaper(p, "arxiv")),
        ...((data?.conferences as any[]) || []).map((p) =>
          shapeSearchPaper(p, "conferences")
        ),
      ];
      return textResult({
        total_papers: papers.length,
        quota_remaining: data?.quota_remaining ?? null,
        papers,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "find_similar_papers",
  "Given ONE paper you already have (from a prior search result), return the most similar papers " +
    "from the same corpus — semantic nearest neighbours, each with the full summary and code link. " +
    "Use for 'more like this', 'related work', 'what else is in this line of work', or to expand a " +
    "literature review. You can chain it: search -> pick a seed -> find_similar_papers -> repeat on a " +
    "strong neighbour.",
  {
    item_type: z
      .enum(["paper", "ciiina"])
      .describe(
        "The seed paper's type, from its search 'source': 'arxiv' -> 'paper', 'conferences' -> 'ciiina'."
      ),
    item_id: z
      .string()
      .describe("The seed paper's arXivSub id (uuid) from a prior search result. Never invent one."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("How many neighbours to return (server caps at 20). Default 8."),
    language: z.string().optional().describe("Summary language, 'en' or 'zh'. Default 'en'."),
  },
  async (args) => {
    try {
      const data = await callGateway({
        action: "similar",
        item_type: args.item_type,
        item_id: args.item_id,
        limit: args.limit ?? 8,
        language: args.language ?? "en",
      });
      const papers = ((data?.results as any[]) || []).map((p) =>
        shapeSimilarPaper(p, args.item_type)
      );
      return textResult({
        item_type: args.item_type,
        item_id: args.item_id,
        total_similar: papers.length,
        quota_remaining: data?.quota_remaining ?? null,
        papers,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "research_insight",
  "Build aggregate pivot statistics over the arXivSub corpora — the same engine as the website's " +
    "Custom Chart. Use for trends, rankings, breakdowns and comparisons: 'how has interest in diffusion " +
    "models trended', 'top institutions in RL', 'papers per month by keyword', 'avg citations by " +
    "affiliation'. Returns rows of {dim, breakdown, value} for you to interpret and visualize. " +
    "Requires Pro or active trial days.",
  {
    corpus: z
      .enum(["arxiv", "ciiina", "conference"])
      .optional()
      .describe("'arxiv' (recent arXiv) or 'ciiina' (conferences; 'conference' is an alias). Default 'arxiv'."),
    dim: z
      .string()
      .describe(
        "REQUIRED axis. arxiv: time:day|week|month|year, keyword, category, affiliation, author, citation_bin. " +
          "ciiina: time:year, keyword, conference, award, affiliation, author, citation_bin."
      ),
    measure: z
      .string()
      .optional()
      .describe(
        "count_papers (default) | count_authors | count_affiliations | count_keywords | avg_citation | " +
          "median_citation | award_rate (ciiina only)."
      ),
    breakdown: z
      .string()
      .nullable()
      .optional()
      .describe("Optional second split, same value set as dim. e.g. dim=time:month, breakdown=keyword."),
    filters: z
      .record(z.any())
      .optional()
      .describe(
        "Optional object: search, start_date, end_date, keywords[], categories[] (arxiv), " +
          "conferences[]/publish_years[]/awards[] (ciiina), affiliations[]."
      ),
    options: z
      .record(z.any())
      .optional()
      .describe("Optional object: top_n_dim, top_n_breakdown, min_count, show_others, sort."),
  },
  async (args) => {
    try {
      const data = await callGateway({
        action: "insight",
        corpus: args.corpus ?? "arxiv",
        dim: args.dim,
        measure: args.measure ?? "count_papers",
        breakdown: args.breakdown ?? null,
        filters: args.filters ?? {},
        options: args.options ?? {},
      });
      return textResult(data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "library_save",
  "Save (or update) a paper in the user's personal arXivSub library. Use for 'save this', 'bookmark " +
    "that paper', 'add it to my <X> collection', 'note that ...', 'mark as read'. Idempotent: saving the " +
    "same paper again updates only the fields you pass and never duplicates. Cannot delete — removals " +
    "are done on the website.",
  {
    item_type: z
      .enum(["paper", "ciiina"])
      .describe("From the search 'source': 'arxiv' -> 'paper', 'conferences' -> 'ciiina'."),
    item_id: z.string().describe("The item's arXivSub id (uuid) from a prior search result."),
    note: z.string().optional().describe("Optional note (<=2000 chars)."),
    reading_status: z
      .enum(["unread", "reading", "read"])
      .optional()
      .describe("Optional reading status."),
    collection_name: z
      .string()
      .optional()
      .describe("Optional collection/folder name; created automatically if it doesn't exist."),
  },
  async (args) => {
    try {
      const data = await callGateway({
        action: "library_save",
        item_type: args.item_type,
        item_id: args.item_id,
        note: args.note ?? null,
        reading_status: args.reading_status ?? null,
        collection_name: args.collection_name ?? null,
      });
      return textResult(data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.tool(
  "library_list",
  "List the user's personal arXivSub library — collections and saved items, optionally filtered. " +
    "Use for 'what have I saved', 'show my library', 'which papers are in my <name> collection', " +
    "'what am I reading'.",
  {
    status: z
      .enum(["unread", "reading", "read"])
      .optional()
      .describe("Only items with this reading status."),
    item_type: z
      .enum(["paper", "ciiina"])
      .optional()
      .describe("Only papers ('paper') or conference items ('ciiina')."),
    collection_name: z.string().optional().describe("Only items in this collection."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max items (server caps at 200). Default 100."),
  },
  async (args) => {
    try {
      const data = await callGateway({
        action: "library_list",
        status: args.status ?? null,
        item_type: args.item_type ?? null,
        collection_name: args.collection_name ?? null,
        limit: args.limit ?? 100,
      });
      return textResult(data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel — only log to stderr.
  console.error("arxivsub-mcp server running on stdio");
}

/** True only when this file is the process entry point (run directly or via the
 *  npx bin shim) — so importing it for tests does NOT start the stdio server. */
function isEntrypoint(): boolean {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const argv1 = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return self === argv1;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
