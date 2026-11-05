#!/usr/bin/env python3
"""Tree-sitter based extractor of symbols and references.

Reads a repo (or a list of files from stdin), parses each file with its
grammar and emits JSON on stdout:

    {"repo": str, "files": [...], "symbols": [...], "refs": [...]}

References are emitted UNRESOLVED (only the invoked name). The name -> symbol
resolution is done by codectl.js with a join against `symbols`, so that
reindexing one file does not force rebuilding the whole graph.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from bisect import bisect_left
from pathlib import Path

from tree_sitter import Query, QueryCursor
from tree_sitter_language_pack import get_language, get_parser

QUERIES_DIR = Path(__file__).resolve().parent.parent / "queries"

# Extension -> grammar name en tree_sitter_language_pack.
LANG_BY_EXT = {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".pyi": "python",
    ".rs": "rust",
}

# tsx shares its grammar with typescript except for JSX, which does not affect these queries.
QUERY_FALLBACK = {"tsx": "typescript"}

# Directories that never contribute their own symbols. git ls-files already filters
# most of them, but the walk fallback needs them and some repos version vendor/.
SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
    ".next", "out", "coverage", "vendor", ".cache", "target", ".mypy_cache",
    ".pytest_cache", "site-packages",
}

# A file larger than this is almost always generated code or a bundle.
MAX_FILE_BYTES = 1_500_000


def sha1(*parts: str) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(p.encode("utf-8", "replace"))
        h.update(b"\x00")
    return h.hexdigest()[:16]


def load_query(lang: str) -> Query:
    name = QUERY_FALLBACK.get(lang, lang)
    path = QUERIES_DIR / f"{name}.scm"
    if not path.exists():
        raise FileNotFoundError(f"no query for {lang} ({path})")
    return Query(get_language(lang), path.read_text(encoding="utf-8"))


def discover(repo: Path) -> list[Path]:
    """Indexable files. Uses git ls-files to respect .gitignore."""
    files: list[Path] = []
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "ls-files", "-z", "--cached", "--others",
             "--exclude-standard"],
            capture_output=True, check=True, timeout=60,
        ).stdout
        candidates = [repo / p.decode() for p in out.split(b"\x00") if p]
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            FileNotFoundError):
        candidates = []
        for root, dirs, names in os.walk(repo):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            candidates.extend(Path(root) / n for n in names)

    for p in candidates:
        if p.suffix not in LANG_BY_EXT:
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        try:
            if not p.is_file() or p.stat().st_size > MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        files.append(p)
    return files


def enclosing_symbol(defs: list[dict], byte: int) -> str | None:
    """Tightest symbol containing `byte`. defs is sorted by ascending span."""
    best = None
    for d in defs:
        if d["start_byte"] <= byte < d["end_byte"]:
            if best is None or d["_span"] < best["_span"]:
                best = d
    return best["id"] if best else None


def node_text(src: bytes, node) -> str:
    return src[node.start_byte:node.end_byte].decode("utf-8", "replace")


def signature_of(src: bytes, node) -> str:
    """First line of the definition, truncated."""
    line = node_text(src, node).split("\n", 1)[0].strip()
    return line[:200]


def refine_kind(kind: str, node, lang: str) -> str:
    """The Python grammar does not tell a method from a function; the ancestor does."""
    if lang == "python" and kind == "function":
        parent = node.parent
        while parent is not None:
            if parent.type == "class_definition":
                return "method"
            if parent.type == "function_definition":
                break
            parent = parent.parent
    return kind


def parse_file(repo: Path, path: Path, lang: str, query: Query) -> tuple[dict, list, list]:
    raw = path.read_bytes()
    rel = str(path.relative_to(repo))
    file_id = sha1(str(repo), rel)
    tree = get_parser(lang).parse(raw)
    caps = QueryCursor(query).captures(tree.root_node)

    # @name nodes come in their own capture; they must be paired with the
    # definition/reference that contains them, by position.
    names = sorted(caps.get("name", []), key=lambda n: n.start_byte)
    name_starts = [n.start_byte for n in names]

    def name_inside(node):
        # The first @name inside the node is always its own identifier:
        # in every definition the name precedes the body.
        i = bisect_left(name_starts, node.start_byte)
        if i < len(names) and names[i].end_byte <= node.end_byte:
            return node_text(raw, names[i])
        return None

    defs: list[dict] = []
    raw_refs: list[dict] = []

    for cap, nodes in caps.items():
        if cap == "name":
            continue
        head, _, kind = cap.partition(".")
        for node in nodes:
            name = name_inside(node)
            if not name:
                continue
            if head == "definition":
                defs.append({
                    "id": sha1(str(repo), rel, name, str(node.start_point[0])),
                    "file_id": file_id,
                    "name": name,
                    "kind": refine_kind(kind, node, lang),
                    "start_line": node.start_point[0] + 1,
                    "end_line": node.end_point[0] + 1,
                    "start_byte": node.start_byte,
                    "end_byte": node.end_byte,
                    "_span": node.end_byte - node.start_byte,
                    "signature": signature_of(raw, node),
                    "body": node_text(raw, node),
                })
            else:
                raw_refs.append({
                    "file_id": file_id,
                    "name": name,
                    "type": kind,
                    "line": node.start_point[0] + 1,
                    "start_byte": node.start_byte,
                })

    defs.sort(key=lambda d: d["_span"])
    refs = []
    for r in raw_refs:
        # A reference is attributed to the symbol that encloses it. Module-level
        # ones (loose imports) have no container: src_symbol_id = None.
        r["src_symbol_id"] = enclosing_symbol(defs, r["start_byte"])
        r.pop("start_byte")
        refs.append(r)

    for d in defs:
        d.pop("_span")

    file_row = {
        "id": file_id,
        "path": rel,
        "lang": lang,
        "mtime": path.stat().st_mtime,
        "sha": hashlib.sha1(raw).hexdigest(),
    }
    return file_row, defs, refs


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract symbols and refs with tree-sitter")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--files", help="'-' to read relative paths from stdin")
    ap.add_argument("--list", action="store_true",
                    help="only list indexable files with their mtime, without parsing")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    if not repo.is_dir():
        print(json.dumps({"error": f"repo does not exist: {repo}"}), file=sys.stderr)
        return 2

    # Single source of truth on which files are indexable: codectl.js queries it
    # instead of reimplementing discover() in JS.
    if args.list:
        json.dump([
            {"path": str(p.relative_to(repo)), "mtime": p.stat().st_mtime}
            for p in discover(repo)
        ], sys.stdout)
        return 0

    if args.files == "-":
        targets = [repo / line.strip() for line in sys.stdin if line.strip()]
    else:
        targets = discover(repo)

    queries: dict[str, Query] = {}
    files, symbols, refs, errors = [], [], [], []

    for path in targets:
        lang = LANG_BY_EXT.get(path.suffix)
        if not lang:
            continue
        try:
            if lang not in queries:
                queries[lang] = load_query(lang)
            f, d, r = parse_file(repo, path, lang, queries[lang])
        except Exception as exc:  # a broken file must not take down indexing
            errors.append({"path": str(path), "error": f"{type(exc).__name__}: {exc}"})
            continue
        files.append(f)
        symbols.extend(d)
        refs.extend(r)

    json.dump({
        "repo": str(repo),
        "files": files,
        "symbols": symbols,
        "refs": refs,
        "errors": errors,
    }, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
