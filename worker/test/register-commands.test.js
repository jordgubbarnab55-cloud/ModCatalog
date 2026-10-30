// Offline tests for the guild-scoped slash-command registration script
// (node --test, Node 18+). A mock fetch stands in for the Discord API;
// nothing touches the network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS,
  listGuilds,
  registerForGuilds,
  retireGlobal,
  runCli,
} from "../scripts/register-commands.mjs";

// ------------------------------------------------------------- fakes

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler ? handler(url, init) : new Response(null, { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const GUILDS = [
  { id: "g1", name: "Alpha" },
  { id: "g2", name: "Beta" },
];

// ----------------------------------------------------- registration

test("happy path: one bulk PUT per guild, full command set payload", async () => {
  const f = makeFetch();
  const r = await registerForGuilds("app1", "tok1", GUILDS, f);
  assert.equal(r.registered.length, 2);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.failed.length, 0);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map((c) => c.url), [
    "https://discord.com/api/v10/applications/app1/guilds/g1/commands",
    "https://discord.com/api/v10/applications/app1/guilds/g2/commands",
  ]);
  for (const c of f.calls) {
    assert.equal(c.init.method, "PUT");
    assert.equal(c.init.headers["Authorization"], "Bot tok1");
    assert.equal(c.init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(c.init.body), COMMANDS);
  }
  // payload shape: the single, parameter-free "token" command
  // (subcommand-bearing commands never rendered for this app, see the
  // COMMANDS comment in the script)
  assert.equal(COMMANDS.length, 1);
  assert.equal(COMMANDS[0].name, "token");
  assert.equal(COMMANDS[0].options, undefined);
  assert.ok(COMMANDS[0].description.length <= 100, "description within Discord's limit");
});

test("per-guild 403 isolation: the rest still register", async () => {
  const f = makeFetch((url) =>
    url.endsWith("/g1/commands") ? new Response("forbidden", { status: 403 }) : new Response(null, { status: 200 }));
  const r = await registerForGuilds("app1", "tok1", GUILDS, f);
  assert.equal(f.calls.length, 2, "the 403 did not stop the other guild");
  assert.deepEqual(r.registered.map((g) => g.id), ["g2"]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].guild.id, "g1");
  assert.equal(r.failed.length, 0);
});

test("a non-403 HTTP error (and a thrown error) is a failure; processing continues", async () => {
  const f = makeFetch((url) => {
    if (url.endsWith("/g1/commands")) return new Response("boom", { status: 500 });
    if (url.endsWith("/g2/commands")) throw new Error("network down");
    return new Response(null, { status: 200 });
  });
  const r = await registerForGuilds("app1", "tok1", GUILDS, f);
  assert.equal(f.calls.length, 2);
  assert.equal(r.registered.length, 0);
  assert.equal(r.failed.length, 2);
  assert.equal(r.failed[0].status, 500);
  assert.equal(r.failed[0].detail, "boom");
  assert.equal(r.failed[1].status, null);
  assert.match(r.failed[1].detail, /network down/);
});

test("auto-discovery: GET /users/@me/guilds lists the targets", async () => {
  const f = makeFetch((url) =>
    url.endsWith("/users/@me/guilds")
      ? new Response(JSON.stringify([
          { id: "g9", name: "Solo", owner: true, permissions: "8" },
          { id: "g8", name: "Other" },
        ]), { status: 200 })
      : new Response(null, { status: 200 }));
  const guilds = await listGuilds("tok1", f);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/users\/@me\/guilds$/);
  assert.equal(f.calls[0].init.headers["Authorization"], "Bot tok1");
  assert.deepEqual(guilds, [{ id: "g9", name: "Solo" }, { id: "g8", name: "Other" }]);
});

test("auto-discovery: a non-2xx listing fails loudly", async () => {
  const f = makeFetch(() => new Response("nope", { status: 401 }));
  await assert.rejects(listGuilds("tok1", f), /HTTP 401/);
});

// --------------------------------------------------- --retire-global

test("ordering: the global delete happens only when ALL guilds succeeded", async () => {
  // a hard failure blocks the delete
  const f1 = makeFetch((url) =>
    url.endsWith("/g1/commands") ? new Response("boom", { status: 500 }) : new Response(null, { status: 200 }));
  const r1 = await runCli("app1", "tok1", GUILDS, f1, { retireGlobal: true });
  assert.equal(f1.calls.length, 2, "no DELETE after a failed guild");
  assert.ok(!f1.calls.some((c) => c.url.includes("/commands/token")));
  assert.ok(r1.retire && r1.retire.skipped);

  // a skipped (403) guild also blocks the delete
  const f2 = makeFetch((url) =>
    url.endsWith("/g1/commands") ? new Response("forbidden", { status: 403 }) : new Response(null, { status: 200 }));
  const r2 = await runCli("app1", "tok1", GUILDS, f2, { retireGlobal: true });
  assert.equal(f2.calls.length, 2);
  assert.ok(r2.retire && r2.retire.skipped);

  // all success: the DELETE is sent, AFTER every PUT
  const f3 = makeFetch((url, init = {}) => {
    if (init.method === "GET" && url.endsWith("/commands"))
      return new Response(JSON.stringify([{ id: "1565303852956131431", name: "token" }]), { status: 200 });
    return new Response(null, { status: 200 });
  });
  const r3 = await runCli("app1", "tok1", GUILDS, f3, { retireGlobal: true });
  const putIdx = f3.calls.map((c, i) => (c.init.method === "PUT" ? i : -1)).filter((i) => i >= 0);
  const del = f3.calls.findIndex((c) => c.init.method === "DELETE");
  assert.equal(putIdx.length, 2);
  assert.ok(del > -1, "DELETE sent when all guilds registered");
  assert.ok(del > Math.max(...putIdx), "DELETE comes after the last PUT");
  assert.equal(f3.calls[del].url, "https://discord.com/api/v10/applications/app1/commands/1565303852956131431");
  assert.equal(f3.calls[del].init.headers["Authorization"], "Bot tok1");
  assert.ok(r3.retire && r3.retire.ok && r3.retire.deleted);
});

test("retire: deletes by the listed snowflake id (not by name)", async () => {
  const f = makeFetch((url, init = {}) => {
    if (init.method === "GET" && url.endsWith("/commands"))
      return new Response(JSON.stringify([{ id: "123", name: "token" }, { id: "456", name: "other" }]), { status: 200 });
    return new Response(null, { status: 200 });
  });
  const r = await retireGlobal("app1", "tok1", f);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, "https://discord.com/api/v10/applications/app1/commands/123");
  assert.equal(f.calls[1].init.method, "DELETE");
  assert.deepEqual(r, { ok: true, deleted: true });
});

test("retire: an absent token command is a success with no delete", async () => {
  const f = makeFetch((url, init = {}) => {
    if (init.method === "GET" && url.endsWith("/commands"))
      return new Response(JSON.stringify([{ id: "456", name: "other" }]), { status: 200 });
    return new Response(null, { status: 200 });
  });
  const r = await retireGlobal("app1", "tok1", f);
  assert.equal(f.calls.length, 1, "no DELETE when the command is already gone");
  assert.deepEqual(r, { ok: true, deleted: false });
});

test("retire: delete 404 is tolerated; list/delete errors are failures", async () => {
  const list = [{ id: "123", name: "token" }];

  const f404 = makeFetch((url, init = {}) => {
    if (init.method === "GET" && url.endsWith("/commands"))
      return new Response(JSON.stringify(list), { status: 200 });
    return new Response("gone", { status: 404 });
  });
  const r404 = await retireGlobal("app1", "tok1", f404);
  assert.deepEqual(r404, { ok: true, deleted: false });

  const f500 = makeFetch((url, init = {}) => {
    if (init.method === "GET" && url.endsWith("/commands"))
      return new Response(JSON.stringify(list), { status: 200 });
    return new Response("boom", { status: 500 });
  });
  const r500 = await retireGlobal("app1", "tok1", f500);
  assert.equal(r500.ok, false);
  assert.equal(r500.status, 500);
  assert.equal(r500.detail, "boom");

  const fThrow = makeFetch(() => { throw new Error("offline"); });
  const rThrow = await retireGlobal("app1", "tok1", fThrow);
  assert.equal(rThrow.ok, false);
  assert.match(rThrow.detail, /offline/);

  const fListErr = makeFetch((url, init = {}) => {
    if (init.method === "GET" && url.endsWith("/commands"))
      return new Response("denied", { status: 401 });
    return new Response(null, { status: 200 });
  });
  const rListErr = await retireGlobal("app1", "tok1", fListErr);
  assert.equal(rListErr.ok, false);
  assert.equal(rListErr.status, 401);
  assert.equal(fListErr.calls.length, 1, "no DELETE after a failed list");
});

test("dry-run sends no mutation requests", async () => {
  const f = makeFetch(() => { throw new Error("should not be called"); });
  const r = await runCli("app1", "tok1", GUILDS, f, { dryRun: true, retireGlobal: true });
  assert.equal(f.calls.length, 0);
  assert.equal(r.registered.length, 2);
  assert.equal(r.retire.ok, true);
  assert.equal(r.retire.dryRun, true);
});
