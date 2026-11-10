// Run with the same Playwright and CHROME_PATH as tests/voice-navigation.cjs.
const assert = require('node:assert/strict');
const {readFile, mkdir} = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const types = {'.js':'text/javascript', '.html':'text/html', '.svg':'image/svg+xml', '.json':'application/json', '.css':'text/css'};
const data = async ch => JSON.parse(await readFile(path.join(root, 'tanzil', ch + '.json')));
const output = process.env.QURAN_REVIEW_DIR;

async function run() {
  const server = http.createServer(async (req, res) => {
    const target = new URL(req.url, 'http://localhost').pathname;
    try {
      const file = path.join(root, target === '/' ? 'index.html' : target);
      const body = await readFile(file);
      res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'text/plain'}).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
    const context = await browser.newContext({viewport:{width:600,height:600},reducedMotion:'reduce',serviceWorkers:'block'});
    const page = await context.newPage();
    const errors = [], files = [], requests = [];
    let online = false;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === base) {
        if (url.pathname.startsWith('/tanzil/')) files.push(url.pathname);
        return route.continue();
      }
      if (url.hostname === 'api.quran.com') {
        requests.push(url.pathname);
        if (online && url.pathname.includes('/verses/by_chapter/112')) {
          return route.fulfill({json:{verses:[{verse_number:1,verse_key:'112:1',
            translations:[{text:'Test meaning from restored service'}],
            words:[{char_type_name:'word',position:1,text_uthmani:'TEST'}]}]}});
        }
        if (online && url.pathname.includes('/chapter_recitations/7/112')) {
          // Successful full-surah timing responses may take longer than the text fallback deadline.
          await new Promise(resolve => setTimeout(resolve, 4000));
          return route.fulfill({json:{audio_file:{audio_url:base+'/test-audio',timestamps:[]}}});
        }
        return route.fulfill({status:502,body:'Upstream unavailable'});
      }
      return route.abort();
    });
    await page.addInitScript(() => {
      Object.defineProperty(document,'modelContext',{value:{registerTool(t){window.voiceTool = t;}}});
    });
    await page.goto(base);
    await page.locator('#allSurahs').click();
    await page.locator('#surah-114').waitFor();
    assert.equal(await page.locator('#surahs button').count(),114);
    assert.equal(requests.filter(x=>x.endsWith('/chapters')).length,1);
    assert.deepEqual(files,['/tanzil/chapters.json']);
    const call = ch => page.evaluate(async number => JSON.parse(await window.voiceTool.execute({number})),ch);
    for (const ch of [1,2,9,112]) {
      assert.equal((await call(ch)).reader_open,ch);
      const source = await data(ch);
      await page.waitForFunction(text => document.querySelector('#ayah').textContent === text,source.ayahs[0]);
      assert.equal(await page.locator('#basmala').textContent(), source.basmala || '');
      assert.equal(await page.locator('#basmala').isVisible(),Boolean(source.basmala));
      assert.equal(await page.locator('#voice').isVisible(),false);
      assert.equal(await page.locator('#play').isVisible(),false);
      assert.equal(await page.locator('#meaning').isVisible(),false);
      assert.equal(await page.locator('#arabicSource').isVisible(),true);
      await page.locator('#textbox').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#ayah .said').count(),1);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('#ayah .said').count(),0);
    }
    assert.deepEqual(files,['/tanzil/chapters.json','/tanzil/1.json','/tanzil/2.json','/tanzil/9.json','/tanzil/112.json']);
    assert.equal(requests.some(x=>x.includes('/chapter_recitations/')),false);
    // A late chapter request cannot replace the one the wearer selected next.
    let releaseChapter, startedChapter;
    const started = new Promise(resolve=>{startedChapter=resolve;});
    const held = new Promise(resolve=>{releaseChapter=resolve;});
    await page.route(base+'/tanzil/19.json', async route=>{
      startedChapter();
      await held;
      await route.continue();
    });
    await call(19);
    await started;
    await call(112);
    releaseChapter();
    await page.waitForFunction(async()=>{await bundledRequests.get(19); return currentVerse()?.key==='112:1';});
    assert.equal(await page.locator('#ayah').textContent(),(await data(112)).ayahs[0]);
    if(output) {
      await mkdir(output,{recursive:true});
      await page.screenshot({path:path.join(output,'arabic-reader-112.png')});
    }
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'retryReader');
    await page.locator('#retryReader').click();
    await page.waitForFunction(()=>!document.querySelector('#retryReader').disabled);
    assert.equal(await page.locator('#arabicSource').isVisible(),true);
    online = true;
    await page.locator('#retryReader').click();
    await page.waitForFunction(()=>document.querySelector('#meaning').textContent === 'Test meaning from restored service');
    assert.equal(await page.locator('#play').isVisible(),true);
    assert.equal(await page.locator('#arabicSource').isVisible(),false);
    assert.equal(await page.locator('#basmala').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'play');
    await page.waitForFunction(()=>timing?.ch===112 && audioReady(), {timeout:6500});
    assert.equal(await page.evaluate(()=>playing),false);
    await page.goBack();
    await page.locator('#list').waitFor();
    // Previously loaded chapters remain usable with both upstream and local data endpoints down.
    online = false;
    await page.route(base+'/tanzil/**', r=>r.abort());
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('#pick-112').click();
    const chapter = await data(112);
    await page.waitForFunction(text => document.querySelector('#ayah').textContent === text, chapter.ayahs[0]);
    // Exercise the actual production token function on every original string.
    let total = 0;
    for (let ch = 1; ch <= 114; ch++) {
      const bundle = await data(ch);
      assert(await page.evaluate(ayahs=>ayahs.every(text=>tanzilWords(text).map(w=>w.ar).join(' ')===text),bundle.ayahs));
      total += bundle.ayahs.length;
    }
    assert.equal(total,6236);
    assert.deepEqual(errors,[]);
    console.log('Passed 114-surah catalog, on-demand Arabic, basmalas 1/2/9/112, offline cache, manual gestures, silent voice navigation, source attribution and recovery to online meaning/playback controls.');
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

run().catch(e=>{console.error(e);process.exitCode=1;});
