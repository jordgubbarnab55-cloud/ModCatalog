#!/usr/bin/env python3
"""Generates site/catalog.json from the mod package releases.

Single source of truth: the release assets. A mod is a `.zip` release asset
whose package contains a `.utoc` carrying a valid metadata trailer (see
trailer.py); the catalog entry (name/author/version/gameVersion/description/
tags/id/file/size/sha256/cover/updated) is derived from it. The shared
formats (trailer, catalog schema, package shape, tag vocabulary) live in the
vendored `mod-contract/` folder. Packages without a valid
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
  python build.py process --from-dir legacy-assets --as-uid ID --as-username NAME
                                                    # seed a dir's zips as that Discord user
  python build.py rebuild                           # regenerate from all mod-* releases
  python build.py retitle                           # only re-apply the name/description

  The catalog's name/description come from site/config.json (`title`,
  `description`; defaults when absent), `--config` picks another file.

  --client local --root DIR selects the directory-backed client.
  --owner / --repo default to GITHUB_OWNER/GITHUB_REPO (or GITHUB_REPOSITORY).

Two upload shapes are accepted in the inbox (both end in a release-asset zip):
  * a ready-made .zip package (the original zip mode), or
  * an upload SET announced by a small JSON manifest: either the loose
    .utoc/.ucas/.pak/+.sig files or exactly one .zip, each streamed to the
    inbox (part-split when over 100 MB), plus an optional metadata.json.
    This pipeline reassembles the parts, verifies the per-file sha256 from
    the manifest, applies the metadata and zips the set HERE on the runner
    (the Worker is a stateless pass-through and cannot do it).

Identity: a mod IS its trailer `identifier` (catalog `id`, release tag
`mod_tag(identifier)`), minted on its first upload as
`{discordId}.{Title, whitespace removed}` and locked afterwards; compared
case-insensitively. The trailer GUID is only a revision id (fresh per upload).

Verified authors: every stored package goes through `apply_metadata`, the one
place a stored trailer is written, which FORCES `author` = the uploader's
Discord username, the resolved `identifier` and a fresh `guid`.
The uploader is stamped into the inbox asset name by the Worker
(`<discordId>-<hex of the UTF-8 username>__…`); nothing the client sends is
trusted for it.
"""

import argparse
import base64
import binascii
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from typing import NamedTuple

import trailer

ROOT = pathlib.Path(__file__).resolve().parent
SITE = ROOT / "site"
CATALOG_DEFAULT = SITE / "catalog.json"
CONFIG_DEFAULT = SITE / "config.json"
CONTRACT = ROOT / "mod-contract"
CATALOG_SCHEMA_VERSION = 1

INBOX_TAG = "inbox"
MOD_TAG_PREFIX = "mod-"
MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024  # GitHub release asset cap
STALE_AFTER = 7 * 24 * 3600  # seconds; incomplete/stalled inbox items are swept
MANIFEST_PART = "manifest.json"
METADATA_PART = "metadata.json"

# Top-level catalog identity when site/config.json sets none (`title`, `description`).
DEFAULT_CATALOG_NAME = "Mod Catalog"
DEFAULT_CATALOG_DESCRIPTION = "Community mod catalog for ModManager (and anyone else who wants the mods)."

IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg"}

SET_REQUIRED = (".utoc", ".ucas", ".pak")
SET_EXTENSIONS = SET_REQUIRED + (".sig",)


def load_tag_vocabulary() -> list[str]:
    with (CONTRACT / "tags.json").open(encoding="utf-8") as f:
        return list(json.load(f)["tags"])


TAGS = load_tag_vocabulary()


def sanitize_tags(tags) -> tuple[list[str], list[str]]:
    """(kept, dropped): kept = vocabulary tags in the vocabulary's casing,
    order-preserving, deduplicated case-insensitively; blanks are skipped."""
    by_key = {t.lower(): t for t in TAGS}
    kept, dropped = [], []
    for raw in tags or []:
        tag = (raw or "").strip()
        if not tag:
            continue
        match = by_key.get(tag.lower())
        if match is None:
            if tag.lower() not in {d.lower() for d in dropped}:
                dropped.append(tag)
        elif match not in kept:
            kept.append(match)
    return kept, dropped


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


def is_unsafe_member(name: str) -> bool:
    n = name.replace("\\", "/")
    return n.startswith("/") or bool(re.match(r"^[A-Za-z]:", n)) or ".." in n.split("/")


def check_member_names(names: list[str]) -> None:
    for n in names:
        if is_unsafe_member(n):
            raise PackageError(f"unsafe member name: {n!r}")


def _split(name: str) -> tuple[str, str]:
    """(base name, lowercase extension) of a member's file name."""
    leaf = name.replace("\\", "/").rsplit("/", 1)[-1]
    stem, dot, ext = leaf.rpartition(".")
    return (stem, "." + ext.lower()) if dot and stem else (leaf, "")


def classify_members(names: list[str]) -> tuple[str, str | None, dict]:
    """Package-shape rule for a zip (mod-contract/package-spec.md).

    Returns (verdict, base, {ext: member}) with verdict one of
    "ok" / "unsafe-path" / "multiple-sets" / "incomplete".
    """
    groups: dict[str, dict[str, str]] = {}
    for name in names:
        if not name or name.replace("\\", "/").endswith("/"):
            continue
        if is_unsafe_member(name):
            return "unsafe-path", None, {}
        base, ext = _split(name)
        if base and ext in SET_EXTENSIONS:
            groups.setdefault(base, {}).setdefault(ext, name)
    complete = [b for b, exts in groups.items() if all(e in exts for e in SET_REQUIRED)]
    if len(complete) > 1:
        return "multiple-sets", None, {}
    if not complete:
        return "incomplete", None, {}
    return "ok", complete[0], groups[complete[0]]


def classify_raw(names: list[str]) -> tuple[str, str | None]:
    """Package-shape rule for loose files: "ok" / "bad-files" /
    "name-mismatch" / "incomplete", plus the base name when known."""
    if not 3 <= len(names) <= 4:
        return "bad-files", None
    bases = {_split(n)[0] for n in names}
    if len(bases) > 1:
        return "name-mismatch", None
    base = bases.pop()
    exts = {_split(n)[1] for n in names}
    if exts - set(SET_EXTENSIONS):
        return "bad-files", base
    if not set(SET_REQUIRED) <= exts:
        return "incomplete", base
    return "ok", base


def shape_error(verdict: str) -> str | None:
    """The rejection text for a `classify_members` verdict (None = ok)."""
    return {
        "unsafe-path": "unsafe member name (absolute path or path traversal)",
        "multiple-sets": "more than one complete .utoc/.ucas/.pak set — one mod per package",
        "incomplete": "no complete .utoc/.ucas/.pak set sharing one base name",
    }.get(verdict)


def validate_package(zip_path: pathlib.Path) -> dict:
    """Validates a package zip; returns the trailer metadata dict.

    Rules: a valid zip within the release-asset limit; the package-shape
    rule (safe member names, exactly one complete .utoc/.ucas/.pak set);
    that set's .utoc carries a valid trailer.
    """
    size = zip_path.stat().st_size
    if size > MAX_RELEASE_ASSET_BYTES:
        raise PackageError(f"package is {size} bytes; the release asset limit is {MAX_RELEASE_ASSET_BYTES}")
    if not zipfile.is_zipfile(zip_path):
        raise PackageError("not a valid zip file")
    with zipfile.ZipFile(zip_path) as zf:
        verdict, _, members = classify_members(zf.namelist())
        problem = shape_error(verdict)
        if problem:
            raise PackageError(problem)
        utoc_data = zf.read(members[".utoc"])
    try:
        return trailer.read_trailer(utoc_data)
    except trailer.TrailerError as ex:
        raise PackageError(f"invalid or missing trailer ({ex.kind}): {ex}") from ex


def parse_upload_metadata(raw: bytes) -> dict:
    """Parses the untrusted metadata.json of an upload set into the dict
    `apply_metadata` takes. `image` is present only when the upload says
    something about the cover: None removes it, {"mime", "data"} replaces it."""
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise PackageError("metadata.json is not valid JSON")
    if not isinstance(obj, dict):
        raise PackageError("metadata.json is not a JSON object")
    meta: dict = {}
    for key in ("title", "author", "description", "version", "game_version"):
        value = obj.get(key)
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise PackageError(f'metadata.json: "{key}" must be a string')
        meta[key] = value
    # "guid" is ignored (a revision id the runner writes fresh); "identifier"
    # names the mod an UPDATE targets (absent / null / "" = a new mod)
    target = obj.get("identifier")
    if target is not None and not isinstance(target, str):
        raise PackageError('metadata.json: "identifier" must be a string')
    meta["target"] = target.strip() if target and target.strip() else None
    tags = obj.get("tags")
    if tags is None:
        tags = []
    if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
        raise PackageError('metadata.json: "tags" must be an array of strings')
    meta["tags"] = tags
    if "image" in obj:
        image = obj["image"]
        if image is None:
            meta["image"] = None
        elif isinstance(image, dict) and isinstance(image.get("mime"), str) and isinstance(image.get("data"), str):
            try:
                data = base64.b64decode(image["data"], validate=True)
            except (binascii.Error, ValueError):
                raise PackageError("metadata.json: image data is not valid base64")
            meta["image"] = {"mime": image["mime"], "data": data}
        else:
            raise PackageError('metadata.json: "image" must be null or {"mime", "data"}')
    try:
        trailer.validate_metadata({**meta, "image": meta.get("image")})
    except trailer.TrailerError as ex:
        raise PackageError(f"metadata.json is invalid ({ex.kind}): {ex}") from ex
    return meta


class Uploader(NamedTuple):
    """The verified identity an upload is stamped with: the Discord user id
    and the Discord `username` (not the display name) at upload time."""
    uid: str
    username: str


def mint_identifier(uid: str, title: str) -> str:
    """A new mod's permanent identifier: `{discordId}.{title}` with all
    whitespace removed. The trailer puts no charset rule on identifiers (only
    <= 513 UTF-16 units, which a <= 256 title + an id always fits), so every
    other character of the title is kept; `mod_tag` makes it git-safe."""
    identifier = trailer.build_identifier(uid, title)
    if identifier.endswith("."):
        raise PackageError("the title has no non-whitespace character to build the mod's identifier from")
    return identifier


def ident_key(identifier: str) -> str:
    """Identifiers compare case-insensitively: the lowercase form is the key."""
    return (identifier or "").lower()


def mod_tag(identifier: str) -> str:
    """The release tag of the mod with this identifier:
    `mod-<slug>-<first 8 hex of sha256(lowercased identifier)>`, the slug being
    the lowercased identifier reduced to [a-z0-9._-] (other runs -> "-", no
    "..", no leading/trailing "." or "-", at most 100 chars). The hash keeps
    two identifiers with the same slug apart; equal-ignoring-case identifiers
    share the tag on purpose. E.g. "123.CoolMod!" -> "mod-123.coolmod-<8 hex>"."""
    key = ident_key(identifier)
    slug = re.sub(r"[^a-z0-9._-]+", "-", key)
    slug = re.sub(r"\.{2,}", ".", slug)
    slug = slug.strip(".-")[:100].strip(".-")
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:8]
    return f"{MOD_TAG_PREFIX}{slug}-{digest}" if slug else f"{MOD_TAG_PREFIX}{digest}"


def uploader_from_identifier(identifier: str) -> str | None:
    """The Discord id a catalog-minted identifier starts with: its owner."""
    m = re.match(r"^(\d+)\.", identifier or "")
    return m.group(1) if m else None


def existing_trailer(utoc: bytes) -> dict | None:
    """The .utoc's current trailer metadata, None when it has none."""
    try:
        return trailer.read_trailer(utoc)
    except trailer.TrailerError as ex:
        if ex.kind == "NoTrailer":
            return None
        raise PackageError(f"the package's .utoc trailer is unreadable ({ex.kind}): {ex}") from ex


def package_fields(metadata: dict | None, existing: dict | None) -> dict:
    """The fields an upload declares: its metadata.json, else the package's
    own trailer (which must then exist)."""
    if metadata is not None:
        return metadata
    if existing is None:
        raise PackageError("invalid or missing trailer (NoTrailer): no metadata trailer")
    return existing


def apply_metadata(utoc: bytes, metadata: dict | None, existing: dict | None, *,
                   author: str, identifier: str, fallback_cover=None) -> bytes:
    """The one place a stored trailer is written: returns the .utoc with the
    package's metadata as its trailer.

    `metadata` is from `parse_upload_metadata`; None keeps the package's own
    trailer fields (`package_fields`). Whatever the source, `author` (the
    verified name), `identifier` (the mod's minted or locked one) and a FRESH
    guid (a revision id) are forced. The cover: metadata `image` None removes
    it, an object replaces it. Absent: for an explicit update (metadata.json
    with an `identifier`, parsed as `target`) the mod's current cover
    (`fallback_cover()`) comes first and the package's own cover is used only
    when the mod has none; otherwise (a new mod, or no metadata.json, where the
    package's trailer is the uploader's intent) the package's own cover is kept
    and `fallback_cover()` supplies one only when the package has none."""
    fields = package_fields(metadata, existing)
    meta = {k: fields[k] for k in ("title", "description", "version", "game_version", "tags")}
    meta["author"] = author
    meta["identifier"] = identifier
    meta["guid"] = str(uuid.uuid4())
    if metadata is not None and "image" in metadata:
        meta["image"] = metadata["image"]
    else:
        own = (existing or {}).get("image")
        explicit_update = metadata is not None and bool(metadata.get("target"))
        if explicit_update and fallback_cover is not None:
            meta["image"] = fallback_cover() or own
        else:
            meta["image"] = own
            if own is None and fallback_cover is not None:
                meta["image"] = fallback_cover()
    try:
        return trailer.write_trailer(utoc, meta)[0]
    except trailer.TrailerError as ex:
        raise PackageError(f"cannot write the metadata ({ex.kind}): {ex}") from ex


def sanitize_name(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s.strip())
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s or "package"


def cover_name(image: dict) -> tuple[str, str]:
    """(mime, release-asset-name) for a trailer cover image (in the mod's own
    release, so the name only needs the content hash)."""
    ext = IMAGE_EXT.get(image["mime"])
    if ext is None:
        raise PackageError(f"unsupported cover mime {image['mime']!r}")
    name = f"cover-{hashlib.sha256(image['data']).hexdigest()[:8]}{ext}"
    return image["mime"], name


def mod_asset_name(meta: dict) -> str:
    return f"{sanitize_name(meta['title'])}-{sanitize_name(meta['version'])}.zip"


def free_asset_name(base: str, taken: set[str]) -> str:
    """`base` (a `<SafeName>-<version>.zip`) when no asset has it yet, else the
    first free `<SafeName>-<version>-<n>.zip`, n = 2, 3, ... (a re-upload of a
    version with different bytes; existing assets are never overwritten)."""
    if base not in taken:
        return base
    stem = base[:-len(".zip")]
    n = 2
    while f"{stem}-{n}.zip" in taken:
        n += 1
    return f"{stem}-{n}.zip"


def same_version_names(base: str, names) -> list[str]:
    """The assets that may hold an earlier upload of `base`'s version: `base`
    itself and its `-<n>` suffixed names (see `free_asset_name`)."""
    stem = re.escape(base[:-len(".zip")])
    return sorted(n for n in names if re.fullmatch(stem + r"(-\d+)?\.zip", n))


def asset_order_key(asset: "Asset") -> tuple:
    """Upload order of a release's assets: created-at, then (for a tie in
    GitHub's 1 s resolution) the longer name -- a suffixed re-upload
    `<base>-<n>.zip` is longer than the name it collided with -- then name."""
    return (asset.created, len(asset.name), asset.name)


_CONTENT_ORDER = (".utoc", ".ucas", ".pak", ".sig")


def content_hash(members: dict) -> str:
    """sha256 of a package set's content (members name -> bytes, the
    .utoc/.ucas/.pak(+.sig) of one set), independent of the zip container
    (timestamps, compression) and of member names: each member as extension
    + length + bytes, in the fixed order .utoc, .ucas, .pak, .sig.

    The .utoc is cut at TocEnd, so the trailer -- which the catalog rewrites
    on every stored package -- does not count: "the same mod content"."""
    by_ext = {_split(n)[1]: data for n, data in members.items()}
    h = hashlib.sha256()
    for ext in _CONTENT_ORDER:
        data = by_ext.get(ext)
        if data is None:
            continue
        if ext == ".utoc":
            try:
                end = trailer.toc_end(trailer.parse_toc_header(data), data)
            except trailer.TrailerError as ex:
                raise PackageError(f"cannot locate TocEnd in the .utoc ({ex.kind}): {ex}") from ex
            data = data[:end]
        h.update(ext.encode("ascii") + len(data).to_bytes(8, "little"))
        h.update(data)
    return h.hexdigest()


def package_fingerprint(members: dict) -> str:
    """"The same stored package": `content_hash` plus every trailer field
    except the guid (a fresh revision id on every upload, so it never counts)."""
    utoc = next((d for n, d in members.items() if _split(n)[1] == ".utoc"), b"")
    meta = existing_trailer(utoc) or {}
    fields = {k: v for k, v in meta.items() if k != "guid"}
    if fields.get("image"):
        fields["image"] = {"mime": fields["image"]["mime"], "data": fields["image"]["data"].hex()}
    blob = json.dumps(fields, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(content_hash(members).encode("ascii") + b"\0" + blob).hexdigest()


def zip_content_hash(path: pathlib.Path) -> str:
    """`content_hash` of a package zip's set members."""
    return content_hash(zip_members(path.read_bytes()))


def zip_fingerprint(path: pathlib.Path) -> str:
    """`package_fingerprint` of a package zip's set members."""
    return package_fingerprint(zip_members(path.read_bytes()))


def norm_title(title: str | None) -> str:
    """A title for duplicate comparison: trimmed, case-insensitive."""
    return (title or "").strip().casefold()


def asset_url(owner: str, repo: str, tag: str, name: str) -> str:
    """Stable release-asset URL (the 302 target is a short-lived signed URL;
    never store that one)."""
    return f"https://github.com/{owner}/{repo}/releases/download/{tag}/{name}"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# -------------------------------------------------------------- catalog


def load_catalog(path: pathlib.Path) -> tuple[dict, dict]:
    """Returns (catalog dict with mods list, `ident_key(id)` -> entry map)."""
    if path.is_file():
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
        mods = data.get("mods", [])
        return data, {ident_key(m["id"]): m for m in mods if m.get("id")}
    return {"mods": []}, {}


def entry_from_meta(meta: dict, *, file_url: str, size: int, sha256: str,
                    uploader: str, updated: str, cover_url: str | None) -> dict:
    """The catalog entry for one package (mod-contract/catalog.schema.json).
    Tags outside the vocabulary are dropped with a log line."""
    tags, dropped = sanitize_tags(meta.get("tags"))
    if dropped:
        print(f"  {meta['identifier']}: unknown tag(s) dropped: {', '.join(dropped)}")
    entry = {
        "id": meta["identifier"],
        "name": meta["title"],
        "author": meta["author"],
        "version": meta["version"],
    }
    if meta.get("game_version"):
        entry["gameVersion"] = meta["game_version"]
    entry["description"] = meta["description"]
    if tags:
        entry["tags"] = tags
    entry.update({"file": file_url, "size": size, "sha256": sha256,
                  "uploader": uploader, "updated": updated})
    if cover_url is not None:
        entry["cover"] = cover_url
    return entry


def load_catalog_identity(config_path: pathlib.Path = CONFIG_DEFAULT) -> tuple[str, str]:
    """(name, description) of the catalog: site/config.json's `title` and
    `description` (trimmed). A missing or unreadable file, a non-object, or a
    missing/blank/non-string value falls back to the defaults."""
    try:
        with config_path.open(encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        cfg = {}
    except (OSError, ValueError) as e:
        print(f"  {config_path.name}: unreadable ({e}); using the default catalog title")
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}

    def value(key: str, default: str) -> str:
        v = cfg.get(key)
        return v.strip() if isinstance(v, str) and v.strip() else default

    return value("title", DEFAULT_CATALOG_NAME), value("description", DEFAULT_CATALOG_DESCRIPTION)


def write_catalog(path: pathlib.Path, entries: list[dict],
                  config_path: pathlib.Path = CONFIG_DEFAULT) -> None:
    entries = sorted(entries, key=lambda e: (e["name"] or "").lower())
    name, description = load_catalog_identity(config_path)
    catalog = {"schemaVersion": CATALOG_SCHEMA_VERSION, "name": name,
               "description": description, "verifiedAuthors": True, "mods": entries}
    dump_catalog(path, catalog)


def dump_catalog(path: pathlib.Path, catalog: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ------------------------------------------------------------ processing


class Staged(NamedTuple):
    """An upload as received, before its trailer is written: the set's
    members (name -> bytes: .utoc/.ucas/.pak(+.sig) of one set) and its
    parsed metadata.json (None = zip mode / a set without one)."""
    members: dict
    metadata: dict | None


class PackageSource:
    """One inbox item: how to load it (-> Staged) and how to delete it."""

    def __init__(self, uploader: Uploader, load, delete, label: str):
        self.uploader = uploader
        self._load = load  # () -> Staged
        self._delete = delete
        self.label = label

    def load(self) -> Staged:
        return self._load()

    def delete(self) -> None:
        self._delete()


def read_zip_package(path: pathlib.Path) -> dict:
    """The set members of a zip-mode package (size-checked)."""
    size = path.stat().st_size
    if size > MAX_RELEASE_ASSET_BYTES:
        raise PackageError(f"package is {size} bytes; the release asset limit is {MAX_RELEASE_ASSET_BYTES}")
    return zip_members(path.read_bytes())


def inbox_items_from_dir(d: pathlib.Path, uploader: Uploader) -> list[PackageSource]:
    """The dir's zips as uploads by `uploader` (seeding)."""
    return [PackageSource(uploader, (lambda p=p: Staged(read_zip_package(p), None)),
                          (lambda: None), p.name)
            for p in sorted(d.glob("*.zip"))]


def inbox_items_from_release(client: PackageClient) -> list[PackageSource]:
    """Classifies inbox assets into PackageSources (drains the whole inbox).

    Two upload shapes coexist; <uploader> is the Worker's stamp
    `<discordId>-<hex of the UTF-8 username>`:
      zip packages   <uploader>__<ts>__<safe-name>.zip
      upload sets    <uploader>__<uploadId>__manifest.json   (the manifest)
                     <uploader>__<uploadId>__metadata.json   (optional)
                     <uploader>__<uploadId>__f<i>__p<j>of<n>__<safe-filename>
    A set is reassembled (parts concatenated, per-file sha256 checked
    against the manifest) HERE on the runner — the Worker is a stateless
    pass-through and cannot do it; the Processor then writes its trailer
    and zips it. Incomplete groups are left
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
            def load(n: str = a.name) -> Staged:
                with tempfile.TemporaryDirectory() as td:
                    p = pathlib.Path(td) / "upload.zip"
                    client.download_asset(INBOX_TAG, n, p)
                    return Staged(read_zip_package(p), None)
            sources.append(PackageSource(
                info["uploader"], load,
                (lambda n=a.name: client.delete_asset(INBOX_TAG, n)), a.name))
        else:
            key = (info["uploader"].uid, info["upload_id"])
            groups.setdefault(key, []).append((info, a))
    for (_, uid), items in sorted(groups.items()):
        # the manifest's stamp names the uploader (a token minted mid-upload
        # may change the username between parts)
        first = next((i for i, _ in items if i["kind"] == "manifest"), items[0][0])
        src = raw_group_source(client, first["uploader"], uid, items, now)
        if src is not None:
            sources.append(src)
    if unknown:
        print(f"  note: {unknown} unrecognized inbox asset name(s) left for a human")
    return sources


def parse_uploader(field: str) -> Uploader | None:
    """Parses the Worker's uploader stamp `<discordId>-<hex of the UTF-8
    username>`; None for anything else."""
    m = re.fullmatch(r"(\d+)-((?:[0-9a-f]{2})+)", field)
    if not m:
        return None
    try:
        username = bytes.fromhex(m.group(2)).decode("utf-8")
    except UnicodeDecodeError:
        return None
    return Uploader(m.group(1), username) if username else None


def parse_inbox_name(name: str) -> dict | None:
    """Parses an inbox asset name; None when it matches neither shape or
    carries no valid uploader stamp."""
    parts = name.split("__")
    if len(parts) < 3:
        return None
    uploader = parse_uploader(parts[0])
    if uploader is None:
        return None
    if len(parts) == 3 and parts[2].lower() == MANIFEST_PART:
        return {"kind": "manifest", "uploader": uploader, "upload_id": parts[1]}
    if len(parts) == 3 and parts[2].lower() == METADATA_PART:
        return {"kind": "metadata", "uploader": uploader, "upload_id": parts[1]}
    if len(parts) == 3 and parts[2].lower().endswith(".zip"):
        return {"kind": "zip", "uploader": uploader, "name": name}
    if (len(parts) == 5 and re.fullmatch(r"f\d+", parts[2])
            and re.fullmatch(r"p\d+of\d+", parts[3])):
        return {"kind": "part", "uploader": uploader, "upload_id": parts[1],
                "file_idx": int(parts[2][1:]),
                "part_idx": int(parts[3][1:].split("of")[0]),
                "part_count": int(parts[3].split("of")[1]),
                "filename": parts[4]}
    return None


def make_package_zip(files: dict, dest: pathlib.Path) -> None:
    """Zips a raw file set into one package (deterministic member order,
    .pak/.ucas/.utoc first, same compression as the example packages)."""
    order = {".pak": 0, ".ucas": 1, ".utoc": 2, ".sig": 3}

    def rank(n: str) -> tuple:
        return (order.get(_split(n)[1], 4), n)

    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for n in sorted(files, key=rank):
            z.writestr(n, files[n])


def zip_members(blob: bytes) -> dict:
    """The package's set members of a zip (name -> bytes), by the package-shape
    rule; anything else in the zip is left behind."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        raise PackageError("not a valid zip file") from None
    with zf:
        verdict, _, chosen = classify_members(zf.namelist())
        problem = shape_error(verdict)
        if problem:
            raise PackageError(problem)
        return {name: zf.read(name) for name in chosen.values()}


def utoc_member(members: dict) -> str:
    """The name of the set's .utoc member."""
    return next(n for n in members if _split(n)[1] == ".utoc")


def set_members(data: dict) -> dict:
    """The package members of a reassembled upload set: the loose
    .utoc/.ucas/.pak(/.sig) files, or the set members of exactly one .zip
    (anything else in it is dropped)."""
    check_member_names(list(data))
    zips = [n for n in data if n.lower().endswith(".zip")]
    if zips:
        if len(data) != 1:
            raise PackageError("a .zip upload must be the only file in the set")
        return zip_members(data[zips[0]])
    verdict, _ = classify_raw(list(data))
    if verdict != "ok":
        raise PackageError(f"not one complete .utoc/.ucas/.pak (+.sig) set: {verdict}")
    return dict(data)


def rejecting_source(client: PackageClient, uploader: Uploader, label: str,
                     items: list, reason: str) -> PackageSource:
    """A source whose loading fails with `reason` (the normal
    rejection path then deletes the whole group and logs it)."""
    def load() -> Staged:
        raise PackageError(reason)
    return PackageSource(uploader, load,
                         (lambda: [client.delete_asset(INBOX_TAG, a.name) for _, a in items]),
                         label)


def raw_group_source(client: PackageClient, uploader: Uploader, uid: str,
                     items: list, now: datetime) -> PackageSource | None:
    """Builds one PackageSource for a complete upload set, or None (wait)."""
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
    metadata_asset = next((a for i, a in items if i["kind"] == "metadata"), None)

    parts_by_file: dict[int, list] = {}
    for i, a in items:
        if i["kind"] == "part":
            parts_by_file.setdefault(i["file_idx"], []).append((i, a))

    try:
        manifest = json.loads(client.asset_bytes(INBOX_TAG, manifest_asset.name))
        if not isinstance(manifest, dict):
            raise ValueError("not a JSON object")
    except Exception as ex:
        return rejecting_source(client, uploader, label, items, f"manifest is not valid JSON: {ex}")

    declared = manifest.get("metadata")
    if declared is not None and not isinstance(declared, dict):
        return rejecting_source(client, uploader, label, items, 'manifest "metadata" must be an object')
    files = manifest.get("files", [])
    if not files:
        print(f"  {label}: manifest has no files, waiting")
        return None
    if declared is not None and metadata_asset is None:
        print(f"  {label}: metadata.json missing, waiting")
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

    def load() -> Staged:
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
        if len(files) != len(data):
            raise PackageError("duplicate file names in the upload")
        metadata = None
        if declared is not None:
            raw = client.asset_bytes(INBOX_TAG, metadata_asset.name)
            want = declared.get("sha256")
            if want and hashlib.sha256(raw).hexdigest() != want:
                raise PackageError("metadata.json: sha256 mismatch")
            metadata = parse_upload_metadata(raw)
        return Staged(set_members(data), metadata)

    def delete() -> None:
        for _, a in items:
            client.delete_asset(INBOX_TAG, a.name)

    return PackageSource(uploader, load, delete, label)


class Target(NamedTuple):
    """Which mod an upload goes to: its identifier (minted or locked), the
    existing catalog entry (None = a new mod) and its owner's Discord id."""
    identifier: str
    entry: dict | None
    owner: str


class Processor:
    """Drains inbox items, re-homes valid ones, and merges into the catalog."""

    def __init__(self, client: PackageClient, owner: str, repo: str,
                 admins: set[str], catalog_path: pathlib.Path,
                 config_path: pathlib.Path = CONFIG_DEFAULT):
        self.client = client
        self.owner = owner
        self.repo = repo
        self.admins = admins
        self.catalog_path = catalog_path
        self.config_path = config_path
        self._content: dict[str, str | None] = {}  # entry file URL -> content_hash

    def _is_admin(self, uid: str) -> bool:
        return uid in self.admins

    # -- new mod or update ---------------------------------------------
    def _target(self, staged: Staged, fields: dict, existing: dict | None,
                uid: str, entries: dict) -> Target:
        """Resolves new mod vs update (mod-contract/upload.md):

          * metadata.json `identifier` -> an update of that mod: it must exist
            (case-insensitive) and be the uploader's (admins bypass);
          * metadata.json without it -> a new mod, identifier minted;
          * no metadata.json -> an update when the package's trailer
            identifier starts with `{uid}.` and that mod exists, else new.

        A new mod whose minted identifier already exists is rejected. Raises
        PackageError with the reason."""
        if staged.metadata is not None and staged.metadata.get("target"):
            wanted = staged.metadata["target"]
            entry = entries.get(ident_key(wanted))
            if entry is None:
                raise PackageError(f"update of {wanted!r}: no mod with that identifier in the catalog")
            owner = entry.get("uploader")
            if owner != uid and not self._is_admin(uid):
                raise PackageError(f"update of {entry['id']!r}: the mod belongs to {owner}; uploader {uid} rejected")
            return Target(entry["id"], entry, owner)
        if staged.metadata is None and existing is not None \
                and uploader_from_identifier(existing["identifier"]) == uid:
            entry = entries.get(ident_key(existing["identifier"]))
            if entry is not None and entry.get("uploader") == uid:
                return Target(entry["id"], entry, uid)
        identifier = mint_identifier(uid, fields["title"])
        taken = entries.get(ident_key(identifier))
        if taken is not None:
            raise PackageError(f"you already have a mod with the identifier {taken['id']!r}; "
                               "choose Update to upload a new version of it")
        return Target(identifier, None, uid)

    def _current_cover(self, entry: dict) -> dict | None:
        """The mod's current cover image (downloaded from its release), for
        an update that brings none; None when it has none or it cannot be read."""
        url = entry.get("cover")
        if not url:
            return None
        name = url.rsplit("/", 1)[-1]
        mime = next((m for m, ext in IMAGE_EXT.items() if name.lower().endswith(ext)), None)
        if mime is None:
            return None
        try:
            return {"mime": mime, "data": self.client.asset_bytes(mod_tag(entry["id"]), name)}
        except Exception as ex:
            print(f"  note: cannot reuse {entry['id']}'s cover {name} ({ex})")
            return None

    # -- one item -------------------------------------------------------
    def _process_item(self, src: PackageSource, entries: dict,
                      now: datetime) -> tuple[bool, str]:
        uploader = src.uploader
        try:
            staged = src.load()
            utoc_name = utoc_member(staged.members)
            existing = existing_trailer(staged.members[utoc_name])
            fields = package_fields(staged.metadata, existing)
            # `entries` is live: an earlier item of this same run counts too
            target = self._target(staged, fields, existing, uploader.uid, entries)
        except PackageError as ex:
            src.delete()
            return False, f"invalid package: {ex}"

        # an admin updating someone else's mod: the entry stays under its
        # owner, and the stored package carries the owner's (catalog) name
        author = uploader.username if target.owner == uploader.uid else target.entry["author"]
        members = dict(staged.members)
        with tempfile.TemporaryDirectory() as td:
            tmp = pathlib.Path(td) / "package.zip"
            try:
                members[utoc_name] = apply_metadata(
                    members[utoc_name], staged.metadata, existing, author=author,
                    identifier=target.identifier,
                    fallback_cover=(lambda: self._current_cover(target.entry)) if target.entry else None)
                make_package_zip(members, tmp)
                meta = validate_package(tmp)
            except PackageError as ex:
                src.delete()
                return False, f"invalid package: {ex}"

            # the same content + title + version under ANOTHER identifier is a
            # duplicate of that mod, whoever uploads it
            content = content_hash(members)
            dup = self._duplicate_of(meta, content, entries)
            if dup is not None:
                src.delete()
                return False, (f"duplicate of the existing mod {dup['name']!r} v{dup['version']} "
                               f"(id {dup['id']}): same content, title and version under another identifier")

            tag = mod_tag(target.identifier)
            existing_rel = self.client.get_release(tag)
            taken = {a.name for a in existing_rel.assets} if existing_rel else set()
            base_name = mod_asset_name(meta)
            if base_name in taken:
                # a re-upload of this version: accepted unless nothing changed
                stored = package_fingerprint(members)
                for other in same_version_names(base_name, taken):
                    other_path = pathlib.Path(td) / f"existing-{other}"
                    self.client.download_asset(tag, other, other_path)
                    try:
                        same = zip_fingerprint(other_path) == stored
                    except PackageError:
                        same = False
                    other_path.unlink()
                    if same:
                        src.delete()
                        return False, f"already uploaded as {other}, nothing changed"
            zip_name = free_asset_name(base_name, taken)

            if existing_rel is None:
                self.client.create_release(tag, meta["title"])

            # upload the zip (under a name no asset has: never overwrite)
            staged_zip = pathlib.Path(td) / zip_name
            shutil.copyfile(tmp, staged_zip)
            try:
                self.client.upload_asset(tag, staged_zip, zip_name)
            except AssetExists:
                src.delete()
                return False, f"asset name {zip_name} was taken meanwhile; upload again"

            # cover (dedup: skip an identical one, never overwrite a different one)
            image = meta.get("image")
            if image is not None:
                _, cname = cover_name(image)
                rel = self.client.get_release(tag)
                names = {a.name for a in rel.assets} if rel else set()
                if cname in names:
                    if self.client.asset_bytes(tag, cname) != image["data"]:
                        src.delete()
                        return False, f"cover name collision with different content: {cname}"
                else:
                    cover_path = pathlib.Path(td) / cname
                    cover_path.write_bytes(image["data"])
                    self.client.upload_asset(tag, cover_path, cname)

            sha = hashlib.sha256(tmp.read_bytes()).hexdigest()
            src.delete()  # always: success or failure

            entry = entry_from_meta(
                meta, file_url=asset_url(self.owner, self.repo, tag, zip_name),
                size=tmp.stat().st_size, sha256=sha, uploader=target.owner, updated=_iso(now),
                cover_url=asset_url(self.owner, self.repo, tag, cname) if image is not None else None)
            self._content[entry["file"]] = content
            return True, entry

    # -- duplicates under another identifier ---------------------------
    def _entry_content(self, entry: dict) -> str | None:
        """`content_hash` of a catalog entry's current zip (downloaded through
        the client at most once per run; None when it cannot be read)."""
        url = entry.get("file") or ""
        if url not in self._content:
            name = url.rsplit("/", 1)[-1]
            try:
                with tempfile.TemporaryDirectory() as td:
                    path = pathlib.Path(td) / "existing.zip"
                    self.client.download_asset(mod_tag(entry["id"]), name, path)
                    self._content[url] = zip_content_hash(path)
            except Exception as ex:
                print(f"  note: cannot read {entry['id']}'s {name} for the duplicate check ({ex})")
                self._content[url] = None
        return self._content[url]

    def _duplicate_of(self, meta: dict, content: str, entries: dict) -> dict | None:
        """The catalog entry under another identifier whose current package
        has the same title (trimmed, case-insensitive), version (trimmed) and
        content (`content_hash`, trailer ignored) as `meta`'s package, else
        None. Only entries matching title + version are downloaded. `entries`
        is live, so an earlier upload of this same run counts too."""
        title, version = norm_title(meta["title"]), meta["version"].strip()
        mine = ident_key(meta["identifier"])
        for key, e in sorted(entries.items()):
            if (key != mine and norm_title(e.get("name")) == title
                    and (e.get("version") or "").strip() == version
                    and self._entry_content(e) == content):
                return e
        return None

    def run(self, sources: list[PackageSource]) -> dict:
        # Make sure the inbox release exists so the Worker never 503s after
        # the first run (nobody has to create it by hand).
        if self.client.get_release(INBOX_TAG) is None:
            self.client.create_release(INBOX_TAG, "Inbox")
        _, old_entries = load_catalog(self.catalog_path)
        entries = {k: dict(m) for k, m in old_entries.items()}
        ok = rejected = 0
        for src in sources:
            try:
                success, result = self._process_item(src, entries,
                                                   datetime.now(timezone.utc))
            except Exception as ex:  # a client hiccup must not strand the rest
                src.delete()
                success, result = False, f"error: {ex}"
            if success:
                entries[ident_key(result["id"])] = result
                for entry in entries.values():
                    if entry.get("uploader") == src.uploader.uid:
                        entry["author"] = src.uploader.username  # a rename follows the owner's uploads
                ok += 1
                print(f"  ok {src.label}: {result['name']} v{result['version']} "
                      f"(id {result['id']}, owner {result['uploader']})")
            else:
                rejected += 1
                print(f"  REJECTED {src.label}: {result}", file=sys.stderr)
        if ok:
            write_catalog(self.catalog_path, list(entries.values()), self.config_path)
            print(f"\n{self.catalog_path.name}: catalog written ({ok} new/updated, {rejected} rejected)")
        else:
            print(f"\nnothing processed ({rejected} rejected); catalog left unchanged")
        return {"ok": ok, "rejected": rejected}


# --------------------------------------------------------------- rebuild


def rebuild(client: PackageClient, owner: str, repo: str, catalog_path: pathlib.Path,
            config_path: pathlib.Path = CONFIG_DEFAULT) -> dict:
    """Regenerates the whole catalog from the mod-* releases alone.

    One release per mod identifier (`mod_tag`). Only the runner writes into
    `mod-*` releases, so every package's trailer carries its mod's locked
    `identifier` (`{ownerId}.…`) and its `author` is the verified name it was
    stored with. Per release:

      * the packages whose identifier maps to the release's tag count
        (others are skipped with a log line), ordered by `asset_order_key`;
      * identifier = the earliest package's (locked), owner (`uploader`) =
        the uploader of that earliest package = its identifier's id prefix;
      * the entry points at the newest package (skipped when that is invalid);
      * `author` = the author of the most recent package, in any release,
        under the owner's id (a rename follows the owner's uploads; an
        admin's update of the mod carries the owner's name);
      * duplicates: mods whose newest packages share title + version +
        `content_hash` keep only the one whose first package was uploaded
        earliest -- `process`'s duplicate rule.
    """
    candidates = []  # (meta, asset, sha256, cover_url, owner uid, tag, content_hash, first-upload key)
    latest_by_uid: dict[str, tuple] = {}  # uid -> ((created, name), author)
    for tag in client.list_tags(MOD_TAG_PREFIX):
        rel = client.get_release(tag)
        if rel is None:
            continue
        zips = sorted((a for a in rel.assets if a.name.lower().endswith(".zip")),
                      key=asset_order_key)
        if not zips:
            print(f"  {tag}: no zip assets, skipped")
            continue
        packages = []  # (asset, meta, uid, sha256, content_hash) of the valid packages, oldest first
        for asset in zips:
            with tempfile.TemporaryDirectory() as td:
                tmp = pathlib.Path(td) / asset.name
                client.download_asset(tag, asset.name, tmp)
                try:
                    meta = validate_package(tmp)
                    content = zip_content_hash(tmp)
                except PackageError as ex:
                    print(f"  {tag}: {asset.name} REJECTED {ex}", file=sys.stderr)
                    continue
                uid = uploader_from_identifier(meta["identifier"])
                if uid is None:
                    print(f"  {tag}: {asset.name}: identifier {meta['identifier']!r} carries no uploader id "
                          "(not written by this catalog), skipped", file=sys.stderr)
                    continue
                if mod_tag(meta["identifier"]) != tag:
                    print(f"  {tag}: {asset.name}: identifier {meta['identifier']!r} belongs to another "
                          "release, skipped", file=sys.stderr)
                    continue
                packages.append((asset, meta, uid, hashlib.sha256(tmp.read_bytes()).hexdigest(),
                                 content))
        if not packages or packages[-1][0] is not zips[-1]:
            print(f"  {tag}: the newest package is invalid, skipped", file=sys.stderr)
            continue
        for asset, meta, uid, *_ in packages:
            stamp = (asset.created, asset.name)
            if uid not in latest_by_uid or stamp > latest_by_uid[uid][0]:
                latest_by_uid[uid] = (stamp, meta["author"])
        identifier = packages[0][1]["identifier"]
        asset, meta, _, sha, content = packages[-1]
        cover_url = None
        image = meta.get("image")
        if image is not None:
            _, cname = cover_name(image)
            if any(a.name == cname for a in rel.assets):
                cover_url = asset_url(owner, repo, tag, cname)
            else:
                print(f"  {tag}: cover {cname} missing from the release, omitted")
        candidates.append(({**meta, "identifier": identifier}, asset, sha, cover_url, packages[0][2], tag,
                           content, asset_order_key(packages[0][0]) + (tag,)))

    # the same content + title + version under several identifiers: the mod
    # whose first package is the earliest wins, the later ones are skipped
    kept: dict[tuple, str] = {}
    entries = []
    for meta, asset, sha, cover_url, owner_uid, tag, content, _ in sorted(candidates, key=lambda c: c[7]):
        key = (norm_title(meta["title"]), meta["version"].strip(), content)
        if key in kept:
            print(f"  {tag}: duplicate of {kept[key]} (same content, title and version), skipped",
                  file=sys.stderr)
            continue
        kept[key] = tag
        entries.append(entry_from_meta(
            {**meta, "author": latest_by_uid[owner_uid][1]},
            file_url=asset_url(owner, repo, tag, asset.name), size=asset.size, sha256=sha,
            uploader=owner_uid, updated=_iso(asset.created), cover_url=cover_url))
    write_catalog(catalog_path, entries, config_path)
    print(f"\n{catalog_path.name}: {len(entries)} mod(s) rebuilt")
    return {"ok": len(entries)}


def retitle(catalog_path: pathlib.Path, config_path: pathlib.Path = CONFIG_DEFAULT) -> None:
    """Sets only the catalog's name/description from the site config; every
    other field is kept as it is."""
    data, _ = load_catalog(catalog_path)
    name, description = load_catalog_identity(config_path)
    catalog = {"schemaVersion": data.get("schemaVersion", CATALOG_SCHEMA_VERSION),
               "name": name, "description": description}
    catalog.update({k: v for k, v in data.items() if k not in catalog})
    dump_catalog(catalog_path, catalog)
    print(f"{catalog_path.name}: catalog name set to {name!r}")


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
        p.add_argument("--config", default=str(CONFIG_DEFAULT),
                       help="site config whose `title`/`description` name the catalog")

    p = sub.add_parser("process", help="drain inbox items and merge into the catalog")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-inbox", action="store_true")
    src.add_argument("--from-dir", metavar="DIR",
                     help="seed the dir's zips as uploads by --as-uid/--as-username (both required)")
    p.add_argument("--as-uid", metavar="ID", help="Discord user id the seeded packages belong to")
    p.add_argument("--as-username", metavar="NAME", help="Discord username published as their author")
    common(p)

    p = sub.add_parser("rebuild", help="regenerate the whole catalog from mod-* releases")
    common(p)

    p = sub.add_parser("retitle", help="rewrite only the catalog's name/description from the site config")
    p.add_argument("--catalog", default=str(CATALOG_DEFAULT))
    p.add_argument("--config", default=str(CONFIG_DEFAULT))

    args = ap.parse_args(argv)
    config = pathlib.Path(args.config)
    if args.cmd == "retitle":
        retitle(pathlib.Path(args.catalog), config)
        return 0
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
        rebuild(client, owner, repo, catalog, config)
        return 0

    if args.from_dir:
        if not args.as_uid or not args.as_username:
            raise SystemExit("error: --from-dir needs --as-uid and --as-username: every package in the "
                             "catalog belongs to a verified Discord account")
        if not re.fullmatch(r"\d+", args.as_uid):
            raise SystemExit("error: --as-uid must be a Discord user id (digits)")
        d = pathlib.Path(args.from_dir).resolve()
        if not d.is_dir():
            raise SystemExit(f"error: {d} is not a directory")
        sources = inbox_items_from_dir(d, Uploader(args.as_uid, args.as_username))
        if not sources:
            raise SystemExit(f"error: no .zip packages found in {d}")
    else:
        if args.as_uid or args.as_username:
            raise SystemExit("error: --as-uid/--as-username only apply to --from-dir")
        if client.get_release(INBOX_TAG) is None:
            client.create_release(INBOX_TAG, "Inbox")
        sources = inbox_items_from_release(client)
        if not sources:
            print("inbox is empty; nothing to do")
            return 0

    Processor(client, owner, repo, admins, catalog, config).run(sources)
    return 0


if __name__ == "__main__":
    sys.exit(main())
