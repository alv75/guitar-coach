'use strict';
const synth = require('./synth');
const { noiseFloorDb, streamFrames, trackEvents } = require('./stream');

// Keeps only what the trackers need, so margin sweeps don't recompute FFTs.
function slim(frames) {
  return frames.map(function (f) {
    return { t: f.t, frame: { levelDb: f.frame.levelDb, voiced: f.frame.voiced, lib: f.frame.lib, all: f.frame.all } };
  });
}

function buildChordCases(dsp, opts) {
  const cases = [];
  opts.conditions.forEach(function (cond, ci) {
    dsp.LIBRARY.forEach(function (chord, hi) {
      for (let k = 0; k < opts.trials; k++) {
        const onset = 0.3;
        const x = synth.renderChord(chord, { sr: opts.sr, seed: 50000 + ci * 5000 + hi * 100 + k, condition: cond, duration: 1.6, onset: onset });
        const gate = noiseFloorDb(dsp, x, opts.sr, onset - 0.05) + dsp.CONFIG.gateOffsetDb;
        const frames = slim(streamFrames(dsp, x, opts.sr, { gateDb: gate, pitch: false, chroma: { fftSize: opts.fftSize } }));
        cases.push({ cond: cond, chord: chord, onset: onset, gate: gate, frames: frames });
      }
    });
  });
  return cases;
}

function eventsAfter(dsp, c, mode, margin) {
  return trackEvents(dsp, c.frames, function (fr) { return dsp.chordLabel(fr, mode, margin); }, dsp.CONFIG.chordStableSec, c.gate)
    .filter(function (e) { return e.t > c.onset; });
}

// First-confirmation outcome per case + false-pass rate for verify mode.
function evaluate(dsp, cases, mode, margin) {
  const per = {};
  let falsePass = 0, falseTrials = 0;
  cases.forEach(function (c) {
    const ev = eventsAfter(dsp, c, mode, margin);
    const key = c.cond + '|' + c.chord;
    const s = per[key] || (per[key] = { cond: c.cond, chord: c.chord, n: 0, correct: 0, wrong: 0, none: 0, latency: [], got: {} });
    s.n++;
    if (!ev.length) s.none++;
    else {
      s.got[ev[0].label] = (s.got[ev[0].label] || 0) + 1;
      if (ev[0].label === c.chord) { s.correct++; s.latency.push(ev[0].t - c.onset); } else s.wrong++;
    }
    if (mode === 'verify') {
      dsp.LIBRARY.forEach(function (exp) {
        if (exp === c.chord) return;
        falseTrials++;
        if (ev.some(function (e) { return e.label === exp; })) falsePass++;
      });
    }
  });
  return { per: per, falsePassRate: falseTrials ? falsePass / falseTrials : 0 };
}

function summarize(per, cond) {
  const rows = Object.values(per).filter(function (s) { return !cond || s.cond === cond; });
  const sum = rows.reduce(function (a, s) {
    return { n: a.n + s.n, correct: a.correct + s.correct, wrong: a.wrong + s.wrong, none: a.none + s.none, latency: a.latency.concat(s.latency) };
  }, { n: 0, correct: 0, wrong: 0, none: 0, latency: [] });
  return sum;
}

function frameAccuracy(cases, cond) {
  let ok = 0, n = 0;
  cases.filter(function (c) { return c.cond === cond; }).forEach(function (c) {
    c.frames.forEach(function (f) {
      if (f.t < c.onset + 0.15 || !f.frame.voiced || !f.frame.lib) return;
      n++;
      if (f.frame.lib[0].id === c.chord) ok++;
    });
  });
  return n ? ok / n : 0;
}

function sweepMargins(dsp, cases, margins) {
  return margins.map(function (m) {
    const r = evaluate(dsp, cases, 'verify', m);
    const s = summarize(r.per);
    return { margin: m, truePass: s.correct / s.n, wrongFirst: s.wrong / s.n, none: s.none / s.n, falsePass: r.falsePassRate };
  });
}

// Chord A ringing -> fingers lifted -> chord B strummed. Measures time to confirm B.
function runChanges(dsp, opts) {
  const pairs = [];
  dsp.LIBRARY.forEach(function (a) { dsp.LIBRARY.forEach(function (b) { if (a !== b) pairs.push([a, b]); }); });
  const out = {};
  opts.conditions.forEach(function (cond, ci) {
    const s = { n: 0, correct: 0, wrongBefore: 0, none: 0, latency: [] };
    pairs.forEach(function (p, pi) {
      if (pi % opts.every !== 0) return;
      const onset = 1.0;
      const x = synth.renderChange(p[0], p[1], { sr: opts.sr, seed: 70000 + ci * 1000 + pi, condition: cond, duration: 2.4, onset: onset });
      const gate = noiseFloorDb(dsp, x, opts.sr, 0.04) + dsp.CONFIG.gateOffsetDb;
      const frames = streamFrames(dsp, x, opts.sr, { gateDb: gate, pitch: false, chroma: { fftSize: opts.fftSize } });
      const ev = trackEvents(dsp, frames, function (fr) { return dsp.chordLabel(fr, 'verify'); }, dsp.CONFIG.chordStableSec, gate)
        .filter(function (e) { return e.t > onset; });
      s.n++;
      const hit = ev.findIndex(function (e) { return e.label === p[1]; });
      if (hit < 0) s.none++;
      else { s.correct++; s.latency.push(ev[hit].t - onset); if (hit > 0) s.wrongBefore++; }
    });
    out[cond] = s;
  });
  return out;
}

module.exports = { buildChordCases, evaluate, summarize, frameAccuracy, sweepMargins, runChanges };
