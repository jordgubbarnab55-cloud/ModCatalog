"""Offline tests for the build.py pipeline (LocalClient, synthetic packages).

Run: python -m unittest discover -s tests
"""

import base64
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
                 game_version: str = "") -> pathlib.Path:
    """Builds a synthetic package zip (fake utoc/ucas/pak bytes + a real trailer)."""
    if guid is None:
        guid = str(uuid.uuid4())
    if corrupt:
        dest.write_bytes(b"\x00\x01\x02 not a zip at all " + uuid.uuid4().bytes * 4)
        return dest
    meta = {"title": title, "author": author, "description": description,
            "version": version, "guid": guid, "image": image, "tags": tags or [],
            "game_version": game_version}
    utoc = fake_toc()
    if not no_trailer:
        utoc = trailer.write_trailer(utoc, meta)[0]
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        if include_pak:
            z.writestr("mod.pak", b"FAKE-PAK-" + guid.encode() + b"\x00" * 1024)
        if include_ucas:
            z.writestr("mod.ucas", b"FAKE-UCAS-" + guid.encode() + b"\x00" * 1024)
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

    def stored(self, guid: str, name: str) -> tuple:
        """(member names, trailer metadata, .utoc bytes) of a stored package zip."""
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(f"mod-{guid}", name, z)
            with zipfile.ZipFile(z) as zf:
                names = zf.namelist()
                return names, build.validate_package(z), zf.read(next(n for n in names if n.endswith(".utoc")))


class TestGoodPackage(Base):
    def test_entry_fields_sha_and_urls(self):
        guid = str(uuid.uuid4())
        image = make_image("png")
        make_package(self.root / "a.zip", guid=guid, image=image)
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__A.zip")

        summary = self.run_process()
        self.assertEqual(summary, {"ok": 1, "rejected": 0})

        e = self.catalog_mods()[guid]
        tag = f"mod-{guid}"
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
        self.assertIn(f"{guid}-cover-{hashlib.sha256(image['data']).hexdigest()[:8]}.png", names)

    def test_no_cover_omits_field(self):
        guid = str(uuid.uuid4())
        make_package(self.root / "a.zip", guid=guid)
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__A.zip")
        self.run_process()
        self.assertNotIn("cover", self.catalog_mods()[guid])


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
    def test_same_version_rejected_new_version_wins(self):
        guid = str(uuid.uuid4())
        make_package(self.root / "v1.zip", title="Ver Mod", version="1.0.0", guid=guid)
        self.to_inbox(self.root / "v1.zip", "12345", f"{S('12345')}__1__v1.zip")
        self.run_process()

        # same guid + version (different bytes) -> rejected, original stays
        make_package(self.root / "v1b.zip", title="Ver Mod", version="1.0.0", guid=guid)
        self.to_inbox(self.root / "v1b.zip", "12345", f"{S('12345')}__2__v1b.zip")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        tag = f"mod-{guid}"
        names = {a.name for a in self.client.list_assets(tag)}
        self.assertEqual(names, {"Ver-Mod-1.0.0.zip"})
        self.assertEqual(self.inbox_names(), [])

        # a new version becomes the main entry; the old asset stays
        make_package(self.root / "v2.zip", title="Ver Mod", version="1.1.0", guid=guid)
        self.to_inbox(self.root / "v2.zip", "12345", f"{S('12345')}__3__v2.zip")
        self.run_process()
        e = self.catalog_mods()[guid]
        self.assertEqual(e["version"], "1.1.0")
        self.assertTrue(e["file"].endswith("Ver-Mod-1.1.0.zip"))
        names = {a.name for a in self.client.list_assets(tag)}
        self.assertIn("Ver-Mod-1.0.0.zip", names)
        self.assertIn("Ver-Mod-1.1.0.zip", names)


class TestOwnership(Base):
    def test_first_uploader_owns(self):
        guid = str(uuid.uuid4())
        make_package(self.root / "a.zip", guid=guid)
        self.to_inbox(self.root / "a.zip", "111", f"{S('111')}__1__a.zip")
        self.run_process()
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "111")

        # a different uploader is rejected, even with a new version
        make_package(self.root / "b.zip", version="2.0.0", guid=guid)
        self.to_inbox(self.root / "b.zip", "222", f"{S('222')}__2__b.zip")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "111")

        # an admin (ADMIN_DISCORD_IDS) bypasses the check
        make_package(self.root / "c.zip", version="3.0.0", guid=guid)
        self.to_inbox(self.root / "c.zip", ADMIN, f"{S(ADMIN)}__3__c.zip")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "111")  # owner kept
        self.assertEqual(self.catalog_mods()[guid]["version"], "3.0.0")

    def test_seeding_is_an_upload_by_the_given_user(self):
        guid = str(uuid.uuid4())
        (self.root / "legacy").mkdir()
        make_package(self.root / "legacy" / "s.zip", guid=guid, author="Whoever Wrote It")
        sources = build.inbox_items_from_dir(self.root / "legacy", build.Uploader("777", "seeder"))
        self.processor.run(sources)
        e = self.catalog_mods()[guid]
        self.assertEqual((e["uploader"], e["author"]), ("777", "seeder"))
        self.assertEqual(self.stored(guid, "Test-Mod-1.0.0.zip")[1]["identifier"], "777.TestMod")

        make_package(self.root / "d.zip", version="2.0.0", guid=guid)
        self.to_inbox(self.root / "d.zip", "444", f"{S('444')}__3__d.zip")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})  # 777 owns it now

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
        """Two inbox uploads of one new GUID in the same run: the first wins."""
        guid = str(uuid.uuid4())
        make_package(self.root / "a.zip", guid=guid, title="Race Mod")
        self.to_inbox(self.root / "a.zip", "111", f"{S('111')}__1__a.zip")
        make_package(self.root / "b.zip", version="2.0.0", guid=guid, title="Race Mod")
        self.to_inbox(self.root / "b.zip", "222", f"{S('222')}__2__b.zip")
        summary = self.run_process()
        self.assertEqual(summary, {"ok": 1, "rejected": 1})
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "111")


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
        make_package(self.root / "v2.zip", title="RB Mod", version="1.1.0", guid=guid)
        self.to_inbox(self.root / "v2.zip", "12345", f"{S('12345')}__2__v2.zip")
        self.run_process()
        return guid

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
        self.assertEqual(data["name"], build.CATALOG_NAME)


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
        e = self.catalog_mods()[guid]
        self.assertEqual(e["uploader"], "555")
        self.assertEqual(e["name"], "Raw Mod")
        tag = f"mod-{guid}"
        zips = [a.name for a in self.client.list_assets(tag) if a.name.endswith(".zip")]
        self.assertEqual(zips, ["Raw-Mod-1.0.0.zip"])
        self.assertEqual(self.inbox_names(), [])  # manifest + parts all deleted
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(tag, "Raw-Mod-1.0.0.zip", z)
            meta = build.validate_package(z)
            self.assertEqual(meta["guid"], guid)
            with zipfile.ZipFile(z) as zf:
                self.assertEqual(sorted(zf.namelist()), ["mod.pak", "mod.ucas", "mod.utoc"])

    def test_multi_part_file_reassembles(self):
        guid = str(uuid.uuid4())
        big_ucas = b"U" * 25000  # several parts with part_size=8000 (utoc gets 9)
        self.raw_set("555", "u-6", self.trailer_utoc(guid), big_ucas, b"PAK", part_size=8000)
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(f"mod-{guid}", "Raw-Mod-1.0.0.zip", z)
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
        self.assertIsNone(self.client.get_release(f"mod-{guid}"))

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
        self.assertIsNone(self.client.get_release(f"mod-{guid}"))

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

    def stored_package(self, guid: str, name: str) -> tuple:
        with tempfile.TemporaryDirectory() as td:
            z = pathlib.Path(td) / "p.zip"
            self.client.download_asset(f"mod-{guid}", name, z)
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
        (guid, e), = self.catalog_mods().items()
        self.assertEqual((e["name"], e["author"], e["version"], e["gameVersion"], e["tags"]),
                         ("Edited Title", "user555", "2.0.0", "5.6", ["Skin"]))
        names, meta, _ = self.stored_package(guid, "Edited-Title-2.0.0.zip")
        self.assertEqual(sorted(names), ["mod.pak", "mod.ucas", "mod.utoc"])
        self.assertEqual((meta["author"], meta["identifier"]), ("user555", "555.EditedTitle"))
        self.assertEqual(self.inbox_names(), [])

    def test_loose_set_with_trailer_keeps_guid_and_cover(self):
        guid = str(uuid.uuid4())
        image = make_image("png")
        utoc = build.trailer.write_trailer(fake_toc(), {
            "title": "Old", "author": "Old Author", "description": "", "version": "1.0.0",
            "guid": guid, "image": image, "tags": []})[0]
        self.set_upload("555", "m-2", self.loose(utoc), self.meta_json())
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        e = self.catalog_mods()[guid]
        self.assertEqual(e["name"], "Edited Title")
        self.assertIn("-cover-", e["cover"])  # image key absent: the package's cover is kept
        _, meta, _ = self.stored_package(guid, "Edited-Title-2.0.0.zip")
        self.assertEqual(meta["image"]["data"], image["data"])

    def test_metadata_removes_and_adds_a_cover(self):
        guid = str(uuid.uuid4())
        utoc = build.trailer.write_trailer(fake_toc(), {
            "title": "Old", "author": "A", "description": "", "version": "1.0.0",
            "guid": guid, "image": make_image("png"), "tags": []})[0]
        self.set_upload("555", "m-3", self.loose(utoc), self.meta_json(image=None))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertNotIn("cover", self.catalog_mods()[guid])
        _, meta, _ = self.stored_package(guid, "Edited-Title-2.0.0.zip")
        self.assertIsNone(meta["image"])

        jpeg = make_image("jpeg")
        data = base64.b64encode(jpeg["data"]).decode("ascii")
        self.set_upload("555", "m-4", self.loose(utoc), self.meta_json(
            version="3.0.0", guid=guid, image={"mime": "image/jpeg", "data": data}))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertTrue(self.catalog_mods()[guid]["cover"].endswith(".jpg"))
        _, meta, _ = self.stored_package(guid, "Edited-Title-3.0.0.zip")
        self.assertEqual(meta["image"], jpeg)

    def test_zip_set_with_metadata_is_rewritten_and_drops_unrelated_members(self):
        guid = str(uuid.uuid4())
        utoc = build.trailer.write_trailer(fake_toc(), {
            "title": "Old", "author": "A", "description": "", "version": "1.0.0",
            "guid": guid, "tags": []})[0]
        blob = self.zip_bytes(utoc, nested=True, extra=True)
        self.set_upload("555", "m-5", [("Pack.zip", blob)], self.meta_json())
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()[guid]["name"], "Edited Title")
        names, meta, _ = self.stored_package(guid, "Edited-Title-2.0.0.zip")
        self.assertEqual(sorted(names), ["Content/Paks/mod.pak", "Content/Paks/mod.ucas", "Content/Paks/mod.utoc"])
        self.assertEqual(meta["guid"], guid)

    def test_zip_set_without_metadata_is_rezipped_with_forced_fields(self):
        guid = str(uuid.uuid4())
        utoc = self.trailer_utoc(guid, "Plain Zip")
        blob = self.zip_bytes(utoc, extra=True)
        self.set_upload("555", "m-6", [("Pack.zip", blob)])
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        names, meta, _ = self.stored_package(guid, "Plain-Zip-1.0.0.zip")
        self.assertEqual(sorted(names), ["mod.pak", "mod.ucas", "mod.utoc"])  # readme.txt dropped
        self.assertEqual((meta["author"], meta["identifier"]), ("user555", "555.PlainZip"))

    def test_loose_set_without_metadata_keeps_its_fields_but_forces_author(self):
        guid = str(uuid.uuid4())
        utoc = self.trailer_utoc(guid, "As Is")
        self.set_upload("555", "m-7", self.loose(utoc))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        names, meta, stored_utoc = self.stored_package(guid, "As-Is-1.0.0.zip")
        self.assertEqual((meta["title"], meta["version"], meta["description"], meta["guid"]),
                         ("As Is", "1.0.0", "raw", guid))
        self.assertEqual((meta["author"], meta["identifier"]), ("user555", "555.AsIs"))
        self.assertEqual(stored_utoc[:build.trailer.toc_end(build.trailer.parse_toc_header(utoc), utoc)],
                         utoc[:build.trailer.toc_end(build.trailer.parse_toc_header(utoc), utoc)])
        self.assertEqual(self.catalog_mods()[guid]["author"], "user555")

    def test_set_without_any_trailer_and_without_metadata_is_rejected(self):
        self.set_upload("555", "m-7b", self.loose(fake_toc()))
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        self.assertEqual(self.inbox_names(), [])

    def test_mismatched_guid_is_rejected_and_the_run_continues(self):
        guid = str(uuid.uuid4())
        utoc = self.trailer_utoc(guid, "Has Guid")
        self.set_upload("555", "m-8", self.loose(utoc), self.meta_json(guid=str(uuid.uuid4())))
        good = str(uuid.uuid4())
        self.set_upload("556", "m-9", self.loose(self.trailer_utoc(good, "Good One")))
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 1})
        self.assertEqual(list(self.catalog_mods()), [good])
        self.assertEqual(self.inbox_names(), [])

    def test_guid_on_a_package_without_trailer_is_rejected(self):
        self.set_upload("555", "m-10", self.loose(fake_toc()), self.meta_json(guid=str(uuid.uuid4())))
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
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
        self.assertEqual(self.catalog_mods()[guid]["name"], "Untouched")
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
        who = build.Uploader("555", "alice")
        meta = build.parse_upload_metadata(self.meta_json(guid=None))
        out = build.apply_metadata(fake_toc(), meta, None, who)
        got = build.trailer.read_trailer(out)
        self.assertEqual((got["title"], got["author"], got["identifier"], got["tags"]),
                         ("Edited Title", "alice", "555.EditedTitle", ["Skin"]))
        again = build.apply_metadata(out, build.parse_upload_metadata(self.meta_json(title="Second")),
                                     build.existing_trailer(out), who)
        self.assertEqual(build.trailer.read_trailer(again)["guid"], got["guid"])
        # no metadata: the package's own fields survive, author/identifier are forced
        forced = build.apply_metadata(out, None, build.existing_trailer(out), build.Uploader("9", "bob"))
        f = build.trailer.read_trailer(forced)
        self.assertEqual((f["title"], f["guid"], f["author"], f["identifier"]),
                         ("Edited Title", got["guid"], "bob", "9.EditedTitle"))
        with self.assertRaises(build.PackageError):
            build.apply_metadata(fake_toc(), None, None, who)


class TestVerifiedAuthors(Base):
    """The catalog's author is the uploader's Discord username, whatever the
    package or metadata.json says."""

    def upload(self, uid: str, name: str, *, username: str | None = None, title: str = "Verified Mod",
               version: str = "1.0.0", guid: str | None = None, author: str = "Self Declared") -> str:
        guid = guid or str(uuid.uuid4())
        make_package(self.root / f"{name}.zip", title=title, version=version, guid=guid, author=author)
        self.to_inbox(self.root / f"{name}.zip", uid, f"{S(uid, username)}__{self.next_ts()}__{name}.zip")
        return guid

    def test_zip_mode_forces_author_and_identifier(self):
        guid = self.upload("111", "a", username="Alice.B")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        e = self.catalog_mods()[guid]
        self.assertEqual((e["author"], e["uploader"]), ("Alice.B", "111"))
        meta = self.stored(guid, "Verified-Mod-1.0.0.zip")[1]
        self.assertEqual((meta["author"], meta["identifier"]), ("Alice.B", "111.VerifiedMod"))

    def test_identifier_strips_all_whitespace_of_the_title(self):
        guid = self.upload("111", "a", title="  A \t Spaced\u00a0Title ")
        self.run_process()
        self.assertEqual(self.stored(guid, "A-Spaced-Title-1.0.0.zip")[1]["identifier"], "111.ASpacedTitle")

    def test_admin_is_forced_too(self):
        guid = self.upload(ADMIN, "a", username="boss", author="Somebody Else")
        self.run_process()
        e = self.catalog_mods()[guid]
        self.assertEqual((e["author"], e["uploader"]), ("boss", ADMIN))
        meta = self.stored(guid, "Verified-Mod-1.0.0.zip")[1]
        self.assertEqual((meta["author"], meta["identifier"]), ("boss", f"{ADMIN}.VerifiedMod"))

    def test_admin_updating_another_users_mod_keeps_the_owners_name(self):
        guid = self.upload("111", "a", username="alice")
        self.run_process()
        self.upload(ADMIN, "b", username="boss", version="2.0.0", guid=guid)
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        e = self.catalog_mods()[guid]
        self.assertEqual((e["version"], e["uploader"], e["author"]), ("2.0.0", "111", "alice"))
        self.assertEqual(self.stored(guid, "Verified-Mod-2.0.0.zip")[1]["author"], "boss")

    def test_a_rename_updates_every_entry_of_that_user_and_nobody_elses(self):
        g1 = self.upload("111", "a", username="alice", title="One")
        g2 = self.upload("111", "b", username="alice", title="Two")
        g3 = self.upload("222", "c", username="bob", title="Three")
        self.run_process()
        self.assertEqual({self.catalog_mods()[g]["author"] for g in (g1, g2)}, {"alice"})
        # alice renames herself and uploads a new version of only one of her mods
        self.upload("111", "d", username="alice2", title="One", version="2.0.0", guid=g1)
        self.run_process()
        mods = self.catalog_mods()
        self.assertEqual([mods[g]["author"] for g in (g1, g2, g3)], ["alice2", "alice2", "bob"])
        # the older stored package keeps the name it was uploaded with
        self.assertEqual(self.stored(g2, "Two-1.0.0.zip")[1]["author"], "alice")

    def test_leaving_keeps_the_old_name(self):
        g = self.upload("111", "a", username="alice")
        self.upload("222", "b", username="bob", title="Other")
        self.run_process()
        self.upload("222", "c", username="bob2", title="Other", version="2.0.0",
                    guid=next(i for i, m in self.catalog_mods().items() if m["name"] == "Other"))
        self.run_process()
        self.assertEqual(self.catalog_mods()[g]["author"], "alice")

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
    def upload(self, uid, name, username, title="RB Mod", version="1.0.0", guid=None):
        guid = guid or str(uuid.uuid4())
        make_package(self.root / f"{name}.zip", title=title, version=version, guid=guid)
        self.to_inbox(self.root / f"{name}.zip", uid, f"{S(uid, username)}__{self.next_ts()}__{name}.zip")
        self.run_process()
        return guid

    def test_rebuild_from_releases_alone_reproduces_the_live_catalog(self):
        g1 = self.upload("111", "a", "alice", title="One")
        g2 = self.upload("111", "b", "alice", title="Two")
        g3 = self.upload("222", "c", "bob", title="Three")
        self.upload("111", "d", "alice2", title="One", version="2.0.0", guid=g1)
        self.upload(ADMIN, "e", "boss", title="Three", version="2.0.0", guid=g3)
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
        tag = "mod-" + str(uuid.uuid4())
        guid = tag[4:]
        make_package(self.root / "h.zip", guid=guid)  # identifier "Tester.TestMod": no uploader id
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
