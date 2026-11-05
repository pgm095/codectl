#!/usr/bin/env node
"use strict";

// codectl - code recall: symbol graph, navigation and diagnostics.
// Shared graph/SQLite primitives live in ../lib/retrieval.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const retrieval = require("../lib/retrieval");

const ROOT = path.resolve(__dirname, "..");
const EXTRACT = path.join(ROOT, "lib", "extract.py");
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codectl");
const VENV_PY = path.join(CACHE, "venv", "bin", "python");

// Weight of each edge type in the PPR. A call couples more than an import.
const EDGE_WEIGHTS = { calls: 1, class: 0.8, imports: 0.4, contains: 0.5, cochange: 0.3 };
const EDGE_META = (type) => ({
  weight: Number.isFinite(EDGE_WEIGHTS[type]) ? EDGE_WEIGHTS[type] : 1,
  directed: true,
});

function usage(exitCode = 1) {
  const lines = [
    "usage | codectl index [--repo PATH] [--force]",
    "usage | codectl map --focus <path|symbol> [--repo PATH] [--limit N]",
    "usage | codectl hotspots [--repo PATH] [--limit N] [--since DAYS] [--json]",
    "usage | codectl callers <symbol> [--repo PATH]",
    "usage | codectl calls <symbol> [--repo PATH]",
    "usage | codectl blast <symbol> [--repo PATH] [--depth N]",
    "usage | codectl trace <file|-> [--repo PATH] [--limit N]",
    "usage | codectl holes [--repo PATH] [--kind dead|untested|cycles]",
    "usage | codectl scan [--repo PATH] [--severity ERROR|WARNING|INFO]",
    "usage | codectl risk [<rev-range>] [--staged] [--repo PATH] [--depth N] [--json]",
    "usage | codectl impacted-tests [<rev-range>] [--repo PATH] [--depth N] [--json]",
    "usage | codectl stats [--repo PATH]",
  ];
  for (const line of lines) console.error(line);
  process.exit(exitCode);
}

function fail(message) {
  console.error(`codectl | ${message}`);
  process.exit(1);
}

// --- repo and db ----------------------------------------------------------------

function resolveRepo(explicit) {
  const start = path.resolve(explicit || process.cwd());
  if (!fs.existsSync(start)) fail(`repo does not exist: ${start}`);
  const result = spawnSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return start; // not a git repo: index the directory as is
}

function repoSlug(repo) {
  return path.basename(repo).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function dbPathFor(repo) {
  return path.join(CACHE, repoSlug(repo), "index.sqlite");
}

function requireDb(repo) {
  const dbPath = dbPathFor(repo);
  if (!fs.existsSync(dbPath)) fail(`no index for ${repo}; run: codectl index --repo ${repo}`);
  return dbPath;
}

function requireVenv() {
  if (!fs.existsSync(VENV_PY)) {
    fail(`venv is missing; run: bash ${path.join(ROOT, "bin", "bootstrap.sh")}`);
  }
  return VENV_PY;
}

function runExtract(repo, args = [], input = undefined) {
  const result = spawnSync(requireVenv(), [EXTRACT, "--repo", repo, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) fail(`extract failed: ${(result.stderr || "").trim().slice(0, 400)}`);
  return JSON.parse(result.stdout);
}

// --- schema ------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL DEFAULT '',
  mtime REAL NOT NULL DEFAULT 0,
  sha TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  start_line INTEGER NOT NULL DEFAULT 0,
  end_line INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(id UNINDEXED, name, signature, body);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  src_symbol_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_src ON refs(src_symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_type ON refs(type);
CREATE TABLE IF NOT EXISTS git_commits (
  sha TEXT PRIMARY KEY, ts INTEGER NOT NULL, author TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS git_file_changes (
  sha TEXT NOT NULL, path TEXT NOT NULL, added INTEGER NOT NULL, deleted INTEGER NOT NULL,
  author TEXT NOT NULL, PRIMARY KEY(sha, path)
);
CREATE TABLE IF NOT EXISTS git_file_stats (
  path TEXT PRIMARY KEY, commits INTEGER NOT NULL, lines_added INTEGER NOT NULL,
  lines_deleted INTEGER NOT NULL, authors INTEGER NOT NULL, top_author_share REAL NOT NULL,
  last_commit_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS git_cochange (
  path_a TEXT NOT NULL, path_b TEXT NOT NULL, together INTEGER NOT NULL, jaccard REAL NOT NULL,
  PRIMARY KEY(path_a, path_b)
);
CREATE INDEX IF NOT EXISTS idx_git_changes_path ON git_file_changes(path);
`;

// Writes a batch of files and their symbols/refs. It first deletes the rows of the
// touched files: ON DELETE CASCADE takes symbols and refs with it, and the FTS is
// cleaned separately because virtual tables do not take part in foreign keys.
const WRITE_SCRIPT = `
import json, sqlite3, sys
payload = json.load(sys.stdin)
conn = sqlite3.connect(payload["dbPath"])
conn.execute("PRAGMA journal_mode = WAL")
conn.execute("PRAGMA foreign_keys = ON")
conn.executescript(payload["schema"])

stale = payload.get("stale") or []
if stale:
    marks = ",".join("?" * len(stale))
    ids = [r[0] for r in conn.execute(f"SELECT id FROM files WHERE path IN ({marks})", stale)]
    if ids:
        imarks = ",".join("?" * len(ids))
        sym_ids = [r[0] for r in conn.execute(f"SELECT id FROM symbols WHERE file_id IN ({imarks})", ids)]
        for sid in sym_ids:
            conn.execute("DELETE FROM symbols_fts WHERE id = ?", (sid,))
        conn.execute(f"DELETE FROM files WHERE id IN ({imarks})", ids)

conn.executemany(
    "INSERT OR REPLACE INTO files (id, path, lang, mtime, sha) VALUES (?,?,?,?,?)",
    [(f["id"], f["path"], f["lang"], f["mtime"], f["sha"]) for f in payload["files"]],
)
conn.executemany(
    "INSERT OR REPLACE INTO symbols (id, file_id, name, kind, start_line, end_line, signature)"
    " VALUES (?,?,?,?,?,?,?)",
    [(s["id"], s["file_id"], s["name"], s["kind"], s["start_line"], s["end_line"], s["signature"])
     for s in payload["symbols"]],
)
conn.executemany(
    "INSERT INTO symbols_fts (id, name, signature, body) VALUES (?,?,?,?)",
    [(s["id"], s["name"], s["signature"], s["body"]) for s in payload["symbols"]],
)
conn.executemany(
    "INSERT INTO refs (file_id, src_symbol_id, name, type, line) VALUES (?,?,?,?,?)",
    [(r["file_id"], r["src_symbol_id"], r["name"], r["type"], r["line"]) for r in payload["refs"]],
)

gone = payload.get("gone") or []
if gone:
    marks = ",".join("?" * len(gone))
    ids = [r[0] for r in conn.execute(f"SELECT id FROM files WHERE path IN ({marks})", gone)]
    if ids:
        imarks = ",".join("?" * len(ids))
        for r in conn.execute(f"SELECT id FROM symbols WHERE file_id IN ({imarks})", ids):
            conn.execute("DELETE FROM symbols_fts WHERE id = ?", (r[0],))
        conn.execute(f"DELETE FROM files WHERE id IN ({imarks})", ids)

conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('repo', ?)", (payload["repo"],))
conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('indexed_at', ?)", (payload["now"],))
conn.commit()
conn.close()
print("null")
`;

// --- index --------------------------------------------------------------------

function runIndex(args) {
  const force = args.includes("--force");
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = dbPathFor(repo);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const listed = runExtract(repo, ["--list"]);
  const onDisk = new Map(listed.map((f) => [f.path, f.mtime]));

  let known = new Map();
  if (fs.existsSync(dbPath)) {
    const rows = retrieval.sqliteSelect(dbPath, "SELECT path, mtime FROM files", [], { readonly: true });
    known = new Map(rows.map((r) => [r.path, Number(r.mtime)]));
  }

  const changed = force
    ? [...onDisk.keys()]
    : [...onDisk.entries()].filter(([p, m]) => !known.has(p) || Math.abs(known.get(p) - m) > 1e-6).map(([p]) => p);
  const gone = [...known.keys()].filter((p) => !onDisk.has(p));

  const analytics = updateGitAnalytics(repo, dbPath);
  if (!changed.length && !gone.length) {
    console.log(`no changes | ${repoSlug(repo)} | ${onDisk.size} files${analytics ? ` | git +${analytics}` : ""}`);
    return;
  }

  const extracted = changed.length
    ? runExtract(repo, ["--files", "-"], changed.join("\n"))
    : { files: [], symbols: [], refs: [], errors: [] };

  retrieval.sqlitePythonResult(
    {
      dbPath,
      schema: SCHEMA,
      repo,
      now: new Date().toISOString(),
      files: extracted.files,
      symbols: extracted.symbols,
      refs: extracted.refs,
      stale: changed,
      gone,
    },
    WRITE_SCRIPT
  );

  const errors = extracted.errors || [];
  console.log(
    `indexed | ${repoSlug(repo)} | ${extracted.files.length} files | ` +
      `${extracted.symbols.length} symbols | ${extracted.refs.length} refs` +
      (gone.length ? ` | ${gone.length} removed` : "") +
      (errors.length ? ` | ${errors.length} with errors` : "")
  );
  for (const e of errors.slice(0, 5)) console.error(`  error | ${e.path} | ${e.error}`);
}

// History is stored per commit and file. That lets the next index query only
// last_indexed_commit..HEAD and rebuild deterministic aggregates.
const GIT_ANALYTICS_SCRIPT = `
import json, sqlite3, sys
p = json.load(sys.stdin); c = sqlite3.connect(p["dbPath"]); c.executescript(p["schema"])
for x in p["commits"]:
    c.execute("INSERT OR IGNORE INTO git_commits (sha,ts,author) VALUES (?,?,?)", (x["sha"],x["ts"],x["author"]))
    c.executemany("INSERT OR IGNORE INTO git_file_changes (sha,path,added,deleted,author) VALUES (?,?,?,?,?)", [(x["sha"], f["path"], f["added"], f["deleted"], x["author"]) for f in x["files"]])
c.execute("DELETE FROM git_file_stats")
c.execute("""INSERT INTO git_file_stats
 SELECT path, COUNT(*), SUM(added), SUM(deleted), COUNT(DISTINCT author),
        MAX(n * 1.0 / total), MAX(ts)
 FROM (SELECT fc.path, fc.added, fc.deleted, fc.author, gc.ts,
              COUNT(*) OVER (PARTITION BY fc.path, fc.author) n,
              COUNT(*) OVER (PARTITION BY fc.path) total
       FROM git_file_changes fc JOIN git_commits gc ON gc.sha=fc.sha)
 GROUP BY path""")
c.execute("DELETE FROM git_cochange")
c.execute("""INSERT INTO git_cochange
 SELECT a.path, b.path, COUNT(*), COUNT(*) * 1.0 /
        (SELECT COUNT(DISTINCT sha) FROM git_file_changes z WHERE z.path=a.path OR z.path=b.path)
 FROM git_file_changes a JOIN git_file_changes b ON a.sha=b.sha AND a.path < b.path
 WHERE (SELECT COUNT(*) FROM git_file_changes q WHERE q.sha=a.sha) <= 30
 GROUP BY a.path,b.path""")
c.execute("INSERT OR REPLACE INTO meta (key,value) VALUES ('last_indexed_commit',?)", (p["head"],))
c.commit(); c.close(); print("null")
`;

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function parseGitLog(text) {
  const commits = []; let current = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const marker = line.split("\x1f");
    if (marker.length === 3 && /^[0-9a-f]{40}$/.test(marker[0])) {
      current = { sha: marker[0], ts: Number(marker[1]), author: marker[2], files: [] };
      commits.push(current); continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (current && m) current.files.push({ path: m[3], added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return commits;
}

function updateGitAnalytics(repo, dbPath) {
  const headResult = git(repo, ["rev-parse", "HEAD"]);
  if (headResult.status !== 0) return null;
  const head = headResult.stdout.trim();
  let last = null;
  if (fs.existsSync(dbPath)) {
    const row = retrieval.sqliteSelect(dbPath, "SELECT value FROM meta WHERE key='last_indexed_commit'", [], { readonly: true })[0];
    last = row && row.value;
  }
  if (last === head) return 0;
  const range = last ? `${last}..${head}` : "--all";
  const result = git(repo, ["log", "--reverse", "--format=%H%x1f%ct%x1f%an", "--numstat", range]);
  if (result.status !== 0) return null;
  const commits = parseGitLog(result.stdout);
  retrieval.sqlitePythonResult({ dbPath, schema: SCHEMA, commits, head }, GIT_ANALYTICS_SCRIPT);
  return commits.length;
}

// --- symbol resolution ---------------------------------------------------

// Resolution is by name, not by type: a `get()` can point to many homonymous
// symbols. We return every candidate and let the caller flag the ambiguity
// instead of faking precision.
function symbolsNamed(dbPath, name) {
  return retrieval.sqliteSelect(
    dbPath,
    `SELECT s.id, s.name, s.kind, s.start_line, s.end_line, s.signature, f.path
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.name = ? ORDER BY f.path, s.start_line`,
    [name],
    { readonly: true }
  );
}

function runCallers(args) {
  const name = positionals(args)[0];
  if (!name) usage();
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = requireDb(repo);

  const targets = symbolsNamed(dbPath, name);
  if (!targets.length) fail(`no symbol named ${name}`);

  const rows = retrieval.sqliteSelect(
    dbPath,
    `SELECT f.path, r.line, r.type, s.name AS caller, s.kind AS caller_kind
     FROM refs r
     JOIN files f ON f.id = r.file_id
     LEFT JOIN symbols s ON s.id = r.src_symbol_id
     WHERE r.name = ? AND r.type IN ('call','class')
     ORDER BY f.path, r.line`,
    [name],
    { readonly: true }
  );

  const ambiguous = targets.length > 1;
  console.log(`definitions of ${name}: ${targets.length}${ambiguous ? "  (AMBIGUOUS)" : ""}`);
  for (const t of targets) console.log(`  def | ${t.path}:${t.start_line} | ${t.kind}`);
  console.log(`\ncall sites: ${rows.length}${ambiguous ? "  <- resolved by name; they may point to any of the definitions above" : ""}`);
  for (const r of rows) {
    console.log(`  ${r.path}:${r.line} | ${r.caller ? `${r.caller_kind} ${r.caller}` : "<module>"}`);
  }
}

function runCalls(args) {
  const name = positionals(args)[0];
  if (!name) usage();
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = requireDb(repo);
  const targets = symbolsNamed(dbPath, name);
  if (!targets.length) fail(`no symbol named ${name}`);

  for (const t of targets) {
    const rows = retrieval.sqliteSelect(
      dbPath,
      `SELECT DISTINCT r.name, r.type, r.line FROM refs r
       WHERE r.src_symbol_id = ? ORDER BY r.line`,
      [t.id],
      { readonly: true }
    );
    console.log(`${t.path}:${t.start_line} ${t.kind} ${t.name} -> ${rows.length} refs`);
    for (const r of rows) console.log(`  L${r.line} | ${r.type} | ${r.name}`);
  }
}

// --- blast radius -------------------------------------------------------------

function callersOf(dbPath, names) {
  if (!names.length) return [];
  const marks = names.map(() => "?").join(",");
  return retrieval.sqliteSelect(
    dbPath,
    `SELECT DISTINCT s.name, s.kind, f.path, s.start_line
     FROM refs r
     JOIN symbols s ON s.id = r.src_symbol_id
     JOIN files f ON f.id = s.file_id
     WHERE r.name IN (${marks}) AND r.type IN ('call','class')`,
    names,
    { readonly: true }
  );
}

// How many definitions share each name. A heavily repeated name (`find`, `get`)
// does not identify a symbol: expanding through it floods the result with noise.
function definitionCounts(dbPath, names) {
  if (!names.length) return new Map();
  const marks = names.map(() => "?").join(",");
  const rows = retrieval.sqliteSelect(
    dbPath,
    `SELECT name, COUNT(*) AS n FROM symbols WHERE name IN (${marks}) GROUP BY name`,
    names,
    { readonly: true }
  );
  return new Map(rows.map((r) => [r.name, Number(r.n)]));
}

function runBlast(args) {
  const name = positionals(args)[0];
  if (!name) usage();
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = requireDb(repo);
  const maxDepth = Number(optValue(args, "--depth") || 3);
  const ambiguityLimit = Number(optValue(args, "--max-homonyms") || 8);
  if (!symbolsNamed(dbPath, name).length) fail(`no symbol named ${name}`);

  // Dedupe by symbol (path:line), not by name: `canActivate` exists in many
  // guards and collapsing them would hide real call sites. The frontier, in
  // contrast, advances by name, which is the unit we resolve references with.
  const seenSymbols = new Set();
  const expanded = new Set([name]);
  let frontier = [name];
  let total = 0;

  const blocked = new Map();
  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const rows = callersOf(dbPath, frontier);
    const nextNames = new Set();
    for (const r of rows) {
      const key = `${r.path}:${r.start_line}:${r.name}`;
      if (seenSymbols.has(key)) continue;
      seenSymbols.add(key);
      total += 1;
      console.log(`  d${depth} | ${r.path}:${r.start_line} | ${r.kind} ${r.name}`);
      if (!expanded.has(r.name)) nextNames.add(r.name);
    }
    const counts = definitionCounts(dbPath, [...nextNames]);
    const frontierNames = [];
    for (const n of nextNames) {
      expanded.add(n);
      const homonyms = counts.get(n) || 1;
      if (homonyms > ambiguityLimit) blocked.set(n, homonyms);
      else frontierNames.push(n);
    }
    frontier = frontierNames;
  }

  console.log(`\nblast radius of ${name}: ${total} symbols up to depth ${maxDepth}`);
  if (blocked.size) {
    console.log(
      `\ndid not expand through ${blocked.size} name(s) with more than ${ambiguityLimit} definitions;\n` +
        "name-based resolution cannot tell them apart. Raise --max-homonyms to include them:"
    );
    for (const [n, count] of [...blocked.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n} (${count} definitions)`);
    }
  }
}

// --- repo map (PPR) -----------------------------------------------------------

// Methods of the stdlib and of ubiquitous libraries. `arr.find(...)` is not a call
// to the `find` someone defined in a spec: matching them by name is pure noise. It
// only affects the graph; `callers <name>` still shows everything, because there
// the name was chosen by whoever asks.
const BUILTIN_METHODS = new Set([
  "find", "findIndex", "map", "filter", "forEach", "reduce", "some", "every",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join", "sort",
  "get", "set", "has", "delete", "add", "clear", "keys", "values", "entries",
  "then", "catch", "finally", "resolve", "reject", "all", "race",
  "toString", "valueOf", "trim", "split", "replace", "match", "test", "exec",
  "includes", "indexOf", "startsWith", "endsWith", "padStart", "padEnd",
  "parse", "stringify", "log", "warn", "error", "info", "debug",
  "call", "apply", "bind", "constructor",
]);

const TEST_PATH = /(\.spec\.|\.test\.|__tests__|\/tests?\/)/;

// Symbol graph: one edge per resolved reference. If a name has N definitions,
// the mass is split among them (1/N) so homonyms are not rewarded.
function buildSymbolEdges(dbPath, options = {}) {
  const rows = retrieval.sqliteSelect(
    dbPath,
    `SELECT r.src_symbol_id AS src, s.id AS dst, r.name AS name, r.type AS type,
            f.path AS dst_path, cnt.n AS n, COUNT(*) AS occurrences
     FROM refs r
     JOIN symbols s ON s.name = r.name
     JOIN files f ON f.id = s.file_id
     JOIN (SELECT name, COUNT(*) AS n FROM symbols GROUP BY name) cnt ON cnt.name = r.name
     WHERE r.src_symbol_id IS NOT NULL AND r.type IN ('call','class')
     GROUP BY r.src_symbol_id, s.id, r.name, r.type, f.path, cnt.n`,
    [],
    { readonly: true }
  );
  const edges = [];
  for (const r of rows) {
    if (BUILTIN_METHODS.has(r.name)) continue;
    if (!options.includeTests && TEST_PATH.test(r.dst_path)) continue;
    const type = r.type === "class" ? "class" : "calls";
    edges.push({
      src: r.src,
      dst: r.dst,
      type,
      // Grouping repeated refs avoids materializing the full product of
      // homonyms without dropping names: each occurrence keeps its mass.
      weight: (EDGE_WEIGHTS[type] || 1) * Number(r.occurrences) / Math.max(1, Number(r.n)),
    });
  }
  if (options.cochange) {
    const pairs = retrieval.sqliteSelect(
      dbPath,
      `SELECT c.path_a, c.path_b, c.together,
              (SELECT s.id FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=c.path_a ORDER BY s.start_line LIMIT 1) AS a,
              (SELECT s.id FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=c.path_b ORDER BY s.start_line LIMIT 1) AS b
       FROM git_cochange c WHERE c.together >= 3`, [], { readonly: true }
    );
    for (const p of pairs) {
      if (p.a && p.b) {
        edges.push({ src: p.a, dst: p.b, type: "cochange", weight: EDGE_WEIGHTS.cochange });
        edges.push({ src: p.b, dst: p.a, type: "cochange", weight: EDGE_WEIGHTS.cochange });
      }
    }
  }
  return edges;
}

function runMap(args) {
  const focus = optValue(args, "--focus");
  if (!focus) usage();
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = requireDb(repo);
  const limit = Number(optValue(args, "--limit") || 25);

  // The focus can be a symbol or a path: in the second case it seeds with all
  // the symbols of the file.
  let seeds = symbolsNamed(dbPath, focus);
  if (!seeds.length) {
    // The index stores repository-relative POSIX paths. Accept absolute paths
    // and platform separators at the CLI boundary, while keeping the query
    // exact enough to avoid matching an unrelated suffix.
    const normalizedFocus = focus.replace(/\\/g, "/");
    const absoluteFocus = normalizedFocus.replace(/\\/g, "/");
    const relativeFocus = path.isAbsolute(absoluteFocus)
      ? path.relative(repo, absoluteFocus).replace(/\\/g, "/")
      : normalizedFocus.replace(/^\.\//, "");
    seeds = retrieval.sqliteSelect(
      dbPath,
      `SELECT s.id, s.name, s.kind, s.start_line, f.path FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path = ? OR f.path LIKE ? OR f.path LIKE ?`,
      [relativeFocus, `%/${relativeFocus}`, `${relativeFocus}/%`],
      { readonly: true }
    );
  }
  if (!seeds.length) fail(`focus not found: ${focus}`);

  const seedScores = new Map(seeds.map((s) => [s.id, 1]));
  const edges = buildSymbolEdges(dbPath, { includeTests: args.includes("--include-tests"), cochange: args.includes("--cochange") });
  const ranks = retrieval.personalizedPageRank(edges, seedScores, EDGE_META);

  // Seeds always lead the ranking (they are the teleport vector) and add nothing:
  // the focus is already in view. What is useful is its neighborhood.
  const includeSeeds = args.includes("--include-seeds");
  const top = [...ranks.entries()]
    .filter(([id, v]) => v > 0 && (includeSeeds || !seedScores.has(id)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (!top.length) fail("the graph has no edges from the focus");

  const marks = top.map(() => "?").join(",");
  const info = retrieval.sqliteSelect(
    dbPath,
    `SELECT s.id, s.name, s.kind, s.start_line, s.signature, f.path
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (${marks})`,
    top.map(([id]) => id),
    { readonly: true }
  );
  const byId = new Map(info.map((r) => [r.id, r]));

  console.log(`repo map | focus: ${focus} | ${seeds.length} seeds${args.includes("--cochange") ? " | co-change" : ""}\n`);
  for (const [id, score] of top) {
    const s = byId.get(id);
    if (!s) continue;
    console.log(`${score.toFixed(5)} | ${s.path}:${s.start_line} | ${s.kind} ${s.name}`);
  }
}

// --- trace --------------------------------------------------------------------

// Supported formats: Node/V8 ("at fn (/abs/file.ts:12:5)", "at /abs/file.ts:12:5")
// and Python ('File "/abs/file.py", line 12, in fn').
const FRAME_PATTERNS = [
  /^\s*at\s+(?:.*?\s+\()?(.+?):(\d+):\d+\)?\s*$/,
  /^\s*File\s+"(.+?)",\s+line\s+(\d+)/,
];

function parseFrames(text) {
  const frames = [];
  for (const line of text.split("\n")) {
    for (const pattern of FRAME_PATTERNS) {
      const m = line.match(pattern);
      if (!m) continue;
      const [, file, lineNo] = m;
      // Internal runtime frames do not live in the repo.
      if (/^node:|^internal\/|node_modules/.test(file)) break;
      frames.push({ file, line: Number(lineNo) });
      break;
    }
  }
  return frames;
}

// A stack trace carries absolute paths from the machine where it ran, or compiled
// paths (dist/). Lookup is by path suffix, the only thing stable between build and source.
function symbolAtFrame(dbPath, frame) {
  const rows = retrieval.sqliteSelect(
    dbPath,
    `SELECT s.id, s.name, s.kind, s.start_line, s.end_line, f.path
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE (f.path = ? OR ? LIKE '%' || f.path)
       AND s.start_line <= ? AND s.end_line >= ?
     ORDER BY (s.end_line - s.start_line) ASC
     LIMIT 1`,
    [frame.file, frame.file, frame.line, frame.line],
    { readonly: true }
  );
  return rows[0] || null;
}

function runTrace(args) {
  const source = positionals(args)[0];
  if (!source) usage();
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = requireDb(repo);
  const limit = Number(optValue(args, "--limit") || 15);

  const text = source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8");
  const frames = parseFrames(text);
  if (!frames.length) fail("no frame recognized (formats: Node/V8, Python)");

  const seeds = new Map();
  let resolved = 0;
  console.log(`frames | ${frames.length} recognized\n`);
  for (const frame of frames) {
    const symbol = symbolAtFrame(dbPath, frame);
    if (!symbol) {
      console.log(`  ?  | ${frame.file}:${frame.line} | no symbol in the index`);
      continue;
    }
    resolved += 1;
    // The deepest frame is the one that failed: it weighs more as a seed.
    const weight = 1 / resolved;
    seeds.set(symbol.id, Math.max(seeds.get(symbol.id) || 0, weight));
    console.log(`  ${resolved === 1 ? "*" : " "}  | ${symbol.path}:${frame.line} | ${symbol.kind} ${symbol.name}`);
  }
  if (!seeds.size) fail("no frame resolved to an indexed symbol; reindex the repo");

  const ranks = retrieval.personalizedPageRank(buildSymbolEdges(dbPath), seeds, EDGE_META);
  const top = [...ranks.entries()]
    .filter(([id, v]) => v > 0 && !seeds.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (!top.length) {
    console.log("\nno neighborhood in the graph for these frames");
    return;
  }

  const marks = top.map(() => "?").join(",");
  const info = retrieval.sqliteSelect(
    dbPath,
    `SELECT s.id, s.name, s.kind, s.start_line, f.path FROM symbols s
     JOIN files f ON f.id = s.file_id WHERE s.id IN (${marks})`,
    top.map(([id]) => id),
    { readonly: true }
  );
  const byId = new Map(info.map((r) => [r.id, r]));
  console.log(`\ncontext around the failure (PPR from ${seeds.size} frames):\n`);
  for (const [id, score] of top) {
    const s = byId.get(id);
    if (s) console.log(`${score.toFixed(5)} | ${s.path}:${s.start_line} | ${s.kind} ${s.name}`);
  }
}

// --- holes --------------------------------------------------------------------

// Symbols nobody references. This is not proof of dead code: an export consumed
// by another repo, a handler the framework invokes through a decorator or an
// entry point have no internal call sites. It is a list of candidates to review.
function deadSymbols(dbPath) {
  return retrieval.sqliteSelect(
    dbPath,
    `SELECT s.name, s.kind, s.start_line, f.path, g.last_commit_ts,
            CAST((strftime('%s','now') - COALESCE(g.last_commit_ts, strftime('%s','now'))) / 86400 AS INTEGER) AS age_days
     FROM symbols s JOIN files f ON f.id = s.file_id
     LEFT JOIN git_file_stats g ON g.path=f.path
     WHERE s.kind IN ('function', 'method')
       AND s.name NOT IN ('constructor', 'main', 'default')
       AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.name = s.name)
     ORDER BY age_days DESC, f.path, s.start_line`,
    [],
    { readonly: true }
  );
}

function runHotspots(args) {
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = requireDb(repo);
  const limit = Number(optValue(args, "--limit") || 20);
  const since = Number(optValue(args, "--since") || 0);
  const cutoff = since > 0 ? Math.floor(Date.now() / 1000) - since * 86400 : 0;
  const has = retrieval.sqliteSelect(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name='git_file_stats'", [], { readonly: true }).length;
  if (!has) { console.log("hotspots | no git history"); return; }
  const rows = retrieval.sqliteSelect(
    dbPath,
    `SELECT g.path, g.commits, g.lines_added + g.lines_deleted AS churn, COUNT(s.id) AS symbols,
            CASE WHEN g.top_author_share >= .8 THEN 1 ELSE 0 END AS bus_factor,
            (g.commits * (g.lines_added + g.lines_deleted) * MAX(1, COUNT(s.id))) AS score
     FROM git_file_stats g LEFT JOIN files f ON f.path=g.path LEFT JOIN symbols s ON s.file_id=f.id
     WHERE (? = 0 OR g.last_commit_ts >= ?) GROUP BY g.path
     ORDER BY score DESC, g.path LIMIT ?`, [cutoff, cutoff, limit], { readonly: true }
  );
  if (args.includes("--json")) { console.log(JSON.stringify(rows)); return; }
  if (!rows.length) { console.log("hotspots | no git history"); return; }
  console.log("hotspots | path | commits | churn | symbols | bus factor | score");
  for (const r of rows) console.log(`${r.path} | ${r.commits} | ${r.churn} | ${r.symbols} | ${r.bus_factor} | ${r.score}`);
}

// Symbols that no test file mentions. Attribution is per file, not per symbol:
// inside `describe(() => ...)` calls have no containing symbol.
function untestedSymbols(dbPath) {
  return retrieval.sqliteSelect(
    dbPath,
    `SELECT s.name, s.kind, s.start_line, f.path
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.kind IN ('function', 'method')
       AND s.name NOT IN ('constructor', 'main', 'default')
       AND f.path NOT LIKE '%.spec.%' AND f.path NOT LIKE '%.test.%'
       AND f.path NOT LIKE '%__tests__%' AND f.path NOT LIKE 'test/%'
       AND NOT EXISTS (
         SELECT 1 FROM refs r JOIN files tf ON tf.id = r.file_id
         WHERE r.name = s.name
           AND (tf.path LIKE '%.spec.%' OR tf.path LIKE '%.test.%'
                OR tf.path LIKE '%__tests__%' OR tf.path LIKE 'test/%')
       )
     ORDER BY f.path, s.start_line`,
    [],
    { readonly: true }
  );
}

// Resolves a relative import to an indexed path. Bare specifiers (`zod`) are
// external and are not part of the repo graph.
function resolveImport(specifier, fromPath, knownPaths) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));

  // TypeScript in ESM mode imports `./x.js` to refer to `./x.ts`: the specifier's
  // extension is the build's, not the source's.
  const rewritten = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const bases = rewritten === base ? [base] : [base, rewritten];

  const candidates = [];
  for (const b of bases) {
    candidates.push(b);
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]) candidates.push(`${b}${ext}`);
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) candidates.push(`${b}/index${ext}`);
    candidates.push(`${b}/__init__.py`);
  }
  for (const c of candidates) if (knownPaths.has(c)) return c;
  return null;
}

function importCycles(dbPath) {
  const files = retrieval.sqliteSelect(dbPath, "SELECT id, path FROM files", [], { readonly: true });
  const knownPaths = new Set(files.map((f) => f.path));
  const pathById = new Map(files.map((f) => [f.id, f.path]));

  const rows = retrieval.sqliteSelect(
    dbPath,
    "SELECT file_id, name FROM refs WHERE type = 'import'",
    [],
    { readonly: true }
  );
  const graph = new Map();
  for (const r of rows) {
    const from = pathById.get(r.file_id);
    if (!from) continue;
    const to = resolveImport(r.name, from, knownPaths);
    if (!to || to === from) continue;
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
  }

  // DFS with a recursion stack: when a node on the stack is met again, the stretch
  // from its first appearance to the top is a cycle.
  const cycles = [];
  const state = new Map();
  const stack = [];
  const seenCycles = new Set();

  const visit = (node) => {
    state.set(node, "open");
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (state.get(next) === "open") {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort().join("|");
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(cycle);
        }
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

function runHoles(args) {
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = requireDb(repo);
  const only = optValue(args, "--kind");
  const limit = Number(optValue(args, "--limit") || 20);

  if (!only || only === "dead") {
    const rows = deadSymbols(dbPath);
    console.log(`\n## unreferenced (${rows.length})`);
    console.log("candidates, not a verdict: an export consumed outside the repo or a");
    console.log("handler invoked by the framework also have no internal call sites.\n");
    for (const r of rows.slice(0, limit)) {
      const confidence = r.age_days > 90 ? "high" : r.age_days < 14 ? "low" : "medium";
      console.log(`  ${r.path}:${r.start_line} | ${r.kind} ${r.name} | age ${r.age_days}d | confidence ${confidence}`);
    }
    if (rows.length > limit) console.log(`  ... ${rows.length - limit} more`);
  }

  if (!only || only === "untested") {
    const rows = untestedSymbols(dbPath);
    console.log(`\n## not mentioned in tests (${rows.length})`);
    for (const r of rows.slice(0, limit)) {
      console.log(`  ${r.path}:${r.start_line} | ${r.kind} ${r.name}`);
    }
    if (rows.length > limit) console.log(`  ... ${rows.length - limit} more`);
  }

  if (!only || only === "cycles") {
    const cycles = importCycles(dbPath);
    console.log(`\n## import cycles (${cycles.length})`);
    for (const cycle of cycles.slice(0, limit)) {
      console.log(`  ${cycle.join(" -> ")} -> ${cycle[0]}`);
    }
  }
}

// --- change risk ---------------------------------------------------------

function diffArgs(args) {
  if (args.includes("--staged")) return ["diff", "--cached", "--unified=0"];
  return ["diff", "--unified=0", positionals(args)[0] || "HEAD~1..HEAD"];
}

function changedSymbols(repo, dbPath, args) {
  const result = git(repo, diffArgs(args));
  if (result.status !== 0) fail(`git diff failed: ${(result.stderr || "").trim().slice(0, 200)}`);
  const ranges = new Map(); let current = null;
  for (const line of result.stdout.split("\n")) {
    const file = line.match(/^\+\+\+ b\/(.+)$/);
    if (file) { current = file[1]; continue; }
    if (line === "+++ /dev/null") { current = null; continue; }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (current && hunk) {
      const start = Number(hunk[1]); const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      ranges.set(current, [...(ranges.get(current) || []), { start, end: Math.max(start, start + count - 1) }]);
    }
  }
  const hits = []; const unindexed = [];
  for (const [file, lines] of ranges) {
    const rows = retrieval.sqliteSelect(dbPath,
      `SELECT s.id,s.name,s.kind,s.start_line,s.end_line,f.path FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=?`,
      [file], { readonly: true });
    if (!rows.length) { unindexed.push(file); continue; }
    for (const symbol of rows) if (lines.some((r) => symbol.start_line <= r.end && symbol.end_line >= r.start)) hits.push(symbol);
  }
  return { symbols: [...new Map(hits.map((s) => [s.id, s])).values()], unindexed };
}

function blastRows(dbPath, name, maxDepth) {
  const seen = new Set(); const expanded = new Set([name]); let frontier = [name];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const next = new Set();
    for (const row of callersOf(dbPath, frontier)) { const key = `${row.path}:${row.start_line}:${row.name}`; seen.add(key); if (!expanded.has(row.name)) next.add(row.name); }
    const counts = definitionCounts(dbPath, [...next]);
    frontier = [...next].filter((n) => (counts.get(n) || 1) <= 8); for (const n of frontier) expanded.add(n);
  }
  return [...seen].map((key) => ({ name: key.slice(key.lastIndexOf(":") + 1) }));
}

function testsReaching(dbPath, names) {
  if (!names.length) return [];
  const marks = names.map(() => "?").join(",");
  return retrieval.sqliteSelect(dbPath, `SELECT DISTINCT f.path FROM refs r JOIN files f ON f.id=r.file_id
    WHERE r.name IN (${marks}) AND (f.path LIKE '%.spec.%' OR f.path LIKE '%.test.%' OR f.path LIKE '%__tests__%' OR f.path LIKE 'test/%') ORDER BY f.path`, names, { readonly: true });
}

function hotspotMultiplier(dbPath, file) {
  const exists = retrieval.sqliteSelect(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name='git_file_stats'", [], { readonly: true }).length;
  if (!exists) return { value: 1, warning: true };
  const row = retrieval.sqliteSelect(dbPath, "SELECT commits*(lines_added+lines_deleted) AS score FROM git_file_stats WHERE path=?", [file], { readonly: true })[0];
  const max = retrieval.sqliteSelect(dbPath, "SELECT MAX(commits*(lines_added+lines_deleted)) AS score FROM git_file_stats", [], { readonly: true })[0];
  return !row || !max || !Number(max.score) ? { value: 1, warning: false } : { value: 1 + Number(row.score) / Number(max.score), warning: false };
}

function riskData(repo, dbPath, args) {
  const depth = Number(optValue(args, "--depth") || 3); const changed = changedSymbols(repo, dbPath, args);
  const rows = changed.symbols.map((s) => {
    const callers = callersOf(dbPath, [s.name]); const blast = blastRows(dbPath, s.name, depth);
    const untested = testsReaching(dbPath, [s.name, ...blast.map((x) => x.name)]).length === 0; const hotspot = hotspotMultiplier(dbPath, s.path);
    const score = (1 + Math.log2(1 + callers.length)) * (1 + blast.length / 20) * (untested ? 1.5 : 1) * hotspot.value;
    return { symbol: s.name, path: s.path, fanin: callers.length, blast: blast.length, untested, hotspot: Number(hotspot.value.toFixed(2)), score: Number(score.toFixed(2)) };
  });
  const total = rows.reduce((sum, r) => sum + r.score, 0);
  return { rows, unindexed: changed.unindexed, total: Number(total.toFixed(2)), band: total < 5 ? "LOW" : total <= 15 ? "MEDIUM" : "HIGH" };
}

function runRisk(args) {
  const repo = resolveRepo(optValue(args, "--repo")); const dbPath = requireDb(repo); const data = riskData(repo, dbPath, args);
  if (args.includes("--json")) { console.log(JSON.stringify(data)); return; }
  console.log("risk | symbol | file | fan-in | blast | untested | hotspot | score");
  for (const r of data.rows) console.log(`${r.symbol} | ${r.path} | ${r.fanin} | ${r.blast} | ${r.untested ? "yes" : "no"} | ${r.hotspot.toFixed(2)} | ${r.score.toFixed(2)}`);
  console.log(`total | ${data.total.toFixed(2)} | ${data.band}`);
  if (data.unindexed.length) console.log(`not indexed: ${data.unindexed.join(", ")} — run codectl index`);
  for (const r of data.rows) console.log(`dominant factor | ${r.symbol}: ${r.untested ? "no test safety net" : r.fanin ? `fan-in ${r.fanin}` : "no callers"}`);
}

function runImpactedTests(args) {
  const repo = resolveRepo(optValue(args, "--repo")); const dbPath = requireDb(repo); const depth = Number(optValue(args, "--depth") || 3); const changed = changedSymbols(repo, dbPath, args); const found = new Map();
  for (const s of changed.symbols) for (const test of testsReaching(dbPath, [s.name, ...blastRows(dbPath, s.name, depth).map((x) => x.name)])) { if (!found.has(test.path)) found.set(test.path, new Set()); found.get(test.path).add(s.name); }
  const rows = [...found.entries()].map(([path, symbols]) => ({ path, symbols: [...symbols].sort() }));
  if (args.includes("--json")) { console.log(JSON.stringify({ tests: rows, unindexed: changed.unindexed })); return; }
  if (!rows.length) console.log("0 tests reach this diff — the change has no safety net"); else for (const r of rows) console.log(`${r.path} | ${r.symbols.join(", ")}`);
  if (changed.unindexed.length) console.log(`not indexed: ${changed.unindexed.join(", ")} — run codectl index`);
}

// --- scan (semgrep) -----------------------------------------------------------

// A file that exhausts the timeout was not analyzed: that is a false negative, not
// a "no findings". It is stated out loud.
function reportScanErrors(report, timeout) {
  const errors = report.errors || [];
  if (!errors.length) return;
  const timeouts = errors.filter((e) => /timeout/i.test(e.message || e.type || ""));
  if (timeouts.length) {
    console.log(
      `\nWARNING: ${timeouts.length} file(s) hit the ${timeout}s timeout and were NOT` +
        " fully analyzed. Raise --timeout to cover them:"
    );
    for (const e of timeouts.slice(0, 5)) {
      const where = (e.path || (e.message || "").split(" on ").pop() || "").trim();
      console.log(`  ${where.slice(0, 120)}`);
    }
  }
  for (const e of errors.filter((e) => !/timeout/i.test(e.message || e.type || ""))) {
    console.error(`  error | ${(e.message || "").slice(0, 160)}`);
  }
}

function runScan(args) {
  const repo = resolveRepo(optValue(args, "--repo"));
  const semgrep = path.join(CACHE, "venv", "bin", "semgrep");
  if (!fs.existsSync(semgrep)) {
    fail(`semgrep is missing; run: ${path.join(CACHE, "venv", "bin", "pip")} install -r ` +
      path.join(ROOT, "requirements-scan.txt"));
  }
  const rules = path.join(ROOT, "rules");
  const severity = optValue(args, "--severity");

  // --metrics=off and local rules: the scan is offline and deterministic. The
  // registry needs network and uploads telemetry. It respects .gitignore, like
  // `codectl index`. The 5s default per file-rule leaves large files out in taint
  // mode, and a timeout is a silent false negative: it is reported at the end,
  // not swallowed.
  const timeout = optValue(args, "--timeout") || "30";
  const result = spawnSync(
    semgrep,
    ["scan", "--config", rules, "--metrics=off", "--json", "--quiet", "--timeout", timeout, repo],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  if (!result.stdout) fail(`semgrep failed: ${(result.stderr || "").trim().slice(0, 400)}`);

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    fail(`unreadable semgrep output: ${error.message}`);
  }

  const order = { ERROR: 0, WARNING: 1, INFO: 2 };
  const all = (report.results || []).map((r) => ({
    path: path.relative(repo, r.path),
    line: r.start.line,
    rule: r.check_id.split(".").pop(),
    severity: (r.extra && r.extra.severity) || "INFO",
    message: ((r.extra && r.extra.message) || "").trim().split("\n")[0],
  }));

  // INFO findings are background noise (hundreds of await-in-loop in a large repo) and drown out what is actionable.
  const showAll = args.includes("--all");
  const findings = all
    .filter((f) => (severity ? f.severity === severity : showAll || f.severity !== "INFO"))
    .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3) || a.path.localeCompare(b.path));

  const byRule = new Map();
  for (const f of all) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);

  if (!findings.length) {
    console.log(`scan | ${repoSlug(repo)} | no findings${all.length ? ` (${all.length} hidden, use --all)` : ""}`);
    reportScanErrors(report, timeout);
    return;
  }
  console.log(`scan | ${repoSlug(repo)} | ${findings.length} of ${all.length} findings\n`);
  for (const f of findings) {
    console.log(`${f.severity.padEnd(7)} | ${f.path}:${f.line} | ${f.rule}`);
    console.log(`        ${f.message}`);
  }
  console.log("\nsummary by rule:");
  for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${rule}`);
  }
  if (!showAll && !severity && all.length > findings.length) {
    console.log(`\n${all.length - findings.length} INFO findings hidden; use --all to show them.`);
  }
  reportScanErrors(report, timeout);
}

// --- stats --------------------------------------------------------------------

function runStats(args) {
  const repo = resolveRepo(optValue(args, "--repo"));
  const dbPath = requireDb(repo);
  const one = (sql) => retrieval.sqliteSelect(dbPath, sql, [], { readonly: true })[0];
  const f = one("SELECT COUNT(*) AS n FROM files");
  const s = one("SELECT COUNT(*) AS n FROM symbols");
  const r = one("SELECT COUNT(*) AS n FROM refs");
  const at = one("SELECT value FROM meta WHERE key = 'indexed_at'");
  console.log(`repo      | ${repo}`);
  console.log(`db        | ${dbPath}`);
  console.log(`files     | ${f.n}`);
  console.log(`symbols   | ${s.n}`);
  console.log(`refs      | ${r.n}`);
  console.log(`indexed   | ${at ? at.value : "n/a"}`);
  const kinds = retrieval.sqliteSelect(
    dbPath,
    "SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind ORDER BY n DESC",
    [],
    { readonly: true }
  );
  for (const k of kinds) console.log(`  ${k.kind.padEnd(10)} ${k.n}`);
}

// --- cli ----------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  "--repo", "--focus", "--limit", "--depth", "--max-homonyms", "--kind", "--severity",
  "--timeout", "--since",
]);

function optValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// Flag values are not positionals: in `callers --repo /x foo` the positional is `foo`.
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage(0);
  const table = {
    index: runIndex,
    map: runMap,
    hotspots: runHotspots,
    callers: runCallers,
    calls: runCalls,
    blast: runBlast,
    trace: runTrace,
    holes: runHoles,
    scan: runScan,
    risk: runRisk,
    "impacted-tests": runImpactedTests,
    stats: runStats,
  };
  const handler = table[command];
  if (!handler) usage();
  handler(rest);
}

main();
