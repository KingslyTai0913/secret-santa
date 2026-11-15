/*!
 * santa-core.js — Secret Santa 抽签核心算法 / core draw logic (no dependencies)
 * Works in the browser (window.SantaCore) and in Node (require('./santa-core.js')).
 *
 * Data model
 *   families: [{ name: '王家', members: ['小明', '小红'] }, ...]
 *   people:   [{ name: '小明', family: 0 }, ...]      (flattened, family = index)
 *   rules:    { noReciprocal: bool, singleLoop: bool, exclusions: [['giver', 'receiver'], ...] }
 *   assignment: array, assignment[giverIndex] = receiverIndex
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SantaCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Randomness: crypto-grade, unbiased                                  */
  /* ------------------------------------------------------------------ */
  const cryptoObj =
    typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues
      ? globalThis.crypto
      : null;
  let pool = null;
  let poolIdx = 0;

  function nextUint32() {
    if (!cryptoObj) return Math.floor(Math.random() * 4294967296);
    if (!pool || poolIdx >= pool.length) {
      pool = new Uint32Array(4096);
      cryptoObj.getRandomValues(pool);
      poolIdx = 0;
    }
    return pool[poolIdx++];
  }

  /** Uniform integer in [0, n) without modulo bias. */
  function randomInt(n) {
    if (n <= 1) return 0;
    const limit = Math.floor(4294967296 / n) * n;
    let x;
    do { x = nextUint32(); } while (x >= limit);
    return x % n;
  }

  function shuffle(a, rand) {
    rand = rand || randomInt;
    for (let i = a.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function range(n) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = i;
    return a;
  }

  /* ------------------------------------------------------------------ */
  /* Names & people                                                      */
  /* ------------------------------------------------------------------ */
  function normName(s) {
    return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** Split pasted text into names: newline, comma, 、, ; (not spaces — "John Smith" is one name). */
  function parseNames(text) {
    return String(text == null ? '' : text)
      .split(/[\n\r,，、;；\t]+/)
      .map(function (s) { return s.trim().replace(/\s+/g, ' '); })
      .filter(Boolean);
  }

  function flatten(families) {
    const people = [];
    (families || []).forEach(function (f, fi) {
      (f.members || []).forEach(function (m) {
        const name = String(m).trim();
        if (name) people.push({ name: name, family: fi });
      });
    });
    return people;
  }

  /* ------------------------------------------------------------------ */
  /* Constraints                                                         */
  /* ------------------------------------------------------------------ */
  /** allowed[g][r] = may giver g draw receiver r (not self, not same family, not excluded). */
  function buildAllowed(people, rules) {
    const n = people.length;
    const idx = {};
    for (let i = 0; i < n; i++) idx[normName(people[i].name)] = i;
    const allowed = [];
    for (let g = 0; g < n; g++) {
      const row = new Array(n);
      for (let r = 0; r < n; r++) row[r] = g !== r && people[g].family !== people[r].family;
      allowed.push(row);
    }
    const ex = (rules && rules.exclusions) || [];
    for (let k = 0; k < ex.length; k++) {
      const a = idx[normName(ex[k][0])];
      const b = idx[normName(ex[k][1])];
      if (a !== undefined && b !== undefined) allowed[a][b] = false;
    }
    return allowed;
  }

  /** Kuhn's algorithm: is there any assignment where everyone gives & receives exactly once? */
  function hasPerfectMatching(allowed) {
    const n = allowed.length;
    const matchR = new Array(n).fill(-1);
    function augment(g, seen) {
      for (let r = 0; r < n; r++) {
        if (!allowed[g][r] || seen[r]) continue;
        seen[r] = true;
        if (matchR[r] === -1 || augment(matchR[r], seen)) { matchR[r] = g; return true; }
      }
      return false;
    }
    for (let g = 0; g < n; g++) {
      if (!augment(g, new Array(n).fill(false))) return false;
    }
    return true;
  }

  /**
   * Validate the setup before drawing.
   * Returns { ok, errors: [{ code, ...params }], people, total }
   *   codes: duplicate, too-few-people, too-few-families, family-too-big, too-few-for-no-swap, no-solution
   */
  function validate(families, rules) {
    rules = rules || {};
    const errors = [];
    const people = flatten(families);
    const total = people.length;

    const seen = {};
    const reported = {};
    people.forEach(function (p) {
      const key = normName(p.name);
      if (seen[key] && !reported[key]) {
        errors.push({ code: 'duplicate', name: p.name });
        reported[key] = true;
      }
      seen[key] = true;
    });

    const sizes = (families || []).map(function (f, fi) {
      return { family: fi, name: f.name, size: people.filter(function (p) { return p.family === fi; }).length };
    });
    const nonEmpty = sizes.filter(function (s) { return s.size > 0; }).length;

    if (total < 2) {
      errors.push({ code: 'too-few-people', total: total });
    } else if (nonEmpty < 2) {
      errors.push({ code: 'too-few-families' });
    } else {
      sizes.forEach(function (s) {
        if (s.size * 2 > total) {
          errors.push({ code: 'family-too-big', family: s.family, name: s.name, size: s.size, total: total });
        }
      });
      if (rules.noReciprocal && total < 3) errors.push({ code: 'too-few-for-no-swap', total: total });
      if (errors.length === 0 && !hasPerfectMatching(buildAllowed(people, rules))) {
        errors.push({ code: 'no-solution' });
      }
    }
    return { ok: errors.length === 0, errors: errors, people: people, total: total };
  }

  /* ------------------------------------------------------------------ */
  /* Drawing                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Rejection sampling: random permutation, retry until every rule holds.
   * Result is EXACTLY uniform over all valid assignments.
   * Fisher–Yates finalises position i at step i, so we can bail out early.
   */
  function sampleUniform(n, allowed, noRecip, rand, maxTries) {
    const perm = new Array(n);
    for (let tries = 0; tries < maxTries; tries++) {
      for (let i = 0; i < n; i++) perm[i] = i;
      let ok = true;
      for (let i = n - 1; i >= 0; i--) {
        const j = rand(i + 1);
        const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
        if (!allowed[i][perm[i]]) { ok = false; break; }
      }
      if (!ok) continue;
      if (noRecip) {
        for (let i = 0; i < n; i++) if (perm[perm[i]] === i) { ok = false; break; }
        if (!ok) continue;
      }
      return perm.slice();
    }
    return null;
  }

  /** Same idea for one big loop: random order, each person gives to the next. Uniform over loops. */
  function sampleUniformLoop(n, allowed, rand, maxTries) {
    const order = new Array(n);
    for (let tries = 0; tries < maxTries; tries++) {
      for (let i = 0; i < n; i++) order[i] = i;
      let ok = true;
      for (let i = n - 1; i >= 0; i--) {
        const j = rand(i + 1);
        const t = order[i]; order[i] = order[j]; order[j] = t;
        if (i < n - 1 && !allowed[order[i]][order[i + 1]]) { ok = false; break; }
      }
      if (!ok || !allowed[order[n - 1]][order[0]]) continue;
      const assign = new Array(n);
      for (let i = 0; i < n; i++) assign[order[i]] = order[(i + 1) % n];
      return assign;
    }
    return null;
  }

  /** Fallback for very tight rules: randomised backtracking (most-constrained giver first). */
  function searchGeneral(n, allowed, noRecip, rand, maxNodes) {
    const assign = new Array(n).fill(-1);
    const taken = new Array(n).fill(false);
    const giverOrder = shuffle(range(n), rand);
    let nodes = 0;
    let aborted = false;

    function canGive(g, r) {
      return !taken[r] && allowed[g][r] && !(noRecip && assign[r] === g);
    }
    function rec(depth) {
      if (depth === n) return true;
      if (++nodes > maxNodes) { aborted = true; return false; }
      let best = -1;
      let bestC = null;
      for (let k = 0; k < n; k++) {
        const g = giverOrder[k];
        if (assign[g] !== -1) continue;
        const c = [];
        for (let r = 0; r < n; r++) if (canGive(g, r)) c.push(r);
        if (c.length === 0) return false;
        if (!bestC || c.length < bestC.length) { best = g; bestC = c; }
      }
      for (let r = 0; r < n; r++) { // every free receiver still needs a possible giver
        if (taken[r]) continue;
        let has = false;
        for (let g = 0; g < n && !has; g++) if (assign[g] === -1 && canGive(g, r)) has = true;
        if (!has) return false;
      }
      shuffle(bestC, rand);
      for (let k = 0; k < bestC.length; k++) {
        const r = bestC[k];
        assign[best] = r; taken[r] = true;
        if (rec(depth + 1)) return true;
        assign[best] = -1; taken[r] = false;
        if (aborted) return false;
      }
      return false;
    }
    const found = rec(0);
    return { assignment: found ? assign : null, exhausted: !aborted };
  }

  /** Fallback for one big loop: randomised Hamiltonian-cycle search. */
  function searchLoop(n, allowed, rand, maxNodes) {
    const start = randomStart(n, rand);
    const path = [start];
    const used = new Array(n).fill(false);
    used[start] = true;
    let nodes = 0;
    let aborted = false;

    function rec() {
      if (path.length === n) return allowed[path[n - 1]][start];
      if (++nodes > maxNodes) { aborted = true; return false; }
      const last = path[path.length - 1];
      const c = [];
      for (let r = 0; r < n; r++) if (!used[r] && allowed[last][r]) c.push(r);
      shuffle(c, rand);
      for (let k = 0; k < c.length; k++) {
        used[c[k]] = true; path.push(c[k]);
        if (rec()) return true;
        path.pop(); used[c[k]] = false;
        if (aborted) return false;
      }
      return false;
    }
    if (!rec()) return { assignment: null, exhausted: !aborted };
    const assign = new Array(n);
    for (let i = 0; i < n; i++) assign[path[i]] = path[(i + 1) % n];
    return { assignment: assign, exhausted: true };
  }

  function randomStart(n, rand) { return rand(n); }

  /**
   * Draw names.
   * Returns { assignment, method: 'uniform' | 'search' | null, exhausted }
   *   assignment === null means no valid draw exists (exhausted) or none was found in time.
   */
  function draw(people, rules, opts) {
    rules = rules || {};
    opts = opts || {};
    const n = people.length;
    const rand = opts.rand || randomInt;
    const fail = { assignment: null, method: null, exhausted: true };
    if (n < 2 || (rules.noReciprocal && n < 3)) return fail;

    const allowed = buildAllowed(people, rules);
    if (!hasPerfectMatching(allowed)) return fail;

    const maxTries = opts.maxTries != null ? opts.maxTries : 500000;
    const uniform = rules.singleLoop
      ? sampleUniformLoop(n, allowed, rand, maxTries)
      : sampleUniform(n, allowed, !!rules.noReciprocal, rand, maxTries);
    if (uniform) return { assignment: uniform, method: 'uniform', exhausted: true };

    const s = rules.singleLoop
      ? searchLoop(n, allowed, rand, opts.maxNodes || 300000)
      : searchGeneral(n, allowed, !!rules.noReciprocal, rand, opts.maxNodes || 100000);
    return { assignment: s.assignment, method: s.assignment ? 'search' : null, exhausted: s.exhausted };
  }

  /* ------------------------------------------------------------------ */
  /* Verification (admin check)                                          */
  /* ------------------------------------------------------------------ */
  function cycles(assignment) {
    const n = assignment.length;
    const seen = new Array(n).fill(false);
    const out = [];
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      const cyc = [];
      let x = s;
      while (x >= 0 && x < n && !seen[x]) { seen[x] = true; cyc.push(x); x = assignment[x]; }
      out.push(cyc);
    }
    return out;
  }

  /**
   * Independently re-check a finished draw against every rule.
   * Returns { ok, checks: [{ id, ok, problems: [...] }] }
   *   ids: everyone-gives, everyone-receives, no-self, no-family, no-swap*, single-loop*, exclusions*
   */
  function verify(people, assignment, rules) {
    rules = rules || {};
    const n = people.length;
    const checks = [];
    function add(id, problems) { checks.push({ id: id, ok: problems.length === 0, problems: problems }); }

    const gives = [];
    if (!Array.isArray(assignment) || assignment.length !== n) {
      gives.push({ type: 'length' });
    } else {
      for (let g = 0; g < n; g++) {
        const r = assignment[g];
        if (!Number.isInteger(r) || r < 0 || r >= n) gives.push({ giver: g });
      }
    }
    add('everyone-gives', gives);
    if (gives.length) return { ok: false, checks: checks };

    const count = new Array(n).fill(0);
    for (let g = 0; g < n; g++) count[assignment[g]]++;
    const recv = [];
    for (let r = 0; r < n; r++) if (count[r] !== 1) recv.push({ person: r, count: count[r] });
    add('everyone-receives', recv);

    const self = [];
    const fam = [];
    for (let g = 0; g < n; g++) {
      const r = assignment[g];
      if (r === g) self.push({ giver: g, receiver: r });
      else if (people[g].family === people[r].family) fam.push({ giver: g, receiver: r });
    }
    add('no-self', self);
    add('no-family', fam);

    if (rules.noReciprocal) {
      const swaps = [];
      for (let g = 0; g < n; g++) {
        const r = assignment[g];
        if (r !== g && g < r && assignment[r] === g) swaps.push({ giver: g, receiver: r });
      }
      add('no-swap', swaps);
    }
    if (rules.singleLoop) {
      const c = cycles(assignment).length;
      add('single-loop', c === 1 ? [] : [{ count: c }]);
    }
    const ex = rules.exclusions || [];
    if (ex.length) {
      const idx = {};
      people.forEach(function (p, i) { idx[normName(p.name)] = i; });
      const bad = [];
      ex.forEach(function (pair) {
        const a = idx[normName(pair[0])];
        const b = idx[normName(pair[1])];
        if (a !== undefined && b !== undefined && assignment[a] === b) bad.push({ giver: a, receiver: b });
      });
      add('exclusions', bad);
    }
    return { ok: checks.every(function (c) { return c.ok; }), checks: checks };
  }

  /* ------------------------------------------------------------------ */
  /* Share links: obfuscated + checksummed payload (base64url)           */
  /* Not encryption — it just keeps names unreadable in the URL.         */
  /* ------------------------------------------------------------------ */
  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const bin = unescape(encodeURIComponent(str));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(bin));
  }
  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function keystream(seed) {
    let x = (seed >>> 0) || 0x9e3779b9;
    return function () {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      return x & 0xff;
    };
  }
  function toBase64Url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromBase64Url(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function writeU32(buf, off, v) {
    buf[off] = (v >>> 24) & 0xff; buf[off + 1] = (v >>> 16) & 0xff;
    buf[off + 2] = (v >>> 8) & 0xff; buf[off + 3] = v & 0xff;
  }
  function readU32(buf, off) {
    return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
  }

  const SHARE_VERSION = 1;

  function encodeShare(obj) {
    const plain = utf8Encode(JSON.stringify(obj));
    const salt = nextUint32();
    const ks = keystream(salt);
    const out = new Uint8Array(1 + 4 + plain.length + 4);
    out[0] = SHARE_VERSION;
    writeU32(out, 1, salt);
    for (let i = 0; i < plain.length; i++) out[5 + i] = plain[i] ^ ks();
    writeU32(out, 5 + plain.length, fnv1a(plain));
    return toBase64Url(out);
  }

  /** Returns the decoded object, or null if the code is damaged / not ours. */
  function decodeShare(code) {
    try {
      if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
      const buf = fromBase64Url(code);
      if (buf.length < 10 || buf[0] !== SHARE_VERSION) return null;
      const ks = keystream(readU32(buf, 1));
      const plain = new Uint8Array(buf.length - 9);
      for (let i = 0; i < plain.length; i++) plain[i] = buf[5 + i] ^ ks();
      if (fnv1a(plain) !== readU32(buf, buf.length - 4)) return null;
      return JSON.parse(utf8Decode(plain));
    } catch (e) {
      return null;
    }
  }

  /** Pull the share code out of any URL form: #d=..., ?d=..., even with junk appended by chat apps. */
  function extractShareCode(href) {
    const m = /[#?&]d=([A-Za-z0-9_-]+)/.exec(String(href || ''));
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------------------ */
  /* Misc                                                                */
  /* ------------------------------------------------------------------ */
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  /** Admin PIN is stored only as a salted hash (a speed bump for family members, not real security). */
  function hashPin(pin, salt) {
    return cyrb53(String(salt || '') + '|' + String(pin == null ? '' : pin).trim(), 7).toString(36);
  }

  function newId() {
    return nextUint32().toString(36) + nextUint32().toString(36);
  }

  return {
    randomInt: randomInt,
    shuffle: shuffle,
    normName: normName,
    parseNames: parseNames,
    flatten: flatten,
    buildAllowed: buildAllowed,
    hasPerfectMatching: hasPerfectMatching,
    validate: validate,
    draw: draw,
    verify: verify,
    cycles: cycles,
    encodeShare: encodeShare,
    decodeShare: decodeShare,
    extractShareCode: extractShareCode,
    hashPin: hashPin,
    newId: newId
  };
});
