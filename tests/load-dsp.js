'use strict';
// Extracts <script id="dsp-core"> from index.html and evaluates it in a sandbox,
// so tests run exactly the code the browser runs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadDsp() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = /<script id="dsp-core">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('dsp-core script block not found in index.html');
  const ctx = vm.createContext({ Math, Float64Array, Float32Array, Uint32Array, Map, Object, Array, Number, parseInt, ArrayBuffer, DataView, Uint8Array });
  vm.runInContext(m[1], ctx, { filename: 'index.html#dsp-core' });
  if (!ctx.GuitarDSP) throw new Error('GuitarDSP not defined by dsp-core');
  return ctx.GuitarDSP;
}

module.exports = { loadDsp };
