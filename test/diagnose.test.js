const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CODECTL = path.resolve(__dirname, "..", "bin", "codectl.js");
const CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
const VENV = path.join(CACHE_HOME, "codectl", "venv");
const SEMGREP = path.join(VENV, "bin", "semgrep");

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codectl-diag-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

function runCodectl(repo, args, cacheDir) {
  return spawnSync(process.execPath, [CODECTL, ...args, "--repo", repo], {
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: cacheDir },
  });
}

function withRepo(files, fn) {
  const repo = makeRepo(files);
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codectl-cache-"));
  try {
    fs.mkdirSync(path.join(cache, "codectl"), { recursive: true });
    fs.symlinkSync(VENV, path.join(cache, "codectl", "venv"));
    fn(repo, cache);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

test("trace resolves Node frames to the symbol that contains them and ignores internal ones", () => {
  const files = {
    "src/svc.ts": [
      "export function boom(x: any) {", //  1
      "  return x.missing.field;", //        2
      "}", //                                3
      "export function caller(x: any) {", // 4
      "  return boom(x);", //                5
      "}", //                                6
    ].join("\n"),
  };
  withRepo(files, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const stack = [
      "TypeError: Cannot read properties of undefined",
      `    at boom (${repo}/src/svc.ts:2:12)`,
      `    at caller (${repo}/src/svc.ts:5:10)`,
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n");
    const stackFile = path.join(repo, "stack.txt");
    fs.writeFileSync(stackFile, stack);

    const out = runCodectl(repo, ["trace", stackFile], cache);
    assert.equal(out.status, 0, out.stderr);
    // The node: frame does not count; the two repo frames do.
    assert.match(out.stdout, /frames \| 2 recognized/);
    assert.match(out.stdout, /src\/svc\.ts:2 \| function boom/);
    assert.match(out.stdout, /src\/svc\.ts:5 \| function caller/);
    assert.doesNotMatch(out.stdout, /task_queues/);
  });
});

test("trace recognizes the Python format", () => {
  withRepo({ "app.py": "def boom(x):\n    return x.missing\n" }, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const stackFile = path.join(repo, "stack.txt");
    fs.writeFileSync(stackFile, `Traceback:\n  File "${repo}/app.py", line 2, in boom\n    return x.missing\n`);
    const out = runCodectl(repo, ["trace", stackFile], cache);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /app\.py:2 \| function boom/);
  });
});

test("holes dead lists unreferenced symbols and omits referenced ones", () => {
  const files = {
    "src/a.ts": "export function used() { return 1; }\nexport function orphan() { return 2; }",
    "src/b.ts": "import { used } from './a';\nexport function run() { return used(); }",
  };
  withRepo(files, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["holes", "--kind", "dead"], cache);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /function orphan/);
    assert.doesNotMatch(out.stdout, /function used/);
  });
});

test("holes untested tells what a spec covers from what it does not", () => {
  const files = {
    "src/a.ts": "export function covered() { return 1; }\nexport function bare() { return 2; }",
    "src/a.spec.ts": "import { covered } from './a';\nit('x', () => { covered(); });",
  };
  withRepo(files, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["holes", "--kind", "untested"], cache);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /function bare/);
    assert.doesNotMatch(out.stdout, /function covered/);
  });
});

test("holes cycles detects a real import cycle, even with the ESM .js extension", () => {
  // `./b.js` points to b.ts: that is how TypeScript emits ESM imports.
  const files = {
    "src/a.ts": "import { fb } from './b.js';\nexport function fa() { return fb(); }",
    "src/b.ts": "import { fa } from './a.js';\nexport function fb() { return fa(); }",
    "src/free.ts": "export function libre() { return 0; }",
  };
  withRepo(files, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["holes", "--kind", "cycles"], cache);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /import cycles \(1\)/);
    assert.match(out.stdout, /src\/(a|b)\.ts -> src\/(b|a)\.ts/);
    assert.doesNotMatch(out.stdout, /free\.ts/);
  });
});

test("holes cycles reports no cycles where there are none", () => {
  const files = {
    "src/a.ts": "import { fb } from './b';\nexport function fa() { return fb(); }",
    "src/b.ts": "export function fb() { return 1; }",
  };
  withRepo(files, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["holes", "--kind", "cycles"], cache);
    assert.match(out.stdout, /import cycles \(0\)/);
  });
});

// semgrep is slow to start; skipped if not installed.
test("scan fires the taint rule only when user data reaches the sink",
  { skip: !fs.existsSync(SEMGREP) && "semgrep not installed" },
  () => {
    const files = {
      "bad.ts": "export async function h(req: any, db: any) {\n" +
        "  const id = req.body.id;\n" +
        "  await db.query(`SELECT * FROM u WHERE id = ${id}`);\n}",
      // Same sink, no user data: must not be reported.
      "safe.ts": "export async function g(db: any) {\n  await db.query(`SELECT 1`);\n}",
      // Parameterized and sanitized: not reported either.
      "clean.ts": "export async function k(req: any, db: any) {\n" +
        "  await db.query('SELECT * FROM u WHERE id = ?', [Number(req.body.id)]);\n}",
    };
    withRepo(files, (repo, cache) => {
      const out = runCodectl(repo, ["scan"], cache);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /ERROR\s+\| bad\.ts:3 \| sql-injection-taint/);
      assert.doesNotMatch(out.stdout, /safe\.ts/);
      assert.doesNotMatch(out.stdout, /clean\.ts/);
    });
  });

test("scan hides INFO by default and shows them with --all",
  { skip: !fs.existsSync(SEMGREP) && "semgrep not installed" },
  () => {
    const files = {
      "loop.ts": "export async function h(db: any) {\n" +
        "  for (const x of [1]) { await db.q(x); }\n}",
    };
    withRepo(files, (repo, cache) => {
      const quiet = runCodectl(repo, ["scan"], cache);
      assert.match(quiet.stdout, /no findings|INFO findings hidden/);
      assert.doesNotMatch(quiet.stdout, /INFO\s+\| loop\.ts/);

      const all = runCodectl(repo, ["scan", "--all"], cache);
      assert.match(all.stdout, /INFO\s+\| loop\.ts:2 \| await-in-loop-sequential/);
    });
  });
