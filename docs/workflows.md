# Workflows

All workflows live in `.github/workflows/`, declare explicit `permissions`
and share `concurrency: {group: catalog, cancel-in-progress: false}`, so
catalog merges and deploys never race.

## `process-inbox.yml`

- Trigger: `workflow_dispatch` only. The Worker dispatches it after a
  manifest or zip-mode upload; the payload carries nothing, and every run
  drains the whole inbox.
- `permissions: contents: write, pages: write, id-token: write`.
- Steps:
  1. checkout, setup-python 3.12;
  2. `python build.py process --from-inbox --results-file inbox-results.json`
     with `GH_TOKEN: ${{ github.token }}` and `ADMIN_DISCORD_IDS` from the
     repository variable;
  3. the `commit-and-deploy` composite action;
  4. after the deploy, `python build.py announce --results
     inbox-results.json` with `if: always()` and `continue-on-error: true`.
     It reads the secret `DISCORD_BOT_TOKEN` and the repository variables
     `FORUM_CHANNEL_ID`, `NOTICES_CHANNEL_ID`, `FORUM_TAG_IDS` and
     `SITE_URL` (`docs/build-pipeline.md`). Missing settings or a missing
     results file are no-ops.

## `rebuild.yml`

`workflow_dispatch`. Runs `python build.py rebuild`, then
`commit-and-deploy`.

## `seed-legacy.yml`

A one-off `workflow_dispatch` with required inputs `uid` and `username` (a
Discord account). Runs `python build.py process --from-dir legacy-assets
--as-uid … --as-username …`, which seeds the packages as that account, then
`commit-and-deploy`.

## `deploy-site.yml`

Triggers on a push to `main` touching `site/**` or `mod-contract/tags.json`.
Checkout, setup-python, then the `deploy-site` action. Bot pushes made with
`GITHUB_TOKEN` do not trigger it, so there are no loops.

## `refresh-downloads.yml`

Hourly (`cron: "17 * * * *"`) plus `workflow_dispatch`: checkout,
setup-python, then the `deploy-site` action, which regenerates
`downloads.json`.

Scheduled workflows on public repositories are disabled after 60 days without
repository activity; any upload or deploy refreshes the counts too.

## `.github/actions/commit-and-deploy`

- Commits the given path (`site/catalog.json`) **only if changed**, using a
  scoped `git status --porcelain` and `git add`. The scope matters: the
  runner leaves `__pycache__/` behind.
- A no-change run checks `site/` out of the latest `origin/main` instead, so
  it never deploys a checkout older than a commit a concurrent run pushed.
- Then runs the `deploy-site` action. The deploy happens in the same run
  because a commit pushed with `GITHUB_TOKEN` does not trigger other
  workflows.

## `.github/actions/deploy-site`

The only deploy path. Needs a checkout, Python and `GH_TOKEN`.

1. Copies `mod-contract/tags.json` to `site/tags.json`.
2. `python build.py retitle`: the deployed `catalog.json` carries
   `site/config.json`'s title and description (not committed).
3. `python build.py downloads`: fresh `site/downloads.json`. A failure is a
   warning, never a blocked deploy; the page then hides the counts.
4. `actions/upload-pages-artifact@v4` (path `site`) and
   `actions/deploy-pages@v4`.

The inline icon sprite in `site/index.html` is committed, not generated at
deploy time; `tests/test_site_icons.py` fails when it is stale.

## Pages

Source is **GitHub Actions**, not a branch. Custom-Actions deploys are not
subject to the 10-builds-per-hour limit of branch deploys.
