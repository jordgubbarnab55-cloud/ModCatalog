#!/usr/bin/env python3
"""Generates site/catalog.json from the mod package releases.

Single source of truth: the release assets. A mod is a `.zip` release asset
whose package contains a `.utoc` carrying a valid metadata trailer (see
trailer.py); the catalog entry (name/author/version/description/id/file/
size/sha256/cover/updated) is derived from it. Packages without a valid
trailer are REJECTED — the inbox asset is deleted, the reason is logged,
and the rest of the run continues.

Two storage backends behind one thin interface (PackageClient):

  * GhClient    -- real: shells out to the `gh` CLI (Actions / local with
                  GH_TOKEN). Releases are GitHub release tags, assets are
                  release assets.
  * LocalClient -- fake: a directory tree where releases are folders and
                  assets are files. Used by the unit tests and for offline
                  end-to-end runs.

Usage:
  python build.py process --from-inbox              # drain the "inbox" release
  python build.py process --from-dir legacy-assets  # treat a dir as admin inbox
  python build.py rebuild                           # regenerate from all mod-* releases

  --client local --root DIR selects the directory-backed client.
  --owner / --repo default to GITHUB_OWNER/GITHUB_REPO (or GITHUB_REPOSITORY).

Two upload shapes are accepted in the inbox (both end in a release-asset zip):
  * a ready-made .zip package, or
  * a RAW file set (.utoc/.ucas/.pak, no client-side zipping): each file is
    streamed to the inbox (part-split when over 100 MB) together with a
    small JSON manifest; this pipeline reassembles the parts, verifies the
    per-file sha256 from the manifest, and zips the set HERE on the runner
    (the Worker is a stateless pass-through and cannot do it).
"""

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone

import trailer

ROOT = pathlib.Path(__file__).resolve().parent
SITE = ROOT / "site"
CATALOG_DEFAULT = SITE / "catalog.json"

INBOX_TAG = "inbox"
MOD_TAG_PREFIX = "mod-"
MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # matches the Cloudflare free-plan body limit
MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024  # GitHub release asset cap
STALE_AFTER = 7 * 24 * 3600  # seconds; incomplete/stalled inbox items are swept
MANIFEST_PART = "manifest.json"

# Top-level catalog identity (edit here, not in the generated catalog).
CATALOG_NAME = "Mod Catalog"
CATALOG_DESCRIPTION = "Community mod catalog for ModManager (and anyone else who wants the mods)."

IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg"}


class PackageError(Exception):
    """The package is invalid (zip, member names, trailer, or size)."""


class AssetExists(Exception):
    """The release already has an asset with this name."""


class Asset:
    def __init__(self, name: str, size: int, created: datetime):
        self.name = name
        self.size = size
        self.created = created  # naive-UTC datetime


class Release:
    def __init__(self, tag: str, assets: list[Asset]):
        self.tag = tag
        self.assets = assets


class PackageClient:
    """Interface everything talks to; tests and offline runs use LocalClient."""

    def list_tags(self, prefix: str) -> list[str]:
        raise NotImplementedError

    def get_release(self, tag: str) -> Release | None:
        raise NotImplementedError

    def create_release(self, tag: str, title: str) -> None:
        raise NotImplementedError

    def list_assets(self, tag: str) -> list[Asset]:
        raise NotImplementedError

    def download_asset(self, tag: str, name: str, dest: pathlib.Path) -> None:
        raise NotImplementedError

    def asset_bytes(self, tag: str, name: str) -> bytes:
        raise NotImplementedError

    def upload_asset(self, tag: str, src: pathlib.Path, name: str) -> None:
        raise NotImplementedError

    def delete_asset(self, tag: str, name: str) -> None:
        raise NotImplementedError


# ------------------------------------------------------------------- clients


class LocalClient(PackageClient):
    """Directory-backed fake: <root>/releases/<tag>/<asset-file>.

    Asset "created at" is the file mtime. Uploads replace nothing: a
    duplicate asset name raises AssetExists, mirroring the real rule that
    versions are immutable.
    """

    def __init__(self, root: pathlib.Path):
        self.root = pathlib.Path(root)

    def _release_dir(self, tag: str) -> pathlib.Path:
        return self.root / "releases" / tag

    def list_tags(self, prefix: str) -> list[str]:
        d = self.root / "releases"
        if not d.is_dir():
            return []
        return sorted(p.name for p in d.iterdir() if p.is_dir() and p.name.startswith(prefix))

    def get_release(self, tag: str) -> Release | None:
        d = self._release_dir(tag)
        if not d.is_dir():
            return None
        return Release(tag, self.list_assets(tag))

    def create_release(self, tag: str, title: str) -> None:
        self._release_dir(tag).mkdir(parents=True, exist_ok=True)

    def list_assets(self, tag: str) -> list[Asset]:
        d = self._release_dir(tag)
        if not d.is_dir():
            return []
        out = []
        for p in sorted(d.iterdir()):
            if p.is_file():
                out.append(Asset(p.name, p.stat().st_size,
                                datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)))
        return out

    def download_asset(self, tag: str, name: str, dest: pathlib.Path) -> None:
        src = self._release_dir(tag) / name
        if not src.is_file():
            raise FileNotFoundError(f"asset {name} not in release {tag}")
        shutil.copyfile(src, dest)

    def asset_bytes(self, tag: str, name: str) -> bytes:
        with tempfile.TemporaryDirectory() as td:
            dest = pathlib.Path(td) / name
            self.download_asset(tag, name, dest)
            return dest.read_bytes()

    def upload_asset(self, tag: str, src: pathlib.Path, name: str) -> None:
        d = self._release_dir(tag)
        d.mkdir(parents=True, exist_ok=True)
        target = d / name
        if target.exists():
            raise AssetExists(f"release {tag} already has asset {name}")
        shutil.copyfile(src, target)

    def delete_asset(self, tag: str, name: str) -> None:
        p = self._release_dir(tag) / name
        if p.is_file():
            p.unlink()


class GhClient(PackageClient):
    """Real client: shells out to the preinstalled `gh` CLI.

    Never hand-rolls release-asset HTTP: `gh release download` fetches the
    asset without forwarding an Authorization header to the signed storage
    URL (urllib does, and that fails). Auth comes from GH_TOKEN in the
    environment (the workflows set GH_TOKEN: ${{ github.token }}).
    """

    def __init__(self, owner: str, repo: str):
        self.owner = owner
        self.repo = repo

    def _env(self) -> dict:
        env = dict(os.environ)
        env["GH_REPO"] = f"{self.owner}/{self.repo}"
        return env

    def _run(self, args: list[str], cwd: str | None = None) -> str:
        p = subprocess.run(["gh", *args], capture_output=True, text=True, env=self._env(),
                          cwd=cwd or str(ROOT))
        if p.returncode != 0:
            raise RuntimeError(f"gh {' '.join(args)} failed: {p.stderr.strip() or p.stdout.strip()}")
        return p.stdout

    def _api(self, path: str) -> object:
        return json.loads(self._run(["api", path, "--paginate"]))

    def list_tags(self, prefix: str) -> list[str]:
        releases = self._api(f"repos/{self.owner}/{self.repo}/releases")
        return sorted(r["tag_name"] for r in releases if str(r.get("tag_name", "")).startswith(prefix))

    def get_release(self, tag: str) -> Release | None:
        try:
            data = self._api(f"repos/{self.owner}/{self.repo}/releases/tags/{tag}")
        except RuntimeError as ex:
            if "404" in str(ex):
                return None
            raise
        return Release(tag, self._assets(data))

    def _assets(self, release: dict) -> list[Asset]:
        out = []
        for a in release.get("assets", []):
            stamp = a.get("created_at") or a.get("updated_at") or "1970-01-01T00:00:00Z"
            created = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            out.append(Asset(a["name"], a.get("size", 0), created))
        return out

    def create_release(self, tag: str, title: str) -> None:
        self._run(["release", "create", tag, "--title", title,
                   "--notes", f"{title} — package assets (managed by ModCatalog, do not edit)"])

    def list_assets(self, tag: str) -> list[Asset]:
        r = self.get_release(tag)
        return r.assets if r else []

    def download_asset(self, tag: str, name: str, dest: pathlib.Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        d = dest.parent
        # name is already sanitized to [A-Za-z0-9._-]; "." is literal in the glob.
        # No --directory/--dest flag (renamed in gh 2.103.2): download into the
        # subprocess cwd instead, which works across gh versions. gh keeps the
        # asset's original name, so move it to `dest` to honour the contract
        # (callers expect the file AT `dest`, e.g. a fixed `package.zip`).
        self._run(["release", "download", tag, "--pattern", name], cwd=str(d))
        written = d / name
        if written != dest and written.is_file():
            written.rename(dest)

    def asset_bytes(self, tag: str, name: str) -> bytes:
        with tempfile.TemporaryDirectory() as td:
            self.download_asset(tag, name, pathlib.Path(td) / name)
            return (pathlib.Path(td) / name).read_bytes()

    def upload_asset(self, tag: str, src: pathlib.Path, name: str) -> None:
        try:
            # no --clobber: a duplicate name must fail (versions are immutable)
            self._run(["release", "upload", tag, str(src)])
        except RuntimeError as ex:
            if "already exists" in str(ex) or "cannot be overwritten" in str(ex):
                raise AssetExists(f"release {tag} already has asset {name}") from ex
            raise

    def delete_asset(self, tag: str, name: str) -> None:
        self._run(["release", "delete-asset", tag, name, "-y"])


# ------------------------------------------------------------ validation


def check_member_names(names: list[str]) -> None:
    for n in names:
        if n.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", n):
            raise PackageError(f"unsafe member name (absolute path): {n!r}")
        if ".." in n.replace("\\", "/").split("/"):
            raise PackageError(f"unsafe member name (path traversal): {n!r}")


def _member_names(zf: zipfile.ZipFile) -> list[str]:
    return [n for n in zf.namelist() if not n.endswith("/")]


def find_members(zf: zipfile.ZipFile, ext: str) -> list[str]:
    return [n for n in _member_names(zf) if n.lower().endswith(ext)]


def validate_package(zip_path: pathlib.Path) -> dict:
    """Validates a package zip; returns the trailer metadata dict.

    Rules: valid zip; safe member names; exactly one .utoc with a valid
    trailer; at least one .ucas and one .pak; size under 100 MB.
    """
    if zip_path.stat().st_size >= MAX_UPLOAD_BYTES:
        raise PackageError(f"package is {zip_path.stat().st_size} bytes; limit {MAX_UPLOAD_BYTES}")
    if not zipfile.is_zipfile(zip_path):
        raise PackageError("not a valid zip file")
    with zipfile.ZipFile(zip_path) as zf:
        names = _member_names(zf)
        check_member_names(names)
        utocs = find_members(zf, ".utoc")
        if len(utocs) != 1:
            raise PackageError(f"expected exactly one .utoc in the package, found {len(utocs)}: {utocs}")
        if not find_members(zf, ".ucas"):
            raise PackageError("package has no .ucas file")
        if not find_members(zf, ".pak"):
            raise PackageError("package has no .pak file")
        utoc_data = zf.read(utocs[0])
    try:
        return trailer.read_trailer(utoc_data)
    except trailer.TrailerError as ex:
        raise PackageError(f"invalid or missing trailer: {ex}") from ex


def sanitize_name(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s.strip())
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s or "package"


def cover_name(guid: str, image: dict) -> tuple[str, str]:
    """(mime, release-asset-name) for a trailer cover image."""
    ext = IMAGE_EXT.get(image["mime"])
    if ext is None:
        raise PackageError(f"unsupported cover mime {image['mime']!r}")
    name = f"{guid}-cover-{hashlib.sha256(image['data']).hexdigest()[:8]}{ext}"
    return image["mime"], name


def mod_asset_name(meta: dict) -> str:
    return f"{sanitize_name(meta['title'])}-{sanitize_name(meta['version'])}.zip"


def asset_url(owner: str, repo: str, tag: str, name: str) -> str:
    """Stable release-asset URL (the 302 target is a short-lived signed URL;
    never store that one)."""
    return f"https://github.com/{owner}/{repo}/releases/download/{tag}/{name}"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# -------------------------------------------------------------- catalog


def load_catalog(path: pathlib.Path) -> tuple[dict, dict]:
    """Returns (catalog dict with mods list, guid -> entry map)."""
    if path.is_file():
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
        mods = data.get("mods", [])
        return data, {m["id"]: m for m in mods if m.get("id")}
    return {"mods": []}, {}


def write_catalog(path: pathlib.Path, entries: list[dict]) -> None:
    entries = sorted(entries, key=lambda e: (e["name"] or "").lower())
    catalog = {"name": CATALOG_NAME, "description": CATALOG_DESCRIPTION, "mods": entries}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ------------------------------------------------------------ processing


class PackageSource:
    """One inbox item: how to materialize it into a file and how to delete it."""

    def __init__(self, uploader: str | None, materialize, delete, label: str):
        self.uploader = uploader  # None == seeding == admin
        self._materialize = materialize  # (dest) -> path
        self._delete = delete
        self.label = label

    def materialize(self, dest: pathlib.Path) -> pathlib.Path:
        return self._materialize(dest)

    def delete(self) -> None:
        self._delete()


def inbox_items_from_dir(d: pathlib.Path) -> list[PackageSource]:
    out = []
    for p in sorted(d.glob("*.zip")):
        def materialize(dest: pathlib.Path, p: pathlib.Path = p) -> pathlib.Path:
            shutil.copyfile(p, dest)
            return dest
        out.append(PackageSource(None, materialize, (lambda: None), p.name))
    return out


def inbox_items_from_release(client: PackageClient) -> list[PackageSource]:
    """Classifies inbox assets into PackageSources (drains the whole inbox).

    Two upload shapes coexist:
      zip packages   <discordId>__<ts>__<safe-name>.zip
      raw file sets  <discordId>__<uploadId>__manifest.json   (the manifest)
                     <discordId>__<uploadId>__f<i>__p<j>of<n>__<safe-filename>
    A raw set is reassembled (parts concatenated, per-file sha256 checked
    against the manifest) and zipped HERE on the runner — the Worker is a
    stateless pass-through and cannot do it. Incomplete groups are left
    alone (their parts are still arriving); groups stalled for over
    STALE_AFTER are deleted and logged.
    """
    sources: list[PackageSource] = []
    now = datetime.now(timezone.utc)
    groups: dict[tuple, list] = {}
    unknown = 0
    for a in client.list_assets(INBOX_TAG):
        info = parse_inbox_name(a.name)
        if info is None:
            unknown += 1
            continue  # unrecognized name: leave for a human
        if info["kind"] == "zip":
            if (now - a.created).total_seconds() > STALE_AFTER:
                client.delete_asset(INBOX_TAG, a.name)
                print(f"  stale inbox zip {a.name} (>{STALE_AFTER // 86400} days), removed")
                continue
            sources.append(PackageSource(
                info["uploader"],
                (lambda d, n=a.name: (client.download_asset(INBOX_TAG, n, d), d)[1]),
                (lambda n=a.name: client.delete_asset(INBOX_TAG, n)),
                a.name))
        else:
            key = (info["uploader"], info["upload_id"])
            groups.setdefault(key, []).append((info, a))
    for (uploader, uid), items in sorted(groups.items()):
        src = raw_group_source(client, uploader, uid, items, now)
        if src is not None:
            sources.append(src)
    if unknown:
        print(f"  note: {unknown} unrecognized inbox asset name(s) left for a human")
    return sources


def parse_inbox_name(name: str) -> dict | None:
    """Parses an inbox asset name; None when it matches neither shape."""
    parts = name.split("__")
    if len(parts) == 3 and parts[2].lower() == MANIFEST_PART:
        return {"kind": "manifest", "uploader": parts[0] or None, "upload_id": parts[1]}
    if len(parts) == 2 and parts[1].lower().endswith(".zip"):
        return {"kind": "zip", "uploader": None, "name": name}
    if len(parts) == 3 and parts[2].lower().endswith(".zip"):
        return {"kind": "zip", "uploader": parts[0] or None, "name": name}
    if len(parts) == 5 and parts[2].startswith("f") and parts[3].startswith("p") and "of" in parts[3]:
        return {"kind": "part", "uploader": parts[0] or None, "upload_id": parts[1],
                "file_idx": int(parts[2][1:]),
                "part_idx": int(parts[3][1:].split("of")[0]),
                "part_count": int(parts[3].split("of")[1]),
                "filename": parts[4]}
    return None


def make_package_zip(files: dict, dest: pathlib.Path) -> None:
    """Zips a raw file set into one package (deterministic member order,
    .pak/.ucas/.utoc first, same compression as the example packages)."""
    order = {".pak": 0, ".ucas": 1, ".utoc": 2}

    def rank(n: str) -> tuple:
        ext = n.rsplit(".", 1)[-1].lower() if "." in n else ""
        return (order.get(ext, 3), n)

    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for n in sorted(files, key=rank):
            z.writestr(n, files[n])


def raw_group_source(client: PackageClient, uploader: str | None, uid: str,
                     items: list, now: datetime) -> PackageSource | None:
    """Builds one PackageSource for a complete raw file set, or None (wait)."""
    label = f"raw {uid}"
    newest = max(a.created for _, a in items)
    if (now - newest).total_seconds() > STALE_AFTER:
        for _, a in items:
            client.delete_asset(INBOX_TAG, a.name)
        print(f"  REJECTED {label}: stalled for >{STALE_AFTER // 86400} days, removed", file=sys.stderr)
        return None

    manifest_asset = next((a for i, a in items if i["kind"] == "manifest"), None)
    if manifest_asset is None:
        print(f"  {label}: manifest missing, waiting")
        return None

    parts_by_file: dict[int, list] = {}
    for i, a in items:
        if i["kind"] == "part":
            parts_by_file.setdefault(i["file_idx"], []).append((i, a))

    try:
        manifest = json.loads(client.asset_bytes(INBOX_TAG, manifest_asset.name))
    except Exception as ex:
        # an unparseable manifest is fatal (delete + log via the normal path)
        def materialize_bad(dest: pathlib.Path) -> pathlib.Path:
            raise PackageError(f"manifest is not valid JSON: {ex}")
        return PackageSource(uploader, materialize_bad,
                            (lambda: [client.delete_asset(INBOX_TAG, a.name) for _, a in items]),
                            label)

    files = manifest.get("files", [])
    if not files:
        print(f"  {label}: manifest has no files, waiting")
        return None
    if set(parts_by_file) - set(range(len(files))):
        print(f"  {label}: parts for unknown file indices, waiting")
        return None
    for idx, f in enumerate(files):
        need = f.get("parts", 1)
        have = sorted((i for i, _ in parts_by_file.get(idx, [])), key=lambda i: i["part_idx"])
        if len(have) != need or {i["part_idx"] for i in have} != set(range(need)):
            print(f"  {label}: {f.get('name')}: parts incomplete ({len(have)}/{need}), waiting")
            return None

    def materialize(dest: pathlib.Path) -> pathlib.Path:
        data: dict = {}
        for idx, f in enumerate(files):
            parts = sorted(parts_by_file[idx], key=lambda x: x[0]["part_idx"])
            for i, _ in parts:
                if i["part_count"] != f.get("parts", 1):
                    raise PackageError(f"file {f.get('name')}: part header says "
                                      f"{i['part_count']} parts, manifest says {f.get('parts')}")
            blob = bytearray()
            for _, a in parts:
                blob += client.asset_bytes(INBOX_TAG, a.name)
            want = f.get("sha256")
            got = hashlib.sha256(bytes(blob)).hexdigest()
            if want and got != want:
                raise PackageError(f"file {f.get('name')}: sha256 mismatch "
                                  f"(client said {want[:12]}…, got {got[:12]}…)")
            data[f["name"]] = bytes(blob)
        check_member_names(list(data))
        if len(set(data)) != len(data):
            raise PackageError("duplicate file names in the upload")
        make_package_zip(data, dest)
        if dest.stat().st_size > MAX_RELEASE_ASSET_BYTES:
            raise PackageError(f"package zip is {dest.stat().st_size} bytes; "
                              f"the release asset limit is {MAX_RELEASE_ASSET_BYTES}")
        return dest

    def delete() -> None:
        for _, a in items:
            client.delete_asset(INBOX_TAG, a.name)

    return PackageSource(uploader, materialize, delete, label)


class Processor:
    """Drains inbox items, re-homes valid ones, and merges into the catalog."""

    def __init__(self, client: PackageClient, owner: str, repo: str,
                 admins: set[str], catalog_path: pathlib.Path):
        self.client = client
        self.owner = owner
        self.repo = repo
        self.admins = admins
        self.catalog_path = catalog_path

    # -- ownership -----------------------------------------------------
    def _is_admin(self, uploader: str | None) -> bool:
        return uploader is None or uploader in self.admins

    def _owner_of(self, guid: str, old_entries: dict) -> str | None:
        entry = old_entries.get(guid)
        return entry.get("uploader") if entry else None

    # -- one item -------------------------------------------------------
    def _process_item(self, src: PackageSource, entries: dict,
                      now: datetime) -> tuple[bool, str]:
        with tempfile.TemporaryDirectory() as td:
            tmp = pathlib.Path(td) / "package.zip"
            src.materialize(tmp)
            try:
                meta = validate_package(tmp)
            except PackageError as ex:
                src.delete()
                return False, f"invalid package: {ex}"

            guid = meta["guid"]
            uploader = src.uploader
            admin = self._is_admin(uploader)
            # `entries` is live: an earlier item in this same run can set the owner
            owner = self._owner_of(guid, entries)
            if owner and uploader and uploader != owner and not admin:
                src._delete()
                return False, f"GUID {guid} is owned by {owner}; uploader {uploader} rejected"

            zip_name = mod_asset_name(meta)
            tag = f"{MOD_TAG_PREFIX}{guid}"
            existing = self.client.get_release(tag)
            if existing and any(a.name == zip_name for a in existing.assets):
                src._delete()
                return False, f"version already uploaded: {zip_name} (versions are immutable)"

            if existing is None:
                self.client.create_release(tag, meta["title"])

            # upload the zip (under its own name)
            staged = pathlib.Path(td) / zip_name
            shutil.copyfile(tmp, staged)
            try:
                self.client.upload_asset(tag, staged, zip_name)
            except AssetExists:
                src._delete()
                return False, f"version already uploaded: {zip_name} (versions are immutable)"

            # cover (dedup: skip an identical one, never overwrite a different one)
            image = meta.get("image")
            if image is not None:
                _, cname = cover_name(guid, image)
                rel = self.client.get_release(tag)
                names = {a.name for a in rel.assets} if rel else set()
                if cname in names:
                    if self.client.asset_bytes(tag, cname) != image["data"]:
                        src._delete()
                        return False, f"cover name collision with different content: {cname}"
                else:
                    cover_path = pathlib.Path(td) / cname
                    cover_path.write_bytes(image["data"])
                    self.client.upload_asset(tag, cover_path, cname)

            sha = hashlib.sha256(tmp.read_bytes()).hexdigest()
            src._delete()  # always: success or failure

            if admin:
                new_owner = owner  # seeding keeps/leaves the owner as-is
            else:
                new_owner = owner or uploader

            entry = {
                "id": guid,
                "name": meta["title"],
                "author": meta["author"],
                "version": meta["version"],
                "description": meta["description"],
                "file": asset_url(self.owner, self.repo, tag, zip_name),
                "size": tmp.stat().st_size,
                "sha256": sha,
                "uploader": new_owner,
                "updated": _iso(now),
            }
            if image is not None:
                entry["cover"] = asset_url(self.owner, self.repo, tag, cname)
            return True, entry

    def run(self, sources: list[PackageSource]) -> dict:
        # Make sure the inbox release exists so the Worker never 503s after
        # the first run (nobody has to create it by hand).
        if self.client.get_release(INBOX_TAG) is None:
            self.client.create_release(INBOX_TAG, "Inbox")
        _, old_entries = load_catalog(self.catalog_path)
        entries = {m["id"]: dict(m) for m in old_entries.values()}
        ok = rejected = 0
        for src in sources:
            try:
                success, result = self._process_item(src, entries,
                                                   datetime.now(timezone.utc))
            except Exception as ex:  # a client hiccup must not strand the rest
                src._delete()
                success, result = False, f"error: {ex}"
            if success:
                entries[result["id"]] = result
                ok += 1
                print(f"  ok {src.label}: {result['name']} v{result['version']} "
                      f"(id {result['id']}, owner {result['uploader']})")
            else:
                rejected += 1
                print(f"  REJECTED {src.label}: {result}", file=sys.stderr)
        if ok:
            write_catalog(self.catalog_path, list(entries.values()))
            print(f"\n{self.catalog_path.name}: catalog written ({ok} new/updated, {rejected} rejected)")
        else:
            print(f"\nnothing processed ({rejected} rejected); catalog left unchanged")
        return {"ok": ok, "rejected": rejected}


# --------------------------------------------------------------- rebuild


def rebuild(client: PackageClient, owner: str, repo: str, catalog_path: pathlib.Path) -> dict:
    """Regenerates the whole catalog from the mod-* releases.

    Each entry points at the most recently uploaded version zip of that
    release (by asset created-at). `uploader` is inherited from the existing
    catalog when it is present (the re-homed asset names don't carry the
    uploader id); otherwise it is null.
    """
    _, old_entries = load_catalog(catalog_path)
    entries = []
    for tag in client.list_tags(MOD_TAG_PREFIX):
        rel = client.get_release(tag)
        if rel is None:
            continue
        zips = [a for a in rel.assets if a.name.lower().endswith(".zip")]
        if not zips:
            print(f"  {tag}: no zip assets, skipped")
            continue
        newest = max(zips, key=lambda a: (a.created, a.name))
        with tempfile.TemporaryDirectory() as td:
            tmp = pathlib.Path(td) / newest.name
            client.download_asset(tag, newest.name, tmp)
            try:
                meta = validate_package(tmp)
            except PackageError as ex:
                print(f"  {tag}: REJECTED {ex}", file=sys.stderr)
                continue
            if meta["guid"] != tag[len(MOD_TAG_PREFIX):]:
                print(f"  {tag}: trailer guid {meta['guid']} does not match the tag, skipped",
                      file=sys.stderr)
                continue
            sha = hashlib.sha256(tmp.read_bytes()).hexdigest()
            entry = {
                "id": meta["guid"],
                "name": meta["title"],
                "author": meta["author"],
                "version": meta["version"],
                "description": meta["description"],
                "file": asset_url(owner, repo, tag, newest.name),
                "size": newest.size,
                "sha256": sha,
                "uploader": old_entries.get(meta["guid"], {}).get("uploader"),
                "updated": _iso(newest.created),
            }
            image = meta.get("image")
            if image is not None:
                _, cname = cover_name(meta["guid"], image)
                if any(a.name == cname for a in rel.assets):
                    entry["cover"] = asset_url(owner, repo, tag, cname)
                else:
                    print(f"  {tag}: cover {cname} missing from the release, omitted")
            entries.append(entry)
    write_catalog(catalog_path, entries)
    print(f"\n{catalog_path.name}: {len(entries)} mod(s) rebuilt")
    return {"ok": len(entries)}


# ------------------------------------------------------------------ cli


def make_client(args, owner: str | None, repo: str | None) -> PackageClient:
    if args.client == "local":
        if not args.root:
            raise SystemExit("error: --client local requires --root DIR")
        return LocalClient(pathlib.Path(args.root).resolve())
    if args.client != "gh":
        raise SystemExit(f"error: unknown client {args.client!r}")
    if not owner or not repo:
        raise SystemExit("error: the real client needs --owner/--repo (or GITHUB_OWNER/GITHUB_REPO/GITHUB_REPOSITORY)")
    return GhClient(owner, repo)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--client", choices=("local", "gh"), default="gh")
        p.add_argument("--root", help="root dir for the local client")
        p.add_argument("--owner", default=os.environ.get("GITHUB_OWNER"))
        p.add_argument("--repo", default=os.environ.get("GITHUB_REPO"))
        p.add_argument("--catalog", default=str(CATALOG_DEFAULT))

    p = sub.add_parser("process", help="drain inbox items and merge into the catalog")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-inbox", action="store_true")
    src.add_argument("--from-dir", metavar="DIR")
    common(p)

    p = sub.add_parser("rebuild", help="regenerate the whole catalog from mod-* releases")
    common(p)

    args = ap.parse_args(argv)
    owner, repo = args.owner, args.repo
    if not owner or not repo:
        gr = os.environ.get("GITHUB_REPOSITORY")
        if gr and "/" in gr:
            owner, repo = gr.split("/", 1)
    if not owner or not repo:
        raise SystemExit("error: owner/repo unknown (set GITHUB_REPOSITORY or pass --owner/--repo)")
    admins = {s.strip() for s in os.environ.get("ADMIN_DISCORD_IDS", "").split(",") if s.strip()}

    client = make_client(args, owner, repo)
    catalog = pathlib.Path(args.catalog)
    if args.cmd == "rebuild":
        rebuild(client, owner, repo, catalog)
        return 0

    if args.from_dir:
        d = pathlib.Path(args.from_dir).resolve()
        if not d.is_dir():
            raise SystemExit(f"error: {d} is not a directory")
        sources = inbox_items_from_dir(d)
        if not sources:
            raise SystemExit(f"error: no .zip packages found in {d}")
    else:
        if client.get_release(INBOX_TAG) is None:
            client.create_release(INBOX_TAG, "Inbox")
        sources = inbox_items_from_release(client)
        if not sources:
            print("inbox is empty; nothing to do")
            return 0

    Processor(client, owner, repo, admins, catalog).run(sources)
    return 0


if __name__ == "__main__":
    sys.exit(main())
