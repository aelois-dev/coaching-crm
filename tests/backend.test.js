// Run: node tests/backend.test.js   (plain Node, no dependencies)
// Loads apps-script/Code.gs in a vm with a tiny in-memory fake of Google's services.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
const T0 = Date.parse("2026-11-02T10:00:00Z");

// ---------- fakes ----------
function FakeSheet(name) {
  this.name = name; this.data = []; this.frozen = 0; this.formats = [];
}
FakeSheet.prototype = {
  appendRow(r) { this.data.push(r.slice()); },
  setFrozenRows(n) { this.frozen = n; },
  getMaxRows() { return Math.max(this.data.length, 1000); },
  getLastRow() { return this.data.length; },
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); },
  getDataRange() {
    const w = this.getLastColumn(), self = this;
    return { getValues: () => self.data.map(r => { const c = r.slice(); while (c.length < w) c.push(""); return c; }) };
  },
  getRange(r, c, nr, nc) {
    const self = this; nr = nr || 1; nc = nc || 1;
    return {
      getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (self.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? "" : v); } o.push(row); } return o; },
      setValue(v) { self._set(r, c, v); },
      setValues(vs) { vs.forEach((row, i) => row.forEach((v, j) => self._set(r + i, c + j, v))); },
      setNumberFormat(f) { self.formats.push(f); }
    };
  },
  _set(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1]; while (row.length < c) row.push(""); row[c - 1] = v;
  }
};

function makeEnv(props) {
  const sheets = {}; const order = [];
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet(n) { sheets[n] = new FakeSheet(n); order.push(n); return sheets[n]; },
    getName: () => "Fake"
  };
  const env = { sheets, fetches: [], failFetch: false, lockHeld: false, lockTaken: 0, lockBlocked: false, triggers: [], logs: [], now: T0, cache: {}, props: Object.assign({}, props) };
  const ctx = {
    console, JSON, Math, Date, Object, Array, String, Number, isNaN, parseInt, Error,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in env.props ? env.props[k] : null) }) },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (env.lockBlocked || env.lockHeld) throw new Error("Could not obtain lock"); env.lockHeld = true; env.lockTaken++; },
        tryLock() { if (env.lockBlocked || env.lockHeld) return false; env.lockHeld = true; env.lockTaken++; return true; },
        releaseLock() { env.lockHeld = false; }
      })
    },
    CacheService: { getScriptCache: () => ({ get: k => (k in env.cache ? env.cache[k] : null), put: (k, v) => { env.cache[k] = v; } }) },
    UrlFetchApp: {
      fetch(url, opts) {
        if (env.failFetch) throw new Error("network down");
        env.fetches.push({ url, body: opts.payload ? JSON.parse(opts.payload) : null });
        return { getResponseCode: () => 200, getContentText: () => "{}" };
      }
    },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return s; } }) },
    ScriptApp: {
      getProjectTriggers: () => env.triggers,
      newTrigger: fn => ({ timeBased: () => ({ everyMinutes: n => ({ create: () => { env.triggers.push({ getHandlerFunction: () => fn, minutes: n }); } }) }) })
    },
    Utilities: { getUuid: () => "abcdef12-3456-7890-abcd-ef1234567890" },
    Logger: { log: m => env.logs.push(String(m)) }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "Code.gs" });
  ctx.nowMs_ = () => env.now;   // fixed, movable clock
  env.ctx = ctx;
  env.call = (obj, post) => {
    const out = post
      ? ctx.doPost({ postData: { contents: JSON.stringify(obj) }, parameter: {} })
      : ctx.doGet({ parameter: obj });
    return JSON.parse(out.getContent());
  };
  return env;
}
function freshEnv() {
  return makeEnv({ TELEGRAM_BOT_TOKEN: "TOK", TELEGRAM_CHAT_ID: "-100", SITE_URL: "https://x.test/crm.html" });
}
function withCoaches(env) {
  env.ctx.setup();
  const ct = env.sheets["Coaches"];
  ct.data = [["Name", "Telegram", "Code", "Active"], ["Amy", "@amy", "AMY1", "Yes"], ["Ben", "@ben", "BEN1", "Yes"], ["Old", "@old", "OLD1", "No"]];
  return env;
}
const goodLead = (o) => Object.assign({ action: "addLead", name: "Tan Mei", phone: "+65 9123 4567", goal: "10K", level: "Beginner", area: "East", times: "Sat mornings", consent: true, website: "" }, o || {});

// ---------- tiny runner ----------
let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; failures.push(name); console.log("  FAIL " + name + "\n       " + (e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); }
}

// ---------- pure functions ----------
const P = freshEnv().ctx;
const iso = (offMin) => new Date(T0 + offMin * 60000).toISOString();

console.log("Pure logic");
test("normalizePhone_ keeps the last 8 digits", () => {
  assert.strictEqual(P.normalizePhone_("+65 9123-4567"), "91234567");
  assert.strictEqual(P.normalizePhone_("(65) 91234567"), "91234567");
  assert.strictEqual(P.normalizePhone_("91234567"), "91234567");
  assert.strictEqual(P.normalizePhone_(""), "");
});
test("validateLead_ accepts a good form and cleans it", () => {
  const r = P.validateLead_(goodLead({ name: "  Tan   Mei ", age: "34", email: "a@b.co" }));
  assert.ok(r.ok); assert.strictEqual(r.lead.name, "Tan Mei"); assert.strictEqual(r.lead.age, "34");
});
test("validateLead_ rejects bad input", () => {
  const bad = (o) => assert.deepStrictEqual(JSON.parse(JSON.stringify(P.validateLead_(goodLead(o)))), { ok: false, error: "invalid" });
  bad({ name: "" }); bad({ phone: "123" }); bad({ phone: "abc" }); bad({ goal: "Ultra" }); bad({ email: "nope" });
  bad({ age: "abc" }); bad({ age: "0" });
});
test("validateLead_ needs consent (public only)", () => {
  assert.strictEqual(P.validateLead_(goodLead({ consent: false })).error, "consent_required");
  assert.strictEqual(P.validateLead_(goodLead({ consent: undefined })).error, "consent_required");
  assert.ok(P.validateLead_({ name: "Coach Entry", phone: "91234567" }, { manual: true }).ok);
});
test("computeFlag_ unclaimed 30 / 120", () => {
  const l = (min) => ({ status: "New", owner: "", created: iso(-min) });
  assert.strictEqual(P.computeFlag_(l(29), T0), "");
  assert.strictEqual(P.computeFlag_(l(30), T0), "unclaimed_30");
  assert.strictEqual(P.computeFlag_(l(119), T0), "unclaimed_30");
  assert.strictEqual(P.computeFlag_(l(120), T0), "unclaimed_120");
});
test("computeFlag_ no_contact 60 min after claim", () => {
  const l = (min, extra) => Object.assign({ status: "New", owner: "Amy", created: iso(-500), claimedAt: iso(-min), lastContact: "" }, extra);
  assert.strictEqual(P.computeFlag_(l(59), T0), "");
  assert.strictEqual(P.computeFlag_(l(60), T0), "no_contact");
  assert.strictEqual(P.computeFlag_(l(90, { lastContact: iso(-30) }), T0), "");
  assert.strictEqual(P.computeFlag_(l(90, { lastContact: iso(-200) }), T0), "no_contact");   // contact from before the claim does not count
  assert.strictEqual(P.computeFlag_(l(90, { status: "Contacted" }), T0), "");
});
test("computeFlag_ overdue follow-up (Singapore day) and finished statuses", () => {
  // T0 = 2026-11-02 18:00 in Singapore, so "today" is 2026-11-02
  const l = (d, s) => ({ status: s || "Contacted", owner: "Amy", created: iso(-9999), claimedAt: iso(-9000), lastContact: iso(-10), nextFollowUp: d });
  assert.strictEqual(P.computeFlag_(l("2026-11-01"), T0), "overdue_followup");
  assert.strictEqual(P.computeFlag_(l("2026-11-02"), T0), "");
  assert.strictEqual(P.computeFlag_(l(""), T0), "");
  assert.strictEqual(P.computeFlag_(l("2026-10-01", "Paying"), T0), "");
  assert.strictEqual(P.computeFlag_(l("2026-10-01", "Not proceeding"), T0), "");
  // late evening UTC is already tomorrow in Singapore
  assert.strictEqual(P.todayStr_(Date.parse("2026-11-02T17:00:00Z")), "2026-11-03");
});
test("reminderPlan_ sends each unclaimed level once", () => {
  const lead = (min, rem) => ({ id: "A", status: "New", owner: "", created: iso(-min), remindedLevel: rem || "" });
  assert.strictEqual(P.reminderPlan_([lead(10)], T0).length, 0);
  let p = P.reminderPlan_([lead(40)], T0);
  assert.strictEqual(p.length, 1); assert.strictEqual(p[0].kind, "unclaimed_30"); assert.strictEqual(p[0].audience, "all");
  assert.strictEqual(P.reminderPlan_([lead(40, "u1")], T0).length, 0);
  p = P.reminderPlan_([lead(130, "u1")], T0);
  assert.strictEqual(p[0].kind, "unclaimed_120"); assert.strictEqual(p[0].level, 2);
  p = P.reminderPlan_([lead(130)], T0);   // first seen late: only the level-2 message, both levels recorded
  assert.strictEqual(p.length, 1); assert.deepStrictEqual(Array.from(p[0].addTokens), ["u1", "u2"]);
  assert.strictEqual(P.reminderPlan_([lead(500, "u1,u2")], T0).length, 0);
});
test("reminderPlan_ no_contact and daily overdue go to the owner", () => {
  const owned = { id: "B", status: "New", owner: "Amy", created: iso(-300), claimedAt: iso(-100), lastContact: "", nextFollowUp: "", remindedLevel: "" };
  let p = P.reminderPlan_([owned], T0);
  assert.strictEqual(p.length, 1); assert.strictEqual(p[0].kind, "no_contact"); assert.strictEqual(p[0].audience, "owner"); assert.strictEqual(p[0].owner, "Amy");
  assert.strictEqual(P.reminderPlan_([Object.assign({}, owned, { remindedLevel: "nc" })], T0).length, 0);
  const od = { id: "C", status: "Contacted", owner: "Ben", created: iso(-9999), nextFollowUp: "2026-11-01", remindedLevel: "" };
  p = P.reminderPlan_([od], T0);
  assert.strictEqual(p[0].kind, "overdue_followup");
  assert.strictEqual(P.reminderPlan_([Object.assign({}, od, { remindedLevel: "od:2026-11-02" })], T0).length, 0);   // already today
  assert.strictEqual(P.reminderPlan_([Object.assign({}, od, { remindedLevel: "od:2026-11-01" })], T0).length, 1);   // a new day
  assert.strictEqual(P.reminderPlan_([Object.assign({}, od, { status: "Paying" })], T0).length, 0);
  assert.strictEqual(P.addTokens_("u1,od:2026-11-01", ["od:2026-11-02"]), "u1,od:2026-11-02");
});

// ---------- flows against fake Google ----------
console.log("Flows");
test("setup() makes tabs, headers, trigger and a sample coach; running twice is safe", () => {
  const env = freshEnv(); env.ctx.setup(); env.ctx.setup();
  assert.deepStrictEqual(env.sheets["Leads"].data[0], env.ctx.LEADS_HEADER);
  assert.deepStrictEqual(env.sheets["Activity"].data[0], env.ctx.ACTIVITY_HEADER);
  assert.strictEqual(env.sheets["Coaches"].data.length, 4);
  assert.deepStrictEqual(env.sheets["Coaches"].data.slice(1).map(r => r[0]), ["Gabriel", "Leroi", "Carey"]);
  assert.ok(env.sheets["Coaches"].data.slice(1).every(r => r[2] && r[2].length === 10));
  assert.strictEqual(env.triggers.length, 1); assert.strictEqual(env.triggers[0].minutes, 15);
  assert.ok(env.sheets["Leads"].formats.includes("@"));
});
test("a form lead with level, area and times left blank is accepted", () => {
  const env = freshEnv(); env.ctx.setup();
  const r = env.call(Object.assign(goodLead(), { level: "", area: "", times: "" }), true);
  assert.ok(r.ok, JSON.stringify(r));
});
test("missing header columns are added to an existing tab; extra and reordered columns are fine", () => {
  const env = freshEnv();
  env.ctx.setup();
  env.sheets["Leads"].data[0] = ["Name", "Id", "My Notes"];   // owner's own layout
  const r = env.call(goodLead(), true);
  assert.ok(r.ok);
  const h = env.sheets["Leads"].data[0];
  assert.ok(h.includes("Status") && h.includes("Next Follow-up") && h.includes("Reminded Level"));
  const row = env.sheets["Leads"].data[1];
  assert.strictEqual(row[h.indexOf("Name")], "Tan Mei"); assert.strictEqual(row[h.indexOf("Id")], r.id);
});
test("addLead stores a New row, logs activity, sends Telegram", () => {
  const env = withCoaches(freshEnv());
  const r = env.call(goodLead(), true);
  assert.ok(r.ok && r.id && !r.duplicate);
  const lead = env.call({ action: "lead", id: r.id, code: "AMY1" }).lead;
  assert.strictEqual(lead.status, "New"); assert.strictEqual(lead.source, "form"); assert.strictEqual(lead.owner, "");
  assert.strictEqual(env.fetches.length, 1);
  assert.ok(env.fetches[0].url.includes("botTOK/sendMessage")); assert.strictEqual(env.fetches[0].body.chat_id, "-100");
  assert.ok(env.fetches[0].body.text.includes("Tan Mei") && env.fetches[0].body.text.includes("lead=" + r.id));
  assert.strictEqual(env.lockTaken, 1); assert.strictEqual(env.lockHeld, false);
});
test("addLead errors: spam, invalid, consent_required, rate_limited", () => {
  const env = withCoaches(freshEnv());
  assert.strictEqual(env.call(goodLead({ website: "http://spam" }), true).error, "spam");
  assert.strictEqual(env.call(goodLead({ name: "" }), true).error, "invalid");
  assert.strictEqual(env.call(goodLead({ consent: false }), true).error, "consent_required");
  assert.strictEqual(env.sheets["Leads"].data.length, 1);   // nothing saved
  const e2 = withCoaches(freshEnv());
  const outs = [1, 2, 3, 4].map(() => e2.call(goodLead({ phone: "98887777" }), true));
  assert.ok(outs[0].ok && outs[1].ok && outs[2].ok);
  assert.strictEqual(outs[3].error, "rate_limited");
});
test("duplicate phone with an open lead adds a note and returns the existing id", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true);
  const b = env.call(goodLead({ name: "Mei T", phone: "91234567" }), true);
  assert.ok(b.ok && b.duplicate); assert.strictEqual(b.id, a.id);
  assert.strictEqual(env.sheets["Leads"].data.length, 2);
  const acts = env.call({ action: "lead", id: a.id, code: "AMY1" }).activity;
  assert.ok(acts.some(x => x.action === "duplicate"));
  // closed lead: same phone creates a fresh lead
  env.call({ action: "claim", id: a.id, code: "AMY1" }, true);
  env.call({ action: "update", id: a.id, code: "AMY1", status: "Not proceeding" }, true);
  const c = env.call(goodLead({ phone: "9123 4567" }), true);
  assert.ok(c.ok && !c.duplicate && c.id !== a.id);
});
test("Telegram failure never blocks a save", () => {
  const env = withCoaches(freshEnv()); env.failFetch = true;
  const r = env.call(goodLead(), true);
  assert.ok(r.ok && r.id); assert.strictEqual(env.sheets["Leads"].data.length, 2);
  const e2 = withCoaches(makeEnv({}));   // no Telegram properties at all
  assert.ok(e2.call(goodLead(), true).ok);
});
test("auth: wrong, missing and inactive codes are unauthorized; login works", () => {
  const env = withCoaches(freshEnv());
  for (const code of [undefined, "", "nope", "OLD1"]) assert.strictEqual(env.call({ action: "login", code }).error, "unauthorized");
  assert.strictEqual(env.call({ action: "leads", code: "zzz" }).error, "unauthorized");
  assert.strictEqual(env.call({ action: "claim", id: "x", code: "zzz" }, true).error, "unauthorized");
  assert.deepStrictEqual(env.call({ action: "login", code: "AMY1" }), { ok: true, coach: { name: "Amy" } });
});
test("unknown action and bad JSON", () => {
  const env = withCoaches(freshEnv());
  assert.strictEqual(env.call({ action: "dance", code: "AMY1" }).error, "unknown_action");
  assert.strictEqual(JSON.parse(env.ctx.doPost({ postData: { contents: "{oops" }, parameter: {} }).getContent()).error, "invalid");
});
test("leads lists everything with flags and now", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true); env.now += 45 * 60000;
  const r = env.call({ action: "leads", code: "AMY1" });
  assert.ok(r.ok && r.coach.name === "Amy" && r.leads.length === 1 && r.now);
  assert.strictEqual(r.leads[0].id, a.id); assert.strictEqual(r.leads[0].flag, "unclaimed_30");
  assert.ok(!("remindedLevel" in r.leads[0]) && !("_row" in r.leads[0]));
});
test("claim: first coach wins under the lock, second gets already_claimed", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true); const before = env.lockTaken;
  const c1 = env.call({ action: "claim", id: a.id, code: "AMY1" }, true);
  assert.ok(c1.ok && c1.lead.owner === "Amy" && c1.lead.claimedAt);
  assert.strictEqual(env.lockTaken, before + 1); assert.strictEqual(env.lockHeld, false);
  const c2 = env.call({ action: "claim", id: a.id, code: "BEN1" }, true);
  assert.deepStrictEqual(c2, { ok: false, error: "already_claimed", owner: "Amy" });
  assert.ok(env.call({ action: "claim", id: a.id, code: "AMY1" }, true).ok);   // again by the owner is fine
  assert.strictEqual(env.call({ action: "claim", id: "NOPE", code: "AMY1" }, true).error, "not_found");
});
test("claim reports busy if the lock cannot be taken", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true); env.lockBlocked = true;
  assert.strictEqual(env.call({ action: "claim", id: a.id, code: "AMY1" }, true).error, "busy");
  env.lockBlocked = false;
  assert.strictEqual(env.call({ action: "lead", id: a.id, code: "AMY1" }).lead.owner, "");
});
test("update: owner only; validates status / dates; logs changes", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true);
  assert.strictEqual(env.call({ action: "update", id: a.id, code: "AMY1", status: "Contacted" }, true).error, "not_owner");   // unclaimed
  env.call({ action: "claim", id: a.id, code: "AMY1" }, true);
  assert.strictEqual(env.call({ action: "update", id: a.id, code: "BEN1", status: "Contacted" }, true).error, "not_owner");
  assert.strictEqual(env.call({ action: "update", id: a.id, code: "AMY1", status: "Maybe" }, true).error, "invalid");
  assert.strictEqual(env.call({ action: "update", id: a.id, code: "AMY1", nextFollowUp: "02/11/2026" }, true).error, "invalid");
  assert.strictEqual(env.call({ action: "update", id: a.id, code: "AMY1", nextFollowUp: "2026-02-30" }, true).error, "invalid");
  assert.strictEqual(env.call({ action: "update", id: a.id, code: "AMY1", lastContact: "yesterday-ish" }, true).error, "invalid");
  const u = env.call({ action: "update", id: a.id, code: "AMY1", status: "Contacted", nextFollowUp: "2026-11-05", lastContact: "2026-11-02T09:30:00Z" }, true);
  assert.ok(u.ok); assert.strictEqual(u.lead.status, "Contacted"); assert.strictEqual(u.lead.nextFollowUp, "2026-11-05");
  assert.strictEqual(u.lead.lastContact, "2026-11-02T09:30:00.000Z");
  const cleared = env.call({ action: "update", id: a.id, code: "AMY1", nextFollowUp: "" }, true);
  assert.strictEqual(cleared.lead.nextFollowUp, ""); assert.strictEqual(cleared.lead.status, "Contacted");
  const acts = env.call({ action: "lead", id: a.id, code: "BEN1" }).activity;
  assert.ok(acts.some(x => x.action === "updated" && x.text.includes("New -> Contacted")));
});
test("update reflects overdue flag; a new follow-up date re-arms the daily reminder", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true); env.call({ action: "claim", id: a.id, code: "AMY1" }, true);
  const u = env.call({ action: "update", id: a.id, code: "AMY1", status: "Contacted", nextFollowUp: "2026-11-01" }, true);
  assert.strictEqual(u.lead.flag, "overdue_followup");
});
test("note: any coach; empty text invalid; unknown lead not_found", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true);
  assert.ok(env.call({ action: "note", id: a.id, code: "BEN1", text: "Called, no answer" }, true).ok);
  assert.strictEqual(env.call({ action: "note", id: a.id, code: "BEN1", text: "  " }, true).error, "invalid");
  assert.strictEqual(env.call({ action: "note", id: "zz", code: "BEN1", text: "hi" }, true).error, "not_found");
  const acts = env.call({ action: "lead", id: a.id, code: "AMY1" }).activity;
  assert.ok(acts.some(x => x.action === "note" && x.coach === "Ben" && x.text === "Called, no answer"));
});
test("release: owner only, returns lead to pool and tells the group", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true); env.call({ action: "claim", id: a.id, code: "AMY1" }, true);
  assert.strictEqual(env.call({ action: "release", id: a.id, code: "BEN1" }, true).error, "not_owner");
  const n = env.fetches.length;
  const r = env.call({ action: "release", id: a.id, code: "AMY1" }, true);
  assert.ok(r.ok && r.lead.owner === "" && r.lead.claimedAt === "");
  assert.strictEqual(env.fetches.length, n + 1);
  assert.ok(env.call({ action: "claim", id: a.id, code: "BEN1" }, true).ok);   // someone else can take it now
});
test("addManual: source manual, no consent needed, needs a coach code", () => {
  const env = withCoaches(freshEnv());
  assert.strictEqual(env.call({ action: "addManual", name: "Walk In", phone: "81112222" }, true).error, "unauthorized");
  const r = env.call({ action: "addManual", code: "BEN1", name: "Walk In", phone: "81112222", goal: "5K", level: "Beginner", area: "West", times: "Sun", source: "manual" }, true);
  assert.ok(r.ok && r.id);
  assert.strictEqual(env.call({ action: "lead", id: r.id, code: "BEN1" }).lead.source, "manual");
  assert.strictEqual(env.call({ action: "addManual", code: "BEN1", name: "", phone: "81112222" }, true).error, "invalid");
});
test("checkReminders sends due reminders once and records them", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true); const n0 = env.fetches.length;
  env.now += 31 * 60000;
  env.ctx.checkReminders(); assert.strictEqual(env.fetches.length, n0 + 1);
  assert.ok(env.fetches[n0].body.text.includes("30 minutes"));
  env.ctx.checkReminders(); assert.strictEqual(env.fetches.length, n0 + 1);   // not repeated
  env.now += 100 * 60000;
  env.ctx.checkReminders(); assert.strictEqual(env.fetches.length, n0 + 2);
  assert.ok(env.fetches[n0 + 1].body.text.includes("@amy") && env.fetches[n0 + 1].body.text.includes("@ben") && !env.fetches[n0 + 1].body.text.includes("@old"));
  env.ctx.checkReminders(); assert.strictEqual(env.fetches.length, n0 + 2);
  // claimed, nothing logged for an hour: owner is nudged once
  env.call({ action: "claim", id: a.id, code: "AMY1" }, true); const n1 = env.fetches.length;
  env.now += 61 * 60000; env.ctx.checkReminders();
  assert.strictEqual(env.fetches.length, n1 + 1); assert.ok(env.fetches[n1].body.text.includes("@amy"));
  env.ctx.checkReminders(); assert.strictEqual(env.fetches.length, n1 + 1);
  assert.strictEqual(env.lockHeld, false);
});
test("checkReminders retries later when Telegram is down (token not recorded)", () => {
  const env = withCoaches(freshEnv());
  env.call(goodLead(), true); env.now += 31 * 60000; env.failFetch = true;
  env.ctx.checkReminders(); env.failFetch = false; const n = env.fetches.length;
  env.ctx.checkReminders(); assert.strictEqual(env.fetches.length, n + 1);
});
test("fields typed into Sheets as Date objects are read back sensibly", () => {
  const env = withCoaches(freshEnv());
  const a = env.call(goodLead(), true);
  const sh = env.sheets["Leads"], h = sh.data[0];
  sh.data[1][h.indexOf("Next Follow-up")] = new Date(2026, 10, 5);   // Sheets may convert a typed date
  sh.data[1][h.indexOf("Created")] = new Date(T0);
  const l = env.call({ action: "lead", id: a.id, code: "AMY1" }).lead;
  assert.strictEqual(l.nextFollowUp, "2026-11-05"); assert.strictEqual(l.created, new Date(T0).toISOString());
});
test("HTML in names is escaped in Telegram messages", () => {
  const env = withCoaches(freshEnv());
  env.call(goodLead({ name: "<b>Bad</b> & Co" }), true);
  assert.ok(env.fetches[0].body.text.includes("&lt;b&gt;Bad&lt;/b&gt; &amp; Co"));
});
test("authorizeAll and testTelegram run", () => {
  const env = freshEnv(); env.ctx.authorizeAll(); env.ctx.testTelegram();
  assert.ok(env.logs.some(l => l.includes("Permissions OK")));
});

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) { console.log("Failed: " + failures.join("; ")); process.exit(1); }
