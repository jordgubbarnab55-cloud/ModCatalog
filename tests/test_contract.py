"""ModCatalog against the shared mod-contract fixtures (vendored in mod-contract/).

Run: python -m unittest discover -s tests
"""

import base64
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
import uuid
import zipfile
from unittest import mock

import build
import trailer

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "mod-contract"
FIXTURES = CONTRACT / "fixtures"
CANONICAL_CONTRACT = ROOT.parent / "QwenWorkspace" / "mod-contract"

sys.path.insert(0, str(CONTRACT / "tools"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import schema_check  # noqa: E402
import sync  # noqa: E402

from test_build import Base, S, fake_toc, make_package  # noqa: E402


def load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def reported(meta: dict) -> dict:
    """Normalized metadata in the fixtures' shape (image as mime/size/sha256)."""
    image = meta.get("image")
    return {
        **{k: meta[k] for k in ("title", "author", "description", "version",
                                "game_version", "guid", "identifier", "tags")},
        "image": None if image is None else {
            "mime": image["mime"], "size": len(image["data"]),
            "sha256": hashlib.sha256(image["data"]).hexdigest()},
    }


class TestTrailerConformance(unittest.TestCase):
    def test_read_cases(self):
        for case in load("trailer-cases.json")["read"]:
            with self.subTest(case["file"]):
                data = (FIXTURES / "trailer" / case["file"]).read_bytes()
                expect = case["expect"]
                if expect["result"] == "error":
                    with self.assertRaises(trailer.TrailerError) as ctx:
                        trailer.read(data)
                    self.assertEqual(ctx.exception.kind, expect["kind"])
                elif expect["result"] == "none":
                    self.assertIsNone(trailer.read(data)[0])
                else:
                    found, _ = trailer.read(data)
                    self.assertIsNotNone(found)
                    self.assertEqual(found["offset"], expect["offset"])
                    self.assertEqual(reported(found["metadata"]), expect["metadata"])

    def test_write_cases(self):
        for case in load("trailer-cases.json")["write"]:
            with self.subTest(case["file"]):
                data = (FIXTURES / "trailer" / case["file"]).read_bytes()
                expect = case["expect"]
                if expect["result"] == "error":
                    with self.assertRaises(trailer.TrailerError) as ctx:
                        trailer.write_trailer(data, case["metadata"])
                    self.assertEqual(ctx.exception.kind, expect["kind"])
                    continue
                out, replaced, end = trailer.write_trailer(data, case["metadata"])
                self.assertEqual(end, expect["toc_end"])
                self.assertEqual(replaced, expect["replaced"])
                size = int.from_bytes(out[end + 0x18:end + 0x1C], "little")
                self.assertEqual(out[end + 0x20:end + 0x20 + size].decode("utf-8"), expect["payload"])
                self.assertEqual(len(out), expect["size"])
                self.assertEqual(hashlib.sha256(out).hexdigest(), expect["sha256"])

    def test_write_then_read_round_trips_an_image(self):
        image = {"mime": "image/png", "data": b"\x89PNG\r\n\x1a\nbody"}
        out, _, _ = trailer.write_trailer(fake_toc(), {"title": "T", "author": "A", "version": "1",
                                                       "guid": None, "tags": ["Skin"], "image": image})
        meta = trailer.read_trailer(out)
        self.assertEqual(meta["image"], image)
        self.assertEqual(uuid.UUID(meta["guid"]).version, 4)


class TestPackageConformance(unittest.TestCase):
    def test_zip_cases(self):
        for case in load("packages.json")["zip"]:
            with self.subTest(case["note"]):
                verdict, base, _ = build.classify_members(case["members"])
                self.assertEqual(verdict, case["expect"]["result"])
                if verdict == "ok":
                    self.assertEqual(base, case["expect"]["base"])

    def test_raw_cases(self):
        for case in load("packages.json")["raw"]:
            with self.subTest(case["note"]):
                verdict, base = build.classify_raw(case["files"])
                self.assertEqual(verdict, case["expect"]["result"])
                if verdict == "ok":
                    self.assertEqual(base, case["expect"]["base"])


class TestCatalogContract(Base):
    def test_canonical_fixtures_match_the_schema(self):
        for case in load("catalog-cases.json")["cases"]:
            if case["canonical"]:
                with self.subTest(case["file"]):
                    data = json.loads((FIXTURES / "catalogs" / case["file"]).read_text(encoding="utf-8"))
                    self.assertEqual(schema_check.validate_catalog(data), [])

    def test_published_catalog_matches_the_schema(self):
        data = json.loads((ROOT / "site" / "catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(schema_check.validate_catalog(data), [])

    def test_generated_catalog_carries_tags_and_game_version(self):
        guid = str(uuid.uuid4())
        make_package(self.root / "a.zip", guid=guid, tags=["skin", "Bogus", "VFX"], game_version="5.6.1")
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__a.zip")
        self.assertEqual(self.run_process()["ok"], 1)
        data = json.loads(self.catalog.read_text(encoding="utf-8"))
        self.assertEqual(schema_check.validate_catalog(data), [])
        self.assertEqual(data["schemaVersion"], 1)
        entry = data["mods"][0]
        self.assertEqual(entry["tags"], ["Skin", "VFX"])  # vocabulary casing, unknown dropped
        self.assertEqual(entry["gameVersion"], "5.6.1")

    def test_empty_tags_and_game_version_are_omitted(self):
        guid = str(uuid.uuid4())
        make_package(self.root / "a.zip", guid=guid)
        self.to_inbox(self.root / "a.zip", "12345", f"{S('12345')}__1__a.zip")
        self.run_process()
        entry = self.catalog_mods()[guid]
        self.assertNotIn("tags", entry)
        self.assertNotIn("gameVersion", entry)

    def test_tag_vocabulary_comes_from_the_contract(self):
        tags = json.loads((CONTRACT / "tags.json").read_text(encoding="utf-8"))["tags"]
        self.assertEqual(build.TAGS, tags)
        self.assertEqual(build.sanitize_tags(["vfx", " VFX ", "", "nope", "NOPE"]), (["VFX"], ["nope"]))


class TestSizeLimits(Base):
    def test_package_over_the_upload_limit_but_under_the_asset_limit_is_accepted(self):
        # Raw sets exist to get past the 100 MB per-request limit; the package
        # limit is GitHub's per-asset cap.
        make_package(self.root / "a.zip")
        with mock.patch.object(build, "MAX_RELEASE_ASSET_BYTES", (self.root / "a.zip").stat().st_size):
            build.validate_package(self.root / "a.zip")

    def test_package_over_the_asset_limit_is_rejected(self):
        make_package(self.root / "a.zip")
        with mock.patch.object(build, "MAX_RELEASE_ASSET_BYTES", 10):
            with self.assertRaises(build.PackageError):
                build.validate_package(self.root / "a.zip")

    def test_nested_sig_set_is_accepted(self):
        guid = str(uuid.uuid4())
        utoc = trailer.write_trailer(fake_toc(), {"title": "Nested", "author": "A", "version": "1", "guid": guid})[0]
        with zipfile.ZipFile(self.root / "n.zip", "w") as z:
            for ext, data in ((".utoc", utoc), (".ucas", b"u"), (".pak", b"p"), (".sig", b"s")):
                z.writestr(f"Content/Paks/~mods/x_P{ext}", data)
            z.writestr("readme.txt", b"hi")
        self.assertEqual(build.validate_package(self.root / "n.zip")["guid"], guid)


@unittest.skipUnless(CANONICAL_CONTRACT.is_dir(), "the ModManager workspace is not next to this repo")
class TestVendoredContract(unittest.TestCase):
    def test_vendored_copy_matches_the_canonical_one(self):
        changes = sync.diff(CANONICAL_CONTRACT, CONTRACT)
        self.assertEqual(changes, [], "run: python ../QwenWorkspace/mod-contract/tools/sync.py mod-contract")


if __name__ == "__main__":
    unittest.main()
