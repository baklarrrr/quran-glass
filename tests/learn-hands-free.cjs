// Learn, hands-free, at the lens size, with the real text, timing and recitation services.
// Run with the same Playwright and CHROME_PATH as tests/voice-navigation.cjs.
// QURAN_REVIEW_DIR, when set, receives one picture of each step.
const assert = require('node:assert/strict');
const {readFile, mkdir} = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const types = {'.js':'text/javascript', '.html':'text/html', '.svg':'image/svg+xml', '.json':'application/json', '.css':'text/css'};
const output = process.env.QURAN_REVIEW_DIR;
const stray = /[ًٌ]ۭ|ٍۢ|[ًٌ]ۢ|ٍۭ/;

async function run() {
  const server = http.createServer(async (req, res) => {
    const target = new URL(req.url, 'http://localhost').pathname;
    try {
      const file = path.join(root, target === '/' ? 'index.html' : target);
      res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'text/plain'}).end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : 'chrome',
    args: ['--disable-gpu', '--mute-audio'],
  });
  try {
    if (output) await mkdir(output, {recursive: true});
    const context = await browser.newContext({viewport: {width: 600, height: 600}, deviceScaleFactor: 2, serviceWorkers: 'block'});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(() => localStorage.setItem('qg.pos', JSON.stringify({ch: 112, v: 1, w: 0})));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('resumeName').textContent.length > 0, null, {timeout: 20000});

    await page.focus('#homeLearn');
    await page.keyboard.press('Enter');

    const seen = [];
    let filled = 0;
    const started = Date.now();
    while (Date.now() - started < 70000) {
      const s = await page.evaluate(() => {
        const now = document.querySelector('.ayah .w.now');
        return {
          cue: document.getElementById('cue').hidden ? '' : document.getElementById('cueText').textContent,
          where: document.getElementById('where').textContent,
          fill: now ? Number(now.style.getPropertyValue('--f') || 0) : 0,
          veiled: document.querySelectorAll('.ayah .w.veiled').length,
          controls: getComputedStyle(document.querySelector('.controls')).opacity,
          text: document.getElementById('ayah').textContent,
        };
      });
      assert.ok(!stray.test(s.text), 'no stored tanween pair is drawn');
      if (s.cue === 'Listen') filled = Math.max(filled, s.fill);
      const last = seen[seen.length - 1];
      if (s.cue && (!last || last.cue !== s.cue || last.where !== s.where)) {
        seen.push(s);
        if (output && seen.length <= 3) {
          await page.waitForTimeout(1500);
          await page.screenshot({path: path.join(output, `learn-${seen.length}-${s.cue.replace(/ /g, '-').toLowerCase()}.png`)});
        }
      }
      if (seen.length >= 4) break;
      await page.waitForTimeout(80);
    }

    assert.deepEqual(seen.slice(0, 4).map(s => s.cue), ['Listen', 'Your turn', 'From memory', 'Listen'], 'the three steps run in order, then the next ayah');
    assert.match(seen[0].where, /1 of 4/);
    assert.match(seen[3].where, /2 of 4/, 'it moved to the next ayah with no press');
    assert.ok(seen[2].veiled > 0, 'the words are hidden for the turn from memory');
    assert.ok(filled > 0.2, 'the light moved through a word');

    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('cue').hidden && !document.getElementById('reader').classList.contains('stage'), null, {timeout: 3000});
    assert.equal(await page.evaluate(() => document.getElementById('audio').paused), true, 'a pinch stops the sound');
    assert.deepEqual(errors, []);
    console.log('learn-hands-free ok', JSON.stringify(seen.map(s => `${s.cue} @ ${s.where}`)));
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
