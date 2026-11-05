# codectl

A small CLI that indexes a repository into SQLite (symbols, references, git history) and answers navigation questions from the index: who calls a function, what it calls, what breaks if it changes, and which files matter for a given focus.

It is meant for people and coding agents that need a map of a codebase without reading it file by file. Supported languages: TypeScript, TSX, JavaScript, Python and Rust (tree-sitter based).

## Requirements

- Node.js 18 or newer
- Python 3 with `venv` (used for tree-sitter parsing and SQLite access)
- Optional: `semgrep` for `codectl scan` (see `requirements-scan.txt`)

## Install

```sh
git clone https://github.com/pgm095/codectl && cd codectl
bash bin/bootstrap.sh          # creates ~/.cache/codectl/venv with tree-sitter
node bin/codectl.js index --repo /path/to/any/repo
```

Or with npm: `npm install -g .` and then run `codectl ...`. With `npx`, run `npx --yes github:pgm095/codectl index --repo .` after the bootstrap step.

Indexes are stored in `${XDG_CACHE_HOME:-~/.cache}/codectl/<repo-name>/index.sqlite`, never inside your repo.

## Commands

| Command | Purpose |
| --- | --- |
| `index [--repo PATH] [--force]` | Build or incrementally refresh the index |
| `map --focus <path\|symbol> [--limit N]` | Rank related symbols with personalized PageRank |
| `callers <symbol>` / `calls <symbol>` | Call sites of a symbol / references made by a symbol |
| `blast <symbol> [--depth N]` | Transitive callers (impact radius) |
| `trace <file\|->` | Map a stack trace (or file) to symbols |
| `holes [--kind dead\|untested\|cycles]` | Unreferenced symbols, untested code, import cycles |
| `hotspots [--since DAYS]` | Files ranked by git churn and fan-in |
| `risk [<rev-range>] [--staged]` | Risk summary of a diff |
| `impacted-tests [<rev-range>]` | Tests reachable from a diff |
| `scan [--severity LEVEL]` | Local semgrep rules (`rules/codectl.yaml`) |
| `stats` | Index size |

## Examples

Real output from running codectl on its own source (`node bin/codectl.js index --repo .` first):

```
$ codectl callers resolveRepo
definitions of resolveRepo: 1
  def | bin/codectl.js:51 | function

call sites: 12
  bin/codectl.js:210 | function runIndex
  bin/codectl.js:347 | function runCallers
  bin/codectl.js:377 | function runCalls
  bin/codectl.js:429 | function runBlast
  bin/codectl.js:548 | function runMap
  bin/codectl.js:651 | function runTrace
  bin/codectl.js:724 | function runHotspots
  bin/codectl.js:842 | function runHoles
  bin/codectl.js:948 | function runRisk
  bin/codectl.js:958 | function runImpactedTests
  bin/codectl.js:990 | function runScan
  bin/codectl.js:1060 | function runStats

$ codectl calls runBlast
bin/codectl.js:426 function runBlast -> 30 refs
  L427 | call | positionals
  L428 | call | usage
  L429 | call | resolveRepo
  L429 | call | optValue
  L430 | call | requireDb
  L431 | call | optValue
  L431 | call | Number
  L432 | call | optValue
  L432 | call | Number
  L433 | call | fail
  L433 | call | symbolsNamed

$ codectl blast resolveRepo --depth 2
  d1 | bin/codectl.js:947 | function runRisk
  d1 | bin/codectl.js:208 | function runIndex
  d1 | bin/codectl.js:841 | function runHoles
  d1 | bin/codectl.js:344 | function runCallers
  d1 | bin/codectl.js:426 | function runBlast
  d1 | bin/codectl.js:957 | function runImpactedTests
  d1 | bin/codectl.js:545 | function runMap
  d1 | bin/codectl.js:1059 | function runStats
  d1 | bin/codectl.js:374 | function runCalls
  d1 | bin/codectl.js:648 | function runTrace
  d1 | bin/codectl.js:723 | function runHotspots
  d1 | bin/codectl.js:989 | function runScan

blast radius of resolveRepo: 12 symbols up to depth 2

$ codectl map --focus bin/codectl.js --limit 8
repo map | focus: bin/codectl.js | 46 seeds

0.13036 | lib/retrieval.js:30 | function sqliteSelect
0.11421 | lib/retrieval.js:17 | function sqlitePythonResult
0.00131 | lib/retrieval.js:130 | function personalizedPageRank
0.00111 | lib/retrieval.js:110 | function buildAdjacency
0.00094 | lib/retrieval.js:104 | function addAdjacencyEdge

$ codectl holes --kind dead

## unreferenced (18)
candidates, not a verdict: an export consumed outside the repo or a
handler invoked by the framework also have no internal call sites.

  bin/codectl.js:20 | function EDGE_META | age 0d | confidence low
  bin/codectl.js:208 | function runIndex | age 0d | confidence low
  bin/codectl.js:344 | function runCallers | age 0d | confidence low
  bin/codectl.js:374 | function runCalls | age 0d | confidence low
  bin/codectl.js:426 | function runBlast | age 0d | confidence low
  bin/codectl.js:545 | function runMap | age 0d | confidence low
  bin/codectl.js:648 | function runTrace | age 0d | confidence low
  bin/codectl.js:723 | function runHotspots | age 0d | confidence low
  bin/codectl.js:841 | function runHoles | age 0d | confidence low

$ codectl hotspots --limit 3
hotspots | path | commits | churn | symbols | bus factor | score
bin/codectl.js | 1 | 1130 | 46 | 1 | 51980
lib/extract.py | 1 | 270 | 10 | 1 | 2700
lib/retrieval.js | 1 | 186 | 10 | 1 | 1860
```

## Tests

```sh
bash bin/bootstrap.sh
npm test
```

## Results

In an internal pilot with a coding agent (Codex), the same repair task on a production codebase was run under three setups. The baseline setup used a repo instruction file, summarized quality-gate output and a context compaction limit. Adding codectl (with the repo indexed in the agent's worktree) lowered input token consumption from 12.4 M to 9.6 M tokens, a 23 % reduction, with fewer model calls (178 to 153). The comparison is a single run per setup on one task, so treat it as an indication and not as a benchmark.

## License

MIT, see `LICENSE`.
