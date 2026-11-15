# Agent workspace

Several agents work in this repo over time. Anything an agent produces that is
not meant to be shared lives in that agent's own folder, so the repo root and
shared directories stay clean.

## Naming

Each agent names itself with a two-part identifier:

- an adjective or virtue, then an abstract noun;
- CamelCase, letters only: no digits, spaces or separators;
- in the manner of Halo monitor names: `VigilantRemainder`, `DiligentAxiom`,
  `SolemnTestament`.

No two agents share a name, now or later. The folder listing of `AGENTS/` is
the registry; a name with a folder is taken.

## Claiming a name

```
mkdir AGENTS/<Name>
```

Run it without `-p`. It fails when the folder exists; choose another name and
retry. `AGENTS/` itself is created by the first agent and is gitignored as a
whole.

## What goes where

| Kind of file | Location |
|---|---|
| Scratch, logs, test zips, token dumps, generated sample packages, experiments, draft notes | `AGENTS/<Name>/` |
| Plans | `docs/plans/` (tracked) |
| Implementation docs | `docs/` (tracked) |
| Source, tests, workflows | their normal places (tracked) |
| Credentials | untracked only: `secrets/`, `worker/.dev.vars` |
| Tool caches | `__pycache__/`, `worker/.wrangler/`, `.local/` (ignored; not agent output) |

Offline pipeline runs (`build.py ... --client local --root <dir>`) point
`--root` and any `--results-file` at a path inside the agent's folder.

## Rules

- Do not modify or delete another agent's folder.
- Do not write scratch files to the repo root, to `site/`, or to `worker/`.
- Credentials are fine locally as long as they are untracked. Never print
  their contents into chat output, docs, commit messages or comments.
- Use your name when reporting back, so the owner can find your folder.
