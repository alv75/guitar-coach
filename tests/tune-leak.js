'use strict';
// Grid search for harmonic-leak suppression (CONFIG.chroma.leak). Ranked by % frames passing the verify margin,
// then by the worst condition's 10th-percentile lead. Result 2026-11-06 (realistic DI synth): h3 0.15, h5 0.3, h7 0.15.
// Spectra are computed once; only the cheap salience/chroma step is re-run per setting.
// Usage: node tests/tune-leak.js            (synthetic, all conditions)
//        node tests/tune-leak.js --real     (also tests/real/*.wav chords, reported separately)
const fs = require('fs');
const path = require('path');
const { loadDsp } = require('./load-dsp');
const synth = require('./synth');
const { readWav } = require('./wav');

const dsp = loadDsp();
const SR = 48000;

const CONDITIONS = ['clean', 'room', 'harsh', 'di'];
const TRIALS = 6;
const USE_REAL = process.argv.indexOf('--real') >= 0;

// frames from 0.15 s to 1.0 s after the strum, every ~85 ms
function framesOf(x, sr, onset) {
  const N = dsp.fftSizeFor(sr);
  const out = [];
  for (let t = onset + 0.15; t <= onset + 1.0 && t * sr <= x.length; t += 0.085) {
    const end = Math.round(t * sr);
    out.push(Float32Array.from(dsp.magnitudeSpectrum(x.subarray(Math.max(0, end - N), end), N)));
  }
  return out;
}

function buildSynthetic() {
  const sets = [];
  CONDITIONS.forEach(function (cond, ci) {
    dsp.LIBRARY.forEach(function (chord, hi) {
      for (let k = 0; k < TRIALS; k++) {
        const x = synth.renderChord(chord, { sr: SR, seed: 91000 + ci * 1000 + hi * 50 + k, condition: cond, duration: 1.5, onset: 0.3 });
        sets.push({ group: cond, chord: chord, sr: SR, spectra: framesOf(x, SR, 0.3) });
      }
    });
  });
  return sets;
}

function buildReal() {
  const dir = path.join(__dirname, 'real');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (f) { return /\.wav$/i.test(f); }).map(function (f) {
    const parts = path.basename(f, '.wav').split('_');
    if (dsp.LIBRARY.indexOf(parts[0]) < 0) return null;
    const w = readWav(fs.readFileSync(path.join(dir, f)));
    // onset = first 10 ms window within 30 dB of the file's loudest window
    let peakDb = -200;
    const win = Math.round(0.01 * w.sampleRate), levels = [];
    for (let i = 0; i + win <= w.samples.length; i += win) {
      const db = dsp.toDb(dsp.rms(w.samples, i, i + win)); levels.push(db); peakDb = Math.max(peakDb, db);
    }
    const onsetIdx = levels.findIndex(function (db) { return db > peakDb - 30; });
    return { group: 'real:' + (parts[1] || 'unknown'), chord: parts[0], sr: w.sampleRate, spectra: framesOf(w.samples, w.sampleRate, onsetIdx * 0.01) };
  }).filter(Boolean);
}

function score(sets, leak) {
  const byGroup = {};
  sets.forEach(function (s) {
    const g = byGroup[s.group] || (byGroup[s.group] = { n: 0, ok: 0, leads: [], confusions: {} });
    s.spectra.forEach(function (mag) {
      const chroma = dsp.chromaFromSpectrum(mag, s.sr, dsp.fftSizeFor(s.sr), { leak: leak });
      const ranked = dsp.rankChords(chroma, dsp.LIBRARY);
      const mine = ranked.find(function (r) { return r.id === s.chord; }).score;
      const rival = ranked.find(function (r) { return r.id !== s.chord; });
      g.n++;
      if (ranked[0].id === s.chord) g.ok++;
      else g.confusions[s.chord + '->' + ranked[0].id] = (g.confusions[s.chord + '->' + ranked[0].id] || 0) + 1;
      g.leads.push(mine - rival.score);
    });
  });
  Object.keys(byGroup).forEach(function (k) {
    const g = byGroup[k];
    g.leads.sort(function (a, b) { return a - b; });
    g.acc = g.ok / g.n;
    g.p10 = g.leads[Math.floor(0.1 * g.leads.length)];
    g.passMargin = g.leads.filter(function (l) { return l >= dsp.CONFIG.verifyMargin; }).length / g.leads.length;
  });
  return byGroup;
}

function fmt(g) { return (100 * g.acc).toFixed(1).padStart(5) + '% p10 ' + g.p10.toFixed(3).padStart(6) + ' >m ' + (100 * g.passMargin).toFixed(0).padStart(3) + '%'; }

const t0 = Date.now();
const synthetic = buildSynthetic();
const real = USE_REAL ? buildReal() : [];
console.log('cached ' + synthetic.reduce(function (a, s) { return a + s.spectra.length; }, 0) + ' synthetic frames, ' +
  real.reduce(function (a, s) { return a + s.spectra.length; }, 0) + ' real frames in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
console.log('per condition: frame top-1 accuracy, 10th-percentile lead over best rival, % frames passing verify margin\n');

const grid = [];
[0, 0.15, 0.3].forEach(function (h3) {
  [0, 0.15, 0.3, 0.45, 0.6].forEach(function (h5) {
    [0, 0.15].forEach(function (h7) { grid.push({ h3: h3, h5: h5, h7: h7 }); });
  });
});

const results = grid.map(function (leak) {
  const r = score(synthetic, leak);
  const worstP10 = Math.min.apply(null, CONDITIONS.map(function (c) { return r[c].p10; }));
  const meanPass = CONDITIONS.reduce(function (a, c) { return a + r[c].passMargin; }, 0) / CONDITIONS.length;
  return { leak: leak, r: r, worstP10: worstP10, meanPass: meanPass };
});
results.sort(function (a, b) { return b.meanPass - a.meanPass || b.worstP10 - a.worstP10; });

function show(x, label) {
  console.log((label || '').padEnd(10) + JSON.stringify(x.leak).padEnd(32) + CONDITIONS.map(function (c) { return c + ' ' + fmt(x.r[c]); }).join(' | '));
}
show(results.find(function (x) { return !x.leak.h3 && !x.leak.h5 && !x.leak.h7; }), 'baseline');
results.slice(0, 8).forEach(function (x, i) { show(x, '#' + (i + 1)); });

const best = results[0];
console.log('\nconfusions (baseline vs best), di:');
console.log('  baseline ' + JSON.stringify(results.find(function (x) { return !x.leak.h3 && !x.leak.h5 && !x.leak.h7; }).r.di.confusions));
console.log('  best     ' + JSON.stringify(best.r.di.confusions));
if (real.length) {
  console.log('\nreal recordings (NOT used for choosing):');
  [results.find(function (x) { return !x.leak.h3 && !x.leak.h5 && !x.leak.h7; }), best].forEach(function (x, i) {
    const rr = score(real, x.leak);
    Object.keys(rr).forEach(function (k) { console.log('  ' + (i ? 'best    ' : 'baseline') + ' ' + k.padEnd(16) + fmt(rr[k]) + ' ' + JSON.stringify(rr[k].confusions)); });
  });
}
