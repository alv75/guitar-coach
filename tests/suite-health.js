'use strict';
// Guitar Health Check: synthetic tests of the measurement and decision logic in health-core.
const assert = require('assert');
const synth = require('./synth');

const SR = 48000;
const COND = 'di';                         // iRig-style direct input
const GATE = -50;

function pluck(midi, cents, seed, extra) {
  return synth.renderPluck(midi, cents, Object.assign({ sr: SR, seed: seed, condition: COND, duration: 2.0, onset: 0.2 }, extra || {}));
}

function measure(H, midi, cents, seed, extra) {
  return H.analyzeNote(pluck(midi, cents, seed, extra), SR, GATE, midi);
}

// Pitch accuracy of the steady-state measurement across the neck (what intonation/nut/drift rely on).
function pitchAccuracy(H) {
  const errs = [];
  let seed = 1;
  synth.OPEN_STRINGS.forEach(function (open) {
    [0, 1, 5, 12].forEach(function (fret) {
      const truth = (seed * 7.3) % 20 - 10;   // -10..+10 cents
      const m = measure(H, open + fret, truth, seed++);
      errs.push(m.found ? Math.abs(m.cents - truth) : Infinity);
    });
  });
  errs.sort(function (a, b) { return a - b; });
  return { n: errs.length, median: errs[Math.floor(errs.length / 2)], p95: errs[Math.floor(errs.length * 0.95)], max: errs[errs.length - 1] };
}

function intonationCases(H) {
  // open string tuned +3 c; 12th fret at +3 + offset
  return [-12, -6, -3, 0, 4, 8, 15].map(function (offset, i) {
    const s = i % 6, open = synth.OPEN_STRINGS[s];
    const ref = measure(H, open, 3, 100 + i);
    const fr = measure(H, open + 12, 3 + offset, 200 + i);
    const r = H.intonation(s, ref, fr, 'open');
    return { truth: offset, measured: r.offsetCents, status: r.status };
  });
}

// Fret sweep with planted problems. Buzz is marked by the player; the test checks that buzzing notes still
// measure correctly and that dead/undetected detection is not disturbed by buzz.
function sweepCase(H, buzzAmount, seedBase) {
  const plantedBuzz = { '0:3': 1, '2:7': 1, '4:10': 1 };     // string:fret
  const plantedDead = { '1:5': 1, '3:9': 1 };
  const grid = synth.OPEN_STRINGS.map(function (open, s) {
    const row = [];
    for (let f = 1; f <= 12; f++) {
      const key = s + ':' + f;
      const m = measure(H, open + f, 0, seedBase + s * 20 + f, {
        buzz: plantedBuzz[key] ? buzzAmount : 0, tauScale: plantedDead[key] ? 0.2 : 1, amp: 0.6 + 0.4 * ((s * 13 + f * 7) % 10) / 10
      });
      row.push(Object.assign({}, m, { userBuzz: !!plantedBuzz[key] }));   // the player marks buzz by ear
    }
    return row;
  });
  const res = H.sweep(grid);
  let buzzHit = 0, buzzFalse = 0, deadHit = 0, deadFalse = 0, undetected = 0;
  res.cells.forEach(function (row, s) {
    row.forEach(function (c, f) {
      const key = s + ':' + (f + 1);
      if (c.status === 'buzz') { if (plantedBuzz[key]) buzzHit++; else buzzFalse++; }
      if (c.status === 'dead') { if (plantedDead[key]) deadHit++; else deadFalse++; }
      if (c.status === 'undetected') undetected++;
    });
  });
  return { buzzAmount: buzzAmount, buzzHit: buzzHit, buzzFalse: buzzFalse, deadHit: deadHit, deadFalse: deadFalse, undetected: undetected, findings: res.findings };
}

function logicChecks(H, check) {
  const run = function (label, fn) {
    try { fn(); check(label, true); } catch (e) { check(label + ' -> ' + e.message, false); }
  };
  run('intonation advice: sharp -> saddle away from neck', function () {
    const r = H.intonation(0, { freq: 100, spreadCents: 1 }, { freq: 200 * Math.pow(2, 10 / 1200), spreadCents: 1 }, 'open');
    assert.strictEqual(r.status, 'sharp'); assert.ok(/AWAY from the neck/.test(r.advice));
  });
  run('intonation advice: flat -> saddle toward neck', function () {
    const r = H.intonation(0, { freq: 100, spreadCents: 1 }, { freq: 200 * Math.pow(2, -10 / 1200), spreadCents: 1 }, 'open');
    assert.strictEqual(r.status, 'flat'); assert.ok(/TOWARD the neck/.test(r.advice));
  });
  run('intonation with 12th-fret harmonic reference', function () {
    const r = H.intonation(0, { freq: 200, spreadCents: 1 }, { freq: 200, spreadCents: 1 }, 'harmonic');
    assert.strictEqual(r.status, 'ok');
  });
  run('nut: consistently sharp 1st fret -> LUTHIER', function () {
    const rows = [0, 1, 2, 3, 4, 5].map(function () { return { open: { freq: 100, spreadCents: 1 }, fret1: { freq: 100 * Math.pow(2, 112 / 1200), spreadCents: 1 } }; });
    const f = H.nut(rows).findings[0];
    assert.strictEqual(f.who, 'LUTHIER'); assert.strictEqual(f.severity, 'major');
  });
  run('nut: in tune -> ok', function () {
    const rows = [0, 1, 2, 3, 4, 5].map(function () { return { open: { freq: 100, spreadCents: 1 }, fret1: { freq: 100 * Math.pow(2, 102 / 1200), spreadCents: 1 } }; });
    assert.strictEqual(H.nut(rows).findings[0].severity, 'ok');
  });
  run('stability: one string -7 c flagged, drift computed', function () {
    const b = [0, 1, 2, 3, 4, 5].map(function () { return { found: true, freq: 100 }; });
    const a = b.map(function (x, i) { return { found: true, freq: i === 2 ? 100 * Math.pow(2, -7 / 1200) : 100 }; });
    const r = H.stability(b, a, 10);
    assert.ok(Math.abs(r.rows[2].driftCents + 7) < 1e-6); assert.strictEqual(r.findings[0].severity, 'minor');
  });
  run('pressure: fretted +12 c -> technique finding (DIY)', function () {
    const r = H.pressure([{ fretted: true, m: { found: true, cents: 12 } }, { fretted: true, m: { found: true, cents: 11 } }, { fretted: false, m: { found: true, cents: 0 } }]);
    assert.strictEqual(r.findings[0].who, 'DIY'); assert.strictEqual(r.findings[0].severity, 'minor');
  });
  run('pressure: open-string tuning offset is removed', function () {
    const r = H.pressure([{ fretted: true, m: { found: true, cents: 12 } }, { fretted: true, m: { found: true, cents: 12 } }],
      [{ found: true, cents: 10 }, { found: true, cents: 10 }]);
    assert.strictEqual(r.findings[0].severity, 'ok');
  });
  run('balance: -9 dB string flagged, confidence low', function () {
    const r = H.balance([-20, -21, -19, -29, -20, -20]);
    assert.strictEqual(r.findings[0].confidence, 'low'); assert.ok(/G/.test(r.findings[0].title));
  });
  run('manual: high relief + old strings', function () {
    const f = H.manual({ reliefMm: '0.6', stringAgeWeeks: '20', actionBassMm: '1.8' });
    assert.ok(f.some(function (x) { return /relief high/i.test(x.title); }));
    assert.ok(f.some(function (x) { return /weeks old/.test(x.title) && x.severity === 'minor'; }));
    assert.ok(f.some(function (x) { return /low E/.test(x.title) && x.severity === 'ok'; }));
  });
  run('markdown report: all sections, grid as text, DIY/LUTHIER tags, diff vs previous', function () {
    const note = function (cents, extra) { return Object.assign({ found: true, matches: true, freq: 100 * Math.pow(2, cents / 1200), cents: cents, spreadCents: 1, decaySec: 2, decayCapped: true }, extra || {}); };
    const sweepRow = function () { return new Array(12).fill(null); };
    const sweep = [0, 1, 2, 3, 4, 5].map(sweepRow);
    sweep[0] = sweep[0].map(function (_, f) { return f < 4 ? note(1, { userBuzz: f === 1 }) : f === 4 ? { skipped: true } : null; });
    const raw = {
      manual: { guitar: 'Test LP', stringAgeWeeks: '20', reliefMm: '0.3' },
      intonation: [{ ref: note(0), fretted: note(9), refKind: 'open' }, null, null, null, null, null],
      nut: [0, 1, 2, 3, 4, 5].map(function () { return { open: note(0), fret1: note(12) }; }),
      sweep: sweep,
      stability: { before: [0, 1, 2, 3, 4, 5].map(function () { return note(0); }), beforeAt: 0,
        after: [0, 1, 2, 3, 4, 5].map(function (i) { return note(i === 2 ? -7 : 0); }), afterAt: 600000 },
      pressure: { chord: 'C', notes: [null, null, null, null, null, null] },
      balance: [-20, -21, -19, -29, -20, -20]
    };
    const report = {
      intonation: raw.intonation.map(function (x, s) { return x ? H.intonation(s, x.ref, x.fretted, x.refKind) : null; }),
      nut: H.nut(raw.nut), sweep: H.sweep(raw.sweep), stability: H.stability(raw.stability.before, raw.stability.after, 10),
      balance: H.balance(raw.balance), manual: raw.manual
    };
    const entry = { date: '2026-11-06T21:30:00.000Z', meta: { input: 'iRig HD 2', sampleRate: 48000 }, raw: raw, report: report, findings: H.summarize(report) };
    const prev = { date: '2026-10-01T10:00:00.000Z', report: { manual: { reliefMm: '0.5' } } };
    const md = H.reportMarkdown(entry, prev);
    ['# Guitar Health Check - 2026-11-06', 'Guitar: Test LP', 'Strings: 20 weeks old', 'Input: iRig HD 2 @ 48000 Hz',
      '## Findings', '[LUTHIER]', '[DIY]', 'confidence]', '## Intonation', '## Nut', '## Fret sweep', '## Tuning stability',
      '## String balance', '## Diff vs previous run (2026-10-01)', '| reliefMm | 0.5 | 0.3 | -0.2 |'].forEach(function (t) {
      assert.ok(md.indexOf(t) >= 0, 'missing: ' + t);
    });
    assert.ok(/E6 +\. +B +\. +\. +-/.test(md), 'sweep status row for low E');
  });
  run('summary sorts major before minor before ok; compare lists keys', function () {
    const rep = { manual: { reliefMm: '0.6', stringAgeWeeks: '2' } };
    const s = H.summarize(rep);
    assert.ok(s[0].severity !== 'ok' && s[s.length - 1].severity === 'ok');
    const c = H.compare(rep, { manual: { reliefMm: '0.3' } });
    const rel = c.find(function (x) { return x.key === 'reliefMm'; });
    assert.strictEqual(rel.before, 0.6); assert.strictEqual(rel.after, 0.3);
  });
}

module.exports = { pitchAccuracy, intonationCases, sweepCase, logicChecks };
