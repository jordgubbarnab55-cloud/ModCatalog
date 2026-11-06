"""The inline icon sprite in site/index.html matches site/icons/*.svg.

Run: python -m unittest discover -s tests
"""
import importlib.util
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _load_sync_icons():
    spec = importlib.util.spec_from_file_location(
        "sync_icons", ROOT / "scripts" / "sync-icons.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestIconSpriteInSync(unittest.TestCase):
    """Fail when an icon file changed (or a new one was added) without
    re-running scripts/sync-icons.py — the deployed sprite would be stale."""

    def test_sprite_matches_icon_files(self):
        mod = _load_sync_icons()
        expected = mod.build_sprite(ROOT / "site" / "icons")
        html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
        self.assertIn(mod.START, html, "sprite markers missing from index.html")
        self.assertIn(mod.END, html)
        start, end = html.index(mod.START), html.index(mod.END) + len(mod.END)
        self.assertEqual(
            html[start:end], expected,
            "sprite is out of date; run: python scripts/sync-icons.py")

    def test_every_reference_has_a_symbol(self):
        mod = _load_sync_icons()
        html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
        symbol_names = {name.name for name in (ROOT / "site" / "icons").glob("*.svg")}
        refs = set(re.findall(r'<use href="#i-([a-z0-9-]+)"', html))
        refs |= set(re.findall(
            r'<use href="#i-([a-z0-9-]+)"',
            (ROOT / "site" / "upload-editor.js").read_text(encoding="utf-8")))
        for ref in refs:
            self.assertIn(f"{ref}.svg", symbol_names,
                         f"icon {ref}.svg referenced but not in site/icons/")


if __name__ == "__main__":
    unittest.main()
