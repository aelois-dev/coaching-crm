/* API layer. Global `API`.
   API.get(action, params) / API.post(action, body) -> Promise of parsed JSON {ok:true,...} | {ok:false,error}
   When CONFIG.apiUrl is empty, everything runs in DEMO MODE in localStorage (API.demo === true).
   Demo coach codes: demo1 (Gabriel), demo2 (Leroi). */
(function () {
  var CFG = window.CONFIG || {};
  var URL_ = (CFG.apiUrl || "").trim();
  var demo = !URL_;

  function qs(o) {
    return Object.keys(o || {}).filter(function (k) { return o[k] !== undefined && o[k] !== null; })
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&");
  }
  function parse(r) { return r.text().then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, error: "bad_response" }; } }); }
  function netFail() { return { ok: false, error: "network" }; }

  /* ---------- real mode ---------- */
  function realGet(action, params) {
    var p = Object.assign({}, params || {}, { action: action });
    return fetch(URL_ + (URL_.indexOf("?") < 0 ? "?" : "&") + qs(p)).then(parse).catch(netFail);
  }
  function realPost(action, body) {
    var b = Object.assign({}, body || {}, { action: action });
    return fetch(URL_, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(b) })
      .then(parse).catch(netFail);
  }

  /* ---------- demo mode ---------- */
  var KEY = "crm_demo_v1";
  var COACHES = { demo1: "Gabriel", demo2: "Leroi" };
  var STATUSES = ["New", "Contacted", "Trial booked", "Paying", "Not proceeding"];
  var GOALS = ["5K", "10K", "Half marathon", "Marathon", "General fitness", "Other"];
  var MIN = 60000;

  function load() {
    try { var s = JSON.parse(localStorage.getItem(KEY)); if (s && s.leads) return s; } catch (e) {}
    var s2 = seed(); save(s2); return s2;
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function iso(ms) { return new Date(ms).toISOString(); }
  function day(ms) { return new Date(ms).toISOString().slice(0, 10); }

  function seed() {
    var n = Date.now(), H = 60 * MIN, D = 24 * H;
    function L(id, ago, name, phone, email, age, goal, level, area, times, src, status, owner, claimAgo, lastAgo, fu) {
      return { id: id, created: iso(n - ago), name: name, phone: phone, email: email, age: age, goal: goal, level: level,
        area: area, times: times, source: src, status: status, owner: owner,
        claimedAt: owner ? iso(n - claimAgo) : "", lastContact: lastAgo ? iso(n - lastAgo) : "", nextFollowUp: fu || "" };
    }
    var s = { seq: 8, activity: {}, rate: [], leads: [
      L("L1", 40 * MIN, "Priya Nair", "+65 9123 4501", "priya@example.com", "29", "5K", "Complete beginner", "East Coast", "Weekday evenings", "form", "New", "", 0, 0, ""),
      L("L2", 3 * H, "Daniel Tan", "+65 9234 5602", "", "41", "Half marathon", "Can run 5 km", "Bishan", "Weekend mornings", "form", "New", "", 0, 0, ""),
      L("L3", 5 * H, "Mei Ling Chua", "+65 9345 6703", "mei@example.com", "35", "10K", "Can run 1-3 km", "Tampines", "Tue/Thu 7pm", "form", "New", "Gabriel", 3 * H, 0, ""),
      L("L4", 2 * D, "Raj Kumar", "+65 9456 7804", "", "52", "General fitness", "Complete beginner", "Jurong", "Saturday mornings", "manual", "Contacted", "Gabriel", 2 * D, 20 * H, day(n - D)),
      L("L5", 4 * D, "Sarah Lim", "+65 9567 8905", "sarah@example.com", "24", "Marathon", "Can run 10 km+", "Marina Bay", "Weekday mornings", "form", "Trial booked", "Leroi", 4 * D, 2 * D, day(n + 2 * D)),
      L("L6", 9 * D, "Kevin Ong", "+65 9678 9006", "", "33", "10K", "Can run 5 km", "Punggol", "Sunday mornings", "form", "Paying", "Leroi", 9 * D, 3 * D, ""),
      L("L7", 12 * D, "Aisha Rahman", "+65 9789 0107", "aisha@example.com", "27", "5K", "Complete beginner", "Woodlands", "Weekday evenings", "form", "Not proceeding", "Gabriel", 12 * D, 10 * D, "")
    ] };
    s.activity.L3 = [{ time: iso(n - 3 * H), coach: "Gabriel", action: "claim", text: "Claimed" }];
    s.activity.L4 = [{ time: iso(n - 2 * D), coach: "Gabriel", action: "claim", text: "Claimed" },
      { time: iso(n - 20 * H), coach: "Gabriel", action: "note", text: "Spoke on WhatsApp, wants to start slowly." }];
    return s;
  }

  function computeFlag(l, now) {
    if (l.status === "Paying" || l.status === "Not proceeding") return "";
    var created = Date.parse(l.created);
    if (l.status === "New" && !l.owner) {
      var age = (now - created) / MIN;
      if (age >= 120) return "unclaimed_120";
      if (age >= 30) return "unclaimed_30";
    }
    if (l.nextFollowUp && l.nextFollowUp < day(now)) return "overdue_followup";
    if (l.owner && l.status === "New" && !l.lastContact && l.claimedAt && (now - Date.parse(l.claimedAt)) / MIN >= 60) return "no_contact";
    return "";
  }
  function view(l) { var o = Object.assign({}, l); o.flag = computeFlag(l, Date.now()); return o; }
  function digits8(p) { return String(p || "").replace(/\D/g, "").slice(-8); }
  function log(s, id, coach, action, text) {
    (s.activity[id] = s.activity[id] || []).push({ time: iso(Date.now()), coach: coach, action: action, text: text || "" });
  }
  function find(s, id) { for (var i = 0; i < s.leads.length; i++) if (s.leads[i].id === id) return s.leads[i]; return null; }
  function str(v) { return v === undefined || v === null ? "" : String(v).trim(); }

  function validLead(b) {
    var name = str(b.name), ph = str(b.phone).replace(/\D/g, "");
    if (!name || name.length > 100) return false;
    if (ph.length < 8 || ph.length > 15) return false;
    if (GOALS.indexOf(str(b.goal)) < 0) return false;
    if (str(b.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(b.email))) return false;
    if (str(b.age) && !(+b.age >= 5 && +b.age <= 100)) return false;
    return true;
  }
  function addRow(s, b, source) {
    var dup = null, d8 = digits8(b.phone);
    s.leads.forEach(function (l) { if (!dup && digits8(l.phone) === d8 && l.status !== "Not proceeding" && l.status !== "Paying") dup = l; });
    if (dup) { log(s, dup.id, "System", "duplicate", "Enquiry received again (" + source + ")."); save(s); return { ok: true, id: dup.id, duplicate: true }; }
    var id = "L" + (++s.seq);
    s.leads.push({ id: id, created: iso(Date.now()), name: str(b.name), phone: str(b.phone), email: str(b.email), age: str(b.age),
      goal: str(b.goal), level: str(b.level), area: str(b.area), times: str(b.times), source: source, status: "New",
      owner: "", claimedAt: "", lastContact: "", nextFollowUp: "" });
    log(s, id, "System", "created", "New enquiry (" + source + ").");
    save(s); return { ok: true, id: id };
  }

  var PUBLIC = { addLead: 1 };
  function handle(action, b) {
    b = b || {};
    var s = load();
    if (action === "addLead") {
      if (str(b.website)) return { ok: false, error: "spam" };
      if (b.consent !== true) return { ok: false, error: "consent_required" };
      if (!validLead(b)) return { ok: false, error: "invalid" };
      var now = Date.now();
      s.rate = (s.rate || []).filter(function (t) { return now - t < 10 * MIN; });
      if (s.rate.length >= 5) return { ok: false, error: "rate_limited" };
      s.rate.push(now);
      return addRow(s, b, "form");
    }
    var coach = COACHES[str(b.code)];
    if (!coach) return { ok: false, error: "unauthorized" };
    var l;
    switch (action) {
      case "login": return { ok: true, coach: { name: coach } };
      case "leads": return { ok: true, coach: { name: coach }, leads: s.leads.map(view), now: iso(Date.now()) };
      case "lead":
        l = find(s, b.id); if (!l) return { ok: false, error: "not_found" };
        return { ok: true, lead: view(l), activity: (s.activity[l.id] || []).slice().reverse() };
      case "claim":
        l = find(s, b.id); if (!l) return { ok: false, error: "not_found" };
        if (l.owner && l.owner !== coach) return { ok: false, error: "already_claimed", owner: l.owner };
        if (!l.owner) { l.owner = coach; l.claimedAt = iso(Date.now()); log(s, l.id, coach, "claim", "Claimed"); save(s); }
        return { ok: true, lead: view(l) };
      case "update":
        l = find(s, b.id); if (!l) return { ok: false, error: "not_found" };
        if (l.owner !== coach) return { ok: false, error: "not_owner" };
        if (b.status !== undefined) {
          if (STATUSES.indexOf(b.status) < 0) return { ok: false, error: "invalid" };
          if (l.status !== b.status) log(s, l.id, coach, "status", l.status + " -> " + b.status);
          l.status = b.status;
        }
        if (b.nextFollowUp !== undefined) {
          if (b.nextFollowUp !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(b.nextFollowUp)) return { ok: false, error: "invalid" };
          l.nextFollowUp = b.nextFollowUp; log(s, l.id, coach, "followup", b.nextFollowUp ? "Next follow-up " + b.nextFollowUp : "Follow-up cleared");
        }
        if (b.lastContact !== undefined) {
          if (b.lastContact !== "" && isNaN(Date.parse(b.lastContact))) return { ok: false, error: "invalid" };
          l.lastContact = b.lastContact; log(s, l.id, coach, "contact", "Marked contacted");
        }
        save(s); return { ok: true, lead: view(l) };
      case "note":
        l = find(s, b.id); if (!l) return { ok: false, error: "not_found" };
        if (!str(b.text)) return { ok: false, error: "invalid" };
        log(s, l.id, coach, "note", str(b.text)); save(s); return { ok: true };
      case "release":
        l = find(s, b.id); if (!l) return { ok: false, error: "not_found" };
        if (l.owner !== coach) return { ok: false, error: "not_owner" };
        l.owner = ""; l.claimedAt = ""; log(s, l.id, coach, "release", "Released to pool"); save(s);
        return { ok: true, lead: view(l) };
      case "addManual":
        if (!validLead(b)) return { ok: false, error: "invalid" };
        return addRow(s, b, "manual");
    }
    return { ok: false, error: "unknown_action" };
  }

  function demoCall(action, data) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var r; try { r = handle(action, JSON.parse(JSON.stringify(data || {}))); } catch (e) { r = { ok: false, error: "server_error" }; }
        resolve(r);
      }, 250);
    });
  }

  window.API = {
    demo: demo,
    get: function (action, params) { return demo ? demoCall(action, params) : realGet(action, params); },
    post: function (action, body) { return demo ? demoCall(action, body) : realPost(action, body); },
    // demo helper only: wipe demo data back to the sample leads
    resetDemo: function () { try { localStorage.removeItem(KEY); } catch (e) {} }
  };
})();
