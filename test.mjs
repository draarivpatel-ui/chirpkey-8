import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { boardModel, schematicModel, validateBOM, FSK, crc8, carrierHz, encodeFrame, frameBits,
  synthesize, addAwgn, attackBit, goertzelEnergy, decodeFrame, fftRadix2, spectrogram,
  parseFirmwareProtocol, firmwareParity } from './core.js';
import { generatePack } from './tools/generate.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const bytes = (rel) => readFileSync(join(ROOT, rel));

function walk(dir = '.') {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
    const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

test('Deterministic generator matches all 18 checked-in artifacts', () => {
  const pack = generatePack();
  assert.equal(Object.keys(pack).length, 18);
  for (const [rel, expected] of Object.entries(pack)) {
    if (Buffer.isBuffer(expected)) {
      assert.equal(bytes(rel).equals(expected), true, `binary mismatch in ${rel}`);
    } else {
      assert.equal(read(rel), expected, `text mismatch in ${rel}`);
    }
  }
});

test('KiCad 8 PCB, schematic, and BOM models parse and cross-check', () => {
  const board = boardModel(read('chirpkey8.kicad_pcb'));
  const sch = schematicModel(read('chirpkey8.kicad_sch'));
  const bom = JSON.parse(read('bom.json'));
  const budget = validateBOM(bom);

  assert.equal(board.footprints.length, 11);
  assert.equal(board.segments.length, 338);
  assert.equal(board.vias.length, 10);
  assert.equal(board.outline.length, 4);
  assert.equal(sch.symbols.length, 11);
  assert.equal(budget.subtotal, 1144n);
  assert.equal(budget.total, 1740n);
  assert.equal(budget.withinTarget, true);
  assert.equal(budget.withinGrant, true);
});

const GBR_SPECS = [
  ['F_Cu', 'Copper,L1,Top', 'Positive'],
  ['B_Cu', 'Copper,L2,Bot', 'Positive'],
  ['F_Mask', 'Soldermask,Top', 'Negative'],
  ['B_Mask', 'Soldermask,Bot', 'Negative'],
  ['F_Paste', 'Paste,Top', 'Positive'],
  ['B_Paste', 'Paste,Bot', 'Positive'],
  ['F_SilkS', 'Legend,Top', 'Positive'],
  ['B_SilkS', 'Legend,Bot', 'Positive'],
  ['Edge_Cuts', 'Profile,NP', 'Positive']
];

test('RS-274X Gerber X2 set preserves solder-mask-covered TP1 electrode and plots silkscreen labels clear of pads', () => {
  for (const [sfx, fn, pol] of GBR_SPECS) {
    const rel = `gerbers/chirpkey8-${sfx}.gbr`;
    const t = read(rel);
    assert.match(t, /^G04 /);
    assert.ok(t.includes('%FSLAX46Y46*%'));
    assert.ok(t.includes('%MOMM*%'));
    assert.ok(t.includes(`%TF.FileFunction,${fn}*%`), `${rel} missing ${fn}`);
    assert.ok(t.includes(`%TF.FilePolarity,${pol}*%`), `${rel} missing ${pol}`);
    assert.ok(t.includes('%LPD*%'));
    assert.equal(t.includes('%LPC*%'), false);
    assert.ok(t.trimEnd().endsWith('M02*'));
  }

  // TP1 is the unique 8.400000 mm circular pad at (6.5, 17.8) -> Gerber (6500000, 6200000).
  const fCu = read('gerbers/chirpkey8-F_Cu.gbr');
  const fMask = read('gerbers/chirpkey8-F_Mask.gbr');
  const fPaste = read('gerbers/chirpkey8-F_Paste.gbr');
  const bCu = read('gerbers/chirpkey8-B_Cu.gbr');
  const fSilk = read('gerbers/chirpkey8-F_SilkS.gbr');
  const tp1Ap = fCu.match(/%ADD(\d+)C,8\.400000\*%/)?.[1];
  assert.ok(tp1Ap, '8.4 mm touch aperture present');
  const tp1Flash = `D${tp1Ap}*\nX6500000Y6200000D03*`;
  assert.ok(fCu.includes(tp1Flash), 'TP1 flashed on F.Cu');
  assert.equal(fMask.includes(tp1Flash), false, 'TP1 must stay covered on F.Mask');
  assert.equal(fPaste.includes(tp1Flash), false, 'TP1 must have no solder paste');
  assert.equal(bCu.includes(tp1Flash), false, 'B.Cu stays clear beneath TP1');

  // Every visible component reference and board label from KiCad must be rendered into F_SilkS.
  const board = boardModel(read('chirpkey8.kicad_pcb'));
  for (const fp of board.footprints) {
    assert.ok(fSilk.includes(`G04 SilkRef: ${fp.ref}*`), `F_SilkS missing reference ${fp.ref}`);
  }
  for (const txt of board.texts.filter(t => t.layer === 'F.SilkS')) {
    assert.ok(fSilk.includes(`G04 SilkText: ${txt.text}*`), `F_SilkS missing board label ${txt.text}`);
  }

  // Parse F_SilkS into outline strokes vs each SilkRef/SilkText group and verify ink-to-ink clearance
  // against exposed F.Mask pads, footprint silkscreen outlines + touch ring, board edges, and other labels.
  const maskPads = board.footprints.flatMap(fp => fp.pads.filter(pd => pd.layers.some(l => l.includes('Mask'))));
  assert.equal(maskPads.length, 27);
  const apWidth = { 10: 0.05, 11: 0.15, 12: 0.25, 13: 0.65, 14: 0.12 };
  const groups = [];
  let curGroup = { name: 'outline', segs: [] };
  groups.push(curGroup);
  let curX = 0, curY = 0, curAp = 11, segCount = 0;
  for (const line of fSilk.split('\n')) {
    if (line.startsWith('G04 Silk')) {
      curGroup = { name: line.slice(4, -1), segs: [] };
      groups.push(curGroup);
      continue;
    }
    const am = line.match(/^D(\d+)\*$/);
    if (am) {
      curAp = Number(am[1]);
      if (curAp === 11 && curGroup.name !== 'outline') {
        curGroup = { name: 'outline', segs: [] };
        groups.push(curGroup);
      }
      continue;
    }
    const m = line.match(/^X(-?\d+)Y(-?\d+)D0([12])\*$/);
    if (!m) continue;
    const nx = Number(m[1]) / 1e6, ny = 24 - Number(m[2]) / 1e6;
    if (m[3] === '1') {
      segCount++;
      assert.ok(nx >= 0.2 && nx <= 31.8 && ny >= 0.2 && ny <= 23.8, `Silk stroke out of board bounds at (${nx}, ${ny})`);
      curGroup.segs.push([curX, curY, nx, ny, apWidth[curAp] || 0.15]);
      for (let t = 0; t <= 8; t++) {
        const sx = curX + (nx - curX) * (t / 8), sy = curY + (ny - curY) * (t / 8);
        for (const pd of maskPads) {
          const hit = Math.abs(sx - pd.x) < pd.w / 2 + 0.08 && Math.abs(sy - pd.y) < pd.h / 2 + 0.08;
          assert.equal(hit, false, `F_SilkS stroke (${sx.toFixed(2)}, ${sy.toFixed(2)}) overlaps pad ${pd.netName} at (${pd.x}, ${pd.y})`);
        }
      }
    }
    curX = nx; curY = ny;
  }
  assert.ok(segCount > 300, `Expected rich vector silkscreen strokes, got ${segCount}`);

  const ptSegDist = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const segSegDist = (a, b) => {
    const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
    const o1 = orient(x1, y1, x2, y2, x3, y3), o2 = orient(x1, y1, x2, y2, x4, y4);
    const o3 = orient(x3, y3, x4, y4, x1, y1), o4 = orient(x3, y3, x4, y4, x2, y2);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
    return Math.min(ptSegDist(x1, y1, x3, y3, x4, y4), ptSegDist(x2, y2, x3, y3, x4, y4), ptSegDist(x3, y3, x1, y1, x2, y2), ptSegDist(x4, y4, x1, y1, x2, y2));
  };
  const outlines = groups.filter(g => g.name === 'outline').flatMap(g => g.segs);
  const textGroups = groups.filter(g => g.name !== 'outline');
  assert.equal(textGroups.length, 19);
  for (const tg of textGroups) {
    for (const s of tg.segs) {
      for (const o of outlines) {
        const inkGap = segSegDist(s, o) - (s[4] + o[4]) / 2;
        assert.ok(inkGap >= 0.20, `${tg.name} overlaps/crowds outline (${inkGap.toFixed(3)} mm)`);
      }
      for (const og of textGroups) {
        if (og === tg) continue;
        for (const os of og.segs) {
          const inkGap = segSegDist(s, os) - (s[4] + os[4]) / 2;
          assert.ok(inkGap >= 0.20, `${tg.name} crowds ${og.name} (${inkGap.toFixed(3)} mm)`);
        }
      }
    }
  }
});

test('Excellon PTH drill and chirpkey8-gerbers.zip have 13 holes and 10 entries', () => {
  const drl = read('gerbers/chirpkey8.drl');
  assert.match(drl, /^M48/m);
  assert.ok(drl.includes('T1C0.300'));
  assert.ok(drl.includes('T2C1.000'));
  assert.equal((drl.match(/^X[\d.]+Y[\d.]+$/gm) || []).length, 13);
  assert.ok(drl.trimEnd().endsWith('M30'));

  const zb = bytes('chirpkey8-gerbers.zip');
  assert.equal(zb.readUInt32LE(0), 0x04034b50);
  const eocd = zb.length - 22;
  assert.equal(zb.readUInt32LE(eocd), 0x06054b50);
  assert.equal(zb.readUInt16LE(eocd + 10), 10);
});

test('STEP + STL snap-fit enclosure manifold pocket, firmware, docs, and text hygiene match specifications', () => {
  const step = read('cad/chirpkey8_enclosure.step');
  assert.ok(step.includes("PRODUCT('chirpkey8_enclosure','ChirpKey-8 Pocket Enclosure'"));
  assert.equal(step.includes('Orpheus'), false);
  assert.ok(step.includes('MANIFOLD_SOLID_BREP'));
  assert.ok(step.includes('CLOSED_SHELL'));

  // Parse STEP CARTESIAN_POINTs, EDGE_CURVEs, ORIENTED_EDGEs, and ADVANCED_FACEs to prove 36x28x7.6 mm cavity,
  // opposing 23.50 mm snap-clip throat above Z = 5.0 mm PCB top, and closed genus-0 B-rep (V - E + F = 2).
  const stepPts = [...step.matchAll(/CARTESIAN_POINT\('',\(([-\d.]+),([-\d.]+),([-\d.]+)\)\)/g)]
    .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
  const xs = [...new Set(stepPts.map(p => p[0]))].sort((a, b) => a - b);
  const ys = [...new Set(stepPts.map(p => p[1]))].sort((a, b) => a - b);
  const zs = [...new Set(stepPts.map(p => p[2]))].sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 1.8, 3, 14, 22, 33, 34.2, 36]);
  assert.deepEqual(ys, [0, 1.8, 2.25, 3, 25, 25.75, 26.2, 28]);
  assert.deepEqual(zs, [0, 1.8, 3.4, 5.1, 5.35, 5.8, 7.6]);

  const edgeCurves = [...step.matchAll(/#(\d+)=EDGE_CURVE\(/g)].map(m => m[1]);
  const faces = [...step.matchAll(/#(\d+)=ADVANCED_FACE\(/g)];
  assert.equal(stepPts.length - edgeCurves.length + faces.length, 2, 'STEP B-rep must satisfy V - E + F = 2');
  for (const eid of edgeCurves) {
    assert.equal(step.includes(`ORIENTED_EDGE('',*,*,#${eid},.T.)`), true, `Edge #${eid} missing .T. half-edge`);
    assert.equal(step.includes(`ORIENTED_EDGE('',*,*,#${eid},.F.)`), true, `Edge #${eid} missing .F. half-edge`);
  }

  // Parse STL triangles and verify closed watertight manifold + outward normals + analytic volume (3287.868 mm^3).
  const stl = read('cad/chirpkey8_enclosure.stl');
  const tris = [...stl.matchAll(/facet normal\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+outer loop\s+vertex\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+vertex\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+vertex\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)]
    .map(m => ({ n: [+m[1], +m[2], +m[3]], v: [[+m[4], +m[5], +m[6]], [+m[7], +m[8], +m[9]], [+m[10], +m[11], +m[12]]] }));
  let signedVol6 = 0;
  const halfEdges = new Set();
  for (const { n, v: [a, b, c] } of tris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const clen = Math.hypot(cx, cy, cz);
    assert.ok(clen > 1e-6, 'Non-degenerate triangle area');
    const dot = (cx * n[0] + cy * n[1] + cz * n[2]) / clen;
    assert.ok(Math.abs(dot - 1) < 1e-5, `STL facet normal misaligned with right-hand winding: dot=${dot}`);
    signedVol6 += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = `${p.join(',')}->${q.join(',')}`;
      assert.equal(halfEdges.has(k), false, `Duplicate half-edge ${k}`);
      halfEdges.add(k);
    }
  }
  for (const k of halfEdges) {
    const [p, q] = k.split('->');
    assert.equal(halfEdges.has(`${q}->${p}`), true, `Unpaired boundary half-edge ${k}`);
  }
  const baseVol = 36 * 28 * 7.6 - 32.4 * 24.4 * 4.2 - 30 * 22 * 1.6;
  const clipsVol = 2 * (8.0 * 0.45 * 0.25 + 0.5 * 8.0 * 0.45 * 0.45);
  const expectedVol = baseVol + clipsVol;
  assert.ok(Math.abs(signedVol6 / 6 - expectedVol) < 1e-6, `Volume mismatch: ${signedVol6 / 6} vs ${expectedVol}`);

  const ino = read('firmware/chirpkey8.ino');
  assert.ok(ino.includes('F_CPU != 10000000UL'));
  assert.ok(ino.includes('SPACE_HZ = 2400'));
  assert.ok(ino.includes('MARK_HZ = 3600'));
  assert.ok(ino.includes('0x07'));

  const readme = read('README.md');
  for (const mpn of ['ATtiny412-SSNR', 'CMT-1203-SMT-TR', 'LTST-C171KRKT', 'C0805C104K5RACTU', 'RC0805FR-0710KL', 'RC0805FR-07220RL', 'B3U-1000P', 'M20-9990345']) {
    assert.ok(readme.includes(mpn), `README missing ${mpn}`);
  }
  assert.ok(read('LICENSE').includes('MIT License'));

  for (const rel of walk()) {
    if (rel.endsWith('.png') || rel.endsWith('.zip')) continue;
    let s;
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes(rel)); }
    catch { continue; }
    assert.equal(s.includes('\u2014'), false, `em dash in ${rel}`);
    assert.equal(s.includes('\u2013'), false, `en dash in ${rel}`);
    if (rel.endsWith('.md')) {
      const stripped = s.replace(/`[^`]*`/g, '');
      const unquoted = stripped.match(/\$\d[\d,.]*/g) || [];
      assert.equal(unquoted.length, 0, `unquoted dollar figure in ${rel}: ${unquoted.join(', ')}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Acoustic FSK protocol + DSP suite (Wave 1)
// ---------------------------------------------------------------------------
const FS = 48000;
const SYM = Math.round(FS * FSK.symbolMs / 1000);
const frame = seq => encodeFrame(seq);
const synthBits = (seq, opts = {}) => synthesize(frameBits(frame(seq)), { sampleRate: FS, ...opts });

test('CRC-8/SMBUS matches the published 0xF4 check vector', () => {
  assert.equal(crc8([...'123456789'].map(c => c.charCodeAt(0))), 0xF4);
});

for (const seq of [0, 1, 7, 42, 127, 200, 255]) {
  test(`encodeFrame(${seq}) appends CRC-8 of the 5-byte payload`, () => {
    const f = frame(seq);
    assert.equal(f.length, 11);
    assert.equal(f[9], seq);
    assert.equal(f[10], crc8(f.slice(5, 10)));
  });
}

test('frame layout is 4 preamble + 1 sync + 5 payload + 1 CRC, 88 bits MSB-first', () => {
  const bits = frameBits(frame(0xA5));
  assert.equal(bits.length, 88);
  assert.deepEqual(bits.slice(0, 8).map(b => b.bit), [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.equal(bits[32].role, 'sync');
  assert.equal(bits[40].role, 'payload');
  assert.equal(bits[80].role, 'crc');
  assert.equal(bits[87].role, 'crc');
});

test('CRC covers exactly the payload, not the sync byte', () => {
  const f = frame(9);
  const mutated = Uint8Array.from(f);
  mutated[4] ^= 0xFF;
  assert.equal(crc8(mutated.slice(5, 10)), f[10], 'sync byte mutation must not change CRC');
  mutated[5] ^= 0x01;
  assert.notEqual(crc8(mutated.slice(5, 10)), f[10], 'payload mutation must change CRC');
});

// Every single-bit corruption of the 40 payload bits is caught.
for (let bit = 0; bit < 40; bit++) {
  test(`CRC detects payload bit ${bit} corrupted`, () => {
    const f = frame(77);
    const mutated = Uint8Array.from(f);
    mutated[5 + Math.floor(bit / 8)] ^= 1 << (7 - (bit % 8));
    assert.notEqual(crc8(mutated.slice(5, 10)), f[10]);
  });
}

// Every single-bit corruption of the CRC byte itself is caught.
for (let bit = 0; bit < 8; bit++) {
  test(`CRC detects CRC-byte bit ${bit} corrupted`, () => {
    const f = frame(200);
    const received = f[10] ^ (1 << bit);
    assert.notEqual(received, crc8(f.slice(5, 10)));
  });
}

test('CRC detects an 8-bit burst error spanning two payload bytes', () => {
  const f = frame(3);
  const mutated = Uint8Array.from(f);
  mutated[6] ^= 0xF0; mutated[7] ^= 0x0F;
  assert.notEqual(crc8(mutated.slice(5, 10)), f[10]);
});

test('CRC detects sampled double-bit errors in the payload', () => {
  const f = frame(90);
  const combos = [[0, 7], [3, 19], [12, 30], [8, 39], [1, 2], [22, 23]];
  for (const [a, b] of combos) {
    const mutated = Uint8Array.from(f);
    mutated[5 + Math.floor(a / 8)] ^= 1 << (7 - (a % 8));
    mutated[5 + Math.floor(b / 8)] ^= 1 << (7 - (b % 8));
    assert.notEqual(crc8(mutated.slice(5, 10)), f[10], `bits ${a},${b}`);
  }
});

test('CCMP integer math gives the real carriers 2400.38 Hz and 3599.71 Hz', () => {
  const space = carrierHz(2400), mark = carrierHz(3600);
  assert.equal(space.ccmp, 2082);
  assert.equal(mark.ccmp, 1388);
  assert.ok(Math.abs(space.hz - 2400.384061449832) < 1e-9);
  assert.ok(Math.abs(mark.hz - 3599.712023038157) < 1e-9);
});

test('firmware C source parses to the same protocol constants as the JS engine', () => {
  const fw = parseFirmwareProtocol(read('firmware/chirpkey8.ino'));
  assert.equal(fw.fcpuHz, FSK.fcpuHz);
  assert.equal(fw.spaceHz, FSK.spaceHz);
  assert.equal(fw.markHz, FSK.markHz);
  assert.equal(fw.symbolMs, FSK.symbolMs);
  assert.equal(fw.preambleByte, 0x55);
  assert.equal(fw.preambleCount, 4);
  assert.equal(fw.syncByte, 0xD3);
  assert.deepEqual(fw.payloadConstants, [0x01, 0x08, 0x41, 0x52]);
  assert.equal(fw.crcPoly, 0x07);
  assert.equal(fw.payloadLength, 5);
});

test('firmwareParity reports zero divergence from the JS protocol table', () => {
  const p = firmwareParity(read('firmware/chirpkey8.ino'));
  assert.deepEqual(p.problems, []);
  assert.equal(p.ok, true);
});

test('firmware bit order is MSB-first with no UART framing and differential piezo drive', () => {
  const fw = parseFirmwareProtocol(read('firmware/chirpkey8.ino'));
  assert.equal(fw.msbFirst, true);
  assert.equal(fw.noUartFraming, true);
  assert.equal(fw.differentialDrive, true);
  assert.equal(fw.crcCoversPayloadOnly, true);
  assert.equal(fw.ccmpFormula, true);
});

test('JS encoder emits byte-for-byte what the C transmit() loop emits', () => {
  // Simulates the firmware loop: 4 x sendByte(0x55), sendByte(0xD3), payload, CRC.
  const seq = 0xAB;
  const cPayload = [0x01, 0x08, 0x41, 0x52, seq];
  let crc = 0;
  const cFrame = [0x55, 0x55, 0x55, 0x55, 0xD3];
  for (const b of cPayload) { crc = crc8(crc, b); cFrame.push(b); }
  cFrame.push(crc);
  assert.deepEqual([...frame(seq)], cFrame);
});

test('frame duration is 11 bytes x 8 bits x 16 ms = 1408 ms', () => {
  assert.equal(FSK.frameBytes, 11);
  assert.equal(FSK.frameBits, 88);
  assert.equal(FSK.frameBits * FSK.symbolMs, 1408);
});

for (const seq of [0, 1, 42, 255]) {
  test(`clean square-wave round-trip decodes seq ${seq} with CRC pass`, () => {
    const d = decodeFrame(synthBits(seq).samples, { sampleRate: FS });
    assert.equal(d.ok, true);
    assert.equal(d.verified, true);
    assert.equal(d.sequence, seq);
    assert.equal(d.crcOk, true);
  });
}

test('sine-wave round-trip also decodes (real piezo band-limits the square)', () => {
  const d = decodeFrame(synthBits(33, { shape: 'sine' }).samples, { sampleRate: FS });
  assert.equal(d.ok, true);
  assert.equal(d.sequence, 33);
});

for (const amp of [0.02, 0.1, 1.5]) {
  test(`amplitude ${amp}x still decodes (Goertzel decisions are scale-free)`, () => {
    const d = decodeFrame(synthBits(5, { amplitude: amp }).samples, { sampleRate: FS });
    assert.equal(d.ok, true);
    assert.equal(d.sequence, 5);
  });
}

test('leading and trailing silence do not break acquisition', () => {
  const d = decodeFrame(synthBits(19, { leadSec: 0.4, trailSec: 0.3 }).samples, { sampleRate: FS });
  assert.equal(d.ok, true);
  assert.equal(d.sequence, 19);
  assert.ok(d.offsetSec > 0.3);
});

for (const rate of [16000, 22050, 44100]) {
  test(`round-trip decodes at ${rate} Hz sample rate`, () => {
    const d = decodeFrame(synthBits(12, { sampleRate: rate }).samples, { sampleRate: rate });
    assert.equal(d.ok, true);
    assert.equal(d.sequence, 12);
  });
}

for (const drift of [0.005, 0.01, -0.01, 0.015, -0.015, 0.02, -0.02, 0.03, -0.03]) {
  test(`clock drift ${drift > 0 ? '+' : ''}${drift * 100}% decodes (symbol-rate tracking)`, () => {
    const s = synthBits(7, { clockDrift: drift });
    const d = decodeFrame(s.samples, { sampleRate: FS });
    assert.equal(d.ok, true, `off=${d.startSample} symR=${d.symbolSamples}`);
    assert.equal(d.sequence, 7);
  });
}

test('decoder honestly rejects frames beyond the verified drift tolerance', () => {
  for (const drift of [0.06, -0.06]) {
    const d = decodeFrame(synthBits(7, { clockDrift: drift }).samples, { sampleRate: FS });
    assert.equal(d.ok, false, `drift ${drift} should not verify`);
  }
});

for (const snr of [20, 10, 0, -5]) {
  test(`AWGN at ${snr} dB SNR decodes on every seed`, () => {
    const s = synthBits(55);
    for (let seed = 1; seed <= 4; seed++) {
      const d = decodeFrame(addAwgn(s.samples, snr, seed * 7919), { sampleRate: FS });
      assert.equal(d.ok, true, `seed ${seed}`);
      assert.equal(d.sequence, 55);
    }
  });
}

test('AWGN at -10 dB SNR decodes on most seeds (honest noise floor)', () => {
  const s = synthBits(55);
  let ok = 0;
  for (let seed = 1; seed <= 6; seed++) ok += decodeFrame(addAwgn(s.samples, -10, seed * 7919), { sampleRate: FS }).ok;
  assert.ok(ok >= 3, `${ok}/6 decoded at -10 dB`);
});

test('pure white noise yields no valid frame', () => {
  const noise = addAwgn(new Float32Array(FS), 0, 1234);
  const d = decodeFrame(noise, { sampleRate: FS });
  assert.equal(d.ok, false);
});

test('pure silence is rejected as silence, not decoded', () => {
  const d = decodeFrame(new Float32Array(FS), { sampleRate: FS });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'silence');
});

test('a truncated frame is rejected, never half-verified', () => {
  const s = synthBits(9);
  const d = decodeFrame(s.samples.slice(0, Math.floor(s.samples.length * 0.6)), { sampleRate: FS });
  assert.equal(d.ok, false);
});

// A jammed payload bit must flip the decoded bit and be caught by CRC-8.
for (const target of [40, 47, 55, 60, 66, 71, 79, 84]) {
  test(`jamming payload-region bit ${target} flips it and CRC rejects the frame`, () => {
    const s = synthBits(100);
    const truth = frameBits(frame(100));
    const d = decodeFrame(attackBit(s.samples, target, s), { sampleRate: FS });
    assert.equal(d.syncOk, true, 'sync must survive a single jammed symbol');
    assert.notEqual(d.bits[target], truth[target].bit, 'jammed bit must flip at the detector');
    assert.equal(d.crcOk, false, 'CRC must catch the tamper');
    assert.equal(d.ok, false);
  });
}

test('jamming under clock drift is still caught', () => {
  const s = synthBits(100, { clockDrift: 0.02 });
  const d = decodeFrame(attackBit(s.samples, 60, s), { sampleRate: FS });
  assert.equal(d.syncOk, true, 'sync must survive a single jammed symbol');
  assert.equal(d.crcOk, false, 'CRC must reject the tampered frame');
  assert.equal(d.ok, false);
});

test('replay detection: the same sequence decoded twice is flaggable', () => {
  const a = decodeFrame(synthBits(77).samples, { sampleRate: FS });
  const b = decodeFrame(synthBits(77).samples, { sampleRate: FS });
  assert.equal(a.sequence, b.sequence);
  assert.equal(a.sequence === b.sequence, true, 'receiver sees a repeated counter');
});

test('Goertzel isolates a tone bin from the adjacent FSK bin', () => {
  const s = synthesize([{ bit: 1, role: 'mark' }], { sampleRate: FS }); // single mark symbol
  const eMark = goertzelEnergy(s.samples, s.lead, s.symLen, s.markHz, FS);
  const eSpace = goertzelEnergy(s.samples, s.lead, s.symLen, s.spaceHz, FS);
  assert.ok(eMark > eSpace * 50, `mark/space ratio ${eMark / eSpace}`);
  const s2 = synthesize([{ bit: 0, role: 'space' }], { sampleRate: FS });
  const eMark2 = goertzelEnergy(s2.samples, s2.lead, s2.symLen, s2.markHz, FS);
  const eSpace2 = goertzelEnergy(s2.samples, s2.lead, s2.symLen, s2.spaceHz, FS);
  assert.ok(eSpace2 > eMark2 * 50, `space/mark ratio ${eSpace2 / eMark2}`);
});

test('radix-2 FFT matches a direct DFT on a small input', () => {
  const n = 16;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + i * 0.1);
  const im = new Float64Array(n);
  const re2 = Float64Array.from(re), im2 = Float64Array.from(im);
  fftRadix2(re2, im2);
  for (let k = 0; k < n; k++) {
    let xr = 0, xi = 0;
    for (let t = 0; t < n; t++) { const a = -2 * Math.PI * k * t / n; xr += re[t] * Math.cos(a); xi += re[t] * Math.sin(a); }
    assert.ok(Math.abs(re2[k] - xr) < 1e-8 && Math.abs(im2[k] - xi) < 1e-8, `bin ${k}`);
  }
});

test('spectrogram puts frame energy on the mark and space carrier bins', () => {
  const s = synthBits(0xAA);
  const spec = spectrogram(s.samples, { sampleRate: FS, size: 1024, hop: 512, minHz: 1000, maxHz: 5000 });
  const binOf = hz => Math.round(hz / spec.binHz) - spec.lo;
  const midCol = spec.cols[Math.floor(spec.cols.length / 2)];
  const markBin = binOf(3600), spaceBin = binOf(2400);
  const top = Math.max(...midCol);
  assert.ok(midCol[markBin] > top - 12 || midCol[spaceBin] > top - 12, 'a carrier rail carries the peak');
});

test('Gerber zip contains exactly the 10 plotted entries, byte-identical to disk', () => {
  const zb = bytes('chirpkey8-gerbers.zip');
  const eocd = zb.length - 22;
  assert.equal(zb.readUInt32LE(eocd), 0x06054b50);
  const count = zb.readUInt16LE(eocd + 10), cdOff = zb.readUInt32LE(eocd + 16);
  assert.equal(count, 10);
  const names = [];
  for (let i = 0, p = cdOff; i < count; i++) {
    assert.equal(zb.readUInt32LE(p), 0x02014b50);
    const nlen = zb.readUInt16LE(p + 28), elen = zb.readUInt16LE(p + 30), clen = zb.readUInt16LE(p + 32);
    const name = zb.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lh = zb.readUInt32LE(p + 42);
    assert.equal(zb.readUInt32LE(lh), 0x04034b50);
    const nlen2 = zb.readUInt16LE(lh + 26), elen2 = zb.readUInt16LE(lh + 28);
    const method = zb.readUInt16LE(lh + 8), csize = zb.readUInt32LE(lh + 18);
    const data = zb.slice(lh + 30 + nlen2 + elen2, lh + 30 + nlen2 + elen2 + csize);
    const raw = method === 8 ? inflateRawSync(data) : data;
    const disk = bytes(`gerbers/${name}`);
    assert.ok(disk.equals(raw), `zip entry ${name} differs from disk`);
    names.push(name);
    p += 46 + nlen + elen + clen;
  }
  assert.deepEqual(names.sort(), readdirSync(join(ROOT, 'gerbers')).sort());
});

test('every BOM reference resolves to a real PCB footprint and README lists every MPN', () => {
  const board = boardModel(read('chirpkey8.kicad_pcb'));
  const bom = JSON.parse(read('bom.json'));
  const refs = new Set(board.footprints.map(f => f.ref));
  for (const row of bom.rows) {
    if (row.references[0] === 'PCB') continue;
    for (const ref of row.references) assert.ok(refs.has(ref), `BOM ref ${ref} missing on PCB`);
  }
  const readme = read('README.md');
  for (const row of bom.rows) assert.ok(readme.includes(row.partNumber), `README missing ${row.partNumber}`);
});

test('bom.csv and bom.json carry identical rows and totals', () => {
  const bom = JSON.parse(read('bom.json'));
  const csv = read('bom.csv').trim().split('\n');
  assert.equal(csv.length - 1, bom.rows.length);
  for (const row of bom.rows) {
    const line = csv.find(l => l.includes(`"${row.partNumber}"`) && l.includes(`"${row.lineTotal}"`));
    assert.ok(line, `csv row missing or mismatched for ${row.partNumber} (${row.lineTotal})`);
  }
  assert.equal(bom.pricing.partsAndPCB, '11.44');
  assert.equal(bom.pricing.estimatedTotal, '17.40');
});

// ---------------------------------------------------------------------------
// UI + hygiene invariants
// ---------------------------------------------------------------------------
const html = read('index.html');
const app = read('app.js');
const css = read('style.css');

test('every element id app.js queries exists in index.html', () => {
  const ids = new Set([...app.matchAll(/\$\('([a-z0-9-]+)'\)/gi)].map(m => m[1]));
  assert.ok(ids.size > 20, 'expected the app to query many ids');
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `missing #${id} in index.html`);
});

test('workbench exposes the one-click transmit flow and all three visualizations', () => {
  for (const id of ['tx-btn', 'play-btn', 'verdict', 'framemap', 'wave', 'goertzel', 'spectro', 'snr', 'drift', 'tamper', 'replay', 'wb-stats', 'wb-truth']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});

test('every named app.js import actually exists in core.js exports', () => {
  const m = app.match(/import \{([\s\S]*?)\} from '\.\/core\.js'/);
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const src = read('core.js');
  for (const name of names) assert.ok(new RegExp(`export (?:const|function) ${name}\\b`).test(src), `core.js does not export ${name}`);
});

test('no smooth-scroll behavior, favicon declared, no tagline under the h1', () => {
  assert.equal(css.includes('scroll-behavior:smooth'), false);
  assert.equal(css.includes('scroll-behavior: smooth'), false);
  assert.ok(html.includes('rel="icon"'), 'favicon prevents a 404 console error');
  const headerInner = html.match(/<header>([\s\S]*?)<\/header>/)[1];
  assert.equal(headerInner.includes('<p>'), false, 'tagline under the title is not allowed');
});

test('revamp surfaces carry no AI-tool mentions (frozen KiCad artifacts excluded)', () => {
  const pat = /\bAI\b|artificial intelligence|chatgpt|claude|copilot|\bllm\b/i;
  for (const rel of ['index.html', 'README.md', 'app.js', 'core.js', 'firmware/chirpkey8.ino']) {
    assert.equal(pat.test(read(rel)), false, `AI mention found in ${rel}`);
  }
});

test('key text/background pairs meet WCAG 4.5:1 contrast', () => {
  const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const [fg, bg, name] of [
    ['#e6eee9', '#101719', 'ink on bg'], ['#a9bbb5', '#101719', 'muted on bg'],
    ['#a9bbb5', '#182225', 'muted on panel'], ['#c8ec86', '#101719', 'accent on bg'],
    ['#e6eee9', '#203035', 'ink on button'], ['#d4c4a9', '#292922', 'notice text'],
    ['#c8ec86', '#34453a', 'active tab'],
  ]) assert.ok(ratio(fg, bg) >= 4.5, `${name}: ${ratio(fg, bg).toFixed(2)}`);
});

// ---------------------------------------------------------------------------
// Wave 2 hardening regressions
// ---------------------------------------------------------------------------
test('NaN or Infinity in the audio buffer is rejected, never decoded', () => {
  const s = synthBits(9).samples;
  for (const [name, poison] of [['NaN', NaN], ['Infinity', Infinity]]) {
    const bad = Float32Array.from(s);
    bad[3000] = poison;
    const d = decodeFrame(bad, { sampleRate: FS });
    assert.equal(d.ok, false, `${name}-poisoned buffer must not decode`);
    assert.equal(d.reason, 'signal-not-finite');
    assert.equal(d.verified, false);
  }
});

// Single-bit payload mutations must never fake-verify: the decoder's
// alignment search used to accept a CRC-lucky misaligned grid whose windows
// straddle carrier transitions. The undecided-window gate demotes those.
for (let k = 0; k < 6; k++) {
  const seq = (37 * k + 11) & 0xFF;
  for (let byteIdx = 5; byteIdx <= 10; byteIdx++) {
    for (let bit = 0; bit < 8; bit++) {
      test(`mutated frame byte ${byteIdx} bit ${bit} (seq ${seq}) never fake-verifies`, () => {
        const f = frame(seq);
        const mut = Uint8Array.from(f);
        mut[byteIdx] ^= 1 << (7 - bit);
        const bits = [];
        mut.forEach(byte => { for (let b = 7; b >= 0; b--) bits.push({ bit: (byte >> b) & 1, role: 'payload' }); });
        const s = synthesize(bits, { sampleRate: FS });
        const d = decodeFrame(s.samples, { sampleRate: FS });
        // A single-bit corruption anywhere in the CRC-protected region
        // (payload bytes 5..9 plus the CRC byte itself) must be rejected.
        assert.equal(d.ok, false, `fake verify at byte ${byteIdx} bit ${bit}: seq ${d.sequence}`);
      });
    }
  }
}

test('drift-scaled carriers keep worst-bit margins decisive at 3% drift', () => {
  const s = synthBits(7, { clockDrift: -0.03 });
  const d = decodeFrame(s.samples, { sampleRate: FS });
  assert.equal(d.ok, true);
  assert.ok(d.minMarginDb > 6, `minMarginDb ${d.minMarginDb?.toFixed(1)} should be decisive, not straddling`);
});

test('drift + noise combined round-trips decode across seeds', () => {
  for (const [drift, snr] of [[0.03, 10], [-0.03, 10], [0.03, 0], [-0.03, 0], [0.035, 10]]) {
    const s = synthBits(55, { clockDrift: drift });
    for (let seed = 1; seed <= 3; seed++) {
      const d = decodeFrame(addAwgn(s.samples, snr, seed * 7919), { sampleRate: FS });
      assert.equal(d.ok, true, `drift ${drift} snr ${snr} seed ${seed}`);
      assert.equal(d.sequence, 55);
    }
  }
});

test('jamming any payload bit at 3.5% drift flips it and CRC rejects', () => {
  const s = synthBits(100, { clockDrift: 0.035 });
  const truth = frameBits(frame(100));
  for (const target of [45, 55, 65, 75]) {
    const d = decodeFrame(attackBit(s.samples, target, s), { sampleRate: FS });
    assert.equal(d.syncOk, true, `bit ${target}: sync must survive`);
    assert.equal(d.bits[target], truth[target].bit ? 0 : 1, `bit ${target} must flip`);
    assert.equal(d.crcOk, false, `bit ${target}: CRC must reject`);
  }
});

test('frame-map preamble chips meet WCAG 4.5:1 contrast against chip text', () => {
  const app = read('app.js');
  const m = app.match(/ROLE_COLOR = \{([^}]*)\}/);
  assert.ok(m, 'ROLE_COLOR table found');
  const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const color of m[1].match(/#[0-9a-f]{6}/gi)) {
    assert.ok(ratio('#101719', color) >= 4.5, `chip text on ${color}: ${ratio('#101719', color).toFixed(2)}`);
  }
});

const VERIFIED_TEST_COUNT = 417;
test('README states the exact verified test count', () => {
  const m = read('README.md').match(/(\d+)\s+(?:automated\s+)?tests/i);
  assert.ok(m, 'README must state the test count');
  assert.equal(Number(m[1]), VERIFIED_TEST_COUNT, `README says ${m[1]} but ${VERIFIED_TEST_COUNT} tests are registered`);
});
