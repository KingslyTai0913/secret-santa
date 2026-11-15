/* app.js — UI for 家庭交换礼物抽签 / Family Secret Santa. Needs santa-core.js loaded first. */
(function () {
  'use strict';
  const S = window.SantaCore;
  const STORE_KEY = 'familySecretSanta.v1';
  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ================= helpers ================= */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  /** Bilingual snippet. Arguments are trusted HTML — always esc() user values first. */
  const bi = (zh, en) => `<span class="zh">${zh}</span><span class="en">${en}</span>`;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function famHtml(names, i) {
    const n = String(names[i] || '').trim();
    return n ? esc(n) : bi(`家庭 ${i + 1}`, `Family ${i + 1}`);
  }
  function famText(names, i) {
    const n = String(names[i] || '').trim();
    return n || `家庭${i + 1} Family ${i + 1}`;
  }
  /** Separate zh / en labels for use inside bi() — unnamed families become 家庭 N / Family N. */
  const famZh = (names, i) => esc(String(names[i] || '').trim() || `家庭 ${i + 1}`);
  const famEn = (names, i) => esc(String(names[i] || '').trim() || `Family ${i + 1}`);
  const famClass = (i) => `fam-${i % 8}`;

  /* ================= state ================= */
  function defaultState() {
    return {
      event: { name: '', budget: '', date: '', note: '' },
      families: Array.from({ length: 5 }, () => ({ name: '', members: [] })),
      rules: { noReciprocal: false, singleLoop: false, exclusions: [] }, // only "not your own family" by default
      pinHash: '',
      pinSalt: '',
      demo: false, // true while the untouched sample list is loaded
      draw: null, // { id, at, event, familyNames, people, assignment, rules, method }
      viewed: {}, // { [drawId]: [personIndex, ...] } — results opened on this device
      mine: {}, // { [drawId]: [personIndex, ...] } — names chosen on this device
      pending: {} // { [drawId]: [personIndex, ...] } — choices that could not reach the server yet
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const s = Object.assign(defaultState(), JSON.parse(raw));
      if (!Array.isArray(s.families)) s.families = defaultState().families;
      s.families = s.families.map((f) => ({ name: String(f.name || ''), members: Array.isArray(f.members) ? f.members.map(String) : [] }));
      s.rules = Object.assign(defaultState().rules, s.rules || {});
      if (!Array.isArray(s.rules.exclusions)) s.rules.exclusions = [];
      if (!s.viewed || typeof s.viewed !== 'object') s.viewed = {};
      if (!s.mine || typeof s.mine !== 'object') s.mine = {};
      if (!s.pending || typeof s.pending !== 'object') s.pending = {};
      return s;
    } catch (e) {
      return null;
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode etc. */ }
  }

  let state = load() || defaultState();
  let shared = null; // decoded draw from a share link (view-only)
  let adminUnlocked = false;
  let shareCache = { id: null, code: null };

  /* A "view" = the draw being shown, from this device or from a share link */
  function currentView() {
    if (shared) {
      const families = shared.f.map((x) => ({ name: x[0], members: x[1] }));
      return {
        id: shared.id, at: shared.at, isShared: true,
        event: { name: shared.e.n || '', budget: shared.e.b || '', date: shared.e.d || '', note: shared.e.o || '' },
        familyNames: families.map((f) => f.name),
        people: S.flatten(families),
        assignment: shared.a,
        rules: { noReciprocal: !!shared.r.nr, singleLoop: !!shared.r.sl, exclusions: shared.r.x || [] },
        pinHash: shared.ph || '', pinSalt: shared.ps || '', method: shared.m || 'uniform'
      };
    }
    const d = state.draw;
    if (!d) return null;
    return Object.assign({ isShared: false, pinHash: state.pinHash, pinSalt: state.pinSalt }, d);
  }
  function isValidPayload(p) {
    try {
      if (!p || p.v !== 1 || !Array.isArray(p.f) || !Array.isArray(p.a) || !p.e || !p.r) return false;
      if (!p.f.every((x) => Array.isArray(x) && typeof x[0] === 'string' && Array.isArray(x[1]) && x[1].every((m) => typeof m === 'string'))) return false;
      if (p.r.x != null && !(Array.isArray(p.r.x) && p.r.x.every((x) => Array.isArray(x) && x.length === 2))) return false;
      const n = S.flatten(p.f.map((x) => ({ name: x[0], members: x[1] }))).length;
      return n >= 2 && p.a.length === n && p.a.every((r) => Number.isInteger(r) && r >= 0 && r < n);
    } catch (e) { return false; }
  }
  function getViewed(id) { return state.viewed[id] || []; }
  function markViewed(id, pi) {
    const list = getViewed(id);
    if (!list.includes(pi)) { state.viewed[id] = list.concat(pi); save(); }
  }

  /* ================= shared "who has drawn" list (Firebase Firestore, REST) ================= */
  // Stores only draws/<random draw id>/claims/<person number>. Names and results never leave the link.
  const Sync = (function () {
    const cfg = window.SANTA_SYNC || {};
    const enabled = !!(cfg.projectId && cfg.apiKey) && typeof fetch === 'function';
    const base = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/draws/`;
    function call(method, path, body) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl && setTimeout(() => ctrl.abort(), 8000);
      return fetch(base + path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(cfg.apiKey), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl ? ctrl.signal : undefined
      }).finally(() => { if (timer) clearTimeout(timer); });
    }
    async function list(drawId) {
      const r = await call('GET', `${drawId}/claims?pageSize=1000&mask.fieldPaths=at`);
      if (!r.ok) throw new Error('list ' + r.status);
      const data = await r.json();
      return new Set((data.documents || []).map((d) => Number(d.name.split('/').pop())).filter(Number.isInteger));
    }
    /** 'ok' | 'taken' (someone already chose this name) | 'error' (offline etc.) */
    async function claim(drawId, pi) {
      try {
        const r = await call('POST', `${drawId}/claims?documentId=${pi}`, { fields: { at: { integerValue: String(Date.now()) } } });
        if (r.ok) return 'ok';
        return r.status === 409 ? 'taken' : 'error';
      } catch (e) { return 'error'; }
    }
    async function unclaim(drawId, pi) {
      const r = await call('DELETE', `${drawId}/claims/${pi}`);
      if (!r.ok) throw new Error('delete ' + r.status);
    }
    return { enabled, list, claim, unclaim };
  })();

  let claims = { id: null, set: null, error: false }; // last known server list for the draw on screen
  async function refreshClaims(v) {
    if (!Sync.enabled || !v) return;
    try {
      const set = await Sync.list(v.id);
      claims = { id: v.id, set, error: false };
      retryPending(v, set);
    } catch (e) {
      claims = { id: v.id, set: claims.id === v.id ? claims.set : null, error: true };
    }
  }
  /** Choices made while offline are sent again once the server answers. */
  function retryPending(v, set) {
    const waiting = (state.pending[v.id] || []).filter((pi) => !set.has(pi));
    if (waiting.length !== (state.pending[v.id] || []).length) {
      state.pending[v.id] = waiting;
      save();
    }
    waiting.forEach((pi) => Sync.claim(v.id, pi).then((res) => {
      if (res === 'error') return;
      state.pending[v.id] = (state.pending[v.id] || []).filter((x) => x !== pi);
      save();
    }));
  }
  /** Names chosen on this device (without the server, the ones whose result was opened here). */
  function myDraws(v) { return Sync.enabled ? (state.mine[v.id] || []) : getViewed(v.id); }
  function addMine(id, pi) {
    const list = state.mine[id] || [];
    if (!list.includes(pi)) { state.mine[id] = list.concat(pi); save(); }
  }
  let pollTimer = null;
  function setPolling(on) {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!on || !Sync.enabled) return;
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      await refreshClaims(currentView());
      if (!$('screen-results').hidden && $('modal').hidden) renderResults();
    }, 5000);
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !Sync.enabled || $('screen-results').hidden) return;
    await refreshClaims(currentView());
    if (!$('screen-results').hidden && $('modal').hidden) renderResults();
  });

  /* ================= UI primitives ================= */
  let modalResolve = null;
  function openModal(html, onOpen, cls) {
    closeModal(undefined);
    return new Promise((resolve) => {
      $('modal').firstElementChild.className = 'modal' + (cls ? ' ' + cls : '');
      $('modalContent').innerHTML = html;
      $('modal').hidden = false;
      modalResolve = resolve;
      if (onOpen) onOpen($('modalContent'));
      const f = $('modalContent').querySelector('input, [data-result="ok"], .btn');
      if (f) setTimeout(() => f.focus({ preventScroll: true }), 30);
    });
  }
  function closeModal(value) {
    if ($('modal').hidden) return;
    $('modal').hidden = true;
    $('modalContent').innerHTML = '';
    const r = modalResolve;
    modalResolve = null;
    if (r) r(value);
  }
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) return closeModal(false);
    const b = e.target.closest('[data-result]');
    if (b) closeModal(b.dataset.result === 'ok');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(false); });

  function confirmModal(o) {
    return openModal(`
      ${o.emoji ? `<div class="modal-emoji" aria-hidden="true">${o.emoji}</div>` : ''}
      <h2 id="modalTitle">${o.title}</h2>
      ${o.text ? `<p class="modal-text">${o.text}</p>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn ${o.danger ? 'btn-danger' : 'btn-primary'}" data-result="ok">${o.ok || bi('确定', 'OK')}</button>
        ${o.cancel === false ? '' : `<button type="button" class="btn btn-ghost" data-result="cancel">${o.cancel || bi('取消', 'Cancel')}</button>`}
      </div>`);
  }

  let toastTimer = null;
  function toast(html) {
    const t = $('toast');
    t.innerHTML = html;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  async function copyWithFeedback(text) {
    if (await copyText(text)) return toast(bi('已复制', 'Copied') + ' ✓');
    openModal(`<h2 id="modalTitle">${bi('请手动复制', 'Please copy manually')}</h2>
      <textarea readonly rows="6" style="width:100%">${esc(text)}</textarea>
      <div class="modal-actions"><button type="button" class="btn btn-primary" data-result="ok">${bi('好的', 'OK')}</button></div>`,
    (root) => { const ta = root.querySelector('textarea'); ta.focus(); ta.select(); });
  }

  function confetti() {
    if (reducedMotion) return;
    const colors = ['#b8322a', '#1d7a4c', '#c99a36', '#2a62a8', '#ffffff', '#e2b85c'];
    for (let i = 0; i < 36; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 1.8 + Math.random() * 1.6 + 's';
      c.style.animationDelay = Math.random() * 0.4 + 's';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 4200);
    }
  }

  function playDrawAnimation(people) {
    return new Promise((resolve) => {
      $('drawing').hidden = false;
      const total = reducedMotion ? 300 : 1700;
      const start = Date.now();
      const tick = setInterval(() => {
        $('drawName').textContent = people[Math.floor(Math.random() * people.length)].name;
        if (Date.now() - start >= total) {
          clearInterval(tick);
          $('drawing').hidden = true;
          resolve();
        }
      }, 85);
    });
  }

  /* ================= routing ================= */
  const SCREENS = ['setup', 'results', 'tree', 'admin'];
  function showScreen(name) {
    if (name !== 'admin') adminUnlocked = false; // re-lock whenever admin page is left
    SCREENS.forEach((s) => { $('screen-' + s).hidden = s !== name; });
    // the pages family members see get the snowy Christmas-night scene
    document.body.classList.toggle('scene', name === 'results' || name === 'tree');
    setPolling(name === 'results'); // keep the name list fresh while people are choosing
    if (name === 'setup') renderSetup();
    if (name === 'results') renderResults();
    if (name === 'tree') renderTree();
    if (name === 'admin') renderAdmin();
    renderHeader(name);
    window.scrollTo(0, 0);
  }
  function renderHeader(name) {
    const v = name === 'setup' ? null : currentView();
    $('eventLine').textContent = v ? v.event.name : state.event.name;
  }
  function route() {
    const code = S.extractShareCode(location.href);
    shared = null;
    if (code) {
      const p = S.decodeShare(code);
      if (p && isValidPayload(p)) {
        shared = p;
        return showScreen('results');
      }
      clearUrl();
      confirmModal({
        emoji: '😕', cancel: false,
        title: bi('这个链接打不开', "This link doesn't work"),
        text: bi('链接可能复制不完整。请让管理员重新发一次。', 'The link may be incomplete. Ask the organiser to send it again.')
      });
      return showScreen(state.draw ? 'results' : 'setup');
    }
    if (!state.draw) return showScreen('setup');
    // This device created the draw, so it is the organiser's: reopen on the admin page (behind the PIN if set)
    if (!state.pinHash) return showScreen('admin');
    showScreen('results');
    askPin(currentView()).then((ok) => { if (ok) showScreen('admin'); });
  }
  function clearUrl() {
    try { history.replaceState(null, '', location.href.split('#')[0].split('?')[0]); } catch (e) { location.hash = ''; }
  }
  window.addEventListener('hashchange', route);

  /* ================= SETUP ================= */
  function renderSetup() {
    $('evName').value = state.event.name;
    $('evBudget').value = state.event.budget;
    $('evDate').value = state.event.date;
    $('evNote').value = state.event.note;
    $('ruleNoSwap').checked = !!state.rules.noReciprocal;
    $('ruleLoop').checked = !!state.rules.singleLoop;
    $('adminPin').value = '';
    renderFamilies();
    renderPinStatus();
    refreshDerived();
  }

  /** Things that depend on the member list. */
  function refreshDerived() {
    pruneExclusions();
    renderExclusions();
    renderValidation();
  }

  function dupSet() {
    const count = {};
    state.families.forEach((f) => f.members.forEach((m) => { const k = S.normName(m); count[k] = (count[k] || 0) + 1; }));
    return new Set(Object.keys(count).filter((k) => count[k] > 1));
  }

  function renderFamilies(focusFi) {
    const names = state.families.map((f) => f.name);
    const dups = dupSet();
    $('demoNotice').hidden = !state.demo;
    $('clearListBtn').hidden = !state.families.some((f) => f.members.length);
    $('familyList').innerHTML = state.families.map((f, fi) => `
      <div class="family ${famClass(fi)}" data-fi="${fi}">
        <div class="family-head">
          <span class="family-dot" aria-hidden="true"></span>
          <input class="family-name" type="text" maxlength="30" data-act="fname" value="${esc(f.name)}"
            placeholder="家庭 ${fi + 1}（例如 王家）· Family ${fi + 1}" aria-label="家庭名称 Family name">
          <span class="family-count">${f.members.length} 人<span class="en">${f.members.length === 1 ? 'person' : 'people'}</span></span>
          <button type="button" class="icon-btn" data-act="delfam" title="删除这个家庭 Remove family" aria-label="删除 ${esc(famText(names, fi))} Remove family">🗑</button>
        </div>
        <div class="chips">${f.members.map((m, mi) => `<span class="chip${dups.has(S.normName(m)) ? ' dup' : ''}"><span>${esc(m)}</span><button type="button" data-act="delmem" data-mi="${mi}" aria-label="删除 ${esc(m)} Remove">×</button></span>`).join('')}</div>
        <div class="add-row">
          <input type="text" maxlength="300" data-act="addinput" enterkeyhint="done"
            placeholder="输入名字，按回车添加 · Type a name, press Enter" aria-label="添加成员 Add member">
          <button type="button" class="btn btn-small" data-act="addmem">${bi('添加', 'Add')}</button>
        </div>
      </div>`).join('');
    if (focusFi != null) {
      const el = $('familyList').querySelector(`.family[data-fi="${focusFi}"] [data-act="addinput"]`);
      if (el) el.focus();
    }
  }

  function addMembers(fi, input, refocus) {
    const names = S.parseNames(input.value).map((n) => n.slice(0, 30));
    input.value = '';
    if (!names.length) return;
    state.families[fi].members.push(...names);
    state.demo = false;
    save();
    renderFamilies(refocus ? fi : null);
    refreshDerived();
  }

  $('familyList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const fi = Number(btn.closest('.family').dataset.fi);
    const fam = state.families[fi];
    if (btn.dataset.act === 'delmem') {
      fam.members.splice(Number(btn.dataset.mi), 1);
      state.demo = false;
      save(); renderFamilies(); refreshDerived();
    } else if (btn.dataset.act === 'addmem') {
      addMembers(fi, btn.closest('.family').querySelector('[data-act="addinput"]'), true);
    } else if (btn.dataset.act === 'delfam') {
      if (fam.members.length) {
        const names = state.families.map((f) => f.name);
        const ok = await confirmModal({
          emoji: '🗑', danger: true,
          title: bi(`删除「${famZh(names, fi)}」？`, `Remove "${famEn(names, fi)}"?`),
          text: bi(`这个家庭的 ${fam.members.length} 个成员也会一起删除。`, `Its ${fam.members.length} member(s) will be removed too.`),
          ok: bi('删除', 'Remove')
        });
        if (!ok) return;
      }
      state.families.splice(fi, 1);
      state.demo = false;
      save(); renderFamilies(); refreshDerived();
    }
  });
  $('familyList').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return; // isComposing: don't add while typing Chinese with an IME
    if (e.target.dataset.act === 'addinput') {
      e.preventDefault();
      addMembers(Number(e.target.closest('.family').dataset.fi), e.target, true);
    } else if (e.target.dataset.act === 'fname') {
      e.preventDefault();
      e.target.blur();
    }
  });
  $('familyList').addEventListener('change', (e) => {
    if (e.target.dataset.act === 'addinput' && e.target.value.trim()) {
      addMembers(Number(e.target.closest('.family').dataset.fi), e.target, false);
    }
  });
  $('familyList').addEventListener('input', (e) => {
    if (e.target.dataset.act !== 'fname') return;
    state.families[Number(e.target.closest('.family').dataset.fi)].name = e.target.value;
    save();
    renderExclusions();
    renderValidation();
  });

  $('addFamilyBtn').addEventListener('click', () => {
    state.families.push({ name: '', members: [] });
    state.demo = false;
    save();
    renderFamilies();
    const inputs = $('familyList').querySelectorAll('.family-name');
    inputs[inputs.length - 1].focus();
    refreshDerived();
  });

  $('demoBtn').addEventListener('click', async () => {
    const hasData = state.families.some((f) => f.members.length);
    if (hasData) {
      const ok = await confirmModal({
        emoji: '📝',
        title: bi('用示例覆盖现在的名单？', 'Replace your list with the demo?'),
        text: bi('你已经填的名字会被换掉。', "The names you've entered will be replaced."),
        ok: bi('用示例', 'Use demo')
      });
      if (!ok) return;
    }
    fillDemo();
    renderSetup();
    renderHeader('setup');
  });
  function fillDemo() {
    state.families = [
      { name: '王家', members: ['王爸爸', '王妈妈', '王小明'] },
      { name: '李家', members: ['李爷爷', '李奶奶', '李叔叔', '李阿姨', '李小美'] },
      { name: '陈家', members: ['陈大伟', '陈太太'] },
      { name: '张家', members: ['张伯伯', '张阿姨', '张小宝', '张小贝'] },
      { name: '林家', members: ['林哥哥'] }
    ];
    state.rules.exclusions = [];
    state.demo = true;
    if (!state.event.name) state.event.name = '2026 家庭圣诞交换礼物';
    save();
  }

  $('clearListBtn').addEventListener('click', async () => {
    const ok = await confirmModal({
      emoji: '🧹', danger: true,
      title: bi('清空名单？', 'Clear the list?'),
      text: bi('所有家庭和成员都会删除，活动信息和规则会保留。', 'All families and members will be removed. Event details and rules are kept.'),
      ok: bi('清空', 'Clear')
    });
    if (!ok) return;
    state.families = defaultState().families;
    state.rules.exclusions = [];
    state.demo = false;
    save();
    renderSetup();
  });

  [['evName', 'name'], ['evBudget', 'budget'], ['evDate', 'date'], ['evNote', 'note']].forEach(([id, key]) => {
    $(id).addEventListener('input', () => {
      state.event[key] = $(id).value;
      save();
      if (key === 'name') renderHeader('setup');
    });
  });
  $('ruleNoSwap').addEventListener('change', () => { state.rules.noReciprocal = $('ruleNoSwap').checked; save(); renderValidation(); });
  $('ruleLoop').addEventListener('change', () => { state.rules.singleLoop = $('ruleLoop').checked; save(); renderValidation(); });

  /* ---- admin PIN (only a salted hash is stored) ---- */
  $('adminPin').addEventListener('input', () => {
    const v = $('adminPin').value.trim();
    if (!v) return; // empty field keeps the existing PIN; use "remove" to clear
    if (!state.pinSalt) state.pinSalt = S.newId();
    state.pinHash = S.hashPin(v, state.pinSalt);
    save();
    renderPinStatus();
  });
  function renderPinStatus() {
    $('pinStatus').innerHTML = state.pinHash
      ? `${bi('✓ 已设置管理员密码。输入新密码就会替换旧的。', '✓ Admin PIN is set. Typing a new one replaces it.')}
         <button type="button" class="btn btn-link" id="clearPinBtn">${bi('清除密码', 'Remove PIN')}</button>`
      : bi('还没有设置密码。', 'No PIN set yet.');
  }
  $('pinStatus').addEventListener('click', (e) => {
    if (e.target.closest('#clearPinBtn')) {
      state.pinHash = '';
      state.pinSalt = '';
      $('adminPin').value = '';
      save();
      renderPinStatus();
    }
  });

  /* ---- extra exclusions ---- */
  function allPeople() {
    return S.flatten(state.families);
  }
  function pruneExclusions() {
    const names = new Set(allPeople().map((p) => S.normName(p.name)));
    const before = state.rules.exclusions.length;
    state.rules.exclusions = state.rules.exclusions.filter((x) => names.has(S.normName(x[0])) && names.has(S.normName(x[1])));
    if (state.rules.exclusions.length !== before) save();
  }
  function renderExclusions() {
    const people = allPeople();
    const names = state.families.map((f) => f.name);
    const giverSel = $('exGiver');
    const prev = giverSel.value;
    giverSel.innerHTML = `<option value="">送礼人 · Giver</option>` +
      people.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}（${esc(famText(names, p.family))}）</option>`).join('');
    if (people.some((p) => p.name === prev)) giverSel.value = prev;
    renderReceiverOptions();
    const ex = state.rules.exclusions;
    $('exCount').hidden = !ex.length;
    $('exCount').textContent = ex.length;
    $('exList').innerHTML = ex.map((x, i) => `
      <li><span><b>${esc(x[0])}</b> <span class="en" style="margin:0 .3em">✗→</span> <b>${esc(x[1])}</b></span>
      <button type="button" class="icon-btn" data-ex="${i}" aria-label="删除 Remove">✕</button></li>`).join('');
  }
  function renderReceiverOptions() {
    const people = allPeople();
    const names = state.families.map((f) => f.name);
    const g = people.find((p) => p.name === $('exGiver').value);
    const options = g ? people.filter((p) => p.family !== g.family) : [];
    $('exReceiver').innerHTML = `<option value="">收礼人 · Receiver</option>` +
      options.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}（${esc(famText(names, p.family))}）</option>`).join('');
  }
  $('exGiver').addEventListener('change', renderReceiverOptions);
  $('exAddBtn').addEventListener('click', () => {
    const g = $('exGiver').value;
    const r = $('exReceiver').value;
    if (!g || !r) return toast(bi('请先选好两个人', 'Pick both people first'));
    const exists = state.rules.exclusions.some((x) => S.normName(x[0]) === S.normName(g) && S.normName(x[1]) === S.normName(r));
    if (!exists) state.rules.exclusions.push([g, r]);
    save();
    renderExclusions();
    renderValidation();
  });
  $('exList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ex]');
    if (!b) return;
    state.rules.exclusions.splice(Number(b.dataset.ex), 1);
    save();
    renderExclusions();
    renderValidation();
  });

  /* ---- validation ---- */
  function errorHtml(e) {
    const names = state.families.map((f) => f.name);
    switch (e.code) {
      case 'duplicate':
        return bi(`名字重复：「${esc(e.name)}」。同名的话请加个区分，比如「${esc(e.name)}（大）」。`,
          `Duplicate name: "${esc(e.name)}". Please make names unique, e.g. "${esc(e.name)} (Jr)".`);
      case 'too-few-people':
        return bi('至少需要 2 个人才能抽签。', 'Add at least 2 people to draw names.');
      case 'too-few-families':
        return bi('至少要有 2 个家庭有成员。', 'At least 2 families need members.');
      case 'family-too-big': {
        return bi(`「${famZh(names, e.family)}」有 ${e.size} 人，超过了总人数 ${e.total} 人的一半，这样一定会有人抽到自家人。请给其他家庭加人，或者把这个家庭拆开。`,
          `"${famEn(names, e.family)}" has ${e.size} of ${e.total} people (more than half), so someone would have to draw their own family. Add people to other families or split this one.`);
      }
      case 'too-few-for-no-swap':
        return bi('只有 2 个人时一定会互抽，请关掉「避免两人互抽」。', 'With only 2 people a swap is unavoidable. Turn off "No swaps".');
      case 'no-solution':
        return bi('按照现在的额外限制，找不到符合规则的抽法。请删掉一些额外限制。', 'These exclusions make a valid draw impossible. Please remove some.');
      default:
        return esc(e.code);
    }
  }
  function renderValidation() {
    const v = S.validate(state.families, state.rules);
    const famCount = state.families.filter((f) => f.members.length).length;
    $('peopleCount').innerHTML = `${v.total} 人 · ${famCount} 个家庭<span class="en">${v.total} people · ${famCount} families</span>`;
    // "too few people" is obvious while the list is still empty — don't shout about it
    const errors = v.total === 0 ? [] : v.errors;
    $('setupErrors').innerHTML = errors.map((e) => `<div class="err">${errorHtml(e)}</div>`).join('');
    // Not `disabled`: a disabled button swallows taps, and the errors may be off-screen on a phone.
    $('drawBtn').classList.toggle('is-disabled', !v.ok);
    $('drawBtn').setAttribute('aria-disabled', String(!v.ok));
    return v;
  }

  /* ---- draw ---- */
  $('drawBtn').addEventListener('click', async () => {
    const v = renderValidation();
    if (!v.ok) {
      if (v.total === 0) return toast(bi('请先添加家庭成员', 'Add family members first'));
      toast(bi('请先处理红色的提示', 'Please fix the issue in red'));
      return $('setupErrors').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (!state.pinHash) {
      const go = await confirmModal({
        emoji: '🔓',
        title: bi('还没有设置管理员密码', 'No admin PIN yet'),
        text: bi('没有密码的话，拿到手机的人都能点「管理员」看到全部结果。确定不设密码吗？',
          'Without a PIN, anyone holding the phone can open "Admin" and see every result. Continue without one?'),
        ok: bi('不用密码，直接抽签', 'Draw without a PIN'),
        cancel: bi('我去设置密码', "I'll set a PIN")
      });
      if (!go) {
        $('adminPin').focus();
        return $('adminPin').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    const res = S.draw(v.people, state.rules);
    if (!res.assignment) {
      return confirmModal({
        emoji: '🤔', cancel: false,
        title: bi('找不到符合所有规则的抽法', "Couldn't find a draw that fits every rule"),
        text: bi('请关掉「所有人连成一个大圈」，或者删掉一些额外限制，再试一次。', 'Turn off "One big loop" or remove some exclusions, then try again.')
      });
    }
    await playDrawAnimation(v.people);
    state.draw = {
      id: S.newId(),
      at: Date.now(),
      event: clone(state.event),
      familyNames: state.families.map((f) => f.name.trim()),
      people: v.people,
      assignment: res.assignment,
      rules: clone(state.rules),
      method: res.method
    };
    save();
    showScreen('admin'); // the organiser just made it, so no PIN is needed this once
    confetti();
    toast(bi('抽签好了！把链接发给大家', 'Done! Send the link to everyone') + ' 🎉');
  });

  /* ================= RESULTS ================= */
  function eventMetaHtml(ev) {
    const items = [];
    if (ev.budget) items.push(`<span class="meta">💰 ${bi('预算', 'Budget')} <b>${esc(ev.budget)}</b></span>`);
    if (ev.date) items.push(`<span class="meta">📅 ${bi('交换日期', 'Date')} <b>${esc(ev.date)}</b></span>`);
    return items.join('');
  }
  function renderResults() {
    const v = currentView();
    if (!v) return showScreen('setup');
    $('sharedBanner').hidden = !v.isShared;
    // only offer "back to my own draw" on a device that actually has one
    $('leaveSharedBtn').hidden = !(v.isShared && (state.draw || state.families.some((f) => f.members.length)));
    $('adminBtn').hidden = v.isShared && !v.pinHash; // shared links without a PIN have no admin page

    const meta = eventMetaHtml(v.event);
    $('eventCard').innerHTML = `
      <div class="event-name">${v.event.name ? esc(v.event.name) : bi('家庭交换礼物', 'Family gift exchange')}</div>
      ${meta ? `<div class="event-meta">${meta}</div>` : ''}
      ${v.event.note ? `<p class="event-note">${esc(v.event.note)}</p>` : ''}`;

    if (Sync.enabled && claims.id !== v.id) {
      // wait for the shared list first, so names that were already drawn never flash up
      $('viewedBox').hidden = true;
      $('nameGroups').innerHTML = `<p class="names-note">${bi('正在载入名单…', 'Loading names…')}</p>`;
      refreshClaims(v).then(() => { if (!$('screen-results').hidden) renderResults(); });
      return;
    }
    const remote = Sync.enabled ? claims.set : null; // who has drawn (everyone's phones), or null if unknown
    const viewed = getViewed(v.id);
    const mine = myDraws(v);
    const n = v.people.length;
    const done = remote ? remote.size : viewed.length;
    // a per-device count only means something when everyone shares this one device
    $('viewedBox').hidden = !remote && v.isShared;
    $('viewedBar').style.width = (100 * Math.min(done, n) / n) + '%';
    $('viewedText').innerHTML = remote
      ? `已经有 ${done} / ${n} 人抽过了<span class="en">${done} of ${n} have drawn</span>`
      : `已抽 ${done} / ${n}<span class="en">${done} of ${n} have drawn on this device</span>`;

    // names that were already drawn leave the list, so nobody can peek at them
    const open = (pi) => !mine.includes(pi) && !(remote && remote.has(pi));
    const groups = v.familyNames.map((_, fi) => {
      const members = v.people.map((p, pi) => ({ p, pi })).filter((x) => x.p.family === fi && open(x.pi));
      if (!members.length) return '';
      return `<div class="name-group ${famClass(fi)}">
        <h3><span class="family-dot" aria-hidden="true"></span>${famHtml(v.familyNames, fi)}</h3>
        <div class="name-grid">${members.map((x) => `<button type="button" class="name-btn" data-pi="${x.pi}">${esc(x.p.name)}</button>`).join('')}</div>
      </div>`;
    }).join('');
    const mineHtml = mine.length ? `<div class="mine-box">
        <h3>${bi('这台手机抽过的', 'Drawn on this phone')}</h3>
        <div class="name-grid">${mine.map((pi) => `<button type="button" class="name-btn mine ${famClass(v.people[pi].family)}" data-pi="${pi}">${esc(v.people[pi].name)}<small>${viewed.includes(pi) ? bi('再看一次结果', 'See my result') : bi('继续抽签', 'Continue')}</small></button>`).join('')}</div>
      </div>` : '';
    const offline = Sync.enabled && claims.error
      ? `<p class="names-note warn">${bi('暂时连不上网络，已经抽过的名字可能还会显示。', 'Offline right now, so names that were already drawn may still show.')}</p>` : '';
    const allDone = groups ? '' : `<p class="names-note done">🎉 ${bi('大家都抽完了！', 'Everyone has drawn!')}</p>`;
    $('nameGroups').innerHTML = offline + groups + allDone + mineHtml;
  }

  $('nameGroups').addEventListener('click', (e) => {
    const b = e.target.closest('.name-btn');
    if (b) chooseName(Number(b.dataset.pi));
  });

  async function chooseName(pi) {
    const v = currentView();
    const name = esc(v.people[pi].name);
    if (myDraws(v).includes(pi)) {
      if (!getViewed(v.id).includes(pi)) { treePerson = pi; return showScreen('tree'); } // chose, but never opened a tag
      const again = await confirmModal({
        emoji: '👀',
        title: bi(`${name}，你已经抽过了`, `${name}, you've already drawn`),
        text: bi('要再看一次你抽到的人吗？请确认是本人哦。', "See who you drew again? Make sure it's really you."),
        ok: bi('再看一次', 'Show again')
      });
      if (again) showReveal(v, pi, false);
      return;
    }
    // ask twice, so nobody takes someone else's name by mistake
    const first = await confirmModal({
      emoji: '🤔',
      title: bi(`你是 ${name} 吗？`, `Are you ${name}?`),
      text: bi('请确认这是你自己的名字。', 'Please check that this is your own name.'),
      ok: bi('是我', "Yes, it's me"),
      cancel: bi('不是', 'No')
    });
    if (!first) return;
    const second = await confirmModal({
      emoji: '⚠️',
      title: bi(`再确认一次：你真的是 ${name}？`, `Double-check: are you really ${name}?`),
      text: Sync.enabled
        ? bi('确定以后，这个名字会从大家的名单上消失，不能再改。', "After this, the name disappears from everyone's list and can't be changed.")
        : bi('确定以后就不能再改了。', "After this you can't change it."),
      ok: bi('确定，我要抽签', "Yes, I'm ready to draw"),
      cancel: bi('取消', 'Cancel')
    });
    if (!second) return;
    if (Sync.enabled) {
      openModal(`<div class="modal-emoji busy" aria-hidden="true">🎄</div>
        <p class="modal-text" id="modalTitle">${bi('正在登记，请稍等…', 'Saving your pick…')}</p>`);
      const res = await Sync.claim(v.id, pi);
      closeModal(undefined);
      if (res === 'taken') {
        await refreshClaims(v);
        renderResults();
        return confirmModal({
          emoji: '😮', cancel: false,
          title: bi(`${name} 已经抽过了`, `${name} has already drawn`),
          text: bi('如果这真的是你，而且你还没抽过，请找管理员帮你重置。', "If this really is you and you haven't drawn yet, ask the organiser to reset it.")
        });
      }
      if (res === 'error') {
        const go = await confirmModal({
          emoji: '📶',
          title: bi('网络好像有问题', 'Network problem'),
          text: bi('现在连不上网络，你的名字暂时不会从别人的名单上消失（连上网以后会自动补上）。要继续抽吗？',
            "Can't reach the network, so your name won't leave other people's lists yet (it catches up once you're back online). Draw anyway?"),
          ok: bi('继续抽签', 'Draw anyway'),
          cancel: bi('稍后再试', 'Try later')
        });
        if (!go) return;
        state.pending[v.id] = (state.pending[v.id] || []).concat(pi);
      }
      addMine(v.id, pi);
      if (res === 'ok' && claims.id === v.id && claims.set) claims.set.add(pi);
    }
    treePerson = pi;
    showScreen('tree');
  }

  /**
   * Show who person pi gives to, on a red-and-gold card. The pairing was fixed when the organiser
   * created the draw (that is what guarantees everyone gets a valid match).
   * animate: the card starts face down ("签") and flips over.
   */
  function showReveal(v, pi, animate) {
    const name = esc(v.people[pi].name);
    const rp = v.people[v.assignment[pi]];
    markViewed(v.id, pi);
    const meta = eventMetaHtml(v.event);
    const flip = animate && !reducedMotion;
    openModal(`
      <p class="reveal-intro" id="modalTitle">${bi(`${name}，你要送礼物给`, `${name}, you're the Secret Santa for`)}</p>
      <div class="flip${flip ? '' : ' flipped'}" id="revealFlip">
        <div class="flip-inner">
          <div class="flip-face flip-front" aria-hidden="true">签</div>
          <div class="flip-face flip-back">
            <div class="reveal-name">${esc(rp.name)}</div>
            <div class="reveal-family ${famClass(rp.family)}"><span class="tag">${famHtml(v.familyNames, rp.family)}</span></div>
          </div>
        </div>
      </div>
      ${meta ? `<div class="reveal-meta">${meta}</div>` : ''}
      <p class="reveal-secret">${bi('🤫 记住了就关掉，不要告诉别人哦！', '🤫 Remember it, close this, and keep it a secret!')}</p>
      <div class="modal-actions"><button type="button" class="btn btn-ok btn-big" data-result="ok">${bi('记住了，关掉', 'Got it, close')}</button></div>`,
    (root) => {
      if (!flip) return confetti();
      setTimeout(() => {
        const f = root.querySelector('#revealFlip');
        if (f) { f.classList.add('flipped'); confetti(); }
      }, 450);
    }, 'modal-reveal').then(() => showScreen('results'));
  }

  /* ================= CHRISTMAS TREE ================= */
  let treePerson = null;

  /** Hanging spots for n tags: rows of 2, 3, 4, … inside the tree's triangle, in % of the tree box. */
  function treeSpots(n) {
    let rows = 1;
    while ((rows * (rows + 3)) / 2 < n) rows++;
    const caps = Array.from({ length: rows }, (_, i) => i + 2);
    const total = caps.reduce((a, b) => a + b, 0);
    const exact = caps.map((c) => (c * n) / total);
    const counts = exact.map(Math.floor);
    let left = n - counts.reduce((a, b) => a + b, 0);
    exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0])
      .forEach(([, i]) => { if (left > 0) { counts[i]++; left--; } });
    const spots = [];
    counts.forEach((c, r) => {
      const y = rows === 1 ? 45 : 20 + (r * 50) / (rows - 1); // where the string hangs from
      const half = ((y + 6 - 11) / 71) * 38.75 * 0.88; // the tree's half-width at the tag
      for (let k = 0; k < c; k++) spots.push({ x: c === 1 ? 50 : 50 - half + (2 * half * k) / (c - 1), y });
    });
    return spots;
  }

  function renderTree() {
    const v = currentView();
    const me = v && v.people[treePerson];
    if (!me) return showScreen('results');
    $('treeName').textContent = me.name;
    $('treeNameEn').textContent = me.name;
    // one tag per person in the other families (the people you could get), kept to a size that fits
    const n = Math.max(3, Math.min(21, v.people.filter((p) => p.family !== me.family).length));
    const colors = ['t-red', 't-gold', 't-white', 't-blue'];
    $('treeTags').className = 'tree-tags';
    $('treeTags').innerHTML = treeSpots(n).map((s, i) => `
      <button type="button" class="hang-tag ${colors[i % colors.length]}" data-tag="${i}"
        style="left:${s.x.toFixed(1)}%;top:${s.y.toFixed(1)}%;--d:${(2.2 + Math.random() * 1.8).toFixed(2)}s;--delay:-${(Math.random() * 3).toFixed(2)}s"
        aria-label="签 ${i + 1} · Tag ${i + 1}"><span class="string"></span><span class="tag-body">签</span></button>`).join('');
  }

  $('treeTags').addEventListener('click', (e) => {
    const tag = e.target.closest('.hang-tag');
    const box = $('treeTags');
    if (!tag || box.classList.contains('picking')) return;
    box.classList.add('picking');
    // fly the chosen tag to the middle of the screen, then turn it over
    const r = tag.getBoundingClientRect();
    tag.style.setProperty('--tx', (window.innerWidth / 2 - (r.left + r.width / 2)) + 'px');
    tag.style.setProperty('--ty', (window.innerHeight / 2 - (r.top + r.height / 2)) + 'px');
    tag.classList.add('picked');
    // Whichever tag is picked holds this person's match, fixed when the organiser created the draw.
    setTimeout(() => showReveal(currentView(), treePerson, true), reducedMotion ? 60 : 750);
  });

  $('adminBtn').addEventListener('click', async () => {
    const v = currentView();
    if (v.pinHash) {
      const ok = await askPin(v);
      if (!ok) return;
    } else {
      const ok = await confirmModal({
        emoji: '🔓',
        title: bi('查看全部结果？', "See everyone's results?"),
        text: bi('这会显示每个人抽到了谁。如果你自己也参加，看了就没有惊喜了哦。', "This shows who everyone drew. If you're playing too, it spoils your own surprise."),
        ok: bi('我是管理员，继续', "I'm the admin, continue")
      });
      if (!ok) return;
    }
    showScreen('admin');
    adminUnlocked = true;
  });

  function askPin(v) {
    return openModal(`
      <div class="modal-emoji" aria-hidden="true">🔒</div>
      <h2 id="modalTitle">${bi('输入管理员密码', 'Enter the admin PIN')}</h2>
      <input class="pin-input" id="pinTry" type="password" inputmode="numeric" autocomplete="off" maxlength="20" aria-label="管理员密码 Admin PIN">
      <p class="err-inline" id="pinErr"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary" id="pinOk">${bi('确定', 'OK')}</button>
        <button type="button" class="btn btn-ghost" data-result="cancel">${bi('取消', 'Cancel')}</button>
      </div>`, (root) => {
      const input = root.querySelector('#pinTry');
      const submit = () => {
        if (S.hashPin(input.value, v.pinSalt) === v.pinHash) return closeModal(true);
        root.querySelector('#pinErr').innerHTML = bi('密码不对，再试一次。', 'Wrong PIN, try again.');
        input.value = '';
        input.focus();
      };
      root.querySelector('#pinOk').addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });
  }

  $('leaveSharedBtn').addEventListener('click', () => { clearUrl(); route(); });

  /* ================= ADMIN ================= */
  const CHECK_LABELS = {
    'everyone-gives': ['每个人都要送出 1 份礼物', 'Everyone gives exactly 1 gift'],
    'everyone-receives': ['每个人都会收到 1 份礼物', 'Everyone gets exactly 1 gift'],
    'no-self': ['没有人抽到自己', 'Nobody drew themselves'],
    'no-family': ['没有人抽到自己家的人', 'Nobody drew their own family'],
    'no-swap': ['没有两个人互相抽到', 'No two people drew each other'],
    'single-loop': ['所有人连成一个大圈', 'Everyone is in one big loop'],
    'exclusions': ['额外限制全部遵守', 'All extra exclusions respected']
  };
  function problemText(v, p) {
    const nm = (i) => esc(v.people[i] ? v.people[i].name : '?');
    if (p.giver != null && p.receiver != null) return `${nm(p.giver)} → ${nm(p.receiver)}`;
    if (p.person != null) return bi(`${nm(p.person)} 收到 ${p.count} 份`, `${nm(p.person)} gets ${p.count}`);
    if (p.count != null) return bi(`分成了 ${p.count} 个圈`, `split into ${p.count} loops`);
    if (p.giver != null) return bi(`${nm(p.giver)} 没有结果`, `${nm(p.giver)} has no result`);
    return bi('结果不完整', 'incomplete result');
  }

  function renderAdmin() {
    const v = currentView();
    if (!v) return showScreen('setup');
    const check = S.verify(v.people, v.assignment, v.rules);
    const badPairs = new Set();
    check.checks.forEach((c) => c.problems.forEach((p) => { if (p.giver != null) badPairs.add(p.giver); }));

    const when = new Date(v.at).toLocaleString();
    $('verifyCard').innerHTML = `
      <div class="verify-status ${check.ok ? 'ok' : 'bad'}">
        <span class="big" aria-hidden="true">${check.ok ? '✓' : '✗'}</span>
        <div>${check.ok ? bi('全部符合规则，没有抽错！', 'Everything checks out!') : bi('有问题！请重新抽签', 'Problems found — please redraw')}</div>
      </div>
      <ul class="checks">${check.checks.map((c) => `
        <li class="${c.ok ? 'ok' : 'bad'}"><span class="mark">${c.ok ? '✓' : '✗'}</span>
          <div>${bi(CHECK_LABELS[c.id][0], CHECK_LABELS[c.id][1])}
          ${c.ok ? '' : `<div class="problems">${c.problems.map((p) => problemText(v, p)).join('；')}</div>`}</div></li>`).join('')}
      </ul>
      <p class="method-note">${v.method === 'search'
        ? bi('规则比较严格，这次是用搜索算法找到的结果。', 'Rules were tight, so a search algorithm found this result.')
        : bi('完全随机：每一种符合规则的结果，被抽中的机会都一样。', 'Fully random: every valid outcome was equally likely.')}
        <br>${bi(`抽签时间：${esc(when)}`, `Drawn: ${esc(when)}`)}</p>`;

    const viewed = getViewed(v.id);
    $('resultTable').innerHTML = `
      <thead><tr><th>${bi('送礼人', 'Giver')}</th><th></th><th>${bi('收礼人', 'Receiver')}</th><th>${Sync.enabled ? bi('已抽', 'Drawn') : bi('已查看', 'Viewed')}</th></tr></thead>
      <tbody>${v.people.map((p, g) => {
        const r = v.people[v.assignment[g]];
        return `<tr class="${badPairs.has(g) ? 'problem' : ''}" data-pi="${g}">
          <td><span class="person ${famClass(p.family)}"><b>${esc(p.name)}</b><span class="tag">${famHtml(v.familyNames, p.family)}</span></span></td>
          <td class="arrow">→</td>
          <td>${r ? `<span class="person ${famClass(r.family)}"><b>${esc(r.name)}</b><span class="tag">${famHtml(v.familyNames, r.family)}</span></span>` : '?'}</td>
          <td class="seen">${viewed.includes(g) ? '✓' : ''}</td></tr>`;
      }).join('')}</tbody>`;

    const loops = S.cycles(v.assignment);
    $('chains').innerHTML = loops.map((cyc, i) => {
      const who = (pi) => `<span class="who ${famClass(v.people[pi].family)}">${esc(v.people[pi].name)}</span>`;
      return `<div class="chain">
        <span class="chain-label">${loops.length > 1 ? bi(`第 ${i + 1} 圈 · ${cyc.length} 人`, `Loop ${i + 1} · ${cyc.length} people`) : bi(`一个大圈 · ${cyc.length} 人`, `One loop · ${cyc.length} people`)}</span>
        ${cyc.map(who).join('<span class="to">→</span>')}<span class="to">→</span>${who(cyc[0])}
      </div>`;
    }).join('');

    renderShare(v);
    $('redrawBtn').hidden = v.isShared;
    $('editSetupBtn').hidden = v.isShared;
    $('resetAllBtn').hidden = v.isShared;
    renderProgress(v);
  }

  /** Admin: who has drawn so far (from the shared list), with a reset for wrong picks. */
  async function renderProgress(v) {
    $('progressCard').hidden = !Sync.enabled;
    if (!Sync.enabled) return;
    $('progressList').innerHTML = `<p class="hint">${bi('正在载入…', 'Loading…')}</p>`;
    await refreshClaims(v);
    const now = currentView();
    if ($('screen-admin').hidden || !now || now.id !== v.id) return;
    const set = claims.set;
    if (!set) {
      $('progressList').innerHTML = `<p class="warn">${bi('连不上网络，等一下再按「刷新」。', 'Offline. Tap "Refresh" in a moment.')}</p>`;
      return;
    }
    $('progressList').innerHTML = `<p class="progress-summary"><b>${set.size} / ${v.people.length}</b> ${bi('人已经抽了', 'have drawn')}</p>` +
      v.familyNames.map((_, fi) => {
        const members = v.people.map((p, pi) => ({ p, pi })).filter((x) => x.p.family === fi);
        if (!members.length) return '';
        return `<div class="progress-family ${famClass(fi)}"><h3>${famHtml(v.familyNames, fi)}</h3><ul>` +
          members.map((x) => set.has(x.pi)
            ? `<li class="drawn"><span>✓ ${esc(x.p.name)}</span><button type="button" class="btn btn-small btn-ghost" data-reset="${x.pi}">${bi('重置', 'Reset')}</button></li>`
            : `<li><span>○ ${esc(x.p.name)}</span><span class="pending">${bi('还没抽', 'Not yet')}</span></li>`).join('') +
          '</ul></div>';
      }).join('');
    document.querySelectorAll('#resultTable tbody tr').forEach((tr) => {
      const cell = tr.querySelector('.seen');
      if (cell) cell.textContent = set.has(Number(tr.dataset.pi)) ? '✓' : '';
    });
  }
  $('refreshProgressBtn').addEventListener('click', () => renderProgress(currentView()));
  $('progressList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-reset]');
    if (!b) return;
    const v = currentView();
    const pi = Number(b.dataset.reset);
    const name = esc(v.people[pi].name);
    const ok = await confirmModal({
      emoji: '↩️',
      title: bi(`把 ${name} 放回名单？`, `Put ${name} back on the list?`),
      text: bi('有人点错名字的时候用。重置后，这个名字会重新出现在大家的名单上，可以再抽一次（抽到的人不会变）。',
        "Use this if someone picked the wrong name. The name comes back on everyone's list so it can be drawn again (the match stays the same)."),
      ok: bi('重置', 'Reset')
    });
    if (!ok) return;
    try {
      await Sync.unclaim(v.id, pi);
      toast(bi('已重置', 'Reset done') + ' ✓');
    } catch (err) {
      toast(bi('重置失败，请检查网络', 'Reset failed, check the connection'));
    }
    renderProgress(v);
  });

  function shareLink(v) {
    if (v.isShared) return location.href.split('#')[0].split('?')[0] + '#d=' + S.extractShareCode(location.href);
    if (shareCache.id !== v.id) {
      const payload = {
        v: 1, id: v.id, at: v.at, m: v.method,
        e: { n: v.event.name, b: v.event.budget, d: v.event.date, o: v.event.note },
        f: v.familyNames.map((fn, fi) => [fn, v.people.filter((p) => p.family === fi).map((p) => p.name)]),
        a: v.assignment,
        r: { nr: v.rules.noReciprocal ? 1 : 0, sl: v.rules.singleLoop ? 1 : 0, x: v.rules.exclusions || [] },
        ph: v.pinHash, ps: v.pinSalt
      };
      shareCache = { id: v.id, code: S.encodeShare(payload) };
    }
    return location.href.split('#')[0].split('?')[0] + '#d=' + shareCache.code;
  }
  function shareMessage(v) {
    const title = v.event.name || '家庭交换礼物 Family Secret Santa';
    return `🎁 ${title}\n` +
      '🎄 来抽签啦！点开链接 → 选自己的名字 → 在圣诞树上挑一个签，看看你要送礼物给谁。只点自己的名字哦！\n' +
      "🎄 Time to draw! Open the link, tap YOUR name and pick a tag from the Christmas tree to see who you're buying for. Only your own name, please!\n" +
      shareLink(v);
  }
  function renderShare(v) {
    $('shareLink').value = shareLink(v);
    let framed = false;
    try { framed = window.self !== window.top; } catch (e) { framed = true; }
    // A local file or an embedded preview has no address that other phones can open
    const local = !/^https?:$/.test(location.protocol) || framed;
    $('shareWarning').hidden = !local;
    $('shareWarning').innerHTML = bi(
      '⚠️ 你现在是直接打开电脑上的网页文件（或者是在预览窗口里），这个链接在别人的手机上打不开。要分享给不在场的家人，需要先把网页放到网上（比如 GitHub Pages，看 README 里的步骤）。大家在一起的话，直接用这台设备轮流看就行。',
      "⚠️ You opened this page as a file on this computer (or inside a preview), so the link won't work on other phones. To share it, put the page online first (e.g. GitHub Pages, see the README). If everyone is together, just pass this device around.");
    $('nativeShareBtn').hidden = !navigator.share || local;
  }

  function resultsText(v) {
    const lines = [`🎁 ${v.event.name || '家庭交换礼物 Family Secret Santa'}`];
    if (v.event.budget) lines.push(`预算 Budget: ${v.event.budget}`);
    if (v.event.date) lines.push(`日期 Date: ${v.event.date}`);
    lines.push('');
    v.familyNames.forEach((_, fi) => {
      const members = v.people.map((p, pi) => ({ p, pi })).filter((x) => x.p.family === fi);
      if (!members.length) return;
      lines.push(`【${famText(v.familyNames, fi)}】`);
      members.forEach((x) => {
        const r = v.people[v.assignment[x.pi]];
        lines.push(`  ${x.p.name} → ${r.name}（${famText(v.familyNames, r.family)}）`);
      });
    });
    return lines.join('\n');
  }

  $('backToResultsBtn').addEventListener('click', () => showScreen('results'));
  $('copyResultsBtn').addEventListener('click', () => copyWithFeedback(resultsText(currentView())));
  $('copyLinkBtn').addEventListener('click', () => copyWithFeedback($('shareLink').value));
  $('copyMessageBtn').addEventListener('click', () => copyWithFeedback(shareMessage(currentView())));
  $('shareLink').addEventListener('focus', () => $('shareLink').select());
  $('nativeShareBtn').addEventListener('click', async () => {
    const v = currentView();
    try { await navigator.share({ title: v.event.name || 'Secret Santa', text: shareMessage(v) }); } catch (e) { /* cancelled */ }
  });

  $('redrawBtn').addEventListener('click', async () => {
    const ok = await confirmModal({
      emoji: '🔄',
      title: bi('重新抽签？', 'Redraw?'),
      text: bi('现在的结果会作废。如果已经有人看过结果、或者已经把链接发出去了，记得通知大家重新看新的结果。',
        'The current result will be replaced. If anyone already looked or you sent a link, tell everyone to check the new result.'),
      ok: bi('重新抽签', 'Redraw')
    });
    if (!ok) return;
    const d = state.draw;
    const res = S.draw(d.people, d.rules);
    if (!res.assignment) return toast(bi('抽签失败，请修改规则', 'Draw failed, please change the rules'));
    await playDrawAnimation(d.people);
    Object.assign(d, { id: S.newId(), at: Date.now(), assignment: res.assignment, method: res.method });
    save();
    renderAdmin();
    adminUnlocked = true;
    window.scrollTo(0, 0);
    toast(bi('已重新抽签', 'Redrawn') + ' 🎉');
  });

  $('editSetupBtn').addEventListener('click', async () => {
    const ok = await confirmModal({
      emoji: '✏️',
      title: bi('修改名单和规则？', 'Edit names & rules?'),
      text: bi('修改后需要重新抽签，现在的结果会作废。', "You'll need to draw again; the current result will be discarded."),
      ok: bi('去修改', 'Edit')
    });
    if (!ok) return;
    state.draw = null;
    save();
    showScreen('setup');
  });

  $('resetViewedBtn').addEventListener('click', async () => {
    const v = currentView();
    const ok = await confirmModal({
      emoji: '👀',
      title: bi('清除「已查看」标记？', 'Clear "viewed" marks?'),
      text: bi('只会清除这台设备上的记录，不会改变抽签结果。', 'Only affects this device. The draw stays the same.')
    });
    if (!ok) return;
    delete state.viewed[v.id];
    save();
    renderAdmin();
    adminUnlocked = true;
  });

  $('resetAllBtn').addEventListener('click', async () => {
    const ok = await confirmModal({
      emoji: '🗑', danger: true,
      title: bi('全部清空？', 'Start over?'),
      text: bi('名单、规则、抽签结果都会删除，没办法恢复。', 'All names, rules and results will be deleted. This cannot be undone.'),
      ok: bi('全部清空', 'Delete everything')
    });
    if (!ok) return;
    state = defaultState();
    shareCache = { id: null, code: null };
    save();
    showScreen('setup');
  });

  /* ================= start ================= */
  function buildLights() {
    const n = Math.max(12, Math.round(window.innerWidth / 30));
    if ($('lights').children.length !== n) $('lights').innerHTML = '<span class="bulb"></span>'.repeat(n);
  }
  buildLights();
  window.addEventListener('resize', buildLights);

  // A preview page can set window.SANTA_START_WITH_DEMO so first-time viewers see a filled-in example.
  if (window.SANTA_START_WITH_DEMO && !state.draw && !state.families.some((f) => f.members.length)) fillDemo();
  route();
})();
