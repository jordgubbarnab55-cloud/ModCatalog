// A fake D1 matching prepared statements by their SQL string, with
// SQLite-like transition semantics and changed-row counts
// (`meta.changes`). Covers the forum ingestion statements (FSQL) and the
// auth statements (ASQL). Nothing touches the network.

import { FSQL } from "../../src/forum.js";
import { ASQL } from "../../src/auth.js";

export class FakeD1 {
  constructor() {
    this.rows = new Map();      // forum_posts: tid -> row
    this.tokens = new Map();    // tokens: hash -> row
    this.codes = new Map();     // login_codes: hash -> row
  }
  // -- test introspection
  tokenRows() { return [...this.tokens.values()]; }
  codeRows() { return [...this.codes.values()]; }
  row(tid) { return this.rows.get(tid) || null; }
  insert(tid, owner_id, owner_name, status, last_msg_id, created_at) {
    if (this.rows.has(tid)) return 0;
    this.rows.set(tid, {
      thread_id: tid, owner_id, owner_name, status,
      prompt_msg: null, last_msg_id, created_at,
      prompt_sent_at: null, auto_due: null, dispatched_at: null,
      attempts: 0, detail: null, ident_key: null, pkg_sha256: null, pkg_size: null,
    });
    return 1;
  }
  prepare(sql) {
    const self = this;
    return {
      bind(...args) {
        const run = () => self.exec(sql, args);
        return {
          __exec: run,
          run: async () => ({ meta: { changes: run() } }),
          first: async () => {
            const out = run();
            return Array.isArray(out) ? (out[0] || null) : out;
          },
          all: async () => {
            const out = run();
            return { results: Array.isArray(out) ? out : (out ? [out] : []) };
          },
        };
      },
    };
  }
  batch(stmts) {
    const out = [];
    for (const st of stmts) out.push({ meta: { changes: st.__exec() } });
    return out;
  }
  // Returns the changed-row count (or the row/rows for reads).
  exec(sql, a) {
    const R = (tid) => this.rows.get(tid);
    const set = (tid, patch) => { if (R(tid)) Object.assign(R(tid), patch); };
    switch (sql) {
      // ---- forum_posts (FSQL)
      case FSQL.insertRow:
        return this.insert(a[0], a[1], a[2], a[3], a[4], a[5]);
      case FSQL.getRow:
        return R(a[0]) || null;
      case FSQL.listStatus:
        return [...this.rows.values()].filter((r) => r.status === a[0]);
      case FSQL.deleteRow: {
        const n = this.rows.delete(a[0]) ? 1 : 0;
        return n;
      }
      case FSQL.setPrompted: {
        const r = R(a[0]);
        if (r && r.status === "prompting") {
          set(a[0], { status: "awaiting", prompt_msg: a[1], prompt_sent_at: a[2], auto_due: a[3], last_msg_id: a[4] });
          return 1;
        }
        return 0;
      }
      case FSQL.packageAppeared: {
        const r = R(a[0]);
        if (r && r.status === "awaiting_package") { set(a[0], { status: "prompting", last_msg_id: a[1] }); return 1; }
        return 0;
      }
      case FSQL.startProcessing: {
        const r = R(a[0]);
        if (r && r.status === "awaiting") {
          set(a[0], { status: "processing", dispatched_at: a[1], attempts: r.attempts + 1 });
          return 1;
        }
        return 0;
      }
      case FSQL.revertToAwaiting: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { status: "awaiting", dispatched_at: null }); return 1; }
        return 0;
      }
      case FSQL.setDispatched: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { pkg_size: a[1], detail: "dispatched" }); return 1; }
        return 0;
      }
      case FSQL.markDeclined: {
        const r = R(a[0]);
        if (r && r.status === "awaiting") { set(a[0], { status: "declined" }); return 1; }
        return 0;
      }
      case FSQL.markUnconfirmed: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { status: "unconfirmed" }); return 1; }
        return 0;
      }
      case FSQL.markPublished: {
        const r = R(a[0]);
        if (r && (r.status === "processing" || r.status === "unconfirmed")) { set(a[0], { status: "published" }); return 1; }
        return 0;
      }
      case FSQL.markFailed: {
        const r = R(a[0]);
        if (r && r.status === "awaiting") { set(a[0], { status: "failed", detail: a[1] }); return 1; }
        return 0;
      }
      case FSQL.markFailedProcessing: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { status: "failed", detail: a[1] }); return 1; }
        return 0;
      }
      case FSQL.setUploaded: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { pkg_sha256: a[1], detail: "uploaded" }); return 1; }
        return 0;
      }
      case FSQL.touchLastMsg: {
        const r = R(a[0]);
        if (r) { set(a[0], { last_msg_id: a[1] }); return 1; }
        return 0;
      }
      case FSQL.setIdentKey: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { ident_key: a[1] }); return 1; }
        return 0;
      }
      case FSQL.setPromptMsg: {
        const r = R(a[0]);
        if (r) { r.prompt_msg = a[1]; return 1; }
        return 0;
      }
      case FSQL.cleanupTerminal:
      case FSQL.cleanupAwaitingPackage:
      case FSQL.cleanupUnconfirmed: {
        let n = 0;
        for (const r of [...this.rows.values()]) {
          const hit =
            (sql === FSQL.cleanupTerminal &&
              ["published", "declined", "failed"].includes(r.status)) ||
            (sql === FSQL.cleanupAwaitingPackage && r.status === "awaiting_package") ||
            (sql === FSQL.cleanupUnconfirmed && r.status === "unconfirmed");
          if (hit && r.created_at < a[0]) { this.rows.delete(r.thread_id); n++; }
        }
        return n;
      }
      // ---- tokens + login_codes (ASQL)
      case ASQL.deleteManual: {
        let n = 0;
        for (const [h, r] of this.tokens)
          if (r.discord_id === a[0] && r.kind === "manual") { this.tokens.delete(h); n++; }
        return n;
      }
      case ASQL.insertToken:
        this.tokens.set(a[0], { hash: a[0], discord_id: a[1], username: a[2], kind: a[3],
          created_at: a[4], expires_at: a[5] });
        return 1;
      case ASQL.getToken:
        return this.tokens.get(a[0]) || null;
      case ASQL.deleteWeb: {
        const r = this.tokens.get(a[0]);
        if (r && r.kind === "web") { this.tokens.delete(a[0]); return 1; }
        return 0;
      }
      case ASQL.deleteAllTokens: {
        let n = 0;
        for (const [h, r] of this.tokens)
          if (r.discord_id === a[0]) { this.tokens.delete(h); n++; }
        return n;
      }
      case ASQL.codeCount60s:
        return { n: [...this.codes.values()].filter((r) => r.discord_id === a[0] && r.created_at > a[1]).length };
      case ASQL.invalidateCodes: {
        let n = 0;
        for (const r of this.codes.values())
          if (r.discord_id === a[0] && !r.used_at) { r.used_at = a[1]; n++; }
        return n;
      }
      case ASQL.insertCode:
        this.codes.set(a[0], { hash: a[0], discord_id: a[1], username: a[2],
          created_at: a[3], expires_at: a[4], used_at: null });
        return 1;
      case ASQL.deleteOldCodes: {
        let n = 0;
        for (const [h, r] of this.codes)
          if (r.created_at < a[0]) { this.codes.delete(h); n++; }
        return n;
      }
      case ASQL.getCode:
        return this.codes.get(a[0]) || null;
      case ASQL.burnCode: {
        const r = this.codes.get(a[1]);
        if (r && !r.used_at && r.expires_at > a[0]) { r.used_at = a[0]; return 1; }
        return 0;
      }
      default:
        throw new Error(`FakeD1: unknown statement ${sql}`);
    }
  }
}
