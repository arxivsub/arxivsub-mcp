# arxivsub-mcp

An [MCP](https://modelcontextprotocol.io) server for **[arXivSub](https://arxivsub.comfyai.app)** — search arXiv and the top AI / CV / ML / robotics / NLP conferences, follow any paper to its related work, build research analytics, and manage a personal library, straight from your AI agent (Claude Desktop, Cursor, Cline, Claude Code, Windsurf, …).

arXivSub summarizes every paper into a structured 6-part breakdown (what it's about, innovations, techniques, datasets, results, limitations) and indexes it for semantic search across **arXiv + CVPR, ICCV, ECCV, ICLR, ICML, NeurIPS, AAAI, MICCAI, CoRL, RSS, ACL, EMNLP, ICRA, IROS, IJCAI, SIGGRAPH, SIGGRAPH Asia**. This server puts that engine directly in your agent's hands.

## Get a free key (7-day trial, no credit card)

1. Sign in at **https://arxivsub.comfyai.app/skills** with email or Google.
2. Copy your API key from the Skills page.
3. Put it in the server config below as `ARXIVSUB_SKILL_KEY`.

New accounts get a **7-day free trial** of the full skill. After that it's part of arXivSub Pro.

## Install

The server runs via `npx` — no manual install needed. Add it to your MCP client's config.

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`~/.cursor/mcp.json`), **Windsurf**, **Cline**, etc.:

```json
{
  "mcpServers": {
    "arxivsub": {
      "command": "npx",
      "args": ["-y", "arxivsub-mcp"],
      "env": { "ARXIVSUB_SKILL_KEY": "your_key_here" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add arxivsub --env ARXIVSUB_SKILL_KEY=your_key_here -- npx -y arxivsub-mcp
```

Restart your client and the tools below become available.

## Tools

| Tool | What it does |
|------|--------------|
| `search_papers` | Semantic + keyword search over arXiv and conferences. Filters: venues, recency, year, `has_code`. Returns each paper's 6-part summary, authors, PDF, and code link. |
| `find_similar_papers` | Nearest-neighbour "related work" for a paper you already found. Chainable for a mini literature review. |
| `research_insight` | Pivot analytics (the website's Custom Chart engine): trends, rankings, breakdowns. *Pro / trial.* |
| `library_save` | Save/update a paper in your personal library — notes, reading status, collections. |
| `library_list` | List your saved papers and collections. |

Just ask your agent naturally — *"find recent papers on LLM safety with code"*, *"more work like this one"*, *"how has interest in diffusion models trended by month"*, *"save this to my "to read" collection"* — and it will pick the right tool.

## Notes

- **Case-sensitive venues:** `arxiv`, `CVPR`, `ICCV`, `ECCV`, `ICLR`, `ICML`, `NeurIPS`, `AAAI`, `MICCAI`, `CoRL`, `RSS`, `ACL`, `EMNLP`, `ICRA`, `IROS`, `IJCAI`, `SIGGRAPH`, `SIGGRAPH Asia`.
- **Quota:** each search / similar / insight call uses one daily quota unit; library calls are free. The remaining quota is returned with every result.
- **Privacy / security:** the server only holds your skill key and talks to the arXivSub gateway over HTTPS. It has no direct database access and no service credentials.

## Development

```bash
npm install
npm run build           # tsc -> dist/
ARXIVSUB_SKILL_KEY=... node dist/index.js   # run over stdio
```

## License

MIT
