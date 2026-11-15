# AGENTS.md

ModCatalog is a trailer-driven public mod catalog plus upload system on free
tiers: GitHub Releases (storage), Actions (processing), Pages (static site and
`catalog.json`) and one Cloudflare Worker (Discord interactions and streaming
uploads). Two consumers read it: browsers (the web page) and ModManager's
Browse tab (via the manifest). Upload identity comes from Discord-minted
tokens; there are no other accounts.

## Start of every session

1. **Name yourself.** Pick a two-part identifier: an adjective or virtue plus
   an abstract noun, CamelCase, letters only (`VigilantRemainder`,
   `DiligentAxiom`, `SolemnTestament`).
2. **Claim it** with `mkdir AGENTS/<Name>` (no `-p`). If it fails the name is
   taken; pick another. `AGENTS/` is gitignored.
3. Put everything non-shared in `AGENTS/<Name>/`: scratch files, logs, test
   zips, generated packages, notes. Never write scratch to the repo root and
   never touch another agent's folder. Details: `docs/agent-workspace.md`.

## Repo map

```
build.py            catalog pipeline: process / rebuild / retitle / notify (stdlib only)
trailer.py          .utoc trailer read/write/validate (stdlib only)
site/               static page + generated catalog.json (no build step)
worker/             Cloudflare Worker (zero runtime dependencies) + its tests
mod-contract/       vendored shared contract with ModManager (do not edit here)
tests/              Python unittest suite for build.py, trailer.py, the contract
.github/            workflows + the commit-and-deploy composite action
docs/               implementation docs (below); docs/plans/ holds plans
AGENTS/             per-agent working folders (untracked)
```

## Docs

Read the ones your task touches before editing code.

| Doc | Read when |
|---|---|
| `docs/architecture.md` | You need the big picture, limits, or the rules that never bend |
| `docs/identity-and-ownership.md` | Touching identifiers, tags, owners, admins, authors, renames |
| `docs/inbox-pipeline.md` | Touching how uploads become catalog entries |
| `docs/build-pipeline.md` | Editing `build.py`, its CLI, clients, events, or validation |
| `docs/workflows.md` | Editing anything under `.github/` |
| `docs/worker.md` | Editing `worker/` or its Discord/D1/KV behavior |
| `docs/site.md` | Editing the page, cards, filters, icons, or modal motion |
| `docs/upload-flow.md` | Editing the upload modals or what the browser sends |
| `docs/trailer-and-contract.md` | Touching the trailer format, `mod-contract/`, or the JS/Python twins |
| `docs/conventions.md` | Writing code, comments, plans, tests, commit messages |
| `docs/environment.md` | Running tools, git, `gh`, Python, or deploys on this machine |
| `docs/agent-workspace.md` | Naming yourself and placing files |

`worker/README.md` holds the wire-level upload and events contract;
`mod-contract/` holds the contracts shared with ModManager; `SETUP.md` is the
owner's deployment runbook.

## Rules that never bend

- `site/catalog.json` is generated. Never edit it by hand; fix the package.
- `mod-contract/` is a synced copy. Change the canonical one, then sync
  (`docs/trailer-and-contract.md`).
- A mod's identity is its trailer `identifier`; it is locked after first
  upload and compared case-insensitively.
- Never commit package zips or cover images. Releases are the storage.
- The page never fetches package bytes at render time; downloads start only
  on click.
- Python is stdlib only, the Worker has zero runtime dependencies, the site
  has no build step, framework or CDN.
- The Python and JS trailer implementations stay in lockstep with the C#
  reference through the shared fixtures; when they disagree the C# wins.
- Comments describe current code only (`docs/conventions.md`). Rationale for
  a change goes in the commit message or your summary.

## Commands

```
python -m unittest discover -s tests     # repo root
cd worker && node --test                 # Worker, site libs, contract fixtures
python build.py process --client local --root <dir> ...   # offline pipeline run
```

## GitHub authentication

- Always use the classic token in `secrets/github_tokenclassic.txt` for git
  and `gh` operations. The fine-grained `github_pat*.txt` tokens lack the
  `workflow` scope, so pushes touching `.github/` are rejected.
- Never let git open an interactive login prompt for the owner. Do not use
  `git -c credential.helper=...` (Git Credential Manager still shows its
  dialog). Instead pass the token in a one-off URL so git never consults
  any credential helper, with `GIT_TERMINAL_PROMPT=0` as a backstop
  (never print the token):
  ```
  GIT_TERMINAL_PROMPT=0 git push \
    "https://x-access-token:$(cat secrets/github_tokenclassic.txt)@github.com/jordgubbarnab55-cloud/ModCatalog.git" main
  ```
  (the URL is used for the one invocation only; it is never stored)
- For `gh`, use `GH_TOKEN="$(cat secrets/github_tokenclassic.txt)"` instead
  of `gh auth login`.
