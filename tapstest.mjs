// iOS-tap regression: WebKit iPhone 13 (touch) + Chromium Pixel 7. Usage: BASE=http://127.0.0.1:8787/ node tapstest.mjs
import { webkit, chromium, devices } from 'playwright';
const BASE = process.env.BASE || 'http://127.0.0.1:8787/';
const LAT=40.75, LON=-74.73;
function overpassMock(){ const els=[]; let id=1;
  for(let i=-6;i<=6;i++){ const g=[],n=[]; for(let j=-6;j<=6;j++){ g.push({lat:LAT+i*0.0015+Math.sin(j)*0.0002,lon:LON+j*0.002}); n.push(1000+(i+6)*13+(j+6)); } els.push({type:'way',id:id++,nodes:n,geometry:g,tags:{highway:'path'}}); }
  for(let j=-6;j<=6;j+=3){ const g=[],n=[]; for(let i=-6;i<=6;i++){ g.push({lat:LAT+i*0.0015+Math.sin(j)*0.0002,lon:LON+j*0.002}); n.push(1000+(i+6)*13+(j+6)); } els.push({type:'way',id:id++,nodes:n,geometry:g,tags:{highway:'track'}}); }
  return JSON.stringify({elements:els}); }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=','base64');
let fails = 0; const ok = (name, cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}: ${msg}`); if (!cond) fails++; };
for (const [name, engine, dev] of [['iPhone13/WebKit', webkit, devices['iPhone 13']], ['Pixel7/Chromium', chromium, devices['Pixel 7']]]) {
  const b = await engine.launch();
  const ctx = await b.newContext({ ...dev, geolocation:{latitude:LAT,longitude:LON}, permissions:['geolocation'], serviceWorkers:'block' });
  await ctx.route(/overpass/, r => r.fulfill({ contentType:'application/json', body:overpassMock() }));
  await ctx.route(/tile|arcgisonline|nationalmap|terrarium|amazonaws/, r => r.fulfill({ contentType:'image/png', body:PNG }));
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept());
  const T = (k, ...a) => ok(`${name} ${k}`, ...a);
  await page.goto(BASE); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.evaluate(([a,o]) => App.map.setView([a,o], 15, {animate:false}), [LAT,LON]); await page.waitForTimeout(600);
  const snap = () => page.$eval('#sheet', e => e.dataset.snap);
  // is the element's centre actually hit-testable (not covered/clipped)?
  const hit = sel => page.evaluate(s => { const el = document.querySelector(s); const r = el.getBoundingClientRect(); if (!r.width) return false;
    const x = r.left + r.width/2, y = r.top + r.height/2; if (y < 0 || y > innerHeight) return false; const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); }, sel);
  // tap like a finger: scroll into view inside the sheet body (as a user would), require it to be hittable, then touch-tap
  const tap = async (sel, wait = 250) => { await page.$eval(sel, e => e.scrollIntoView({ block:'center' })); await page.waitForTimeout(80);
    if (!(await hit(sel))) { T(`tap ${sel}`, false, 'not hittable ' + await page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return JSON.stringify([r.top|0, r.height|0, innerHeight, scrollY, document.documentElement.scrollTop, h && (h.id || h.className || h.tagName)]); }, sel)); return; }
    const bb = await page.locator(sel).boundingBox(); await page.touchscreen.tap(bb.x + bb.width/2, bb.y + bb.height/2); await page.waitForTimeout(wait); };

  // handle tap toggles
  await tap('#handle', 400); T('handle tap', await snap() === 'half', await snap()); await tap('#handle', 400); T('handle tap back', await snap() === 'peek', await snap());
  // area: This view
  await tap('#handle', 400); await tap('#useView', 400);
  T('area set + New course visible', await page.evaluate(() => !!App.S.area) && await hit('#newCourse'), await page.textContent('#summary'));
  // Options
  T('options collapsed initially', await page.$eval('#optsBody', e => e.hidden), '');
  await tap('#optsToggle', 500);
  const o = await page.evaluate(() => ({ exp:document.getElementById('optsToggle').getAttribute('aria-expanded'), hidden:document.getElementById('optsBody').hidden, snap:document.getElementById('sheet').dataset.snap }));
  T('Options expands', o.exp === 'true' && !o.hidden && o.snap === 'full', JSON.stringify(o));
  if (engine === webkit) await page.screenshot({ path:'shots/8-options-open.png' });
  T('Options content on screen', await hit('#startGps') && await hit('#clearArea'), 'startGps/clearArea hittable without extra scrolling');
  // each options button
  await page.$eval('#circR', e => { e.value = 1000; e.dispatchEvent(new Event('input')); }); T('radius slider', (await page.textContent('#circROut')).includes('1'), await page.textContent('#circROut'));
  await tap('#startGps', 800); T('📍 My location', (await page.textContent('#startInfo')).includes('GPS'), await page.textContent('#startInfo'));
  await tap('#startTap', 400); T('⌖ Pick on map opens crosshair', !(await page.$eval('#drawBar', e => e.hidden)), '');
  await tap('#dAdd', 400); T('start set from map', (await page.textContent('#startInfo')).includes('map'), await page.textContent('#startInfo'));
  await tap('#roads', 150); T('roads checkbox', !(await page.$eval('#roads', e => e.checked)), 'unchecked'); await tap('#roads', 150);
  await tap('#scoreMode', 150); T('score checkbox', await page.$eval('#scoreMode', e => e.checked), 'checked'); await tap('#scoreMode', 150);
  await tap('#save', 200); T('💾 Save w/o course', (await page.textContent('#status')).includes('Nothing'), await page.textContent('#status'));
  await tap('#gen', 200); await page.waitForFunction(() => App.S.course, null, { timeout:30000 });
  T('generate -> peek', await snap() === 'peek', await page.textContent('#summary'));
  if (engine === webkit) await page.screenshot({ path:'shots/8-peek-newcourse.png' });
  T('New course visible in peek', await hit('#newCourse') && await hit('#peekAction') && await hit('#peekRegen'), 'newCourse/peekAction/peekRegen hittable');
  await tap('#peekRegen', 200); await page.waitForTimeout(1500); T('↻ peek regen', await page.evaluate(() => !!App.S.course), await page.textContent('#status'));
  await tap('#handle', 400); await tap('#optsToggle', 300); if (await page.$eval('#optsBody', e => e.hidden)) await tap('#optsToggle', 500);
  await tap('#save', 200); T('💾 Save', (await page.textContent('#status')).includes('saved'), await page.textContent('#status'));
  await tap('#load', 300); T('📂 Load', (await page.textContent('#status')).includes('restored'), await page.textContent('#status'));
  const dl = page.waitForEvent('download', { timeout:5000 }).then(d => d.suggestedFilename()).catch(() => null);
  await tap('#gpx', 300); const fn = await dl; T('GPX', !!fn && fn.endsWith('.gpx'), String(fn));
  await tap('#print', 400); T('🖨 Print dialog', !(await page.$eval('#modal', e => e.hidden)), '');
  await page.waitForFunction(() => !document.getElementById('pmGo').disabled, null, { timeout:30000 }).catch(() => {}); await page.waitForTimeout(300);
  await tap('#modalClose', 300); T('print dialog closes', await page.$eval('#modal', e => e.hidden), await page.textContent('#pmMsg'));
  await tap('#cacheTiles', 3000); T('⬇ Offline tiles', /Cached|Caching|too many/.test(await page.textContent('#status')), await page.textContent('#status'));
  await tap('#clearArea', 400);
  T('✕ Clear area', await page.evaluate(() => !App.S.area && !App.S.course && !localStorage.getItem('orienteer.autosave')), await page.textContent('#status'));
  // run bar audit
  await tap('#useView', 400); await page.evaluate(() => App.setSnap('full')); await page.waitForTimeout(300);
  await tap('#gen', 200); await page.waitForFunction(() => App.S.course, null, { timeout:30000 });
  await tap('#peekAction', 600); T('▶ Start run (peek)', !(await page.$eval('#runbar', e => e.hidden)), '');
  await tap('#rStart', 200); T('Start clock', await page.evaluate(() => !!App.S.run.started), '');
  await page.waitForTimeout(1200); await tap('#hint', 200); T('🧭 Hint', (await page.textContent('#rMsg')).includes('🧭') || (await page.textContent('#rMsg')).includes('GPS'), await page.textContent('#rMsg'));
  await tap('#courseList', 300); T('📋 List', !(await page.$eval('#modal', e => e.hidden)), ''); await tap('#modalClose', 200);
  const c1 = await page.textContent('#rCoords'); await tap('#rCoords', 200); T('coords toggle', c1 !== await page.textContent('#rCoords'), await page.textContent('#rCoords'));
  await tap('#rToggle', 200); T('▾ collapse', await page.$eval('#runbar', e => e.classList.contains('collapsed')), ''); await tap('#rToggle', 200);
  await tap('#rStop', 400); await tap('#modalClose', 200); T('■ Finish/Quit', await page.$eval('#runbar', e => e.hidden) && !(await page.$eval('#sheet', e => e.hidden)), await snap());
  // New course from peek after generation
  T('peek after run', await snap() === 'peek' && await hit('#newCourse'), '');
  await tap('#newCourse', 500);
  const r = await page.evaluate(() => ({ area:!!App.S.area, course:!!App.S.course, start:!!App.S.start, auto:localStorage.getItem('orienteer.autosave'), snap:document.getElementById('sheet').dataset.snap, sum:document.getElementById('summary').textContent, nc:document.getElementById('newCourse').hidden, layers:document.querySelectorAll('.leaflet-overlay-pane path, .leaflet-marker-icon').length, top:document.getElementById('sheetBody').scrollTop }));
  T('✕ New course clears', !r.area && !r.course && !r.start && !r.auto && r.snap === 'half' && r.nc && r.layers === 0 && r.top === 0, JSON.stringify(r));
  await page.reload(); await page.waitForTimeout(800);
  const r2 = await page.evaluate(() => ({ area:!!App.S.area, course:!!App.S.course, sum:document.getElementById('summary').textContent }));
  T('cleared after reload', !r2.area && !r2.course && r2.sum === 'Pick an area to start', JSON.stringify(r2));
  // drag still works (Chromium CDP touch; WebKit has no touch-move API in Playwright)
  if (engine === chromium) {
    const cdp = await ctx.newCDPSession(page);
    const drag = async (x, y0, y1) => { await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{ x, y:y0 }] });
      for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{ x, y:y0 + (y1-y0)*i/10 }] }); await page.waitForTimeout(16); }
      await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] }); await page.waitForTimeout(600); };
    const hb = await page.locator('#handle').boundingBox(); await drag(hb.x + hb.width/2, hb.y + 10, 60); T('drag up -> full', await snap() === 'full', await snap());
    const hb2 = await page.locator('#handle').boundingBox(); await drag(hb2.x + hb2.width/2, hb2.y + 10, page.viewportSize().height - 10); T('drag down -> peek', await snap() === 'peek', await snap());
    await page.evaluate(() => { window.L2 = []; ['pointerdown','pointerup','pointercancel','click'].forEach(t => document.addEventListener(t, e => L2.push(t + ':' + (e.target.id||e.target.tagName)), true)); });
    await page.waitForTimeout(1500); const pb = await page.locator('#peekAction').boundingBox(); await drag(pb.x + 20, pb.y + 20, pb.y + 23); T('3px jiggle on button is still a tap (draw opens)', !(await page.$eval('#drawBar', e => e.hidden)), JSON.stringify([pb, await page.evaluate(() => L2)]));
  }
  T('no page errors', !errs.length, errs.join(' | ') || 'none');
  await page.screenshot({ path:`shots/8-${name.replace('/','-')}.png` });
  await b.close();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
