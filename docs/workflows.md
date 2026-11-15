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
config's title at once (nothing is committed), then a
`python build.py downloads` step (with `GH_TOKEN`, `continue-on-error: true`
— a transient API failure must not block the site deploy), then uploads
`site/` as the Pages artifact and deploys. `permissions` lists `contents: read`
as well (an unlisted permission is `none`). Bot pushes made with
`GITHUB_TOKEN` do not trigger it, so there are no loops. The deploy copies
`mod-contract/tags.json` to `site/tags.json`.

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
- After the sync, next to the `tags.json` copy: `python build.py downloads`
  with `GH_TOKEN: ${{ github.token }}`, `continue-on-error: true` (the
  caller's Python setup is reused; the action itself needs none).

## `refresh-downloads.yml`

The hourly download-count refresh: `schedule: cron "17 * * * *"` (off the
hour) plus `workflow_dispatch`.
`permissions: contents: read, pages: write, id-token: write`;
`concurrency: {group: catalog, cancel-in-progress: false}` (it queues behind
uploads and rebuilds like the other workflows). Steps: checkout, setup-python
3.12, `python build.py retitle` (the committed `catalog.json` can carry an
older title than `config.json`, and the site deploy applies it at deploy
time without committing — a refresh that skipped it would revert the
deployed title), `python build.py downloads` (not `continue-on-error`: a
failure ends the run before the deploy, so the previously deployed counts
stay in place), `cp mod-contract/tags.json site/tags.json`,
`actions/upload-pages-artifact@v4` (path `site`), `actions/deploy-pages@v4`.

## Pages

Source is **GitHub Actions**, not a branch. Custom-Actions deploys are not
subject to the 10-builds-per-hour limit of branch deploys.

## Download counts

Every deploy path publishes a fresh `site/downloads.json`
(`docs/build-pipeline.md`, `downloads`): `commit-and-deploy` and
`deploy-site` run `python build.py downloads` (with `GH_TOKEN`) right next
to the `tags.json` copy, **after** the `git checkout origin/main -- site`
sync in `commit-and-deploy` (that checkout would otherwise clobber anything
generated earlier), marked `continue-on-error: true` — a transient GitHub
API failure must not block deploying a freshly processed upload; a deploy
that ships without counts blanks them until the next successful one. The
hourly `refresh-downloads.yml` (below) runs it **without**
`continue-on-error`: a failed generation ends the run before the deploy, so
a failure leaves the previously deployed counts in place.

Scheduled workflows on public repositories are disabled after 60 days without
repository activity. Uploads (and pushes) keep the repository alive; a long
quiet period would stop the hourly refresh silently — every deploy still
refreshes the counts, so a manual run or any upload recovers them.
