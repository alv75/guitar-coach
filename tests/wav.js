'use strict';
// Minimal WAV reader: PCM 16/24/32-bit int and 32-bit float, any channel count (mixed to mono).

function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14)
      };
      if (fmt.format === 0xFFFE && size >= 26) fmt.format = buffer.readUInt16LE(body + 24); // extensible
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, buffer.length - body) };
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  const bytes = fmt.bits / 8;
  const frameBytes = bytes * fmt.channels;
  const frames = Math.floor(data.size / frameBytes);
  const out = new Float32Array(frames);
  const read = sampleReader(buffer, fmt);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += read(data.start + i * frameBytes + c * bytes);
    out[i] = s / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples: out };
}

function sampleReader(buf, fmt) {
  if (fmt.format === 3 && fmt.bits === 32) return function (o) { return buf.readFloatLE(o); };
  if (fmt.format === 1 && fmt.bits === 16) return function (o) { return buf.readInt16LE(o) / 32768; };
  if (fmt.format === 1 && fmt.bits === 24) return function (o) { return buf.readIntLE(o, 3) / 8388608; };
  if (fmt.format === 1 && fmt.bits === 32) return function (o) { return buf.readInt32LE(o) / 2147483648; };
  throw new Error('unsupported WAV format ' + fmt.format + '/' + fmt.bits + '-bit');
}

module.exports = { readWav };
