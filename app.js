import { boardModel, schematicModel, validateBOM, safeSupplierURL, child, children,
  FSK, carrierHz, encodeFrame, frameBits, synthesize, addAwgn, attackBit, decodeFrame, spectrogram } from './core.js';

const $ = id => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg';
const money = value => `$${(Number(value) / 100).toFixed(2)}`;
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function field(list, name, value) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = name; dd.textContent = value; list.append(dt, dd);
}
async function source(path, json = false) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return json ? response.json() : response.text();
}

async function start() {
  const [pcb, sch, bom] = await Promise.all([source('chirpkey8.kicad_pcb'), source('chirpkey8.kicad_sch'), source('bom.json', true)]);
  const board = boardModel(pcb), schematic = schematicModel(sch), budget = validateBOM(bom);
  const byRef = new Map(bom.rows.flatMap(row => row.references.map(ref => [ref, row])));
  let selected = '', view = [-1, -1, 34, 26];
  function inspect(ref) {
    selected = ref;
    const row = byRef.get(ref), fp = board.footprints.find(f => f.ref === ref);
    $('detail-title').textContent = ref;
    $('detail-body').textContent = row?.description ?? fp?.value ?? 'Source component';
    $('detail-fields').replaceChildren();
    if (row) {
      field($('detail-fields'), 'Manufacturer part number', row.partNumber);
      field($('detail-fields'), 'Manufacturer', row.manufacturer);
      field($('detail-fields'), 'Quantity / unit estimate', `${row.quantity} / $${row.unitPrice}`);
      field($('detail-fields'), 'Price evidence', row.quoteStatus);
      $('supplier-link').href = safeSupplierURL(row.sourceUrl);
    }
    if (fp) {
      field($('detail-fields'), 'Board position', `${fp.x}, ${fp.y} mm`);
      field($('detail-fields'), 'Connected nets', [...new Set(fp.pads.map(p => p.netName))].join(', '));
    }
    $('supplier-link').hidden = !row;
    document.querySelectorAll('[data-ref]').forEach(n => {
      const match = n.dataset.ref === selected;
      n.classList.toggle('selected', match);
      if (n.getAttribute('role') === 'button') n.setAttribute('aria-pressed', String(match));
    });
  }
  function selectable(node, ref) {
    node.dataset.ref = ref; node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `Inspect ${ref}`); node.setAttribute('aria-pressed', String(ref === selected));
    node.addEventListener('click', () => inspect(ref));
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(ref); }
    });
    node.classList.toggle('selected', ref === selected);
    return node;
  }
  for (const net of board.nets.filter(n => n.id)) {
    const option = document.createElement('option'); option.value = net.id; option.textContent = net.name;
    $('net-filter').append(option);
  }
  function renderPCB() {
    const root = $('pcb-svg'); root.replaceChildren(); root.setAttribute('viewBox', view.join(' '));
    const bx = Math.min(...board.outline.flatMap(l => [l.a[0], l.b[0]])), by = Math.min(...board.outline.flatMap(l => [l.a[1], l.b[1]]));
    root.append(svg('rect', { x: bx, y: by, width: Math.max(...board.outline.flatMap(l => [l.a[0], l.b[0]])) - bx,
      height: Math.max(...board.outline.flatMap(l => [l.a[1], l.b[1]])) - by, rx: .3, fill: '#15352e' }));
    const net = $('net-filter').value, front = $('front-layer').checked, back = $('back-layer').checked;
    const opacity = id => !net || String(id) === net ? 1 : .16;
    for (const segment of board.segments) {
      if (!(segment.layer === 'F.Cu' ? front : back)) continue;
      root.append(svg('line', { x1: segment.a[0], y1: segment.a[1], x2: segment.b[0], y2: segment.b[1],
        stroke: segment.layer === 'F.Cu' ? '#f2b675' : '#75b8ee', 'stroke-width': segment.width, 'stroke-linecap': 'round', opacity: opacity(segment.net) }));
    }
    for (const via of board.vias) if (front || back) {
      root.append(svg('circle', { cx: via.at[0], cy: via.at[1], r: via.size / 2, fill: '#e4ce8b', opacity: opacity(via.net) }));
      root.append(svg('circle', { cx: via.at[0], cy: via.at[1], r: via.drill / 2, fill: '#101719' }));
    }
    for (const fp of board.footprints) {
      const group = selectable(svg('g', { class: 'footprint' }), fp.ref);
      const padXs = fp.pads.map(p => p.x), padYs = fp.pads.map(p => p.y);
      group.append(svg('rect', { x: Math.min(...padXs) - 1, y: Math.min(...padYs) - 1,
        width: Math.max(...padXs) - Math.min(...padXs) + 2, height: Math.max(...padYs) - Math.min(...padYs) + 2,
        fill: 'transparent', stroke: '#a9bbb5', 'stroke-width': .12 }));
      for (const pad of fp.pads) {
        if (pad.layers.includes('*.Cu') ? !(front || back) : !pad.layers.some(l => l === 'F.Cu' ? front : l === 'B.Cu' && back)) continue;
        group.append(svg('rect', { x: pad.x - pad.w / 2, y: pad.y - pad.h / 2, width: pad.w, height: pad.h,
          rx: pad.shape === 'circle' || pad.shape === 'oval' ? Math.min(pad.w, pad.h) / 2 : .12,
          fill: '#e4ce8b', opacity: opacity(pad.net) }));
        if (pad.drill) group.append(svg('circle', { cx: pad.x, cy: pad.y, r: pad.drill / 2, fill: '#101719' }));
      }
      if ($('silk-layer').checked) group.append(svg('text', { x: fp.x, y: Math.min(...padYs) - 1.3, fill: '#e6eee9', 'font-size': .9, 'text-anchor': 'middle' }, fp.ref));
      root.append(group);
    }
    for (const line of board.outline) root.append(svg('line', { x1: line.a[0], y1: line.a[1], x2: line.b[0], y2: line.b[1], stroke: '#c8ec86', 'stroke-width': .15 }));
    if ($('silk-layer').checked) for (const label of board.texts.filter(t => t.layer === 'F.SilkS')) {
      root.append(svg('text', { x: label.at[0], y: label.at[1], 'font-size': label.size, fill: '#e6eee9' }, label.text));
    }
  }
  function renderSchematic() {
    const root = $('schematic-svg');
    for (const wire of schematic.wires) root.append(svg('polyline', { points: wire.map(p => p.join(',')).join(' '), fill: 'none', stroke: '#82c4a2', 'stroke-width': .3 }));
    for (const label of schematic.labels) {
      const at = child(label, 'at'); root.append(svg('text', { x: at[1], y: at[2] - .6, fill: '#c8ec86', 'font-size': 1.4 }, label[1]));
    }
    for (const symbol of schematic.symbols) {
      const group = selectable(svg('g', { transform: `translate(${symbol.at[0]} ${symbol.at[1]}) rotate(${-symbol.at[2]})` }), symbol.ref);
      for (const unit of children(symbol.lib, 'symbol')) for (const rect of children(unit, 'rectangle')) {
        const a = child(rect, 'start').slice(1), b = child(rect, 'end').slice(1);
        group.append(svg('rect', { x: Math.min(a[0], b[0]), y: -Math.max(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), fill: '#203035', stroke: '#e4ce8b', 'stroke-width': .25 }));
      }
      for (const pin of symbol.pins) {
        const [x, y, angle] = pin.at, r = angle * Math.PI / 180;
        group.append(svg('line', { x1: x, y1: -y, x2: x + Math.cos(r) * pin.length, y2: -y - Math.sin(r) * pin.length, stroke: '#e4ce8b', 'stroke-width': .25 }));
        group.append(svg('text', { x: x, y: -y - .5, fill: '#a9bbb5', 'font-size': .95 }, `${pin.n} ${pin.name}`));
      }
      root.append(group);
      for (const prop of children(symbol.node, 'property').filter(p => ['Reference', 'Value'].includes(p[1]))) {
        const at = child(prop, 'at');
        root.append(svg('text', { x: at[1], y: at[2], fill: '#e6eee9', 'font-size': 1.4 }, prop[2]));
      }
    }
    for (const text of schematic.texts) {
      const at = child(text, 'at'); root.append(svg('text', { x: at[1], y: at[2], fill: '#a9bbb5', 'font-size': 1.3 }, text[1]));
    }
  }
  function renderBOM() {
    const query = $('bom-filter').value.trim().toLowerCase();
    const rows = bom.rows.filter(row => [row.references.join(' '), row.partNumber, row.description, row.supplier].join(' ').toLowerCase().includes(query));
    $('bom-body').replaceChildren();
    for (const row of rows) {
      const tr = document.createElement('tr'), refs = document.createElement('td');
      for (const ref of row.references) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = ref; button.dataset.ref = ref;
        button.addEventListener('click', () => inspect(ref)); button.classList.toggle('selected', selected === ref); refs.append(button);
      }
      tr.append(refs);
      for (const text of [row.partNumber, row.quantity, `$${row.unitPrice}`, `$${row.lineTotal}`, row.supplier]) {
        const td = document.createElement('td'); td.textContent = text; tr.append(td);
      }
      $('bom-body').append(tr);
    }
    $('bom-count').textContent = `${rows.length} of ${bom.rows.length} BOM rows. Totals always include all rows.`;
  }
  $('estimate').textContent = `${money(budget.total)} estimated total`;
  wbTruth.bom = `BOM ${money(budget.subtotal)} parts + PCB, ${money(budget.total)} estimated total, inside the $18.40 target and $35.00 grant cap.`;
  renderTruth();
  for (const [name, amount] of [['Parts + PCB', budget.subtotal], ['Shipping allowance', BigInt(bom.pricing.shippingAllowance.replace('.', ''))], ['Tax allowance', BigInt(bom.pricing.taxAllowance.replace('.', ''))], ['Estimated total', budget.total]]) field($('totals'), name, money(amount));
  const tabs = [...document.querySelectorAll('[data-tab]')];
  function activate(tab, focus = false) {
    for (const item of tabs) {
      const active = item === tab; item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
      $(`panel-${item.dataset.tab}`).hidden = !active;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (next !== undefined) { event.preventDefault(); activate(tabs[next], true); }
    });
  });
  for (const id of ['front-layer', 'back-layer', 'silk-layer', 'net-filter']) $(id).addEventListener('change', renderPCB);
  $('bom-filter').addEventListener('input', renderBOM);
  function zoom(factor, px = .5, py = .5) {
    const width = Math.min(102, Math.max(5, view[2] * factor)), ratio = width / view[2];
    view = [view[0] + view[2] * px * (1 - ratio), view[1] + view[3] * py * (1 - ratio), width, view[3] * ratio];
    $('pcb-svg').setAttribute('viewBox', view.join(' '));
  }
  document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.zoom === 'reset') { view = [-1, -1, 34, 26]; $('pcb-svg').setAttribute('viewBox', view.join(' ')); }
    else zoom(button.dataset.zoom === 'in' ? .8 : 1.25);
  }));
  $('pcb-svg').addEventListener('wheel', event => {
    event.preventDefault(); const rect = $('pcb-svg').getBoundingClientRect();
    zoom(event.deltaY < 0 ? .9 : 1.1, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  }, { passive: false });
  let drag;
  $('pcb-svg').style.touchAction = 'none';
  $('pcb-svg').addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('[data-ref]')) return;
    drag = { x: event.clientX, y: event.clientY, view: [...view] }; $('pcb-svg').setPointerCapture(event.pointerId);
  });
  $('pcb-svg').addEventListener('pointermove', event => {
    if (!drag) return; const rect = $('pcb-svg').getBoundingClientRect();
    const scale = Math.min(rect.width / drag.view[2], rect.height / drag.view[3]);
    view = [drag.view[0] - (event.clientX - drag.x) / scale, drag.view[1] - (event.clientY - drag.y) / scale, ...drag.view.slice(2)];
    $('pcb-svg').setAttribute('viewBox', view.join(' '));
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('pcb-svg').addEventListener(type, () => { drag = undefined; });
  renderPCB(); renderSchematic(); renderBOM();
  $('explorer').hidden = false;
  $('status').textContent = `Loaded ${board.footprints.length} footprints, ${board.segments.length} routed segments and ${schematic.symbols.length} symbols from the local KiCad files. Preview only, not ERC/DRC.`;
}

// ---------------- Acoustic FSK workbench ----------------
// One click synthesizes the exact frame the ATtiny412 firmware emits,
// optionally degrades it with room noise, clock drift or a jammed symbol,
// then decodes it with the same Goertzel + CRC-8 chain a laptop mic would use.
const wb = { seq: 0, lastSeen: -1, last: null, audio: null };
const wbTruth = { bom: '' };
const TONE = { mark: '#c8ec86', space: '#75b8ee' };
const ROLE_COLOR = { preamble: '#75857e', sync: '#f2b675', payload: '#c8ec86', crc: '#e4ce8b' };
const hex2 = b => (b >>> 0).toString(16).padStart(2, '0').toUpperCase();

function renderTruth(extra = '') {
  const m = carrierHz(FSK.markHz), s = carrierHz(FSK.spaceHz);
  $('wb-truth').textContent = `Decoded live in this page from the firmware bitstream itself: ${m.hz.toFixed(1)} Hz mark (CCMP ${m.ccmp}), ${s.hz.toFixed(1)} Hz space (CCMP ${s.ccmp}), 62.5 baud MSB-first, 11 bytes in 1.408 s. ${wbTruth.bom} ${extra}`.trim();
}

function fitCanvas(canvas, cssH) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(2, Math.round(canvas.clientWidth || canvas.parentElement.clientWidth || 600));
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, cssH];
}

function drawWave(samples, res) {
  const [ctx, w, h] = fitCanvas($('wave'), 140);
  ctx.fillStyle = '#122121'; ctx.fillRect(0, 0, w, h);
  const mid = h / 2, n = samples.length;
  const bitOf = s => Math.floor((s - res.startSample) / res.symbolSamples);
  for (let px = 0; px < w; px++) {
    const s0 = Math.floor(px / w * n), s1 = Math.max(s0 + 1, Math.ceil((px + 1) / w * n));
    const step = Math.max(1, Math.floor((s1 - s0) / 12));
    let mn = Infinity, mx = -Infinity;
    for (let s = s0; s < s1 && s < n; s += step) { if (samples[s] < mn) mn = samples[s]; if (samples[s] > mx) mx = samples[s]; }
    const b = bitOf(s0);
    ctx.strokeStyle = b >= 0 && b < res.bits.length ? (res.bits[b] ? TONE.mark : TONE.space) : '#56665f';
    ctx.globalAlpha = b >= 0 && b < res.bits.length ? .9 : .45;
    ctx.beginPath(); ctx.moveTo(px + .5, mid + mn * mid * .92); ctx.lineTo(px + .5, mid + mx * mid * .92); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(230,238,233,.14)';
  for (let b = 8; b < res.bits.length; b += 8) {
    const x = (res.startSample + b * res.symbolSamples) / n * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
}

function drawGoertzel(res, truthBits) {
  const [ctx, w, h] = fitCanvas($('goertzel'), 160);
  ctx.fillStyle = '#122121'; ctx.fillRect(0, 0, w, h);
  const syms = res.symbols;
  if (!syms.length) return;
  const maxE = Math.max(...syms.map(s => Math.max(s.mark, s.space)), 1e-9);
  const mid = h / 2, bw = w / syms.length;
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i], wrong = truthBits && truthBits[i] && truthBits[i].bit !== s.bit;
    const mh = Math.sqrt(s.mark / maxE) * (mid - 14), sh = Math.sqrt(s.space / maxE) * (mid - 14);
    ctx.fillStyle = wrong ? '#e0705c' : TONE.mark;
    ctx.fillRect(i * bw + .5, mid - mh, Math.max(1, bw - 1), mh);
    ctx.fillStyle = wrong ? '#e0705c' : TONE.space;
    ctx.fillRect(i * bw + .5, mid, Math.max(1, bw - 1), sh);
  }
  ctx.strokeStyle = 'rgba(230,238,233,.35)';
  ctx.beginPath(); ctx.moveTo(0, mid + .5); ctx.lineTo(w, mid + .5); ctx.stroke();
  ctx.fillStyle = '#a9bbb5'; ctx.font = '10px ui-monospace,monospace';
  ctx.fillText('mark', 6, 12); ctx.fillText('space', 6, h - 4);
  ctx.fillStyle = 'rgba(230,238,233,.25)';
  for (let b = 8; b < syms.length; b += 8) ctx.fillRect(b * bw - .5, 0, 1, h);
}

function drawSpectro(samples) {
  const [ctx, w, h] = fitCanvas($('spectro'), 140);
  ctx.fillStyle = '#122121'; ctx.fillRect(0, 0, w, h);
  const spec = spectrogram(samples, { sampleRate: 48000, size: 1024, hop: 384, minHz: 1600, maxHz: 4400 });
  if (!spec.cols.length) return;
  let lo = Infinity, hi = -Infinity;
  for (const c of spec.cols) for (const v of c) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const cw = w / spec.cols.length, bh = h / spec.cols[0].length;
  const ramp = t => {
    const x = Math.min(1, Math.max(0, t));
    if (x < .45) { const u = x / .45; return `rgb(${18 + u * 28},${33 + u * 60},${33 + u * 41})`; }
    if (x < .8) { const u = (x - .45) / .35; return `rgb(${46 + u * 154},${93 + u * 143},${74 + u * 60})`; }
    const u = (x - .8) / .2; return `rgb(${200 + u * 55},${236 + u * 19},${134 + u * 121})`;
  };
  spec.cols.forEach((col, x) => {
    for (let y = 0; y < col.length; y++) {
      ctx.fillStyle = ramp((col[y] - lo) / (hi - lo || 1));
      ctx.fillRect(x * cw, h - (y + 1) * bh, Math.ceil(cw), Math.ceil(bh));
    }
  });
  for (const [hz, name] of [[2400, '2400 Hz space'], [3600, '3600 Hz mark']]) {
    const y = h - (hz / 48000 * spec.size - spec.lo) * bh;
    ctx.strokeStyle = 'rgba(230,238,233,.5)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(16,23,25,.78)';
    ctx.fillRect(4, y - 13, ctx.measureText(name).width + 10, 15);
    ctx.fillStyle = '#e6eee9'; ctx.font = '10px ui-monospace,monospace'; ctx.fillText(name, 9, y - 3);
  }
}

function renderFrameMap(res, truthBits, reveal) {
  const el = $('framemap'); el.replaceChildren();
  const names = ['PRE', 'PRE', 'PRE', 'PRE', 'SYNC', 'ID', 'ID', 'ID', 'ID', 'SEQ', 'CRC'];
  const roles = ['preamble', 'preamble', 'preamble', 'preamble', 'sync', 'payload', 'payload', 'payload', 'payload', 'payload', 'crc'];
  for (let b = 0; b < FSK.frameBytes; b++) {
    const card = document.createElement('div');
    card.className = `byte ${roles[b]}${roles[b] === 'crc' ? (res.crcOk ? ' ok' : ' fail') : ''}`;
    const head = document.createElement('div'); head.className = 'byte-head';
    head.innerHTML = `<span>${names[b]}</span><span>${b < res.bytes.length ? '0x' + hex2(res.bytes[b]) : '--'}</span>`;
    const row = document.createElement('div'); row.className = 'bits';
    for (let k = 0; k < 8; k++) {
      const i = b * 8 + k, chip = document.createElement('span');
      chip.className = 'bit';
      const val = i < res.bits.length ? res.bits[i] : '?';
      chip.textContent = val;
      chip.style.background = ROLE_COLOR[res.symbols[i]?.role] || '#75857e';
      if (truthBits?.[i] && truthBits[i].bit !== val) chip.classList.add('err');
      if (reveal) { chip.classList.add('hide'); chip.style.transitionDelay = `${i * 9}ms`; }
      row.append(chip);
    }
    card.append(head, row); el.append(card);
  }
  if (reveal) requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll('.bit.hide').forEach(c => c.classList.remove('hide'))));
}

function renderStats(res, seq, snrDb, driftPct, jammedBits) {
  const dl = $('wb-stats'); dl.replaceChildren();
  field(dl, 'Frame', res.bytes.length ? [...res.bytes].map(b => hex2(b)).join(' ') : 'not acquired');
  field(dl, 'Payload', res.payload.length ? res.payload.map(b => hex2(b)).join(' ') + ` (seq ${res.sequence})` : 'none');
  field(dl, 'CRC-8/SMBUS', res.syncOk ? `received 0x${hex2(res.crcReceived)} vs computed 0x${hex2(res.crcComputed)}` : 'sync not acquired');
  field(dl, 'Channel', `${snrDb >= 35 ? 'clean' : `${snrDb} dB SNR`} room noise, ${driftPct === 0 ? 'nominal' : `${driftPct > 0 ? '+' : ''}${driftPct}%`} clock drift${jammedBits.length ? `, ${jammedBits.length} bit${jammedBits.length > 1 ? 's' : ''} jammed` : ''}`);
  if (res.startSample >= 0) field(dl, 'Symbol rate', `${(48000 / res.symbolSamples).toFixed(1)} baud estimated (${res.symbolSamples.toFixed(0)} samples/symbol)`);
  if (res.symbols.length) field(dl, 'Worst bit margin', `${res.minMarginDb.toFixed(1)} dB`);
}

function transmit() {
  const snrDb = Number($('snr').value), driftPct = Number($('drift').value);
  const reuse = $('replay').checked && wb.lastSeen >= 0;
  const seq = reuse ? wb.lastSeen : wb.seq;
  wb.seq = (wb.seq + 1) & 0xFF;
  const frame = encodeFrame(seq), truth = frameBits(frame);
  const synth = synthesize(truth, { sampleRate: 48000, clockDrift: driftPct / 100, leadSec: .06, trailSec: .06 });
  let wave = synth.samples;
  const jamAt = $('tamper').checked ? 40 + Math.floor(Math.random() * 40) : -1;
  if (jamAt >= 0) wave = attackBit(wave, jamAt, synth);
  wave = addAwgn(wave, snrDb, (Math.random() * 2 ** 31) >>> 0);
  const res = decodeFrame(wave, { sampleRate: 48000 });
  const jammed = res.bits.length === truth.length ? res.bits.map((b, i) => b !== truth[i].bit ? i : -1).filter(i => i >= 0) : [];
  const attackArmed = $('tamper').checked;
  const replayed = res.ok && res.sequence === wb.lastSeen;
  if (res.ok) wb.lastSeen = res.sequence;
  wb.last = { wave, res };

  const v = $('verdict');
  const replayNote = replayed ? ' (replayed sequence)' : '';
  if (res.verified) {
    v.textContent = `FRAME VERIFIED. CRC-8 pass, seq ${res.sequence}${replayNote}.${attackArmed ? ' Bit-flip attack had no effect on the decoded frame.' : ''}`;
    v.className = 'wb-verdict ok';
  } else if (res.ok) { v.textContent = `CRC PASS, preamble degraded. seq ${res.sequence}${replayNote}.`; v.className = 'wb-verdict warn'; }
  else if (res.syncOk && !res.crcOk) {
    v.textContent = attackArmed
      ? `ATTACK DETECTED. ${jammed.length || 'A'} bit${jammed.length === 1 ? '' : 's'} flipped and CRC-8 rejected the frame.`
      : `CRC-8 FAILED. ${jammed.length || 'Channel'} bit${jammed.length === 1 ? '' : 's'} corrupted by noise or drift, not a bit-flip attack.`;
    v.className = 'wb-verdict fail';
  } else { v.textContent = `NO FRAME. Sync word not acquired (${res.reason || 'channel too hostile'}).`; v.className = 'wb-verdict fail'; }

  renderFrameMap(res, truth, true);
  drawWave(wave, res); drawGoertzel(res, truth); drawSpectro(wave);
  renderStats(res, seq, snrDb, driftPct, jammed);
  renderTruth();
}

$('tx-btn').addEventListener('click', transmit);
$('play-btn').addEventListener('click', () => {
  if (!wb.last) return;
  wb.audio = wb.audio || new (window.AudioContext || window.webkitAudioContext)();
  const ctx = wb.audio, buf = ctx.createBuffer(1, wb.last.wave.length, 48000);
  buf.getChannelData(0).set(wb.last.wave);
  const src = ctx.createBufferSource(), gain = ctx.createGain();
  gain.gain.value = .85;
  src.buffer = buf; src.connect(gain); gain.connect(ctx.destination); src.start();
});
$('snr').addEventListener('input', () => { $('snr-out').textContent = `${$('snr').value} dB SNR`; });
$('drift').addEventListener('input', () => { const d = Number($('drift').value); $('drift-out').textContent = d === 0 ? 'nominal' : `${d > 0 ? '+' : ''}${d}%`; });
window.addEventListener('resize', () => { if (wb.last) { drawWave(wb.last.wave, wb.last.res); drawGoertzel(wb.last.res, null); drawSpectro(wb.last.wave); } });
transmit();

$('load-kicanvas').addEventListener('click', async () => {
  const button = $('load-kicanvas'); button.disabled = true; $('kicanvas-status').textContent = 'Loading optional external KiCanvas engine…';
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.type = 'module'; script.src = 'https://kicanvas.org/kicanvas/kicanvas.js';
      const timeout = setTimeout(() => reject(new Error('KiCanvas network timeout')), 15000);
      script.onload = () => { clearTimeout(timeout); resolve(); }; script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('KiCanvas network request failed')); };
      document.head.append(script);
    });
    for (const file of ['chirpkey8.kicad_pcb', 'chirpkey8.kicad_sch']) {
      const embed = document.createElement('kicanvas-embed'); embed.setAttribute('src', new URL(file, import.meta.url).href); embed.setAttribute('controls', 'full');
      $('kicanvas-host').append(embed);
    }
    $('kicanvas-status').textContent = 'KiCanvas engine loaded. Its embedded viewers report their own file-loading errors.';
  } catch (error) { $('kicanvas-status').textContent = `${error.message}. The local explorer remains available.`; button.disabled = false; }
});
start().catch(error => { $('status').textContent = `${error.message}. Serve this folder over HTTP; module fetches do not work reliably from file://.`; });
