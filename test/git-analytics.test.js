const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CODECTL = path.resolve(__dirname, "..", "bin", "codectl.js");
const VENV = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codectl", "venv");
function cmd(repo, args, cache) { return spawnSync(process.execPath, [CODECTL, ...args, "--repo", repo], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cache } }); }
function git(repo, args, env = {}) { const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...env } }); assert.equal(r.status, 0, r.stderr); }
function write(repo, file, body) { const full = path.join(repo, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, body); }
function commit(repo, n, files, author = "Ada") { for (const [f, b] of Object.entries(files)) write(repo, f, b); git(repo, ["add", "."]); git(repo, ["commit", "-m", `c${n}`], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author}@x.test`, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author}@x.test` }); }
function withRepo(fn) { const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codectl-git-")); const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codectl-cache-")); try { fs.mkdirSync(path.join(cache, "codectl"), { recursive: true }); fs.symlinkSync(VENV, path.join(cache, "codectl", "venv")); git(repo, ["init"]); fn(repo, cache); } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); } }

test("F7 aggregates hotspots, co-change, bus factor, age and incremental index", () => withRepo((repo, cache) => {
  for (let n = 1; n <= 6; n += 1) commit(repo, n, n <= 3 ? { "src/a.ts": `export function old() { return ${n}; }\n`, "src/b.ts": `export function pair() { return ${n}; }\n` } : { "src/a.ts": `export function old() { return ${n}; }\n` }, "Ada");
  commit(repo, 7, { "src/other.ts": "export function other() { return 1; }\n" }, "Bob");
  let out = cmd(repo, ["index"], cache); assert.equal(out.status, 0, out.stderr);
  out = cmd(repo, ["hotspots", "--limit", "2"], cache); assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /src\/a\.ts \| 6/); assert.match(out.stdout, /\| 1 \|/);
  out = cmd(repo, ["holes", "--kind", "dead"], cache); assert.match(out.stdout, /function old.*confidence low/);
  out = cmd(repo, ["map", "--focus", "src/a.ts", "--cochange", "--include-seeds"], cache); assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /co-change/); assert.match(out.stdout, /src\/b\.ts.*function pair/);
  out = cmd(repo, ["index"], cache); assert.match(out.stdout, /no changes/);
}));
