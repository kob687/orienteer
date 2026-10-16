import { chromium } from 'playwright'; import fs from 'fs';
const nom = await (await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.00005&limit=3&q=Hacklebarney+State+Park', {headers:{'User-Agent':'orienteer-test/1 (kob687)'}})).json();
const it = nom.find(x => /Polygon/.test(x.geojson.type)); console.log('area', it.display_name);
const b = await chromium.launch(); const page = await (await b.newContext({ viewport:{width:1200,height:900} })).newPage();
const errs=[]; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => /status|fail|error/i.test(m.text()) && console.log(' >', m.text().slice(0,160)));
await page.goto('http://127.0.0.1:8787/'); await page.evaluate(()=>localStorage.clear()); await page.reload(); await page.waitForTimeout(800);
await page.evaluate(g => { App.setArea(turf.feature(g, {name:'Hacklebarney State Park'})); App.setDiff('medium'); }, it.geojson);
await page.evaluate(() => App.generate()); 
const ok = await page.evaluate(() => !!App.S.course); console.log('course', ok);
const r = await page.evaluate(async () => { const t = Date.now(); const r = await PrintMap.render({ scale:10000 }); return { url:r.canvas.toDataURL('image/png'), paper:r.paper, o:r.orientation, fits:r.fits, dec:r.declination, ms:Date.now()-t, w:r.canvas.width, h:r.canvas.height }; });
fs.writeFileSync('shots/8-print-map.png', Buffer.from(r.url.split(',')[1], 'base64'));
console.log(r.paper, r.o, r.w+'x'+r.h, 'fits', r.fits, 'dec', JSON.stringify(r.dec), r.ms+'ms');
process.env.QUICK && (await b.close(), process.exit(0));
// dialog path
await page.click('#sheet #handle'); await page.evaluate(()=>App.setSnap('full')); await page.click('summary'); await page.click('#print');
await page.waitForFunction(() => !document.getElementById('pmImg').hidden, null, {timeout:120000}); console.log('dialog:', await page.textContent('#pmMsg'));
console.log('errors', errs.length ? errs : 'none'); await b.close();
