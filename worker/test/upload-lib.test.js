// Offline tests for the pure helpers behind site/upload.html
// (run together with the worker tests: `node --test` from worker/ or the repo root).

import test from "node:test";
import assert from "node:assert/strict";
import { configOk, statusMessage, findNewMod, findNewModByName, POLL_MAX_MS } from "../../site/upload-lib.js";

test("configOk rejects placeholders, empty, non-http and missing values", () => {
  assert.equal(configOk("REPLACE_ME_WORKER_URL"), false);
  assert.equal(configOk("REPLACE_ME"), false);
  assert.equal(configOk(""), false);
  assert.equal(configOk(undefined), false);
  assert.equal(configOk(null), false);
  assert.equal(configOk("http://insecure.example.com"), false);
  assert.equal(configOk("https://modcatalog.example.workers.dev"), true);
  assert.equal(configOk("https://modcatalog.example.workers.dev/discord?x=1"), true);
});

test("statusMessage covers every documented status", () => {
  assert.match(statusMessage(202), /queued/i);
  assert.match(statusMessage(401), /token/i);
  assert.match(statusMessage(411), /size/i);
  assert.match(statusMessage(413), /100 MB/i);
  assert.match(statusMessage(429), /daily/i);
  assert.match(statusMessage(400), /\.zip/i);
  assert.match(statusMessage(502), /github/i);
  assert.match(statusMessage(503), /inbox/i);
  assert.match(statusMessage(500), /HTTP 500/);
  assert.match(statusMessage(599), /server error/i);
  assert.match(statusMessage("network"), /network/i);
});

test("findNewMod matches by size and excludes previously known ids", () => {
  const before = [{ id: "a", size: 100 }, { id: "b", size: 200 }];
  const after = [
    { id: "a", size: 100 },
    { id: "b", size: 200 },
    { id: "c", size: 200 },
    { id: "d", size: 999 },
  ];
  const hit = findNewMod(before, after, 200);
  assert.ok(hit);
  assert.equal(hit["id"], "c");
  assert.equal(findNewMod(before, after, 12345), null, "unknown size: nothing new");
  assert.equal(findNewMod(null, after, 200)["id"], "b", "empty 'before': first matching mod is new");
});

test("findNewModByName matches by name (null = any new mod)", () => {
  const before = [{ id: "a", name: "Old Mod" }];
  const after = [
    { id: "a", name: "Old Mod" },
    { id: "b", name: "New Mod" },
    { id: "c", name: "Other Mod" },
  ];
  assert.equal(findNewModByName(before, after, "New Mod")["id"], "b");
  assert.equal(findNewModByName(before, after, "new mod")["id"], "b", "case-insensitive");
  assert.equal(findNewModByName(before, after, "Missing"), null);
  assert.equal(findNewModByName(before, after, null)["id"], "b", "null name: first new mod");
  assert.equal(findNewModByName(after, after, null), null, "nothing new: null");
});

test("POLL_MAX_MS is about 3 minutes", () => {
  assert.ok(POLL_MAX_MS >= 170000 && POLL_MAX_MS <= 190000);
});
