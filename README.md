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

## Tests

```
node tests/run-tests.js            # full: unit checks + synthetic accuracy + real recordings (~5-8 min)
node tests/run-tests.js --quick    # fewer trials (~2 min)
node tests/run-tests.js --real-only
```

The tests load the `<script id="dsp-core">` block straight out of `index.html`, so they test the exact code the
browser runs.

### Real recordings

Calibration > Recorder records 3 s and downloads a WAV named `<label>_<source>_<timestamp>.wav`
(for example `Am_irig_20261106-201500.wav`). Put the files into `tests/real/`. The report shows them separately
from the synthetic results and groups them by source (`irig`, `phonemic`, `laptopmic`).

## Files

- `index.html` - the app: styles, `dsp-core` (pitch, chroma, chord matching, trackers), `app-core` (storage,
  wake lock, audio engine, monitor, latency test), `app-ui` (screens)
- `tests/` - Node test harness: `synth.js` (test signals), `suite-*.js`, `run-tests.js`
- `tests/real/` - your recordings (WAV)
