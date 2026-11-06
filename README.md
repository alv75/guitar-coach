# Guitar Coach

Personal guitar practice app. Single file (`index.html`), vanilla JS, no build step, no external APIs.
Progress is stored in the browser (localStorage).

**Live:** https://alv75.github.io/guitar-coach/

## Run locally

The microphone only works on HTTPS or `localhost`, so open it through a local server, not by double-clicking:

```
cd guitar-coach
python -m http.server 8080
```

Then open http://localhost:8080 in Chrome.

On iPhone use the GitHub Pages link (HTTPS). Tip: Share > "Add to Home Screen". Safari can delete
data of sites you have not opened for 7 days; Home Screen apps are exempt.

## Audio setup

- **Primary:** iRig (direct input), its THRU going to the amp for monitoring.
  On iPhone the iRig is picked automatically; on a computer choose it in Calibration > Input.
- **Alternative:** phone or laptop mic about 50 cm from the amp (clean tone, neck pickup).
- Calibration screen: set the input gain so strum peaks land in the green band (-12 to -3 dBFS), never CLIP,
  then measure the noise floor.
- Monitor (Calibration > 7) plays the input through a simple clean amp tone. Off by default. Detection always
  reads the dry input.

## Guitar Health Check

Guided checks with the iRig: tuning stability, nut height, intonation (with an adjust -> retune -> re-measure
loop), fret sweep (frets 1-12, heatmap), fretting pressure, string balance, plus a manual checklist (string age,
relief, action, pickup height). Each finding is marked DIY or LUTHIER with a confidence level. Reports are saved
to history for before/after comparison.

Automatic: pitch (median of the steady part of each note, low-passed just above the fundamental), sustain (dead
notes), undetected notes. Buzz is marked by you during the sweep: an automatic buzz metric was tested and did not
work reliably (see `attackNoise` in `health-core`).

## Tests

```
node tests/run-tests.js            # full: unit checks, synthetic accuracy, health check, real recordings (~15 min)
node tests/run-tests.js --quick    # fewer trials (~5 min)
node tests/run-tests.js --real-only
node tests/run-tests.js --health-only
node tests/tune-leak.js [--real]      # grid search for chord harmonic-leak suppression
```

The tests load the `<script id="dsp-core">` block straight out of `index.html`, so they test the exact code the
browser runs.

### Real recordings

Calibration > Recorder records 3 s and downloads a WAV named `<label>_<source>_<timestamp>.wav`
(for example `Am_irig_20261106-201500.wav`). Put the files into `tests/real/`. The report shows them separately
from the synthetic results and groups them by source (`irig`, `phonemic`, `laptopmic`).

## Files

- `index.html` - the app: styles, `dsp-core` (pitch, chroma, chord matching, trackers), `health-core` (Health Check
  analysis), `app-core` (storage, wake lock, audio engine, monitor, latency test), `app-ui` (screens), `health-ui`
- `tests/` - Node test harness: `synth.js` (test signals), `suite-*.js`, `run-tests.js`
- `tests/real/` - your recordings (WAV)
