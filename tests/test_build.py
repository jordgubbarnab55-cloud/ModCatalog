"""Offline tests for the build.py pipeline (LocalClient, synthetic packages).

Run: python -m unittest discover -s tests
"""

import base64
import contextlib
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import uuid
import unittest
import zipfile

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
        self.catalog.unlink()  # forget 111.DupMod: a duplicate gets stored (as before this rule)
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
        """A loose set (+ optional metadata.json) in the inbox."""
        self.client.create_release(build.INBOX_TAG, "inbox")
        d = self.client._release_dir(build.INBOX_TAG)
        files = [("mod.pak", payload), ("mod.ucas", b"UCAS"), ("mod.utoc", utoc or fake_toc())]
        manifest: dict = {"files": [{"name": n, "sha256": hashlib.sha256(b).hexdigest(), "parts": 1}
                                    for n, b in files]}
        raw = json.dumps(metadata).encode("utf-8") if metadata is not None else None
        if raw is not None:
            manifest["metadata"] = {"sha256": hashlib.sha256(raw).hexdigest()}
        stamp = S(uid, username)
        (d / f"{stamp}__{upload_id}__manifest.json").write_bytes(json.dumps(manifest).encode("utf-8"))
        for idx, (n, b) in enumerate(files):
            (d / f"{stamp}__{upload_id}__f{idx}__p0of1__{n}").write_bytes(b)
        if raw is not None:
            (d / f"{stamp}__{upload_id}__metadata.json").write_bytes(raw)

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
            self.assertIsNone(build.parse_upload_metadata(
                json.dumps(self.meta(identifier=blank)).encode())["target"])

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
        # metadata.json update, image absent, a package WITH its own cover: the current cover wins
        self.set_upload("111", "u2", self.meta("Cool Mod", "2.0", identifier="111.CoolMod"),
                        utoc=with_cover("Cool Mod", "2.0", jpeg), payload=b"P2")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()["111.CoolMod"]["cover"], cover)
        self.assertEqual(self.stored("111.CoolMod", "Cool-Mod-2.0.zip")[1]["image"], png)
        # no metadata.json (zip mode): the package's own trailer is the intent, its cover is kept
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
        self.assertEqual(build.parse_upload_metadata(b'{"title":"T","author":"a","identifier":"777.TestMod"}')
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
    """Upload sets: loose files or one .zip, plus an optional metadata.json
    that the runner applies with `apply_metadata`."""

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
                   declare_metadata: bool = True, sha: str | None = None) -> None:
        self.client.create_release(build.INBOX_TAG, "inbox")
        manifest: dict = {"files": [{"name": n, "sha256": hashlib.sha256(b).hexdigest(), "parts": 1}
                                    for n, b in files]}
        if metadata is not None and declare_metadata:
            manifest["metadata"] = {"sha256": sha or hashlib.sha256(metadata).hexdigest()}
        self.upload_raw_bytes(f"{S(uploader)}__{uid}__manifest.json", json.dumps(manifest).encode("utf-8"))
        for idx, (n, b) in enumerate(files):
            self.upload_raw_bytes(f"{S(uploader)}__{uid}__f{idx}__p0of1__{n}", b)
        if metadata is not None:
            self.upload_raw_bytes(f"{S(uploader)}__{uid}__metadata.json", metadata)

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
        bad = [self.meta_json(title=""), self.meta_json(tags=["a"] * 11), b"{not json",
               self.meta_json(image={"mime": "image/png", "data": "***"}),
               self.meta_json(image={"mime": "image/gif", "data": ""}), b"[]"]
        for n, raw in enumerate(bad):
            self.set_upload("555", f"bad-{n}", self.loose(fake_toc()), raw)
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": len(bad)})
        self.assertEqual(self.inbox_names(), [])
        self.assertEqual(self.client.list_tags(build.MOD_TAG_PREFIX), [])

    def test_metadata_sha_mismatch_is_rejected(self):
        self.set_upload("555", "m-11", self.loose(fake_toc()), self.meta_json(), sha="0" * 64)
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        self.assertEqual(self.inbox_names(), [])

    def test_declared_metadata_not_yet_arrived_waits(self):
        self.set_upload("555", "m-12", self.loose(fake_toc()), self.meta_json())
        self.client.delete_asset(build.INBOX_TAG, f"{S('555')}__m-12__metadata.json")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 0})
        self.assertEqual(len(self.inbox_names()), 4)

    def test_undeclared_metadata_is_ignored(self):
        guid = str(uuid.uuid4())
        self.set_upload("555", "m-13", self.loose(self.trailer_utoc(guid, "Untouched")),
                        self.meta_json(), declare_metadata=False)
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()["555.Untouched"]["name"], "Untouched")
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

    def test_parse_inbox_name_metadata(self):
        self.assertEqual(build.parse_inbox_name(f"{S('555')}__u-1__metadata.json"),
                         {"kind": "metadata", "uploader": build.Uploader("555", "user555"), "upload_id": "u-1"})

    def test_apply_metadata_unit(self):
        meta = build.parse_upload_metadata(self.meta_json(guid=None))
        out = build.apply_metadata(fake_toc(), meta, None, author="alice", identifier="555.EditedTitle")
        got = build.trailer.read_trailer(out)
        self.assertEqual((got["title"], got["author"], got["identifier"], got["tags"]),
                         ("Edited Title", "alice", "555.EditedTitle", ["Skin"]))
        again = build.apply_metadata(out, build.parse_upload_metadata(self.meta_json(title="Second")),
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
    package or metadata.json says."""

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


if __name__ == "__main__":
    unittest.main()
