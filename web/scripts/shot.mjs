// Opens the viewer in the installed Edge (real GPU), waits for streaming, reports frame timing and saves a screenshot.
//   node scripts/shot.mjs "<url>" out.png [seconds] [width] [height]
import puppeteer from 'puppeteer-core';
const [url, out = 'shot.png', secs = '12', w = '1600', h = '900'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${w},${h}`],
  defaultViewport: { width: +w, height: +h },
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto(url, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, +secs * 1000));
const t = await page.evaluate(() => {
  const x = window.__timing; const s = document.getElementById('stats')?.textContent;
  return x ? { frames: x.frames, lod: +(x.lod / x.frames).toFixed(2), render: +(x.render / x.frames).toFixed(2), stats: s } : { stats: s };
});
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
await page.screenshot({ path: out });
console.log(JSON.stringify({ gpu, ...t }));
await browser.close();
