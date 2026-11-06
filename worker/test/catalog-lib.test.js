// site/catalog-lib.js against the shared catalog fixtures and the app's recorded vectors.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseCatalog, sanitizeTags, formatBytes, singleLine, metaParts, fileNameOf,
  parseAccent, accentFor, placeholder, matches, catalogTitle, fitTagCutoff,
} from "../../site/catalog-lib.js";

const FIXTURES = new URL("../../mod-contract/fixtures/", import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const all = load("catalog-cases.json");
const vocabulary = load("../tags.json").tags;

for (const c of all.cases) {
  test(`catalog parse: ${c.file}`, () => {
    const doc = parseCatalog(load(`catalogs/${c.file}`), all.base);
    assert.equal(doc.schemaVersion, c.expect.schemaVersion);
    assert.equal(doc.name, c.expect.name);
    assert.equal(doc.skipped, c.expect.skipped);
    assert.equal(doc.verifiedAuthors, c.expect.verifiedAuthors);
    // the shared fixtures describe the contract fields; `uploader` is this page's extension
    assert.deepEqual(doc.mods.map(({ uploader, ...rest }) => rest), c.expect.mods);
  });
}

test("catalog parse: keeps the uploader (ModCatalog's owner id) as text, else null", () => {
  const canonical = parseCatalog(load("catalogs/canonical.json"), all.base);
  assert.equal(canonical.mods[0].uploader, "1509993694902878381");
  const doc = parseCatalog([
    { file: "https://h.example/a.zip", id: "a", uploader: "42" },
    { file: "https://h.example/b.zip", id: "b", uploader: null },
    { file: "https://h.example/c.zip", id: "c", uploader: 7 },
    { file: "https://h.example/d.zip", id: "d", uploader: "" },
    { file: "https://h.example/e.zip", id: "e" },
  ], "https://h.example/");
  assert.deepEqual(doc.mods.map((m) => m.uploader), ["42", null, "7", null, null]);
});

test("catalog parse: unusable roots throw", () => {
  assert.throws(() => parseCatalog({ items: [] }, all.base));
  assert.throws(() => parseCatalog({ mods: {} }, all.base));
  assert.throws(() => parseCatalog("nope", all.base));
  assert.throws(() => parseCatalog(null, all.base));
});

test("catalog parse: warnings describe skipped entries", () => {
  const doc = parseCatalog(load("catalogs/messy.json"), all.base);
  assert.equal(doc.warnings.length >= 5, true);
  assert.ok(doc.warnings.some((w) => w.includes("newer than")));
  assert.ok(doc.warnings.some((w) => w.includes("duplicate id 'keeper'")));
  assert.ok(doc.warnings.some((w) => w.includes("not http(s)")));
});

test("catalog parse: whitespace-padded and relative URLs resolve like the app", () => {
  const doc = parseCatalog([{ file: "  a/b%20c.zip ", cover: "../c.png" }], "https://h.example/x/y/catalog.json");
  assert.equal(doc.mods[0].file, "https://h.example/x/y/a/b%20c.zip");
  assert.equal(doc.mods[0].cover, "https://h.example/x/c.png");
  assert.equal(doc.mods[0].name, "b c");
});

test("catalog parse: size leniency", () => {
  const sizes = [1.5, "12", " 12", "-1", -3, "x", 0, 7].map((size) =>
    parseCatalog([{ file: "https://h.example/a.zip", size }], "https://h.example/").mods[0].size);
  assert.deepEqual(sizes, [0, 12, 0, 0, 0, 0, 0, 7]);
});

test("sanitizeTags keeps vocabulary casing, order, drops unknowns and duplicates", () => {
  const { kept, dropped } = sanitizeTags([" skin ", "VFX", "SKIN", "", "  ", "Nope", "nope", "sound"], vocabulary);
  assert.deepEqual(kept, ["Skin", "VFX", "Sound"]);
  assert.deepEqual(dropped, ["Nope"]);
  assert.deepEqual(sanitizeTags(["a", "A", "b"], null).kept, ["a", "b"]);
  assert.deepEqual(sanitizeTags(undefined, vocabulary), { kept: [], dropped: [] });
});

test("formatBytes", () => {
  const cases = [
    [0, "0 B"], [1, "1 B"], [1023, "1023 B"], [1024, "1 KB"], [1536, "1.5 KB"],
    [10485760, "10 MB"], [10 * 1024 * 1024 + 512 * 1024, "10.5 MB"],
    [1024 ** 3, "1 GB"], [1024 ** 4, "1 TB"], [1024 ** 5, "1024 TB"], [1280, "1.3 KB"],
  ];
  for (const [n, s] of cases) assert.equal(formatBytes(n, "en-US"), s, String(n));
  assert.equal(formatBytes(undefined, "en-US"), "0 B");
});

test("formatBytes follows the viewer's locale, like the app", () => {
  assert.equal(formatBytes(10 * 1024 * 1024 + 717 * 1024, "sv-SE"), "10,7 MB");
  assert.equal(formatBytes(1536, "de-DE"), "1,5 KB");
  assert.equal(formatBytes(1023, "sv-SE"), "1023 B");
});

test("singleLine", () => {
  assert.equal(singleLine("a\r\nb\nc\rd"), "a b c d");
  assert.equal(singleLine("plain"), "plain");
  assert.equal(singleLine(""), "");
  assert.equal(singleLine(null), "");
});

test("metaParts", () => {
  assert.deepEqual(metaParts({ author: "A", version: "1", gameVersion: "" }), ["A", "•", "v1"]);
  assert.deepEqual(metaParts({ author: "A", version: "1", gameVersion: "5.6" }), ["A", "•", "v1", "•", "[5.6]"]);
  assert.deepEqual(metaParts({ author: "A", version: "", gameVersion: "" }), ["A"]);
  assert.deepEqual(metaParts({ author: "A", version: "", gameVersion: "5.6" }), ["A", "•", "[5.6]"]);
  assert.deepEqual(metaParts({ author: "", version: "", gameVersion: "" }), [""]);
});

test("metaParts: parsed entries without a version show no 'v'", () => {
  const doc = parseCatalog({ mods: [
    { id: "a", name: "A", author: "Ann", file: "a.zip" },
    { id: "b", name: "B", author: "Bob", version: "", gameVersion: "5.6", file: "b.zip" },
    { id: "c", name: "C", author: "Cy", version: 2, file: "c.zip" },
  ] }, "https://h.example/catalog.json");
  assert.deepEqual(doc.mods.map(metaParts), [["Ann"], ["Bob", "•", "[5.6]"], ["Cy", "•", "v2"]]);
});

test("catalogTitle: config title, then the catalog name, then the default", () => {
  assert.equal(catalogTitle("  XYZ Community Mods ", "Mod Catalog"), "XYZ Community Mods");
  assert.equal(catalogTitle(undefined, "Catalog Name"), "Catalog Name");
  assert.equal(catalogTitle("   ", " Catalog Name "), "Catalog Name");
  assert.equal(catalogTitle(42, null), "Mod Catalog");
  assert.equal(catalogTitle(null, ""), "Mod Catalog");
});

test("fileNameOf", () => {
  assert.equal(fileNameOf("https://h.example/p/foreign%20mod.zip"), "foreign mod.zip");
  assert.equal(fileNameOf("https://h.example/"), "download");
  assert.equal(fileNameOf("nonsense"), "download");
});

// Recorded from ModManager.Tests/PlaceholderAccentTests.cs (the app's PlaceholderAccent.HexFor).
const VECTORS = [
  ["", "#408C3F"], ["a", "#8C3F73"], ["ExampleUEMod", "#583F8C"],
  ["mod-guid-1", "#8C3F64"], ["Zebra", "#3F628C"], ["Lava Skin", "#493F8C"],
];
for (const [key, hex] of VECTORS) {
  test(`accentFor(${JSON.stringify(key)}) = ${hex}`, () => assert.equal(accentFor(key), hex));
}

test("placeholder: initial and colour", () => {
  assert.deepEqual(placeholder({ id: "Zebra", name: "zebra skin" }), { initial: "Z", color: "#3F628C" });
  assert.deepEqual(placeholder({ id: "Zebra", name: "" }), { initial: "?", color: "#3F628C" });
  assert.deepEqual(placeholder({ id: "Zebra", name: "x", accent: "#112233" }), { initial: "X", color: "#112233" });
  assert.deepEqual(placeholder({ id: "Zebra", name: "x", accent: "#80112233" }), { initial: "X", color: "#11223380" });
  assert.equal(placeholder({ id: "Zebra", name: "x", accent: "blue" }).color, "#3F628C");
  assert.equal(placeholder({ id: "k", name: "ß" }).initial, "ß");
});

test("parseAccent", () => {
  assert.equal(parseAccent("#abc"), "#AABBCC");
  assert.equal(parseAccent("#206bd4"), "#206BD4");
  assert.equal(parseAccent("red"), null);
  assert.equal(parseAccent("#12345"), null);
  assert.equal(parseAccent(null), null);
});

test("matches: tag filter is OR-ed, every query word hits name/author/description/tags", () => {
  const mod = { name: "Lava Skin", author: "Ann", description: "Hot stuff", tags: ["Skin", "VFX"] };
  assert.equal(matches(mod, "", []), true);
  assert.equal(matches(mod, "", ["sound"]), false);
  assert.equal(matches(mod, "", ["sound", "vfx"]), true);
  assert.equal(matches(mod, "  LAVA ", []), true);
  assert.equal(matches(mod, "ann", []), true);
  assert.equal(matches(mod, "hot", []), true);
  assert.equal(matches(mod, "vf", []), true);
  assert.equal(matches(mod, "zzz", []), false);
  assert.equal(matches(mod, "lava", ["Sound"]), false);
  assert.equal(matches({ name: "x", author: "", description: "", tags: [] }, "x", ["Skin"]), false);
  assert.equal(matches(mod, "ann hot", []), true);
  assert.equal(matches(mod, "hot ann", []), true);
  assert.equal(matches(mod, "lava zzz", []), false);
  assert.equal(matches(mod, "  ", []), true);
  assert.equal(matches(mod, "ann vfx", []), true);
});

test("matches: words may span fields (author word + name word)", () => {
  const mod = { name: "Galaxy Lockers", author: "uncool_1234", description: "Storage anywhere", tags: [] };
  assert.equal(matches(mod, "uncool galaxy", []), true);
  assert.equal(matches(mod, "galaxy uncool", []), true);
  assert.equal(matches(mod, "uncool zzz", []), false);
});

test("fitTagCutoff: all fit -> no +N chip (inclusive boundary)", () => {
  const plus = (r) => 24 + r * 8;
  assert.deepEqual(fitTagCutoff([], 100, 6, plus), { tags: 0, plus: 0 });
  assert.deepEqual(fitTagCutoff([40, 40, 40], 132, 6, plus), { tags: 3, plus: 0 });
  assert.deepEqual(fitTagCutoff([40, 40, 40], 131, 6, plus), { tags: 2, plus: 1 });
});

test("fitTagCutoff: cut rows include the +N chip in the budget", () => {
  // two chips fit (206 <= 220) but two + the chip (232) do not -> one chip + +2
  assert.deepEqual(fitTagCutoff([100, 100, 100], 220, 6, () => 20), { tags: 1, plus: 2 });
  // exact fit of the cut row
  assert.deepEqual(fitTagCutoff([100, 100, 100], 232, 6, () => 20), { tags: 2, plus: 1 });
  // the +N chip's width tracks the remaining count
  const plus = (r) => 24 + r * 8;
  assert.deepEqual(fitTagCutoff([40, 40, 40], 100, 6, plus), { tags: 1, plus: 2 });
  assert.deepEqual(fitTagCutoff([40, 40, 40], 124, 6, plus), { tags: 2, plus: 1 });
});

test("fitTagCutoff: no single chip fits -> just the +N chip", () => {
  assert.deepEqual(fitTagCutoff([300], 100, 6, (r) => 30), { tags: 0, plus: 1 });
});

test("fitTagCutoff: the +N chip fits nowhere -> plain chips as far as they fit", () => {
  assert.deepEqual(fitTagCutoff([40, 40, 40], 92, 6, () => 500), { tags: 2, plus: 0 });
  assert.deepEqual(fitTagCutoff([40, 40, 40], 30, 6, () => 500), { tags: 0, plus: 0 });
});
