"""Offline tests for the build.py pipeline (LocalClient, synthetic packages).

Run: python -m unittest discover -s tests
"""

import base64
import contextlib
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import unittest
import zipfile
from datetime import datetime, timedelta, timezone

import build
import trailer

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEGACY = ROOT / "legacy-assets"
OWNER = "jordgubbarnab55-cloud"
REPO = "ModCatalog"
ADMIN = "999999"


def username_of(uid: str) -> str:
    """The test Discord username of a test user id."""
    return f"user{uid}"


def S(uid: str, username: str | None = None) -> str:
    """The Worker's uploader stamp for a test user: `<id>-<hex of the username>`."""
    return f"{uid}-{(username or username_of(uid)).encode('utf-8').hex()}"


def fake_toc() -> bytes:
    """A minimal valid UE 5.6 (v8) .utoc header with no sections: TocEnd = 144."""
    h = bytearray(trailer.TOC_HEADER_SIZE)
    h[0:16] = trailer.TOC_MAGIC
    h[0x10] = trailer.TOC_SUPPORTED_VERSION
    h[0x14:0x18] = trailer.TOC_HEADER_SIZE.to_bytes(4, "little")
    h[0x20:0x24] = trailer.TOC_BLOCK_ENTRY_SIZE.to_bytes(4, "little")
    return bytes(h)


def make_package(dest: pathlib.Path, title: str = "Test Mod", author: str = "Tester",
                 version: str = "1.0.0", description: str = "a test package",
                 guid: str | None = None, image: dict | None = None,
                 second_set: bool = False, include_ucas: bool = True, include_pak: bool = True,
                 no_trailer: bool = False, extra_members: list[str] | None = None,
                 corrupt: bool = False, tags: list[str] | None = None,
                 game_version: str = "", payload: str | None = None,
                 identifier: str | None = None) -> pathlib.Path:
    """Builds a synthetic package zip (fake utoc/ucas/pak bytes + a real trailer).
    The .ucas/.pak bytes derive from `payload` (default: the GUID). The trailer
    identifier defaults to the derived `Author.Title` (not catalog-written);
    pass `{uid}.Title` to make a zip-mode upload an update of that mod."""
    if guid is None:
        guid = str(uuid.uuid4())
    if corrupt:
        dest.write_bytes(b"\x00\x01\x02 not a zip at all " + uuid.uuid4().bytes * 4)
        return dest
    meta = {"title": title, "author": author, "description": description,
            "version": version, "guid": guid, "image": image, "tags": tags or [],
            "game_version": game_version, "identifier": identifier}
    content = (payload if payload is not None else guid).encode()
    utoc = fake_toc()
    if not no_trailer:
        utoc = trailer.write_trailer(utoc, meta)[0]
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        if include_pak:
            z.writestr("mod.pak", b"FAKE-PAK-" + content + b"\x00" * 1024)
        if include_ucas:
            z.writestr("mod.ucas", b"FAKE-UCAS-" + content + b"\x00" * 1024)
        z.writestr("mod.utoc", utoc)
        if second_set:
            for ext in (".utoc", ".ucas", ".pak"):
                z.writestr("other" + ext, b"second set")
        for name in extra_members or []:
            z.writestr(name, b"oops")
    return dest


def make_image(kind: str = "png") -> dict:
    if kind == "png":
        data = b"\x89PNG\r\n\x1a\n" + b"fake-png-body"
        mime = "image/png"
    else:
        data = b"\xff\xd8\xff" + b"fake-jpeg-body"
        mime = "image/jpeg"
    return {"mime": mime, "data": data}


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._tmp.name)
        self.catalog = self.root / "site" / "catalog.json"
        self.client = build.LocalClient(self.root)
        self.processor = build.Processor(self.client, OWNER, REPO, {ADMIN}, self.catalog)
        self.n = 0

    def tearDown(self):
        self._tmp.cleanup()

    def next_ts(self) -> str:
        self.n += 1
        return str(1000 + self.n)

    def to_inbox(self, zip_path: pathlib.Path, uploader: str,
                 filename: str | None = None) -> str:
        """Stages a package into the local "inbox" release; returns the asset name."""
        self.client.create_release(build.INBOX_TAG, "inbox")
        name = filename or f"{S(uploader)}__{self.next_ts()}__{zip_path.name}"
        self.client.upload_asset(build.INBOX_TAG, zip_path, name)
        return name

    def run_process(self) -> dict:
        return self.processor.run(build.inbox_items_from_release(self.client))

    def catalog_mods(self) -> dict:
        with self.catalog.open(encoding="utf-8") as f:
            data = json.load(f)
        return {m["id"]: m for m in data["mods"]}

    def inbox_names(self) -> list[str]:
        return [a.name for a in self.client.list_assets(build.INBOX_TAG)]

    def stored(self, identifier: str, name: str) -> tuple:
        """(member names, trailer metadata, .utoc bytes) of a stored package zip."""
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(build.mod_tag(identifier), name, z)
            with zipfile.ZipFile(z) as zf:
                names = zf.namelist()
                return names, build.validate_package(z), zf.read(next(n for n in names if n.endswith(".utoc")))


class TestGoodPackage(Base):
    def test_entry_fields_sha_and_urls(self):
        image = make_image("png")
        make_package(self.root / "a.zip", image=image)
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__A.zip")

        summary = self.run_process()
        self.assertEqual(summary, {"ok": 1, "rejected": 0})

        e = self.catalog_mods()["12345.TestMod"]  # the minted identifier is the id
        tag = build.mod_tag("12345.TestMod")
        self.assertRegex(tag, r"^mod-12345\.testmod-[0-9a-f]{8}$")
        # the stored package is rewritten (forced author/identifier), so its hash is the stored one
        with tempfile.TemporaryDirectory() as td:
            stored = pathlib.Path(td) / "s.zip"
            self.client.download_asset(tag, "Test-Mod-1.0.0.zip", stored)
            sha = hashlib.sha256(stored.read_bytes()).hexdigest()
            self.assertEqual(e["size"], stored.stat().st_size)
        self.assertEqual(e["name"], "Test Mod")
        self.assertEqual(e["author"], "user12345")
        self.assertEqual(e["version"], "1.0.0")
        self.assertEqual(e["description"], "a test package")
        self.assertEqual(e["sha256"], sha)
        self.assertEqual(e["uploader"], "12345")
        self.assertRegex(e["updated"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(e["file"],
                         f"https://github.com/{OWNER}/{REPO}/releases/download/{tag}/Test-Mod-1.0.0.zip")
        self.assertTrue(e["file"].startswith("https://github.com/"))
        self.assertIn(f"cover-{hashlib.sha256(image['data']).hexdigest()[:8]}.png", e["cover"])
        self.assertIn(f"releases/download/{tag}/", e["cover"])

        # inbox drained, re-homed assets present
        self.assertEqual(self.inbox_names(), [])
        names = {a.name for a in self.client.list_assets(tag)}
        self.assertIn("Test-Mod-1.0.0.zip", names)
        self.assertIn(f"cover-{hashlib.sha256(image['data']).hexdigest()[:8]}.png", names)

    def test_no_cover_omits_field(self):
        make_package(self.root / "a.zip")
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__A.zip")
        self.run_process()
        self.assertNotIn("cover", self.catalog_mods()["12345.TestMod"])


class TestRejections(Base):
    def _bad_set(self) -> None:
        """One run: six different kinds of bad packages plus one good one."""
        good = self.root / "good.zip"
        make_package(good, title="Good Mod")
        self.to_inbox(good, "12345", f"{S('12345')}__1__good.zip")

        make_package(self.root / "corrupt.zip", corrupt=True)
        self.to_inbox(self.root / "corrupt.zip", "12345", f"{S('12345')}__2__corrupt.zip")
        make_package(self.root / "notrail.zip", no_trailer=True)
        self.to_inbox(self.root / "notrail.zip", "12345", f"{S('12345')}__3__notrail.zip")
        make_package(self.root / "two-sets.zip", second_set=True)
        self.to_inbox(self.root / "two-sets.zip", "12345", f"{S('12345')}__4__two-sets.zip")
        make_package(self.root / "noupak.zip", include_pak=False)
        self.to_inbox(self.root / "noupak.zip", "12345", f"{S('12345')}__5__noupak.zip")
        make_package(self.root / "noucas.zip", include_ucas=False)
        self.to_inbox(self.root / "noucas.zip", "12345", f"{S('12345')}__6__noucas.zip")
        make_package(self.root / "traversal.zip", extra_members=["../evil.txt"])
        self.to_inbox(self.root / "traversal.zip", "12345", f"{S('12345')}__7__traversal.zip")

    def test_all_rejected_good_survives(self):
        self._bad_set()
        summary = self.run_process()
        self.assertEqual(summary["rejected"], 6)
        self.assertEqual(summary["ok"], 1)
        mods = self.catalog_mods()
        self.assertEqual(len(mods), 1)
        self.assertEqual(list(mods.values())[0]["name"], "Good Mod")
        self.assertEqual(self.inbox_names(), [])  # all inbox assets deleted

    def test_rejections_do_not_block(self):
        # a bad package first must not stop the good one later in the same run
        make_package(self.root / "corrupt.zip", corrupt=True)
        self.to_inbox(self.root / "corrupt.zip", "12345", f"{S('12345')}__1__corrupt.zip")
        good = self.root / "good.zip"
        make_package(good, title="Good Mod")
        self.to_inbox(good, "12345", f"{S('12345')}__2__good.zip")
        self.assertEqual(self.run_process()["ok"], 1)


class TestVersions(Base):
    def test_identical_reupload_rejected_new_version_wins(self):
        guid, ident = str(uuid.uuid4()), "12345.VerMod"
        make_package(self.root / "v1.zip", title="Ver Mod", version="1.0.0", guid=guid)
        self.to_inbox(self.root / "v1.zip", "12345", f"{S('12345')}__1__v1.zip")
        self.run_process()

        # same identifier + version + bytes -> "nothing changed", original stays
        # (the fresh GUID the runner writes does not count)
        make_package(self.root / "v1b.zip", title="Ver Mod", version="1.0.0", guid=guid, identifier=ident)
        self.to_inbox(self.root / "v1b.zip", "12345", f"{S('12345')}__2__v1b.zip")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        tag = build.mod_tag(ident)
        names = {a.name for a in self.client.list_assets(tag)}
        self.assertEqual(names, {"Ver-Mod-1.0.0.zip"})
        self.assertEqual(self.inbox_names(), [])

        # a new version becomes the main entry; the old asset stays
        make_package(self.root / "v2.zip", title="Ver Mod", version="1.1.0", guid=guid, identifier=ident)
        self.to_inbox(self.root / "v2.zip", "12345", f"{S('12345')}__3__v2.zip")
        self.run_process()
        e = self.catalog_mods()[ident]
        self.assertEqual(e["version"], "1.1.0")
        self.assertTrue(e["file"].endswith("Ver-Mod-1.1.0.zip"))
        names = {a.name for a in self.client.list_assets(tag)}
        self.assertIn("Ver-Mod-1.0.0.zip", names)
        self.assertIn("Ver-Mod-1.1.0.zip", names)


class TestDuplicateRules(Base):
    """Re-uploads of a version, and the same mod under another identifier."""

    def up(self, uid: str, label: str, **kw) -> str:
        make_package(self.root / f"{label}.zip", **kw)
        return self.to_inbox(self.root / f"{label}.zip", uid,
                             f"{S(uid)}__{self.next_ts()}__{label}.zip")

    def assets(self, identifier: str) -> set[str]:
        return {a.name for a in self.client.list_assets(build.mod_tag(identifier))}

    def rejection(self) -> tuple[dict, str]:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            summary = self.run_process()
        return summary, err.getvalue()

    # 1
    def test_same_content_bumped_version_same_mod_is_an_update(self):
        self.up("111", "a", title="Upd", version="1.0", payload="P")
        self.run_process()
        self.up("111", "b", title="Upd", version="1.1", payload="P", identifier="111.Upd")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.assets("111.Upd"), {"Upd-1.0.zip", "Upd-1.1.zip"})
        self.assertTrue(self.catalog_mods()["111.Upd"]["file"].endswith("/Upd-1.1.zip"))

    # 2
    def test_same_version_new_content_is_stored_under_a_suffix(self):
        ident = "111.ReMod"
        self.up("111", "a", title="Re Mod", version="1.0", payload="A")
        self.run_process()
        tag = build.mod_tag(ident)
        first = self.client.asset_bytes(tag, "Re-Mod-1.0.zip")
        self.up("111", "b", title="Re Mod", version="1.0", payload="B", identifier=ident,
                game_version="5.6")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.up("111", "c", title="Re Mod", version="1.0", payload="C", identifier=ident)
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.assets(ident), {"Re-Mod-1.0.zip", "Re-Mod-1.0-2.zip", "Re-Mod-1.0-3.zip"})
        self.assertEqual(self.client.asset_bytes(tag, "Re-Mod-1.0.zip"), first)  # never overwritten
        e = self.catalog_mods()[ident]
        self.assertTrue(e["file"].endswith("/Re-Mod-1.0-3.zip"))
        self.assertEqual(e["sha256"], hashlib.sha256(
            self.client.asset_bytes(tag, "Re-Mod-1.0-3.zip")).hexdigest())

        # rebuild picks the newest (suffixed) upload too
        live = json.loads(self.catalog.read_text(encoding="utf-8"))
        self.catalog.unlink()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        rebuilt = json.loads(self.catalog.read_text(encoding="utf-8"))
        for doc in (live, rebuilt):
            for m in doc["mods"]:
                m.pop("updated")
        self.assertEqual(rebuilt, live)

    def test_identical_reupload_of_a_suffixed_version_is_rejected(self):
        ident = "111.ReMod"
        self.up("111", "a", title="Re Mod", version="1.0", payload="A", identifier=ident)
        self.up("111", "b", title="Re Mod", version="1.0", payload="B", identifier=ident)
        self.assertEqual(self.run_process(), {"ok": 2, "rejected": 0})  # same run works too
        before = self.catalog.read_bytes()
        for label, payload in (("c", "B"), ("d", "A")):
            self.up("111", label, title="Re Mod", version="1.0", payload=payload, identifier=ident)
            summary, err = self.rejection()
            self.assertEqual(summary, {"ok": 0, "rejected": 1})
            self.assertIn("nothing changed", err)
        self.assertEqual(self.assets(ident), {"Re-Mod-1.0.zip", "Re-Mod-1.0-2.zip"})
        self.assertEqual(self.inbox_names(), [])
        self.assertEqual(self.catalog.read_bytes(), before)

    def test_same_bytes_with_a_different_trailer_is_a_change(self):
        self.up("111", "a", title="Re Mod", version="1.0", payload="A")
        self.run_process()
        self.up("111", "b", title="Re Mod", version="1.0", payload="A", identifier="111.ReMod",
                description="better words")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()["111.ReMod"]["description"], "better words")

    # 3
    def test_same_content_title_version_under_another_identifier_is_rejected(self):
        self.up("111", "a", title="Dup Mod", version="1.0", payload="X")
        self.run_process()
        before = self.catalog.read_bytes()
        for uid, title in (("222", "  dup MOD "), (ADMIN, "DUP MOD")):
            self.up(uid, f"dup{uid}", title=title, version=" 1.0 ", payload="X",
                    description="other words", author="someone")
            summary, err = self.rejection()
            self.assertEqual(summary, {"ok": 0, "rejected": 1}, uid)
            self.assertIn("duplicate of the existing mod 'Dup Mod' v1.0 (id 111.DupMod)", err)
            self.assertEqual(self.client.list_tags(build.MOD_TAG_PREFIX), [build.mod_tag("111.DupMod")])
        # the owner's own re-upload as a NEW mod collides with the identifier first
        self.up("111", "again", title="dup mod", version="1.0", payload="X")
        summary, err = self.rejection()
        self.assertEqual(summary, {"ok": 0, "rejected": 1})
        self.assertIn("you already have a mod with the identifier '111.DupMod'", err)
        self.assertEqual(self.inbox_names(), [])
        self.assertEqual(self.catalog.read_bytes(), before)

    def test_duplicates_in_the_same_run(self):
        self.up("111", "a", title="Dup Mod", version="1.0", payload="X")
        self.up("222", "b", title="Dup Mod", version="1.0", payload="X")
        self.up("333", "c", title="Other")
        self.assertEqual(self.run_process(), {"ok": 2, "rejected": 1})
        self.assertEqual(set(self.catalog_mods()), {"111.DupMod", "333.Other"})
        self.assertEqual(self.inbox_names(), [])

    def test_a_different_title_or_version_is_a_new_mod(self):
        self.up("111", "a", title="Base", version="1.0", payload="X")
        self.up("111", "b", title="Base 2", version="1.0", payload="X")
        self.up("222", "c", title="Base", version="1.1", payload="X")
        self.assertEqual(self.run_process(), {"ok": 3, "rejected": 0})
        self.assertEqual(set(self.catalog_mods()), {"111.Base", "111.Base2", "222.Base"})

    def test_different_content_same_title_version_is_a_new_mod(self):
        self.up("111", "a", title="Base", version="1.0", payload="X")
        self.up("222", "b", title="Base", version="1.0", payload="Y")
        self.assertEqual(self.run_process(), {"ok": 2, "rejected": 0})

    def test_only_the_current_version_counts(self):
        self.up("111", "a", title="Base", version="1.0", payload="X")
        self.up("111", "b", title="Base", version="2.0", payload="Z", identifier="111.Base")
        self.run_process()
        self.up("222", "c", title="Base", version="1.0", payload="X")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})

    def test_rebuild_keeps_the_earliest_of_duplicate_mods(self):
        self.up("111", "a", title="Dup Mod", version="1.0", payload="X")
        self.run_process()
        live = json.loads(self.catalog.read_text(encoding="utf-8"))
        self.catalog.unlink()  # forget 111.DupMod: the catalog is gone, so the duplicate check has nothing to match and the mod is stored
        self.up("222", "b", title="dup mod", version="1.0", payload="X")
        self.run_process()
        self.assertIsNotNone(self.client.get_release(build.mod_tag("222.dupmod")))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertIn(f"{build.mod_tag('222.dupmod')}: duplicate of {build.mod_tag('111.DupMod')}",
                      err.getvalue())
        rebuilt = json.loads(self.catalog.read_text(encoding="utf-8"))
        for doc in (live, rebuilt):
            for m in doc["mods"]:
                m.pop("updated")
        self.assertEqual(rebuilt, live)

    def test_content_hash_and_fingerprint(self):
        utoc = fake_toc()
        meta = {"title": "T", "author": "A", "description": "", "version": "1", "game_version": "",
                "tags": [], "guid": None, "image": None, "identifier": "1.T"}
        a = {"x.utoc": utoc, "x.ucas": b"U", "x.pak": b"P"}
        b = {"y.pak": b"P", "y.ucas": b"U", "y.utoc": trailer.write_trailer(utoc, meta)[0]}
        self.assertEqual(build.content_hash(a), build.content_hash(b))  # trailer and names ignored
        self.assertNotEqual(build.content_hash(a), build.content_hash({**a, "x.sig": b"S"}))
        self.assertNotEqual(build.content_hash(a), build.content_hash({**a, "x.pak": b"Q"}))
        # the fingerprint ("the same stored package") counts the trailer but not its guid
        self.assertNotEqual(build.package_fingerprint(a), build.package_fingerprint(b))
        c = {**b, "y.utoc": trailer.write_trailer(utoc, {**meta, "guid": str(uuid.uuid4())})[0]}
        self.assertNotEqual(trailer.read_trailer(b["y.utoc"])["guid"], trailer.read_trailer(c["y.utoc"])["guid"])
        self.assertEqual(build.package_fingerprint(b), build.package_fingerprint(c))
        d = {**b, "y.utoc": trailer.write_trailer(utoc, {**meta, "description": "x"})[0]}
        self.assertNotEqual(build.package_fingerprint(b), build.package_fingerprint(d))

    def test_suffix_helpers(self):
        self.assertEqual(build.free_asset_name("M-1.0.zip", set()), "M-1.0.zip")
        self.assertEqual(build.free_asset_name("M-1.0.zip", {"M-1.0.zip", "M-1.0-2.zip"}), "M-1.0-3.zip")
        self.assertEqual(build.same_version_names("M-1.0.zip", ["M-1.0.zip", "M-1.0-2.zip", "M-1.0.1.zip",
                                                                "M-1.0-x.zip", "M-1.zip"]),
                         ["M-1.0-2.zip", "M-1.0.zip"])
        t = build.datetime(2026, 1, 1, tzinfo=build.timezone.utc)
        older = [build.Asset("M-1.0-10.zip", 1, t), build.Asset("M-1.0-9.zip", 1, t),
                 build.Asset("M-1.0.zip", 1, t)]
        self.assertEqual([a.name for a in sorted(older, key=build.asset_order_key)],
                         ["M-1.0.zip", "M-1.0-9.zip", "M-1.0-10.zip"])


class TestIdentity(Base):
    """The identifier is the mod's permanent identity (minted, then locked);
    the GUID is a per-upload revision id."""

    def set_upload(self, uid: str, upload_id: str, metadata: dict | None = None,
                   utoc: bytes | None = None, payload: bytes = b"PAK", username: str | None = None) -> None:
        """A loose set in the inbox: the parts, then the manifest (with the
        optional `metadata` object) last."""
        self.client.create_release(build.INBOX_TAG, "inbox")
        d = self.client._release_dir(build.INBOX_TAG)
        files = [("mod.pak", payload), ("mod.ucas", b"UCAS"), ("mod.utoc", utoc or fake_toc())]
        manifest: dict = {"files": [{"name": n, "sha256": hashlib.sha256(b).hexdigest(), "parts": 1}
                                    for n, b in files]}
        if metadata is not None:
            manifest["metadata"] = metadata
        stamp = S(uid, username)
        for idx, (n, b) in enumerate(files):
            (d / f"{stamp}__{upload_id}__f{idx}__p0of1__{n}").write_bytes(b)
        (d / f"{stamp}__{upload_id}__manifest.json").write_bytes(json.dumps(manifest).encode("utf-8"))

    @staticmethod
    def meta(title: str = "Cool Mod", version: str = "1.0", **over) -> dict:
        m = {"title": title, "author": "whoever", "description": "d", "version": version,
             "game_version": "", "tags": []}
        m.update(over)
        return m

    def rejection(self) -> tuple[dict, str]:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            summary = self.run_process()
        return summary, err.getvalue()

    def zips(self, identifier: str) -> list[str]:
        return sorted(a.name for a in self.client.list_assets(build.mod_tag(identifier))
                      if a.name.endswith(".zip"))

    def test_mod_tag_slug(self):
        h = lambda s: hashlib.sha256(s.lower().encode("utf-8")).hexdigest()[:8]
        self.assertEqual(build.mod_tag("123.CoolMod"), f"mod-123.coolmod-{h('123.coolmod')}")
        self.assertEqual(build.mod_tag("123.COOLMOD"), build.mod_tag("123.CoolMod"))  # case-insensitive
        self.assertEqual(build.mod_tag("1.a..b/c?d"), f"mod-1.a.b-c-d-{h('1.a..b/c?d')}")
        self.assertEqual(build.mod_tag("1.Ünï"), f"mod-1.-n-{h('1.ünï')}")
        self.assertEqual(build.mod_tag("1.日本"), f"mod-1-{h('1.日本')}")
        self.assertEqual(build.mod_tag("...--"), f"mod-{h('...--')}")
        # same slug, different identifiers -> different tags
        self.assertEqual(build.mod_tag("1.a!b").rsplit("-", 1)[0], build.mod_tag("1.a?b").rsplit("-", 1)[0])
        self.assertNotEqual(build.mod_tag("1.a!b"), build.mod_tag("1.a?b"))
        long_tag = build.mod_tag("1." + "x" * 400)
        self.assertLessEqual(len(long_tag), len("mod-") + 100 + 9)
        for ident in ("1.a..b", "1.-x-", "1..", "1.x.lock", "1.a b", "1.~^:"):
            tag = build.mod_tag(ident)
            self.assertRegex(tag, r"^mod-([a-z0-9._-]*[a-z0-9]-)?[0-9a-f]{8}$", ident)
            self.assertNotIn("..", tag)

    def test_mint_identifier(self):
        self.assertEqual(build.mint_identifier("42", " My\tCool  Mod! "), "42.MyCoolMod!")
        with self.assertRaises(build.PackageError):
            build.mint_identifier("42", " \t ")

    def test_minted_then_locked_across_a_title_change(self):
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0"))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(list(self.catalog_mods()), ["111.CoolMod"])
        # the update renames the mod; the identifier, tag and id stay
        self.set_upload("111", "u2", self.meta("Renamed Thing", "2.0", identifier="111.CoolMod"),
                        payload=b"PAK2")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        mods = self.catalog_mods()
        self.assertEqual(list(mods), ["111.CoolMod"])
        self.assertEqual((mods["111.CoolMod"]["name"], mods["111.CoolMod"]["version"]), ("Renamed Thing", "2.0"))
        self.assertEqual(self.zips("111.CoolMod"), ["Cool-Mod-1.0.zip", "Renamed-Thing-2.0.zip"])
        self.assertEqual(self.stored("111.CoolMod", "Renamed-Thing-2.0.zip")[1]["identifier"], "111.CoolMod")
        # a NEW mod with the new title is a different mod
        self.set_upload("111", "u3", self.meta("Renamed Thing", "1.0"), payload=b"PAK3")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(sorted(self.catalog_mods()), ["111.CoolMod", "111.RenamedThing"])

    def test_zip_mode_locks_through_the_trailer_identifier(self):
        make_package(self.root / "a.zip", title="Zip Mod", version="1.0")
        self.to_inbox(self.root / "a.zip", "111")
        self.run_process()
        # the stored package carries 111.ZipMod: ModManager re-uploads it renamed
        make_package(self.root / "b.zip", title="Zip Mod Deluxe", version="2.0", identifier="111.ZipMod")
        self.to_inbox(self.root / "b.zip", "111")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(list(self.catalog_mods()), ["111.ZipMod"])
        self.assertEqual(self.catalog_mods()["111.ZipMod"]["name"], "Zip Mod Deluxe")
        # someone else's identifier in the trailer -> a new mod of the uploader
        make_package(self.root / "c.zip", title="Zip Mod", version="3.0", identifier="111.ZipMod")
        self.to_inbox(self.root / "c.zip", "222")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(sorted(self.catalog_mods()), ["111.ZipMod", "222.ZipMod"])
        self.assertEqual(self.catalog_mods()["111.ZipMod"]["version"], "2.0")
        # an identifier of the uploader's that does not exist -> a new (minted) mod
        make_package(self.root / "d.zip", title="Fresh", identifier="111.Gone")
        self.to_inbox(self.root / "d.zip", "111")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertIn("111.Fresh", self.catalog_mods())

    def test_update_of_own_mod_case_insensitive(self):
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0"))
        self.run_process()
        self.set_upload("111", "u2", self.meta("Cool Mod", "1.1", identifier="111.COOLMOD"), payload=b"P2")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(list(self.catalog_mods()), ["111.CoolMod"])  # the stored case is kept
        self.assertEqual(self.catalog_mods()["111.CoolMod"]["version"], "1.1")

    def test_update_of_someone_elses_mod_is_rejected(self):
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0"))
        self.run_process()
        before = self.catalog.read_bytes()
        self.set_upload("222", "u2", self.meta("Cool Mod", "2.0", identifier="111.CoolMod"), payload=b"P2")
        summary, err = self.rejection()
        self.assertEqual(summary, {"ok": 0, "rejected": 1})
        self.assertIn("update of '111.CoolMod': the mod belongs to 111; uploader 222 rejected", err)
        self.assertEqual(self.catalog.read_bytes(), before)
        self.assertEqual(self.zips("111.CoolMod"), ["Cool-Mod-1.0.zip"])
        self.assertEqual(self.inbox_names(), [])

    def test_update_of_an_unknown_identifier_is_rejected(self):
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0", identifier="111.Nope"))
        summary, err = self.rejection()
        self.assertEqual(summary, {"ok": 0, "rejected": 1})
        self.assertIn("update of '111.Nope': no mod with that identifier in the catalog", err)
        self.assertEqual(self.client.list_tags(build.MOD_TAG_PREFIX), [])
        self.assertEqual(self.inbox_names(), [])

    def test_admin_updates_anyones_mod_under_its_owner(self):
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0"), username="alice")
        self.run_process()
        self.set_upload(ADMIN, "u2", self.meta("Cool Mod", "2.0", identifier="111.coolmod"),
                        payload=b"P2", username="boss")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        e = self.catalog_mods()["111.CoolMod"]
        self.assertEqual((e["version"], e["uploader"], e["author"]), ("2.0", "111", "alice"))
        meta = self.stored("111.CoolMod", "Cool-Mod-2.0.zip")[1]
        self.assertEqual((meta["identifier"], meta["author"]), ("111.CoolMod", "alice"))

    def test_new_mod_collision_is_rejected(self):
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0"))
        self.run_process()
        before = self.catalog.read_bytes()
        for n, title in enumerate(("Cool Mod", "cool  MOD", "COOLMOD")):  # case/whitespace-insensitive
            self.set_upload("111", f"n{n}", self.meta(title, "9.0"), payload=f"other{n}".encode())
            summary, err = self.rejection()
            self.assertEqual(summary, {"ok": 0, "rejected": 1}, title)
            self.assertIn("you already have a mod with the identifier '111.CoolMod'; choose Update", err)
        self.assertEqual(self.catalog.read_bytes(), before)
        self.assertEqual(self.zips("111.CoolMod"), ["Cool-Mod-1.0.zip"])
        # another user minting the same title gets their own identifier
        self.set_upload("222", "x", self.meta("Cool Mod", "1.0"), payload=b"theirs")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(sorted(self.catalog_mods()), ["111.CoolMod", "222.CoolMod"])

    def test_same_run_new_mod_then_collision(self):
        self.set_upload("111", "a", self.meta("Race", "1.0"))
        self.set_upload("111", "b", self.meta("race", "2.0"), payload=b"P2")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 1})

    def test_metadata_guid_is_ignored(self):
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0", guid="not even a guid"))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})

    def test_metadata_identifier_must_be_a_string(self):
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0", identifier=5))
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        for blank in (None, "", "  "):  # = a new mod
            self.assertIsNone(build.parse_upload_metadata(self.meta(identifier=blank))["target"])

    def test_fresh_guid_per_upload(self):
        guid = str(uuid.uuid4())
        utoc = trailer.write_trailer(fake_toc(), {"title": "G", "author": "a", "description": "",
                                                  "version": "1", "guid": guid})[0]
        self.set_upload("111", "u1", None, utoc=utoc)
        self.set_upload("111", "u2", self.meta("G", "2", identifier="111.G"), utoc=utoc, payload=b"P2")
        self.assertEqual(self.run_process(), {"ok": 2, "rejected": 0})
        g1 = self.stored("111.G", "G-1.zip")[1]["guid"]
        g2 = self.stored("111.G", "G-2.zip")[1]["guid"]
        self.assertEqual(len({guid, g1, g2}), 3)
        self.assertEqual(uuid.UUID(g1).version, 4)

    def test_cover_reuse_on_update(self):
        png = make_image("png")
        data = base64.b64encode(png["data"]).decode("ascii")
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0", image={"mime": "image/png", "data": data}))
        self.run_process()
        cover = self.catalog_mods()["111.CoolMod"]["cover"]
        # image absent + a package without a cover: the mod's cover is reused
        self.set_upload("111", "u2", self.meta("Cool Mod", "2.0", identifier="111.CoolMod"), payload=b"P2")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()["111.CoolMod"]["cover"], cover)
        self.assertEqual(self.stored("111.CoolMod", "Cool-Mod-2.0.zip")[1]["image"], png)
        # zip mode (no metadata) reuses it too
        make_package(self.root / "z.zip", title="Cool Mod", version="3.0", identifier="111.CoolMod")
        self.to_inbox(self.root / "z.zip", "111")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.stored("111.CoolMod", "Cool-Mod-3.0.zip")[1]["image"], png)
        # null removes it
        self.set_upload("111", "u4", self.meta("Cool Mod", "4.0", identifier="111.CoolMod", image=None),
                        payload=b"P4")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertNotIn("cover", self.catalog_mods()["111.CoolMod"])
        self.assertIsNone(self.stored("111.CoolMod", "Cool-Mod-4.0.zip")[1]["image"])
        # nothing to reuse now; an object replaces
        self.set_upload("111", "u5", self.meta("Cool Mod", "5.0", identifier="111.CoolMod"), payload=b"P5")
        self.run_process()
        self.assertNotIn("cover", self.catalog_mods()["111.CoolMod"])
        jpeg = make_image("jpeg")
        self.set_upload("111", "u6", self.meta("Cool Mod", "6.0", identifier="111.CoolMod", image={
            "mime": "image/jpeg", "data": base64.b64encode(jpeg["data"]).decode("ascii")}), payload=b"P6")
        self.run_process()
        self.assertTrue(self.catalog_mods()["111.CoolMod"]["cover"].endswith(".jpg"))
        # a new mod never inherits a cover
        self.set_upload("111", "u7", self.meta("Other Mod", "1.0"), payload=b"P7")
        self.run_process()
        self.assertNotIn("cover", self.catalog_mods()["111.OtherMod"])

    def test_update_keeps_current_cover_over_the_packages_own(self):
        png, jpeg = make_image("png"), make_image("jpeg")
        def with_cover(title, version, image):
            return trailer.write_trailer(fake_toc(), {"title": title, "author": "x", "description": "",
                                                      "version": version, "image": image})[0]
        data = base64.b64encode(png["data"]).decode("ascii")
        self.set_upload("111", "u1", self.meta("Cool Mod", "1.0", image={"mime": "image/png", "data": data}))
        self.run_process()
        cover = self.catalog_mods()["111.CoolMod"]["cover"]
        # manifest-metadata update, image absent, a package WITH its own cover: the current cover wins
        self.set_upload("111", "u2", self.meta("Cool Mod", "2.0", identifier="111.CoolMod"),
                        utoc=with_cover("Cool Mod", "2.0", jpeg), payload=b"P2")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()["111.CoolMod"]["cover"], cover)
        self.assertEqual(self.stored("111.CoolMod", "Cool-Mod-2.0.zip")[1]["image"], png)
        # no manifest metadata (zip mode): the package's own trailer is the intent, its cover is kept
        make_package(self.root / "z.zip", title="Cool Mod", version="3.0", identifier="111.CoolMod", image=jpeg)
        self.to_inbox(self.root / "z.zip", "111")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.stored("111.CoolMod", "Cool-Mod-3.0.zip")[1]["image"], jpeg)
        self.assertTrue(self.catalog_mods()["111.CoolMod"]["cover"].endswith(".jpg"))
        # a mod without a current cover falls back to the package's cover
        self.set_upload("111", "u4", self.meta("Bare Mod", "1.0"), payload=b"P4")
        self.run_process()
        self.assertNotIn("cover", self.catalog_mods()["111.BareMod"])
        self.set_upload("111", "u5", self.meta("Bare Mod", "2.0", identifier="111.BareMod"),
                        utoc=with_cover("Bare Mod", "2.0", png), payload=b"P5")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.stored("111.BareMod", "Bare-Mod-2.0.zip")[1]["image"], png)
        self.assertIn("cover", self.catalog_mods()["111.BareMod"])
        # rebuild reproduces it from the stored packages
        live = json.loads(self.catalog.read_text(encoding="utf-8"))
        self.catalog.unlink()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        rebuilt = json.loads(self.catalog.read_text(encoding="utf-8"))
        for doc in (live, rebuilt):
            for m in doc["mods"]:
                m.pop("updated")
        self.assertEqual(rebuilt, live)

    def test_rebuild_reproduces_identity_ownership_and_covers(self):
        png = make_image("png")
        data = base64.b64encode(png["data"]).decode("ascii")
        self.set_upload("111", "a", self.meta("Cool Mod", "1.0", image={"mime": "image/png", "data": data}),
                        username="alice")
        self.run_process()
        self.set_upload("111", "b", self.meta("New Name", "2.0", identifier="111.coolmod"), payload=b"P2",
                        username="alice")
        self.set_upload("222", "c", self.meta("Bob Mod", "1.0"), payload=b"P3", username="bob")
        self.run_process()
        self.set_upload(ADMIN, "d", self.meta("Bob Mod", "1.1", identifier="222.BobMod"), payload=b"P4",
                        username="boss")
        self.set_upload("111", "e", self.meta("Third", "1.0"), payload=b"P5", username="alice2")
        self.run_process()
        live = json.loads(self.catalog.read_text(encoding="utf-8"))
        by_id = {m["id"]: m for m in live["mods"]}
        self.assertEqual(sorted(by_id), ["111.CoolMod", "111.Third", "222.BobMod"])
        self.assertEqual([(by_id[i]["uploader"], by_id[i]["author"]) for i in sorted(by_id)],
                         [("111", "alice2"), ("111", "alice2"), ("222", "bob")])
        self.assertEqual(by_id["111.CoolMod"]["name"], "New Name")
        self.assertIn("cover", by_id["111.CoolMod"])
        self.catalog.unlink()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        rebuilt = json.loads(self.catalog.read_text(encoding="utf-8"))
        for doc in (live, rebuilt):
            for m in doc["mods"]:
                m.pop("updated")
        self.assertEqual(rebuilt, live)

    def test_rebuild_skips_packages_of_another_identifier(self):
        self.set_upload("111", "a", self.meta("Cool Mod", "1.0"))
        self.run_process()
        live = self.catalog.read_bytes()
        # a package whose identifier belongs to another release, planted in this one
        tag = build.mod_tag("111.CoolMod")
        make_package(self.root / "x.zip", title="Stray", identifier="111.Stray")
        self.client.upload_asset(tag, self.root / "x.zip", "Stray-1.0.0.zip")
        build.rebuild(self.client, OWNER, REPO, self.catalog)  # newest invalid -> whole release skipped
        self.assertEqual(json.loads(self.catalog.read_text(encoding="utf-8"))["mods"], [])
        self.client.delete_asset(tag, "Stray-1.0.0.zip")
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertEqual(self._minus_updated(self.catalog.read_bytes()), self._minus_updated(live))

    @staticmethod
    def _minus_updated(raw: bytes) -> dict:
        doc = json.loads(raw)
        for m in doc["mods"]:
            m.pop("updated")
        return doc


class TestOwnership(Base):
    def test_first_uploader_owns(self):
        guid = str(uuid.uuid4())
        make_package(self.root / "a.zip", guid=guid)
        self.to_inbox(self.root / "a.zip", "111", f"{S('111')}__1__a.zip")
        self.run_process()
        self.assertEqual(self.catalog_mods()["111.TestMod"]["uploader"], "111")

        # another uploader's zip carrying the owner's identifier (and the same
        # GUID) is not an update of it: it becomes that uploader's own new mod
        for uid, label in (("222", "b"), (ADMIN, "c")):
            make_package(self.root / f"{label}.zip", version="2.0.0", guid=guid, identifier="111.TestMod",
                         payload=label)
            self.to_inbox(self.root / f"{label}.zip", uid)
            self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        mods = self.catalog_mods()
        self.assertEqual(sorted(mods), sorted(["111.TestMod", "222.TestMod", f"{ADMIN}.TestMod"]))
        self.assertEqual((mods["111.TestMod"]["uploader"], mods["111.TestMod"]["version"]), ("111", "1.0.0"))

    def test_seeding_is_an_upload_by_the_given_user(self):
        (self.root / "legacy").mkdir()
        make_package(self.root / "legacy" / "s.zip", author="Whoever Wrote It")
        sources = build.inbox_items_from_dir(self.root / "legacy", build.Uploader("777", "seeder"))
        self.processor.run(sources)
        e = self.catalog_mods()["777.TestMod"]
        self.assertEqual((e["uploader"], e["author"]), ("777", "seeder"))
        self.assertEqual(self.stored("777.TestMod", "Test-Mod-1.0.0.zip")[1]["identifier"], "777.TestMod")

        # 777 owns it now: an update by 444 is rejected
        self.assertEqual(build.parse_upload_metadata({"title": "T", "author": "a", "identifier": "777.TestMod"})
                         ["target"], "777.TestMod")
        target = build.Staged({}, {"target": "777.TestMod"})
        with self.assertRaisesRegex(build.PackageError, "belongs to 777"):
            self.processor._target(target, {"title": "T"}, None, "444",
                                   build.load_catalog(self.catalog)[1])

    def test_cli_seeding_needs_an_identity(self):
        d = self.root / "legacy"
        d.mkdir()
        make_package(d / "s.zip")
        base = [sys.executable, str(ROOT / "build.py"), "process", "--from-dir", str(d),
                "--client", "local", "--root", str(self.root), "--catalog", str(self.catalog),
                "--owner", OWNER, "--repo", REPO]
        for extra in ([], ["--as-uid", "777"], ["--as-username", "seeder"]):
            p = subprocess.run(base + extra, capture_output=True, text=True, cwd=str(ROOT))
            self.assertNotEqual(p.returncode, 0, extra)
            self.assertIn("--as-uid and --as-username", p.stderr)
        self.assertFalse(self.catalog.exists())
        p = subprocess.run(base + ["--as-uid", "not-a-number", "--as-username", "x"],
                           capture_output=True, text=True, cwd=str(ROOT))
        self.assertNotEqual(p.returncode, 0)
        p = subprocess.run(base + ["--as-uid", "777", "--as-username", "seeder"],
                           capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual([m["author"] for m in self.catalog_mods().values()], ["seeder"])

    def test_same_run_first_wins(self):
        """Two new mods of one title by one uploader in the same run: the first wins."""
        make_package(self.root / "a.zip", title="Race Mod")
        self.to_inbox(self.root / "a.zip", "111", f"{S('111')}__1__a.zip")
        make_package(self.root / "b.zip", version="2.0.0", title="race mod")
        self.to_inbox(self.root / "b.zip", "111", f"{S('111')}__2__b.zip")
        summary = self.run_process()
        self.assertEqual(summary, {"ok": 1, "rejected": 1})
        self.assertEqual(self.catalog_mods()["111.RaceMod"]["version"], "1.0.0")


class TestDrain(Base):
    def test_all_inbox_assets_processed(self):
        for i in range(3):
            make_package(self.root / f"p{i}.zip", title=f"Drain Mod {i}")
            self.to_inbox(self.root / f"p{i}.zip", f"100{i}", f"{S(f'100{i}')}__{i + 1}__p{i}.zip")
        summary = self.run_process()
        self.assertEqual(summary["ok"], 3)
        self.assertEqual(len(self.catalog_mods()), 3)
        self.assertEqual(self.inbox_names(), [])

    def test_empty_inbox_is_a_noop(self):
        self.client.create_release(build.INBOX_TAG, "inbox")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 0})
        self.assertFalse(self.catalog.exists())


class TestRebuild(Base):
    def _process_two_versions(self) -> str:
        guid = str(uuid.uuid4())
        make_package(self.root / "v1.zip", title="RB Mod", version="1.0.0", guid=guid)
        self.to_inbox(self.root / "v1.zip", "12345", f"{S('12345')}__1__v1.zip")
        self.run_process()
        make_package(self.root / "v2.zip", title="RB Mod", version="1.1.0", guid=guid,
                     identifier="12345.RBMod")
        self.to_inbox(self.root / "v2.zip", "12345", f"{S('12345')}__2__v2.zip")
        self.run_process()
        return "12345.RBMod"

    @staticmethod
    def _minus_updated(data: dict) -> dict:
        for m in data.get("mods", []):
            m.pop("updated", None)
        return data

    def test_rebuild_matches_incremental(self):
        self._process_two_versions()
        before = self.catalog.read_bytes()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        with self.catalog.open(encoding="utf-8") as f:
            rebuilt = json.load(f)
        with tempfile.NamedTemporaryFile("wb", delete=False) as nf:
            nf.write(before)
            prev_path = pathlib.Path(nf.name)
        with prev_path.open(encoding="utf-8") as f:
            prev = json.load(f)
        # every field except `updated` must match (rebuild stamps asset times)
        self.assertEqual(self._minus_updated(rebuilt), self._minus_updated(prev))
        # latest version is the main entry
        m = rebuilt["mods"][0]
        self.assertEqual(m["version"], "1.1.0")
        self.assertTrue(m["file"].endswith("RB-Mod-1.1.0.zip"))

    def test_rebuild_is_byte_deterministic(self):
        self._process_two_versions()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        first = self.catalog.read_bytes()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertEqual(self.catalog.read_bytes(), first)

    def test_rebuild_empty(self):
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        with self.catalog.open(encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["mods"], [])
        self.assertEqual(data["name"], build.load_catalog_identity()[0])


class TestRebuildNewestOnly(Base):
    """`rebuild` reads only the newest package of each release."""

    def setUp(self):
        super().setUp()
        self.downloads: list[str] = []
        orig = self.client.download_asset

        def counting(tag, name, dest):
            self.downloads.append(name)
            orig(tag, name, dest)

        self.client.download_asset = counting

    def _stamp_oldest_first(self, tag: str, names: list[str]) -> None:
        """Give the release's assets distinct mtimes in `names` order (oldest first)."""
        d = self.root / "releases" / tag
        base = 1_700_000_000
        for i, name in enumerate(names):
            os.utime(d / name, (base + i, base + i))

    @staticmethod
    def _minus_updated(raw: bytes) -> dict:
        data = json.loads(raw)
        for m in data.get("mods", []):
            m.pop("updated", None)
        return data

    def test_reads_one_package_per_release_and_agrees_with_the_live_catalog(self):
        guid, ident = str(uuid.uuid4()), "12345.SelMod"
        for i, (ver, payload) in enumerate(
                (("1.0", "A"), ("1.1", "B"), ("1.1", "C"), ("2.0", "D")), start=1):
            make_package(self.root / f"p{i}.zip", title="Sel Mod", version=ver,
                        payload=payload, guid=guid, identifier=ident)
            self.to_inbox(self.root / f"p{i}.zip", "12345", f"{S('12345')}__{i}__p{i}.zip")
            self.run_process()
        tag = build.mod_tag(ident)
        self.assertEqual(len(self.client.list_assets(tag)), 4)
        self._stamp_oldest_first(tag, ["Sel-Mod-1.0.zip", "Sel-Mod-1.1-2.zip",
                                       "Sel-Mod-1.1.zip", "Sel-Mod-2.0.zip"])

        live = self._minus_updated(self.catalog.read_bytes())
        self.catalog.unlink()
        self.downloads.clear()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertEqual(self._minus_updated(self.catalog.read_bytes()), live)
        self.assertEqual(self.downloads, ["Sel-Mod-2.0.zip"])

    def test_an_invalid_oldest_package_does_not_matter(self):
        guid, ident = str(uuid.uuid4()), "12345.SelMod"
        make_package(self.root / "p.zip", title="Sel Mod", version="2.0", guid=guid, identifier=ident)
        self.to_inbox(self.root / "p.zip", "12345", f"{S('12345')}__1__p.zip")
        self.run_process()
        tag = build.mod_tag(ident)
        (self.root / "bad.zip").write_bytes(b"not a zip " + uuid.uuid4().bytes * 4)
        self.client.upload_asset(tag, self.root / "bad.zip", "Sel-Mod-0.9.9.zip")
        self._stamp_oldest_first(tag, ["Sel-Mod-0.9.9.zip", "Sel-Mod-2.0.zip"])
        live = self._minus_updated(self.catalog.read_bytes())
        self.catalog.unlink()
        self.downloads.clear()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertEqual(self._minus_updated(self.catalog.read_bytes()), live)
        self.assertEqual(self.downloads, ["Sel-Mod-2.0.zip"])

    def test_an_invalid_newest_package_skips_the_release(self):
        make_package(self.root / "p.zip", title="Sel Mod", version="1.0", identifier="12345.SelMod")
        self.to_inbox(self.root / "p.zip", "12345", f"{S('12345')}__1__p.zip")
        self.run_process()
        tag = build.mod_tag("12345.SelMod")
        (self.root / "bad.zip").write_bytes(b"not a zip " + uuid.uuid4().bytes * 4)
        self.client.upload_asset(tag, self.root / "bad.zip", "Sel-Mod-9.9.zip")
        self._stamp_oldest_first(tag, ["Sel-Mod-1.0.zip", "Sel-Mod-9.9.zip"])
        with contextlib.redirect_stderr(io.StringIO()):
            build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertEqual(json.loads(self.catalog.read_text(encoding="utf-8"))["mods"], [])


class TestCatalogConfig(Base):
    """The catalog's name/description come from the site config (`title`/`description`)."""

    def write_config(self, content) -> pathlib.Path:
        path = self.root / "config.json"
        path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
        return path

    def catalog_doc(self) -> dict:
        with self.catalog.open(encoding="utf-8") as f:
            return json.load(f)

    def test_title_and_description(self):
        cfg = self.write_config({"uploadUrl": "https://w.example/upload",
                                 "title": "  XYZ Community Mods ", "description": "XYZ mods."})
        self.assertEqual(build.load_catalog_identity(cfg), ("XYZ Community Mods", "XYZ mods."))
        build.rebuild(self.client, OWNER, REPO, self.catalog, cfg)
        doc = self.catalog_doc()
        self.assertEqual((doc["name"], doc["description"]), ("XYZ Community Mods", "XYZ mods."))

    def test_defaults(self):
        defaults = (build.DEFAULT_CATALOG_NAME, build.DEFAULT_CATALOG_DESCRIPTION)
        self.assertEqual(build.load_catalog_identity(self.root / "missing.json"), defaults)
        for content in ('{"uploadUrl": "x"}', '{"title": "   ", "description": 5}', "[1, 2]", "not json", ""):
            with self.subTest(content=content):
                self.assertEqual(build.load_catalog_identity(self.write_config(content)), defaults)

    def test_process_uses_the_config(self):
        cfg = self.write_config({"title": "Processed Title"})
        self.processor = build.Processor(self.client, OWNER, REPO, {ADMIN}, self.catalog, cfg)
        self.to_inbox(make_package(self.root / "p.zip"), "111")
        self.run_process()
        doc = self.catalog_doc()
        self.assertEqual(doc["name"], "Processed Title")
        self.assertEqual(doc["description"], build.DEFAULT_CATALOG_DESCRIPTION)
        self.assertEqual(len(doc["mods"]), 1)

    def test_retitle_keeps_entries_and_is_deterministic(self):
        self.to_inbox(make_package(self.root / "p.zip"), "111")
        self.run_process()
        before = self.catalog_doc()
        cfg = self.write_config({"title": "Renamed"})
        build.main(["retitle", "--catalog", str(self.catalog), "--config", str(cfg)])
        after = self.catalog_doc()
        self.assertEqual(after["name"], "Renamed")
        self.assertEqual(after["mods"], before["mods"])
        first = self.catalog.read_bytes()
        build.retitle(self.catalog, cfg)
        self.assertEqual(self.catalog.read_bytes(), first)

    def test_retitle_changes_nothing_else(self):
        self.catalog.parent.mkdir(parents=True, exist_ok=True)
        self.catalog.write_text(json.dumps({"schemaVersion": 1, "name": "Old", "extra": [1],
                                            "mods": [{"id": "x", "name": "X", "file": "f"}]}),
                                encoding="utf-8")
        build.retitle(self.catalog, self.write_config({"title": "New", "description": "D"}))
        self.assertEqual(self.catalog_doc(), {"schemaVersion": 1, "name": "New", "description": "D",
                                              "extra": [1], "mods": [{"id": "x", "name": "X", "file": "f"}]})

    def test_catalog_validates_against_the_schema(self):
        sys.path.insert(0, str(ROOT / "mod-contract" / "tools"))
        try:
            import schema_check
        finally:
            sys.path.pop(0)
        cfg = self.write_config({"title": "XYZ Community Mods"})
        build.rebuild(self.client, OWNER, REPO, self.catalog, cfg)
        self.assertEqual(schema_check.validate_catalog(self.catalog_doc()), [])

    def test_site_config_is_valid(self):
        with (ROOT / "site" / "config.json").open(encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertIsInstance(cfg.get("title"), str)
        self.assertTrue(cfg["title"].strip())


class TestSanitize(unittest.TestCase):
    def test_names(self):
        self.assertEqual(build.sanitize_name("Example UE Mod"), "Example-UE-Mod")
        self.assertEqual(build.sanitize_name("  A  B..C! "), "A-B..C")
        self.assertEqual(build.sanitize_name("???"), "package")
        self.assertEqual(build.mod_asset_name({"title": "Example UE Mod", "version": "1.0.0"}),
                         "Example-UE-Mod-1.0.0.zip")


class TestRawUploads(Base):
    """Raw file sets (no client-side zipping): manifest + part-split files.

    Inbox names: <discordId>__<uploadId>__manifest.json and
    <discordId>__<uploadId>__f<i>__p<j>of<n>__<safe-filename>.
    """

    def upload_raw_bytes(self, name: str, data: bytes) -> None:
        d = self.client._release_dir(build.INBOX_TAG)
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(data)

    def add_file(self, uploader: str, uid: str, idx: int, filename: str, data: bytes,
                part_size: int = 65536) -> None:
        n = (len(data) + part_size - 1) // part_size if data else 1
        for i in range(n):
            self.upload_raw_bytes(
                f"{S(uploader)}__{uid}__f{idx}__p{i}of{n}__{filename}",
                data[i * part_size:(i + 1) * part_size])

    def add_manifest(self, uploader: str, uid: str, files: list[dict]) -> None:
        self.upload_raw_bytes(f"{S(uploader)}__{uid}__manifest.json",
                             json.dumps({"files": files}).encode("utf-8"))

    def raw_set(self, uploader: str, uid: str, utoc: bytes, ucas: bytes, pak: bytes,
               part_size: int = 65536, manifest_files: list[dict] | None = None) -> list[dict]:
        """Uploads a complete raw set: manifest + 3 files (pak, ucas, utoc).
        Returns the manifest's files list (so tests can corrupt it)."""
        self.client.create_release(build.INBOX_TAG, "inbox")
        ordered = (("mod.pak", pak), ("mod.ucas", ucas), ("mod.utoc", utoc))
        files = manifest_files or [
            {"name": n, "sha256": hashlib.sha256(b).hexdigest(),
             "parts": max(1, (len(b) + part_size - 1) // part_size)}
            for n, b in ordered
        ]
        self.add_manifest(uploader, uid, files)
        for idx, (n, b) in enumerate(ordered):
            self.add_file(uploader, uid, idx, n, b, part_size)
        return files

    def trailer_utoc(self, guid: str, title: str = "Raw Mod") -> bytes:
        payload = build.trailer.build_payload(
            {"title": title, "author": "Raw Author", "description": "raw",
             "version": "1.0.0", "guid": guid})
        return fake_toc() + build.trailer.build_trailer(payload)

    def test_raw_set_is_zipped_and_rehomed(self):
        guid = str(uuid.uuid4())
        self.raw_set("555", "u-1", self.trailer_utoc(guid), b"UCAS", b"PAK")
        summary = self.run_process()
        self.assertEqual(summary, {"ok": 1, "rejected": 0})
        e = self.catalog_mods()["555.RawMod"]
        self.assertEqual(e["uploader"], "555")
        self.assertEqual(e["name"], "Raw Mod")
        tag = build.mod_tag("555.RawMod")
        zips = [a.name for a in self.client.list_assets(tag) if a.name.endswith(".zip")]
        self.assertEqual(zips, ["Raw-Mod-1.0.0.zip"])
        self.assertEqual(self.inbox_names(), [])  # manifest + parts all deleted
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(tag, "Raw-Mod-1.0.0.zip", z)
            meta = build.validate_package(z)
            self.assertNotEqual(meta["guid"], guid)  # a fresh revision GUID
            self.assertEqual(meta["identifier"], "555.RawMod")
            with zipfile.ZipFile(z) as zf:
                self.assertEqual(sorted(zf.namelist()), ["mod.pak", "mod.ucas", "mod.utoc"])

    def test_multi_part_file_reassembles(self):
        guid = str(uuid.uuid4())
        big_ucas = b"U" * 25000  # several parts with part_size=8000 (utoc gets 9)
        self.raw_set("555", "u-6", self.trailer_utoc(guid), big_ucas, b"PAK", part_size=8000)
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(build.mod_tag("555.RawMod"), "Raw-Mod-1.0.0.zip", z)
            with zipfile.ZipFile(z) as zf:
                self.assertEqual(zf.read("mod.ucas"), big_ucas)

    def test_sha256_mismatch_rejected_and_group_deleted(self):
        guid = str(uuid.uuid4())
        files = self.raw_set("555", "u-2", self.trailer_utoc(guid), b"UCAS", b"PAK")
        files[1]["sha256"] = "0" * 64  # corrupt the mod.ucas claim (keeps part counts)
        self.client.delete_asset(build.INBOX_TAG, f"{S('555')}__u-2__manifest.json")
        self.add_manifest("555", "u-2", files)
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        self.assertEqual(self.inbox_names(), [])  # whole group deleted
        self.assertEqual(self.client.list_tags(build.MOD_TAG_PREFIX), [])

    def test_incomplete_group_waits(self):
        guid = str(uuid.uuid4())
        self.raw_set("555", "u-3", self.trailer_utoc(guid), b"UCAS", b"PAK")
        self.client.delete_asset(build.INBOX_TAG, f"{S('555')}__u-3__f0__p0of1__mod.pak")  # drop a part
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 0})
        self.assertEqual(len(self.inbox_names()), 4)  # waiting, nothing deleted

    def test_stale_group_deleted(self):
        guid = str(uuid.uuid4())
        self.raw_set("555", "u-4", self.trailer_utoc(guid), b"UCAS", b"PAK")
        import os as _os, time as _time
        for a in self.client.list_assets(build.INBOX_TAG):
            p = self.client._release_dir(build.INBOX_TAG) / a.name
            old = _time.time() - 8 * 86400
            _os.utime(p, (old, old))
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 0})
        self.assertEqual(self.inbox_names(), [])  # swept
        self.assertEqual(self.client.list_tags(build.MOD_TAG_PREFIX), [])

    def test_zip_and_raw_coexist_in_one_run(self):
        zguid, rguid = str(uuid.uuid4()), str(uuid.uuid4())
        make_package(self.root / "z.zip", title="Zip Mod", guid=zguid)
        self.to_inbox(self.root / "z.zip", "12345", f"{S('12345')}__1__z.zip")
        self.raw_set("555", "u-5", self.trailer_utoc(rguid, "Raw Mod"), b"UCAS", b"PAK")
        self.assertEqual(self.run_process(), {"ok": 2, "rejected": 0})
        self.assertEqual(len(self.catalog_mods()), 2)
        self.assertEqual(self.inbox_names(), [])

    def test_unrecognized_name_left_alone(self):
        self.client.create_release(build.INBOX_TAG, "inbox")
        self.upload_raw_bytes("weird-name.txt", b"x")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 0})
        self.assertEqual(self.inbox_names(), ["weird-name.txt"])


class TestUploadSets(Base):
    """Upload sets: loose files or one .zip, plus an optional manifest
    `metadata` object that the runner applies with `apply_metadata`."""

    def upload_raw_bytes(self, name: str, data: bytes) -> None:
        d = self.client._release_dir(build.INBOX_TAG)
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(data)

    def trailer_utoc(self, guid: str, title: str = "Raw Mod") -> bytes:
        payload = build.trailer.build_payload(
            {"title": title, "author": "Raw Author", "description": "raw",
             "version": "1.0.0", "guid": guid})
        return fake_toc() + build.trailer.build_trailer(payload)

    def set_upload(self, uploader: str, uid: str, files: list, metadata: bytes | None = None,
                   with_manifest: bool = True) -> None:
        """The parts, then the manifest last; `metadata` is the JSON text of the
        manifest's `metadata` value."""
        self.client.create_release(build.INBOX_TAG, "inbox")
        manifest: dict = {"files": [{"name": n, "sha256": hashlib.sha256(b).hexdigest(), "parts": 1}
                                    for n, b in files]}
        if metadata is not None:
            manifest["metadata"] = json.loads(metadata)
        for idx, (n, b) in enumerate(files):
            self.upload_raw_bytes(f"{S(uploader)}__{uid}__f{idx}__p0of1__{n}", b)
        if with_manifest:
            self.upload_raw_bytes(f"{S(uploader)}__{uid}__manifest.json", json.dumps(manifest).encode("utf-8"))

    @staticmethod
    def meta_json(**over) -> bytes:
        m = {"title": "Edited Title", "description": "edited", "version": "2.0.0",
             "game_version": "5.6", "tags": ["Skin"], "author": "Web Author"}
        m.update(over)
        return json.dumps(m).encode("utf-8")

    def loose(self, utoc: bytes) -> list:
        return [("mod.pak", b"PAK"), ("mod.ucas", b"UCAS"), ("mod.utoc", utoc)]

    def stored_package(self, identifier: str, name: str) -> tuple:
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(build.mod_tag(identifier), name, z)
            with zipfile.ZipFile(z) as zf:
                names = zf.namelist()
                return names, build.validate_package(z), zf.read(next(n for n in names if n.endswith(".utoc")))

    def zip_bytes(self, utoc: bytes, nested: bool = False, extra: bool = False) -> bytes:
        buf = io.BytesIO()
        pre = "Content/Paks/" if nested else ""
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(pre + "mod.pak", b"PAK")
            z.writestr(pre + "mod.ucas", b"UCAS")
            z.writestr(pre + "mod.utoc", utoc)
            if extra:
                z.writestr("readme.txt", b"hello")
        return buf.getvalue()

    def test_loose_set_without_trailer_gets_metadata(self):
        self.set_upload("555", "m-1", self.loose(fake_toc()), self.meta_json())
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        (ident, e), = self.catalog_mods().items()
        self.assertEqual((e["name"], e["author"], e["version"], e["gameVersion"], e["tags"]),
                         ("Edited Title", "user555", "2.0.0", "5.6", ["Skin"]))
        names, meta, _ = self.stored_package(ident, "Edited-Title-2.0.0.zip")
        self.assertEqual(sorted(names), ["mod.pak", "mod.ucas", "mod.utoc"])
        self.assertEqual((meta["author"], meta["identifier"]), ("user555", "555.EditedTitle"))
        self.assertEqual(self.inbox_names(), [])

    def test_loose_set_with_trailer_keeps_its_cover_but_not_its_guid(self):
        guid = str(uuid.uuid4())
        image = make_image("png")
        utoc = build.trailer.write_trailer(fake_toc(), {
            "title": "Old", "author": "Old Author", "description": "", "version": "1.0.0",
            "guid": guid, "image": image, "tags": []})[0]
        self.set_upload("555", "m-2", self.loose(utoc), self.meta_json())
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        e = self.catalog_mods()["555.EditedTitle"]
        self.assertEqual(e["name"], "Edited Title")
        self.assertIn("/cover-", e["cover"])  # image key absent: the package's cover is kept
        _, meta, _ = self.stored_package("555.EditedTitle", "Edited-Title-2.0.0.zip")
        self.assertEqual(meta["image"]["data"], image["data"])
        self.assertNotEqual(meta["guid"], guid)

    def test_metadata_removes_and_adds_a_cover(self):
        guid = str(uuid.uuid4())
        utoc = build.trailer.write_trailer(fake_toc(), {
            "title": "Old", "author": "A", "description": "", "version": "1.0.0",
            "guid": guid, "image": make_image("png"), "tags": []})[0]
        self.set_upload("555", "m-3", self.loose(utoc), self.meta_json(image=None))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertNotIn("cover", self.catalog_mods()["555.EditedTitle"])
        _, meta, _ = self.stored_package("555.EditedTitle", "Edited-Title-2.0.0.zip")
        self.assertIsNone(meta["image"])

        jpeg = make_image("jpeg")
        data = base64.b64encode(jpeg["data"]).decode("ascii")
        self.set_upload("555", "m-4", self.loose(utoc), self.meta_json(
            version="3.0.0", identifier="555.EditedTitle", image={"mime": "image/jpeg", "data": data}))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertTrue(self.catalog_mods()["555.EditedTitle"]["cover"].endswith(".jpg"))
        _, meta, _ = self.stored_package("555.EditedTitle", "Edited-Title-3.0.0.zip")
        self.assertEqual(meta["image"], jpeg)

    def test_zip_set_with_metadata_is_rewritten_and_drops_unrelated_members(self):
        guid = str(uuid.uuid4())
        utoc = build.trailer.write_trailer(fake_toc(), {
            "title": "Old", "author": "A", "description": "", "version": "1.0.0",
            "guid": guid, "tags": []})[0]
        blob = self.zip_bytes(utoc, nested=True, extra=True)
        self.set_upload("555", "m-5", [("Pack.zip", blob)], self.meta_json())
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()["555.EditedTitle"]["name"], "Edited Title")
        names, meta, _ = self.stored_package("555.EditedTitle", "Edited-Title-2.0.0.zip")
        self.assertEqual(sorted(names), ["Content/Paks/mod.pak", "Content/Paks/mod.ucas", "Content/Paks/mod.utoc"])
        self.assertNotEqual(meta["guid"], guid)

    def test_zip_set_without_metadata_is_rezipped_with_forced_fields(self):
        guid = str(uuid.uuid4())
        utoc = self.trailer_utoc(guid, "Plain Zip")
        blob = self.zip_bytes(utoc, extra=True)
        self.set_upload("555", "m-6", [("Pack.zip", blob)])
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        names, meta, _ = self.stored_package("555.PlainZip", "Plain-Zip-1.0.0.zip")
        self.assertEqual(sorted(names), ["mod.pak", "mod.ucas", "mod.utoc"])  # readme.txt dropped
        self.assertEqual((meta["author"], meta["identifier"]), ("user555", "555.PlainZip"))

    def test_loose_set_without_metadata_keeps_its_fields_but_forces_author(self):
        guid = str(uuid.uuid4())
        utoc = self.trailer_utoc(guid, "As Is")
        self.set_upload("555", "m-7", self.loose(utoc))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        names, meta, stored_utoc = self.stored_package("555.AsIs", "As-Is-1.0.0.zip")
        self.assertEqual((meta["title"], meta["version"], meta["description"]), ("As Is", "1.0.0", "raw"))
        self.assertNotEqual(meta["guid"], guid)
        self.assertEqual((meta["author"], meta["identifier"]), ("user555", "555.AsIs"))
        self.assertEqual(stored_utoc[:build.trailer.toc_end(build.trailer.parse_toc_header(utoc), utoc)],
                         utoc[:build.trailer.toc_end(build.trailer.parse_toc_header(utoc), utoc)])
        self.assertEqual(self.catalog_mods()["555.AsIs"]["author"], "user555")

    def test_set_without_any_trailer_and_without_metadata_is_rejected(self):
        self.set_upload("555", "m-7b", self.loose(fake_toc()))
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        self.assertEqual(self.inbox_names(), [])

    def test_metadata_guid_is_ignored_and_a_bad_set_does_not_block_the_run(self):
        guid = str(uuid.uuid4())
        utoc = self.trailer_utoc(guid, "Has Guid")
        self.set_upload("555", "m-8", self.loose(utoc), self.meta_json(guid=str(uuid.uuid4())))
        self.set_upload("556", "m-9", self.loose(fake_toc()), self.meta_json(title=""))  # invalid
        self.set_upload("557", "m-10", [("mod.pak", b"PAK-557"), ("mod.ucas", b"UCAS"), ("mod.utoc", fake_toc())],
                        self.meta_json(guid="not a guid"))
        self.assertEqual(self.run_process(), {"ok": 2, "rejected": 1})
        self.assertEqual(sorted(self.catalog_mods()), ["555.EditedTitle", "557.EditedTitle"])
        self.assertEqual(self.inbox_names(), [])

    def test_invalid_metadata_is_rejected_and_assets_deleted(self):
        bad = [self.meta_json(title=""), self.meta_json(tags=["a"] * 11), b'"text"',
               self.meta_json(image={"mime": "image/png", "data": "***"}),
               self.meta_json(image={"mime": "image/gif", "data": ""}), b"[]"]
        for n, raw in enumerate(bad):
            self.set_upload("555", f"bad-{n}", self.loose(fake_toc()), raw)
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": len(bad)})
        self.assertEqual(self.inbox_names(), [])
        self.assertEqual(self.client.list_tags(build.MOD_TAG_PREFIX), [])

    def test_set_without_its_manifest_waits(self):
        self.set_upload("555", "m-12", self.loose(fake_toc()), self.meta_json(), with_manifest=False)
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 0})
        self.assertEqual(len(self.inbox_names()), 3)
        self.upload_raw_bytes(f"{S('555')}__m-12__manifest.json", json.dumps({
            "files": [{"name": n, "sha256": hashlib.sha256(b).hexdigest(), "parts": 1}
                      for n, b in self.loose(fake_toc())],
            "metadata": json.loads(self.meta_json())}).encode("utf-8"))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.inbox_names(), [])

    def test_manifest_declaring_a_missing_part_waits_until_the_stale_sweep(self):
        self.set_upload("555", "m-13", self.loose(fake_toc()), self.meta_json())
        self.client.delete_asset(build.INBOX_TAG, f"{S('555')}__m-13__f1__p0of1__mod.ucas")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 0})
        self.assertEqual(len(self.inbox_names()), 3)
        old = time.time() - build.STALE_AFTER - 60
        for name in self.inbox_names():
            os.utime(self.client._release_dir(build.INBOX_TAG) / name, (old, old))
        events: list = []
        self.assertEqual(build.inbox_items_from_release(self.client, events), [])
        self.assertEqual([e["reason"] for e in events], ["incomplete upload expired"])
        self.assertEqual(self.inbox_names(), [])

    def test_metadata_is_part_of_the_manifest_only(self):
        guid = str(uuid.uuid4())
        self.set_upload("555", "m-14b", self.loose(self.trailer_utoc(guid, "Untouched")))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()["555.Untouched"]["name"], "Untouched")
        self.assertEqual(self.inbox_names(), [])

    def test_manifest_metadata_must_be_an_object(self):
        self.upload_raw_bytes(f"{S('555')}__m-14c__f0__p0of1__mod.pak", b"PAK")
        self.upload_raw_bytes(f"{S('555')}__m-14c__manifest.json", json.dumps({
            "files": [{"name": "mod.pak", "sha256": hashlib.sha256(b"PAK").hexdigest(), "parts": 1}],
            "metadata": "text"}).encode("utf-8"))
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        self.assertEqual(self.inbox_names(), [])

    def test_zip_with_other_files_is_rejected(self):
        guid = str(uuid.uuid4())
        blob = self.zip_bytes(self.trailer_utoc(guid))
        self.set_upload("555", "m-14", [("Pack.zip", blob), ("mod.pak", b"PAK")], self.meta_json())
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})

    def test_zip_with_two_sets_is_rejected_with_metadata(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for base in ("a", "b"):
                for ext in (".utoc", ".ucas", ".pak"):
                    z.writestr(base + ext, fake_toc() if ext == ".utoc" else b"x")
        self.set_upload("555", "m-15", [("Pack.zip", buf.getvalue())], self.meta_json())
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})

    def test_a_metadata_json_asset_is_not_an_inbox_name(self):
        self.assertIsNone(build.parse_inbox_name(f"{S('555')}__u-1__metadata.json"))
        self.assertEqual(build.parse_inbox_name(f"{S('555')}__u-1__manifest.json")["kind"], "manifest")

    def test_apply_metadata_unit(self):
        meta = build.parse_upload_metadata(json.loads(self.meta_json(guid=None)))
        out = build.apply_metadata(fake_toc(), meta, None, author="alice", identifier="555.EditedTitle")
        got = build.trailer.read_trailer(out)
        self.assertEqual((got["title"], got["author"], got["identifier"], got["tags"]),
                         ("Edited Title", "alice", "555.EditedTitle", ["Skin"]))
        again = build.apply_metadata(out, build.parse_upload_metadata(json.loads(self.meta_json(title="Second"))),
                                     build.existing_trailer(out), author="alice", identifier="555.EditedTitle")
        a = build.trailer.read_trailer(again)
        self.assertNotEqual(a["guid"], got["guid"])  # a fresh revision GUID on every write
        self.assertEqual((a["title"], a["identifier"]), ("Second", "555.EditedTitle"))  # identifier as given
        # no metadata: the package's own fields survive, author/identifier are forced
        forced = build.apply_metadata(out, None, build.existing_trailer(out), author="bob", identifier="9.X")
        f = build.trailer.read_trailer(forced)
        self.assertEqual((f["title"], f["author"], f["identifier"]), ("Edited Title", "bob", "9.X"))
        # the fallback cover is used only when neither metadata nor the package has one
        png = make_image("png")
        calls = []
        def fallback():
            calls.append(1)
            return png
        with_cover = build.apply_metadata(out, None, build.existing_trailer(out), author="a", identifier="1.X",
                                          fallback_cover=fallback)
        self.assertEqual(build.trailer.read_trailer(with_cover)["image"], png)
        removed = build.apply_metadata(with_cover, {**meta, "image": None}, build.existing_trailer(with_cover),
                                       author="a", identifier="1.X", fallback_cover=fallback)
        self.assertIsNone(build.trailer.read_trailer(removed)["image"])
        self.assertEqual(len(calls), 1)
        # an explicit update (metadata `identifier` -> target), image absent: the
        # current cover beats the package's own; the package's is the fallback
        jpeg = make_image("jpeg")
        upd = {k: v for k, v in meta.items() if k != "image"}
        upd["target"] = "1.X"
        current = build.apply_metadata(with_cover, upd, build.existing_trailer(with_cover),
                                       author="a", identifier="1.X", fallback_cover=lambda: jpeg)
        self.assertEqual(build.trailer.read_trailer(current)["image"], jpeg)
        kept = build.apply_metadata(with_cover, upd, build.existing_trailer(with_cover),
                                    author="a", identifier="1.X", fallback_cover=lambda: None)
        self.assertEqual(build.trailer.read_trailer(kept)["image"], png)
        # no metadata: the package's own cover still wins
        own = build.apply_metadata(with_cover, None, build.existing_trailer(with_cover),
                                   author="a", identifier="1.X", fallback_cover=lambda: jpeg)
        self.assertEqual(build.trailer.read_trailer(own)["image"], png)
        with self.assertRaises(build.PackageError):
            build.apply_metadata(fake_toc(), None, None, author="a", identifier="1.X")


class TestVerifiedAuthors(Base):
    """The catalog's author is the uploader's Discord username, whatever the
    package or the manifest metadata says."""

    def upload(self, uid: str, name: str, *, username: str | None = None, title: str = "Verified Mod",
               version: str = "1.0.0", identifier: str | None = None, author: str = "Self Declared") -> str:
        """A zip-mode upload; returns the mod's identifier (`identifier` = an update of it)."""
        make_package(self.root / f"{name}.zip", title=title, version=version, author=author,
                     identifier=identifier)
        self.to_inbox(self.root / f"{name}.zip", uid, f"{S(uid, username)}__{self.next_ts()}__{name}.zip")
        return identifier or build.mint_identifier(uid, title)

    def test_zip_mode_forces_author_and_identifier(self):
        ident = self.upload("111", "a", username="Alice.B")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        e = self.catalog_mods()[ident]
        self.assertEqual((e["author"], e["uploader"]), ("Alice.B", "111"))
        meta = self.stored(ident, "Verified-Mod-1.0.0.zip")[1]
        self.assertEqual((meta["author"], meta["identifier"]), ("Alice.B", "111.VerifiedMod"))

    def test_identifier_strips_all_whitespace_of_the_title(self):
        self.upload("111", "a", title="  A 	 Spaced Title ")
        self.run_process()
        self.assertEqual(self.stored("111.ASpacedTitle", "A-Spaced-Title-1.0.0.zip")[1]["identifier"],
                         "111.ASpacedTitle")

    def test_admin_is_forced_too(self):
        ident = self.upload(ADMIN, "a", username="boss", author="Somebody Else")
        self.run_process()
        e = self.catalog_mods()[ident]
        self.assertEqual((e["author"], e["uploader"]), ("boss", ADMIN))
        meta = self.stored(ident, "Verified-Mod-1.0.0.zip")[1]
        self.assertEqual((meta["author"], meta["identifier"]), ("boss", f"{ADMIN}.VerifiedMod"))

    def test_admin_updating_another_users_mod_keeps_the_owners_name(self):
        ident = self.upload("111", "a", username="alice")
        self.run_process()
        helper = TestIdentity("test_mint_identifier")
        helper.client = self.client
        helper.set_upload(ADMIN, "adm", helper.meta("Verified Mod", "2.0.0", identifier=ident), username="boss")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        e = self.catalog_mods()[ident]
        self.assertEqual((e["version"], e["uploader"], e["author"]), ("2.0.0", "111", "alice"))
        # the stored package carries the owner's name too (so rebuild cannot mistake it)
        self.assertEqual(self.stored(ident, "Verified-Mod-2.0.0.zip")[1]["author"], "alice")
        # the admin's own entries are renamed by the upload, nobody else's
        self.assertEqual([m["author"] for m in self.catalog_mods().values()], ["alice"])

    def test_a_rename_updates_every_entry_of_that_user_and_nobody_elses(self):
        g1 = self.upload("111", "a", username="alice", title="One")
        g2 = self.upload("111", "b", username="alice", title="Two")
        g3 = self.upload("222", "c", username="bob", title="Three")
        self.run_process()
        self.assertEqual({self.catalog_mods()[g]["author"] for g in (g1, g2)}, {"alice"})
        # alice renames herself and uploads a new version of only one of her mods
        self.upload("111", "d", username="alice2", title="One", version="2.0.0", identifier=g1)
        self.run_process()
        mods = self.catalog_mods()
        self.assertEqual([mods[g]["author"] for g in (g1, g2, g3)], ["alice2", "alice2", "bob"])
        # the older stored package keeps the name it was uploaded with
        self.assertEqual(self.stored(g2, "Two-1.0.0.zip")[1]["author"], "alice")

    def test_leaving_keeps_the_old_name(self):
        g = self.upload("111", "a", username="alice")
        other = self.upload("222", "b", username="bob", title="Other")
        self.run_process()
        self.upload("222", "c", username="bob2", title="Other", version="2.0.0", identifier=other)
        self.run_process()
        self.assertEqual(self.catalog_mods()[g]["author"], "alice")
        self.assertEqual(self.catalog_mods()[other]["author"], "bob2")

    def test_username_with_unicode_roundtrips(self):
        g = self.upload("111", "a", username="Zoë 日本__x")
        self.run_process()
        self.assertEqual(self.catalog_mods()[g]["author"], "Zoë 日本__x")

    def test_unstamped_or_malformed_names_are_left_alone(self):
        self.client.create_release(build.INBOX_TAG, "inbox")
        d = self.client._release_dir(build.INBOX_TAG)
        for n in ("111__1__a.zip", "__1__a.zip", "111-zz__1__a.zip", "111-__1__a.zip",
                  "111-ff__1__a.zip", "abc-616c696365__1__a.zip"):
            (d / n).write_bytes(b"x")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 0})
        self.assertEqual(len(self.inbox_names()), 6)

    def test_parse_uploader(self):
        self.assertEqual(build.parse_uploader("42-616c696365"), build.Uploader("42", "alice"))
        for bad in ("42", "42-", "42-6", "42-zz", "-616c696365", "x-616c696365", "42-ff", "42-616C696365"):
            self.assertIsNone(build.parse_uploader(bad), bad)

    def test_set_group_uses_the_manifests_username(self):
        guid = str(uuid.uuid4())
        helper = TestUploadSets("test_loose_set_without_trailer_gets_metadata")
        helper.client = self.client
        helper.set_upload("555", "m-1", helper.loose(fake_toc()), helper.meta_json())
        # a part uploaded after the user re-minted a token with a new username
        d = self.client._release_dir(build.INBOX_TAG)
        old = d / f"{S('555')}__m-1__f0__p0of1__mod.pak"
        old.rename(d / f"{S('555', 'renamed')}__m-1__f0__p0of1__mod.pak")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        (e,) = self.catalog_mods().values()
        self.assertEqual(e["author"], "user555")
        del guid

    def test_catalog_declares_verified_authors(self):
        self.upload("111", "a")
        self.run_process()
        self.assertIs(json.loads(self.catalog.read_text(encoding="utf-8"))["verifiedAuthors"], True)
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertIs(json.loads(self.catalog.read_text(encoding="utf-8"))["verifiedAuthors"], True)


class TestRebuildVerified(Base):
    def upload(self, uid, name, username, title="RB Mod", version="1.0.0", identifier=None):
        make_package(self.root / f"{name}.zip", title=title, version=version, identifier=identifier)
        self.to_inbox(self.root / f"{name}.zip", uid, f"{S(uid, username)}__{self.next_ts()}__{name}.zip")
        self.run_process()
        return identifier or build.mint_identifier(uid, title)

    def test_rebuild_from_releases_alone_reproduces_the_live_catalog(self):
        g1 = self.upload("111", "a", "alice", title="One")
        g2 = self.upload("111", "b", "alice", title="Two")
        g3 = self.upload("222", "c", "bob", title="Three")
        self.upload("111", "d", "alice2", title="One renamed", version="2.0.0", identifier=g1)
        helper = TestIdentity("test_mint_identifier")
        helper.client = self.client
        helper.set_upload(ADMIN, "adm", helper.meta("Three", "2.0.0", identifier=g3), username="boss")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        live = json.loads(self.catalog.read_text(encoding="utf-8"))
        self.catalog.unlink()  # a lost catalog: nothing to inherit from
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        rebuilt = json.loads(self.catalog.read_text(encoding="utf-8"))
        for doc in (live, rebuilt):
            for m in doc["mods"]:
                m.pop("updated")
        self.assertEqual(rebuilt, live)
        by_id = {m["id"]: m for m in rebuilt["mods"]}
        self.assertEqual([(by_id[g]["uploader"], by_id[g]["author"]) for g in (g1, g2, g3)],
                         [("111", "alice2"), ("111", "alice2"), ("222", "bob")])

    def test_rebuild_is_byte_deterministic_and_idempotent(self):
        self.upload("111", "a", "alice")
        self.upload("222", "b", "bob", title="Other")
        self.catalog.unlink()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        first = self.catalog.read_bytes()
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertEqual(self.catalog.read_bytes(), first)

    def test_rebuild_skips_packages_not_written_by_the_catalog(self):
        tag = build.mod_tag("Tester.TestMod")
        make_package(self.root / "h.zip")  # identifier "Tester.TestMod": no uploader id
        self.client.create_release(tag, "Hand Made")
        self.client.upload_asset(tag, self.root / "h.zip", "Test-Mod-1.0.0.zip")
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        self.assertEqual(json.loads(self.catalog.read_text(encoding="utf-8"))["mods"], [])


@unittest.skipUnless(LEGACY.is_dir(), "legacy-assets/ not present")
class TestLegacyEndToEnd(Base):
    """The real example zips through the whole pipeline (local client)."""

    def test_seed_three_examples(self):
        p = subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "process", "--from-dir", str(LEGACY),
             "--as-uid", "777", "--as-username", "seeder", "--client", "local", "--root", str(self.root), "--catalog", str(self.catalog),
             "--owner", OWNER, "--repo", REPO],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(p.returncode, 0, p.stderr)
        mods = self.catalog_mods()
        self.assertEqual(len(mods), 3)
        for m in mods.values():
            self.assertTrue(m["file"].startswith(f"https://github.com/{OWNER}/{REPO}/releases/download/mod-"))
            self.assertTrue(m["file"].endswith(".zip"))
            self.assertEqual((m["uploader"], m["author"]), ("777", "seeder"))  # seeding as that user
            self.assertEqual(len(m["sha256"]), 64)
        # covers were extracted from the trailers
        self.assertEqual(sum(1 for m in mods.values() if "cover" in m), 3)
        # and rebuild reproduces the same catalog (modulo updated)
        build.rebuild(self.client, OWNER, REPO, self.catalog)
        with self.catalog.open(encoding="utf-8") as f:
            data = json.load(f)
        for m in data["mods"]:
            self.assertEqual(len(m["sha256"]), 64)
        self.assertEqual(len(data["mods"]), 3)


class TestEvents(Base):
    """A run's outcome events (published/rejected): the results file and the
    event ids (mod-contract: `published` = <identKeyLower>:<package sha256>,
    `rejected` = rej:<uploaderId>:<inbox group or asset id>)."""

    def events(self) -> list[dict]:
        return self.processor.results

    def by_status(self, status: str) -> list[dict]:
        return [e for e in self.events() if e["status"] == status]

    def reset(self) -> None:
        """A fresh world (no releases, no catalog) for the same Processor."""
        rel = self.root / "releases"
        for p in rel.glob("*") if rel.is_dir() else []:
            if p.is_dir():
                shutil.rmtree(p)
        self.catalog.unlink(missing_ok=True)
        self.n = 0

    def test_published_event_fields_equal_the_catalog_entry(self):
        image = make_image("png")
        make_package(self.root / "a.zip", image=image, tags=["VFX"], game_version="5.6")
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__a.zip")
        self.run_process()
        pub = self.by_status("published")
        self.assertEqual(len(pub), 1)
        e = pub[0]
        entry = self.catalog_mods()["12345.TestMod"]
        self.assertEqual(e["status"], "published")
        self.assertEqual(e["mode"], "new")
        self.assertEqual(e["uploaderId"], "12345")
        self.assertEqual(e["uploaderName"], "user12345")
        self.assertEqual(e["title"], entry["name"])
        self.assertEqual(e["version"], entry["version"])
        self.assertEqual(e["description"], entry["description"])
        self.assertEqual(e["author"], entry["author"])
        self.assertEqual(e["identifier"], entry["id"])
        self.assertEqual(e["tags"], entry.get("tags", []))
        self.assertEqual(e["gameVersion"], entry.get("gameVersion"))
        self.assertEqual(e["fileUrl"], entry["file"])
        self.assertEqual(e["coverUrl"], entry.get("cover"))
        self.assertEqual(e["size"], entry["size"])
        self.assertEqual(e["sha256"], entry["sha256"])
        self.assertEqual(e["assetName"], entry["file"].rsplit("/", 1)[-1])
        # the event id: the identifier key + the stored package's sha256
        tag = build.mod_tag("12345.TestMod")
        self.assertEqual(e["eventId"],
                         f"12345.testmod:{hashlib.sha256(self.client.asset_bytes(tag, e['assetName'])).hexdigest()}")

    def test_update_event_mode(self):
        make_package(self.root / "a.zip", title="Upd Mod", version="1.0")
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__a.zip")
        self.run_process()
        self.assertEqual(self.by_status("published")[0]["mode"], "new")
        make_package(self.root / "b.zip", title="Upd Mod", version="1.1", identifier="12345.UpdMod")
        self.to_inbox(self.root / "b.zip", "12345", f"{S('12345')}__2__b.zip")
        self.run_process()  # `results` is per run
        pub = self.by_status("published")
        self.assertEqual(len(pub), 1)
        self.assertEqual(pub[0]["mode"], "update")
        self.assertEqual(pub[0]["identifier"], "12345.UpdMod")

    def test_rejection_events_with_reasons_do_not_block(self):
        good = self.root / "good.zip"
        make_package(good, title="Good Mod")
        self.to_inbox(good, "12345", f"{S('12345')}__1__good.zip")
        make_package(self.root / "notrail.zip", no_trailer=True)
        self.to_inbox(self.root / "notrail.zip", "12345", f"{S('12345')}__2__notrail.zip")
        make_package(self.root / "corrupt.zip", corrupt=True)
        self.to_inbox(self.root / "corrupt.zip", "12345", f"{S('12345')}__3__corrupt.zip")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 2})
        pub = self.by_status("published")
        self.assertEqual(len(pub), 1)  # the good one survived the rejections
        self.assertEqual(pub[0]["title"], "Good Mod")
        rej = self.by_status("rejected")
        self.assertEqual(len(rej), 2)
        for e in rej:
            self.assertIsNone(e["mode"])
            self.assertEqual(e["uploaderId"], "12345")
            self.assertEqual(e["uploaderName"], "user12345")
            self.assertTrue(e["reason"])
            self.assertLessEqual(len(e["reason"]), 300)
            self.assertRegex(e["eventId"], r"^rej:12345:")
            # rejected before the trailer is parsed: nothing is known
            self.assertIsNone(e["title"])
            self.assertIsNone(e["version"])
            self.assertIsNone(e["identifier"])
        self.assertTrue(any("no metadata trailer" in e["reason"] for e in rej))
        self.assertTrue(any("not a valid zip file" in e["reason"] for e in rej))

    def test_rejection_event_carries_the_known_fields(self):
        make_package(self.root / "a.zip", title="Dup Mod", version="1.0", payload="X")
        self.to_inbox(self.root / "a.zip", "111", f"{S('111')}__1__a.zip")
        self.run_process()
        make_package(self.root / "b.zip", title="Dup Mod", version="1.0", payload="X", author="other")
        self.to_inbox(self.root / "b.zip", "222", f"{S('222')}__2__b.zip")
        self.run_process()
        rej = self.by_status("rejected")
        self.assertEqual(len(rej), 1)
        e = rej[0]
        self.assertEqual((e["title"], e["version"], e["identifier"]), ("Dup Mod", "1.0", "222.DupMod"))
        self.assertIn("duplicate of the existing mod 'Dup Mod' v1.0 (id 111.DupMod)", e["reason"])

    def test_incomplete_group_emits_nothing(self):
        # a set that declares 2 parts but only uploaded one: left for the next run
        self.client.create_release(build.INBOX_TAG, "inbox")
        d = self.client._release_dir(build.INBOX_TAG)
        stamp = S("111")
        manifest = {"files": [{"name": "mod.pak",
                               "sha256": hashlib.sha256(b"PAK").hexdigest(), "parts": 2}]}
        (d / f"{stamp}__u1__manifest.json").write_bytes(json.dumps(manifest).encode("utf-8"))
        (d / f"{stamp}__u1__f0__p0of2__mod.pak").write_bytes(b"PAK")
        events = []
        sources = build.inbox_items_from_release(self.client, events)
        self.assertEqual(sources, [])
        self.assertEqual(events, [])
        self.assertEqual(sorted(self.inbox_names()),
                         sorted([f"{stamp}__u1__manifest.json", f"{stamp}__u1__f0__p0of2__mod.pak"]))

    def test_stalled_group_is_rejected_with_the_sweep_reason(self):
        # a group stalled for > 7 days: deleted, and a 'rejected' event
        self.client.create_release(build.INBOX_TAG, "inbox")
        d = self.client._release_dir(build.INBOX_TAG)
        stamp = S("111")
        manifest = {"files": [{"name": "mod.pak",
                               "sha256": hashlib.sha256(b"PAK").hexdigest(), "parts": 1}]}
        (d / f"{stamp}__u9__manifest.json").write_bytes(json.dumps(manifest).encode("utf-8"))
        (d / f"{stamp}__u9__f0__p0of1__mod.pak").write_bytes(b"PAK")
        old = (datetime.now(timezone.utc) - timedelta(days=8)).timestamp()
        os.utime(d / f"{stamp}__u9__manifest.json", (old, old))
        os.utime(d / f"{stamp}__u9__f0__p0of1__mod.pak", (old, old))
        events = []
        sources = build.inbox_items_from_release(self.client, events)
        self.assertEqual(sources, [])
        self.assertEqual(len(events), 1)
        e = events[0]
        self.assertEqual(e["status"], "rejected")
        self.assertEqual(e["reason"], "incomplete upload expired")
        self.assertEqual(e["eventId"], "rej:111:u9")
        self.assertEqual(e["uploaderName"], "user111")
        self.assertEqual(self.inbox_names(), [])  # the group was deleted

    def test_event_ids_stable_and_distinct(self):
        def stage() -> None:
            make_package(self.root / "bad.zip", no_trailer=True)
            self.to_inbox(self.root / "bad.zip", "12345", f"{S('12345')}__7__bad.zip")
            make_package(self.root / "good.zip", title="Stable Mod")
            self.to_inbox(self.root / "good.zip", "12345", f"{S('12345')}__8__good.zip")
        stage()
        self.run_process()
        first = [e["eventId"] for e in self.events()]
        self.assertEqual(len(first), 2)
        self.assertNotEqual(first[0], first[1])  # distinct
        self.reset()
        stage()
        self.run_process()
        second = [e["eventId"] for e in self.events()]
        # the rejection id (uploader + asset name) is stable across runs of
        # the same input ...
        self.assertEqual(first[0], second[0])
        # ... the published one is checked against the stored package's bytes
        # (the runner's per-upload fresh guid makes those differ between runs)
        pub = self.by_status("published")[0]
        tag = build.mod_tag("12345.StableMod")
        sha = hashlib.sha256(self.client.asset_bytes(tag, pub["assetName"])).hexdigest()
        self.assertEqual(pub["eventId"], f"12345.stablemod:{sha}")


class TestResultsFile(Base):
    """`process --results-file`: the events as a JSON array (atomic write,
    `[]` when there were none, written even with rejections)."""

    def run_cli(self, extra: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "process", "--from-inbox",
             "--client", "local", "--root", str(self.root),
             "--catalog", str(self.catalog), "--owner", OWNER, "--repo", REPO] + extra,
            capture_output=True, text=True, cwd=str(ROOT))

    def test_writes_one_event_per_item_including_rejections(self):
        make_package(self.root / "a.zip", title="RF Mod")
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__a.zip")
        make_package(self.root / "b.zip", no_trailer=True)
        self.to_inbox(self.root / "b.zip", "12345", f"{S('12345')}__2__b.zip")
        out = self.root / "res.json"
        p = self.run_cli(["--results-file", str(out)])
        self.assertEqual(p.returncode, 0, p.stderr)
        events = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(len(events), 2)
        self.assertEqual(sorted(e["status"] for e in events), ["published", "rejected"])
        self.assertEqual(events[0]["status"], "published")  # sources are in asset order

    def test_empty_run_writes_an_empty_array(self):
        out = self.root / "res.json"
        p = self.run_cli(["--results-file", str(out)])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(out.read_text(encoding="utf-8")), [])

    def test_no_results_file_no_file(self):
        make_package(self.root / "a.zip", title="RF Mod")
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__a.zip")
        p = self.run_cli([])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse((self.root / "res.json").exists())


class FakeDiscord:
    """An injectable `http` for `announce`: records every call and answers with
    the next scripted (status, body) per call, else 200 with a fresh id."""

    def __init__(self):
        self.calls: list[dict] = []
        self.script: list = []  # (status, dict|None) or a callable(call) -> (status, dict|None)
        self.sleeps: list[float] = []
        self._next_id = 5000

    def __call__(self, method, url, headers, body):
        call = {"method": method, "url": url, "headers": headers, "body": json.loads(body.decode("utf-8"))}
        self.calls.append(call)
        if self.script:
            step = self.script.pop(0)
            status, doc = step(call) if callable(step) else step
        else:
            self._next_id += 1
            status, doc = 200, {"id": str(self._next_id)}
        return status, (json.dumps(doc).encode("utf-8") if doc is not None else b"")

    def sleep(self, seconds):
        self.sleeps.append(seconds)


class TestAnnounce(Base):
    """`build.py announce`: Discord posts from the run's events, the thread id
    kept in the mod release's notes (offline: injected `http`, LocalClient)."""

    ENV = {"DISCORD_BOT_TOKEN": "tok-secret", "FORUM_CHANNEL_ID": "900",
           "NOTICES_CHANNEL_ID": "800", "SITE_URL": "https://site.example/",
           "FORUM_TAG_IDS": json.dumps({"Skin": "11", "Audio": 12})}

    def setUp(self):
        super().setUp()
        self.discord = FakeDiscord()

    def published(self, version="1.0.0", identifier="12345.TestMod", **over) -> dict:
        ev = {"eventId": f"{identifier.lower()}:{version}", "status": "published", "mode": "new",
              "uploaderId": "12345", "uploaderName": "user12345", "title": "Test Mod",
              "version": version, "description": "A mod", "identifier": identifier,
              "tags": ["Skin", "Nope", "Audio"], "coverUrl": "https://x/cover.png"}
        ev.update(over)
        return ev

    def rejected(self, **over) -> dict:
        ev = {"eventId": "rej:12345:g", "status": "rejected", "mode": None, "uploaderId": "12345",
              "uploaderName": "user12345", "reason": "bad package", "title": "Test Mod",
              "version": None, "identifier": None}
        ev.update(over)
        return ev

    def announce(self, events, env=None) -> tuple[int, int]:
        self.client.create_release(build.mod_tag("12345.TestMod"), "Test Mod")
        return build.announce_events(self.client, events, self.ENV if env is None else env,
                                     http=self.discord, sleep=self.discord.sleep)

    def notes(self, identifier="12345.TestMod") -> str:
        return self.client.release_notes(build.mod_tag(identifier))

    def test_first_publish_creates_a_thread_and_records_its_id(self):
        self.assertEqual(self.announce([self.published()]), (1, 1))
        (call,) = self.discord.calls
        self.assertEqual(call["url"], "https://discord.com/api/v10/channels/900/threads")
        self.assertEqual(call["headers"]["Authorization"], "Bot tok-secret")
        self.assertTrue(call["headers"]["User-Agent"])
        body = call["body"]
        self.assertEqual(body["name"], "Test Mod")
        self.assertEqual(body["applied_tags"], ["11", "12"])
        msg = body["message"]
        self.assertEqual(msg["content"],
                         "<@12345> published **Test Mod** v1.0.0\nA mod\nhttps://site.example/")
        self.assertEqual(msg["allowed_mentions"], {"parse": [], "users": ["12345"]})
        self.assertEqual(msg["embeds"], [{"footer": {"text": "mod-id: 12345.TestMod"},
                                          "image": {"url": "https://x/cover.png"}}])
        self.assertEqual(build.thread_id_from_notes(self.notes()), "5001")

    def test_follow_up_posts_into_the_recorded_thread(self):
        self.announce([self.published()])
        self.discord.calls.clear()
        self.assertEqual(self.announce([self.published("1.1.0")]), (1, 1))
        (call,) = self.discord.calls
        self.assertEqual(call["url"], "https://discord.com/api/v10/channels/5001/messages")
        self.assertEqual(call["body"]["content"], "<@12345> uploaded **v1.1.0**\nA mod")
        self.assertEqual(call["body"]["allowed_mentions"], {"parse": [], "users": ["12345"]})
        self.assertEqual(build.thread_id_from_notes(self.notes()), "5001")

    def test_a_deleted_thread_is_recreated_and_the_line_rewritten(self):
        tag = build.mod_tag("12345.TestMod")
        self.client.create_release(tag, "Test Mod")
        self.client.set_release_notes(tag, "Some text\n\ndiscord-thread: 77\n\nmore text")
        for status in (404, 403):
            self.client.set_release_notes(tag, "Some text\n\ndiscord-thread: 77\n\nmore text")
            self.discord.calls.clear()
            self.discord.script = [(status, {"message": "gone"})]
            self.assertEqual(self.announce([self.published("2.0.0")]), (1, 1))
            self.assertEqual([c["url"].rsplit("/", 2)[-2:] for c in self.discord.calls],
                             [["77", "messages"], ["900", "threads"]])
            self.assertEqual(self.notes(), f"Some text\n\ndiscord-thread: {self.discord._next_id}\n\nmore text")

    def test_other_discord_errors_leave_the_mapping_alone(self):
        tag = build.mod_tag("12345.TestMod")
        self.client.create_release(tag, "Test Mod")
        self.client.set_release_notes(tag, "discord-thread: 77")
        self.discord.script = [(500, None)]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.announce([self.published()]), (0, 1))
        self.assertEqual(len(self.discord.calls), 1)
        self.assertEqual(self.notes(), "discord-thread: 77")

    def test_rejection_notice(self):
        ev = self.rejected(title="Ev`il @everyone", reason="x" * 400)
        self.assertEqual(self.announce([ev]), (1, 1))
        (call,) = self.discord.calls
        self.assertEqual(call["url"], "https://discord.com/api/v10/channels/800/messages")
        self.assertEqual(call["body"]["allowed_mentions"], {"parse": [], "users": ["12345"]})
        self.assertEqual(call["body"]["content"],
                         "<@12345> your upload of **Evil everyone** was not accepted: " + "x" * 300)

    def test_rejection_without_a_notices_channel_is_only_logged(self):
        env = {k: v for k, v in self.ENV.items() if k != "NOTICES_CHANNEL_ID"}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(self.announce([self.rejected()], env), (1, 1))
        self.assertEqual(self.discord.calls, [])
        self.assertIn("bad package", out.getvalue())

    def test_user_text_is_cleaned_and_clipped(self):
        ev = self.published(title="`@Big` " + "t" * 300, description="@here `code` " + "d" * 600,
                            version="v@1" + "9" * 80)
        self.announce([ev])
        body = self.discord.calls[0]["body"]
        self.assertEqual(body["name"], ("Big " + "t" * 300)[:100])
        content = body["message"]["content"]
        self.assertNotIn("@here", content)
        self.assertNotIn("`", content)
        self.assertLessEqual(len(content), 2000)
        self.assertEqual(body["message"]["allowed_mentions"]["parse"], [])

    def test_forum_tags_are_capped_and_a_bad_map_is_ignored(self):
        env = dict(self.ENV, FORUM_TAG_IDS=json.dumps({f"T{i}": str(i) for i in range(9)}))
        self.announce([self.published(tags=[f"T{i}" for i in range(9)])], env)
        self.assertEqual(self.discord.calls[0]["body"]["applied_tags"], ["0", "1", "2", "3", "4"])
        self.discord.calls.clear()
        self.client.set_release_notes(build.mod_tag("12345.TestMod"), "")
        for bad in ("{oops", "[]"):
            self.discord.calls.clear()
            self.client.set_release_notes(build.mod_tag("12345.TestMod"), "")
            self.announce([self.published()], dict(self.ENV, FORUM_TAG_IDS=bad))
            self.assertEqual(self.discord.calls[0]["body"]["applied_tags"], [])

    def test_a_failing_event_does_not_stop_the_others(self):
        self.client.create_release(build.mod_tag("12345.Other"), "Other")
        self.discord.script = [(500, None)]
        events = [self.published(), self.published(identifier="12345.Other", title="Other"),
                  {"status": "published"}, "junk", self.rejected()]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.announce(events), (2, 5))
        self.assertEqual(len(self.discord.calls), 3)
        self.assertEqual(self.notes(), "")
        self.assertEqual(build.thread_id_from_notes(self.notes("12345.Other")), "5001")

    def test_a_rate_limit_is_retried_once(self):
        self.discord.script = [(429, {"retry_after": 0.5}), (200, {"id": "42"})]
        self.assertEqual(self.announce([self.published()]), (1, 1))
        self.assertEqual(self.discord.sleeps, [0.5])
        self.assertEqual(len(self.discord.calls), 2)
        self.assertEqual(build.thread_id_from_notes(self.notes()), "42")

    def test_the_rate_limit_wait_is_capped_and_a_second_429_fails(self):
        self.discord.script = [(429, {"retry_after_ms": 60000}), (429, {"retry_after": 1})]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.announce([self.published()]), (0, 1))
        self.assertEqual(self.discord.sleeps, [5.0])
        self.assertEqual(len(self.discord.calls), 2)
        self.assertEqual(self.notes(), "")

    def test_notes_line_helpers(self):
        self.assertIsNone(build.thread_id_from_notes("nothing here"))
        self.assertEqual(build.thread_id_from_notes("a\r\ndiscord-thread: 9\r\nb"), "9")
        self.assertEqual(build.notes_with_thread("", "5"), "discord-thread: 5")
        self.assertEqual(build.notes_with_thread("Mod\n", "5"), "Mod\n\ndiscord-thread: 5")
        self.assertEqual(build.notes_with_thread("x\ndiscord-thread: 1\ny", "5"), "x\ndiscord-thread: 5\ny")


class TestAnnounceCli(Base):
    def run_cli(self, results: str, env: dict) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(ROOT / "build.py"), "announce", "--results", results,
                              "--client", "local", "--root", str(self.root)],
                             env=env, capture_output=True, text=True, cwd=str(ROOT))

    def clean_env(self) -> dict:
        drop = ("DISCORD_BOT_TOKEN", "FORUM_CHANNEL_ID", "NOTICES_CHANNEL_ID", "FORUM_TAG_IDS", "SITE_URL")
        return {k: v for k, v in os.environ.items() if k not in drop}

    def test_missing_env_is_a_noop(self):
        res = self.root / "res.json"
        res.write_text(json.dumps([{"status": "rejected"}]), encoding="utf-8")
        p = self.run_cli(str(res), self.clean_env())
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("not set", p.stdout)
        env = dict(self.clean_env(), DISCORD_BOT_TOKEN="t")  # no forum channel
        p = self.run_cli(str(res), env)
        self.assertEqual((p.returncode, "not set" in p.stdout), (0, True))

    def test_missing_or_broken_results_file_exits_zero(self):
        env = dict(self.clean_env(), DISCORD_BOT_TOKEN="tok-secret", FORUM_CHANNEL_ID="1")
        self.assertEqual(self.run_cli(str(self.root / "nope.json"), env).returncode, 0)
        bad = self.root / "bad.json"
        bad.write_text("{oops", encoding="utf-8")
        p = self.run_cli(str(bad), env)
        self.assertEqual(p.returncode, 0)
        self.assertIn("not valid JSON", p.stderr)
        self.assertNotIn("tok-secret", p.stdout + p.stderr)

    def test_announce_cli_function_uses_the_injected_http(self):
        res = self.root / "res.json"
        ev = {"eventId": "rej:1:g", "status": "rejected", "uploaderId": "1", "reason": "no", "title": None}
        res.write_text(json.dumps([ev]), encoding="utf-8")
        fake = FakeDiscord()
        args = build.argparse.Namespace(results=str(res), client="local", root=str(self.root),
                                        owner=OWNER, repo=REPO)
        env = {"DISCORD_BOT_TOKEN": "t", "FORUM_CHANNEL_ID": "1", "NOTICES_CHANNEL_ID": "2"}
        self.assertEqual(build.announce_cli(args, env, http=fake, sleep=fake.sleep), 0)
        self.assertEqual([c["url"].rsplit("/", 2)[-2:] for c in fake.calls], [["2", "messages"]])
        self.assertIn("unknown", fake.calls[0]["body"]["content"])


class TestAssetLabels(Base):
    """Package zips carry `<content_hash>:<package_fingerprint>` labels; the
    duplicate and nothing-changed checks read them without downloading."""

    def upload(self, uid: str, name: str, **kw) -> None:
        make_package(self.root / f"{name}.zip", **kw)
        self.to_inbox(self.root / f"{name}.zip", uid, f"{S(uid)}__{self.next_ts()}__{name}.zip")

    def mod_downloads(self) -> list[str]:
        calls: list[str] = []
        orig = self.client.download_asset

        def counting(tag, name, dest):
            if tag != build.INBOX_TAG:
                calls.append(f"{tag}/{name}")
            orig(tag, name, dest)

        self.client.download_asset = counting
        return calls

    def test_uploaded_zip_label_matches_its_content_and_fingerprint(self):
        self.upload("12345", "a", title="Lab Mod")
        self.run_process()
        (asset,) = [a for a in self.client.list_assets(build.mod_tag("12345.LabMod")) if a.name.endswith(".zip")]
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(build.mod_tag("12345.LabMod"), asset.name, z)
            members = build.zip_members(z.read_bytes())
        self.assertEqual(asset.label, f"{build.content_hash(members)}:{build.package_fingerprint(members)}")
        self.assertEqual(build.parse_asset_label(asset.label),
                         (build.content_hash(members), build.package_fingerprint(members)))

    def test_label_files_are_not_listed_as_assets(self):
        self.upload("12345", "a", title="Lab Mod")
        self.run_process()
        names = [a.name for a in self.client.list_assets(build.mod_tag("12345.LabMod"))]
        self.assertEqual(sorted(names), ["Lab-Mod-1.0.0.zip"])
        self.client.delete_asset(build.mod_tag("12345.LabMod"), "Lab-Mod-1.0.0.zip")
        self.assertEqual(self.client.list_assets(build.mod_tag("12345.LabMod")), [])
        self.assertEqual(list((self.root / "meta" / build.mod_tag("12345.LabMod") / "labels").iterdir()), [])

    def test_parse_asset_label(self):
        good = "a" * 64 + ":" + "b" * 64
        self.assertEqual(build.parse_asset_label(good), ("a" * 64, "b" * 64))
        for bad in ("", None, "a" * 64, "a" * 64 + ":" + "b" * 63, "X" * 64 + ":" + "b" * 64):
            self.assertIsNone(build.parse_asset_label(bad))

    def test_nothing_changed_and_duplicates_download_nothing_from_mod_releases(self):
        downloads = self.mod_downloads()
        self.upload("12345", "a", title="Lab Mod", payload="same")
        self.run_process()
        self.upload("12345", "b", title="Lab Mod", payload="same", identifier="12345.LabMod")
        _, err = self._run_stderr()
        self.assertIn("nothing changed", err)
        self.upload("67890", "c", title="Lab Mod", payload="same")
        _, err = self._run_stderr()
        self.assertIn("duplicate of the existing mod", err)
        self.assertEqual(downloads, [])

    def _run_stderr(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            summary = self.run_process()
        return summary, err.getvalue()

    def test_an_unlabelled_asset_is_unknown_and_never_matches(self):
        self.upload("12345", "a", title="Lab Mod", payload="same")
        self.run_process()
        tag = build.mod_tag("12345.LabMod")
        (self.root / "meta" / tag / "labels" / "Lab-Mod-1.0.0.zip").unlink()
        out = io.StringIO()
        self.upload("12345", "b", title="Lab Mod", payload="same", identifier="12345.LabMod")
        with contextlib.redirect_stdout(out):
            summary = self.run_process()
        self.assertEqual(summary, {"ok": 1, "rejected": 0})
        self.assertIn("no usable label", out.getvalue())
        self.assertEqual(sorted(a.name for a in self.client.list_assets(tag) if a.name.endswith(".zip")),
                         ["Lab-Mod-1.0.0-2.zip", "Lab-Mod-1.0.0.zip"])

    def test_gh_client_upload_uses_the_path_hash_label_syntax(self):
        calls: list[list[str]] = []
        gh = build.GhClient("o", "r")
        gh._run = lambda args, cwd=None: calls.append(args) or ""
        src = pathlib.Path("x") / "p.zip"
        gh.upload_asset("t", src, "p.zip", "lab:el")
        gh.upload_asset("t", src, "p.zip")
        self.assertEqual(calls[0], ["release", "upload", "t", f"{src}#lab:el"])
        self.assertEqual(calls[1], ["release", "upload", "t", str(src)])

    def test_gh_client_reads_labels_and_notes(self):
        gh = build.GhClient("o", "r")
        release = {"body": "hello\r\ndiscord-thread: 5", "assets": [
            {"name": "a.zip", "size": 1, "created_at": "2026-01-01T00:00:00Z", "label": "L"},
            {"name": "b.zip", "size": 1, "created_at": "2026-01-01T00:00:00Z", "label": None}]}
        gh._api = lambda path: release
        self.assertEqual([a.label for a in gh.get_release("t").assets], ["L", ""])
        self.assertEqual(gh.release_notes("t"), "hello\ndiscord-thread: 5")
        calls: list[list[str]] = []
        gh._run = lambda args, cwd=None: calls.append(args) or ""
        gh.set_release_notes("t", "new notes")
        self.assertEqual(calls, [["release", "edit", "t", "--notes", "new notes"]])

    def test_local_client_release_notes_round_trip(self):
        self.client.create_release("mod-x", "X")
        self.assertEqual(self.client.release_notes("mod-x"), "")
        self.client.set_release_notes("mod-x", "a\nb")
        self.assertEqual(self.client.release_notes("mod-x"), "a\nb")
        self.assertEqual(self.client.list_assets("mod-x"), [])


class TestDownloads(unittest.TestCase):
    """`downloads`: per-mod counts from the release assets' `download_count`
    (LocalClient seam: `client.downloads[(tag, name)]`)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._tmp.name)
        self.catalog = self.root / "catalog.json"
        self.client = build.LocalClient(self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def write_catalog(self, mods) -> None:
        with self.catalog.open("w", encoding="utf-8") as f:
            json.dump({"mods": mods}, f)

    def entry(self, identifier: str, tag: str, asset: str, url: str | None = None) -> dict:
        return {"id": identifier,
                "file": url or f"https://github.com/{OWNER}/{REPO}/releases/download/{tag}/{asset}"}

    def upload(self, tag: str, name: str) -> None:
        self.client.create_release(tag, tag)
        src = self.root / f"src-{name}"
        src.write_bytes(b"x" * 8)
        self.client.upload_asset(tag, src, name)

    def payload(self, assets_by_tag: dict) -> dict:
        with self.catalog.open(encoding="utf-8") as f:
            catalog = json.load(f)
        return build.downloads_payload(catalog, assets_by_tag, "2026-01-01T00:00:00Z")

    def test_total_sums_every_zip_version_and_latest_matches_the_file_url(self):
        self.write_catalog([self.entry("12345.Foo", "mod-12345.foo-abc", "Foo-1.1.0.zip")])
        for name in ("Foo-1.0.0.zip", "Foo-1.1.0.zip", "cover-1234abcd.png", "notes.txt"):
            self.upload("mod-12345.foo-abc", name)
        self.client.downloads.update({
            ("mod-12345.foo-abc", "Foo-1.0.0.zip"): 10,
            ("mod-12345.foo-abc", "Foo-1.1.0.zip"): 20,
            ("mod-12345.foo-abc", "cover-1234abcd.png"): 100,
            ("mod-12345.foo-abc", "notes.txt"): 5})
        p = self.payload(self.client.release_assets("mod-"))
        self.assertEqual(p, {"generated": "2026-01-01T00:00:00Z",
                            "mods": {"12345.Foo": {"total": 30, "latest": 20}}})

    def test_uppercase_zip_counted_cover_and_non_zip_excluded(self):
        self.write_catalog([self.entry("12345.Bar", "mod-12345.bar-def", "Bar-1.0.0.zip")])
        for name in ("Bar-1.0.0.zip", "Bar-2.0.0.ZIP", "cover-abcdef01.png", "readme.md"):
            self.upload("mod-12345.bar-def", name)
        self.client.downloads.update({
            ("mod-12345.bar-def", "Bar-1.0.0.zip"): 1,
            ("mod-12345.bar-def", "Bar-2.0.0.ZIP"): 7,
            ("mod-12345.bar-def", "cover-abcdef01.png"): 9,
            ("mod-12345.bar-def", "readme.md"): 3})
        p = self.payload(self.client.release_assets("mod-"))
        self.assertEqual(p["mods"]["12345.Bar"], {"total": 8, "latest": 1})

    def test_release_without_zip_assets_has_total_zero(self):
        self.write_catalog([self.entry("12345.NoZip", "mod-12345.nozip-abc", "Gone.zip")])
        self.upload("mod-12345.nozip-abc", "cover-0123abcd.png")
        self.client.downloads[("mod-12345.nozip-abc", "cover-0123abcd.png")] = 4
        p = self.payload(self.client.release_assets("mod-"))
        self.assertEqual(p["mods"]["12345.NoZip"], {"total": 0})

    def test_missing_release_omitted_named_asset_missing_omits_latest_only(self):
        self.write_catalog([self.entry("12345.Only", "mod-12345.only-abc", "Missing.zip"),
                           self.entry("12345.Kept", "mod-12345.kep-abc", "Gone.zip")])
        self.upload("mod-12345.kep-abc", "Kept.zip")
        self.client.downloads[("mod-12345.kep-abc", "Kept.zip")] = 11
        p = self.payload(self.client.release_assets("mod-"))
        self.assertNotIn("12345.Only", p["mods"])
        self.assertEqual(p["mods"]["12345.Kept"], {"total": 11})

    def test_non_release_file_urls_are_skipped(self):
        self.write_catalog([
            self.entry("12345.A", "mod-12345.a-abc", "A.zip",
                      url="https://other.example/foo/bar.zip"),
            self.entry("12345.B", "mod-12345.b-abc", "B.zip",
                      url=f"https://github.com/{OWNER}/{REPO}/releases/download"),
            self.entry("12345.C", "mod-12345.c-abc", "C.zip",
                      url=f"https://github.com/{OWNER}/{REPO}/releases/download/mod-12345.c-abc"),
            self.entry("12345.D", "mod-12345.d-abc", "D.zip"),
        ])
        self.upload("mod-12345.d-abc", "D.zip")
        self.client.downloads[("mod-12345.d-abc", "D.zip")] = 2
        p = self.payload(self.client.release_assets("mod-"))
        self.assertEqual(p["mods"], {"12345.D": {"total": 2, "latest": 2}})

    def test_percent_encoded_tag_and_asset_are_decoded(self):
        tag = "mod-12345.foo-abc"
        self.write_catalog([self.entry("12345.Pct", tag, "Foo%20v1.zip"),
                           self.entry("12345.Pct2", "mod-12345%2Epct-abc", "Foo%20v2.zip")])
        self.upload(tag, "Foo v1.zip")
        self.upload("mod-12345.pct-abc", "Foo v2.zip")
        self.client.downloads[(tag, "Foo v1.zip")] = 3
        self.client.downloads[("mod-12345.pct-abc", "Foo v2.zip")] = 4
        p = self.payload(self.client.release_assets("mod-"))
        self.assertEqual(p["mods"], {"12345.Pct": {"total": 3, "latest": 3},
                                    "12345.Pct2": {"total": 4, "latest": 4}})

    def test_inbox_release_never_contributes(self):
        self.write_catalog([self.entry("12345.Foo", "mod-12345.foo-abc", "Foo.zip")])
        self.upload("mod-12345.foo-abc", "Foo.zip")
        self.client.create_release("inbox", "Inbox")
        self.client.upload_asset("inbox", self.root / "src-Foo.zip", "inbox.zip")
        self.client.downloads[("inbox", "inbox.zip")] = 7
        assets = self.client.release_assets("mod-")
        self.assertNotIn("inbox", assets)
        p = self.payload(assets)
        self.assertEqual(p["mods"], {"12345.Foo": {"total": 0, "latest": 0}})

    def test_localclient_release_assets_and_get_release_carry_the_seam_counts(self):
        self.upload("mod-12345.foo-abc", "Foo-1.0.0.zip")
        self.upload("mod-12345.foo-abc", "Foo-2.0.0.zip")
        self.client.downloads[("mod-12345.foo-abc", "Foo-1.0.0.zip")] = 5
        assets = self.client.release_assets("mod-")
        by_name = {a.name: a for a in assets["mod-12345.foo-abc"]}
        self.assertEqual(by_name["Foo-1.0.0.zip"].downloads, 5)
        self.assertEqual(by_name["Foo-2.0.0.zip"].downloads, 0)
        self.assertEqual({a.name: a.downloads for a in self.client.get_release("mod-12345.foo-abc").assets},
                        {"Foo-1.0.0.zip": 5, "Foo-2.0.0.zip": 0})

    def test_output_is_stable_for_a_fixed_now(self):
        self.write_catalog([self.entry("12345.Foo", "mod-12345.foo-abc", "Foo.zip"),
                           self.entry("12345.Bar", "mod-12345.bar-def", "Bar.zip")])
        self.upload("mod-12345.foo-abc", "Foo.zip")
        self.upload("mod-12345.bar-def", "Bar.zip")
        self.client.downloads[("mod-12345.foo-abc", "Foo.zip")] = 1
        self.client.downloads[("mod-12345.bar-def", "Bar.zip")] = 2
        with self.catalog.open(encoding="utf-8") as f:
            catalog = json.load(f)
        p1 = build.downloads_payload(catalog, self.client.release_assets("mod-"), "2026-01-01T00:00:00Z")
        p2 = build.downloads_payload(catalog, self.client.release_assets("mod-"), "2026-01-01T00:00:00Z")
        self.assertEqual(p1, p2)
        self.assertEqual(json.dumps(p1, indent=2, ensure_ascii=False),
                         json.dumps(p2, indent=2, ensure_ascii=False))
        self.assertEqual(list(p1["mods"]), ["12345.Bar", "12345.Foo"])  # sorted keys

    def test_zero_mods_catalog_gives_an_empty_mods_object(self):
        self.write_catalog([])
        p = self.payload(self.client.release_assets("mod-"))
        self.assertEqual(p, {"generated": "2026-01-01T00:00:00Z", "mods": {}})


class TestDownloadsCli(unittest.TestCase):
    """The `downloads` subcommand: atomic write, fail hard (non-zero, no file)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._tmp.name)
        self.catalog = self.root / "catalog.json"
        self.out = self.root / "downloads.json"
        (self.root / "releases").mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self, extra: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "downloads",
             "--client", "local", "--root", str(self.root),
             "--catalog", str(self.catalog), "--out", str(self.out)] + extra,
            capture_output=True, text=True, cwd=str(ROOT))

    def test_missing_catalog_exits_non_zero_and_leaves_no_file(self):
        p = self.run_cli([])
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(self.out.exists())
        self.assertEqual(len([l for l in p.stderr.splitlines() if l.strip()]), 1)

    def test_unreadable_catalog_exits_non_zero_and_leaves_no_file(self):
        self.catalog.write_text("not json", encoding="utf-8")
        p = self.run_cli([])
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(self.out.exists())

    def test_writes_the_payload_and_zero_mods_is_empty(self):
        self.catalog.write_text(json.dumps({"mods": []}), encoding="utf-8")
        p = self.run_cli([])
        self.assertEqual(p.returncode, 0, p.stderr)
        data = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(data["mods"], {})
        self.assertRegex(data["generated"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertTrue(self.out.read_text(encoding="utf-8").endswith("\n"))

    def test_counts_flow_from_the_release_into_the_file(self):
        client = build.LocalClient(self.root)
        client.create_release("mod-12345.foo-abc", "Foo")
        for name in ("Foo-1.0.0.zip", "Foo-1.1.0.zip"):
            src = self.root / f"src-{name}"
            src.write_bytes(b"x" * 8)
            client.upload_asset("mod-12345.foo-abc", src, name)
        self.catalog.write_text(json.dumps({"mods": [{
            "id": "12345.Foo",
            "file": f"https://github.com/{OWNER}/{REPO}/releases/download/mod-12345.foo-abc/Foo-1.1.0.zip"}]}),
            encoding="utf-8")
        p = self.run_cli([])
        self.assertEqual(p.returncode, 0, p.stderr)
        # the fresh LocalClient reads no seam, so every count is 0 (shown, not omitted)
        self.assertEqual(json.loads(self.out.read_text(encoding="utf-8"))["mods"],
                        {"12345.Foo": {"total": 0, "latest": 0}})


if __name__ == "__main__":
    unittest.main()
