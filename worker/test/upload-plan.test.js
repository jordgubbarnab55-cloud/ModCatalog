// Offline tests for the pure helpers of the upload modals in site/upload-lib.js:
// package selection, image rules, the forced-field resolution, metadata.json,
// the manifest/request plan and the published-mod matcher.

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySelection, imageVerdict, scaledSize, sniffImageMime, imageInfoText, bytesToBase64,
  deriveIdentifier, resolveForm, buildMetadataJson, confirmText, doneText, titleFromBase,
  PART_SIZE, partCount, partRange, buildManifest, planRequests, sha256Hex, findPublishedMod,
  MAX_PACKAGE_BYTES, IMAGE_HARD_LIMIT, IMAGE_WARN_BYTES,
} from "../../site/upload-lib.js";

const f = (name, size = 100) => ({ name, size });

// --------------------------------------------------------------- selection

test("classifySelection: one zip", () => {
  const r = classifySelection([f("My_Pack.zip")]);
  assert.equal(r.kind, "zip");
  assert.equal(r.base, "My_Pack");
  assert.equal(r.error, null);
});

test("classifySelection: loose files are ordered utoc, ucas, pak, sig", () => {
  const r = classifySelection([f("m.sig"), f("m.pak"), f("m.ucas"), f("m.utoc")]);
  assert.equal(r.kind, "loose");
  assert.equal(r.utocName, "m.utoc");
  assert.deepEqual(r.files.map((x) => x.name), ["m.utoc", "m.ucas", "m.pak", "m.sig"]);
  assert.equal(r.base, "m");
});

test("classifySelection: every problem has a message and no kind", () => {
  const cases = [
    [[], /Pick a \.zip/],
    [[f("a.txt")], /Only a \.zip/],
    [[f("a.zip"), f("a.pak")], /not both/],
    [[f("a.zip"), f("b.zip")], /One \.zip/],
    [[f("a.utoc"), f("a.ucas"), f("a.sig")], /missing/],
    [[f("a.utoc"), f("a.ucas")], /Pick exactly/],
    [[f("a.utoc"), f("b.ucas"), f("b.pak")], /share one name/],
    [[f("a.utoc"), f("a.utoc"), f("a.pak")], /twice/],
    [[f("a.zip", MAX_PACKAGE_BYTES + 1)], /2 GiB/],
    [[f("a.utoc", MAX_PACKAGE_BYTES), f("a.ucas"), f("a.pak")], /2 GiB/],
  ];
  for (const [picked, re] of cases) {
    const r = classifySelection(picked);
    assert.equal(r.kind, null);
    assert.match(r.error, re);
  }
});

// ------------------------------------------------------------------ images

test("imageVerdict follows the app's thresholds", () => {
  assert.equal(imageVerdict(10), "ok");
  assert.equal(imageVerdict(IMAGE_WARN_BYTES), "ok");
  assert.equal(imageVerdict(IMAGE_WARN_BYTES + 1), "downscale");
  assert.equal(imageVerdict(IMAGE_HARD_LIMIT), "downscale");
  assert.equal(imageVerdict(IMAGE_HARD_LIMIT + 1), "reject");
});

test("scaledSize keeps the aspect ratio with a 512 px longest edge", () => {
  assert.equal(scaledSize(512, 300), null);
  assert.deepEqual(scaledSize(1024, 512), { width: 512, height: 256 });
  assert.deepEqual(scaledSize(400, 2000), { width: 102, height: 512 });
  assert.deepEqual(scaledSize(5000, 1), { width: 512, height: 1 });
});

test("sniffImageMime and imageInfoText", () => {
  assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMime(Uint8Array.from([0x47, 0x49, 0x46])), null);
  assert.equal(imageInfoText("image/png", 1536), "image/png · 1.5 KiB");
});

test("bytesToBase64 handles large arrays", () => {
  const big = new Uint8Array(200000).fill(65);
  assert.equal(bytesToBase64(big), Buffer.from(big).toString("base64"));
});

// ------------------------------------------------------------ the form

test("deriveIdentifier is Author.Title without whitespace, empty until both are filled", () => {
  assert.equal(deriveIdentifier(" Some One ", "My  Mod"), "SomeOne.MyMod");
  assert.equal(deriveIdentifier("", "My Mod"), "");
  assert.equal(deriveIdentifier("A", "  "), "");
});

test("resolveForm without forced values derives the identifier", () => {
  assert.deepEqual(resolveForm({ author: "A B", title: "T t" }),
    { author: "A B", identifier: "AB.Tt", authorForced: false, identifierForced: false });
});

test("resolveForm: forced author and a static or title-following identifier", () => {
  const r1 = resolveForm({ author: "ignored", title: "Cool Mod" }, { author: "discorduser" });
  assert.equal(r1.author, "discorduser");
  assert.equal(r1.authorForced, true);
  assert.equal(r1.identifier, "discorduser.CoolMod"); // derived from the forced author

  const r2 = resolveForm({ author: "x", title: "Cool Mod" }, { identifier: "fixed.Id" });
  assert.deepEqual([r2.identifier, r2.identifierForced, r2.authorForced], ["fixed.Id", true, false]);

  const live = { identifier: (form) => `123.${form.title.replace(/\s+/g, "")}` };
  assert.equal(resolveForm({ author: "x", title: "A  B c" }, live).identifier, "123.ABc");
  assert.equal(resolveForm({ author: "x", title: "Z" }, live).identifier, "123.Z");
});

test("buildMetadataJson: fields, trimming, no guid, the target identifier and the three image states", () => {
  const form = { title: " T ", author: " A ", description: "d\nd", version: " 1.0 ", gameVersion: "5.6", tags: ["Skin"] };
  const base = JSON.parse(buildMetadataJson(form));
  assert.deepEqual(base, { title: "T", author: "A", description: "d\nd", version: "1.0", game_version: "5.6", tags: ["Skin"] });
  assert.ok(!("image" in base) && !("guid" in base) && !("identifier" in base)); // a new mod

  assert.equal(JSON.parse(buildMetadataJson({ ...form, image: null })).image, null);
  const withImg = JSON.parse(buildMetadataJson({ ...form, guid: "g", image: { mime: "image/png", data: Uint8Array.from([1, 2, 3]) } }));
  assert.deepEqual(withImg.image, { mime: "image/png", data: "AQID" });
  assert.ok(!("guid" in withImg)); // never sent: the server writes a fresh revision GUID

  // an update names its mod; the forced (display) identifier is never sent as a target
  const update = JSON.parse(buildMetadataJson({ ...form, identifier: "42.T", targetIdentifier: " 42.Old " }));
  assert.equal(update.identifier, "42.Old");
  assert.ok(!("identifier" in JSON.parse(buildMetadataJson({ ...form, identifier: "42.T", targetIdentifier: " " }))));
});

test("confirmText and titleFromBase", () => {
  assert.equal(confirmText(" Mod ", "1.2"), "Upload “Mod” v1.2 to the catalog?");
  assert.equal(confirmText("Mod", ""), "Upload “Mod” to the catalog?");
  assert.equal(doneText("Mod", "1.2"), "Done — “Mod” v1.2 is now in the catalog.");
  assert.equal(doneText("Mod", ""), "Done — “Mod” is now in the catalog.");
  assert.equal(titleFromBase("pakchunk_my-mod"), "pakchunk my mod");
});

// ---------------------------------------------------------- the request set

test("part ranges cover a file exactly", () => {
  assert.equal(partCount(0), 1);
  assert.equal(partCount(PART_SIZE), 1);
  assert.equal(partCount(PART_SIZE + 1), 2);
  const size = PART_SIZE * 2 + 5;
  assert.deepEqual([0, 1, 2].map((i) => partRange(i, size)),
    [[0, PART_SIZE], [PART_SIZE, PART_SIZE * 2], [PART_SIZE * 2, size]]);
});

test("buildManifest: files in order, part counts, optional metadata hash", () => {
  const files = [{ name: "a.utoc", sha256: "aa", size: 10 }, { name: "a.pak", sha256: "bb", size: PART_SIZE + 1 }];
  assert.deepEqual(buildManifest(files, "cc"), {
    files: [{ name: "a.utoc", sha256: "aa", parts: 1 }, { name: "a.pak", sha256: "bb", parts: 2 }],
    metadata: { sha256: "cc" },
  });
  assert.ok(!("metadata" in buildManifest(files, null)));
});

test("planRequests: manifest, metadata, then each part in file order", () => {
  const files = [{ name: "a.utoc", size: 10 }, { name: "a.pak", size: PART_SIZE + 1 }];
  const plan = planRequests(files, true);
  assert.deepEqual(plan.map((r) => [r.kind, r.filename, r.fileIdx, r.partIdx, r.partCount]), [
    ["manifest", "manifest.json", -1, 0, 1],
    ["metadata", "metadata.json", -2, 0, 1],
    ["part", "a.utoc", 0, 0, 1],
    ["part", "a.pak", 1, 0, 2],
    ["part", "a.pak", 1, 1, 2],
  ]);
  assert.deepEqual(plan[4].range, [PART_SIZE, PART_SIZE + 1]);
  assert.equal(planRequests(files, false).length, 4);
});

test("sha256Hex", async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// ------------------------------------------------------------ the catalog

test("findPublishedMod: a new mod, a new version of a known id, and non-matches", () => {
  const before = [{ id: "a", name: "Alpha", version: "1.0", file: "f1", updated: "t1" }];
  const target = { id: null, name: "beta", version: "2.0" };

  assert.equal(findPublishedMod(before, before, target), null);
  const added = [...before, { id: "b", name: "Beta", version: "2.0", file: "f2", updated: "t2" }];
  assert.equal(findPublishedMod(before, added, target).id, "b");
  assert.equal(findPublishedMod(before, added, { ...target, version: "3.0" }), null);

  const bumped = [{ id: "a", name: "Alpha", version: "1.1", file: "f3", updated: "t3" }];
  assert.equal(findPublishedMod(before, bumped, { id: "a", name: "x", version: "1.1" }).version, "1.1");
  assert.equal(findPublishedMod(before, bumped, { id: "a", name: "x", version: "1.0" }), null);
  // an unchanged known mod is not "published by this upload"
  assert.equal(findPublishedMod(before, before, { id: "a", name: "Alpha", version: "1.0" }), null);
  // ids are identifiers, matched case-insensitively
  const minted = [...before, { id: "42.CoolMod", name: "Cool Mod", version: "1", file: "f4", updated: "t4" }];
  assert.equal(findPublishedMod(before, minted, { id: "42.coolmod", name: "x", version: "1" }).id, "42.CoolMod");
});
