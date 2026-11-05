const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const CODECTL = path.resolve(__dirname, "..", "bin", "codectl.js");
const EXTRACT = path.resolve(__dirname, "..", "lib", "extract.py");
const VENV_PY = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codectl", "venv", "bin", "python");
function extract(repo) { const out = spawnSync(VENV_PY, [EXTRACT, "--repo", repo], { encoding: "utf8" }); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout); }
function runCodectl(repo, args, cache) { return spawnSync(process.execPath, [CODECTL, ...args, "--repo", repo], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cache } }); }
test("extractor indexa Rust", () => { const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codectl-rust-")); try { fs.writeFileSync(path.join(repo, "sample.rs"), "struct Worker; fn log() {} fn run() { log(); }\n"); const report = extract(repo); assert.deepEqual(report.errors, []); assert.ok(report.symbols.some((x) => x.kind === "struct")); assert.ok(report.refs.some((x) => x.name === "log")); } finally { fs.rmSync(repo, { recursive: true, force: true }); } });
test("codectl index/map Rust", () => { const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codectl-rust-map-")); const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codectl-rust-cache-")); try { fs.mkdirSync(path.join(cache, "codectl"), { recursive: true }); fs.symlinkSync(path.dirname(path.dirname(VENV_PY)), path.join(cache, "codectl", "venv")); fs.writeFileSync(path.join(repo, "call.rs"), "fn alpha() { beta(); }\nfn beta() {}\n"); assert.equal(runCodectl(repo, ["index"], cache).status, 0); const mapped = runCodectl(repo, ["map", "--focus", "alpha", "--include-seeds"], cache); assert.equal(mapped.status, 0, mapped.stderr); assert.match(mapped.stdout, /function alpha/); } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); } });
