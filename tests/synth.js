'use strict';
// Synthetic guitar-like signals for classifier tests. Deterministic (seeded RNG).

const OPEN_STRINGS = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4 (MIDI)

// Chord voicings, low E -> high e. null = string not played.
const VOICINGS = Object.freeze({
  E: [0, 2, 2, 1, 0, 0], Em: [0, 2, 2, 0, 0, 0], A: [null, 0, 2, 2, 2, 0], Am: [null, 0, 2, 2, 1, 0],
  D: [null, null, 0, 2, 3, 2], Dm: [null, null, 0, 2, 3, 1], G: [3, 2, 0, 0, 0, 3], C: [null, 3, 2, 0, 1, 0],
  E7: [0, 2, 0, 1, 0, 0], A7: [null, 0, 2, 0, 2, 0], D7: [null, null, 0, 2, 1, 2]
});

const CONDITIONS = Object.freeze({
  clean: { snrDb: 30, tuneCents: 5, hum: 0, micHp: 0, dropString: 0 },
  room: { snrDb: 20, tuneCents: 10, hum: 0.02, micHp: 120, dropString: 0 },
  harsh: { snrDb: 10, tuneCents: 15, hum: 0.05, micHp: 180, dropString: 0.3 },
  // iRig-style direct input: raw humbucker, no speaker/mic filtering, pickup resonance, picked near the bridge
  di: { snrDb: 40, tuneCents: 5, hum: 0.005, micHp: 0, dropString: 0, direct: true }
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// Adds one plucked string into `out` (mutates the local render buffer only).
// stopAt: time (s) where the string is damped (fingers lifted), or undefined.
function addPluck(out, sr, f0, tStart, amp, rng, cond, stopAt, tauScale) {
  const nH = cond.direct ? Math.min(120, Math.floor(8000 / f0)) : 16; // a raw pickup carries partials up to ~8 kHz
  const beta = cond.direct ? 0.07 + 0.08 * rng() : 0.12 + 0.12 * rng(); // pluck position (pick near bridge = brighter)
  const pickup = 0.27;                       // neck pickup position (fraction of scale)
  const B = 0.00008 + 0.00008 * rng();       // inharmonicity
  const tau0 = (1.5 + rng()) * (tauScale || 1); // fundamental decay (s); tauScale < 1 = dead note
  const partials = [];
  for (let n = 1; n <= nH; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    if (fn > sr * 0.45) break;
    let a = amp * Math.abs(Math.sin(n * Math.PI * beta)) * (0.3 + Math.abs(Math.sin(n * Math.PI * pickup))) / n;
    if (cond.direct) {
      // humbucker + cable: resonant peak around 2.5 kHz, then roll-off (no speaker)
      const x = fn / 2500;
      a *= 1 / Math.sqrt(Math.pow(1 - x * x, 2) + Math.pow(x / 1.5, 2));
    } else {
      a /= 1 + Math.pow(fn / 4500, 4);       // speaker roll-off
    }
    if (cond.micHp) a /= Math.sqrt(1 + Math.pow(cond.micHp / fn, 4)); // phone mic bass roll-off
    partials.push({ w: 2 * Math.PI * fn / sr, a: a, tau: tau0 / (1 + 0.25 * n), ph: 2 * Math.PI * rng() });
  }
  const i0 = Math.max(0, Math.round(tStart * sr));
  const iStop = stopAt === undefined ? out.length : Math.round(stopAt * sr);
  const attack = Math.round(0.003 * sr);
  const dampRate = Math.exp(-1 / (0.02 * sr));
  const iEnd = Math.min(out.length, iStop + Math.round(0.2 * sr));
  for (const p of partials) {
    // recursive damped oscillator: z <- z * r * e^{iw}
    const r = Math.exp(-1 / (p.tau * sr));
    const c = Math.cos(p.w) * r, s = Math.sin(p.w) * r;
    let re = Math.cos(p.ph) * p.a, im = Math.sin(p.ph) * p.a, damp = 1;
    for (let i = i0; i < iEnd; i++) {
      const env = i - i0 < attack ? (i - i0) / attack : 1;
      if (i >= iStop) damp *= dampRate;
      out[i] += im * env * damp;
      const nre = re * c - im * s;
      im = re * s + im * c;
      re = nre;
    }
  }
}

function addNoiseAndHum(out, sr, rng, cond, sigRms) {
  const noiseRms = sigRms / Math.pow(10, cond.snrDb / 20);
  for (let i = 0; i < out.length; i++) {
    let h = 0;
    if (cond.hum) for (let k = 1; k <= 5; k++) h += Math.sin(2 * Math.PI * 50 * k * i / sr) / k;
    out[i] += noiseRms * gaussian(rng) + cond.hum * sigRms * h;
  }
}

function signalRms(buf, from) {
  let s = 0, n = 0;
  for (let i = from; i < buf.length; i++) { s += buf[i] * buf[i]; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

function chordStrings(chordId, rng, cond) {
  const frets = VOICINGS[chordId];
  const played = [];
  frets.forEach(function (f, s) { if (f !== null) played.push({ s: s, midi: OPEN_STRINGS[s] + f }); });
  if (cond.dropString && rng() < cond.dropString && played.length > 3) {
    played.splice(Math.floor(rng() * played.length), 1); // one string muted by mistake
  }
  return played;
}

function strum(out, sr, chordId, tStart, rng, cond, stopAt) {
  const strings = chordStrings(chordId, rng, cond);
  let t = tStart;
  strings.forEach(function (st) {
    const detune = (rng() * 2 - 1) * cond.tuneCents;
    addPluck(out, sr, midiToFreq(st.midi + detune / 100), t, 0.6 + 0.4 * rng(), rng, cond, stopAt);
    t += 0.008 + 0.012 * rng();                // 8-20 ms between strings (total ~40-100 ms)
  });
}

// Silence(noise) then one strum of chordId at `onset` seconds.
function renderChord(chordId, opts) {
  const sr = opts.sr, rng = mulberry32(opts.seed), cond = CONDITIONS[opts.condition];
  const out = new Float32Array(Math.round(opts.duration * sr));
  strum(out, sr, chordId, opts.onset, rng, cond);
  addNoiseAndHum(out, sr, rng, cond, signalRms(out, Math.round(opts.onset * sr)));
  return out;
}

// Chord `from` ringing, fingers lifted at onset-50ms, chord `to` strummed at `onset`.
function renderChange(from, to, opts) {
  const sr = opts.sr, rng = mulberry32(opts.seed), cond = CONDITIONS[opts.condition];
  const out = new Float32Array(Math.round(opts.duration * sr));
  strum(out, sr, from, 0.05, rng, cond, opts.onset - 0.05);
  strum(out, sr, to, opts.onset, rng, cond);
  addNoiseAndHum(out, sr, rng, cond, signalRms(out, 0));
  return out;
}

// Single plucked note with detune (cents).
function renderNote(midi, detuneCents, opts) {
  const sr = opts.sr, rng = mulberry32(opts.seed), cond = CONDITIONS[opts.condition];
  const out = new Float32Array(Math.round(opts.duration * sr));
  addPluck(out, sr, midiToFreq(midi + detuneCents / 100), opts.onset, 0.8, rng, cond);
  addNoiseAndHum(out, sr, rng, cond, signalRms(out, Math.round(opts.onset * sr)));
  return out;
}

// Note sequence. A note stops when the next note on the same string is picked, otherwise
// `overlap` seconds after the next note (fretting finger lifted). Larger overlap = sloppier playing.
function renderSequence(notes, opts) {
  const sr = opts.sr, rng = mulberry32(opts.seed), cond = CONDITIONS[opts.condition];
  const overlap = opts.overlap === undefined ? 0.06 : opts.overlap;
  const out = new Float32Array(Math.round(opts.duration * sr));
  notes.forEach(function (n, i) {
    const sameString = notes.slice(i + 1).find(function (m) { return m.string === n.string; });
    const next = notes[i + 1];
    const stops = [n.t + 0.9];
    if (sameString) stops.push(sameString.t);
    if (next) stops.push(next.t + overlap);
    const detune = (rng() * 2 - 1) * cond.tuneCents;
    addPluck(out, sr, midiToFreq(n.midi + detune / 100), n.t, 0.6 + 0.4 * rng(), rng, cond, Math.min.apply(null, stops));
  });
  addNoiseAndHum(out, sr, rng, cond, signalRms(out, Math.round(notes[0].t * sr)));
  return out;
}

// Fret buzz: the string slaps the next fret once per cycle during the loud attack ->
// broadband noise bursts, phase-locked to f0, decaying with the vibration amplitude.
function addBuzz(out, sr, f0, tStart, amount, rng) {
  const i0 = Math.round(tStart * sr), len = Math.round(0.4 * sr);
  for (let i = 0; i < len && i0 + i < out.length; i++) {
    const t = i / sr;
    const pulse = Math.pow(Math.max(0, Math.sin(2 * Math.PI * f0 * t)), 8);
    out[i0 + i] += amount * gaussian(rng) * pulse * Math.exp(-t / 0.12);
  }
}

// One plucked note for the health checks. opts: { sr, seed, condition, duration, onset, tauScale, buzz, amp }
function renderPluck(midi, detuneCents, opts) {
  const sr = opts.sr, rng = mulberry32(opts.seed), cond = CONDITIONS[opts.condition];
  const out = new Float32Array(Math.round(opts.duration * sr));
  const f0 = midiToFreq(midi + detuneCents / 100);
  addPluck(out, sr, f0, opts.onset, opts.amp || 0.8, rng, cond, undefined, opts.tauScale);
  if (opts.buzz) addBuzz(out, sr, f0, opts.onset, opts.buzz, rng);
  addNoiseAndHum(out, sr, rng, cond, signalRms(out, Math.round(opts.onset * sr)));
  return out;
}

module.exports = { VOICINGS, CONDITIONS, OPEN_STRINGS, mulberry32, renderChord, renderChange, renderNote, renderSequence, renderPluck };
