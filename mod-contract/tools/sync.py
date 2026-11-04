#!/usr/bin/env python3
"""Copies this mod-contract folder to a vendored copy, or checks that one matches.

The canonical copy lives in the ModManager workspace; ModCatalog vendors it.

    python mod-contract/tools/sync.py ../ModCatalog/mod-contract           # copy
    python mod-contract/tools/sync.py ../ModCatalog/mod-contract --check   # exit 1 on drift
"""

import argparse
import hashlib
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
IGNORED_PARTS = {"__pycache__"}


def tree(root: pathlib.Path) -> dict:
    """Relative path -> sha256 for every contract file under `root`."""
    out = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if p.is_file() and not IGNORED_PARTS.intersection(rel.parts):
            out[rel.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def diff(src: pathlib.Path, dst: pathlib.Path) -> list[str]:
    a, b = tree(src), tree(dst) if dst.is_dir() else {}
    return sorted(
        [f"missing  {k}" for k in a.keys() - b.keys()]
        + [f"extra    {k}" for k in b.keys() - a.keys()]
        + [f"changed  {k}" for k in a.keys() & b.keys() if a[k] != b[k]])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", type=pathlib.Path)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    target = args.target.resolve()
    if target == ROOT:
        print("target is the canonical copy itself", file=sys.stderr)
        return 2

    changes = diff(ROOT, target)
    if args.check:
        for line in changes:
            print(line)
        print("in sync" if not changes else f"{len(changes)} difference(s)")
        return 1 if changes else 0

    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(ROOT, target, ignore=shutil.ignore_patterns(*IGNORED_PARTS))
    print(f"synced {len(tree(ROOT))} files -> {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
