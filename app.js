'use strict';
/* Orienteer – virtual orienteering course generator (prototype). Plain JS, Leaflet + turf. */
const $ = id => document.getElementById(id);
const MAGENTA = '#c4007a';
const OVERPASS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'];
const DIFF = { easy:{min:0,max:10,label:'Easy'}, medium:{min:15,max:50,label:'Medium'}, hard:{min:50,max:150,label:'Hard'}, expert:{min:150,max:Infinity,label:'Expert'} };
const S = { area:null, data:null, start:null, course:null, diff:'easy', run:null };
const status = (t) => { $('status').textContent = t; console.log('[status]', t); };

/* ---------- map ---------- */
const map = L.map('map', { zoomControl:true }).setView([39.5,-98.35], 4);
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'});
const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Imagery © Esri'});
const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{maxZoom:19,maxNativeZoom:16,subdomains:'abc',attribution:'Map: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · Data: © OpenStreetMap contributors, SRTM'});
const usgs = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,maxNativeZoom:16,attribution:'Tiles courtesy of the <a href="https://www.usgs.gov/">U.S. Geological Survey</a> (The National Map)'});
const BASES = { 'Topo (OpenTopoMap)':topo, 'Topo US (USGS)':usgs, 'Street (OSM)':osm, 'Satellite (Esri)':sat };
(BASES[localStorage.getItem('orienteer.base')] || topo).addTo(map);
map.on('baselayerchange', e => localStorage.setItem('orienteer.base', e.name));
L.control.layers(BASES, null, { position:'topright' }).addTo(map);
map.attributionControl.setPrefix(false); map.zoomControl.setPosition('topright');
const areaLayer = L.layerGroup().addTo(map), trailLayer = L.layerGroup().addTo(map), courseLayer = L.layerGroup().addTo(map), meLayer = L.layerGroup().addTo(map), drawLayer = L.layerGroup().addTo(map);

/* ---------- search (Nominatim) ---------- */
async function search() {
  const q = $('q').value.trim(); if (!q) return;
  status('Searching…');
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.00005&limit=6&q=' + encodeURIComponent(q));
  const js = await r.json();
  $('results').innerHTML = '';
  js.forEach(it => {
    const d = document.createElement('div');
    const hasPoly = it.geojson && /Polygon/.test(it.geojson.type);
    d.textContent = it.display_name + (hasPoly ? '  ▸ use boundary' : '');
    d.onclick = () => {
      $('results').innerHTML = '';
      const b = it.boundingbox.map(Number); map.fitBounds([[b[0],b[2]],[b[1],b[3]]]);
      if (hasPoly) setArea(turf.feature(it.geojson, { name: it.display_name.split(',')[0] }));
    };
    $('results').appendChild(d);
  });
  status(js.length ? 'Pick a result (parks with a boundary can be used directly).' : 'No results.');
}
$('searchBtn').onclick = search; $('q').addEventListener('keydown', e => e.key === 'Enter' && search());

/* ---------- Overpass ---------- */
async function overpass(q) {
  let lastErr;
  for (let round = 0; round < 3; round++) {
  if (round) { status(`Overpass servers busy – retrying in ${5*round}s (round ${round+1}/3)…`); await new Promise(r => setTimeout(r, 5000*round)); }
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
      const r = await fetch(url, { method:'POST', body:'data=' + encodeURIComponent(q), headers:{'Content-Type':'application/x-www-form-urlencoded'}, signal:ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; console.warn('overpass fail', e); status('Overpass busy, trying another server…'); }
  }}
  throw lastErr || new Error('Overpass failed');
}
const bboxStr = (f) => { const b = turf.bbox(f); return `${b[1]},${b[0]},${b[3]},${b[2]}`; };

/* stitch way geometries (lists of [lon,lat]) into closed rings */
function stitch(lines) {
  const segs = lines.map(l => l.slice()); const rings = [];
  const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  while (segs.length) {
    let ring = segs.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length-1]) && guard++ < 5000) {
      const end = key(ring[ring.length-1]);
      const i = segs.findIndex(s => key(s[0]) === end || key(s[s.length-1]) === end);
      if (i < 0) break;
      let s = segs.splice(i,1)[0]; if (key(s[0]) !== end) s = s.reverse();
      ring = ring.concat(s.slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length-1])) rings.push(ring);
  }
  return rings;
}
function elementToPolygons(el) {
  const g = a => a.map(p => [p.lon, p.lat]);
  if (el.type === 'way' && el.geometry) {
    const c = g(el.geometry); if (c.length >= 4 && c[0][0] === c[c.length-1][0] && c[0][1] === c[c.length-1][1]) return [[c]]; return [];
  }
  if (el.type === 'relation' && el.members) {
    const outers = stitch(el.members.filter(m => m.type === 'way' && m.geometry && m.role !== 'inner').map(m => g(m.geometry)));
    const inners = stitch(el.members.filter(m => m.type === 'way' && m.geometry && m.role === 'inner').map(m => g(m.geometry)));
    return outers.map(o => { const poly = [o]; const op = turf.polygon([o]);
      inners.forEach(i => { if (turf.booleanPointInPolygon(turf.point(i[0]), op)) poly.push(i); }); return poly; });
  }
  return [];
}

/* ---------- area selection ---------- */
function setArea(f) {
  if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') return status('Area must be a polygon.');
  S.area = f; S.data = null; S.course = null; courseLayer.clearLayers(); trailLayer.clearLayers();
  areaLayer.clearLayers();
  L.geoJSON(f, { style:{ color:'#333', weight:2, dashArray:'6 4', fill:true, fillOpacity:0.05 }, interactive:false }).addTo(areaLayer);
  map.fitBounds(L.geoJSON(f).getBounds(), { padding:[20,20] });
  const km2 = turf.area(f) / 1e6;
  status(`Area set${f.properties && f.properties.name ? ': ' + f.properties.name : ''} (${km2.toFixed(2)} km²). ${km2 > 30 ? 'Large area – data fetch may be slow; consider drawing a smaller rectangle.' : 'Now pick difficulty and Generate.'}`);
  if (!S.start) { const c = turf.centroid(f).geometry.coordinates; }
}
/* ---------- touch-friendly drawing (v2) ----------
   Draw modes: poly | rect | circle | start. While drawing: map dragging + dbl-tap zoom off,
   panel collapsed, big bottom toolbar + banner. Each tap = one point. */
let drawMode = null, drawPts = [], circleCenter = null, panelWasOpen = null;
const BANNER = {
  poly:'Tap points around the area, then tap Done',
  rect:'Tap two opposite corners of the rectangle',
  circle:'Tap the map to place the circle centre (or use “Around me”), set the radius, then tap Done',
  start:'Tap the map to set the start'
};
function collapsePanel(on) {
  const b = $('panelBody');
  if (on) { panelWasOpen = !b.hidden; b.hidden = true; $('togglePanel').textContent = '▸'; $('panel').classList.add('drawing'); }
  else { $('panel').classList.remove('drawing'); if (panelWasOpen) { b.hidden = false; $('togglePanel').textContent = '▾'; } panelWasOpen = null; }
}
function startDraw(mode) {
  endDraw(true);
  drawMode = mode; drawPts = []; circleCenter = null;
  map.dragging.disable(); map.doubleClickZoom.disable(); if (map.tap) map.tap.disable();
  map.getContainer().classList.add('drawing-map');
  collapsePanel(true);
  $('drawBar').hidden = false; $('drawBar').dataset.mode = mode;
  $('drawBanner').textContent = BANNER[mode];
  $('circleRow').hidden = mode !== 'circle';
  $('dUndo').hidden = $('dClear').hidden = !(mode === 'poly' || mode === 'rect');
  $('dDone').hidden = mode === 'rect' || mode === 'start';
  renderDraw();
}
function endDraw(silent) {
  const was = drawMode;
  drawMode = null; drawPts = []; circleCenter = null; drawLayer.clearLayers();
  map.dragging.enable(); map.doubleClickZoom.enable();
  map.getContainer().classList.remove('drawing-map');
  $('drawBar').hidden = true;
  if (was) collapsePanel(false);
}
const ll = q => [q[1], q[0]];
function renderDraw() {
  drawLayer.clearLayers();
  let info = '';
  if (drawMode === 'poly' || drawMode === 'rect') {
    if (drawMode === 'poly' && drawPts.length >= 2)
      L.polygon(drawPts.map(ll), { color:MAGENTA, weight:3, fillOpacity:0.15, dashArray: drawPts.length < 3 ? '6 6' : null, interactive:false }).addTo(drawLayer);
    if (drawMode === 'rect' && drawPts.length === 1) info = ' — now tap the opposite corner';
    drawPts.forEach((q, i) => L.circleMarker(ll(q), { radius: i === 0 ? 12 : 9, color:'#fff', weight:3, fillColor: i === 0 ? '#ff9800' : MAGENTA, fillOpacity:1, interactive:false }).addTo(drawLayer));
    if (drawMode === 'poly') info = ` — ${drawPts.length} point${drawPts.length === 1 ? '' : 's'}` + (drawPts.length >= 3 ? ' (tap the orange first point or Done to close)' : drawPts.length ? ` (need ${3 - drawPts.length} more)` : '');
  }
  if (drawMode === 'circle') {
    const r = +$('circR').value; $('circROut').textContent = r >= 1000 ? (r/1000).toFixed(2).replace(/0$/,'') + ' km' : r + ' m';
    if (circleCenter) { L.circle(ll(circleCenter), { radius:r, color:MAGENTA, weight:3, fillOpacity:0.15, interactive:false }).addTo(drawLayer);
      L.circleMarker(ll(circleCenter), { radius:8, color:'#fff', weight:3, fillColor:MAGENTA, fillOpacity:1, interactive:false }).addTo(drawLayer); }
    else info = ' — no centre yet';
  }
  $('drawBanner').textContent = BANNER[drawMode] + info;
  $('dUndo').disabled = !drawPts.length; $('dClear').disabled = !drawPts.length;
  $('dDone').disabled = drawMode === 'poly' ? drawPts.length < 3 : drawMode === 'circle' ? !circleCenter : true;
}
function finishPoly() { if (drawPts.length < 3) return; const ring = drawPts.concat([drawPts[0]]); endDraw(); setArea(turf.feature(turf.polygon([ring]).geometry, { name:'Drawn area' })); }
function finishRect() { const [a,b] = drawPts; endDraw(); if (Math.abs(a[0]-b[0]) < 1e-6 || Math.abs(a[1]-b[1]) < 1e-6) return status('Rectangle too thin – try again.'); setArea(turf.feature(turf.bboxPolygon([Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]).geometry, { name:'Rectangle' })); }
function finishCircle() { if (!circleCenter) return; const r = +$('circR').value, c = circleCenter; endDraw(); setArea(turf.feature(turf.circle(c, r/1000, { steps:64, units:'kilometers' }).geometry, { name:`Circle ${r} m` })); }
function useView() {
  endDraw(); const b = map.getBounds();
  if (map.getZoom() < 12) return status('Zoom in closer first (the view is too large for a course area).');
  setArea(turf.feature(turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]).geometry, { name:'Map view' }));
}
map.on('click', e => {
  if (!drawMode) return;
  const p = [e.latlng.lng, e.latlng.lat];
  if (drawMode === 'start') { endDraw(); setStart(e.latlng.lat, e.latlng.lng, 'tap'); return; }
  if (drawMode === 'rect') { drawPts.push(p); if (drawPts.length === 2) return finishRect(); return renderDraw(); }
  if (drawMode === 'poly') {
    if (drawPts.length >= 3 && map.latLngToContainerPoint(L.latLng(drawPts[0][1], drawPts[0][0])).distanceTo(e.containerPoint) < 32) return finishPoly();
    drawPts.push(p); return renderDraw();
  }
  if (drawMode === 'circle') { circleCenter = p; renderDraw(); }
});
$('drawPoly').onclick = () => startDraw('poly');
$('drawRect').onclick = () => startDraw('rect');
$('drawCircle').onclick = () => startDraw('circle');
$('useView').onclick = useView;
$('startTap').onclick = () => startDraw('start');
$('dUndo').onclick = () => { drawPts.pop(); renderDraw(); };
$('dClear').onclick = () => { drawPts = []; renderDraw(); };
$('dCancel').onclick = () => { endDraw(); status('Drawing cancelled.'); };
$('dDone').onclick = () => drawMode === 'poly' ? finishPoly() : drawMode === 'circle' ? finishCircle() : null;
$('circR').oninput = renderDraw;
$('circMe').onclick = () => { $('drawBanner').textContent = 'Getting your location…';
  navigator.geolocation.getCurrentPosition(pos => { if (drawMode !== 'circle') return; circleCenter = [pos.coords.longitude, pos.coords.latitude]; map.setView(ll(circleCenter), Math.max(map.getZoom(), 14)); renderDraw(); },
    err => { $('drawBanner').textContent = 'Location error: ' + err.message; }, { enableHighAccuracy:true, timeout:20000 }); };
$('clearArea').onclick = () => { endDraw(); S.area = null; areaLayer.clearLayers(); courseLayer.clearLayers(); trailLayer.clearLayers(); status('Area cleared.'); };

$('pickPark').onclick = async () => {
  const b = map.getBounds(); if (map.getZoom() < 11) return status('Zoom in closer (search for a place first).');
  const bb = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  status('Looking for parks in view…');
  try {
    const js = await overpass(`[out:json][timeout:50];(way["leisure"~"^(park|nature_reserve)$"]["name"](${bb});relation["leisure"~"^(park|nature_reserve)$"]["name"](${bb});way["boundary"="protected_area"]["name"](${bb});relation["boundary"="protected_area"]["name"](${bb}););out tags bb;`);
    const els = js.elements.filter(e => e.bounds).map(e => ({ e, sz:(e.bounds.maxlat-e.bounds.minlat)*(e.bounds.maxlon-e.bounds.minlon) })).sort((a,b) => b.sz - a.sz).slice(0, 25);
    $('parks').innerHTML = els.length ? '' : '<div>No named parks in view.</div>';
    els.forEach(({e}) => { const d = document.createElement('div'); d.textContent = `${e.tags.name} (${e.tags.leisure || e.tags.boundary})`; d.onclick = () => loadPark(e); $('parks').appendChild(d); });
    status(`${els.length} parks found – tap one.`);
  } catch (err) { status('Park lookup failed: ' + err.message); }
};
async function loadPark(e) {
  $('parks').innerHTML = ''; status('Loading boundary of ' + e.tags.name + '…');
  const js = await overpass(`[out:json][timeout:50];${e.type}(${e.id});out geom;`);
  const polys = elementToPolygons(js.elements[0]);
  if (!polys.length) return status('Could not build a polygon for that park.');
  setArea(turf.feature(polys.length === 1 ? { type:'Polygon', coordinates:polys[0] } : { type:'MultiPolygon', coordinates:polys }, { name:e.tags.name }));
}

/* ---------- start ---------- */
function setStart(lat, lon, src) {
  S.start = [lon, lat];
  $('startInfo').textContent = `start: ${lat.toFixed(5)}, ${lon.toFixed(5)} (${src})`;
  if (S.course) { S.course = null; courseLayer.clearLayers(); }
  courseLayer.clearLayers(); L.marker([lat, lon], { icon:triIcon() }).addTo(courseLayer);
}
$('startGps').onclick = () => { status('Getting location…'); navigator.geolocation.getCurrentPosition(p => { setStart(p.coords.latitude, p.coords.longitude, `GPS ±${Math.round(p.coords.accuracy)} m`); status('Start set from GPS.'); }, err => status('Location error: ' + err.message), { enableHighAccuracy:true, timeout:20000 }); };

/* ---------- local metric projection + spatial grid ---------- */
function makeProj(lat0, lon0) { const kx = Math.cos(lat0*Math.PI/180)*111320, ky = 110574;
  return { f:(lon,lat) => [(lon-lon0)*kx, (lat-lat0)*ky], inv:(x,y) => [x/kx+lon0, y/ky+lat0] }; }
function segDist(px,py,ax,ay,bx,by){ const dx=bx-ax, dy=by-ay, l=dx*dx+dy*dy; let t = l ? ((px-ax)*dx+(py-ay)*dy)/l : 0; t = t<0?0:t>1?1:t; const x=ax+t*dx-px, y=ay+t*dy-py; return Math.sqrt(x*x+y*y); }
class SegGrid {
  constructor(cell=100){ this.c=cell; this.m=new Map(); this.n=0; }
  add(ax,ay,bx,by){ const s=[ax,ay,bx,by]; this.n++; const c=this.c;
    for(let i=Math.floor(Math.min(ax,bx)/c);i<=Math.floor(Math.max(ax,bx)/c);i++) for(let j=Math.floor(Math.min(ay,by)/c);j<=Math.floor(Math.max(ay,by)/c);j++){ const k=i+','+j; let a=this.m.get(k); if(!a) this.m.set(k,a=[]); a.push(s);} }
  addLine(pts){ for(let i=1;i<pts.length;i++) this.add(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]); }
  nearest(x,y,maxR=1000){ const c=this.c, ci=Math.floor(x/c), cj=Math.floor(y/c); let best=Infinity;
    for(let r=0;r*c<=maxR+c;r++){ if(best < (r-1)*c) break;
      for(let i=ci-r;i<=ci+r;i++) for(let j=cj-r;j<=cj+r;j++){ if(Math.max(Math.abs(i-ci),Math.abs(j-cj))!==r) continue; const a=this.m.get(i+','+j); if(!a) continue; for(const s of a){ const d=segDist(x,y,s[0],s[1],s[2],s[3]); if(d<best) best=d; } } }
    return best; }
}
function pip(x,y,ring){ let ins=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++){ const a=ring[i], b=ring[j]; if(((a[1]>y)!==(b[1]>y)) && (x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])) ins=!ins; } return ins; }
class PolySet { constructor(){ this.p=[]; } add(rings){ let x0=1e18,y0=1e18,x1=-1e18,y1=-1e18; for(const q of rings[0]){ x0=Math.min(x0,q[0]);x1=Math.max(x1,q[0]);y0=Math.min(y0,q[1]);y1=Math.max(y1,q[1]); } this.p.push({rings,b:[x0,y0,x1,y1]}); }
  has(x,y){ for(const {rings,b} of this.p){ if(x<b[0]||x>b[2]||y<b[1]||y>b[3]) continue; if(pip(x,y,rings[0]) && !rings.slice(1).some(r=>pip(x,y,r))) return true; } return false; } }

/* ---------- data fetch ---------- */
async function fetchData() {
  if (S.data && S.data.roads === $('roads').checked) return S.data;
  const bb = bboxStr(turf.buffer(S.area, 0.2, { units:'kilometers' }));
  status('Fetching trails, water, buildings, cliffs from OpenStreetMap…');
  const roads = $('roads').checked;
  const hw = roads ? 'path|footway|track|bridleway|cycleway|steps|pedestrian|living_street|residential|service|unclassified|tertiary|secondary' : 'path|footway|track|bridleway|cycleway|steps|pedestrian';
  const q = `[out:json][timeout:90];(
    way["highway"~"^(${hw})$"](${bb});
    way["natural"="water"](${bb});relation["natural"="water"](${bb});
    way["waterway"](${bb});way["landuse"~"^(reservoir|basin)$"](${bb});
    way["building"](${bb});
    way["natural"="cliff"](${bb});way["barrier"~"^(wall|retaining_wall)$"](${bb});
    way["natural"="wood"](${bb});way["landuse"="forest"](${bb});relation["natural"="wood"](${bb});relation["landuse"="forest"](${bb});
  );out geom;`;
  const js = await overpass(q);
  const c = turf.centroid(S.area).geometry.coordinates; const P = makeProj(c[1], c[0]);
  const D = { roads, P, trails:[], trailGrid:new SegGrid(60), hazGrid:new SegGrid(60), blocked:new PolySet(), wood:new PolySet(), nodeUse:new Map(), counts:{trail:0,water:0,building:0,cliff:0,wood:0} };
  for (const el of js.elements) {
    const t = el.tags || {};
    if (el.type === 'way' && t.highway) {
      const ll = el.geometry.map(p => [p.lon, p.lat]); const xy = ll.map(p => P.f(p[0], p[1]));
      D.trails.push({ ll, xy, nodes:el.nodes || [], hw:t.highway }); D.trailGrid.addLine(xy); D.counts.trail++;
      (el.nodes || []).forEach((n, i) => { const u = D.nodeUse.get(n) || { c:0, xy:xy[i], ll:ll[i] }; u.c++; D.nodeUse.set(n, u); });
    } else if (t.natural === 'wood' || t.landuse === 'forest') {
      elementToPolygons(el).forEach(p => D.wood.add(p.map(r => r.map(q => P.f(q[0], q[1]))))); D.counts.wood++;
    } else if (t.natural === 'cliff' || t.barrier) {
      if (el.geometry) D.hazGrid.addLine(el.geometry.map(p => P.f(p.lon, p.lat))); D.counts.cliff++;
    } else if (t.waterway && el.type === 'way' && !['riverbank','dock'].includes(t.waterway)) {
      D.hazGrid.addLine(el.geometry.map(p => P.f(p.lon, p.lat))); D.counts.water++;
    } else {
      const polys = elementToPolygons(el);
      polys.forEach(p => { const rings = p.map(r => r.map(q => P.f(q[0], q[1]))); D.blocked.add(rings); rings.forEach(r => D.hazGrid.addLine(r)); });
      if (t.building) D.counts.building++; else D.counts.water++;
    }
  }
  // area in projected coords
  const geom = S.area.geometry; const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  D.areaPolys = polys.map(p => p.map(r => r.map(q => P.f(q[0], q[1]))));
  D.edgeGrid = new SegGrid(100); D.areaPolys.forEach(p => p.forEach(r => D.edgeGrid.addLine(r)));
  D.inArea = (x,y) => D.areaPolys.some(p => pip(x,y,p[0]) && !p.slice(1).some(r => pip(x,y,r)));
  S.data = D;
  trailLayer.clearLayers();
  D.trails.forEach(t => L.polyline(t.ll.map(p => [p[1],p[0]]), { color:'#8a5a00', weight:1.5, opacity:0.5, dashArray: /path|footway|track|bridleway/.test(t.hw) ? '4 3' : null, interactive:false }).addTo(trailLayer));
  status(`Loaded ${D.counts.trail} trails/paths, ${D.counts.water} water, ${D.counts.building} buildings, ${D.counts.cliff} cliffs/walls.`);
  return D;
}

/* ---------- candidate generation ---------- */
function okSpot(D, x, y, edgeMin=8) {
  if (!D.inArea(x,y)) return false;
  if (D.edgeGrid.nearest(x,y,edgeMin) < edgeMin) return false;
  if (D.blocked.has(x,y)) return false;
  if (D.hazGrid.nearest(x,y,12) < 12) return false;
  return true;
}
function candidates(D, diff) {
  const R = DIFF[diff]; const out = [];
  if (diff === 'easy') {
    // trail features: junctions, ends, bends – only on trails inside area
    const feat = (xy, ll, kind) => { if (okSpot(D, xy[0], xy[1], 3)) out.push({ xy, kind, d:D.trailGrid.nearest(xy[0], xy[1], 20) }); };
    for (const [, u] of D.nodeUse) if (u.c >= 2) feat(u.xy, u.ll, 'junction');
    for (const t of D.trails) {
      const n = t.nodes;
      [0, t.xy.length-1].forEach(i => { const u = D.nodeUse.get(n[i]); if (u && u.c === 1) feat(t.xy[i], t.ll[i], 'trail end'); });
      for (let i = 1; i < t.xy.length-1; i++) {
        const a=t.xy[i-1], b=t.xy[i], c=t.xy[i+1];
        const ang = Math.abs(Math.atan2(c[1]-b[1], c[0]-b[0]) - Math.atan2(b[1]-a[1], b[0]-a[0]));
        const turn = Math.min(ang, 2*Math.PI-ang) * 180/Math.PI;
        if (turn > 50 && Math.hypot(a[0]-b[0],a[1]-b[1]) > 8 && Math.hypot(c[0]-b[0],c[1]-b[1]) > 8) feat(b, t.ll[i], 'bend');
      }
    }
    return dedupe(out, 15);
  }
  // off-trail: random sampling inside area
  const bb = D.areaPolys.flat(2).reduce((b,q) => [Math.min(b[0],q[0]),Math.min(b[1],q[1]),Math.max(b[2],q[0]),Math.max(b[3],q[1])], [1e18,1e18,-1e18,-1e18]);
  const areaM2 = turf.area(S.area); const N = Math.min(12000, Math.max(3000, Math.round(areaM2 / 400)));
  const all = [];
  for (let i = 0; i < N * 3 && all.length < N; i++) {
    const x = bb[0] + Math.random()*(bb[2]-bb[0]), y = bb[1] + Math.random()*(bb[3]-bb[1]);
    if (!okSpot(D, x, y)) continue;
    const d = D.trailGrid.nearest(x, y, Math.min(R.max, 2000) + 50);
    all.push({ xy:[x,y], d, kind:'off-trail' });
    if (d >= R.min && d <= R.max) out.push(all[all.length-1]);
  }
  if (diff === 'expert' && out.length < 15) {
    // as far as the area allows: take the most remote decile (but at least Hard level)
    const s = all.filter(c => c.d >= 50).sort((a,b) => b.d - a.d);
    const extra = s.slice(0, Math.max(30, Math.floor(s.length * 0.1)));
    extra.forEach(c => { c.kind = 'max-remote'; out.push(c); });
  }
  return dedupe(out, 10);
}
function dedupe(arr, m) { const g = new Map(), res = [];
  for (const c of arr) { const k = Math.floor(c.xy[0]/m)+','+Math.floor(c.xy[1]/m); if (g.has(k)) continue; g.set(k,1); res.push(c); } return res; }

/* ---------- course building: pick N spaced controls, order into loop near target length ---------- */
const dist = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
function loopLen(st, pts) { let L = 0, p = st; for (const q of pts) { L += dist(p,q); p = q; } return L + dist(p, st); }
function orderLoop(st, pts) {
  // nearest neighbour then 2-opt
  let rest = pts.slice(), cur = st, ord = [];
  while (rest.length) { let bi = 0, bd = Infinity; rest.forEach((p,i) => { const d = dist(cur, p.xy); if (d < bd) { bd = d; bi = i; } }); cur = rest[bi].xy; ord.push(rest.splice(bi,1)[0]); }
  let improved = true, guard = 0;
  while (improved && guard++ < 50) { improved = false;
    for (let i = 0; i < ord.length - 1; i++) for (let k = i + 1; k < ord.length; k++) {
      const cand = ord.slice(0,i).concat(ord.slice(i,k+1).reverse(), ord.slice(k+1));
      if (loopLen(st, cand.map(c=>c.xy)) < loopLen(st, ord.map(c=>c.xy)) - 0.1) { ord = cand; improved = true; }
    } }
  return ord;
}
function buildCourse(D, cands, n, target, st) {
  const MIN_SEP = 50;
  let best = null;
  const near = cands.filter(c => dist(c.xy, st) <= Math.max(target * 0.55, 300) && dist(c.xy, st) >= 40);
  const pool = near.length >= n ? near : cands.filter(c => dist(c.xy, st) >= 40);
  if (!pool.length) return null;
  for (let trial = 0; trial < 250; trial++) {
    // vary sampling radius per trial to explore lengths
    const rad = target * (0.15 + Math.random()*0.45);
    const sh = pool.slice().sort(() => Math.random() - 0.5).sort((a,b) => Math.abs(dist(a.xy,st)-rad*(0.5+Math.random())) - Math.abs(dist(b.xy,st)-rad*(0.5+Math.random())));
    const pick = [];
    for (const c of sh) { if (pick.length >= n) break; if (pick.every(p => dist(p.xy, c.xy) >= MIN_SEP)) pick.push(c); }
    if (pick.length < Math.min(n, 5) && trial < 249) continue;
    const ord = orderLoop(st, pick); const len = loopLen(st, ord.map(c=>c.xy));
    const score = Math.abs(len - target) / target + (n - pick.length) * 0.5;
    if (!best || score < best.score) best = { ord, len, score };
    if (best.score < 0.05 && pick.length === n) break;
  }
  return best;
}

async function generate() {
  try {
    if (!S.area) return status('Select an area first (search, draw, or pick a park).');
    const D = await fetchData();
    if (!D.trails.length) status('Warning: no trails found in this area — distances are measured to nothing. Try enabling roads.');
    if (!S.start) { // default start: trail junction / point nearest the area centroid on a trail
      const c = turf.centroid(S.area).geometry.coordinates; let best = null;
      for (const t of D.trails) for (let i = 0; i < t.xy.length; i++) if (D.inArea(t.xy[i][0], t.xy[i][1])) { const dd = dist(t.xy[i], D.P.f(c[0], c[1])); if (!best || dd < best.d) best = { d:dd, ll:t.ll[i] }; }
      const ll = best ? best.ll : c; setStart(ll[1], ll[0], 'auto: trail near centre');
    }
    const st = D.P.f(S.start[0], S.start[1]);
    status('Generating ' + DIFF[S.diff].label + ' course…');
    await new Promise(r => setTimeout(r, 20));
    const cands = candidates(D, S.diff);
    if (cands.length < 5) return status(`Only ${cands.length} valid ${DIFF[S.diff].label} control sites in this area. Try a bigger area or a different difficulty.`);
    const n = +$('n').value, target = +$('len').value * 1000;
    const b = buildCourse(D, cands, n, target, st);
    if (!b) return status('Could not build a course.');
    // verify each control's trail distance with turf
    const tl = D.trails.length ? turf.multiLineString(D.trails.map(t => t.ll)) : null;
    const controls = b.ord.map((c, i) => { const [lon, lat] = D.P.inv(c.xy[0], c.xy[1]); const pt = turf.point([lon, lat]);
      let dT = tl ? nearestTurf(pt, D) : null;
      return { n:i+1, lat, lon, dTrail: dT, kind:c.kind, wooded: D.wood.has(c.xy[0], c.xy[1]) }; });
    S.course = { diff:S.diff, start:S.start, controls, length:Math.round(b.len), target, score:$('scoreMode').checked, area:S.area, created:new Date().toISOString() };
    map.fitBounds(L.latLngBounds([[S.start[1], S.start[0]], ...controls.map(k => [k.lat, k.lon])]).pad(0.25));
    drawCourse(); saveCourse('orienteer.autosave');
    const short = controls.length < n ? ` (only ${controls.length} fit with 50 m spacing)` : '';
    status(`${DIFF[S.diff].label}: ${controls.length} controls${short}, ${(b.len/1000).toFixed(2)} km straight-line loop (target ${(target/1000).toFixed(1)} km). Candidates: ${cands.length}.`);
  } catch (e) { console.error(e); status('Error: ' + e.message); }
}
// precise distance to nearest trail using turf.pointToLineDistance over trails near the point
function nearestTurf(pt, D) {
  const [x, y] = D.P.f(...pt.geometry.coordinates); let best = Infinity;
  const approx = D.trailGrid.nearest(x, y, 3000);
  for (const t of D.trails) {
    // cheap prefilter using projected bbox
    let mn = Infinity; for (const q of t.xy) { const dd = dist(q, [x,y]); if (dd < mn) mn = dd; }
    if (mn > approx + 500) continue;
    const d = turf.pointToLineDistance(pt, turf.lineString(t.ll), { units:'meters' }); if (d < best) best = d;
  }
  return Math.round(best * 10) / 10;
}

/* ---------- rendering (orienteering style) ---------- */
function triIcon(sz=28) { return L.divIcon({ className:'', iconSize:[sz,sz], iconAnchor:[sz/2,sz*0.62], html:`<svg width="${sz}" height="${sz}" viewBox="0 0 28 28"><path d="M14 2 L26 24 L2 24 Z" fill="none" stroke="${MAGENTA}" stroke-width="3"/></svg>` }); }
function finishIcon() { return L.divIcon({ className:'', iconSize:[40,40], iconAnchor:[20,20], html:`<svg width="40" height="40"><circle cx="20" cy="20" r="17" fill="none" stroke="${MAGENTA}" stroke-width="3"/><circle cx="20" cy="20" r="11" fill="none" stroke="${MAGENTA}" stroke-width="3"/></svg>` }); }
const CR = 15; // control circle radius px
function drawCourse() {
  courseLayer.clearLayers(); const c = S.course; if (!c) return;
  const pts = [[c.start[1], c.start[0]], ...c.controls.map(k => [k.lat, k.lon]), [c.start[1], c.start[0]]];
  if (!c.score) for (let i = 0; i < pts.length - 1; i++) {
    const a = map.latLngToLayerPoint(pts[i]), b = map.latLngToLayerPoint(pts[i+1]); const d = a.distanceTo(b);
    const ta = i === 0 ? 16 : CR + 2, tb = i === pts.length - 2 ? 19 : CR + 2;
    if (d <= ta + tb) continue;
    const u = b.subtract(a).divideBy(d);
    L.polyline([map.layerPointToLatLng(a.add(u.multiplyBy(ta))), map.layerPointToLatLng(b.subtract(u.multiplyBy(tb)))], { color:MAGENTA, weight:3, interactive:false }).addTo(courseLayer);
  }
  L.marker(pts[0], { icon:triIcon(), interactive:false }).addTo(courseLayer);
  L.marker(pts[0], { icon:finishIcon(), interactive:false }).addTo(courseLayer);
  const punched = S.run ? S.run.punched : {};
  c.controls.forEach(k => {
    L.circleMarker([k.lat, k.lon], { radius:CR, color: punched[k.n] ? '#999' : MAGENTA, weight:3, fill:true, fillOpacity:0.01 })
      .bindPopup(`<b>Control ${k.n}</b><br>${k.kind}<br>${k.dTrail != null ? k.dTrail + ' m from nearest trail' : ''}<br>${k.wooded ? 'wooded' : 'open'}`).addTo(courseLayer);
    L.marker([k.lat, k.lon], { interactive:false, icon:L.divIcon({ className:'', iconSize:[30,20], iconAnchor:[-12,22], html:`<span class="ctl-label ${punched[k.n]?'done':''}">${k.n}</span>` }) }).addTo(courseLayer);
  });
  $('legend').innerHTML = `${DIFF[c.diff].label} · ${c.controls.length} controls · ${(c.length/1000).toFixed(2)} km · ${c.score ? 'score (any order)' : 'in order'}<br>Trail dist (m): ${c.controls.map(k => k.n + ':' + Math.round(k.dTrail)).join(' ')}`;
}
map.on('zoomend', () => S.course && drawCourse());

/* ---------- UI wiring ---------- */
document.querySelectorAll('#diff button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#diff button').forEach(x => x.classList.remove('on')); b.classList.add('on'); S.diff = b.dataset.d;
  $('hidePos').checked = S.diff !== 'easy';
});
$('n').oninput = () => $('nOut').textContent = $('n').value;
$('len').oninput = () => $('lenOut').textContent = (+$('len').value).toFixed(1);
$('gen').onclick = generate; $('regen').onclick = generate;
$('roads').onchange = () => { S.data = null; };
$('scoreMode').onchange = () => { if (S.course) { S.course.score = $('scoreMode').checked; drawCourse(); } };
$('togglePanel').onclick = () => { const b = $('panelBody'); b.hidden = !b.hidden; $('togglePanel').textContent = b.hidden ? '▸' : '▾'; };
/* ---------- coordinates: decimal degrees / UTM (WGS84) ---------- */
function toUTM(lat, lon) {
  const a = 6378137, f = 1/298.257223563, k0 = 0.9996, e2 = f*(2-f), ep2 = e2/(1-e2), d = Math.PI/180;
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) { if (lon >= 0 && lon < 9) zone = 31; else if (lon >= 9 && lon < 21) zone = 33; else if (lon >= 21 && lon < 33) zone = 35; else if (lon >= 33 && lon < 42) zone = 37; }
  const phi = lat*d, lam0 = ((zone-1)*6 - 180 + 3)*d, s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = a/Math.sqrt(1 - e2*s*s), T = t*t, C = ep2*c*c, A = c*(lon*d - lam0);
  const M = a*((1 - e2/4 - 3*e2*e2/64 - 5*e2**3/256)*phi - (3*e2/8 + 3*e2*e2/32 + 45*e2**3/1024)*Math.sin(2*phi) + (15*e2*e2/256 + 45*e2**3/1024)*Math.sin(4*phi) - (35*e2**3/3072)*Math.sin(6*phi));
  const E = k0*N*(A + (1-T+C)*A**3/6 + (5 - 18*T + T*T + 72*C - 58*ep2)*A**5/120) + 500000;
  let Nn = k0*(M + N*t*(A*A/2 + (5 - T + 9*C + 4*C*C)*A**4/24 + (61 - 58*T + T*T + 600*C - 330*ep2)*A**6/720));
  if (lat < 0) Nn += 10000000;
  const band = 'CDEFGHJKLMNPQRSTUVWXX'[Math.max(0, Math.min(20, Math.floor((lat + 80) / 8)))];
  return { zone, band, E, N: Nn };
}
let coordFmt = localStorage.getItem('orienteer.coordFmt') === 'utm' ? 'utm' : 'dd';
const fmtUTM = (lat, lon) => { const u = toUTM(lat, lon); return `${u.zone}${u.band} ${Math.round(u.E)}E ${Math.round(u.N)}N`; };
const fmtCoord = (lat, lon) => coordFmt === 'utm' ? fmtUTM(lat, lon) : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
function updateCoords() { const r = S.run; if (!r || !S.course) return; const t = nextTarget();
  $('rNextC').textContent = r.finished ? '' : t ? `${t.finish ? 'Finish' : 'Next #' + t.n}: ${fmtCoord(t.lat, t.lon)}` : 'Next: any order (see Course list)';
  const p = r.pos;
  $('rMe').textContent = $('hidePos').checked ? 'Me: hidden' : p ? `Me: ${fmtCoord(p.coords.latitude, p.coords.longitude)} ±${Math.round(p.coords.accuracy)} m` : 'Me: waiting for GPS…'; }
$('rCoords').onclick = () => { coordFmt = coordFmt === 'utm' ? 'dd' : 'utm'; localStorage.setItem('orienteer.coordFmt', coordFmt); updateCoords(); };
$('courseList').onclick = () => { if (!S.course) return; const r = S.run || { punched:{} };
  modal(`<h3>Course list <small>(${coordFmt === 'utm' ? 'UTM' : 'lat, lon'})</small></h3><table class="clist"><tr><th>#</th><th>Coordinates</th><th>Status</th></tr>` +
    S.course.controls.map(k => `<tr class="${r.punched[k.n] ? 'done' : ''}"><td>${k.n}</td><td>${fmtCoord(k.lat, k.lon)}</td><td>${r.punched[k.n] ? '✅ punched' : '○ not yet'}</td></tr>`).join('') +
    `<tr><td>S/F</td><td>${fmtCoord(S.course.start[1], S.course.start[0])}</td><td></td></tr></table>`); };
const modal = (html) => { $('modalBody').innerHTML = html; $('modal').hidden = false; };
$('modalClose').onclick = () => $('modal').hidden = true;

/* ---------- save / restore / GPX / print ---------- */
function saveCourse(key='orienteer.saved') { if (S.course) localStorage.setItem(key, JSON.stringify(S.course)); }
function restore(c) {
  S.course = c; S.diff = c.diff; S.start = c.start; S.area = c.area; S.data = null;
  areaLayer.clearLayers(); if (c.area) L.geoJSON(c.area, { style:{ color:'#333', weight:2, dashArray:'6 4', fillOpacity:0.05 }, interactive:false }).addTo(areaLayer);
  document.querySelectorAll('#diff button').forEach(x => x.classList.toggle('on', x.dataset.d === c.diff));
  $('scoreMode').checked = !!c.score; $('hidePos').checked = c.diff !== 'easy';
  map.fitBounds(L.latLngBounds([[c.start[1], c.start[0]], ...c.controls.map(k => [k.lat, k.lon])]).pad(0.2));
  drawCourse();
}
$('save').onclick = () => { if (!S.course) return status('Nothing to save.'); saveCourse(); status('Course saved on this device.'); };
$('load').onclick = () => { const s = localStorage.getItem('orienteer.saved') || localStorage.getItem('orienteer.autosave'); if (!s) return status('No saved course.'); restore(JSON.parse(s)); status('Course restored.'); };
function gpx(c) {
  const esc = s => String(s).replace(/[<&>]/g, m => ({'<':'&lt;','&':'&amp;','>':'&gt;'}[m]));
  const w = (lat, lon, name, sym) => `  <wpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><name>${esc(name)}</name><sym>${sym}</sym></wpt>\n`;
  const pts = [['Start', c.start[1], c.start[0]], ...c.controls.map(k => ['Control ' + k.n, k.lat, k.lon]), ['Finish', c.start[1], c.start[0]]];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Orienteer prototype" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${DIFF[c.diff].label} course ${c.created.slice(0,10)}</name></metadata>\n`
    + w(c.start[1], c.start[0], 'Start', 'Triangle') + c.controls.map(k => w(k.lat, k.lon, 'Control ' + k.n, 'Circle')).join('')
    + `  <rte><name>Course</name>\n` + pts.map(p => `    <rtept lat="${p[1].toFixed(7)}" lon="${p[2].toFixed(7)}"><name>${p[0]}</name></rtept>\n`).join('') + `  </rte>\n</gpx>\n`;
}
$('gpx').onclick = () => { if (!S.course) return status('Generate a course first.');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([gpx(S.course)], { type:'application/gpx+xml' })); a.download = `orienteer-${S.course.diff}.gpx`; a.click(); };
$('print').onclick = () => { if (!S.course) return status('Generate a course first.'); const c = S.course;
  $('printSheet').innerHTML = `<h3>${DIFF[c.diff].label} course · ${c.controls.length} controls · ${(c.length/1000).toFixed(2)} km</h3><table><tr><th>#</th><th>Lat</th><th>Lon</th><th>UTM</th><th>Feature</th><th>Trail dist</th><th>Leg (m)</th></tr>` +
    c.controls.map((k, i) => { const p = i ? c.controls[i-1] : { lat:c.start[1], lon:c.start[0] }; return `<tr><td>${k.n}</td><td>${k.lat.toFixed(5)}</td><td>${k.lon.toFixed(5)}</td><td>${fmtUTM(k.lat, k.lon)}</td><td>${k.kind}</td><td>${Math.round(k.dTrail)} m</td><td>${Math.round(turf.distance([p.lon,p.lat],[k.lon,k.lat],{units:'meters'}))}</td></tr>`; }).join('') + '</table>';
  document.body.classList.add('printing'); map.invalidateSize();
  setTimeout(() => { window.print(); document.body.classList.remove('printing'); map.invalidateSize(); }, 400); };

/* offline tile prefetch for the course area (cached by the service worker) */
$('cacheTiles').onclick = async () => {
  const f = S.area || (S.course && S.course.area); if (!f) return status('Select an area first.');
  const b = turf.bbox(f); const lon2x = (lon,z) => Math.floor((lon+180)/360*2**z), lat2y = (lat,z) => Math.floor((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*2**z);
  const active = map.hasLayer(sat) ? sat : map.hasLayer(topo) ? topo : osm; const urls = [];
  for (let z = 13; z <= 17; z++) for (let x = lon2x(b[0],z); x <= lon2x(b[2],z); x++) for (let y = lat2y(b[3],z); y <= lat2y(b[1],z); y++) urls.push(active.getTileUrl({ x, y, z }));
  if (urls.length > 800) return status(`Area needs ${urls.length} tiles – too many to prefetch politely (max 800). Draw a smaller area.`);
  let done = 0; for (const u of urls) { try { await fetch(u, { mode:'no-cors' }); } catch {} if (++done % 20 === 0) status(`Caching tiles ${done}/${urls.length}…`); }
  status(`Cached ${urls.length} tiles for offline use (current layer).`);
};

/* ---------- run mode ---------- */
let audioCtx;
function beep(freq=880, ms=250) { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination); g.gain.value = 0.3; o.start(); o.stop(audioCtx.currentTime + ms/1000); } catch {} }
const fmt = (ms) => { const s = Math.max(0, Math.round(ms/1000)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; };
const HINT_PENALTY = 60;
function radiusFor(k) { const v = +$('rad').value; return v >= 5 ? v : (k && k.wooded ? 15 : 10); }
$('rad').oninput = () => $('radOut').textContent = (+$('rad').value >= 5 ? $('rad').value + ' m' : 'auto');
$('run').onclick = () => {
  if (!S.course) return status('Generate or load a course first.');
  S.run = { started:null, punched:{}, splits:[], hints:[], pos:null, next:1, finished:false, watch:null };
  $('panel').hidden = true; $('runbar').hidden = false; $('rStart').hidden = false; $('penOut').textContent = HINT_PENALTY;
  drawCourse(); updateRunUI();
  if (!navigator.geolocation) { $('rMsg').textContent = 'No geolocation on this device.'; return; }
  startWatch();
};
function startWatch() {
  const r = S.run; if (!r || r.finished) return; if (r.watch != null) navigator.geolocation.clearWatch(r.watch);
  r.watch = navigator.geolocation.watchPosition(onPos, e => {
    console.warn('geo error', e.code, e.message);
    $('rAcc').textContent = e.code === 1 ? 'GPS permission denied' : 'GPS searching…'; $('rAcc').style.color = 'red';
    if (e.code === 3) setTimeout(startWatch, 2000); // restart watch after timeout/unavailable
  }, { enableHighAccuracy:true, maximumAge:1000, timeout:60000 });
}
$('rStart').onclick = () => { S.run.started = Date.now(); $('rStart').hidden = true; beep(660, 150); $('rMsg').textContent = 'Clock running – go!'; if (S.run.pos) onPos(S.run.pos); };
let clockT = setInterval(() => { if (S.run && S.run.started && !S.run.finished) $('rClock').textContent = fmt(Date.now() - S.run.started); }, 500);
function nextTarget() { const c = S.course, r = S.run; const left = c.controls.filter(k => !r.punched[k.n]); if (!left.length) return { finish:true, lat:c.start[1], lon:c.start[0] }; return c.score ? null : left[0]; }
function updateRunUI() { const r = S.run, c = S.course; const nP = Object.keys(r.punched).length;
  const t = nextTarget(); $('rNext').textContent = r.finished ? 'Finished' : t && t.finish ? '→ Finish' : c.score ? `${nP}/${c.controls.length} punched (any order)` : `→ Control ${t.n} (${nP}/${c.controls.length})`; updateCoords(); }
function onPos(p) {
  const r = S.run; if (!r || r.finished) return; r.pos = p;
  const { latitude:lat, longitude:lon, accuracy:acc } = p.coords;
  $('rAcc').textContent = `GPS ±${Math.round(acc)} m`; $('rAcc').style.color = acc <= 10 ? 'green' : acc <= 25 ? '#a60' : 'red';
  meLayer.clearLayers(); updateCoords();
  if (!$('hidePos').checked) { L.circle([lat, lon], { radius:acc, color:'#2a7fff', weight:1, fillOpacity:0.1, interactive:false }).addTo(meLayer); L.circleMarker([lat, lon], { radius:7, color:'#fff', weight:2, fillColor:'#2a7fff', fillOpacity:1, interactive:false }).addTo(meLayer); }
  if (!r.started) return;
  const here = [lon, lat], dm = k => turf.distance(here, [k.lon, k.lat], { units:'meters' });
  const c = S.course; const cand = c.score ? c.controls.filter(k => !r.punched[k.n]) : (nextTarget() && !nextTarget().finish ? [nextTarget()] : []);
  for (const k of cand) if (dm(k) <= radiusFor(k)) punch(k);
  const t = nextTarget();
  if (t && t.finish && turf.distance(here, c.start, { units:'meters' }) <= radiusFor(null) + 5) finish();
}
function punch(k) { const r = S.run; const now = Date.now(); const prev = r.splits.length ? r.splits[r.splits.length-1].t : r.started;
  r.punched[k.n] = now; r.splits.push({ n:k.n, t:now, split:now - prev, total:now - r.started });
  if (navigator.vibrate) navigator.vibrate([200, 80, 200]); beep(988, 200); setTimeout(() => beep(1319, 200), 220);
  $('rMsg').innerHTML = `✅ Control ${k.n} punched · split ${fmt(now - prev)} · total ${fmt(now - r.started)}`; drawCourse(); updateRunUI(); }
function finish(quit=false) { const r = S.run; if (!r) return; r.finished = true; if (r.watch != null) navigator.geolocation.clearWatch(r.watch);
  const end = Date.now(); const raw = r.started ? end - r.started : 0; const pen = r.hints.length * HINT_PENALTY * 1000;
  if (!quit) { if (navigator.vibrate) navigator.vibrate([400]); beep(523, 400); }
  const res = { date:new Date().toISOString(), diff:S.course.diff, raw, penalty:pen, total:raw + pen, splits:r.splits, hints:r.hints.length, completed:!quit, missing:S.course.controls.filter(k => !r.punched[k.n]).map(k => k.n) };
  r.result = res; const hist = JSON.parse(localStorage.getItem('orienteer.results') || '[]'); hist.push(res); localStorage.setItem('orienteer.results', JSON.stringify(hist.slice(-50)));
  modal(`<h3>${quit ? 'Run ended' : '🏁 Finished!'}</h3><p>Time <b>${fmt(raw)}</b> + hint penalty ${fmt(pen)} = <b>${fmt(raw + pen)}</b><br>Hints used: ${r.hints.length}${res.missing.length ? '<br>Missing controls: ' + res.missing.join(', ') : ''}</p>
    <table><tr><th>Control</th><th>Split</th><th>Total</th></tr>${r.splits.map(s => `<tr><td>${s.n}</td><td>${fmt(s.split)}</td><td>${fmt(s.total)}</td></tr>`).join('')}${!quit ? `<tr><td>Finish</td><td>${fmt(end - (r.splits.length ? r.splits[r.splits.length-1].t : r.started))}</td><td>${fmt(raw)}</td></tr>` : ''}</table>`);
  $('rClock').textContent = fmt(raw); updateRunUI(); }
$('rStop').onclick = () => { if (S.run && !S.run.finished) finish(true); $('runbar').hidden = true; $('panel').hidden = false; meLayer.clearLayers(); };
$('hidePos').onchange = () => { if (S.run && S.run.pos) onPos(S.run.pos); updateCoords(); };
$('hint').onclick = () => { const r = S.run; if (!r || !r.pos) return $('rMsg').textContent = 'Waiting for GPS…';
  let t = nextTarget(); const here = [r.pos.coords.longitude, r.pos.coords.latitude];
  if (!t) t = S.course.controls.filter(k => !r.punched[k.n]).sort((a,b) => turf.distance(here,[a.lon,a.lat]) - turf.distance(here,[b.lon,b.lat]))[0];
  const d = turf.distance(here, [t.lon, t.lat], { units:'meters' }), b = (turf.bearing(here, [t.lon, t.lat]) + 360) % 360;
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  r.hints.push({ t:Date.now(), target:t.finish ? 'F' : t.n });
  $('rMsg').innerHTML = `🧭 ${t.finish ? 'Finish' : 'Control ' + t.n}: <b>${Math.round(b)}° ${dirs[Math.round(b/45)%8]}</b>, <b>${Math.round(d)} m</b> (hint #${r.hints.length}, +${HINT_PENALTY}s)`; };

/* ---------- boot ---------- */
(function boot() {
  const s = localStorage.getItem('orienteer.autosave');
  if (s) { try { restore(JSON.parse(s)); status('Restored your last course. Generate a new one any time.'); } catch {} }
  else status('Search for a park, or zoom in and draw an area.');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
})();
window.App = { toUTM, startDraw, useView, endDraw, S, generate, setArea, setStart, fetchData, candidates, gpx, onPos, finish, DIFF, map, nearestTurf };
