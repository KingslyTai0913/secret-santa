// Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../santa-core.js');

/* ---------- helpers ---------- */
function makeFamilies(sizes) {
  return sizes.map((size, fi) => ({
    name: 'F' + fi,
    members: Array.from({ length: size }, (_, i) => `F${fi}-P${i}`)
  }));
}
function seeded(seed) { // deterministic PRNG for reproducible stress tests (mulberry32)
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (n) => Math.floor(next() * n);
}
function* permutations(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  function* rec(k) {
    if (k === n) { yield a.slice(); return; }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i], a[k]];
      yield* rec(k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  }
  yield* rec(0);
}
function assertValid(people, assignment, rules, msg) {
  const v = S.verify(people, assignment, rules);
  assert.ok(v.ok, (msg || '') + ' ' + JSON.stringify(v.checks.filter((c) => !c.ok)));
}
/** chi-square goodness of fit vs. uniform; generous bound so the test is not flaky */
function assertRoughlyUniform(counts, draws) {
  const k = counts.length;
  const expected = draws / k;
  const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  const bound = (k - 1) + 6 * Math.sqrt(2 * (k - 1));
  assert.ok(chi2 < bound, `chi2=${chi2.toFixed(1)} bound=${bound.toFixed(1)} k=${k}`);
  assert.ok(Math.min(...counts) > 0, 'every valid outcome should appear');
}

/* ---------- parsing & validation ---------- */
test('parseNames splits on newline / commas / 、 but keeps spaces inside names', () => {
  assert.deepEqual(S.parseNames('小明，小红、 John Smith\n\nAmy;Bob , '), ['小明', '小红', 'John Smith', 'Amy', 'Bob']);
  assert.deepEqual(S.parseNames('   '), []);
});

test('validate: five families of different sizes is fine', () => {
  const v = S.validate(makeFamilies([1, 2, 3, 4, 5]), { noReciprocal: true });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.total, 15);
});

test('validate: duplicate names (case/space-insensitive, across families)', () => {
  const fams = [{ name: 'A', members: ['Amy', 'Bob'] }, { name: 'B', members: ['amy ', 'Cat'] }];
  const v = S.validate(fams, {});
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors.map((e) => e.code), ['duplicate']);
});

test('validate: a family with more than half of everyone is impossible', () => {
  const v = S.validate(makeFamilies([4, 1, 1]), {});
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, 'family-too-big');
  assert.equal(v.errors[0].size, 4);
  assert.equal(S.validate(makeFamilies([3, 1, 1, 1]), {}).ok, true, 'exactly half is still possible');
});

test('validate: too few people / families / no-swap with 2 people', () => {
  assert.equal(S.validate(makeFamilies([1]), {}).errors[0].code, 'too-few-people');
  assert.equal(S.validate(makeFamilies([3, 0, 0]), {}).errors[0].code, 'too-few-families');
  assert.equal(S.validate(makeFamilies([1, 1]), { noReciprocal: true }).errors[0].code, 'too-few-for-no-swap');
  assert.equal(S.validate(makeFamilies([1, 1]), {}).ok, true);
});

test('validate: exclusions that make it impossible are caught before drawing', () => {
  // F0-P0 can only give to F1-P0 or F2-P0; exclude both
  const fams = makeFamilies([2, 1, 1]);
  const rules = { exclusions: [['F0-P0', 'F1-P0'], ['F0-P0', 'F2-P0']] };
  assert.equal(S.validate(fams, rules).errors[0].code, 'no-solution');
});

/* ---------- drawing: correctness ---------- */
test('draw: stress test — every result obeys every rule (2000+ random setups)', () => {
  const rand = seeded(12345);
  let drawn = 0;
  for (let trial = 0; trial < 700; trial++) {
    const famCount = 2 + rand(6);
    const sizes = Array.from({ length: famCount }, () => 1 + rand(7));
    const fams = makeFamilies(sizes);
    const people = S.flatten(fams);
    const rules = { noReciprocal: rand(2) === 1, singleLoop: rand(3) === 0, exclusions: [] };
    for (let e = rand(3); e > 0; e--) {
      const a = people[rand(people.length)].name;
      const b = people[rand(people.length)].name;
      if (a !== b) rules.exclusions.push([a, b]);
    }
    if (!S.validate(fams, rules).ok) continue;
    for (let k = 0; k < 4; k++) {
      const res = S.draw(people, rules);
      if (res.assignment === null) {
        // only acceptable if the extra rules really make it impossible
        assert.ok(rules.singleLoop || rules.exclusions.length, `no draw for ${JSON.stringify(sizes)}`);
        continue;
      }
      assertValid(people, res.assignment, rules, JSON.stringify({ sizes, rules }));
      drawn++;
    }
  }
  assert.ok(drawn > 1500, `drew ${drawn}`);
});

test('draw: the search fallback also produces valid results', () => {
  for (const sizes of [[1, 2, 3, 4, 5], [3, 3], [5, 2, 2, 1], [2, 2, 2, 2, 2]]) {
    const people = S.flatten(makeFamilies(sizes));
    for (const rules of [{}, { noReciprocal: true }, { singleLoop: true }]) {
      for (let k = 0; k < 50; k++) {
        const res = S.draw(people, rules, { maxTries: 0 });
        assert.equal(res.method, 'search');
        assertValid(people, res.assignment, rules, JSON.stringify({ sizes, rules }));
      }
    }
  }
});

test('draw: impossible setups return null instead of a bad result', () => {
  assert.equal(S.draw(S.flatten(makeFamilies([3, 1])), {}).assignment, null);
  assert.equal(S.draw(S.flatten(makeFamilies([1, 1])), { noReciprocal: true }).assignment, null);
  // 2 people in different families, one excluded from the other
  const people = S.flatten(makeFamilies([1, 1]));
  assert.equal(S.draw(people, { exclusions: [['F0-P0', 'F1-P0']] }).assignment, null);
});

test('draw: [1,1] without no-swap rule gives the only possible answer', () => {
  const res = S.draw(S.flatten(makeFamilies([1, 1])), {});
  assert.deepEqual(res.assignment, [1, 0]);
});

/* ---------- drawing: fairness ---------- */
test('draw: every valid assignment is equally likely (uniform)', () => {
  const fams = makeFamilies([2, 2, 1]);
  const people = S.flatten(fams);
  const rules = {};
  const valid = [...permutations(people.length)].filter((p) => S.verify(people, p, rules).ok);
  const index = new Map(valid.map((p, i) => [p.join(','), i]));
  const counts = new Array(valid.length).fill(0);
  const N = 40000;
  for (let i = 0; i < N; i++) counts[index.get(S.draw(people, rules).assignment.join(','))]++;
  assertRoughlyUniform(counts, N);
});

test('draw: uniform with the no-swap rule too', () => {
  const people = S.flatten(makeFamilies([2, 2, 2]));
  const rules = { noReciprocal: true };
  const valid = [...permutations(people.length)].filter((p) => S.verify(people, p, rules).ok);
  const index = new Map(valid.map((p, i) => [p.join(','), i]));
  const counts = new Array(valid.length).fill(0);
  const N = 60000;
  for (let i = 0; i < N; i++) counts[index.get(S.draw(people, rules).assignment.join(','))]++;
  assertRoughlyUniform(counts, N);
});

test('draw: one-big-loop mode is uniform over all valid loops', () => {
  const people = S.flatten(makeFamilies([2, 1, 1, 1]));
  const rules = { singleLoop: true };
  const valid = [...permutations(people.length)].filter((p) => S.verify(people, p, rules).ok);
  const index = new Map(valid.map((p, i) => [p.join(','), i]));
  const counts = new Array(valid.length).fill(0);
  const N = 30000;
  for (let i = 0; i < N; i++) counts[index.get(S.draw(people, rules).assignment.join(','))]++;
  assertRoughlyUniform(counts, N);
});

test('draw: fast enough for big families', () => {
  const t0 = Date.now();
  const people = S.flatten(makeFamilies([3, 4, 5, 6, 7]));
  for (let i = 0; i < 500; i++) {
    assertValid(people, S.draw(people, { noReciprocal: true }).assignment, { noReciprocal: true });
  }
  const tight = S.flatten(makeFamilies([10, 10])); // only cross-family swaps possible: worst case
  assertValid(tight, S.draw(tight, { noReciprocal: true }).assignment, { noReciprocal: true });
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0}ms`);
});

/* ---------- verification ---------- */
test('verify: catches every kind of mistake', () => {
  const people = S.flatten(makeFamilies([2, 1, 1])); // F0-P0, F0-P1, F1-P0, F2-P0
  const failed = (a, rules) => S.verify(people, a, rules || {}).checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(failed([2, 3, 0, 1]), []);
  assert.deepEqual(failed([1, 0, 3, 2]), ['no-family']);
  assert.deepEqual(failed([0, 2, 3, 1]), ['no-self']);
  assert.deepEqual(failed([2, 2, 3, 0]), ['everyone-receives']);
  assert.deepEqual(failed([2, 3, 0]), ['everyone-gives']);
  assert.deepEqual(failed([2, 3, 0, 1], { noReciprocal: true }), ['no-swap']);
  assert.deepEqual(failed([2, 3, 0, 1], { singleLoop: true }), ['single-loop']);
  assert.deepEqual(failed([2, 3, 0, 1], { exclusions: [['F0-P0', 'f1-p0']] }), ['exclusions']);
});

test('cycles: splits an assignment into gift loops', () => {
  assert.deepEqual(S.cycles([1, 2, 0, 4, 3]), [[0, 1, 2], [3, 4]]);
});

/* ---------- share links ---------- */
test('share code: round trip with Chinese & emoji, and names are not readable', () => {
  const obj = { e: { n: '2026 圣诞交换礼物 🎄' }, f: [['王家', ['小明', 'Amy']]], a: [1, 0] };
  const code = S.encodeShare(obj);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(S.decodeShare(code), obj);
  assert.ok(!code.includes('Amy') && !Buffer.from(code, 'base64').toString('utf8').includes('Amy'));
  assert.notEqual(S.encodeShare(obj), code, 'random salt each time');
});

test('share code: damaged codes are rejected', () => {
  const code = S.encodeShare({ hello: 'world' });
  const flipped = code.slice(0, 10) + (code[10] === 'A' ? 'B' : 'A') + code.slice(11);
  assert.equal(S.decodeShare(flipped), null);
  assert.equal(S.decodeShare(code.slice(0, -3)), null);
  assert.equal(S.decodeShare(''), null);
  assert.equal(S.decodeShare('not a code!'), null);
});

test('extractShareCode: works with #, ? and junk appended by chat apps', () => {
  assert.equal(S.extractShareCode('https://x.github.io/santa/#d=AbC-_9'), 'AbC-_9');
  assert.equal(S.extractShareCode('https://x.github.io/santa/?d=AbC-_9&from=singlemessage'), 'AbC-_9');
  assert.equal(S.extractShareCode('https://x.github.io/santa/#d=AbC-_9?from=singlemessage&isappinstalled=0'), 'AbC-_9');
  assert.equal(S.extractShareCode('https://x.github.io/santa/'), null);
});

test('hashPin: stable, depends on pin and salt, ignores surrounding spaces', () => {
  assert.equal(S.hashPin('1234', 's'), S.hashPin(' 1234 ', 's'));
  assert.notEqual(S.hashPin('1234', 's'), S.hashPin('1235', 's'));
  assert.notEqual(S.hashPin('1234', 's'), S.hashPin('1234', 't'));
});
