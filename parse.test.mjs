// Parser parity test: verify the <SEG> summary parsing + author extraction
// against the same layout the bundled Python skill scripts produce.
import assert from "node:assert";
import {
  parseSummary,
  parseSummaryWithAuthors,
  shapeSearchPaper,
  shapeSimilarPaper,
} from "./dist/index.js";

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// 11 segments: first is a duplicated title and must be dropped -> [1..10] used.
const seg11 =
  "Dup Title<SEG>What it's about<SEG>Innovations<SEG>Techniques<SEG>Datasets<SEG>Results<SEG>Limitations<SEG>Alice<SEG>MIT<SEG>Bob<SEG>Stanford";
// 10 segments: used as-is [0..9].
const seg10 =
  "What10<SEG>Innov10<SEG>Tech10<SEG>Data10<SEG>Res10<SEG>Lim10<SEG>Carol<SEG>CMU<SEG>Dan<SEG>Oxford";

check("parseSummary drops the dup title on 11 segments", () => {
  const s = parseSummary(seg11);
  assert.equal(s.what_about, "What it's about");
  assert.equal(s.innovations, "Innovations");
  assert.equal(s.limitations, "Limitations");
});

check("parseSummary uses segments as-is on 10 segments", () => {
  const s = parseSummary(seg10);
  assert.equal(s.what_about, "What10");
  assert.equal(s.limitations, "Lim10");
});

check("parseSummary falls back for short/garbage input", () => {
  const s = parseSummary("just a blurb, no segments");
  assert.equal(s.what_about, "just a blurb, no segments");
  assert.equal(s.innovations, "");
});

check("parseSummaryWithAuthors pulls the author tail (11 seg)", () => {
  const s = parseSummaryWithAuthors(seg11);
  assert.equal(s.what_about, "What it's about");
  assert.equal(s.first_author, "Alice");
  assert.equal(s.first_aff, "MIT");
  assert.equal(s.last_author, "Bob");
  assert.equal(s.last_aff, "Stanford");
});

check("shapeSearchPaper uses structured authors + maps fields", () => {
  const p = {
    id: "uuid-1",
    title: "Paper One",
    conference_name: "NeurIPS",
    publish_year: 2025,
    arxiv_id: "2501.00001",
    pdf_url: "https://x/pdf",
    github_url: "https://github.com/a/b",
    authors: [
      { name: "Alice", affiliation: "MIT", is_first_author: true, is_last_author: false },
      { name: "Zed", affiliation: "Meta", is_first_author: false, is_last_author: true },
    ],
    keywords: [{ name: "LLM" }, { name: "Safety" }],
    summary_content: seg11,
  };
  const out = shapeSearchPaper(p, "conferences");
  assert.equal(out.source, "conferences");
  assert.equal(out.conference, "NeurIPS");
  assert.equal(out.first_author, "Alice");
  assert.equal(out.last_author, "Zed");
  assert.equal(out.last_aff, "Meta");
  assert.equal(out.github_url, "https://github.com/a/b");
  assert.deepEqual(out.keywords, ["LLM", "Safety"]);
  assert.equal(out.what_about, "What it's about");
});

check("shapeSearchPaper handles missing authors/keywords/github gracefully", () => {
  const out = shapeSearchPaper(
    { id: "u2", title: "Bare", summary_content: seg10 },
    "arxiv"
  );
  assert.equal(out.source, "arxiv");
  assert.equal(out.conference, "arXiv");
  assert.equal(out.first_author, "");
  assert.equal(out.github_url, null);
  assert.deepEqual(out.keywords, []);
  assert.equal(out.what_about, "What10");
});

check("shapeSimilarPaper maps type->source and reads author tail", () => {
  const out = shapeSimilarPaper(
    {
      id: "u3",
      title: "Neighbour",
      conference_name: "CVPR",
      publish_year: 2024,
      pdf_url: "https://y/pdf",
      github_url: null,
      summary_content: seg11,
    },
    "ciiina"
  );
  assert.equal(out.source, "conferences");
  assert.equal(out.first_author, "Alice");
  assert.equal(out.last_author, "Bob");
  assert.equal(out.what_about, "What it's about");
});

console.log(`\n${passed} checks passed`);
process.exit(0);
