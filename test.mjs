import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardModel, schematicModel, validateBOM } from './core.js';
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
