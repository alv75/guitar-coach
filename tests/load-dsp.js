'use strict';
// Extracts the dsp-core and health-core <script> blocks from index.html and evaluates them in a sandbox,
// so tests run exactly the code the browser runs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBlocks() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ctx = vm.createContext({ Math, Float64Array, Float32Array, Uint32Array, Map, Set, Object, Array, Number, String, Date, parseInt, isNaN, ArrayBuffer, DataView, Uint8Array });
  ['dsp-core', 'health-core'].forEach(function (id) {
    const start = html.indexOf('<script id="' + id + '">');
    const m = start < 0 ? null : /^<script id="[\w-]+">([\s\S]*?)<\/script>/.exec(html.slice(start));
    if (!m) throw new Error(id + ' script block not found in index.html');
    vm.runInContext(m[1], ctx, { filename: 'index.html#' + id });
  });
  if (!ctx.GuitarDSP || !ctx.GuitarHealth) throw new Error('GuitarDSP / GuitarHealth not defined');
  return ctx;
}

function loadDsp() { return loadBlocks().GuitarDSP; }
function loadHealth() { const c = loadBlocks(); return { dsp: c.GuitarDSP, health: c.GuitarHealth }; }

module.exports = { loadDsp, loadHealth };
