'use strict';
const synth = require('./synth');
const { noiseFloorDb, streamFrames, trackEvents } = require('./stream');

const BANDS = [
  { name: 'E2-B2', lo: 40, hi: 47 }, { name: 'C3-B3', lo: 48, hi: 59 },
  { name: 'C4-B4', lo: 60, hi: 71 }, { name: 'C5-E6', lo: 72, hi: 88 }
];

function emptyStats() { return { n: 0, correct: 0, octave: 0, wrong: 0, none: 0, cents: [], latency: [] }; }

function analyzeNoteCase(dsp, x, sr, target, detune, onset) {
  const gate = noiseFloorDb(dsp, x, sr, onset - 0.05) + dsp.CONFIG.gateOffsetDb;
  const frames = streamFrames(dsp, x, sr, { gateDb: gate, chords: false });
  const events = trackEvents(dsp, frames, dsp.noteLabel, dsp.CONFIG.noteStableSec, gate)
    .filter(function (e) { return e.t > onset; });
  if (!events.length) return { outcome: 'none' };
  const first = events[0];
  const diff = first.label - target;
  const outcome = diff === 0 ? 'correct' : diff % 12 === 0 ? 'octave' : 'wrong';
  const after = frames.filter(function (f) {
    return f.t >= first.t && f.t <= first.t + 0.2 && f.frame.pitch && f.frame.pitch.midi === target;
  });
  const centsErr = after.length
    ? after.reduce(function (s, f) { return s + Math.abs(f.frame.pitch.cents - detune); }, 0) / after.length
    : null;
  return { outcome: outcome, latency: first.t - onset, centsErr: centsErr, got: first.label };
}

function runNotes(dsp, opts) {
  const results = {};
  const errors = [];
  opts.conditions.forEach(function (cond, ci) {
    const total = emptyStats();
    const bands = BANDS.map(function () { return emptyStats(); });
    for (let midi = 40; midi <= 88; midi++) {
      for (let k = 0; k < opts.trials; k++) {
        const seed = 1 + ci * 100000 + midi * 100 + k;
        const detune = (synth.mulberry32(seed + 7)() * 2 - 1) * 30;
        const onset = 0.3;
        const x = synth.renderNote(midi, detune, { sr: opts.sr, seed: seed, condition: cond, duration: 0.9, onset: onset });
        const r = analyzeNoteCase(dsp, x, opts.sr, midi, detune, onset);
        const band = bands[BANDS.findIndex(function (b) { return midi >= b.lo && midi <= b.hi; })];
        [total, band].forEach(function (s) {
          s.n++; s[r.outcome]++;
          if (r.outcome === 'correct') { s.latency.push(r.latency); if (r.centsErr !== null) s.cents.push(r.centsErr); }
        });
        if (r.outcome !== 'correct' && errors.length < 12) {
          errors.push(cond + ' ' + dsp.noteName(midi) + ' -> ' + (r.got === undefined ? 'nothing' : dsp.noteName(r.got)));
        }
      }
    }
    results[cond] = { total: total, bands: bands };
  });
  return { results: results, errors: errors, bands: BANDS };
}

// Pentatonic box 1 (A minor, 5th fret): up then down, simulating the trainer's "next expected note" logic.
const BOX1 = [[0, 5], [0, 8], [1, 5], [1, 7], [2, 5], [2, 7], [3, 5], [3, 7], [4, 5], [4, 8], [5, 5], [5, 8]];

function box1Sequence() {
  const up = BOX1.map(function (sf) { return { string: sf[0], midi: synth.OPEN_STRINGS[sf[0]] + sf[1] }; });
  return up.concat(up.slice(0, -1).reverse());
}

function runSequences(dsp, opts) {
  const seq = box1Sequence();
  const out = [];
  const variants = [];
  opts.conditions.forEach(function (cond) { opts.bpms.forEach(function (bpm) { variants.push({ cond: cond, bpm: bpm, overlap: 0.06 }); }); });
  opts.bpms.forEach(function (bpm) { variants.push({ cond: 'room', bpm: bpm, overlap: 0.3, tag: 'sloppy' }); });
  variants.forEach(function (v, vi) {
    const cond = v.cond, bpm = v.bpm;
    let clean = 0, hits = 0, wrong = 0;
    const lat = [];
    for (let k = 0; k < opts.trials; k++) {
      const notes = seq.map(function (n, i) { return Object.assign({}, n, { t: 0.4 + i * 60 / bpm }); });
      const x = synth.renderSequence(notes, {
        sr: opts.sr, seed: 9000 + vi * 1000 + k, condition: cond, duration: notes[notes.length - 1].t + 1, overlap: v.overlap
      });
      const gate = noiseFloorDb(dsp, x, opts.sr, 0.3) + dsp.CONFIG.gateOffsetDb;
      const frames = streamFrames(dsp, x, opts.sr, { gateDb: gate, chords: false });
      const events = trackEvents(dsp, frames, dsp.noteLabel, dsp.CONFIG.noteStableSec, gate);
      let idx = 0, w = 0;
      events.forEach(function (e) {
        if (idx >= seq.length) return;
        if (e.label === seq[idx].midi) { lat.push(e.t - notes[idx].t); idx++; }
        else if (idx === 0 || e.label !== seq[idx - 1].midi) w++; // a still-ringing previous note is ignored
      });
      hits += idx; wrong += w;
      if (idx === seq.length && w === 0) clean++;
    }
    out.push({ cond: v.tag || cond, bpm: bpm, runs: opts.trials, clean: clean, hitRate: hits / (opts.trials * seq.length), wrongPerRun: wrong / opts.trials, latency: lat });
  });
  return out;
}

module.exports = { runNotes, runSequences, box1Sequence };
