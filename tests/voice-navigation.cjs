// Run with Playwright installed locally: node tests/voice-navigation.cjs
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const chapters = Array.from({length: 114}, (_, index) => ({
  id: index + 1, name_simple: 'Test ' + (index + 1), name_arabic: '', verses_count: 2,
}));

async function run() {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    try {
      const data = await readFile(path.join(root, pathname === '/' ? 'index.html' : pathname));
      res.writeHead(200, {'Content-Type': types[path.extname(pathname)] || 'text/html'});
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({executablePath: process.env.CHROME_PATH, args: ['--disable-background-networking']});
    for (const registration of ['absent', 'throws', 'rejects', 'works']) {
      const context = await browser.newContext({viewport: {width: 600, height: 600}, serviceWorkers: 'block'});
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base) return route.continue();
        if (url.pathname.endsWith('/chapters')) return route.fulfill({json: {chapters}});
        if (url.pathname.includes('/verses/by_chapter/')) {
          const ch = url.pathname.split('/').pop();
          return route.fulfill({json: {verses: [1, 2].map(v => ({
            verse_number: v, verse_key: ch + ':' + v, words: [{char_type_name: 'word', position: 1, text_uthmani: 'Fixture'}],
          }))}});
        }
        return route.abort();
      });
      await page.addInitScript(mode => {
        localStorage.setItem('qg.pos', JSON.stringify({ch: 112, v: 2, w: 0}));
        localStorage.setItem('qg.settings', JSON.stringify({mode:'recite'}));
        window.audioStarts = 0;
        HTMLMediaElement.prototype.play = () => { window.audioStarts++; return Promise.resolve(); };
        if (mode === 'absent') return;
        Object.defineProperty(document, 'modelContext', {value: {registerTool(tool) {
          if (mode === 'throws') throw Error('unavailable');
          if (mode === 'rejects') return Promise.reject(Error('unavailable'));
          window.voiceTool = tool;
        }}});
      }, registration);
      await page.goto(base);
      await page.locator('#pick-112').waitFor();
      if (registration === 'works') {
        const call = arg => page.evaluate(async arg => JSON.parse(await window.voiceTool.execute(arg)), arg);
        assert.equal(await page.evaluate(() => window.voiceTool.name), 'quran_open_surah');
        for (const number of [0, 115, 1.5, null, 'oops', false]) {
          assert.equal((await call({number})).error, true);
        }
        await page.evaluate(() => { playing = true; });
        assert.equal((await call({number: 112})).error, true);
        await page.evaluate(() => { playing = false; voice.on = true; });
        assert.equal((await call({number: 112})).error, true);
        await page.evaluate(() => { voice.on = false; });
        await page.click('#homeOptions');
        assert.equal((await call({number: 36})).error, true);
        await page.goBack();
        await page.click('#allSurahs');
        const depth = await page.evaluate(() => history.length);
        const result = await call({number: '112'});
        assert.deepEqual(Object.keys(result).sort(), ['next_action', 'reader_open']);
        assert.equal(result.reader_open, 112);
        await page.waitForFunction(() => document.querySelector('#ayah').textContent.includes('Fixture'));
        assert.equal(await page.evaluate(() => history.state.v), 2);
        assert.equal((await call({number:112})).reader_open, 112);
        assert.equal((await call({number:36})).reader_open, 36);
        assert.equal(await page.evaluate(() => history.length), depth + 1);
        await page.goBack();
        await page.locator('#list').waitFor();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'surah-112');
        await page.route('**/verses/by_chapter/17?*', route => route.fulfill({status: 502, body: 'Unavailable'}));
        const unavailable = await call({number:17});
        assert.equal(unavailable.reader_open, 17);
        await page.locator('#arabicSource').waitFor();
        assert.equal(await page.locator('#whoText').innerText(), '0 of ' + (await page.locator('#ayah [data-p]').count()) + ' words');
        await page.goBack();
        await page.evaluate(() => { chapters = null; });
        assert.equal((await call({number:36})).error, true);
      } else {
        await page.click('#pick-112');
        await page.waitForFunction(() => document.querySelector('#ayah').textContent.includes('Fixture'));
        await page.goBack();
        await page.locator('#home').waitFor();
      }
      assert.equal(await page.evaluate(() => window.audioStarts), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base + '/install.html');
    const keys = await page.evaluate(async () => {
      for (const name of ['quran-glass-v13', 'glass-home-v34', 'quran-glass-vendor']) await caches.open(name);
      await navigator.serviceWorker.register('/sw.js');
      const {active} = await navigator.serviceWorker.ready;
      if (active.state !== 'activated') {
        await new Promise(resolve => active.addEventListener('statechange', () => {
          if (active.state === 'activated') resolve();
        }));
      }
      return (await caches.keys()).sort();
    });
    assert.deepEqual(keys, ['glass-home-v34', 'quran-glass-v15', 'quran-glass-vendor']);
    console.log('Passed voice routing, input, saved place, back, silent mode, registration fallback and cache isolation.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => {console.error(error);process.exitCode = 1;});
