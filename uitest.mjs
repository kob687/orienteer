import { chromium, devices } from 'playwright';
const LAT=40.75, LON=-74.73;
function overpassMock(){ // synthetic trail grid + some water/buildings
  const els=[]; let id=1, nid=1;
  for(let i=-6;i<=6;i++){ const g=[],n=[]; for(let j=-6;j<=6;j++){ g.push({lat:LAT+i*0.0015+Math.sin(j)*0.0002,lon:LON+j*0.002}); n.push(1000+(i+6)*13+(j+6)); } els.push({type:'way',id:id++,nodes:n,geometry:g,tags:{highway:'path'}}); }
  for(let j=-6;j<=6;j+=3){ const g=[],n=[]; for(let i=-6;i<=6;i++){ g.push({lat:LAT+i*0.0015+Math.sin(j)*0.0002,lon:LON+j*0.002}); n.push(1000+(i+6)*13+(j+6)); } els.push({type:'way',id:id++,nodes:n,geometry:g,tags:{highway:'track'}}); }
  return JSON.stringify({elements:els}); }
const errors=[];
for (const [name, dev] of (process.env.ONE?[["iphone13",devices["iPhone 13"]]]:[["iphone13", devices["iPhone 13"]], ["pixel7", devices["Pixel 7"]]])) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...dev, geolocation:{latitude:LAT,longitude:LON}, permissions:['geolocation'] });
  await ctx.route(/overpass/, r => r.fulfill({ contentType:'application/json', body:overpassMock() }));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(name+': '+e.message));
  await page.goto('http://127.0.0.1:8787/'); await page.evaluate(()=>localStorage.clear()); await page.reload();
  await page.evaluate(([a,o]) => App.map.setView([a,o], 15, {animate:false}), [LAT,LON]); await page.waitForTimeout(1500);
  const vp = page.viewportSize(); const cx=vp.width/2, cy=vp.height/2;
  const snap = () => page.$eval('#sheet', e => e.dataset.snap);
  console.log(name, 'initial snap', await snap());
  if (name==='iphone13') await page.screenshot({ path:'shots/7-build.png' });
  // sheet: tap handle -> half, drag up -> full, drag down -> peek
  await page.tap('#handle'); await page.waitForTimeout(350); const s1=await snap();
  const hb = await page.$eval('#handle', e => { const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]; });
  const cdp = await ctx.newCDPSession(page);
  const touchDrag = async (x0,y0,x1,y1,steps=8) => {
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x0,y:y0}]});
    for(let i=1;i<=steps;i++){ await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x0+(x1-x0)*i/steps,y:y0+(y1-y0)*i/steps}]}); await page.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await page.waitForTimeout(700); };
  await touchDrag(hb[0],hb[1],hb[0],80,12); const s2=await snap();
  const hb2 = await page.$eval('#handle', e => { const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]; });
  await touchDrag(hb2[0],hb2[1],hb2[0],vp.height-20,12); const s3=await snap();
  console.log(name,'sheet snaps tap/up/down:', s1, s2, s3);
  // draw via toolbar
  await page.waitForTimeout(500); await page.tap('#tDraw'); await page.waitForTimeout(300); if (await page.$eval('#drawBar', e=>e.hidden)) { await page.waitForTimeout(800); await page.tap('#tDraw'); await page.waitForTimeout(300); } console.log('drawbar hidden', await page.evaluate(()=>[document.getElementById('drawBar').hidden, document.getElementById('sheet').dataset.snap, document.getElementById('tDraw').className]));
  const c0 = await page.evaluate(()=>App.map.getCenter());
  const moves=[[0,0],[-280,0],[0,-280],[280,0]];
  for (const [dx,dy] of moves) { if(dx||dy) await touchDrag(cx,cy,cx+dx,cy+dy,10); await page.tap('#dAdd'); await page.waitForTimeout(150); }
  const nPts = await page.evaluate(()=>document.getElementById('drawBanner').textContent);
  // accidental pan: short drag of 40px on map shouldn't add
  await touchDrag(cx-60,cy+40,cx-20,cy+40,6);
  const afterPan = await page.evaluate(()=>document.getElementById('drawBanner').textContent);
  // a real tap should add
  await page.touchscreen.tap(cx+40, cy-60); await page.waitForTimeout(300);
  const afterTap = await page.evaluate(()=>document.getElementById('drawBanner').textContent);
  await page.tap('#dUndo'); await page.waitForTimeout(200);
  console.log(name, '|', nPts, '| after pan:', afterPan, '| after tap:', afterTap);
  if (name==='iphone13') await page.screenshot({ path:'shots/7-draw.png' });
  await page.tap('#dDone'); await page.waitForTimeout(400);
  console.log(name, 'area', await page.evaluate(()=>App.S.area && App.S.area.geometry.coordinates[0].length), 'snap', await snap());
  const R = {easy:[0,10],medium:[15,50],hard:[50,150],expert:[150,1e9]};
  await page.evaluate(()=>App.setSnap('full')); await page.waitForTimeout(400);
  // chip sequence test (no generation): state + aria-pressed must follow every tap
  for (const d of ['medium','expert','easy','hard','hard','medium','easy']) {
    await page.tap(`#diff button[data-d=${d}]`); await page.waitForTimeout(120);
    const st = await page.evaluate(() => ({ s:App.S.diff, p:[...document.querySelectorAll('#diff button[aria-pressed=true]')].map(b=>b.dataset.d), ls:localStorage.getItem('orienteer.diff') }));
    if (st.s!==d || st.p.join()!==d || st.ls!==d) errors.push(`${name} chip ${d} mismatch ${JSON.stringify(st)}`);
  }
  console.log(name, 'chip sequence ok');
  for (const d of ['easy','medium','hard','expert']) {
    await page.evaluate(()=>App.setSnap('full')); await page.waitForTimeout(400);
    await page.tap(`#diff button[data-d=${d}]`); await page.waitForTimeout(700);
    const stale = await page.evaluate(()=>document.getElementById('summary').textContent);
    await page.tap('#gen');
    await page.waitForFunction(dd => App.S.course && App.S.course.diff===dd, d, {timeout:30000}).catch(()=>{});
    const c = await page.evaluate(()=>App.S.course && {diff:App.S.course.diff,n:App.S.course.controls.length,len:App.S.course.length,dt:App.S.course.controls.map(k=>k.dTrail)});
    const bad = c ? c.dt.filter(x => d==='expert' ? x < 50 : (x < R[d][0]-1 || x > R[d][1]+1)) : ['none'];
    if (!c || c.diff!==d || bad.length) errors.push(`${name} ${d} distances off ${JSON.stringify(c)}`);
    console.log(name, d, await page.textContent('#status'), 'n', c&&c.n, 'len', c&&c.len, 'dTrail', c&&c.dt.map(Math.round).join(','), '| before-gen summary:', stale, '| snap', await snap(), '| peek:', await page.textContent('#summary'));
  }
  // persistence across reload
  const pd = await page.evaluate(()=>App.S.diff); await page.reload(); await page.waitForTimeout(800);
  console.log(name, 'persisted diff', pd, '->', await page.evaluate(()=>[App.S.diff, document.querySelector('#diff button[aria-pressed=true]').dataset.d]));
  await page.waitForTimeout(800);
  if (name==='iphone13') await page.screenshot({ path:'shots/7-course.png' });
  // run with mocked GPS
  const course = await page.evaluate(()=>App.S.course);
  await ctx.setGeolocation({latitude:course.start[1],longitude:course.start[0]});
  await page.tap('#peekAction'); await page.waitForTimeout(800); await page.tap('#rStart');
  const k = course.controls[0];
  await ctx.setGeolocation({latitude:k.lat+0.00003,longitude:k.lon}); await page.waitForTimeout(1500);
  console.log(name, 'punched #1:', await page.evaluate(()=>!!App.S.run.punched[1]), '|', await page.textContent('#rMsg'), '|', await page.textContent('#rCoords'));
  await page.tap('#rToggle'); await page.waitForTimeout(200);
  console.log(name, 'runbar collapsed height', await page.$eval('#runbar', e=>e.offsetHeight));
  if (name==='iphone13') await page.screenshot({ path:'shots/7-run.png' });
  // tap-target check
  const small = await page.evaluate(()=>[...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>{const r=b.getBoundingClientRect();return [b.id||b.textContent,r.width|0,r.height|0]}).filter(x=>x[1]<44||x[2]<44));
  console.log(name,'small visible buttons', JSON.stringify(small));
  await b.close();
}
console.log('page errors:', errors.length ? errors : 'none'); process.exit(0);
