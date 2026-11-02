/* Coach dashboard. Needs globals CONFIG and API (see CONTRACT.md). */
(function () {
  'use strict';
  var STATUSES = ['New', 'Contacted', 'Trial booked', 'Paying', 'Not proceeding'];
  var GOALS = ['5K', '10K', 'Half marathon', 'Marathon', 'General fitness', 'Other'];
  var FLAG_RANK = { unclaimed_120: 0, unclaimed_30: 1, overdue_followup: 2, no_contact: 3 };
  var FLAG_TEXT = {
    unclaimed_120: 'Unclaimed 2h+', unclaimed_30: 'Unclaimed 30m+',
    overdue_followup: 'Follow-up overdue', no_contact: 'No contact yet'
  };
  var KEY = 'crm_code';

  var $ = function (id) { return document.getElementById(id); };
  var state = { code: '', coach: '', leads: [], tab: 'unclaimed', q: '', openId: '', detail: null, activity: [], loaded: false, error: '', busy: false, manual: false };
  var lastFocus = null, toastTimer = null, refreshing = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function toast(msg) {
    var t = $('crm-toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 4000);
  }
  function call(method, action, data) {
    var d = Object.assign({ code: state.code }, data || {});
    return (method === 'post' ? API.post(action, d) : API.get(action, d));
  }
  function ago(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return '';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24); return d + ' d ago';
  }
  function when(iso) {
    var d = new Date(iso); if (isNaN(d)) return iso || '';
    return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function waLink(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    if (d.length === 8) d = '65' + d;
    return d ? 'https://wa.me/' + d : '';
  }
  function errText(r) {
    var e = r && r.error;
    return ({ unauthorized: 'That code was not recognised.', not_owner: 'Only the lead\'s owner can change this.',
      invalid: 'Please check the details and try again.', not_found: 'Lead not found.' })[e] || (e ? 'Something went wrong (' + e + ').' : 'Could not reach the server. Check your connection.');
  }

  /* ---------- sign in ---------- */
  function showLogin(msg) {
    $('crm-app').hidden = true; $('crm-login').hidden = false;
    var er = $('crm-login-error'); er.hidden = !msg; er.textContent = msg || '';
    $('crm-code').focus();
  }
  function signIn(code, remember) {
    var btn = $('crm-login-btn'); btn.disabled = true;
    state.code = code;
    return call('get', 'login').then(function (r) {
      btn.disabled = false;
      if (!r || !r.ok) { state.code = ''; if (remember) store(KEY, null); showLogin(r && r.error === 'unauthorized' ? 'That code was not recognised.' : errText(r)); return; }
      state.coach = r.coach.name; store(KEY, code);
      $('crm-login').hidden = true; $('crm-app').hidden = false;
      $('crm-coach').textContent = state.coach;
      refresh(true).then(applyHash);
    }).catch(function () { btn.disabled = false; state.code = ''; showLogin('Could not reach the server. Check your connection.'); });
  }
  function signOut() {
    store(KEY, null); state = Object.assign(state, { code: '', coach: '', leads: [], loaded: false, openId: '', detail: null });
    closeDetail(true); $('crm-code').value = ''; showLogin('');
  }

  /* ---------- list ---------- */
  function isMine(l) { return l.owner && l.owner === state.coach; }
  function visible() {
    var q = state.q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
    return state.leads.filter(function (l) {
      if (state.tab === 'unclaimed' && l.owner) return false;
      if (state.tab === 'mine' && !isMine(l)) return false;
      if (!q) return true;
      var hay = [l.name, l.email, l.area, l.goal, l.owner, l.phone].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0 || (qd.length > 2 && String(l.phone).replace(/\D/g, '').indexOf(qd) >= 0);
    }).sort(function (a, b) {
      var ra = a.flag in FLAG_RANK ? FLAG_RANK[a.flag] : 99, rb = b.flag in FLAG_RANK ? FLAG_RANK[b.flag] : 99;
      if (ra !== rb) return ra - rb;
      return Date.parse(b.created) - Date.parse(a.created) || 0;
    });
  }
  function stClass(s) { return 'st-' + (s === 'Not proceeding' ? 'Not' : s === 'Paying' ? 'Paying' : s === 'New' ? 'New' : 'x'); }
  function renderCounts() {
    var un = state.leads.filter(function (l) { return !l.owner && l.status === 'New'; }).length;
    var ov = state.leads.filter(function (l) { return l.flag === 'overdue_followup'; }).length;
    $('crm-n-unclaimed').textContent = un; $('crm-n-overdue').textContent = ov;
    $('crm-n-overdue').parentNode.classList.toggle('has', ov > 0);
  }
  function renderList() {
    renderCounts();
    var ul = $('crm-list'), st = $('crm-status');
    if (state.error && !state.loaded) { st.innerHTML = ''; ul.innerHTML = '<li class="crm-card crm-empty"><p>' + esc(state.error) + '</p><button type="button" class="crm-btn crm-primary" id="crm-retry">Try again</button></li>'; return; }
    if (!state.loaded) { st.textContent = 'Loading leads…'; ul.innerHTML = ''; return; }
    st.textContent = state.error ? state.error + ' Showing the last data we have.' : '';
    var items = visible();
    if (!items.length) {
      var msg = state.q ? 'No leads match your search.' : state.tab === 'unclaimed' ? 'No unclaimed leads. Nice work!' : state.tab === 'mine' ? 'You have not claimed any leads yet.' : 'No leads yet.';
      ul.innerHTML = '<li class="crm-card crm-empty">' + esc(msg) + '</li>'; return;
    }
    ul.innerHTML = items.map(function (l) {
      var warn = l.flag === 'unclaimed_30' || l.flag === 'no_contact' ? ' warn' : '';
      return '<li><button type="button" class="crm-lead f-' + esc(l.flag || 'none') + (l.id === state.openId ? ' sel' : '') + '" data-id="' + esc(l.id) + '">' +
        '<span class="crm-lead-top"><span class="crm-lead-name">' + esc(l.name) + '</span><span class="crm-lead-time">' + esc(ago(l.created)) + '</span></span>' +
        '<span class="crm-lead-meta">' + esc([l.goal, l.level, l.area].filter(Boolean).join(' · ')) + '</span>' +
        '<span class="crm-chips"><span class="crm-chip ' + stClass(l.status) + '">' + esc(l.status) + '</span>' +
        (l.flag ? '<span class="crm-chip flag' + warn + '">' + esc(FLAG_TEXT[l.flag] || l.flag) + '</span>' : '') +
        '<span class="crm-chip">' + (l.owner ? 'Owner: ' + esc(l.owner) : 'Unclaimed') + '</span></span></button></li>';
    }).join('');
  }

  function refresh(first) {
    if (refreshing) return Promise.resolve(); refreshing = true;
    return call('get', 'leads').then(function (r) {
      refreshing = false;
      if (r && r.error === 'unauthorized') { signOut(); showLogin('Your code is no longer valid. Please sign in again.'); return; }
      if (!r || !r.ok) { state.error = errText(r); renderList(); return; }
      state.error = ''; state.loaded = true; state.leads = r.leads || [];
      renderList();
      if (state.openId && !first) loadDetail(state.openId, true);
    }).catch(function () { refreshing = false; state.error = 'Could not reach the server.'; renderList(); });
  }

  /* ---------- detail ---------- */
  function findLead(id) { for (var i = 0; i < state.leads.length; i++) if (state.leads[i].id === id) return state.leads[i]; return null; }
  function openLead(id, opener) {
    if (opener) lastFocus = opener;
    state.openId = id; state.detail = findLead(id); state.activity = [];
    if (location.hash !== '#lead=' + id) history.replaceState(null, '', '#lead=' + encodeURIComponent(id));
    buildDetail(); loadDetail(id, false); renderList();
    var d = $('crm-detail'); d.hidden = false; d.scrollTop = 0; document.querySelector('.crm-layout').classList.remove('no-detail');
    $('crm-detail-title').focus();
  }
  function closeDetail(quiet) {
    state.openId = ''; state.detail = null; state.manual = false;
    var d = $('crm-detail'); d.hidden = true; d.innerHTML = '';
    document.querySelector('.crm-layout').classList.add('no-detail');
    if (!quiet) { history.replaceState(null, '', location.pathname + location.search); renderList(); if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus(); }
  }
  function loadDetail(id, silent) {
    return call('get', 'lead', { id: id }).then(function (r) {
      if (state.openId !== id) return;
      if (!r || !r.ok) { if (!silent) $('crm-d-msg').textContent = r && r.error === 'not_found' ? 'This lead could not be found.' : errText(r); return; }
      state.detail = r.lead; state.activity = r.activity || [];
      var i = state.leads.map(function (l) { return l.id; }).indexOf(id);
      if (i >= 0) state.leads[i] = Object.assign({}, state.leads[i], r.lead); else state.leads.push(r.lead);
      fillDetail(); renderList();
    }).catch(function () { if (!silent && state.openId === id) $('crm-d-msg').textContent = 'Could not reach the server.'; });
  }

  function buildDetail() {
    var d = $('crm-detail');
    d.innerHTML =
      '<div class="crm-detail-head"><h2 id="crm-detail-title" tabindex="-1">Loading…</h2>' +
      '<button type="button" class="crm-btn" id="crm-close" aria-label="Close lead">Close</button></div>' +
      '<p id="crm-d-msg" class="crm-error" role="alert"></p>' +
      '<div id="crm-d-actions" class="crm-actions"></div>' +
      '<dl id="crm-d-fields" class="crm-fields"></dl>' +
      '<div class="crm-section crm-row2">' +
        '<div><label for="crm-d-status">Status</label><select id="crm-d-status">' +
        STATUSES.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select></div>' +
        '<div><label for="crm-d-follow">Next follow-up</label><input id="crm-d-follow" type="date"></div>' +
      '</div>' +
      '<p id="crm-d-hint" class="crm-muted crm-modal-note"></p>' +
      '<div class="crm-section"><h3>Notes and activity</h3>' +
        '<label for="crm-d-note">Add a note</label><textarea id="crm-d-note" rows="3"></textarea>' +
        '<button type="button" class="crm-btn crm-primary" id="crm-d-addnote" style="margin-top:.5rem">Add note</button>' +
        '<ul id="crm-d-notes" class="crm-notes" aria-live="polite"></ul></div>';
  }
  function field(label, val) { return '<div><dt>' + esc(label) + '</dt><dd>' + (val ? val : '<span class="crm-muted">-</span>') + '</dd></div>'; }
  function fillDetail() {
    var l = state.detail; if (!l || state.manual) return;
    $('crm-detail-title').textContent = l.name || 'Lead';
    var mine = isMine(l), wa = waLink(l.phone), act = '';
    if (!l.owner) act += '<button type="button" class="crm-btn crm-primary crm-big" id="crm-d-claim">Claim this lead</button>';
    else if (mine) act += '<div class="crm-owner-note">This lead is yours.</div>';
    else act += '<div class="crm-owner-note">Claimed by <b>' + esc(l.owner) + '</b>. Only they can change status or follow-up.</div>';
    if (wa) act += '<a class="crm-btn crm-wa" target="_blank" rel="noopener" href="' + esc(wa) + '">WhatsApp ' + esc(l.name) + '</a>';
    if (mine) act += '<button type="button" class="crm-btn crm-danger" id="crm-d-release">Release back to pool</button>';
    var a = $('crm-d-actions');
    // keep focus if the claim button is being re-rendered with identical content
    if (a.getAttribute('data-sig') !== act) { a.innerHTML = act; a.setAttribute('data-sig', act); }
    $('crm-d-fields').innerHTML =
      field('Phone', l.phone ? '<a href="tel:' + esc(String(l.phone).replace(/[^\d+]/g, '')) + '">' + esc(l.phone) + '</a>' : '') +
      field('Email', l.email ? '<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a>' : '') +
      field('Age', esc(l.age)) + field('Goal', esc(l.goal)) + field('Level', esc(l.level)) + field('Area', esc(l.area)) +
      field('Preferred times', esc(l.times)) + field('Source', esc(l.source)) + field('Created', esc(when(l.created))) +
      field('Claimed', l.claimedAt ? esc(when(l.claimedAt)) : '') + field('Last contact', l.lastContact ? esc(when(l.lastContact)) : '') +
      field('Flag', l.flag ? esc(FLAG_TEXT[l.flag] || l.flag) : '');
    var sel = $('crm-d-status'), fu = $('crm-d-follow');
    if (document.activeElement !== sel) sel.value = l.status;
    if (document.activeElement !== fu) fu.value = l.nextFollowUp ? String(l.nextFollowUp).slice(0, 10) : '';
    sel.disabled = fu.disabled = !mine;
    $('crm-d-hint').textContent = mine ? '' : (l.owner ? 'Only ' + l.owner + ' can change these.' : 'Claim the lead to change status or follow-up.');
    var notes = (state.activity || []).slice().sort(function (x, y) { return Date.parse(y.time) - Date.parse(x.time); });
    $('crm-d-notes').innerHTML = notes.length ? notes.map(function (n) {
      return '<li><small>' + esc(when(n.time)) + ' · ' + esc(n.coach || 'System') + (n.action ? ' · ' + esc(n.action) : '') + '</small>' + esc(n.text) + '</li>';
    }).join('') : '<li class="crm-muted">No activity yet.</li>';
  }

  function claim(btn) {
    btn.disabled = true; var id = state.openId;
    call('post', 'claim', { id: id }).then(function (r) {
      if (r && r.ok) { toast('Claimed. Message them soon!'); state.detail = r.lead; return refresh(true).then(function () { return loadDetail(id, true); }); }
      if (r && r.error === 'already_claimed') { toast('Too late: ' + (r.owner || 'another coach') + ' has just claimed this lead.'); return refresh(true).then(function () { return loadDetail(id, true); }); }
      btn.disabled = false; toast(errText(r));
    }).catch(function () { btn.disabled = false; toast('Could not reach the server.'); });
  }
  function save(data, okMsg) {
    var id = state.openId;
    return call('post', 'update', Object.assign({ id: id }, data)).then(function (r) {
      if (r && r.ok) { toast(okMsg); state.detail = r.lead; var i = state.leads.map(function (l) { return l.id; }).indexOf(id); if (i >= 0) state.leads[i] = r.lead; fillDetail(); renderList(); return; }
      toast(errText(r)); return loadDetail(id, true);
    }).catch(function () { toast('Could not reach the server.'); });
  }
  function addNote() {
    var ta = $('crm-d-note'), text = ta.value.trim(), id = state.openId;
    if (!text) { toast('Type a note first.'); ta.focus(); return; }
    var b = $('crm-d-addnote'); b.disabled = true;
    call('post', 'note', { id: id, text: text }).then(function (r) {
      b.disabled = false;
      if (r && r.ok) { ta.value = ''; toast('Note added.'); loadDetail(id, true); } else toast(errText(r));
    }).catch(function () { b.disabled = false; toast('Could not reach the server.'); });
  }
  function release() {
    if (!window.confirm('Give this lead back to the unclaimed pool?')) return;
    var id = state.openId;
    call('post', 'release', { id: id }).then(function (r) {
      if (r && r.ok) { toast('Released.'); refresh(true).then(function () { loadDetail(id, true); }); } else toast(errText(r));
    }).catch(function () { toast('Could not reach the server.'); });
  }

  /* ---------- manual add ---------- */
  function showManual() {
    state.manual = true; state.openId = ''; state.detail = null;
    var d = $('crm-detail'); d.hidden = false; document.querySelector('.crm-layout').classList.remove('no-detail');
    function f(id, label, type, extra) { return '<label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + (type || 'text') + '" ' + (extra || '') + '>'; }
    d.innerHTML =
      '<div class="crm-detail-head"><h2 id="crm-detail-title" tabindex="-1">Add lead manually</h2><button type="button" class="crm-btn" id="crm-close">Cancel</button></div>' +
      '<form id="crm-manual" novalidate>' +
      f('m-name', 'Name (required)', 'text', 'required autocomplete="off"') + f('m-phone', 'Phone (required)', 'tel', 'required autocomplete="off" inputmode="tel"') +
      f('m-email', 'Email', 'email', 'autocomplete="off"') + f('m-age', 'Age', 'number', 'min="1" max="120" inputmode="numeric"') +
      '<label for="m-goal">Goal</label><select id="m-goal">' + GOALS.map(function (g) { return '<option>' + esc(g) + '</option>'; }).join('') + '</select>' +
      f('m-level', 'Level (e.g. Beginner)', 'text', 'list="m-levels"') + '<datalist id="m-levels"><option>Beginner</option><option>Improver</option><option>Experienced</option></datalist>' +
      f('m-area', 'Area') + f('m-times', 'Preferred times') +
      '<p id="crm-d-msg" class="crm-error" role="alert"></p>' +
      '<button type="submit" class="crm-btn crm-primary crm-big" id="m-save" style="margin-top:1rem">Save lead</button></form>';
    $('crm-detail-title').focus();
  }
  function submitManual(e) {
    e.preventDefault();
    var v = function (id) { return $(id).value.trim(); }, msg = $('crm-d-msg');
    if (!v('m-name') || !v('m-phone')) { msg.textContent = 'Name and phone are required.'; (v('m-name') ? $('m-phone') : $('m-name')).focus(); return; }
    msg.textContent = ''; var b = $('m-save'); b.disabled = true;
    call('post', 'addManual', { name: v('m-name'), phone: v('m-phone'), email: v('m-email'), age: v('m-age'), goal: $('m-goal').value, level: v('m-level'), area: v('m-area'), times: v('m-times'), source: 'manual' })
      .then(function (r) {
        b.disabled = false;
        if (!r || !r.ok) { msg.textContent = errText(r); return; }
        toast(r.duplicate ? 'That phone number already exists; a note was added.' : 'Lead added.');
        state.manual = false; state.tab = 'all'; syncTabs();
        refresh(true).then(function () { openLead(r.id); });
      }).catch(function () { b.disabled = false; msg.textContent = 'Could not reach the server.'; });
  }

  /* ---------- wiring ---------- */
  function syncTabs() {
    [].forEach.call(document.querySelectorAll('.crm-tabs button'), function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)); });
  }
  function applyHash() {
    var m = /#lead=([^&]+)/.exec(location.hash);
    if (m && state.code) { var id = decodeURIComponent(m[1]); if (id !== state.openId) openLead(id); }
    else if (!m && state.openId) closeDetail(true);
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button,a'); if (!t) return;
    if (t.classList.contains('crm-lead')) return openLead(t.dataset.id, t);
    switch (t.id) {
      case 'crm-close': return closeDetail();
      case 'crm-d-claim': return claim(t);
      case 'crm-d-release': return release();
      case 'crm-d-addnote': return addNote();
      case 'crm-signout': return signOut();
      case 'crm-add': lastFocus = t; return showManual();
      case 'crm-retry': state.error = ''; renderList(); return refresh(true);
    }
    if (t.dataset && t.dataset.tab) { state.tab = t.dataset.tab; syncTabs(); renderList(); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'crm-d-status') save({ status: e.target.value }, 'Status updated.');
    if (e.target.id === 'crm-d-follow') save({ nextFollowUp: e.target.value }, e.target.value ? 'Follow-up saved.' : 'Follow-up cleared.');
  });
  document.addEventListener('input', function (e) { if (e.target.id === 'crm-search') { state.q = e.target.value; renderList(); } });
  document.addEventListener('submit', function (e) { if (e.target.id === 'crm-manual') submitManual(e); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('crm-detail').hidden && !$('crm-app').hidden) closeDetail(); });
  window.addEventListener('hashchange', applyHash);
  $('crm-login-form').addEventListener('submit', function (e) {
    e.preventDefault(); var c = $('crm-code').value.trim();
    if (!c) { showLogin('Please enter your code.'); return; }
    signIn(c, true);
  });
  setInterval(function () { if (state.code && !document.hidden) refresh(false); }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state.code) refresh(false); });

  document.querySelector('.crm-layout').classList.add('no-detail');
  if (window.API && API.demo) $('crm-demo').hidden = false;
  var saved = load(KEY);
  if (saved) signIn(saved, true); else showLogin('');
})();
