// Small source-derived preview parser, not a substitute for KiCad ERC/DRC.
export function parseSExpression(text) {
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid KiCad text size');
  let i = 0, nodes = 0;
  function value(depth = 0) {
    if (depth > 80 || ++nodes > 100_000) throw new Error('KiCad complexity limit');
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
    if (text[i] === '(') {
      i++; const list = [];
      while (true) {
        while (/\s/.test(text[i] ?? '') && i < text.length) i++;
        if (text[i] === ')') { i++; return list; }
        if (i >= text.length) throw new Error('Unclosed KiCad expression');
        list.push(value(depth + 1));
      }
    }
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') return JSON.parse(text.slice(start, i));
      }
      throw new Error('Unclosed KiCad string');
    }
    const start = i;
    while (i < text.length && !/[\s()]/.test(text[i])) i++;
    if (i === start) throw new Error('Unexpected KiCad token');
    const token = text.slice(start, i);
    return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token) ? Number(token) : token;
  }
  const root = value();
  if (text.slice(i).trim()) throw new Error('Trailing KiCad data');
  if (!Array.isArray(root)) throw new Error('Missing KiCad root');
  return root;
}
export const children = (node, name) => node.filter(item => Array.isArray(item) && item[0] === name);
export const child = (node, name) => children(node, name)[0];
export const properties = node => Object.fromEntries(children(node, 'property').map(p => [p[1], p[2]]));
export function boardModel(text) {
  const root = parseSExpression(text);
  if (root[0] !== 'kicad_pcb' || child(root, 'version')?.[1] !== 20240108) throw new Error('Expected KiCad 8 PCB');
  const footprints = children(root, 'footprint').map(fp => {
    const at = child(fp, 'at'), props = properties(fp);
    if (!at || !props.Reference || !props['Part Number']) throw new Error('Incomplete footprint');
    return { ref: props.Reference, value: props.Value, partNumber: props['Part Number'], x: at[1], y: at[2], node: fp,
      pads: children(fp, 'pad').map(p => {
        const pos = child(p, 'at'), size = child(p, 'size'), net = child(p, 'net');
        return { n: String(p[1]), shape: p[3], x: at[1] + pos[1], y: at[2] + pos[2], w: size[1], h: size[2], net: net[1], netName: net[2], layers: child(p, 'layers').slice(1), drill: child(p, 'drill')?.[1], node: p };
      }) };
  });
  const segments = children(root, 'segment').map(s => ({ a: child(s, 'start').slice(1), b: child(s, 'end').slice(1), width: child(s, 'width')[1], layer: child(s, 'layer')[1], net: child(s, 'net')[1] }));
  const vias = children(root, 'via').map(v => ({ at: child(v, 'at').slice(1), size: child(v, 'size')[1], drill: child(v, 'drill')[1], net: child(v, 'net')[1] }));
  return { root, footprints, segments, vias, nets: children(root, 'net').map(n => ({ id: n[1], name: n[2] })),
    outline: children(root, 'gr_line').filter(n => child(n, 'layer')[1] === 'Edge.Cuts').map(n => ({ a: child(n, 'start').slice(1), b: child(n, 'end').slice(1) })),
    texts: children(root, 'gr_text').map(n => ({ text: n[1], at: child(n, 'at').slice(1), size: child(child(child(n, 'effects'), 'font'), 'size')[1], layer: child(n, 'layer')[1] })) };
}
export function schematicModel(text) {
  const root = parseSExpression(text);
  if (root[0] !== 'kicad_sch' || child(root, 'version')?.[1] !== 20231120) throw new Error('Expected KiCad 8 schematic');
  const libs = new Map(children(child(root, 'lib_symbols'), 'symbol').map(s => [s[1], s]));
  const symbols = children(root, 'symbol').map(s => {
    const lib = libs.get(child(s, 'lib_id')[1]), at = child(s, 'at'), props = properties(s);
    if (!lib || !props['Part Number']) throw new Error('Missing embedded symbol or manufacturer number');
    return { ref: props.Reference, props, at: at.slice(1), node: s, lib,
      pins: children(lib, 'symbol').flatMap(unit => children(unit, 'pin')).map(p => ({ n: String(child(p, 'number')[1]), name: child(p, 'name')[1], at: child(p, 'at').slice(1), length: child(p, 'length')[1] })) };
  });
  return { root, symbols, wires: children(root, 'wire').map(w => children(child(w, 'pts'), 'xy').map(n => n.slice(1))), labels: children(root, 'label'), texts: children(root, 'text') };
}
export function usdCents(value) {
  if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) throw new Error('USD must have two decimal places');
  const [d, c] = value.split('.'); return BigInt(d) * 100n + BigInt(c);
}
export const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function safeSupplierURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['www.digikey.com', 'www.mouser.com', 'docs.oshpark.com'].includes(u.hostname)) throw new Error('Invalid supplier URL');
  return u.href;
}
export function validateBOM(bom) {
  if (bom.schemaVersion !== 1 || bom.currency !== 'USD' || !Array.isArray(bom.rows) || bom.rows.length > 100) throw new Error('Invalid BOM');
  let sum = 0n;
  for (const row of bom.rows) {
    if (!Number.isInteger(row.quantity) || row.quantity < 0 || !Array.isArray(row.references) || !row.references.length) throw new Error('Invalid BOM quantity/reference');
    safeSupplierURL(row.sourceUrl);
    const amount = usdCents(row.unitPrice) * BigInt(row.quantity);
    if (amount !== usdCents(row.lineTotal)) throw new Error('Incorrect line total');
    sum += amount;
  }
  if (sum !== usdCents(bom.pricing.partsAndPCB)) throw new Error('Incorrect BOM subtotal');
  const total = sum + usdCents(bom.pricing.shippingAllowance) + usdCents(bom.pricing.taxAllowance);
  if (total !== usdCents(bom.pricing.estimatedTotal)) throw new Error('Incorrect budget total');
  return { subtotal: sum, total, withinTarget: total <= usdCents(bom.pricing.target), withinGrant: total <= usdCents(bom.pricing.grantCap) };
}

// Acoustic FSK protocol engine. Bit-for-bit model of firmware/chirpkey8.ino:
// TCB0 toggles PA1/PA2 differentially, one 16 ms symbol per bit, MSB first,
// no UART framing. Frame: 4 x 0x55 preamble, 0xD3 sync byte, 5-byte payload
// {0x01, 0x08, 0x41, 0x52, sequence}, then CRC-8/SMBUS over the payload only.
export const FSK = Object.freeze({
  fcpuHz: 10_000_000,
  spaceHz: 2400,
  markHz: 3600,
  symbolMs: 16,
  preambleBytes: Object.freeze([0x55, 0x55, 0x55, 0x55]),
  syncByte: 0xD3,
  payloadPrefix: Object.freeze([0x01, 0x08, 0x41, 0x52]),
  payloadLength: 5,
  crcPoly: 0x07,
  crcInit: 0,
  frameBytes: 4 + 1 + 5 + 1,
  frameBits: (4 + 1 + 5 + 1) * 8,
});

export function crc8(data, crc = FSK.crcInit, poly = FSK.crcPoly) {
  for (const byte of typeof data === 'number' ? [data] : data) {
    crc ^= byte & 0xFF;
    for (let b = 0; b < 8; b++) crc = (crc & 0x80) ? ((crc << 1) ^ poly) & 0xFF : (crc << 1) & 0xFF;
  }
  return crc;
}

// carrier() in firmware writes TCB0.CCMP = (F_CPU + hz) / (2*hz) - 1 using
// integer division, then toggles on every compare match, so one full square
// cycle spans 2 * (CCMP + 1) clocks. These are the real emitted frequencies.
export function carrierHz(nominalHz, fcpuHz = FSK.fcpuHz) {
  const ccmp = Math.floor((fcpuHz + nominalHz) / (2 * nominalHz)) - 1;
  return { ccmp, hz: fcpuHz / (2 * (ccmp + 1)) };
}

export function encodeFrame(sequence, proto = FSK) {
  const frame = [...proto.preambleBytes, proto.syncByte, ...proto.payloadPrefix, sequence & 0xFF];
  frame.push(crc8(frame.slice(frame.length - proto.payloadLength)));
  return Uint8Array.from(frame);
}

export function frameBits(frame, proto = FSK) {
  const syncAt = proto.preambleBytes.length, payloadEnd = syncAt + 1 + proto.payloadLength;
  const role = i => i < syncAt ? 'preamble' : i === syncAt ? 'sync' : i < payloadEnd ? 'payload' : 'crc';
  const bits = [];
  frame.forEach((byte, i) => {
    for (let b = 7; b >= 0; b--) bits.push({ bit: (byte >> b) & 1, byte: i, bitInByte: 7 - b, role: role(i) });
  });
  return bits;
}

// bits: array of 0/1 or frameBits() entries. Returns Float32Array audio.
// clockDrift models an AVR clock running (1 + drift)x fast: carriers rise and
// symbol periods shrink by the same ratio. freqScale shifts tones only.
export function synthesize(bits, opts = {}) {
  const {
    sampleRate = 48000, amplitude = 0.5, shape = 'square',
    freqScale = 1, clockDrift = 0, leadSec = 0.05, trailSec = 0.05,
    firmwareCarriers = true, proto = FSK,
  } = opts;
  const base = h => (firmwareCarriers ? carrierHz(h, proto.fcpuHz).hz : h) * freqScale * (1 + clockDrift);
  const markHz = base(proto.markHz), spaceHz = base(proto.spaceHz);
  const symLen = Math.max(4, Math.round(sampleRate * proto.symbolMs / 1000 / (1 + clockDrift)));
  const lead = Math.round(leadSec * sampleRate), trail = Math.round(trailSec * sampleRate);
  const samples = new Float32Array(lead + bits.length * symLen + trail);
  for (let i = 0; i < bits.length; i++) {
    const raw = bits[i] && typeof bits[i] === 'object' ? bits[i].bit : bits[i];
    const f = raw ? markHz : spaceHz, off = lead + i * symLen;
    for (let s = 0; s < symLen; s++) {
      const w = Math.sin(2 * Math.PI * f * s / sampleRate);
      samples[off + s] = amplitude * (shape === 'sine' ? w : Math.sign(w) || 1);
    }
  }
  return { samples, sampleRate, symLen, lead, markHz, spaceHz, bitAmplitude: amplitude };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Adds white Gaussian noise so signal/noise power lands on snrDb. Seeded.
export function addAwgn(samples, snrDb, seed = 1) {
  const rng = mulberry32(seed);
  let acc = 0;
  for (const v of samples) acc += v * v;
  const noiseRms = Math.sqrt(acc / samples.length || 1e-12) * Math.pow(10, -snrDb / 20);
  const out = Float32Array.from(samples);
  for (let i = 0; i < out.length; i++) {
    let u = 0;
    while (u === 0) u = rng();
    out[i] += noiseRms * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }
  return out;
}

// Single-bin Goertzel power at `freq` over samples[start, start+length).
export function goertzelEnergy(samples, start, length, freq, sampleRate) {
  const w = 2 * Math.PI * freq / sampleRate, cw = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < length; i++) {
    const s0 = (samples[start + i] || 0) + cw * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - cw * s1 * s2;
}

const emptyDecode = reason => ({ ok: false, verified: false, reason, bits: [], symbols: [], bytes: new Uint8Array(0),
  payload: [], sequence: -1, crcReceived: -1, crcComputed: -1, crcOk: false, preambleOk: false, preambleMatches: 0, syncOk: false,
  startSample: -1, offsetSec: -1, minMarginDb: 0 });

// Demodulates one frame: activity onset scan, symbol-boundary search scored
// by the preamble+sync template, per-symbol mark/space Goertzel decisions,
// then CRC-8 verification. `ok` = sync + CRC proven; `verified` also requires
// an intact preamble (perfect reception).
export function decodeFrame(samples, opts = {}) {
  const { sampleRate = 48000, proto = FSK, firmwareCarriers = true } = opts;
  const markHz = firmwareCarriers ? carrierHz(proto.markHz, proto.fcpuHz).hz : proto.markHz;
  const spaceHz = firmwareCarriers ? carrierHz(proto.spaceHz, proto.fcpuHz).hz : proto.spaceHz;
  const symLen = Math.round(sampleRate * proto.symbolMs / 1000);
  const nBits = proto.frameBits, frameLen = nBits * symLen;
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) return emptyDecode('signal-not-finite');
  }
  if (samples.length < symLen * 2) return emptyDecode('signal-too-short');

  const half = Math.max(16, Math.floor(symLen / 2)), hop = Math.max(1, Math.floor(half / 2));
  let peak = 0;
  for (let s = 0; s + half <= samples.length; s += hop) {
    const e = goertzelEnergy(samples, s, half, markHz, sampleRate) + goertzelEnergy(samples, s, half, spaceHz, sampleRate);
    if (e > peak) peak = e;
  }
  if (!peak || peak < 1e-9) return emptyDecode('silence');
  const lastStart = samples.length - frameLen;
  if (lastStart < 0) return emptyDecode('frame-truncated');

  // Acquire: quarter-symbol windows of mark/space energy locate the frame
  // and its carrier transitions. The alternating 0x55 preamble toggles every
  // symbol, so least-squares on transition times recovers both the frame
  // start and the true symbol rate under clock drift.
  const template = frameBits(Uint8Array.from([...proto.preambleBytes, proto.syncByte]), proto).map(b => b.bit);
  const nominalSym = sampleRate * proto.symbolMs / 1000;
  const bitEnergy = (off, symR, i, out, mHz = markHz, sHz = spaceHz) => {
    const win = Math.round(symR * 0.8), st = Math.round(off + (i + 0.5) * symR - win / 2);
    if (st < 0 || st + win > samples.length) return false;
    out[0] = goertzelEnergy(samples, st, win, mHz, sampleRate);
    out[1] = goertzelEnergy(samples, st, win, sHz, sampleRate);
    return true;
  };
  const buf = [0, 0];
  const scaleScore = (off, symR) => {
    let score = 0;
    for (let i = 0; i < template.length; i++) {
      if (!bitEnergy(off, symR, i, buf)) return -Infinity;
      score += template[i] ? buf[0] - buf[1] : buf[1] - buf[0];
    }
    return score;
  };
  const rankCand = cand => {
    // A drifted transmitter shifts its carriers by the same ratio as its
    // symbol rate (one clock drives both), so each candidate alignment
    // evaluates tones at drift-scaled frequencies. This restores decisive
    // per-bit margins under clock drift, keeping the undecided-window gate
    // honest for wide sweeps.
    const rate = nominalSym / cand.symR;
    const mHz = markHz * rate, sHz = spaceHz * rate;
    const bytes = [];
    let undecided = 0;
    for (let by = 0; by < proto.frameBytes; by++) {
      let v = 0;
      for (let b = 0; b < 8; b++) {
        if (!bitEnergy(cand.off, cand.symR, by * 8 + b, buf, mHz, sHz)) return { rank: -Infinity };
        const hi = Math.max(buf[0], buf[1]), lo = Math.min(buf[0], buf[1]);
        // A window straddling a carrier transition hears both tones strongly;
        // a noise-dominated window also has a weak signal, so only windows
        // carrying real energy against the acquisition peak count.
        if (lo >= 0.25 * hi && hi >= 0.02 * peak) undecided++;
        v = (v << 1) | (buf[0] > buf[1] ? 1 : 0);
      }
      bytes.push(v);
    }
    const syncAt = proto.preambleBytes.length;
    const pm = proto.preambleBytes.reduce((n, p, i) => n + (bytes[i] === p ? 1 : 0), 0);
    const syncOkB = bytes[syncAt] === proto.syncByte;
    const crcOkB = crc8(bytes.slice(syncAt + 1, syncAt + 1 + proto.payloadLength)) === bytes[proto.frameBytes - 1];
    // A CRC-valid alignment is ground truth only when its 88 bit windows
    // actually decided a tone. A misaligned grid straddles carrier
    // transitions, so many of its windows hear both tones at once; a true
    // alignment decides every window except one genuinely jammed symbol.
    // Measured on this protocol: true alignments leave 0-1 undecided windows,
    // CRC-lucky phantom grids leave 8-16, so 4 separates them with margin.
    // Without this gate a phantom whose payload bytes happen to satisfy the
    // CRC outranks the true alignment and fake-verifies a corrupted frame.
    const trust = undecided < 4;
    const rank = (syncOkB && crcOkB && trust ? 1e15 : 0) + (syncOkB && trust ? 1e12 : 0)
      + (crcOkB && trust ? 1e9 : 0) + pm * 1e6 + cand.score;
    return { rank, undecided, driftScale: rate, ...cand };
  };

  const sub = Math.max(8, Math.floor(symLen / 4));
  const nWin = Math.floor(samples.length / sub);
  const dec = new Int8Array(nWin), eWin = new Float64Array(nWin);
  let wFloor = Infinity;
  for (let k = 0; k < nWin; k++) {
    const m = goertzelEnergy(samples, k * sub, sub, markHz, sampleRate);
    const s = goertzelEnergy(samples, k * sub, sub, spaceHz, sampleRate);
    dec[k] = m > s ? 1 : 0; eWin[k] = m + s;
    if (eWin[k] < wFloor) wFloor = eWin[k];
  }
  const thresh = Math.max(wFloor * 9, peak * 0.02);
  const live = k => k >= 0 && k < nWin && eWin[k] > thresh;

  // Carrier transitions: a decision flip between two above-floor windows is
  // a symbol boundary in the alternating preamble (or a same-bit run later).
  const bounds = [];
  for (let k = 1; k < nWin; k++) {
    if (dec[k] !== dec[k - 1] && live(k) && live(k - 1)) bounds.push(k);
    if (bounds.length >= 40) break;
  }

  // Symbol-rate estimate: the median consecutive transition gap, restricted
  // to gaps plausibly spanning 1-2 symbols (the preamble gives all-1 gaps).
  const diffs = [];
  for (let i = 1; i < bounds.length; i++) {
    const d = bounds[i] - bounds[i - 1];
    if (d >= 2 && d <= 10) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);
  const medGap = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
  const symEst = medGap ? medGap * sub : symLen;
  const singleGaps = diffs.filter(d => Math.abs(d - medGap) <= Math.max(1, Math.round(medGap * 0.25)));
  let winner = { rank: -Infinity };
  if (bounds.length >= 6 && singleGaps.length >= 4) {
    // Refine each boundary to ~8-sample precision: the carrier decision of a
    // short sliding window flips when its center crosses the transition.
    const w2 = Math.max(16, sub >> 1);
    const refineBound = k => {
      let prev = null;
      for (let s = k * sub - sub; s <= k * sub + sub; s += 8) {
        const m = goertzelEnergy(samples, s, w2, markHz, sampleRate);
        const sp = goertzelEnergy(samples, s, w2, spaceHz, sampleRate);
        const d = m > s ? 1 : 0;
        if (prev !== null && d !== prev) return s + w2 / 2;
        prev = d;
      }
      return k * sub;
    };
    // Least squares over consecutive one-symbol boundaries only: same-bit
    // runs later in the frame create wider gaps that would skew the fit.
    const use = [bounds[0]];
    for (let i = 1; i < bounds.length && use.length < 16; i++) {
      if (Math.abs(bounds[i] - bounds[i - 1] - medGap) <= Math.max(1, Math.round(medGap * 0.3))) use.push(bounds[i]);
      else break;
    }
    const times = use.map(refineBound);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    times.forEach((y, j) => { const x = j; sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const n = times.length, den = n * sxx - sx * sx;
    const period = den && n >= 3 ? (n * sxy - sx * sy) / den : symEst;
    const first = den ? (sy - period * sx) / n : times[0];
    // The first detected transition is one symbol after the frame start, but
    // an early boundary can be missed and the least-squares fit is biased
    // under clock drift: sweep generously around the fitted grid so the true
    // alignment is always enumerated. A symbol-rate candidate must land
    // within ~0.13% of the true rate or the accumulated window error at bit
    // 87 starts straddling carrier transitions, hence the 0.25% step; the
    // +/-2% range covers LSQ period bias well beyond the verified +/-3.5%
    // drift tolerance. CRC-lucky phantom grids the wide sweep invites are
    // demoted by the undecided-window gate inside rankCand.
    for (let back = 0; back <= 4; back++) {
      const offC = first - (back + 1) * period;
      for (let dOff = -96; dOff <= 96; dOff += 8) {
        const off0 = Math.round(offC + dOff);
        if (off0 < 0 || off0 > lastStart) continue;
        for (let ds = -0.02; ds <= 0.020001; ds += 0.0025) {
          const symR = period * (1 + ds);
          const r = rankCand({ off: off0, symR, score: scaleScore(off0, symR) });
          if (r.rank > winner.rank) winner = r;
        }
      }
    }
  }
  // Fallback when transition fitting fails (bursts, truncation, no clean
  // preamble): soft-correlation scan at the estimated symbol rate.
  if (!isFinite(winner.rank)) {
    const coarse = Math.max(1, Math.floor(symLen / 16));
    const topOffs = [];
    for (let off = 0; off <= lastStart; off += coarse) {
      let score = 0;
      for (let i = 0; i < template.length; i++) {
        const m = goertzelEnergy(samples, off + i * symEst, Math.round(symEst), markHz, sampleRate);
        const s = goertzelEnergy(samples, off + i * symEst, Math.round(symEst), spaceHz, sampleRate);
        score += template[i] ? m - s : s - m;
      }
      topOffs.push({ off, score });
    }
    topOffs.sort((a, b) => b.score - a.score);
    for (const { off: base } of topOffs.slice(0, 8)) {
      for (let ds = -0.08; ds <= 0.0801; ds += 0.01) {
        const symR = symEst * (1 + ds);
        for (let off = Math.max(0, base - coarse); off <= Math.min(lastStart, base + coarse); off += Math.max(1, Math.floor(coarse / 2))) {
          const r = rankCand({ off, symR, score: scaleScore(off, symR) });
          if (r.rank > winner.rank) winner = r;
        }
      }
    }
  }
  if (!isFinite(winner.rank)) return emptyDecode('no-sync');
  const off = winner.off, symR = winner.symR;
  const win = Math.round(symR * 0.8);
  const mHz = markHz * winner.driftScale, sHz = spaceHz * winner.driftScale;
  const symbols = [], bits = [];
  let minMarginDb = Infinity;
  for (let i = 0; i < nBits; i++) {
    const st = Math.round(off + (i + 0.5) * symR - win / 2);
    const m = goertzelEnergy(samples, st, win, mHz, sampleRate);
    const s = goertzelEnergy(samples, st, win, sHz, sampleRate);
    const bit = m > s ? 1 : 0, marginDb = 10 * Math.abs(Math.log10((m + 1e-30) / (s + 1e-30)));
    symbols.push({ bit, mark: m, space: s, marginDb, role: i < 32 ? 'preamble' : i < 40 ? 'sync' : i < 80 ? 'payload' : 'crc' });
    bits.push(bit);
    if (marginDb < minMarginDb) minMarginDb = marginDb;
  }
  const bytes = new Uint8Array(proto.frameBytes);
  for (let i = 0; i < proto.frameBytes; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    bytes[i] = v;
  }
  const syncAt = proto.preambleBytes.length;
  const preambleMatches = proto.preambleBytes.reduce((n, p, i) => n + (bytes[i] === p ? 1 : 0), 0);
  const preambleOk = preambleMatches === proto.preambleBytes.length;
  const syncOk = bytes[syncAt] === proto.syncByte;
  const payload = [...bytes.slice(syncAt + 1, syncAt + 1 + proto.payloadLength)];
  const crcReceived = bytes[proto.frameBytes - 1];
  const crcComputed = crc8(payload);
  const crcOk = crcReceived === crcComputed;
  return {
    ok: syncOk && crcOk, verified: syncOk && crcOk && preambleOk, bits, symbols, bytes, payload,
    sequence: payload[payload.length - 1] ?? -1, crcReceived, crcComputed, crcOk,
    preambleOk, preambleMatches, syncOk, startSample: off, offsetSec: off / sampleRate, minMarginDb,
    symbolSamples: symR,
  };
}

// Waveform-level tamper: jam one symbol window with a strong burst of the
// opposite protocol tone, as an acoustic interference attack on a receiver.
// When the caller passes a synthesize() result, its markHz/spaceHz already
// include the transmitter clock drift, so the burst models a jammer locked
// onto the same acquisition the decoder runs, not a blind nominal-tone burst.
export function attackBit(samples, bitIndex, o) {
  const { lead, symLen, sampleRate, amplitude = 1.2, proto = FSK } = o;
  const markHz = o.markHz ?? carrierHz(proto.markHz, proto.fcpuHz).hz;
  const spaceHz = o.spaceHz ?? carrierHz(proto.spaceHz, proto.fcpuHz).hz;
  const off = lead + bitIndex * symLen;
  if (off < 0 || off >= samples.length) throw new Error('attackBit out of range');
  const flipTo = goertzelEnergy(samples, off, symLen, markHz, sampleRate) > goertzelEnergy(samples, off, symLen, spaceHz, sampleRate) ? spaceHz : markHz;
  const out = Float32Array.from(samples);
  for (let i = 0; i < symLen && off + i < out.length; i++) out[off + i] += amplitude * Math.sin(2 * Math.PI * flipTo * i / sampleRate);
  return out;
}

// In-place radix-2 FFT; re/im are Float64Arrays of equal power-of-two length.
export function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Hann-windowed STFT magnitude spectrogram in dB, time-major columns.
export function spectrogram(samples, opts = {}) {
  const { sampleRate = 48000, size = 1024, hop = 512, minHz = 0, maxHz = 6000 } = opts;
  const binHz = sampleRate / size;
  const lo = Math.max(0, Math.floor(minHz / binHz)), hi = Math.min(size / 2, Math.ceil(maxHz / binHz));
  const cols = [];
  const hann = i => 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  for (let off = 0; off + size <= samples.length; off += hop) {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = samples[off + i] * hann(i);
    fftRadix2(re, im);
    const col = new Float32Array(hi - lo);
    for (let b = lo; b < hi; b++) col[b - lo] = 20 * Math.log10(Math.hypot(re[b], im[b]) / size + 1e-9);
    cols.push(col);
  }
  return { cols, binHz, lo, hi, hopSec: hop / sampleRate, size };
}

// Parses the firmware C source and extracts the wire protocol so tests and
// the web workbench stay pinned to what the ATtiny actually transmits.
export function parseFirmwareProtocol(ino) {
  const grab = (re, name) => {
    const m = ino.match(re);
    if (!m) throw new Error(`Firmware parse failed: ${name}`);
    return m;
  };
  const sendByteBody = grab(/sendByte\(uint8_t data\) \{([\s\S]*?)\n\}/, 'sendByte body')[1];
  const payloadBody = grab(/payload\[\] = \{([^}]+)\}/, 'payload literal')[1]
    .split(',').map(s => s.trim());
  const seqToken = payloadBody[payloadBody.length - 1];
  return {
    fcpuHz: Number(grab(/F_CPU != (\d+)UL/, 'F_CPU')[1]),
    spaceHz: Number(grab(/SPACE_HZ = (\d+)/, 'SPACE_HZ')[1]),
    markHz: Number(grab(/MARK_HZ = (\d+)/, 'MARK_HZ')[1]),
    symbolMs: Number(sendByteBody.match(/_delay_ms\((\d+)\)/)[1]),
    msbFirst: sendByteBody.includes('data & 0x80') && sendByteBody.includes('data <<= 1'),
    // One carrier() call inside an 8-iteration bit loop = 8 raw symbol
    // periods per byte, no start/stop framing bits appended anywhere.
    noUartFraming: (sendByteBody.match(/carrier\(/g) || []).length === 1
      && /for \(uint8_t bit = 0; bit < 8; bit\+\+\)/.test(sendByteBody)
      && !/0x7E/.test(ino.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')),
    preambleByte: Number(grab(/for \(uint8_t i = 0; i < \d+; i\+\+\) sendByte\((0x[0-9A-Fa-f]+)\)/, 'preamble')[1]),
    preambleCount: Number(grab(/for \(uint8_t i = 0; i < (\d+); i\+\+\) sendByte\(0x/, 'preamble count')[1]),
    syncByte: Number(grab(/sendByte\((0x[0-9A-Fa-f]+)\);\s*\/\/ sync/, 'sync byte')[1]),
    payloadConstants: payloadBody.slice(0, -1).map(h => Number(h)),
    payloadHasSequence: /sequence\+\+/.test(seqToken),
    payloadLength: payloadBody.length,
    crcPoly: Number(grab(/\(crc << 1\) \^ (0x[0-9A-Fa-f]+)/, 'crc poly')[1]),
    crcCoversPayloadOnly: /for \(uint8_t i = 0; i < sizeof\(payload\); i\+\+\) \{\s*crc = crc8\(crc, payload\[i\]\);/.test(ino),
    differentialDrive: /OUTTGL = PIEZO/.test(ino) && /PIN1_bm \| PIN2_bm/.test(ino),
    ccmpFormula: /TCB0\.CCMP = \(uint16_t\)\(\(F_CPU \+ hz\) \/ \(2UL \* hz\) - 1UL\)/.test(ino),
  };
}

// Compares parsed firmware constants against the JS protocol table.
export function firmwareParity(ino, proto = FSK) {
  const fw = parseFirmwareProtocol(ino);
  const problems = [];
  const eq = (name, a, b) => { if (a !== b) problems.push(`${name}: firmware ${a} vs JS ${b}`); };
  eq('fcpuHz', fw.fcpuHz, proto.fcpuHz);
  eq('spaceHz', fw.spaceHz, proto.spaceHz);
  eq('markHz', fw.markHz, proto.markHz);
  eq('symbolMs', fw.symbolMs, proto.symbolMs);
  eq('preambleCount', fw.preambleCount, proto.preambleBytes.length);
  for (const p of proto.preambleBytes) eq('preambleByte', fw.preambleByte, p);
  eq('syncByte', fw.syncByte, proto.syncByte);
  eq('payloadLength', fw.payloadLength, proto.payloadLength);
  eq('crcPoly', fw.crcPoly, proto.crcPoly);
  proto.payloadPrefix.forEach((b, i) => eq(`payloadPrefix[${i}]`, fw.payloadConstants[i], b));
  if (!fw.payloadHasSequence) problems.push('payload does not end with sequence++');
  if (!fw.msbFirst) problems.push('firmware is not MSB-first');
  if (!fw.crcCoversPayloadOnly) problems.push('CRC does not cover exactly the payload');
  if (!fw.differentialDrive) problems.push('piezo is not driven differentially');
  if (!fw.ccmpFormula) problems.push('TCB0.CCMP formula changed; carrierHz model is stale');
  return { ok: problems.length === 0, problems, firmware: fw };
}
