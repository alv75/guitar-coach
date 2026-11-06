'use strict';
// Runs the classifiers on real recordings in tests/real/.
// File name convention (what the in-app recorder produces): <label>_<source>_<timestamp>.wav
//   label = chord id (Am, C, E7, ...) or note name (A2, C#4, ...); source = irig | phonemic | laptopmic
const fs = require('fs');
const path = require('path');
const { readWav } = require('./wav');
const { streamFrames, trackEvents, detectOnset } = require('./stream');

const REAL_DIR = path.join(__dirname, 'real');

// Gate = quietest 100 ms window + gateOffsetDb (works without a known silent lead-in).
function autoGate(dsp, x, sr) {
  const w = Math.round(0.1 * sr);
  let min = 0;
  for (let i = 0; i + w <= x.length; i += w) min = Math.min(min, dsp.toDb(dsp.rms(x, i, i + w)));
  return Math.max(-80, min + dsp.CONFIG.gateOffsetDb);
}

const SOURCES = ['irig', 'phonemic', 'laptopmic'];

// <label>_<source>_<timestamp>.wav ; source is optional (older files) -> 'unknown'
function labelOf(dsp, file) {
  const parts = path.basename(file, path.extname(file)).split('_');
  const label = parts[0];
  const source = SOURCES.indexOf(parts[1]) >= 0 ? parts[1] : 'unknown';
  if (dsp.ALL_CHORDS.indexOf(label) >= 0) return { kind: 'chord', label: label, source: source };
  const midi = dsp.parseNoteName(label);
  return midi !== null ? { kind: 'note', label: label, midi: midi, source: source } : null;
}

function runRealFile(dsp, file) {
  const meta = labelOf(dsp, file);
  if (!meta) return { file: path.basename(file), skipped: 'unrecognised label in file name' };
  const wav = readWav(fs.readFileSync(file));
  const x = wav.samples, sr = wav.sampleRate;
  const gate = autoGate(dsp, x, sr);
  const onset = detectOnset(dsp, x, sr, gate);
  const frames = streamFrames(dsp, x, sr, { gateDb: gate, pitch: meta.kind === 'note', chords: meta.kind === 'chord' });
  const base = { file: path.basename(file), kind: meta.kind, expected: meta.label, source: meta.source, sr: sr, gateDb: gate };
  if (meta.kind === 'note') {
    const ev = trackEvents(dsp, frames, dsp.noteLabel, dsp.CONFIG.noteStableSec, gate);
    const first = ev[0];
    const voiced = frames.filter(function (f) { return f.frame.pitch; });
    const ok = voiced.filter(function (f) { return f.frame.pitch.midi === meta.midi; }).length;
    return Object.assign(base, {
      got: first ? dsp.noteName(first.label) : null, pass: !!first && first.label === meta.midi,
      latency: first && onset !== null ? first.t - onset : null, frameAcc: voiced.length ? ok / voiced.length : 0
    });
  }
  const ev = trackEvents(dsp, frames, function (fr) { return dsp.chordLabel(fr, 'verify'); }, dsp.CONFIG.chordStableSec, gate);
  const evAll = trackEvents(dsp, frames, function (fr) { return dsp.chordLabel(fr, 'identify'); }, dsp.CONFIG.chordStableSec, gate);
  const voiced = frames.filter(function (f) { return f.frame.lib; });
  const ok = voiced.filter(function (f) { return f.frame.lib[0].id === meta.label; }).length;
  return Object.assign(base, {
    got: ev[0] ? ev[0].label : null, gotIdentify: evAll[0] ? evAll[0].label : null,
    pass: !!ev[0] && ev[0].label === meta.label,
    latency: ev[0] && onset !== null ? ev[0].t - onset : null, frameAcc: voiced.length ? ok / voiced.length : 0
  });
}

function runReal(dsp) {
  if (!fs.existsSync(REAL_DIR)) return [];
  return fs.readdirSync(REAL_DIR)
    .filter(function (f) { return /\.wav$/i.test(f); })
    .map(function (f) {
      try { return runRealFile(dsp, path.join(REAL_DIR, f)); }
      catch (e) { return { file: f, skipped: 'read error: ' + e.message }; }
    });
}

module.exports = { runReal, SOURCES };
