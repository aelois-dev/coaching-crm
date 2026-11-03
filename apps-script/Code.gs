/**
 * Coaching CRM backend (Google Apps Script web app) over a Google Sheet.
 * Implements CONTRACT.md. Paste into Extensions > Apps Script of the Sheet, run setup() once,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone). See README.md.
 *
 * Tabs (created by setup(); columns are read by HEADER NAME so you may reorder or add your own columns):
 *   Leads    : Id | Created | Name | Phone | Email | Age | Goal | Level | Area | Times | Source | Status | Owner | Claimed At | Last Contact | Next Follow-up | Reminded Level
 *   Activity : Lead Id | Time | Coach | Action | Text
 *   Coaches  : Name | Telegram | Code | Active (Yes/No)
 * Script properties: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SITE_URL, SHEET_ID (optional).
 *
 * Layout of this file:
 *   1. Constants
 *   2. PURE LOGIC (no Apps Script globals, unit-tested in Node): normalizePhone_, validateLead_,
 *      computeFlag_, reminderPlan_, tokens, message text
 *   3. Sheet helpers
 *   4. Telegram
 *   5. Actions and routing (doGet / doPost)
 *   6. Reminders, setup(), authorizeAll()
 */

// ===================================================================== 1. Constants
var STATUSES = ["New", "Contacted", "Trial booked", "Paying", "Not proceeding"];
var TERMINAL_STATUSES = ["Paying", "Not proceeding"];
var GOALS = ["5K", "10K", "Half marathon", "Marathon", "General fitness", "Other"];
var LEADS_HEADER = ["Id", "Created", "Name", "Phone", "Email", "Age", "Goal", "Level", "Area", "Times", "Source", "Status", "Owner", "Claimed At", "Last Contact", "Next Follow-up", "Reminded Level"];
var ACTIVITY_HEADER = ["Lead Id", "Time", "Coach", "Action", "Text"];
var COACHES_HEADER = ["Name", "Telegram", "Code", "Active"];
// header name -> lead object key
var LEAD_FIELDS = {
  "Id": "id", "Created": "created", "Name": "name", "Phone": "phone", "Email": "email", "Age": "age",
  "Goal": "goal", "Level": "level", "Area": "area", "Times": "times", "Source": "source", "Status": "status",
  "Owner": "owner", "Claimed At": "claimedAt", "Last Contact": "lastContact", "Next Follow-up": "nextFollowUp",
  "Reminded Level": "remindedLevel"
};
var MIN30 = 30 * 60000, MIN60 = 60 * 60000, MIN120 = 120 * 60000;
// Day boundaries ("today" for follow-up dates) use this offset from UTC. 480 = Singapore (UTC+8). Change if you coach elsewhere.
var TZ_OFFSET_MIN = 480;

// ===================================================================== 2. PURE LOGIC
function nowMs_() { return Date.now(); }

function norm_(s) { return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim(); }
function clean_(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max || 200); }
function digitsOf_(p) { return String(p == null ? "" : p).replace(/\D/g, ""); }

/** Digits only, last 8 (so +65 9123 4567 and 91234567 match). */
function normalizePhone_(p) { var d = digitsOf_(p); return d.slice(-8); }

/** "2026-11-02" for the given moment in the TZ_OFFSET_MIN time zone. */
function todayStr_(nowMs) { return new Date(nowMs + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10); }
function isDateStr_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function ms_(iso) { var t = Date.parse(iso); return isNaN(t) ? NaN : t; }

/**
 * Check form / manual-entry data. Returns {ok:true, lead:{cleaned fields}} or {ok:false, error}.
 * opts.manual = true: coach entry (no consent needed; only name + phone required).
 */
function validateLead_(d, opts) {
  d = d || {}; opts = opts || {};
  var manual = !!opts.manual;
  var name = clean_(d.name, 100), phone = clean_(d.phone, 40), email = clean_(d.email, 120);
  var age = clean_(d.age, 3), goal = clean_(d.goal, 40), level = clean_(d.level, 100);
  var area = clean_(d.area, 100), times = clean_(d.times, 200);
  var digits = digitsOf_(phone);
  if (name.length < 2) return { ok: false, error: "invalid" };
  if (digits.length < 8 || digits.length > 15) return { ok: false, error: "invalid" };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "invalid" };
  if (age) { if (!/^\d{1,3}$/.test(age) || +age < 1 || +age > 120) return { ok: false, error: "invalid" }; }
  if (manual) {
    if (!goal) goal = "Other";
    if (GOALS.indexOf(goal) < 0) return { ok: false, error: "invalid" };
  } else {
    if (GOALS.indexOf(goal) < 0) return { ok: false, error: "invalid" };
    if (!(d.consent === true || d.consent === "true")) return { ok: false, error: "consent_required" };
  }
  return { ok: true, lead: { name: name, phone: phone, email: email, age: age, goal: goal, level: level, area: area, times: times } };
}

function isTerminal_(status) { return TERMINAL_STATUSES.indexOf(status) > -1; }

/**
 * Flag shown on a lead: "" | "unclaimed_30" | "unclaimed_120" | "overdue_followup" | "no_contact".
 * lead: {status, owner, created, claimedAt, lastContact, nextFollowUp} (ISO strings; nextFollowUp YYYY-MM-DD).
 */
function computeFlag_(lead, nowMs) {
  if (isTerminal_(lead.status)) return "";
  if (lead.status === "New" && !lead.owner) {
    var age = nowMs - ms_(lead.created);
    if (age >= MIN120) return "unclaimed_120";
    if (age >= MIN30) return "unclaimed_30";
  }
  if (lead.nextFollowUp && String(lead.nextFollowUp) < todayStr_(nowMs)) return "overdue_followup";
  if (lead.owner && lead.status === "New") {
    var claimed = ms_(lead.claimedAt), last = ms_(lead.lastContact);
    var contacted = !isNaN(last) && (isNaN(claimed) || last >= claimed);
    if (!contacted && !isNaN(claimed) && nowMs - claimed >= MIN60) return "no_contact";
  }
  return "";
}

/** "Reminded Level" cell = comma-separated tokens: u1, u2, nc, od:<date>. */
function parseTokens_(v) { return String(v == null ? "" : v).split(",").map(function (s) { return s.trim(); }).filter(Boolean); }
function addTokens_(existing, add) {
  var t = parseTokens_(existing);
  var hasOd = add.some(function (a) { return a.indexOf("od:") === 0; });
  if (hasOd) t = t.filter(function (x) { return x.indexOf("od:") !== 0; });
  add.forEach(function (a) { if (t.indexOf(a) < 0) t.push(a); });
  return t.join(",");
}
function dropOverdueTokens_(existing) { return parseTokens_(existing).filter(function (x) { return x.indexOf("od:") !== 0; }).join(","); }

/**
 * Which Telegram reminders are due right now? No sheet / network access.
 * Returns [{id, kind, level, audience:"all"|"owner", owner, addTokens:[...]}].
 * Each level is sent once (tokens remember it); the overdue reminder at most once a day.
 */
function reminderPlan_(leads, nowMs) {
  var plan = [], today = todayStr_(nowMs);
  (leads || []).forEach(function (l) {
    if (isTerminal_(l.status)) return;
    var tok = parseTokens_(l.remindedLevel);
    if (l.status === "New" && !l.owner) {
      var age = nowMs - ms_(l.created);
      if (age >= MIN120 && tok.indexOf("u2") < 0) {
        plan.push({ id: l.id, kind: "unclaimed_120", level: 2, audience: "all", owner: "", addTokens: ["u1", "u2"] });
      } else if (age >= MIN30 && age < MIN120 && tok.indexOf("u1") < 0) {
        plan.push({ id: l.id, kind: "unclaimed_30", level: 1, audience: "all", owner: "", addTokens: ["u1"] });
      }
    }
    if (l.owner && l.status === "New" && tok.indexOf("nc") < 0 && computeFlag_(Object.assign({}, l, { nextFollowUp: "" }), nowMs) === "no_contact") {
      plan.push({ id: l.id, kind: "no_contact", level: 1, audience: "owner", owner: l.owner, addTokens: ["nc"] });
    }
    if (l.owner && l.nextFollowUp && String(l.nextFollowUp) < today && tok.indexOf("od:" + today) < 0) {
      plan.push({ id: l.id, kind: "overdue_followup", level: 1, audience: "owner", owner: l.owner, addTokens: ["od:" + today] });
    }
  });
  return plan;
}

function escHtml_(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function leadLink_(siteUrl, id) { return siteUrl ? siteUrl + (siteUrl.indexOf("#") < 0 ? "#" : "&") + "lead=" + encodeURIComponent(id) : ""; }
function leadSummary_(l) {
  return "<b>" + escHtml_(l.name) + "</b> - " + escHtml_(l.goal) + ", " + escHtml_(l.level) + "\n" +
    "Area: " + escHtml_(l.area) + "\nTimes: " + escHtml_(l.times) + "\nPhone: " + escHtml_(l.phone);
}
/** Telegram text (HTML parse mode) for a new lead. */
function newLeadMessage_(l, siteUrl, how) {
  var t = (how || "New runner enquiry") + "\n" + leadSummary_(l);
  var link = leadLink_(siteUrl, l.id);
  return t + "\n\nFirst coach to tap Claim takes it." + (link ? "\n" + link : "");
}
/** Telegram text for a due reminder. handles = {coachName: "@telegram"}; allHandles = ["@a","@b"]. */
function reminderMessage_(item, l, siteUrl, handles, allHandles) {
  var link = leadLink_(siteUrl, l.id), t;
  var who = item.owner ? (escHtml_(handles && handles[item.owner] || "") + " ").trimStart() : "";
  if (item.kind === "unclaimed_30") t = "Still unclaimed after 30 minutes:\n" + leadSummary_(l);
  else if (item.kind === "unclaimed_120") t = escHtml_((allHandles || []).join(" ")) + "\nUNCLAIMED for 2 hours - someone please take this one:\n" + leadSummary_(l);
  else if (item.kind === "no_contact") t = who + escHtml_(item.owner) + ", you claimed this an hour ago and have not logged contact yet:\n" + leadSummary_(l);
  else t = who + escHtml_(item.owner) + ", follow-up was due " + escHtml_(l.nextFollowUp) + ":\n" + leadSummary_(l);
  return t + (link ? "\n" + link : "");
}

// ===================================================================== 3. Sheet helpers
function prop_(k) { var v = PropertiesService.getScriptProperties().getProperty(k); return v == null ? "" : String(v).trim(); }
function spreadsheet_() { var id = prop_("SHEET_ID"); return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet(); }
function iso_(ms) { return new Date(ms).toISOString(); }
function isDate_(v) { return Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime()); }
function pad2_(n) { return (n < 10 ? "0" : "") + n; }
function textCell_(v) { return isDate_(v) ? v.toISOString() : String(v == null ? "" : v).trim(); }
function dateCell_(v) { return isDate_(v) ? v.getFullYear() + "-" + pad2_(v.getMonth() + 1) + "-" + pad2_(v.getDate()) : String(v == null ? "" : v).trim().slice(0, 10); }

function formatText_(sh, ncols) {   // plain-text columns so Sheets never turns ISO times, phones or "+65..." into dates / formulas
  try { sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), ncols).setNumberFormat("@"); } catch (err) { Logger.log("formatText_: " + err); }
}
/** Open a tab, creating it and/or any missing header columns. Returns {sh, headers:[...], values:[[...]]}. */
function table_(name, required, textFormat) {
  var ss = spreadsheet_(), sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name); sh.appendRow(required); sh.setFrozenRows(1);
    if (textFormat) formatText_(sh, required.length);
  }
  var values = sh.getDataRange().getValues();
  if (!values.length) { sh.appendRow(required); values = sh.getDataRange().getValues(); }
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var missing = required.filter(function (h) { return headers.map(norm_).indexOf(norm_(h)) < 0; });
  if (missing.length) {
    missing.forEach(function (h, i) { sh.getRange(1, headers.length + 1 + i).setValue(h); });
    values = sh.getDataRange().getValues();
    headers = values[0].map(function (h) { return String(h).trim(); });
  }
  return { sh: sh, headers: headers, values: values };
}
function col_(tbl, header) { return tbl.headers.map(norm_).indexOf(norm_(header)); }
function rowObj_(tbl, row) { var o = {}; tbl.headers.forEach(function (h, i) { o[norm_(h)] = row[i]; }); return o; }

function leadFromRow_(tbl, row) {
  var o = rowObj_(tbl, row), l = {};
  Object.keys(LEAD_FIELDS).forEach(function (h) {
    var v = o[norm_(h)], k = LEAD_FIELDS[h];
    l[k] = (h === "Next Follow-up") ? dateCell_(v) : textCell_(v);
  });
  return l;
}
function allLeads_(tbl) {
  var out = [];
  for (var r = 1; r < tbl.values.length; r++) {
    var l = leadFromRow_(tbl, tbl.values[r]);
    if (l.id) { l._row = r + 1; out.push(l); }
  }
  return out;
}
function publicLead_(l, nowMs) {
  var o = {};
  Object.keys(l).forEach(function (k) { if (k !== "_row" && k !== "remindedLevel") o[k] = l[k]; });
  o.flag = computeFlag_(l, nowMs);
  return o;
}
function setLeadCells_(tbl, rowNum, fields) {   // fields keyed by HEADER name
  Object.keys(fields).forEach(function (h) {
    var c = col_(tbl, h);
    if (c >= 0) tbl.sh.getRange(rowNum, c + 1).setValue(fields[h]);
  });
}
function leadAt_(tbl, rowNum) {
  var vals = tbl.sh.getRange(rowNum, 1, 1, tbl.headers.length).getValues()[0];
  var l = leadFromRow_(tbl, vals); l._row = rowNum; return l;
}
function findLead_(tbl, id) {
  id = String(id || "").trim();
  if (!id) return null;
  var all = allLeads_(tbl);
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}
function logActivity_(leadId, coach, action, text) {
  var t = table_("Activity", ACTIVITY_HEADER, true);
  var row = t.headers.map(function (h) {
    switch (norm_(h)) {
      case "lead id": return leadId; case "time": return iso_(nowMs_()); case "coach": return coach || "";
      case "action": return action; case "text": return String(text || "").slice(0, 1000); default: return "";
    }
  });
  t.sh.appendRow(row);
}
function newId_() { return "L" + nowMs_().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase(); }

function coachesTable_() { return table_("Coaches", COACHES_HEADER, false); }
function coachList_() {
  var t = coachesTable_(), out = [];
  for (var r = 1; r < t.values.length; r++) {
    var o = rowObj_(t, t.values[r]);
    var c = { name: textCell_(o["name"]), telegram: textCell_(o["telegram"]), code: textCell_(o["code"]), active: norm_(o["active"]) !== "no" };
    if (c.name) out.push(c);
  }
  return out;
}
/** The active coach whose Code matches, or null. */
function authCoach_(code) {
  code = String(code == null ? "" : code).trim();
  if (!code) return null;
  var list = coachList_();
  for (var i = 0; i < list.length; i++) if (list[i].active && list[i].code && list[i].code === code) return list[i];
  return null;
}

/** Counts hits in CacheService; true when over the limit. */
function rateLimited_(cache, key, max, ttlSec) {
  var n = parseInt(cache.get(key) || "0", 10) || 0;
  if (n >= max) return true;
  cache.put(key, String(n + 1), ttlSec);
  return false;
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) { throw new Error("busy"); }
  try { return fn(); } finally { lock.releaseLock(); }
}

// ===================================================================== 4. Telegram
/** Never throws; returns true when Telegram accepted the message. A failure never blocks a save. */
function sendTelegram_(html) {
  try {
    var token = prop_("TELEGRAM_BOT_TOKEN"), chat = prop_("TELEGRAM_CHAT_ID");
    if (!token || !chat) return false;
    var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "post", contentType: "application/json", muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chat, text: String(html).slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true })
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) { Logger.log("Telegram HTTP " + code + ": " + res.getContentText()); return false; }
    return true;
  } catch (err) { Logger.log("Telegram failed: " + err); return false; }
}
function handleMap_() {
  var m = {}, all = [];
  coachList_().forEach(function (c) { if (c.active) { m[c.name] = c.telegram; if (c.telegram) all.push(c.telegram); } });
  return { byName: m, all: all };
}

// ===================================================================== 5. Actions and routing
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function err_(code, extra) { var o = { ok: false, error: code }; if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); return o; }

function isOpen_(l) { return !isTerminal_(l.status); }

/** Shared by addLead and addManual. */
function createLead_(clean, source, coach) {
  var res = withLock_(function () {
    var tbl = table_("Leads", LEADS_HEADER, true), key = normalizePhone_(clean.phone);
    var all = allLeads_(tbl);
    for (var i = 0; i < all.length; i++) {
      if (all[i].phone && normalizePhone_(all[i].phone) === key && isOpen_(all[i])) {
        logActivity_(all[i].id, coach ? coach.name : "", "duplicate", "Same phone number submitted again" + (coach ? " (manual entry)" : " via the form") + ": " + clean.name + ", " + clean.goal + ", " + clean.area + ", " + clean.times);
        return { dup: all[i] };
      }
    }
    var id = newId_(), now = iso_(nowMs_());
    var vals = { "Id": id, "Created": now, "Name": clean.name, "Phone": clean.phone, "Email": clean.email, "Age": clean.age, "Goal": clean.goal, "Level": clean.level,
      "Area": clean.area, "Times": clean.times, "Source": source, "Status": "New", "Owner": "", "Claimed At": "", "Last Contact": "", "Next Follow-up": "", "Reminded Level": "" };
    tbl.sh.appendRow(tbl.headers.map(function (h) { var v = vals[LEADS_HEADER.filter(function (x) { return norm_(x) === norm_(h); })[0]]; return v == null ? "" : v; }));
    logActivity_(id, coach ? coach.name : "", "created", source === "manual" ? "Added manually" : "Submitted the form");
    var l = { id: id, created: now, status: "New" }; Object.keys(clean).forEach(function (k) { l[k] = clean[k]; });
    return { lead: l };
  });
  var site = prop_("SITE_URL");
  if (res.dup) {
    sendTelegram_("Repeat enquiry (same phone, already in the list" + (res.dup.owner ? ", owned by " + escHtml_(res.dup.owner) : ", unclaimed") + "):\n" + leadSummary_(res.dup) + (leadLink_(site, res.dup.id) ? "\n" + leadLink_(site, res.dup.id) : ""));
    return { ok: true, id: res.dup.id, duplicate: true };
  }
  sendTelegram_(newLeadMessage_(res.lead, site, source === "manual" ? "New lead added by " + escHtml_(coach.name) : "New runner enquiry"));
  return { ok: true, id: res.lead.id };
}

function actionAddLead_(p) {
  if (clean_(p.website, 200)) return err_("spam");
  var v = validateLead_(p, { manual: false });
  if (!v.ok) return err_(v.error);
  var cache = CacheService.getScriptCache();
  if (rateLimited_(cache, "rl:all", 60, 600) || rateLimited_(cache, "rl:p:" + normalizePhone_(v.lead.phone), 3, 3600)) return err_("rate_limited");
  return createLead_(v.lead, "form", null);
}
function actionAddManual_(p, coach) {
  var v = validateLead_(p, { manual: true });
  if (!v.ok) return err_(v.error);
  return createLead_(v.lead, "manual", coach);
}

function actionLogin_(p, coach) { return { ok: true, coach: { name: coach.name } }; }

function actionLeads_(p, coach) {
  var now = nowMs_(), tbl = table_("Leads", LEADS_HEADER, true);
  var list = allLeads_(tbl).map(function (l) { return publicLead_(l, now); });
  list.sort(function (a, b) { return a.created < b.created ? 1 : a.created > b.created ? -1 : 0; });
  return { ok: true, coach: { name: coach.name }, leads: list, now: iso_(now) };
}

function actionLead_(p, coach) {
  var now = nowMs_(), l = findLead_(table_("Leads", LEADS_HEADER, true), p.id);
  if (!l) return err_("not_found");
  var at = table_("Activity", ACTIVITY_HEADER, true), acts = [];
  for (var r = 1; r < at.values.length; r++) {
    var o = rowObj_(at, at.values[r]);
    if (textCell_(o["lead id"]) === l.id) acts.push({ time: textCell_(o["time"]), coach: textCell_(o["coach"]), action: textCell_(o["action"]), text: textCell_(o["text"]) });
  }
  acts.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
  return { ok: true, lead: publicLead_(l, now), activity: acts };
}

function actionClaim_(p, coach) {
  var res = withLock_(function () {
    var tbl = table_("Leads", LEADS_HEADER, true), l = findLead_(tbl, p.id);
    if (!l) return err_("not_found");
    if (l.owner && l.owner !== coach.name) return err_("already_claimed", { owner: l.owner });
    if (l.owner === coach.name) return { ok: true, lead: publicLead_(l, nowMs_()) };   // claiming your own lead again changes nothing
    setLeadCells_(tbl, l._row, { "Owner": coach.name, "Claimed At": iso_(nowMs_()), "Reminded Level": "" });
    logActivity_(l.id, coach.name, "claimed", "Claimed the lead");
    return { ok: true, lead: publicLead_(leadAt_(tbl, l._row), nowMs_()) };
  });
  return res;
}

function actionUpdate_(p, coach) {
  var has = function (k) { return p[k] !== undefined && p[k] !== null; };
  // validate input before taking the lock
  var status, nfu, lc;
  if (has("status")) { status = clean_(p.status, 40); if (STATUSES.indexOf(status) < 0) return err_("invalid"); }
  if (has("nextFollowUp")) { nfu = clean_(p.nextFollowUp, 20); if (nfu !== "" && !isDateStr_(nfu)) return err_("invalid"); }
  if (has("lastContact")) {
    lc = clean_(p.lastContact, 40);
    if (lc !== "") { var t = Date.parse(lc); if (isNaN(t)) return err_("invalid"); lc = new Date(t).toISOString(); }
  }
  return withLock_(function () {
    var tbl = table_("Leads", LEADS_HEADER, true), l = findLead_(tbl, p.id);
    if (!l) return err_("not_found");
    if (l.owner !== coach.name) return err_("not_owner");
    var cells = {}, notes = [];
    if (status !== undefined && status !== l.status) { cells["Status"] = status; notes.push("Status: " + l.status + " -> " + status); }
    if (nfu !== undefined && nfu !== l.nextFollowUp) {
      cells["Next Follow-up"] = nfu; cells["Reminded Level"] = dropOverdueTokens_(l.remindedLevel);
      notes.push("Next follow-up: " + (nfu || "cleared"));
    }
    if (lc !== undefined && lc !== l.lastContact) { cells["Last Contact"] = lc; notes.push("Last contact: " + (lc || "cleared")); }
    if (notes.length) { setLeadCells_(tbl, l._row, cells); logActivity_(l.id, coach.name, "updated", notes.join("; ")); }
    return { ok: true, lead: publicLead_(leadAt_(tbl, l._row), nowMs_()) };
  });
}

function actionNote_(p, coach) {
  var text = String(p.text == null ? "" : p.text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim().slice(0, 1000);
  if (!text) return err_("invalid");
  if (!findLead_(table_("Leads", LEADS_HEADER, true), p.id)) return err_("not_found");
  logActivity_(String(p.id).trim(), coach.name, "note", text);
  return { ok: true };
}

function actionRelease_(p, coach) {
  var res = withLock_(function () {
    var tbl = table_("Leads", LEADS_HEADER, true), l = findLead_(tbl, p.id);
    if (!l) return err_("not_found");
    if (l.owner !== coach.name) return err_("not_owner");
    // Reminded Level u1,u2: the group is told right now (below), so the reminder job does not repeat it
    setLeadCells_(tbl, l._row, { "Owner": "", "Claimed At": "", "Reminded Level": "u1,u2" });
    logActivity_(l.id, coach.name, "released", "Gave the lead back to the pool");
    return { ok: true, lead: publicLead_(leadAt_(tbl, l._row), nowMs_()), _tg: l };
  });
  if (res.ok) {
    var l = res._tg; delete res._tg;
    sendTelegram_(escHtml_(coach.name) + " released a lead - who can take it?\n" + leadSummary_(l) + (leadLink_(prop_("SITE_URL"), l.id) ? "\n" + leadLink_(prop_("SITE_URL"), l.id) : ""));
  }
  return res;
}

var COACH_ACTIONS = { login: actionLogin_, leads: actionLeads_, lead: actionLead_, claim: actionClaim_, update: actionUpdate_, note: actionNote_, release: actionRelease_, addManual: actionAddManual_ };

/** Route one request. Returns a plain object (never throws). */
function handle_(p) {
  try {
    var action = String(p.action || "");
    if (!action) return { ok: true, service: "coaching-crm" };
    if (action === "addLead") return actionAddLead_(p);
    if (COACH_ACTIONS.hasOwnProperty(action)) {
      var coach = authCoach_(p.code);
      if (!coach) return err_("unauthorized");
      return COACH_ACTIONS[action](p, coach);
    }
    return err_("unknown_action");
  } catch (e) {
    if (String(e && e.message) === "busy") return err_("busy");
    Logger.log("handle_ error: " + (e && e.stack || e));
    return err_("server_error");
  }
}
function doGet(e) { return out_(handle_((e && e.parameter) || {})); }
function doPost(e) {
  var p = {};
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) return out_(err_("invalid"));
    Object.keys((e && e.parameter) || {}).forEach(function (k) { p[k] = e.parameter[k]; });
    Object.keys(body).forEach(function (k) { p[k] = body[k]; });
  } catch (x) { return out_(err_("invalid")); }
  return out_(handle_(p));
}

// ===================================================================== 6. Reminders, setup, authorization
/** Runs every 15 minutes (trigger installed by setup()). */
function checkReminders() {
  var plan, leadsById = {}, handles = handleMap_(), site = prop_("SITE_URL");
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var tbl = table_("Leads", LEADS_HEADER, true), leads = allLeads_(tbl);
    leads.forEach(function (l) { leadsById[l.id] = l; });
    plan = reminderPlan_(leads, nowMs_());
    plan.forEach(function (item) {
      var l = leadsById[item.id];
      var ok = sendTelegram_(reminderMessage_(item, l, site, handles.byName, handles.all));
      if (ok) {
        setLeadCells_(tbl, l._row, { "Reminded Level": addTokens_(l.remindedLevel, item.addTokens) });
        l.remindedLevel = addTokens_(l.remindedLevel, item.addTokens);
      }
    });
  } finally { lock.releaseLock(); }
  return plan;
}

/** Run once from the editor: makes the tabs, the 15-minute trigger and the first three coaches (Gabriel, Leroi, Carey). Safe to run again. */
function setup() {
  var lt = table_("Leads", LEADS_HEADER, true); formatText_(lt.sh, lt.headers.length);
  var at = table_("Activity", ACTIVITY_HEADER, true); formatText_(at.sh, at.headers.length);
  var ct = coachesTable_();
  if (ct.values.length < 2) {
    ["Gabriel", "Leroi", "Carey"].forEach(function (name) {
      var code = Utilities.getUuid().replace(/-/g, "").slice(0, 10);
      ct.sh.appendRow(COACHES_HEADER.map(function (h) { return { "Name": name, "Telegram": "", "Code": code, "Active": "Yes" }[h]; }));
      Logger.log("Coach " + name + " added. Access code: " + code);
    });
    Logger.log("Give each coach their own code (also on the Coaches tab). Add the Telegram handle there if you like.");
  }
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "checkReminders"; });
  if (!has) { ScriptApp.newTrigger("checkReminders").timeBased().everyMinutes(15).create(); Logger.log("Installed the 15-minute reminder trigger."); }
  else Logger.log("The 15-minute reminder trigger was already there.");
  ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SITE_URL"].forEach(function (k) { if (!prop_(k)) Logger.log("Script property still empty: " + k); });
  Logger.log("setup() finished.");
}

/** Run once from the editor to approve every permission the script needs (Sheets, external requests, triggers). */
function authorizeAll() {
  spreadsheet_().getName();
  ScriptApp.getProjectTriggers();
  LockService.getScriptLock();
  CacheService.getScriptCache().put("auth-check", "1", 5);
  var r = UrlFetchApp.fetch("https://api.telegram.org/", { muteHttpExceptions: true });
  Logger.log("Permissions OK (Telegram site answered HTTP " + r.getResponseCode() + ").");
}

/** Optional: run from the editor to send yourself a test Telegram message. */
function testTelegram() {
  Logger.log(sendTelegram_("Test message from the coaching CRM.") ? "Sent. Check Telegram." : "NOT sent. See View > Logs and check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.");
}
