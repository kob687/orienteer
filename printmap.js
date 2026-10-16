'use strict';
/* Orienteer – ISOM/ISSprOM-style printable map. Renders OSM data + contours (AWS terrarium DEM, d3-contour)
   onto a canvas at a fixed scale, overprints the course in purple, adds title/scale/north/legend/description. */
(function () {
const DPI = 200, PXMM = DPI / 25.4;
const PAPER = { A4:[210, 297], Letter:[215.9, 279.4] };
const C = { // ISOM 2017-2 approximations
  open:'#FFBA36', rough:'#FFDD9A', slow:'#C7E8B8', walk:'#8DD47F', scrub:'#8DD47F', water:'#00A0E6', waterLight:'#8FD3F5', marsh:'#00A0E6',
  black:'#000', brown:'#C9681E', oob:'#A9AB3B', paved:'#D9B98A', course:'#C800FF', white:'#fff' };
const loadScript = src => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
async function libs() { await loadScript('vendor/internmap.min.js'); await loadScript('vendor/d3-array.min.js'); await loadScript('vendor/d3-contour.min.js'); }

/* magnetic declination: NOAA (WMM) online, fallback = IGRF-14 dipole (approximate) */
async function declination(lat, lon) {
  try {
    const r = await fetch(`https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination?lat1=${lat}&lon1=${lon}&key=zNEw7&resultFormat=json`);
    const j = await r.json(); const d = j.result[0].declination; if (isFinite(d)) return { d, src:'NOAA WMM ' + new Date().getFullYear() };
  } catch (e) { console.warn('NOAA declination failed', e); }
  const g10 = -29350, g11 = -1410, h11 = 4545, th = (90 - lat) * Math.PI / 180, ph = lon * Math.PI / 180;
  const X = -g10 * Math.sin(th) + (g11 * Math.cos(ph) + h11 * Math.sin(ph)) * Math.cos(th), Y = g11 * Math.sin(ph) - h11 * Math.cos(ph);
  return { d: Math.atan2(Y, X) * 180 / Math.PI, src:'APPROXIMATE (dipole model, may be off by >10°)' };
}

/* elevation: terrarium tiles → sampler(lon,lat) */
async function elevation(bb) {
  const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z, lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;
  let z = 15; while (z > 10 && (Math.floor(lon2x(bb[2], z)) - Math.floor(lon2x(bb[0], z)) + 1) * (Math.floor(lat2y(bb[1], z)) - Math.floor(lat2y(bb[3], z)) + 1) > 64) z--;
  const x0 = Math.floor(lon2x(bb[0], z)), x1 = Math.floor(lon2x(bb[2], z)), y0 = Math.floor(lat2y(bb[3], z)), y1 = Math.floor(lat2y(bb[1], z));
  const cv = document.createElement('canvas'); cv.width = (x1 - x0 + 1) * 256; cv.height = (y1 - y0 + 1) * 256; const cx = cv.getContext('2d');
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(new Promise(res => { const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => { cx.drawImage(im, (x - x0) * 256, (y - y0) * 256); res(); }; im.onerror = () => res();
    im.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`; }));
  await Promise.all(jobs);
  const px = cx.getImageData(0, 0, cv.width, cv.height).data, W = cv.width, H = cv.height;
  const at = (i, j) => { i = Math.max(0, Math.min(W - 1, i)); j = Math.max(0, Math.min(H - 1, j)); const k = (j * W + i) * 4; return px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768; };
  return { z, sample: (lon, lat) => { const fx = (lon2x(lon, z) - x0) * 256 - 0.5, fy = (lat2y(lat, z) - y0) * 256 - 0.5, i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    return at(i, j) * (1 - a) * (1 - b) + at(i + 1, j) * a * (1 - b) + at(i, j + 1) * (1 - a) * b + at(i + 1, j + 1) * a * b; } };
}
function blur(g, w, h, r, passes) { let a = g, b = new Float64Array(g.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) { let s = 0, n = 0; for (let x = -r; x < w + r; x++) { if (x + r < w) { s += a[y * w + x + r]; n++; } if (x - r - 1 >= 0) { s -= a[y * w + x - r - 1]; n--; } if (x >= 0 && x < w) b[y * w + x] = s / n; } }
    for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let y = -r; y < h + r; y++) { if (y + r < h) { s += b[(y + r) * w + x]; n++; } if (y - r - 1 >= 0) { s -= b[(y - r - 1) * w + x]; n--; } if (y >= 0 && y < h) a[y * w + x] = s / n; } }
  } return a; }

/* OSM features for the whole sheet extent */
async function osm(bb) {
  const b = `${bb[1]},${bb[0]},${bb[3]},${bb[2]}`;
  return overpass(`[out:json][timeout:120];(
    way["highway"](${b});
    way["building"](${b});
    way["natural"~"^(water|wood|scrub|heath|grassland|wetland|cliff|bare_rock|scree)$"](${b});relation["natural"~"^(water|wood|wetland|scrub)$"](${b});
    way["landuse"~"^(forest|meadow|grass|farmland|farmyard|orchard|vineyard|residential|industrial|commercial|retail|military|cemetery|reservoir|basin|railway|construction|quarry)$"](${b});relation["landuse"~"^(forest|meadow|residential|industrial|commercial|farmland|reservoir)$"](${b});
    way["leisure"~"^(golf_course|pitch|playground|garden)$"](${b});
    way["amenity"="parking"](${b});
    way["waterway"](${b});way["barrier"~"^(wall|fence|retaining_wall|hedge)$"](${b});way["railway"="rail"](${b});way["power"="line"](${b});
  );out geom;`);
}
function classify(t) {
  if (t.building) return 'building';
  if (t.highway) return 'hw';
  if (t.waterway) return ['riverbank', 'dock'].includes(t.waterway) ? 'water' : 'stream';
  if (t.natural === 'water' || ['reservoir', 'basin'].includes(t.landuse)) return 'water';
  if (t.natural === 'wetland') return 'marsh';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'forest';
  if (t.natural === 'scrub') return 'scrub';
  if (t.natural === 'heath' || ['orchard', 'vineyard'].includes(t.landuse)) return 'rough';
  if (t.natural === 'grassland' || ['meadow', 'grass', 'farmland', 'cemetery'].includes(t.landuse) || ['golf_course', 'pitch', 'garden', 'playground'].includes(t.leisure)) return 'open';
  if (['residential', 'industrial', 'commercial', 'retail', 'military', 'railway', 'construction', 'quarry', 'farmyard'].includes(t.landuse)) return 'oob';
  if (t.amenity === 'parking') return 'paved';
  if (t.natural === 'cliff') return 'cliff';
  if (['bare_rock', 'scree'].includes(t.natural)) return 'rock';
  if (t.barrier) return t.barrier === 'fence' ? 'fence' : 'wall';
  if (t.railway) return 'rail';
  if (t.power) return 'power';
  return null;
}
const FEATURE_WORDS = { junction:'Path junction', 'trail end':'Path end', bend:'Path bend', 'off-trail':'Terrain point (off path)', 'max-remote':'Remote terrain point' };

async function render(opts = {}) {
  const c = S.course; if (!c) throw new Error('Generate a course first.');
  const scale = +opts.scale || 10000, prog = opts.progress || (() => {});
  await libs();
  // course extent (metres, local projection)
  const pts = [[c.start[0], c.start[1]], ...c.controls.map(k => [k.lon, k.lat])];
  const ab = c.area ? turf.bbox(c.area) : null;
  let bbll = pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [1e9, 1e9, -1e9, -1e9]);
  const lat0 = (bbll[1] + bbll[3]) / 2, lon0 = (bbll[0] + bbll[2]) / 2, P = makeProj(lat0, lon0);
  const exts = [P.f(bbll[0], bbll[1]), P.f(bbll[2], bbll[3])], cw = exts[1][0] - exts[0][0] + 300, ch = exts[1][1] - exts[0][1] + 300; // +150 m margin each side
  // paper + orientation: choose the one where the course fits best at this scale
  const paperName = opts.paper && PAPER[opts.paper] ? opts.paper : (/^en-(US|CA)/.test(navigator.language) ? 'Letter' : 'A4');
  const [pw, ph] = PAPER[paperName], M = 8, INFO = 72;
  const lay = o => { const W = o === 'landscape' ? ph : pw, H = o === 'landscape' ? pw : ph;
    const fw = o === 'landscape' ? W - 2 * M - INFO - 4 : W - 2 * M, fh = o === 'landscape' ? H - 2 * M : H - 2 * M - INFO - 4;
    const mw = fw * scale / 1000, mh = fh * scale / 1000; return { o, W, H, fw, fh, mw, mh, fit: Math.min(mw / cw, mh / ch) }; };
  const L1 = lay('portrait'), L2 = lay('landscape'); const Lo = opts.orientation ? lay(opts.orientation) : (L2.fit > L1.fit ? L2 : L1);
  const fits = Lo.fit >= 1;
  // extent in lat/lon
  const hx = Lo.mw / 2, hy = Lo.mh / 2, [w0, s0] = P.inv(-hx, -hy), [e0, n0] = P.inv(hx, hy), bb = [w0, s0, e0, n0];
  const cv = document.createElement('canvas'); cv.width = Math.round(Lo.W * PXMM); cv.height = Math.round(Lo.H * PXMM);
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  const FX = M * PXMM, FY = M * PXMM, FW = Lo.fw * PXMM, FH = Lo.fh * PXMM, mpx = 1000 / scale * PXMM; // px per metre
  const tx = (lon, lat) => { const [x, y] = P.f(lon, lat); return [FX + FW / 2 + x * mpx, FY + FH / 2 - y * mpx]; };
  const mm = v => v * PXMM;
  prog('Loading map data & elevation…');
  const [js, dem, dec] = await Promise.all([osm(bb), elevation(bb).catch(e => (console.warn('dem', e), null)), declination(lat0, lon0)]);
  g.save(); g.beginPath(); g.rect(FX, FY, FW, FH); g.clip();
  // gather
  const areas = { forest:[], open:[], rough:[], scrub:[], marsh:[], water:[], oob:[], paved:[], building:[], rock:[] }, lines = [];
  for (const el of js.elements) { const k = classify(el.tags || {}); if (!k) continue;
    if (areas[k] && !(k === 'water' && el.type === 'way' && el.tags.waterway)) { elementToPolygons(el).forEach(p => areas[k].push(p)); continue; }
    if (el.geometry) lines.push({ k, t:el.tags, g:el.geometry.map(p => tx(p.lon, p.lat)) });
    else if (el.members) el.members.forEach(m => m.geometry && lines.push({ k, t:el.tags, g:m.geometry.map(p => tx(p.lon, p.lat)) })); }
  const path = poly => { g.beginPath(); poly.forEach(r => r.forEach((q, i) => { const [x, y] = tx(q[0], q[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); })); };
  const fill = (k, col, alpha = 1) => { g.globalAlpha = alpha; g.fillStyle = col; areas[k].forEach(p => { path(p); g.fill('evenodd'); }); g.globalAlpha = 1; };
  // base: OSM-mapped land is white forest unless open/vegetation says otherwise
  fill('open', C.open); fill('rough', C.rough); fill('forest', C.white); fill('scrub', C.walk); fill('paved', C.paved);
  fill('oob', C.oob, 0.85); fill('rock', '#bbb');
  // marsh: blue horizontal hatch
  g.save(); areas.marsh.forEach(p => { path(p); g.save(); g.clip('evenodd'); g.strokeStyle = C.marsh; g.lineWidth = mm(0.18); const b = g.canvas.height; for (let y = 0; y < b; y += mm(0.75)) { g.beginPath(); g.moveTo(0, y); g.lineTo(cv.width, y); g.stroke(); } g.restore(); }); g.restore();
  // contours
  let cInfo = 'no elevation data';
  if (dem) { prog('Building contours…');
    const step = Math.max(2, scale / 2500); // metres per grid cell (4 m at 1:10 000)
    const gw = Math.ceil(Lo.mw / step) + 1, gh = Math.ceil(Lo.mh / step) + 1; let grid = new Float64Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const [lon, lat] = P.inv(-hx + i * step, hy - j * step); grid[j * gw + i] = dem.sample(lon, lat); }
    grid = blur(grid, gw, gh, Math.round(12 / step) || 1, 3);
    let lo = Infinity, hi = -Infinity; for (const v of grid) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const thr = []; for (let v = Math.ceil(lo / 5) * 5; v <= hi; v += 5) thr.push(v);
    const cs = d3.contours().size([gw, gh]).thresholds(thr)(grid);
    const sx = FX + FW / 2 - hx * mpx, sy = FY + FH / 2 - hy * mpx, k = step * mpx;
    g.strokeStyle = C.brown; g.lineJoin = g.lineCap = 'round';
    for (const ct of cs) { const idx = Math.round(ct.value) % 25 === 0; g.lineWidth = mm(idx ? 0.25 : 0.14);
      g.beginPath(); for (const poly of ct.coordinates) for (const ring of poly) { // skip segments on the grid border
        let pen = false; for (const [x, y] of ring) { const edge = x <= 0.01 || y <= 0.01 || x >= gw - 0.01 || y >= gh - 0.01; const X = sx + (x - 0.5) * k, Y = sy + (y - 0.5) * k;
          if (edge) { pen = false; continue; } pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true; } }
      g.stroke(); }
    cInfo = `Contour interval 5 m (index 25 m) · DEM z${dem.z}`; }
  // water
  fill('water', C.waterLight); g.strokeStyle = C.black; g.lineWidth = mm(0.18); areas.water.forEach(p => { path(p); g.stroke(); });
  const stroke = (pts, w, col, dash) => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.lineWidth = mm(w); g.strokeStyle = col; g.setLineDash(dash ? dash.map(mm) : []); g.stroke(); g.setLineDash([]); };
  g.lineCap = 'butt';
  lines.filter(l => l.k === 'stream').forEach(l => stroke(l.g, /river|canal/.test(l.t.waterway) ? 0.5 : 0.25, C.water, l.t.intermittent === 'yes' ? [1, 0.25] : null));
  lines.filter(l => l.k === 'power').forEach(l => stroke(l.g, 0.14, C.black));
  lines.filter(l => l.k === 'fence').forEach(l => stroke(l.g, 0.18, C.black, [1.2, 0.4]));
  lines.filter(l => l.k === 'wall').forEach(l => stroke(l.g, 0.3, C.black));
  lines.filter(l => l.k === 'rail').forEach(l => { stroke(l.g, 0.7, C.black); stroke(l.g, 0.4, '#fff', [2, 2]); });
  lines.filter(l => l.k === 'cliff').forEach(l => stroke(l.g, 0.35, C.black));
  // roads/paths (ISOM 501-507)
  const H = l => l.t.highway;
  lines.filter(l => l.k === 'hw' && /motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street/.test(H(l))).forEach(l => { stroke(l.g, 1.0, C.black); stroke(l.g, 0.7, C.paved); });
  lines.filter(l => l.k === 'hw' && /service|pedestrian/.test(H(l))).forEach(l => stroke(l.g, 0.5, C.black));
  lines.filter(l => l.k === 'hw' && H(l) === 'track').forEach(l => stroke(l.g, 0.35, C.black, [2.5, 0.35]));
  lines.filter(l => l.k === 'hw' && /path|footway|bridleway|cycleway/.test(H(l))).forEach(l => stroke(l.g, 0.25, C.black, l.t.trail_visibility && /bad|horrible|no/.test(l.t.trail_visibility) ? [1, 0.35] : [2, 0.25]));
  lines.filter(l => l.k === 'hw' && H(l) === 'steps').forEach(l => stroke(l.g, 0.25, C.black, [0.4, 0.4]));
  fill('building', C.black);
  // magnetic north lines: every 30 mm (ISOM: ~250 m at 1:10 000? we use 30 mm), rotated by declination
  const a = dec.d * Math.PI / 180, sp = mm(30); g.strokeStyle = C.water; g.lineWidth = mm(0.18);
  const D = Math.hypot(FW, FH), cxm = FX + FW / 2, cym = FY + FH / 2;
  for (let o = -D; o <= D; o += sp) { const ux = Math.cos(a), uy = Math.sin(a); // perpendicular offset
    g.beginPath(); g.moveTo(cxm + o * ux - D * Math.sin(a), cym + o * uy + D * Math.cos(a)); g.lineTo(cxm + o * ux + D * Math.sin(a), cym + o * uy - D * Math.cos(a)); g.stroke(); }
  // course overprint (ISOM 701-708): circle Ø6 mm, start triangle 7 mm, finish Ø5/7 mm, line 0.35 mm
  g.strokeStyle = g.fillStyle = C.course; g.lineWidth = mm(0.35); g.globalAlpha = 0.95;
  const st = tx(c.start[0], c.start[1]), ctl = c.controls.map(k => tx(k.lon, k.lat));
  const tri = mm(7), triR = tri / Math.sqrt(3);
  const first = ctl[0] || [st[0], st[1] - 1], ang = Math.atan2(first[1] - st[1], first[0] - st[0]);
  g.beginPath(); for (let i = 0; i < 3; i++) { const t = ang + i * 2 * Math.PI / 3; const x = st[0] + triR * Math.cos(t), y = st[1] + triR * Math.sin(t); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); g.stroke();
  ctl.forEach(p => { g.beginPath(); g.arc(p[0], p[1], mm(3), 0, 2 * Math.PI); g.stroke(); });
  [2.5, 3.5].forEach(r => { g.beginPath(); g.arc(st[0], st[1], mm(r), 0, 2 * Math.PI); g.stroke(); });
  if (!c.score) { const seq = [st, ...ctl, st], gap = i => i === 0 ? triR + mm(0.6) : i === seq.length - 1 ? mm(4.2) : mm(3.6);
    for (let i = 0; i < seq.length - 1; i++) { const [x0, y0] = seq[i], [x1, y1] = seq[i + 1], d = Math.hypot(x1 - x0, y1 - y0), g0 = gap(i), g1 = gap(i + 1); if (d <= g0 + g1) continue;
      const ux = (x1 - x0) / d, uy = (y1 - y0) / d; g.beginPath(); g.moveTo(x0 + ux * g0, y0 + uy * g0); g.lineTo(x1 - ux * g1, y1 - uy * g1); g.stroke(); } }
  g.font = `bold ${mm(4)}px Arial,Helvetica,sans-serif`; g.textBaseline = 'middle'; g.lineWidth = mm(0.6); g.strokeStyle = '#fff';
  ctl.forEach((p, i) => { const t = String(i + 1), x = p[0] + mm(3.4), y = p[1] - mm(3.4); g.strokeText(t, x, y); g.fillText(t, x, y); });
  g.globalAlpha = 1; g.restore();
  // frame
  g.strokeStyle = '#000'; g.lineWidth = mm(0.3); g.strokeRect(FX, FY, FW, FH);
  // info block
  const IX = Lo.o === 'landscape' ? FX + FW + mm(4) : FX, IY = Lo.o === 'landscape' ? FY : FY + FH + mm(4), IW = Lo.o === 'landscape' ? mm(INFO) : FW;
  let y = IY; const txt = (s, sz, bold, x = IX, col = '#000') => { g.fillStyle = col; g.font = `${bold ? 'bold ' : ''}${mm(sz)}px Arial,Helvetica,sans-serif`; g.textBaseline = 'top'; g.fillText(s, x, y); y += mm(sz * 1.35); };
  const title = (c.area && c.area.properties && c.area.properties.name && c.area.properties.name !== 'Drawn area' ? c.area.properties.name : 'Orienteering course');
  txt(title, 5, true); txt(`${DIFF[c.diff].label} · ${c.controls.length} controls · ${(c.length / 1000).toFixed(2)} km ${c.score ? '(score)' : ''}`, 3, false);
  txt(`Scale 1:${scale.toLocaleString('en-US')} · ${cInfo}`, 2.6, false);
  txt(`Magnetic declination ${Math.abs(dec.d).toFixed(1)}° ${dec.d < 0 ? 'W' : 'E'} (${dec.src}) — blue lines = magnetic north`, 2.2, false, IX, dec.src.startsWith('APPROX') ? '#c00' : '#000');
  if (!fits) txt(`⚠ Course is larger than the sheet at 1:${scale}; choose a smaller scale.`, 2.4, true, IX, '#c00');
  // scale bar (0-500 m at 1:10k)
  const sbM = scale <= 5000 ? 200 : scale <= 10000 ? 500 : 1000, sbW = sbM * mpx; y += mm(1);
  for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#fff' : '#000'; g.fillRect(IX + i * sbW / 5, y, sbW / 5, mm(1.5)); } g.strokeStyle = '#000'; g.lineWidth = mm(0.15); g.strokeRect(IX, y, sbW, mm(1.5));
  y += mm(2); g.fillStyle = '#000'; g.font = `${mm(2.3)}px Arial`; g.fillText('0', IX, y); g.fillText(sbM + ' m', IX + sbW - mm(5), y);
  // north arrow (true north up) + MN arrow
  const nx = IX + sbW + mm(12), ny = y + mm(3); g.beginPath(); g.moveTo(nx, ny - mm(7)); g.lineTo(nx - mm(2), ny); g.lineTo(nx + mm(2), ny); g.closePath(); g.fill(); g.fillText('N', nx - mm(1), ny + mm(0.8));
  g.strokeStyle = C.water; g.lineWidth = mm(0.3); g.beginPath(); g.moveTo(nx + mm(6), ny + mm(2)); g.lineTo(nx + mm(6) + mm(9) * Math.sin(a), ny + mm(2) - mm(9) * Math.cos(a)); g.stroke(); g.fillStyle = C.water; g.fillText('MN', nx + mm(7.5), ny + mm(0.8));
  y += mm(8);
  // control description table (IOF style, words)
  const colX = [0, 7, 16].map(v => IX + mm(v)), rh = mm(4.2); const tw = Math.min(IW, mm(62));
  const cell = (cols, bold, bg) => { if (bg) { g.fillStyle = bg; g.fillRect(IX, y, tw, rh); } g.strokeStyle = '#000'; g.lineWidth = mm(0.15); g.strokeRect(IX, y, tw, rh); [1, 2].forEach(i => { g.beginPath(); g.moveTo(colX[i], y); g.lineTo(colX[i], y + rh); g.stroke(); });
    g.fillStyle = '#000'; g.font = `${bold ? 'bold ' : ''}${mm(2.5)}px Arial`; g.textBaseline = 'middle'; cols.forEach((s, i) => g.fillText(String(s), colX[i] + mm(0.8), y + rh / 2, (i === 2 ? tw - mm(17) : mm(7)))); y += rh; };
  const desc0 = y;
  cell(['#', 'Code', `${DIFF[c.diff].label} — ${(c.length / 1000).toFixed(1)} km`], true, '#eee');
  cell(['▷', '', 'Start: ' + (/trail|auto/.test(String(document.getElementById('startInfo').textContent)) ? 'path' : 'start point')], false);
  c.controls.forEach((k, i) => cell([k.n, 31 + i, `${FEATURE_WORDS[k.kind] || k.kind}${k.dTrail != null && k.dTrail > 2 ? ', ' + Math.round(k.dTrail) + ' m from path' : ''}${k.wooded ? ', in forest' : ''}`], false));
  cell(['◎', '', 'Finish (= start)'], false);
  // legend
  if (Lo.o === 'landscape') y += mm(3); else { y = desc0; }
  const LX = Lo.o === 'landscape' ? IX : IX + tw + mm(6);
  const LY0 = y; let LXc = LX, nsw = 0;
  const sw = (draw, label) => { if (Lo.o !== 'landscape' && nsw++ === 8) { LXc = LX + mm(48); y = LY0; } const LX_ = LXc; draw(LX_, y); g.fillStyle = '#000'; g.font = `${mm(2.3)}px Arial`; g.textBaseline = 'middle'; g.fillText(label, LX_ + mm(9), y + mm(1.5)); y += mm(3.8); };
  const box = col => (x, yy) => { g.fillStyle = col; g.fillRect(x, yy, mm(7), mm(3)); g.strokeStyle = '#999'; g.lineWidth = 1; g.strokeRect(x, yy, mm(7), mm(3)); };
  const ln = (col, w, dash) => (x, yy) => { g.beginPath(); g.moveTo(x, yy + mm(1.5)); g.lineTo(x + mm(7), yy + mm(1.5)); g.strokeStyle = col; g.lineWidth = mm(w); g.setLineDash(dash ? dash.map(mm) : []); g.stroke(); g.setLineDash([]); };
  sw(box('#fff'), 'Forest, easy running'); sw(box(C.open), 'Open land'); sw(box(C.rough), 'Rough open land'); sw(box(C.walk), 'Scrub / vegetation, walk');
  sw(box(C.waterLight), 'Water'); sw(ln(C.water, 0.25), 'Stream'); sw(box(C.oob), 'Out of bounds / settlement'); sw(box('#000'), 'Building');
  sw((x, yy) => { ln('#000', 1.0)(x, yy); ln(C.paved, 0.7)(x, yy); }, 'Road'); sw(ln('#000', 0.35, [2.5, 0.35]), 'Vehicle track'); sw(ln('#000', 0.25, [2, 0.25]), 'Footpath');
  sw(ln(C.brown, 0.14), 'Contour 5 m'); sw(ln(C.brown, 0.25), 'Index contour 25 m'); sw(ln(C.water, 0.18), 'Magnetic north line');
  sw((x, yy) => { g.strokeStyle = C.course; g.lineWidth = mm(0.35); g.beginPath(); g.arc(x + mm(3.5), yy + mm(1.5), mm(1.5), 0, 7); g.stroke(); }, 'Control (Ø 6 mm on map)');
  g.fillStyle = '#666'; g.font = `${mm(1.8)}px Arial`; g.textBaseline = 'bottom';
  g.fillText('Map data © OpenStreetMap contributors (ODbL) · Elevation: AWS Terrain Tiles (Mapzen, SRTM/USGS 3DEP et al.) · Generated by Orienteer · ISOM-style approximation, not field-checked', M * PXMM, cv.height - mm(2));
  return { canvas:cv, paper:paperName, orientation:Lo.o, scale, fits, declination:dec, widthMM:Lo.W, heightMM:Lo.H };
}

async function printDialog() {
  if (!S.course) return status('Generate a course first.');
  modal(`<h3>Print orienteering map</h3>
    <div class="row wrap"><label>Scale <select id="pmScale"><option value="5000">1:5 000</option><option value="10000" selected>1:10 000</option><option value="15000">1:15 000</option></select></label>
    <label>Paper <select id="pmPaper"><option value="">Auto</option><option>A4</option><option>Letter</option></select></label>
    <label>Orientation <select id="pmOr"><option value="">Auto</option><option>portrait</option><option>landscape</option></select></label></div>
    <div class="row wrap"><button id="pmGo" class="primary">Render map</button><button id="pmPng" disabled>⬇ PNG</button><button id="pmPrint" disabled>🖨 Print / PDF</button><button id="pmList">Control list only</button></div>
    <div id="pmMsg" class="small"></div><img id="pmImg" style="max-width:100%;margin-top:6px;border:1px solid #ccc" hidden>`);
  let res = null;
  const go = async () => { $('pmGo').disabled = true; $('pmMsg').textContent = 'Rendering…';
    try { res = await render({ scale:$('pmScale').value, paper:$('pmPaper').value, orientation:$('pmOr').value, progress:t => $('pmMsg').textContent = t });
      $('pmImg').src = res.canvas.toDataURL('image/png'); $('pmImg').hidden = false; $('pmPng').disabled = $('pmPrint').disabled = false;
      $('pmMsg').textContent = `${res.paper} ${res.orientation}, 1:${res.scale}${res.fits ? '' : ' — course does not fit, try a smaller scale'}. For PDF, use Print → Save as PDF.`; }
    catch (e) { console.error(e); $('pmMsg').textContent = 'Failed: ' + e.message; }
    $('pmGo').disabled = false; };
  $('pmGo').onclick = go;
  $('pmPng').onclick = () => { const a = document.createElement('a'); a.href = res.canvas.toDataURL('image/png'); a.download = `orienteer-map-1-${res.scale}.png`; a.click(); };
  $('pmPrint').onclick = () => printImage(res);
  $('pmList').onclick = () => { $('modal').hidden = true; legacyPrint(); };
  go();
}
function printImage(res) {
  let st = document.getElementById('pmPage'); if (!st) { st = document.createElement('style'); st.id = 'pmPage'; document.head.appendChild(st); }
  st.textContent = `@page{size:${res.paper === 'Letter' ? 'letter' : 'A4'} ${res.orientation};margin:0}`;
  $('printSheet').innerHTML = `<img src="${res.canvas.toDataURL('image/png')}" style="width:${res.widthMM}mm;height:${res.heightMM}mm;display:block">`;
  document.body.classList.add('printmap'); $('modal').hidden = true;
  setTimeout(() => { window.print(); document.body.classList.remove('printmap'); st.textContent = ''; }, 300);
}
let legacyPrint = () => {};
window.PrintMap = { render, printDialog, setLegacy: f => legacyPrint = f };
})();
