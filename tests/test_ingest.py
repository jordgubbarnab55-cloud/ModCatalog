"""Offline tests for `build.py ingest-forum` (LocalClient + fake CDN).

Run: python -m unittest discover -s tests
"""

import base64
import contextlib
import hashlib
import io
import json
import pathlib
import tempfile
import types
import unittest
import unittest.mock

import build

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8"


def S(uid: str, username: str | None = None) -> str:
    """The Worker's uploader stamp: `<id>-<hex of the username>`."""
    username = username or f"user{uid}"
    return f"{uid}-{username.encode('utf-8').hex()}"


def fake_png(data: bytes = b"fake-png-payload") -> bytes:
    return PNG_MAGIC + data


class IngestForumTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = pathlib.Path(self._tmp.name) / "root"
        self.root.mkdir()
        self.client = build.LocalClient(self.root)
        self.dispatches: list[tuple[str, str, str]] = []

    def run_ingest(self, **overrides) -> tuple[int, str, str]:
        """Runs ingest_forum with the given arg overrides; (code, out, err)."""
        base = dict(
            thread_id="12345",
            upload_id="forum-12345",
            stamp=S("12345"),
            package_url="https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1&signature=s",
            package_name="mod.zip",
            package_size="",
            cover_url="",
            cover_name="",
            cover_mime="",
            metadata=json.dumps({"title": "Mod", "description": "d", "version": "",
                               "game_version": "", "author": "user12345", "tags": []}),
            no_dispatch=True,
            client="local",
        )
        base.update(overrides)
        args = types.SimpleNamespace(**base)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = build.ingest_forum(self.client, "o", "r", args)
            except SystemExit as ex:
                if isinstance(ex.code, int):
                    code = ex.code
                else:
                    code = 1
                    err.write(f"{ex.code}\n")
        return code, out.getvalue(), err.getvalue()

    def fake_cdn(self, files: dict):
        """Patches build._download to serve `files` (url -> bytes)."""
        def _download(url, dest, max_bytes):
            if url not in files:
                raise OSError(f"404: {url}")
            data = files[url]
            if len(data) > max_bytes:
                raise build.PackageError("download exceeds the limit")
            dest.write_bytes(data)
        return _download

    # ------------------------------------------------------------- happy path

    def test_happy_path_uploads_manifest_zip_metadata(self):
        pkg = b"zip-bytes"
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({url: pkg})):
            code, out, err = self.run_ingest(package_url=url)
        self.assertEqual(code, 0)
        assets = sorted(a.name for a in self.client.list_assets(build.INBOX_TAG))
        self.assertEqual(assets, [
            f"{S('12345')}__forum-12345__f0__p0of1__mod.zip",
            f"{S('12345')}__forum-12345__manifest.json",
            f"{S('12345')}__forum-12345__metadata.json",
        ])
        manifest = json.loads(self.client.asset_bytes(build.INBOX_TAG,
                       f"{S('12345')}__forum-12345__manifest.json"))
        self.assertEqual(manifest["files"][0]["name"], "mod.zip")
        self.assertEqual(manifest["files"][0]["sha256"], hashlib.sha256(pkg).hexdigest())
        self.assertEqual(manifest["files"][0]["parts"], 1)
        meta = json.loads(self.client.asset_bytes(build.INBOX_TAG,
                      f"{S('12345')}__forum-12345__metadata.json"))
        self.assertEqual(meta["title"], "Mod")
        self.assertEqual(meta["version"], "")
        self.assertNotIn("image", meta)  # no cover: key absent (package's own kept)
        self.assertNotIn("identifier", meta)  # a new post is always a new mod
        self.assertIn(f"RESULT uploaded pkg_sha256={hashlib.sha256(pkg).hexdigest()}", out)

    def test_package_size_is_checked(self):
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({url: b"abc"})):
            code, _, err = self.run_ingest(package_url=url, package_size="999")
        self.assertEqual(code, 1)
        self.assertIn("size mismatch", err)
        self.assertEqual(self.client.list_assets(build.INBOX_TAG), [])

    def test_stale_partial_set_is_removed_before_reupload(self):
        """A retry reuses the same upload_id: GitHub 422s on a duplicate
        asset name, so a stale partial set of this upload_id is deleted first."""
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        stale = f"{S('12345')}__forum-12345__f0__p0of1__old.zip"
        (pathlib.Path(self.root) / "old.zip").write_bytes(b"stale")
        self.client.upload_asset(build.INBOX_TAG, pathlib.Path(self.root) / "old.zip", stale)
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({url: b"zip"})):
            code, out, _ = self.run_ingest(package_url=url)
        self.assertEqual(code, 0)
        names = [a.name for a in self.client.list_assets(build.INBOX_TAG)]
        self.assertNotIn(stale, names, "the stale partial set was removed")
        self.assertEqual(len(names), 3, "exactly the three fresh assets remain")

    def test_dispatch_calls_the_process_inbox_workflow(self):
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        calls = []
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({url: b"zip"})), \
             unittest.mock.patch.object(build, "dispatch_workflow",
                                       lambda o, r, w: calls.append((o, r, w))):
            code, _, _ = self.run_ingest(package_url=url, no_dispatch=False, client="gh")
        self.assertEqual(code, 0)
        self.assertEqual(calls, [("o", "r", "process-inbox.yml")])

    # ------------------------------------------------------------- validation

    def test_bad_thread_id(self):
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({})):
            code, _, err = self.run_ingest(thread_id="abc", upload_id="forum-abc")
        self.assertEqual(code, 1)
        self.assertIn("thread-id", err)

    def test_upload_id_mismatch(self):
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({})):
            code, _, err = self.run_ingest(upload_id="other-12345")
        self.assertEqual(code, 1)
        self.assertIn("upload-id", err)

    def test_bad_stamp(self):
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({})):
            code, _, err = self.run_ingest(stamp="not-a-stamp")
        self.assertEqual(code, 1)
        self.assertIn("stamp", err)

    def test_non_cdn_host_is_rejected(self):
        for url in ("https://example.com/a.zip", "http://cdn.discordapp.com/a.zip",
                    "https://cdn.discordapp.com.evil.com/a.zip"):
            with unittest.mock.patch.object(build, "_download", self.fake_cdn({})):
                code, _, err = self.run_ingest(package_url=url)
            self.assertEqual(code, 1, url)
            self.assertIn("cdn.discordapp.com", err)

    def test_bad_package_name(self):
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        for name in ("a b.zip", "nozip", "../evil.zip"):
            with unittest.mock.patch.object(build, "_download", self.fake_cdn({url: b"z"})):
                code, _, err = self.run_ingest(package_name=name)
            self.assertEqual(code, 1, name)
            self.assertIn("package-name", err)

    def test_bad_metadata(self):
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({url: b"z"})):
            code, _, _ = self.run_ingest(metadata="not json")
        self.assertEqual(code, 1)
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({url: b"z"})):
            code, _, _ = self.run_ingest(
                metadata=json.dumps({"title": "T", "identifier": "1.Mod"}))
        self.assertEqual(code, 1, "an identifier in the metadata is rejected")

    def test_download_failure(self):
        def _fail(url, dest, max_bytes):
            raise OSError("no network in tests")
        with unittest.mock.patch.object(build, "_download", _fail):
            code, _, err = self.run_ingest()
        self.assertEqual(code, 1)
        self.assertIn("download-failed", err)
        self.assertNotIn("cdn.discordapp.com/attachments", err, "no URL in the error")

    def test_empty_download(self):
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        with unittest.mock.patch.object(build, "_download", self.fake_cdn({url: b""})):
            code, _, err = self.run_ingest(package_url=url)
        self.assertEqual(code, 1)
        self.assertIn("empty file", err)

    # ------------------------------------------------------------- covers

    def test_png_cover_passes_through(self):
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        curl = "https://cdn.discordapp.com/attachments/1/1/c.png?ex=1"
        cover = fake_png()
        with unittest.mock.patch.object(build, "_download",
                                       self.fake_cdn({url: b"zip", curl: cover})):
            code, _, _ = self.run_ingest(package_url=url, cover_url=curl,
                                        cover_name="c.png", cover_mime="image/png")
        self.assertEqual(code, 0)
        meta = json.loads(self.client.asset_bytes(build.INBOX_TAG,
                          f"{S('12345')}__forum-12345__metadata.json"))
        self.assertEqual(meta["image"]["mime"], "image/png")
        self.assertEqual(base64.b64decode(meta["image"]["data"]), cover)

    def test_bad_magic_cover_is_dropped(self):
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        curl = "https://cdn.discordapp.com/attachments/1/1/c.png?ex=1"
        with unittest.mock.patch.object(build, "_download",
                                       self.fake_cdn({url: b"zip", curl: b"not a png"})):
            code, _, _ = self.run_ingest(package_url=url, cover_url=curl,
                                        cover_name="c.png", cover_mime="image/png")
        self.assertEqual(code, 0, "a bad cover is not fatal")
        meta = json.loads(self.client.asset_bytes(build.INBOX_TAG,
                          f"{S('12345')}__forum-12345__metadata.json"))
        self.assertNotIn("image", meta, "the cover is dropped; the package's own is kept")

    def test_webp_cover_converted_when_pillow_present(self):
        try:
            import PIL.Image  # noqa: F401
        except ImportError:
            self.skipTest("Pillow unavailable")
        url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
        curl = "https://cdn.discordapp.com/attachments/1/1/c.webp?ex=1"
        # a real, minimal WebP (8x8 solid) via Pillow itself
        import PIL.Image
        buf = io.BytesIO()
        PIL.Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "WEBP")
        with unittest.mock.patch.object(build, "_download",
                                       self.fake_cdn({url: b"zip", curl: buf.getvalue()})):
            code, _, _ = self.run_ingest(package_url=url, cover_url=curl,
                                        cover_name="c.webp", cover_mime="image/webp")
        self.assertEqual(code, 0)
        meta = json.loads(self.client.asset_bytes(build.INBOX_TAG,
                          f"{S('12345')}__forum-12345__metadata.json"))
        self.assertEqual(meta["image"]["mime"], "image/png", "webp is converted to PNG")
        self.assertTrue(base64.b64decode(meta["image"]["data"]).startswith(PNG_MAGIC))

    def test_webp_cover_dropped_when_pillow_absent(self):
        import sys
        saved = {m: sys.modules.get(m) for m in ("PIL", "PIL.Image")}
        for mod in ("PIL", "PIL.Image"):
            sys.modules[mod] = None  # force ImportError on import
        try:
            url = "https://cdn.discordapp.com/attachments/1/1/mod.zip?ex=1"
            curl = "https://cdn.discordapp.com/attachments/1/1/c.webp?ex=1"
            with unittest.mock.patch.object(build, "_download",
                                           self.fake_cdn({url: b"zip", curl: b"RIFF....WEBP"})):
                code, out, err = self.run_ingest(package_url=url, cover_url=curl,
                                                cover_name="c.webp", cover_mime="image/webp")
        finally:
            for m, v in saved.items():
                if v is None:
                    sys.modules.pop(m, None)
                else:
                    sys.modules[m] = v
        self.assertEqual(code, 0, "no Pillow: the cover is dropped, not fatal")
        self.assertIn("Pillow unavailable", out + err)
        meta = json.loads(self.client.asset_bytes(build.INBOX_TAG,
                          f"{S('12345')}__forum-12345__metadata.json"))
        self.assertNotIn("image", meta)


if __name__ == "__main__":
    unittest.main()
