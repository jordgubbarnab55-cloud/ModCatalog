# Environment (this machine)

Development happens on a single Windows PC, so hardcoded local paths and
account names in tests and scripts are acceptable.

## Git and GitHub

- Git identity is set **globally** to the GitHub account
  (`jordgubbarnab55-cloud` plus its noreply email).
- HTTPS auth goes through **Git Credential Manager**
  (`git-credential-manager github login`). No tokens in any config.
- `gh` has no `gh auth` set up. It works by borrowing a GCM token:

  ```
  TOKEN=$(printf "protocol=https\nhost=github.com\n" | git-credential-manager get | grep '^password=' | cut -d= -f2); GH_TOKEN="$TOKEN" gh ...
  ```

- Pages source is **GitHub Actions**; deploys come from the workflows
  (`docs/workflows.md`). The catalog URL is
  `https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json`.
- `deploy-live.bat` runs the checks, commits, pushes, deploys the Worker with
  wrangler and waits for the Pages deploy.

## Python

- Windows Python 3.14 reads text as cp1252 by default. Read and write JSON and
  text with `encoding="utf-8"` explicitly. Console output of non-ASCII (em
  dashes) is mangled; files on disk are fine.
- `build.py` and `trailer.py` stay stdlib-only.

## Paths

- The file tool's `/tmp` is not Git Bash's `/tmp`
  (`C:\Users\Admin\AppData\Local\Temp`), and Windows-native Python resolves
  neither. Use workspace-relative or absolute paths. Scratch goes in
  `AGENTS/<Name>/` (`docs/agent-workspace.md`).
- Sibling repo `C:\Users\Admin\Documents\QwenWorkspace` holds ModManager,
  `io-trailer`, `example_server` and the `example_mod/` pair the sample
  packages are built from. It is a separate git repo; do not assume it shares
  a remote with this one. `make_examples.py <pair-dir> [cover-image.jpg]`
  builds sample packages from a real UE pair.

## Runner quirk

`actions/checkout` plus Python leaves `__pycache__/` behind, hence the
`.gitignore` entry and the scoped status check in the commit step.

## Credentials

Local credentials are fine as long as they are untracked (`secrets/`,
`worker/.dev.vars`; see `worker/.dev.vars.example`). The Discord bot token and
app id are read from the environment when `register-commands.mjs` runs.
