import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const LOC = { latitude:40.7790, longitude:-74.7380 }; // Hacklebarney SP area
let fail = 0;
for (const dn of ['iPhone 13', 'Pixel 7']) {
  const ctx = await browser.newContext({ ...devices[dn], geolocation:LOC, permissions:['geolocation'], serviceWorkers:'block' });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR', e.message); fail++; });
  await page.goto('http://127.0.0.1:8787/'); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.evaluate(ll => App.map.setView([ll.latitude, ll.longitude], 15), LOC); await page.waitForTimeout(500);
  const tapEl = async sel => { const b = await page.locator(sel).boundingBox(); await page.touchscreen.tap(b.x + b.width/2, b.y + b.height/2); await page.waitForTimeout(250); };
  const vp = page.viewportSize(); const cx = vp.width/2, cy = vp.height*0.45;
  const area = () => page.evaluate(() => App.S.area && { type:App.S.area.geometry.type, km2:+(turf.area(App.S.area)/1e6).toFixed(3), valid: turf.kinks(App.S.area.geometry.type==='Polygon'?App.S.area:turf.polygon(App.S.area.geometry.coordinates[0])).features.length===0 });
  const check = (name, a) => { const ok = a && a.type === 'Polygon' && a.km2 > 0 && a.valid; if (!ok) fail++; console.log(dn, name, ok ? 'OK' : 'FAIL', JSON.stringify(a)); };
  const reset = () => page.evaluate(() => { App.S.area = null; App.map.setView([40.7790,-74.7380], 15); });
  // polygon: 4 taps quickly (would double-tap-zoom before), Done
  await reset(); await page.waitForTimeout(300);
  await tapEl('#drawPoly');
  const z0 = await page.evaluate(() => App.map.getZoom());
  const panelHidden = await page.evaluate(() => document.getElementById('panelBody').hidden);
  const pts = [[-80,-60],[80,-70],[90,60],[-70,80]];
  for (const [dx,dy] of pts) { await page.touchscreen.tap(cx+dx, cy+dy); await page.waitForTimeout(120); }
  const st = await page.evaluate(() => ({ z:App.map.getZoom(), done:!document.getElementById('dDone').disabled, banner:document.getElementById('drawBanner').textContent }));
  console.log(dn, 'poly mode: panel collapsed', panelHidden, 'zoom unchanged', st.z === z0, 'Done enabled', st.done, '|', st.banner);
  if (!panelHidden || st.z !== z0 || !st.done) fail++;
  if (dn === 'iPhone 13') await page.screenshot({ path:'shots/5-draw-mode.png' });
  // undo then re-add, close by tapping first point
  await tapEl('#dUndo'); await page.touchscreen.tap(cx-70, cy+80); await page.waitForTimeout(120);
  await page.touchscreen.tap(cx-78, cy-58); await page.waitForTimeout(400);
  check('polygon (close by tapping first point)', await area());
  const panelBack = await page.evaluate(() => !document.getElementById('panelBody').hidden); console.log(dn, 'panel restored', panelBack);
  // polygon via Done
  await reset(); await tapEl('#drawPoly'); for (const [dx,dy] of pts) { await page.touchscreen.tap(cx+dx, cy+dy); await page.waitForTimeout(150); } await tapEl('#dDone');
  check('polygon (Done)', await area());
  // rectangle: two taps
  await reset(); await page.waitForTimeout(300); await tapEl('#drawRect'); await page.touchscreen.tap(cx-90, cy-80); await page.waitForTimeout(100); await page.touchscreen.tap(cx+90, cy+80); await page.waitForTimeout(400);
  check('rectangle (2 taps)', await area());
  // current view
  await reset(); await page.waitForTimeout(300); await tapEl('#useView'); check('current view', await area());
  // circle tapped point
  await reset(); await page.waitForTimeout(300); await tapEl('#drawCircle'); await page.touchscreen.tap(cx, cy);
  await page.locator('#circR').fill('800'); await page.waitForTimeout(150); await tapEl('#dDone'); check('circle tapped 800 m', await area());
  // circle around me
  await reset(); await page.waitForTimeout(300); await tapEl('#drawCircle'); await tapEl('#circMe'); await page.waitForTimeout(800);
  await page.locator('#circR').fill('3000'); await tapEl('#dDone'); check('circle around me 3 km', await area());
  // cancel works, dragging restored
  await tapEl('#drawPoly'); await tapEl('#dCancel'); console.log(dn, 'cancel -> dragging', await page.evaluate(() => App.map.dragging.enabled()));
  if (dn === 'iPhone 13') {
    // generate on a rectangle
    await reset(); await page.waitForTimeout(300); await tapEl('#drawRect'); await page.touchscreen.tap(cx-150, cy-150); await page.waitForTimeout(100); await page.touchscreen.tap(cx+150, cy+150); await page.waitForTimeout(400);
    console.log('gen area', JSON.stringify(await area()));
    await page.evaluate(() => App.generate());
    await page.waitForFunction(() => App.S.course || /Only|Could not|failed|rror/.test(document.getElementById('status').textContent), null, { timeout:240000 });
    const r = await page.evaluate(() => ({ n:App.S.course && App.S.course.controls.length, inArea: App.S.course && App.S.course.controls.every(k => turf.booleanPointInPolygon([k.lon,k.lat], App.S.area)), status:document.getElementById('status').textContent }));
    console.log('GENERATE', JSON.stringify(r)); if (!r.n || !r.inArea) fail++;
    // parks in view + search still work
    await page.evaluate(() => App.map.setView([40.7790,-74.7380], 14));
    await tapEl('#pickPark'); await page.waitForSelector('#parks div', { timeout:120000 }); console.log('parks in view:', (await page.$$eval('#parks div', d => d.map(x => x.textContent))).slice(0,3));
    await page.fill('#q', 'Hacklebarney State Park'); await tapEl('#searchBtn'); await page.waitForSelector('#results div', { timeout:30000 });
    console.log('search:', (await page.$$eval('#results div', d => d.map(x => x.textContent))).slice(0,2));
  }
  await ctx.close();
}
console.log('FAILURES', fail); process.exit(fail ? 1 : 0);
