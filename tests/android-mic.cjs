const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
async function run() {
  const server = http.createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname;
      const file = path.join(root, name === '/' ? 'index.html' : name);
      res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'text/plain'}).end(await fs.readFile(file));
    } catch { res.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const chapter = JSON.parse(await fs.readFile(path.join(root, 'tanzil/112.json')));
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'tanzil/chapters.json')));
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
    const context = await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width:600,height:600}});
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', e=>errors.push(e.message));
    await page.clock.install();
    await page.route('**/*', route=>{
      const u = new URL(route.request().url());
      if (u.origin === base) return route.continue();
      if (u.pathname.endsWith('/chapters')) return route.fulfill({json:{chapters:catalog.chapters.map(c=>({id:c.id,name_simple:c.en,name_arabic:c.ar,verses_count:c.n}))}});
      if (u.pathname.endsWith('/verses/by_chapter/112')) return route.fulfill({json:{verses:chapter.ayahs.map((text,i)=>({
        verse_number:i+1,verse_key:'112:'+(i+1),words:text.split(' ').map((ar,j)=>({char_type_name:'word',position:j+1,text_uthmani:ar}))
      }))}});
      return route.abort();
    });
    await page.addInitScript(()=>{
      const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
      localStorage.setItem('tg.pair', JSON.stringify({t:'test-android',k:key}));
      localStorage.setItem('qg.settings', JSON.stringify({mode:'recite',effects:'off'}));
      window.fakeHidden = false;
      Object.defineProperties(document, {
        hidden:{get:()=>window.fakeHidden},
        visibilityState:{get:()=>window.fakeHidden ? 'hidden':'visible'}
      });
      Object.defineProperty(navigator,'getBattery',{value:undefined});
      window.visibility = hidden => {window.fakeHidden=hidden;document.dispatchEvent(new Event('visibilitychange'));};
      window.clients = [];
      window.sent = [];
      window.autoConnect = true;
      window.mqtt = {connect(_url,options){
        const events = {};
        const client = {connected:false,options,on(name,f){events[name]=f;}, subscribe(){},end(){this.connected=false;},
          connect(){this.connected=true;events.connect?.();}, message(topic,bytes,packet){events.message?.(topic,bytes,packet);},
          publish(topic,body,options){window.sent.push({topic,body,options});}};
        window.clients.push(client);
        if (window.autoConnect) queueMicrotask(()=>client.connect());
        return client;
      }};
      window.commands = async () => {
        const aes = await crypto.subtle.importKey('raw',new Uint8Array(32).fill(42),'AES-GCM',false,['decrypt']);
        return Promise.all(window.sent.map(async item=>{
          const bytes=Uint8Array.from(atob(item.body.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
          const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},aes,bytes.slice(12));
          return {...JSON.parse(new TextDecoder().decode(plain)),topic:item.topic,qos:item.options.qos};
        }));
      };
    });

    await page.goto(base);
    await page.locator('#pick-112').click();
    await page.locator('#ayah [data-p]').first().waitFor();
    const mic = page.getByRole('button',{name:'Start Android mic'});
    const commands = () => page.evaluate(()=>window.commands());
    const receiveState = (age = 0, retain = false, wrong = false) => page.evaluate(async ({age,retain,wrong})=>{
      const payload = await sealForPhone({t:'state',at:Date.now()-age,gb:67});
      clients.at(-1).message('bkr/' + (wrong?'other':'test-android') + '/s',new TextEncoder().encode(payload),{retain});
    },{age,retain,wrong});
    const waitForHello = () => page.waitForFunction(()=>clients.some(c=>c.connected)&&sent.length>0);
    const start = async () => {
      await mic.click();
      await waitForHello();
      await receiveState();
      await page.waitForFunction(()=>voice.startSent);
    };
    assert.equal(await page.locator('dialog').count(),0);
    assert.equal(await mic.isVisible(),true);
    await page.focus('#textbox');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>reciteAt),1);
    await page.locator('#mode').click();
    assert.equal(await page.locator('#play').isVisible(),true);
    await page.locator('#mode').click();
    await page.evaluate(()=>{visibility(true);visibility(false);});
    assert.equal(await page.evaluate(()=>clients.length),0,'ordinary reading never contacts saved Android');
    await page.locator('#voice').evaluate(b=>b.click());
    assert.equal(await page.evaluate(()=>clients.length),0,'synthetic activation cannot start');
    await page.clock.fastForward(2400);
    const labelFits=await mic.evaluate(b=>{const outer=b.getBoundingClientRect(), inner=b.firstElementChild.getBoundingClientRect();return inner.top>=outer.top&&inner.bottom<=outer.bottom;});
    assert.equal(labelFits,true,'visible Android mic label fits inside the button');
    if(process.env.QURAN_REVIEW_DIR){
      await fs.mkdir(process.env.QURAN_REVIEW_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.QURAN_REVIEW_DIR,'direct-reader.png')});
    }
    await mic.click(); await waitForHello();
    await receiveState(0,true); await receiveState(60000); await receiveState(0,false,true);
    assert((await commands()).every(i=>i.c==='hello'),'no start without matching live state');
    await page.locator('#voice').click();
    assert((await commands()).every(i=>i.c==='hello'),'cancel before proof sends no stop');
    await page.evaluate(()=>{autoConnect=false; sent.length=0;});
    await mic.click();await page.waitForFunction(()=>voice.outbox.length>0);await page.locator('#voice').click();
    await page.evaluate(()=>clients.forEach(c=>c.connect()));assert.deepEqual(await commands(),[]);
    await page.evaluate(()=>{autoConnect=true;});
    // A canceled encrypted start cannot publish later, even after the page returns.
    await page.evaluate(()=>{
      window.originalSeal=sealForPhone;
      sealForPhone=async obj=>{const sealed=await originalSeal(obj);if(obj.c==='qStart')await new Promise(r=>window.unblock=r);return sealed;};
    });
    await mic.click();await waitForHello();await receiveState();await page.waitForFunction(()=>typeof window.unblock==='function');
    await page.evaluate(()=>{visibility(true);window.unblock();sealForPhone=originalSeal;visibility(false);});
    assert((await commands()).every(i=>i.c==='hello'));
    await start();
    assert((await commands()).every(i=>i.topic==='bkr/test-android/c' && i.qos===0));
    const signal = (retain,micName) => page.evaluate(async ({retain,micName})=>{
      const payload=await sealForPhone({t:'qv',s:112,st:'listening',mic:micName,re:voice.startTs});
      clients.at(-1).message('bkr/test-android/qv',new TextEncoder().encode(payload),{retain});
    },{retain,micName});
    await signal(true,'phone');assert.equal(await page.evaluate(()=>voice.st),'asking');
    await signal(false,'glasses');await page.waitForFunction(()=>voice.st==='listening');
    assert.equal(await page.locator('#voice').getAttribute('aria-label'),'Stop Android mic');
    await page.evaluate(()=>visibility(true));
    await page.waitForFunction(()=>!voice.grant&&!voice.on);
    await page.evaluate(()=>{clients.forEach(c=>c.connect());visibility(false);});
    await page.clock.fastForward(45000);
    assert((await commands()).some(i=>i.c==='qStop'&&i.only==='voice'));
    assert.equal(await page.evaluate(()=>Boolean(voice.retryTimer)||Boolean(voice.aliveTimer)),false);
    await start();await page.clock.fastForward(21000);
    await page.waitForFunction(()=>!voice.grant&&!voice.on);
    await start();await page.evaluate(()=>{
      const pair=JSON.parse(localStorage.getItem('tg.pair'));pair.t='replaced-target';
      localStorage.setItem('tg.pair',JSON.stringify(pair));dispatchEvent(new StorageEvent('storage',{key:'tg.pair'}));
    });
    await page.waitForFunction(()=>!voice.grant&&!voice.on&&!voice.links.length);
    assert((await commands()).every(i=>i.topic==='bkr/test-android/c'));
    await page.evaluate(()=>{localStorage.removeItem('tg.pair');});
    await page.reload();await page.click('#pick-112');await page.locator('#ayah [data-p]').first().waitFor();
    await page.evaluate(()=>{localStorage.removeItem('tg.pair');applyMode();});
    assert.equal(await page.locator('#voice').isVisible(),false);
    await page.goto(base);
    await page.evaluate(url=>{const frame=document.createElement('iframe');frame.src=url;document.body.append(frame);},base+'/index.html');
    const embedded=page.frameLocator('iframe');
    await embedded.locator('#pick-112').click();
    await embedded.locator('#ayah [data-p]').first().waitFor();
    assert.equal(await embedded.locator('#voice').isVisible(),false,'no mic in an embedded reader');
    assert.equal(await embedded.locator('#reader').evaluate(()=>clients.length),0);
    assert.deepEqual(errors,[]);
    console.log('PASS no modal, silent startup/resume with saved keys, manual and reciter paths, one-action Android mic, fake event denied, signed fresh response required, wrong/retained/stale rejected, delayed encryption, hide, timeout and voice-only stop.');
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
