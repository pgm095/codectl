"use strict";

// Retrieval primitives used by codectl: SQLite access and personalized PageRank.
//
// No dependencies: SQLite is driven through the python3 standard library.
// The graph is parameterized with `edgeMeta(type) -> {weight, directed}` so the
// caller decides edge semantics (codectl fixes them in code).

const { spawnSync } = require("child_process");

const RRF_K = 60;

const DEFAULT_EDGE_META = () => ({ weight: 1, directed: true });

// --- sqlite via python3 -------------------------------------------------------

function sqlitePythonResult(payload, script) {
  const result = spawnSync("python3", ["-c", script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "python sqlite failed").trim();
    throw new Error(`sqlite fallo: ${detail}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function sqliteSelect(dbPath, sql, params = [], options = {}) {
  return sqlitePythonResult(
    { dbPath, sql, params, readonly: Boolean(options.readonly) },
    `
import json, sqlite3, sys
payload = json.load(sys.stdin)
db_path = payload["dbPath"]
readonly = bool(payload.get("readonly"))
uri = f"file:{db_path}?mode=ro" if readonly else db_path
conn = sqlite3.connect(uri, uri=readonly)
conn.row_factory = sqlite3.Row
rows = conn.execute(payload["sql"], payload.get("params") or []).fetchall()
print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
conn.close()
`
  );
}

function sqliteExecute(dbPath, sql, params = []) {
  return sqlitePythonResult(
    { dbPath, sql, params },
    `
import json, sqlite3, sys
payload = json.load(sys.stdin)
conn = sqlite3.connect(payload["dbPath"])
conn.execute(payload["sql"], payload.get("params") or [])
conn.commit()
conn.close()
print("null")
`
  );
}

// --- ranking fusion -------------------------------------------------------

// Reciprocal Rank Fusion. `rankings` is a list of arrays (or {items, weight}).
// Each item is a string key or an object with `.path`.
function rrfScores(rankings, k = RRF_K) {
  const scores = new Map();
  for (const source of rankings) {
    const ranking = Array.isArray(source) ? source : source.items;
    const weight = Array.isArray(source) ? 1 : Number(source.weight) || 1;
    const seen = new Set();
    let rank = 0;
    for (const item of ranking || []) {
      const key = typeof item === "string" ? item : item && item.path;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rank += 1;
      scores.set(key, (scores.get(key) || 0) + (weight / (k + rank)));
    }
  }
  return scores;
}

function normalizeScoreMap(scoreMap) {
  const entries = [...scoreMap.entries()].filter(([, v]) => Number.isFinite(v) && v > 0);
  if (!entries.length) return new Map();
  const max = Math.max(...entries.map(([, v]) => v));
  if (!max) return new Map();
  return new Map(entries.map(([key, v]) => [key, v / max]));
}

function normalizeRankedScoreMap(scoreMap) {
  return new Map(
    [...scoreMap.entries()]
      .filter(([, v]) => Number.isFinite(v) && v > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key], index) => [key, 1 / (index + 1)])
  );
}

// --- grafo --------------------------------------------------------------------

function addAdjacencyEdge(adjacency, from, to, weight) {
  if (!from || !to) return;
  if (!adjacency.has(from)) adjacency.set(from, []);
  adjacency.get(from).push({ to, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 });
}

function buildAdjacency(edges, edgeMeta = DEFAULT_EDGE_META) {
  const adjacency = new Map();
  const nodes = new Set();
  for (const edge of edges) {
    const src = String(edge.src || "");
    const dst = String(edge.dst || "");
    if (!src || !dst) continue;
    const meta = edgeMeta(edge.type) || {};
    // The explicit edge weight wins; the config one is the fallback.
    const weight = Number(edge.weight) || (Number.isFinite(meta.weight) ? meta.weight : 1);
    nodes.add(src);
    nodes.add(dst);
    addAdjacencyEdge(adjacency, src, dst, weight);
    if (meta.directed === false) addAdjacencyEdge(adjacency, dst, src, weight);
  }
  return { adjacency, nodes };
}

// Personalized PageRank: the teleport vector is `seedScores`, so the ranking
// measures closeness to the seeds, not global centrality.
function personalizedPageRank(edges, seedScores, edgeMeta = DEFAULT_EDGE_META, options = {}) {
  const damping = Number.isFinite(options.damping) ? options.damping : 0.85;
  const maxIterations = Number.isFinite(options.maxIterations) ? options.maxIterations : 20;
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : 1e-8;

  const { adjacency, nodes } = buildAdjacency(edges, edgeMeta);
  for (const seed of seedScores.keys()) nodes.add(seed);
  const seedTotal = [...seedScores.values()].reduce((sum, v) => sum + v, 0);
  if (!seedTotal || !nodes.size) return new Map();

  const personalization = new Map();
  for (const [seed, score] of seedScores.entries()) personalization.set(seed, score / seedTotal);

  let ranks = new Map([...nodes].map((n) => [n, personalization.get(n) || 0]));
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const next = new Map([...nodes].map((n) => [n, (1 - damping) * (personalization.get(n) || 0)]));
    let dangling = 0;
    for (const node of nodes) {
      const value = ranks.get(node) || 0;
      if (!value) continue;
      const outgoing = adjacency.get(node) || [];
      if (!outgoing.length) {
        dangling += value;
        continue;
      }
      const totalWeight = outgoing.reduce((sum, e) => sum + e.weight, 0) || 1;
      for (const edge of outgoing) {
        next.set(edge.to, (next.get(edge.to) || 0) + damping * value * (edge.weight / totalWeight));
      }
    }
    // The mass of nodes with no outgoing edges is redistributed according to the
    // personalization, not uniformly: otherwise the ranking drifts away from the seeds.
    if (dangling) {
      for (const [node, probability] of personalization.entries()) {
        next.set(node, (next.get(node) || 0) + damping * dangling * probability);
      }
    }
    let delta = 0;
    for (const node of nodes) delta += Math.abs((next.get(node) || 0) - (ranks.get(node) || 0));
    ranks = next;
    if (delta < tolerance) break;
  }
  return ranks;
}

module.exports = {
  RRF_K,
  sqlitePythonResult,
  sqliteSelect,
  sqliteExecute,
  rrfScores,
  normalizeScoreMap,
  normalizeRankedScoreMap,
  buildAdjacency,
  addAdjacencyEdge,
  personalizedPageRank,
};
