"""Offline tests for the build.py pipeline (LocalClient, synthetic packages).

Run: python -m unittest discover -s tests
"""

import hashlib
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


def make_package(dest: pathlib.Path, title: str = "Test Mod", author: str = "Tester",
                 version: str = "1.0.0", description: str = "a test package",
                 guid: str | None = None, image: dict | None = None,
                 n_utoc: int = 1, include_ucas: bool = True, include_pak: bool = True,
                 no_trailer: bool = False, extra_members: list[str] | None = None,
                 corrupt: bool = False) -> pathlib.Path:
    """Builds a synthetic package zip (fake utoc/ucas/pak bytes + a real trailer)."""
    if guid is None:
        guid = str(uuid.uuid4())
    if corrupt:
        dest.write_bytes(b"\x00\x01\x02 not a zip at all " + uuid.uuid4().bytes * 4)
        return dest
    meta = {"title": title, "author": author, "description": description,
            "version": version, "guid": guid, "image": image}
    utoc = b"FAKE-UTOC-" + (b"\x00" * 4096)
    if not no_trailer:
        utoc += trailer.build_trailer(trailer.build_payload(meta))
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        if include_pak:
            z.writestr("mod.pak", b"FAKE-PAK-" + guid.encode() + b"\x00" * 1024)
        if include_ucas:
            z.writestr("mod.ucas", b"FAKE-UCAS-" + guid.encode() + b"\x00" * 1024)
        for i in range(n_utoc):
            name = f"mod{i}.utoc" if i else "mod.utoc"
            z.writestr(name, utoc if i == 0 else b"FAKE-UTOC with no trailer")
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

    def to_inbox(self, zip_path: pathlib.Path, uploader: str | None,
                 filename: str | None = None) -> str:
        """Stages a package into the local "inbox" release; returns the asset name."""
        self.client.create_release(build.INBOX_TAG, "inbox")
        name = filename or f"{uploader or ''}__{self.next_ts()}__{zip_path.name}"
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


class TestGoodPackage(Base):
    def test_entry_fields_sha_and_urls(self):
        guid = str(uuid.uuid4())
        image = make_image("png")
        make_package(self.root / "a.zip", guid=guid, image=image)
        self.to_inbox(self.root / "a.zip", "12345", "12345__1__A.zip")

        summary = self.run_process()
        self.assertEqual(summary, {"ok": 1, "rejected": 0})

        e = self.catalog_mods()[guid]
        sha = hashlib.sha256((self.root / "a.zip").read_bytes()).hexdigest()
        tag = f"mod-{guid}"
        self.assertEqual(e["name"], "Test Mod")
        self.assertEqual(e["author"], "Tester")
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
        self.to_inbox(self.root / "a.zip", "12345", "12345__1__A.zip")
        self.run_process()
        self.assertNotIn("cover", self.catalog_mods()[guid])


class TestRejections(Base):
    def _bad_set(self) -> None:
        """One run: six different kinds of bad packages plus one good one."""
        good = self.root / "good.zip"
        make_package(good, title="Good Mod")
        self.to_inbox(good, "12345", "12345__1__good.zip")

        make_package(self.root / "corrupt.zip", corrupt=True)
        self.to_inbox(self.root / "corrupt.zip", "12345", "12345__2__corrupt.zip")
        make_package(self.root / "notrail.zip", no_trailer=True)
        self.to_inbox(self.root / "notrail.zip", "12345", "12345__3__notrail.zip")
        make_package(self.root / "two-utoc.zip", n_utoc=2)
        self.to_inbox(self.root / "two-utoc.zip", "12345", "12345__4__two-utoc.zip")
        make_package(self.root / "noupak.zip", include_pak=False)
        self.to_inbox(self.root / "noupak.zip", "12345", "12345__5__noupak.zip")
        make_package(self.root / "noucas.zip", include_ucas=False)
        self.to_inbox(self.root / "noucas.zip", "12345", "12345__6__noucas.zip")
        make_package(self.root / "traversal.zip", extra_members=["../evil.txt"])
        self.to_inbox(self.root / "traversal.zip", "12345", "12345__7__traversal.zip")

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
        self.to_inbox(self.root / "corrupt.zip", "12345", "12345__1__corrupt.zip")
        good = self.root / "good.zip"
        make_package(good, title="Good Mod")
        self.to_inbox(good, "12345", "12345__2__good.zip")
        self.assertEqual(self.run_process()["ok"], 1)


class TestVersions(Base):
    def test_same_version_rejected_new_version_wins(self):
        guid = str(uuid.uuid4())
        make_package(self.root / "v1.zip", title="Ver Mod", version="1.0.0", guid=guid)
        self.to_inbox(self.root / "v1.zip", "12345", "12345__1__v1.zip")
        self.run_process()

        # same guid + version (different bytes) -> rejected, original stays
        make_package(self.root / "v1b.zip", title="Ver Mod", version="1.0.0", guid=guid)
        self.to_inbox(self.root / "v1b.zip", "12345", "12345__2__v1b.zip")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        tag = f"mod-{guid}"
        names = {a.name for a in self.client.list_assets(tag)}
        self.assertEqual(names, {"Ver-Mod-1.0.0.zip"})
        self.assertEqual(self.inbox_names(), [])

        # a new version becomes the main entry; the old asset stays
        make_package(self.root / "v2.zip", title="Ver Mod", version="1.1.0", guid=guid)
        self.to_inbox(self.root / "v2.zip", "12345", "12345__3__v2.zip")
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
        self.to_inbox(self.root / "a.zip", "111", "111__1__a.zip")
        self.run_process()
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "111")

        # a different uploader is rejected, even with a new version
        make_package(self.root / "b.zip", version="2.0.0", guid=guid)
        self.to_inbox(self.root / "b.zip", "222", "222__2__b.zip")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "111")

        # an admin (ADMIN_DISCORD_IDS) bypasses the check
        make_package(self.root / "c.zip", version="3.0.0", guid=guid)
        self.to_inbox(self.root / "c.zip", ADMIN, f"{ADMIN}__3__c.zip")
        self.assertEqual(self.run_process(), {"ok": 1, "rejected": 0})
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "111")  # owner kept
        self.assertEqual(self.catalog_mods()[guid]["version"], "3.0.0")

    def test_seed_then_claim(self):
        guid = str(uuid.uuid4())
        make_package(self.root / "s.zip", guid=guid)
        self.to_inbox(self.root / "s.zip", None, "1__s.zip")  # no id -> seeding
        self.run_process()
        self.assertIsNone(self.catalog_mods()[guid]["uploader"])

        # the first real uploader then becomes the owner
        make_package(self.root / "c.zip", version="2.0.0", guid=guid)
        self.to_inbox(self.root / "c.zip", "333", "333__2__c.zip")
        self.run_process()
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "333")

        make_package(self.root / "d.zip", version="3.0.0", guid=guid)
        self.to_inbox(self.root / "d.zip", "444", "444__3__d.zip")
        self.assertEqual(self.run_process(), {"ok": 0, "rejected": 1})

    def test_same_run_first_wins(self):
        """Two inbox uploads of one new GUID in the same run: the first wins."""
        guid = str(uuid.uuid4())
        make_package(self.root / "a.zip", guid=guid, title="Race Mod")
        self.to_inbox(self.root / "a.zip", "111", "111__1__a.zip")
        make_package(self.root / "b.zip", version="2.0.0", guid=guid, title="Race Mod")
        self.to_inbox(self.root / "b.zip", "222", "222__2__b.zip")
        summary = self.run_process()
        self.assertEqual(summary, {"ok": 1, "rejected": 1})
        self.assertEqual(self.catalog_mods()[guid]["uploader"], "111")


class TestDrain(Base):
    def test_all_inbox_assets_processed(self):
        for i in range(3):
            make_package(self.root / f"p{i}.zip", title=f"Drain Mod {i}")
            self.to_inbox(self.root / f"p{i}.zip", f"100{i}", f"100{i}__{i + 1}__p{i}.zip")
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
        self.to_inbox(self.root / "v1.zip", "12345", "12345__1__v1.zip")
        self.run_process()
        make_package(self.root / "v2.zip", title="RB Mod", version="1.1.0", guid=guid)
        self.to_inbox(self.root / "v2.zip", "12345", "12345__2__v2.zip")
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


@unittest.skipUnless(LEGACY.is_dir(), "legacy-assets/ not present")
class TestLegacyEndToEnd(Base):
    """The real example zips through the whole pipeline (local client)."""

    def test_seed_three_examples(self):
        p = subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "process", "--from-dir", str(LEGACY),
             "--client", "local", "--root", str(self.root), "--catalog", str(self.catalog),
             "--owner", OWNER, "--repo", REPO],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(p.returncode, 0, p.stderr)
        mods = self.catalog_mods()
        self.assertEqual(len(mods), 3)
        for m in mods.values():
            self.assertTrue(m["file"].startswith(f"https://github.com/{OWNER}/{REPO}/releases/download/mod-"))
            self.assertTrue(m["file"].endswith(".zip"))
            self.assertIsNone(m["uploader"])  # seeding
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
