# Workflows

All workflows live in `.github/workflows/` and declare explicit
`permissions`.

## `process-inbox.yml`

- Trigger: `workflow_dispatch` only. The Worker dispatches it; the payload
  carries nothing.
- `permissions: contents: write, pages: write, id-token: write`;
  `concurrency: {group: catalog, cancel-in-progress: false}`.
- Steps:
  1. checkout, setup-python 3.12;
  2. `python build.py process --from-inbox --results-file inbox-results.json`
     with `GH_TOKEN: ${{ github.token }}`;
  3. the shared `commit-and-deploy` composite action;
  4. after the Pages deploy (the site is live before the ping), a notify step
     with `if: always()` and `continue-on-error: true`:
     `python build.py notify --results inbox-results.json`, with
     `CATALOG_CALLBACK_URL` and `CATALOG_CALLBACK_SECRET` from repository
     secrets. Missing secrets or a missing results file are no-ops, so notify
     never fails the run.

## `rebuild.yml`

`workflow_dispatch` with an optional input `full` (exhaustive audit; the
default is the selective scan). Runs `python build.py rebuild`, commits and
deploys. Same concurrency group.

## `seed-legacy.yml`

A one-off `workflow_dispatch` with required inputs `uid` and `username` (a
Discord account). Runs `python build.py process --from-dir legacy-assets
--as-uid … --as-username …`, which seeds the example mods as that account,
then commits and deploys.

## `deploy-site.yml`

Triggers on push to `site/**` (a human editing `index.html` or `config.json`).
Runs `python build.py retitle` so the deployed `catalog.json` carries the
config's title at once (nothing is committed), then uploads `site/` as the
Pages artifact and deploys. Bot pushes made with `GITHUB_TOKEN` do not trigger
it, so there are no loops. The deploy copies `mod-contract/tags.json` to
`site/tags.json`.

## `.github/actions/commit-and-deploy/action.yml`

- Commits `site/catalog.json` **only if changed**, using a scoped
  `git status --porcelain` and `git add` on that path. The scope matters: the
  runner leaves `__pycache__/` behind, so a whole-tree check would always
  report changes.
- Pushes, then runs `actions/upload-pages-artifact` (path `site`) and
  `actions/deploy-pages`.
- The Pages deploy happens in the same run as the commit, because a commit
  pushed with `GITHUB_TOKEN` does not trigger other workflows.
- A no-change run first syncs `site/` to the latest `origin/main`, so it never
  deploys a checkout older than a commit a concurrent run just pushed.

## Pages

Source is **GitHub Actions**, not a branch. Custom-Actions deploys are not
subject to the 10-builds-per-hour limit of branch deploys.
