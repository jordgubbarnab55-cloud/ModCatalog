# Conventions

## Comments

Leave a comment only when something is particularly complex or non-obvious.
A comment describes the current code: what it does, and why it must be that
way when the reason is not evident (an invariant, an external constraint).
Never reference decisions, plans, alternatives or past implementations, in
comments, docstrings, error messages, or other user-facing text. Before
writing one, ask whether it makes sense to someone who never saw the previous
version. Rationale for a change belongs in the commit message or your summary
to the user.

Applies equally to files in `docs/` other than `docs/plans/`: they describe
the system as it is now.

## Plans

Plans live in `docs/plans/` (a single-file plan, or a folder of numbered
parts such as `docs/plans/v2-discord-forum-integration/`). A plan may record
goals, decisions and alternatives. Code, comments and other docs do not point
at plans.

## Commits

The commit message carries the reason for a change, including "this replaces
X" and "Y is no longer done". Do not commit unless asked.

## Tests

```
python -m unittest discover -s tests     # repo root; stdlib unittest
cd worker && node --test                 # Worker, site libs, contract fixtures
```

Both run offline. Python tests use `LocalClient`; Worker tests inject fakes
for `fetch`, KV and D1 (`worker/test/helpers/fake-d1.js`). Add or update tests
with every behavior change; the shared fixtures cover the trailer, catalog and
package-shape rules.

## Constraints by area

| Area | Constraint |
|---|---|
| `build.py`, `trailer.py` | stdlib only; deterministic output |
| `worker/` | zero runtime dependencies; no GitHub calls on `/discord`; no parsing in the Worker |
| `site/` | no build step, framework, CDN or external JS; no package bytes at render time |
| `site/catalog.json` | generated; never hand-edited |
| `mod-contract/` | vendored; edit the canonical copy |
| Repo | no package zips or cover images in git; no credentials tracked |

## Generated and synced files

- `site/catalog.json`: `python build.py process|rebuild|retitle`.
- `site/tags.json`: copied from `mod-contract/tags.json` at deploy time
  (gitignored; the tags UI hides when it is missing, for example in a local
  preview).
- The inline icon sprite in `site/index.html`: `python scripts/sync-icons.py`
  after changing any `site/icons/*.svg`; commit both.
