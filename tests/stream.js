'use strict';
// Streams a signal through dsp-core frame by frame, the same way the browser does
// (one analysis per `hop` samples on the most recent samples).

function noiseFloorDb(dsp, x, sr, seconds) {
  const n = Math.min(x.length, Math.round(seconds * sr));
  return dsp.toDb(dsp.rms(x, 0, n));
}

// Returns [{ t, frame }]. opts: { gateDb, pitch, chords, chroma }
function streamFrames(dsp, x, sr, opts) {
  const hop = dsp.hopFor(sr);
  const span = Math.max((opts.chroma && opts.chroma.fftSize) || dsp.fftSizeFor(sr), dsp.yinSpanFor(sr) + Math.round(0.06 * sr));
  const frames = [];
  for (let i = hop; i <= x.length; i += hop) {
    const buf = x.subarray(Math.max(0, i - span), i);
    frames.push({ t: i / sr, frame: dsp.analyzeFrame(buf, sr, opts) });
  }
  return frames;
}

// Runs a tracker over cached frames. labelFn(frame) -> label|null.
// Returns all confirm events [{ label, t }].
function trackEvents(dsp, frames, labelFn, stableSec, gateDb) {
  let state = dsp.initTracker();
  let prevDb = -120;
  const events = [];
  frames.forEach(function (f) {
    const onset = dsp.isOnset(prevDb, f.frame.levelDb, gateDb);
    prevDb = f.frame.levelDb;
    state = dsp.stepTracker(state, labelFn(f.frame), f.t, stableSec, onset);
    if (state.event === 'confirm') events.push({ label: state.confirmed, t: f.t });
  });
  return events;
}

// Detects onset time from the signal level (for real recordings with unknown onset).
function detectOnset(dsp, x, sr, gateDb) {
  const w = 256;
  for (let i = 0; i + w <= x.length; i += w) {
    if (dsp.toDb(dsp.rms(x, i, i + w)) > gateDb) return i / sr;
  }
  return null;
}

module.exports = { noiseFloorDb, streamFrames, trackEvents, detectOnset };
