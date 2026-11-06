'use strict';
// Usage: node tests/run-tests.js [--quick] [--fft=16384] [--sr=48000] [--real-only] [--health-only]
const assert = require('assert');
const { loadDsp, loadHealth } = require('./load-dsp');
const healthSuite = require('./suite-health');
const { readWav } = require('./wav');
const notes = require('./suite-notes');
const chords = require('./suite-chords');
const { runReal } = require('./suite-real');

const args = process.argv.slice(2);
const argVal = function (name, def) {
  const a = args.find(function (x) { return x.indexOf('--' + name + '=') === 0; });
  return a ? Number(a.split('=')[1]) : def;
};
const QUICK = args.indexOf('--quick') >= 0;
const REAL_ONLY = args.indexOf('--real-only') >= 0;
const HEALTH_ONLY = args.indexOf('--health-only') >= 0;
const SR = argVal('sr', 48000);
const CONDITIONS = ['clean', 'room', 'harsh', 'di'];
const TARGETS = { note: 0.98, chord: 0.90 }; // on the 'room' condition (20 dB SNR)

const dsp = loadDsp();
const FFT = argVal('fft', undefined) || dsp.fftSizeFor(SR);
let failures = 0;

// ---------- formatting helpers ----------
const pct = function (x) { return (100 * x).toFixed(1) + '%'; };
const ms = function (s) { return s === null || s === undefined ? '  -  ' : Math.round(s * 1000) + ' ms'; };
function quantile(arr, q) {
  if (!arr.length) return null;
  const s = arr.slice().sort(function (a, b) { return a - b; });
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function row(cells, widths) { return cells.map(function (c, i) { return String(c).padEnd(widths[i]); }).join(''); }
function heading(t) { console.log('\n=== ' + t + ' ' + '='.repeat(Math.max(0, 70 - t.length))); }
function check(label, ok) { console.log((ok ? '  PASS ' : '  FAIL ') + label); if (!ok) failures++; }

// ---------- unit checks ----------
function unitChecks() {
  heading('Unit checks');
  const run = function (label, fn) {
    try { fn(); check(label, true); } catch (e) { check(label + ' -> ' + e.message, false); }
  };
  run('freqToNote(440) = A4, 0 cents', function () {
    const n = dsp.freqToNote(440); assert.strictEqual(n.name, 'A4'); assert.ok(Math.abs(n.cents) < 1e-9);
  });
  run('freqToNote(82.41) = E2', function () { assert.strictEqual(dsp.freqToNote(82.41).name, 'E2'); });
  run('parseNoteName round trip E2..E6', function () {
    for (let m = 40; m <= 88; m++) assert.strictEqual(dsp.parseNoteName(dsp.noteName(m)), m);
  });
  run('nearestString(196.5) = G3, ~+4 cents', function () {
    const s = dsp.nearestString(196.5); assert.strictEqual(s.string.name, 'G3'); assert.ok(Math.abs(s.cents - 4.4) < 0.5);
  });
  run('rate helpers: FFT 16384 at 44.1/48 kHz, 32768 at 96 kHz; hop ~21 ms', function () {
    assert.strictEqual(dsp.fftSizeFor(44100), 16384); assert.strictEqual(dsp.fftSizeFor(48000), 16384);
    assert.strictEqual(dsp.fftSizeFor(96000), 32768);
    assert.strictEqual(dsp.hopFor(48000), 1022); assert.ok(Math.abs(dsp.hopFor(44100) / 44100 - 0.0213) < 0.0005);
  });
  run('YIN at 96 kHz still finds 82 Hz (window scales with the rate)', function () {
    const sr = 96000;
    const x = new Float32Array(dsp.yinSpanFor(sr) + 100).map(function (_, i) { return Math.sin(2 * Math.PI * 82.41 * i / sr); });
    assert.ok(Math.abs(dsp.freqToNote(dsp.yin(x, sr).freq).cents) < 1);
  });
  run('36 templates; library of 11', function () {
    assert.strictEqual(dsp.ALL_CHORDS.length, 36); assert.strictEqual(dsp.LIBRARY.length, 11);
  });
  run('YIN on pure 110 Hz sine within 1 cent', function () {
    const x = new Float32Array(8192).map(function (_, i) { return Math.sin(2 * Math.PI * 110 * i / SR); });
    assert.ok(Math.abs(dsp.freqToNote(dsp.yin(x, SR).freq).cents) < 1);
  });
  run('YIN returns null on silence', function () { assert.strictEqual(dsp.yin(new Float32Array(8192), SR), null); });
  run('tracker confirms only after stable time', function () {
    let s = dsp.initTracker();
    s = dsp.stepTracker(s, 'A', 0.0, 0.3, false);
    s = dsp.stepTracker(s, 'A', 0.2, 0.3, false); assert.strictEqual(s.confirmed, null);
    s = dsp.stepTracker(s, 'A', 0.3, 0.3, false); assert.strictEqual(s.event, 'confirm');
    s = dsp.stepTracker(s, 'A', 0.4, 0.3, false); assert.strictEqual(s.event, null);
  });
  run('tracker does not mutate previous state', function () {
    const s0 = dsp.initTracker(); dsp.stepTracker(s0, 'A', 0, 0.3, false); assert.strictEqual(s0.candidate, null);
  });
  run('verifyChord requires rank 1 and margin', function () {
    const ranked = [{ id: 'C', score: 0.9 }, { id: 'Am', score: 0.88 }];
    assert.strictEqual(dsp.verifyChord(ranked, 'C', 0.01).pass, true);
    assert.strictEqual(dsp.verifyChord(ranked, 'C', 0.05).pass, false);
    assert.strictEqual(dsp.verifyChord(ranked, 'Am', 0.0).pass, false);
  });
  run('WAV encode -> decode round trip', function () {
    const x = new Float32Array(1000).map(function (_, i) { return 0.5 * Math.sin(i / 10); });
    const w = readWav(Buffer.from(dsp.encodeWav(x, 44100)));
    assert.strictEqual(w.sampleRate, 44100); assert.strictEqual(w.samples.length, 1000);
    assert.ok(Math.abs(w.samples[123] - x[123]) < 1e-4);
  });
}

// ---------- reports ----------
function reportNotes() {
  heading('Single notes E2-E6 (49 notes, detune +-30 c, ' + SR + ' Hz)');
  const r = notes.runNotes(dsp, { sr: SR, trials: QUICK ? 1 : 4, conditions: CONDITIONS });
  const w = [8, 8, 9, 9, 8, 13, 13, 12];
  console.log(row(['cond', 'n', 'correct', 'octave', 'none', 'cents|err|', 'cents p95', 'latency p50/p90'], w));
  CONDITIONS.forEach(function (c) {
    const t = r.results[c].total;
    const mean = t.cents.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, t.cents.length);
    console.log(row([c, t.n, pct(t.correct / t.n), pct(t.octave / t.n), pct(t.none / t.n), mean.toFixed(1),
      (quantile(t.cents, 0.95) || 0).toFixed(1), ms(quantile(t.latency, 0.5)) + ' / ' + ms(quantile(t.latency, 0.9))], w));
  });
  console.log('\n  by register (correct %):  ' + r.bands.map(function (b) { return b.name.padEnd(8); }).join(''));
  CONDITIONS.forEach(function (c) {
    console.log('  ' + c.padEnd(24) + r.results[c].bands.map(function (b) { return pct(b.correct / b.n).padEnd(8); }).join(''));
  });
  if (r.errors.length) console.log('  sample errors: ' + r.errors.join('; '));
  const room = r.results.room.total;
  check('note accuracy on "room" >= ' + pct(TARGETS.note), room.correct / room.n >= TARGETS.note);
}

function reportSequences() {
  heading('Pentatonic box 1 up+down (23 notes), previous notes ringing');
  const r = notes.runSequences(dsp, { sr: SR, trials: QUICK ? 2 : 5, conditions: CONDITIONS, bpms: [60, 90, 120] });
  const w = [8, 6, 12, 10, 14, 16];
  console.log(row(['cond', 'bpm', 'clean runs', 'hit rate', 'wrong/run', 'latency p50/p90'], w));
  r.forEach(function (s) {
    console.log(row([s.cond, s.bpm, s.clean + '/' + s.runs, pct(s.hitRate), s.wrongPerRun.toFixed(2),
      ms(quantile(s.latency, 0.5)) + ' / ' + ms(quantile(s.latency, 0.9))], w));
  });
}

function reportChords() {
  heading('Chords: 11 library voicings, strummed (FFT ' + FFT + ', ' + SR + ' Hz)');
  const cases = chords.buildChordCases(dsp, { sr: SR, trials: QUICK ? 4 : 12, conditions: CONDITIONS, fftSize: FFT });

  console.log('\n  Verify-margin sweep (all conditions pooled). truePass = first confirmed chord is the one played;');
  console.log('  falsePass = while chord X rings, the app would accept a different expected chord Y.');
  const sweep = chords.sweepMargins(dsp, cases, [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10]);
  const ws = [10, 11, 12, 9, 11];
  console.log('  ' + row(['margin', 'truePass', 'wrongFirst', 'none', 'falsePass'], ws));
  sweep.forEach(function (s) {
    const mark = Math.abs(s.margin - dsp.CONFIG.verifyMargin) < 1e-9 ? '  <- configured' : '';
    console.log('  ' + row([s.margin.toFixed(2), pct(s.truePass), pct(s.wrongFirst), pct(s.none), pct(s.falsePass)], ws) + mark);
  });

  const v = chords.evaluate(dsp, cases, 'verify');
  const id = chords.evaluate(dsp, cases, 'identify');
  console.log('\n  Per chord, verify mode (11 library, margin ' + dsp.CONFIG.verifyMargin + '): correct % [most common wrong]');
  console.log('  ' + row(['chord'].concat(CONDITIONS), [8, 22, 22, 22]));
  dsp.LIBRARY.forEach(function (ch) {
    const cells = CONDITIONS.map(function (c) {
      const s = v.per[c + '|' + ch];
      const wrongs = Object.keys(s.got).filter(function (k) { return k !== ch; }).sort(function (a, b) { return s.got[b] - s.got[a]; });
      return pct(s.correct / s.n) + (wrongs.length ? ' [' + wrongs[0] + ']' : '') + (s.none ? ' none:' + s.none : '');
    });
    console.log('  ' + row([ch].concat(cells), [8, 22, 22, 22]));
  });
  const w = [8, 12, 12, 10, 12, 16, 16];
  console.log('\n  ' + row(['cond', 'verify', 'wrong', 'none', 'identify36', 'frame top-1', 'latency p50/p90'], w));
  CONDITIONS.forEach(function (c) {
    const s = chords.summarize(v.per, c), si = chords.summarize(id.per, c);
    console.log('  ' + row([c, pct(s.correct / s.n), pct(s.wrong / s.n), pct(s.none / s.n), pct(si.correct / si.n),
      pct(chords.frameAccuracy(cases, c)), ms(quantile(s.latency, 0.5)) + ' / ' + ms(quantile(s.latency, 0.9))], w));
  });
  const room = chords.summarize(v.per, 'room');
  check('chord verify accuracy on "room" >= ' + pct(TARGETS.chord), room.correct / room.n >= TARGETS.chord);

  const sn = chords.runSingleNotes(dsp, { sr: SR, conditions: ['clean', 'room', 'di'], fftSize: FFT });
  console.log('\n  Single notes played instead of a chord: ' + sn.confirmed + '/' + sn.n + ' confirmed as a chord' +
    (sn.examples.length ? ' (' + sn.examples.join('; ') + ')' : ''));
  check('single notes never confirm a chord', sn.confirmed === 0);

  heading('Chord changes: A ringing -> fingers lifted -> B strummed (time to confirm B)');
  const ch = chords.runChanges(dsp, { sr: SR, conditions: CONDITIONS, fftSize: FFT, every: QUICK ? 7 : 3 });
  const wc = [8, 6, 12, 18, 10, 16];
  console.log(row(['cond', 'n', 'B confirmed', 'wrong label first', 'none', 'latency p50/p90'], wc));
  CONDITIONS.forEach(function (c) {
    const s = ch[c];
    console.log(row([c, s.n, pct(s.correct / s.n), pct(s.wrongBefore / s.n), pct(s.none / s.n),
      ms(quantile(s.latency, 0.5)) + ' / ' + ms(quantile(s.latency, 0.9))], wc));
  });
}

function reportReal() {
  heading('Real recordings (tests/real/*.wav) - reported separately from synthetic');
  const r = runReal(dsp);
  if (!r.length) { console.log('  none found. Record with the app (Calibration > Recorder) and drop WAVs in tests/real/.'); return; }
  const w = [40, 7, 8, 10, 6, 9, 10];
  console.log(row(['file', 'kind', 'expect', 'got', 'pass', 'frames', 'latency'], w));
  r.forEach(function (x) {
    if (x.skipped) { console.log(row([x.file, 'skip', x.skipped], [34, 8, 40])); return; }
    console.log(row([x.file.slice(0, 39), x.kind, x.expected, (x.got || '-') + (x.gotIdentify && x.gotIdentify !== x.got ? '/' + x.gotIdentify : ''),
      x.pass ? 'yes' : 'NO', pct(x.frameAcc), ms(x.latency)], w));
  });
  console.log('\n  By input source (pass rate, mean frame accuracy, latency p50):');
  const wsrc = [12, 8, 26, 26];
  console.log('  ' + row(['source', 'files', 'chords', 'notes'], wsrc));
  const sources = Array.from(new Set(r.filter(function (x) { return !x.skipped; }).map(function (x) { return x.source; })));
  sources.forEach(function (src) {
    const cell = function (k) {
      const xs = r.filter(function (x) { return !x.skipped && x.source === src && x.kind === k; });
      if (!xs.length) return '-';
      const pass = xs.filter(function (x) { return x.pass; }).length;
      const fa = xs.reduce(function (a, x) { return a + x.frameAcc; }, 0) / xs.length;
      const lat = quantile(xs.map(function (x) { return x.latency; }).filter(function (v) { return v !== null; }), 0.5);
      return pass + '/' + xs.length + ' ' + pct(fa) + ' ' + ms(lat);
    };
    const n = r.filter(function (x) { return !x.skipped && x.source === src; }).length;
    console.log('  ' + row([src, n, cell('chord'), cell('note')], wsrc));
  });
  if (sources.indexOf('irig') >= 0 && sources.length > 1) {
    console.log('  (compare like for like: record the same chords/notes through each source)');
  }
}

function reportHealth() {
  heading('Guitar Health Check (synthetic, iRig-style direct input, ' + SR + ' Hz)');
  const H = loadHealth().health;
  healthSuite.logicChecks(H, check);
  const pa = healthSuite.pitchAccuracy(H, SR);
  console.log('\n  Steady pitch error over ' + pa.n + ' notes (strings x frets 0/1/5/12, +-10 c detune): median ' +
    pa.median.toFixed(2) + ' c, p95 ' + pa.p95.toFixed(2) + ' c, max ' + pa.max.toFixed(2) + ' c');
  check('steady pitch p95 error < 1.5 cents', pa.p95 < 1.5);
  const ic = healthSuite.intonationCases(H, SR);
  console.log('  Intonation (true offset -> measured, status): ' + ic.map(function (c) {
    return (c.truth > 0 ? '+' : '') + c.truth + '->' + c.measured.toFixed(1) + ' ' + c.status; }).join(' | '));
  check('intonation status correct on all cases', ic.every(function (c) {
    return c.status === (Math.abs(c.truth) <= 5 ? 'ok' : c.truth > 0 ? 'sharp' : 'flat'); }));
  console.log('\n  Fret sweep, 72 notes, 3 buzzing (marked by player) + 2 dead notes, varying buzz loudness:');
  const w = [14, 12, 14, 12, 14, 12];
  console.log('  ' + row(['buzz amount', 'buzz found', 'false buzz', 'dead found', 'false dead', 'undetected'], w));
  const sweeps = [0.02, 0.05, 0.1, 0.2].map(function (a, i) { return healthSuite.sweepCase(H, a, 5000 + i * 1000, SR); });
  sweeps.forEach(function (r) {
    console.log('  ' + row([r.buzzAmount, r.buzzHit + '/3', r.buzzFalse + '/69', r.deadHit + '/2', r.deadFalse + '/70', r.undetected], w));
  });
  check('sweep: no false buzz/dead flags and dead notes found at all buzz levels',
    sweeps.every(function (r) { return r.buzzFalse === 0 && r.deadFalse === 0 && r.deadHit === 2 && r.undetected === 0; }));
  check('sweep: player-marked buzz kept (3/3), buzzing notes still measured', sweeps.every(function (r) { return r.buzzHit === 3; }));
}

const t0 = Date.now();
if (HEALTH_ONLY) reportHealth();
else {
  if (!REAL_ONLY) { unitChecks(); reportNotes(); reportSequences(); reportChords(); reportHealth(); }
  reportReal();
}
console.log('\nDone in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s. ' + (failures ? failures + ' check(s) FAILED.' : 'All checks passed.'));
process.exitCode = failures ? 1 : 0;
