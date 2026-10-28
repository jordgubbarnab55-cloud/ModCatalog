# HANDOFF.md

For the project owner, after the `migration` branch is reviewed.
Everything that needs a real account is in **`SETUP.md`** (ordered runbook).

## 1. What changed (commits on `migration`)

| Commit | Phase | Summary |
|--------|-------|---------|
| `363548b` | 1 | Storage moved from git (`assets/*.zip`) to **GitHub Releases**; `build.py` refactored into importable functions + a stdlib-only CLI (`process --from-inbox`, `process --from-dir`, `rebuild`; `--client local --root DIR` runs the whole pipeline offline against a directory-backed fake); per-package validation (zip, member names, exactly one `.utoc` + valid trailer, `.ucas`, `.pak`, <100 MB) where a bad package is deleted from the inbox and the run continues; re-homing to `mod-<guid>` with immutable versions and sha256-named covers; first-uploader-owns (+ `ADMIN_DISCORD_IDS` bypass, seeding = admin); catalog entries with stable release-asset URLs + `sha256`/`uploader`/`updated`; `site/` is now the Pages root (published catalog URL unchanged); example zips in `legacy-assets/`; tracked `__pycache__` removed; workflows `process-inbox.yml`, `rebuild.yml`, `seed-legacy.yml`, `deploy-site.yml` + shared `commit-and-deploy` composite action; 15 offline unit tests. |
| `0b8570f` | 2 | Cloudflare Worker (`worker/`, plain JS ES modules, zero runtime deps): `POST /discord` (Ed25519-checked Interactions endpoint; `/token` mints — only the SHA-256 is stored, one active token per user, ephemeral reply; `/token revoke`), `POST /upload` (401/411/413-before-GitHub/400/429/503; streams the body straight to the `inbox` release, then dispatches `process-inbox.yml` as a wake-up; 502 without dispatch on GitHub failure; CORS locked to `ALLOWED_ORIGIN`). `wrangler.toml` with placeholders only, `.dev.vars.example`, `register-commands.mjs`, `smoke-test.sh`, `worker/README.md` (the upload API contract for the ModManager app). 18 offline tests. |
| `de9e1b0` | 3 | `site/upload.html` (static, no deps, same style: token in localStorage, XHR upload with progress, readable error messages, polls `catalog.json` ~3 min after a 202, "not configured" banner while `config.json` is a placeholder) + `site/config.json` + testable `site/upload-lib.js`; "Upload a mod" link in `index.html`. 4 more offline tests (22 node tests total). |
| `0a47285` | 5 | **Raw file uploads + on-page metadata.** `build.py` accepts raw file sets in the inbox (manifest + part-split files: reassemble on the runner, verify per-file sha256, `make_package_zip` — the zip is built HERE, never by the Worker or the client), 7-day TTL sweep for stalled groups, 2 GiB per-asset cap. Worker: raw mode (`X-Upload-Id` + part headers, `.pak/.ucas/.utoc` + `manifest.json`), byte quota (2 GiB/day), CORS extended. `site/trailer.js`: browser/Node twin of `trailer.py` (validate in the C# order + `appendTrailer`); `upload.html` raw mode: auto-detects a missing `.utoc` trailer, shows the metadata form, writes the trailer client-side, part-splits >90 MB files, uploads manifest + parts. 21 more offline tests (58 total: 22 python, 36 node). |

Docs (this commit): `README.md` and `AGENTS.md` rewritten for the new
architecture (inbox/re-home flow, ownership, workflows, Worker, `site/`
layout); `SETUP.md` (owner runbook); this file. The obsolete "do not
widen the path filter" rule is gone; the trailer contract and the
site-design contract are unchanged.

## 2. Verified offline (commands + real results)

- **Baseline (before any change):** `python build.py` reproduced the
  committed `catalog.json` **byte-for-byte**
  (SHA-256 `6fdc5fa3…a5a47b48` before and after).
- **`python -m unittest discover -s tests`** → `Ran 15 tests … OK`.
  Coverage: good package (entry fields, `sha256` match, well-formed
  absolute URLs, cover extraction); corrupt zip / no trailer / two `.utoc` /
  missing `.ucas` / missing `.pak` / path-traversal member — each rejected
  and deleted without blocking a good package in the same run; same
  `guid+version` rejected (original asset kept), new version wins while the
  old asset stays; second uploader rejected, admin accepted, owner kept;
  seed-then-claim; same-run first-uploader-wins; multi-item drain; empty
  inbox no-op; `rebuild` matches the incremental catalog (every field
  except `updated` — see §4) and is byte-deterministic across runs; the
  three **real example zips** from `legacy-assets/` through the whole
  pipeline via `python build.py process --from-dir legacy-assets --client
  local --root <tmp> --catalog <tmp>/site/catalog.json` (3 ok, 0 rejected;
  `rebuild` afterwards: 3 mods, all fields intact).
- **`node --test`** (in `worker/`) → `# tests 36, # pass 36, # fail 0`
  (26 Worker + 5 upload-page-lib + 5 trailer.js). The happy-path test asserts the body
  passed to the GitHub `fetch` is the **same stream object**, the headers
  are right, the dispatch happens afterwards, and 413 fires **before any
  GitHub call**. Raw-mode tests cover the manifest/part naming contract,
  header validation, and the byte quota. **Cross-check (both directions, run
  locally):** a trailer written by `site/trailer.js` (Node) is parsed by
  `trailer.py`, and a trailer written by `trailer.py` is parsed by
  `site/trailer.js` — fields round-trip exactly.
- **Real package through the raw path** (local client, via the CLI
  `process --from-inbox`): the 10 MB `ExampleUEMod` package extracted to
  raw files, `.ucas` split into 3 parts, manifest + parts staged in the
  inbox → reassembled, sha256-verified, zipped, re-homed; the resulting
  zip validates, the trailer is intact, the inbox is drained, and the
  catalog entry is correct (uploader, size, absolute URLs).
- **`node --test`** (in `worker/`, initial phases) → 22/22 (Worker + page lib).
- **`node --check`** on the inline scripts of `site/upload.html` and
  `site/index.html` and on `site/upload-lib.js` → all OK.
  `bash -n worker/scripts/smoke-test.sh` and
  `node --check worker/scripts/register-commands.mjs` → OK.
- **Workflow YAML:** PyYAML is not installed on this machine (no network
  installs allowed), so the four workflow files + the composite action were
  **reviewed by eye**, not machine-parsed. Every `run:` step references
  commands that exist (`gh` preinstalled on `ubuntu-latest`, `GH_TOKEN`
  set; `python build.py …` with the documented CLI).

No tests were skipped or left red. The only tests that could not be
*run* at all are the live ones in §3.

## 3. Not verified (needs live services — the owner's steps in SETUP.md)

- **GitHub side:** the `Seed legacy mods` workflow, the Pages cutover
  (source = GitHub Actions), downloads through the 302 redirect,
  `Rebuild catalog` reproducing the catalog, the `GhClient` paths in
  `build.py` (code-reviewed, but only `LocalClient` is exercised by tests —
  the `gh` subprocess layer itself has not been run).
- **Cloudflare:** `wrangler` login / KV namespace / secrets / deploy; the
  free-plan **CPU limit on the streaming pass-through** (10 ms — a ~90 MB
  upload is the live check, SETUP step 14); the real 413 from Cloudflare
  for >100 MB (the Worker's own pre-check is tested; the platform's own
  rejection is not).
- **Discord:** the signed endpoint handshake when saving the Interactions
  URL, `register-commands.mjs`, `/token` in a real client.
- **Browser:** `upload.html` in Firefox/Chrome/Safari (page logic is
  exercised via `upload-lib.js` tests + `node --check`; actual browser
  behavior — XHR progress, CORS, polling — is unverified). `smoke-test.sh`
  end to end.
- **ModManager:** following the release-URL redirect (open question §5 of
  the plan; the C# workspace is separate and was not touched).
- **Raw file sets end to end:** the `build.py` raw path is fully unit-tested
  (reassembly, sha256 verification, zip building, re-home, TTL sweep) but
  has not been run through a real Worker + GitHub upload; the web page's
  raw-mode flow (trailer detection/writing in a real browser, XHR of the
  manifest + parts) is unverified in browsers; the Worker's raw-mode header
  handling is test-verified but not yet deployed.
- `site/trailer.js` in a real browser (tested under Node; the browser path
  adds `File.arrayBuffer()` + `crypto.subtle`, both standard).

## 4. Defaults chosen (plan §8) and code-vs-plan decisions

**Defaults (as stated in the plan):**
1. Mods over 100 MB → rejected (`413` from the Worker; size check in the
   pipeline too) with a clear message. No chunked uploads / R2.
2. `.ucas` **and** `.pak` are required in every zip, in addition to the
   `.utoc` + trailer.
3. One catalog entry per GUID, pointing at the **most recently uploaded**
   version. Old versions' assets stay in the release.
4. Multiple preview images: **not supported** (trailer v1 holds one cover;
   more would need a schema change in lockstep with the C# reference).
5. ModManager redirect following: **unverified here** — owner checks in
   SETUP step 7; if it fails the fix is app-side (enable redirect
   following).

**Decisions where the code makes a choice the plan left open:**
- `<Safe Name>` = the trailer **title** sanitized to `[A-Za-z0-9._-]`
  (runs of other characters → `-`, e.g. `Example UE Mod` →
  `Example-UE-Mod`); the version string is sanitized the same way.
  `mod-<guid>` asset names are therefore
  `<SafeTitle>-<Version>.zip`.
- The **quota** (10/day/user) is charged only after the GitHub upload
  succeeded; failed or pre-rejected attempts don't count (KV is eventually
  consistent, a slightly late count is fine).
- `rebuild` **inherits `uploader` from the existing catalog** when present
  (re-homed asset names don't carry the uploader id). If the catalog is
  fully lost, rebuilt entries get `uploader: null`; the next uploader then
  claims the GUID (owner `null` means "unclaimed").
- `updated` = *now* when set by `process`; = the **asset creation time**
  when set by `rebuild` (stable → byte-deterministic no-op rebuilds). The
  "rebuild equals incremental" test therefore compares every field except
  `updated`; byte-determinism is asserted across two consecutive rebuilds.
- Both `process` paths (inbox and seed) **create the `inbox` release if
  missing**, so the Worker never 503s after the first workflow run.
- Ownership is checked against the **live** entry map, so the first upload
  of a new GUID within a single run wins over a later same-run one.
- Admin (seeding) uploads **never become the owner**; they keep/leave the
  owner as-is.
- The Discord signature check does **not** verify timestamp freshness
  (Discord does not require it).
- Node tests run via **`node --test`** (auto-discovery); `node --test
  test/` fails on this Windows/Node-22 setup (path resolution), so
  `worker/package.json`'s `test` script is `node --test`.
- `make_examples.py` was left untouched (dev tool; it writes to `assets/`,
  which no longer exists in the repo — it recreates the directory).
- The 8-hex cover name prefix can theoretically collide; dedup downloads
  the existing cover and compares full bytes (a mismatch rejects the
  upload instead of overwriting).

**Raw file upload + on-page metadata (phase 5):**
- Client part size **90 MB** (headroom under the 100 MB cap); 7z-style
  contiguous slices (plain byte chunks; no 7z container dependency).
- Manifest = one small JSON upload per set: per-file `sha256` of the FULL
  reassembled file + `parts`; the workflow verifies both reassembly and
  completeness against it. No per-part hashes (the zip sha256 covers the
  result; a corrupted part fails the file check).
- **TTL 7 days** for stalled raw groups and stray zips (swept by each
  process run, keyed off the newest asset's age).
- Quota switched from 10 uploads/day to **2 GiB of bytes/day** per user
  (charged after a successful GitHub upload; `UPLOAD_DAILY_BYTES` var).
- The built zip is capped at GitHub's **2 GiB per-asset limit**;
  `make_package_zip` orders members `.pak/.ucas/.utoc` first, then
  alphabetical, `ZIP_DEFLATE` level 6 (deterministic; same input bytes →
  same zip → stable `sha256`).
- The web page is the **only** place a trailer is written in this flow
  (ModManager's Development tab is the other, existing, writer); it writes
  only when the `.utoc` has **no valid trailer** (full C#-order
  validation via `site/trailer.js`), with a fresh `crypto.randomUUID()`
  guid and no cover image (trailer v1 allows omitting it). `site/trailer.js`
  is a deliberate twin of `trailer.py`/the C# reference — both directions
  cross-checked (see §2).

## 5. Values the owner must fill in

| File | Placeholder / value |
|------|--------------------|
| `worker/wrangler.toml` | `[[kv_namespaces]] id = "REPLACE_ME_KV_NAMESPACE_ID"` (from `wrangler kv namespace create TOKENS`) |
| `worker/wrangler.toml` `[vars]` | `GITHUB_OWNER` (= `jordgubbarnab55-cloud`), `GITHUB_REPO` (= `ModCatalog`), `ALLOWED_ORIGIN` (= `https://jordgubbarnab55-cloud.github.io`) |
| via `npx wrangler secret put` (not in the repo) | `DISCORD_PUBLIC_KEY` (Discord app public key), `GITHUB_TOKEN` (fine-grained, this repo only, Contents RW + Actions RW) |
| `worker/.dev.vars` (copy of `.dev.vars.example`, gitignored) | same six values for local `wrangler dev` |
| `site/config.json` | `uploadUrl` = the deployed Worker URL (replace `REPLACE_ME_WORKER_URL`) |
| GitHub repo settings (not a file) | Actions variable `ADMIN_DISCORD_IDS` = your Discord user id(s), comma-separated; Pages source = **GitHub Actions**; Actions workflow permissions = read & write |

## 6. Owner steps

**`SETUP.md`** — Parts 1–5, in order (Discord app + token + Cloudflare →
merge + repo settings + `Seed legacy mods` + verify + delete
`legacy-assets/` → Worker deploy + `site/config.json` → Discord
interactions URL + command registration → end-to-end test).

## 7. Known risks

- **100 MB per upload (one part)** — raw file sets may still reach
  GitHub's 2 GiB per-asset limit; larger packages would need multiple
  releases (out of scope).
- **Runner zip time:** deflating a multi-GiB raw set takes minutes of
  runner CPU — fine on free tiers, but very large sets should be expected
  to take a while before they appear in the catalog.
- **`GITHUB_TOKEN` expiry** (fine-grained tokens max out at 1 year) →
  uploads start failing with `502` until a fresh token is put.
- **Free-plan CPU limit (10 ms)** on the streaming pass-through — unverified
  offline; if a ~90 MB upload fails with a CPU-time error, report before
  changing anything.
- **ModManager redirect handling** — unverified here (SETUP step 7).
- **Downtime window** between SETUP steps 5 and 7 (the old branch-based
  Pages build breaks once the merge lands; the site comes back with the
  seed deploy).
- **Content policy:** mods may redistribute third-party game assets; DMCA /
  ToS enforcement against the GitHub account is a bigger risk than
  bandwidth. Read GitHub's acceptable-use terms; nothing here engineers
  around it.
- KV is eventually consistent: the daily quota and the inbox-id cache can
  be briefly stale (acceptable by design).
