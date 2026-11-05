const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CODECTL = path.resolve(__dirname, "..", "bin", "codectl.js");
const VENV_PY = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "codectl", "venv", "bin", "python"
);

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codectl-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

// Each test repo gets its own cache: the db slug comes from the basename.
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
    // The venv lives in XDG_CACHE_HOME/codectl/venv; we link it to the real one.
    fs.mkdirSync(path.join(cache, "codectl"), { recursive: true });
    fs.symlinkSync(path.dirname(path.dirname(VENV_PY)), path.join(cache, "codectl", "venv"));
    fn(repo, cache);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

const SAMPLE = {
  "src/util.ts": `
export function helper(x: string): string { return x.trim(); }
export function unused(): void {}
`,
  "src/main.ts": `
import { helper } from "./util";
export function main(a: string) { return helper(a); }
export function wrapper(a: string) { return main(a); }
`,
  "src/app.py": `
def compute(x):
    return helper_py(x)

def helper_py(x):
    return x + 1

class Repo:
    def find(self, id):
        return compute(id)
`,
};

test("index extracts symbols from typescript and python, and tells a method from a function", () => {
  withRepo(SAMPLE, (repo, cache) => {
    const indexed = runCodectl(repo, ["index"], cache);
    assert.equal(indexed.status, 0, indexed.stderr);
    assert.match(indexed.stdout, /indexed/);

    const stats = runCodectl(repo, ["stats"], cache);
    assert.equal(stats.status, 0, stats.stderr);
    assert.match(stats.stdout, /files\s+\|\s+3/);
    // helper, unused, main, wrapper, compute, helper_py -> 6 functions
    assert.match(stats.stdout, /function\s+6/);
    assert.match(stats.stdout, /class\s+1/);
    // Repo.find is a method, not a function: the ancestor decides, not the grammar.
    assert.match(stats.stdout, /method\s+1/);
  });
});

test("callers finds the call sites and invents none", () => {
  withRepo(SAMPLE, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);

    const out = runCodectl(repo, ["callers", "helper"], cache);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /definitions of helper: 1/);
    assert.match(out.stdout, /call sites: 1/);
    assert.match(out.stdout, /src\/main\.ts:3 \| function main/);

    const none = runCodectl(repo, ["callers", "unused"], cache);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /call sites: 0/);
  });
});

test("callers flags ambiguity when the name has several definitions", () => {
  withRepo(
    {
      "a.ts": "export function dup() {}\nexport function callA() { return dup(); }",
      "b.ts": "export function dup() {}",
    },
    (repo, cache) => {
      assert.equal(runCodectl(repo, ["index"], cache).status, 0);
      const out = runCodectl(repo, ["callers", "dup"], cache);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /definitions of dup: 2\s+\(AMBIGUOUS\)/);
      assert.match(out.stdout, /resolved by name/);
    }
  );
});

test("blast walks the reverse graph and dedupes by symbol, not by name", () => {
  withRepo(SAMPLE, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["blast", "helper", "--depth", "2"], cache);
    assert.equal(out.status, 0, out.stderr);
    // helper <- main <- wrapper
    assert.match(out.stdout, /d1 \|.*function main/);
    assert.match(out.stdout, /d2 \|.*function wrapper/);
    assert.match(out.stdout, /blast radius of helper: 2 symbols/);
  });
});

test("blast does not expand through names with too many homonyms and says so", () => {
  const files = { "caller.ts": "export function seed() { return noisy(); }\n" };
  // `noisy` with 3 definitions and a limit of 2 must stop the expansion.
  for (const n of [1, 2, 3]) files[`m${n}.ts`] = `export function noisy() { return seed(); }\n`;
  withRepo(files, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["blast", "seed", "--depth", "3", "--max-homonyms", "2"], cache);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /did not expand through 1 name/);
    assert.match(out.stdout, /noisy \(3 definitions\)/);
  });
});

test("map ranks the focus neighborhood and excludes the seeds", () => {
  withRepo(SAMPLE, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["map", "--focus", "src/main.ts"], cache);
    assert.equal(out.status, 0, out.stderr);
    // helper lives outside the focus: it must appear. main/wrapper are seeds: they must not.
    assert.match(out.stdout, /src\/util\.ts:2 \| function helper/);
    assert.doesNotMatch(out.stdout, /function wrapper/);
  });
});

test("map accepts a focus with an absolute repository path", () => {
  withRepo(SAMPLE, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["map", "--focus", path.join(repo, "src", "main.ts")], cache);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /src\/util\.ts:2 \| function helper/);
  });
});

test("map ignores builtin methods so arr.find is not matched with a local find", () => {
  withRepo(
    {
      // `sanitize` gives a real edge, so the map produces output and the test
      // has to actually discriminate instead of passing on an empty result.
      "svc.ts": "export function load(rows: string[]) { return rows.find((r) => sanitize(r)); }",
      "helpers.ts": "export function sanitize(r: string) { return r.trim(); }",
      "other.ts": "export function find() { return 1; }",
    },
    (repo, cache) => {
      assert.equal(runCodectl(repo, ["index"], cache).status, 0);
      const out = runCodectl(repo, ["map", "--focus", "svc.ts"], cache);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /helpers\.ts.*function sanitize/);
      assert.doesNotMatch(out.stdout, /other\.ts.*function find/);
    }
  );
});

test("map keeps contribution with more than 20 homonyms and repeated refs", () => {
  const files = {
    "caller.ts": "export function seed() { return noisy() + noisy() + noisy(); }\n",
  };
  for (let n = 1; n <= 21; n++) {
    files[`m${n}.ts`] = `export function noisy() { return ${n}; }\n`;
  }
  withRepo(files, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    const out = runCodectl(repo, ["map", "--focus", "seed", "--limit", "25"], cache);
    assert.equal(out.status, 0, out.stderr);
    const noisyRows = out.stdout.split("\n").filter((line) => /\| function noisy$/.test(line));
    assert.equal(noisyRows.length, 21);
    assert.ok(noisyRows.every((line) => Number(line.split(" | ")[0]) > 0), out.stdout);
  });
});

test("index is incremental: with no changes it does not rewrite, and it detects deleted files", () => {
  withRepo(SAMPLE, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);

    const again = runCodectl(repo, ["index"], cache);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /no changes/);

    fs.rmSync(path.join(repo, "src", "util.ts"));
    const afterDelete = runCodectl(repo, ["index"], cache);
    assert.equal(afterDelete.status, 0, afterDelete.stderr);
    assert.match(afterDelete.stdout, /1 removed/);

    const out = runCodectl(repo, ["callers", "helper"], cache);
    assert.equal(out.status, 1, "helper no longer exists: callers must fail");
  });
});

test("flags with a value are not confused with positionals", () => {
  withRepo(SAMPLE, (repo, cache) => {
    assert.equal(runCodectl(repo, ["index"], cache).status, 0);
    // `callers --repo <path> helper`: the positional is helper, not the path.
    const out = spawnSync(process.execPath, [CODECTL, "callers", "--repo", repo, "helper"], {
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cache },
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /definitions of helper: 1/);
  });
});
