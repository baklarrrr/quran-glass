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
      Object.defineProperty(navigator,'getBattery',{value:()=>Promise.resolve({level:0.64,charging:false,addEventListener(){}})});
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
          return {c:JSON.parse(new TextDecoder().decode(plain)).c,topic:item.topic,qos:item.options.qos};
        }));
      };
    });

    await page.goto(base);
    await page.locator('#pick-112').click();
    await page.locator('#ayah [data-p]').first().waitFor();
    const mic = page.locator('#voice'), choice = page.locator('#androidMicChoice');
    const commands = () => page.evaluate(()=>window.commands());
    const consent = async () => {
      await mic.click();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'useAndroidMic');
      await page.keyboard.press('Enter');
    };
    await mic.click();
    assert.equal(await choice.isVisible(),true);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'keepReading');
    assert.equal(await page.evaluate(()=>window.clients.length),0);
    if (process.env.QURAN_REVIEW_DIR) {
      await fs.mkdir(process.env.QURAN_REVIEW_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.QURAN_REVIEW_DIR,'android-mic-choice.png')});
    }
    await page.keyboard.press('Enter'); // default choice only returns to reading
    await mic.click(); await page.keyboard.press('Escape');
    await mic.click(); await page.clock.fastForward(31000);
    assert.equal(await choice.isVisible(),false);
    await mic.click(); await page.evaluate(()=>visibility(true));
    assert.equal(await choice.isVisible(),false);
    await page.evaluate(()=>{visibility(false);return phoneSend('qStart');});
    assert.deepEqual(await commands(),[]);

    // Pair changed while the chooser was open. The old button can no longer authorize it.
    await mic.click();
    await page.evaluate(()=>{
      const pair=JSON.parse(localStorage.getItem('tg.pair'));pair.t='other';localStorage.setItem('tg.pair',JSON.stringify(pair));
    });
    await page.locator('#useAndroidMic').click();
    assert.deepEqual(await commands(),[]);
    await page.evaluate(()=>{const pair=JSON.parse(localStorage.getItem('tg.pair'));pair.t='test-android';localStorage.setItem('tg.pair',JSON.stringify(pair));});

    console.log('Chooser, cancel and pairing changes passed');
    // Cancel while the first sealed start is still waiting for a broker.
    await page.evaluate(()=>{window.autoConnect=false;});
    await consent();
    await page.waitForFunction(()=>voice.outbox.length>0);
    await mic.click();
    await page.evaluate(()=>clients.forEach(c=>c.connect()));
    assert.deepEqual(await commands(),[]);

    console.log('Cancel before a broker connects passed');
    // The queued encryption must not outlive the consent that began it.
    await page.evaluate(()=>{
      window.autoConnect=true;
      window.originalSeal = sealForPhone;
      sealForPhone = async obj=>{
        const sealed=await originalSeal(obj);
        if(obj.c==='qStart')await new Promise(resolve=>{window.unblockSeal=resolve;});
        return sealed;
      };
    });
    await consent();
    await page.waitForFunction(()=>typeof window.unblockSeal==='function');
    await page.evaluate(()=>{visibility(true);window.unblockSeal();sealForPhone=window.originalSeal;});
    await page.evaluate(()=>visibility(false));
    assert.deepEqual(await commands(),[]);

    console.log('Cancellation during encryption passed');
    // A fresh foreground confirmation is the only path to a microphone start.
    await consent();
    await page.waitForFunction(()=>voice.startSent);
    let history = await commands();
    assert(history.length>0 && history.every(i=>i.c==='qStart' && i.topic==='bkr/test-android/c' && i.qos===0));
    const stateAfterRetained = await page.evaluate(async()=>{
      const payload = await sealForPhone({t:'qv',s:112,st:'listening',re:voice.startTs});
      const latest = clients.at(-1);
      latest.message('bkr/test-android/qv',new TextEncoder().encode(payload),{retain:true});
      return voice.st;
    });
    assert.equal(stateAfterRetained,'asking');
    await page.evaluate(async()=>{
      const payload = await sealForPhone({t:'qv',s:112,st:'listening',re:voice.startTs});
      clients.at(-1).message('bkr/test-android/qv',new TextEncoder().encode(payload),{retain:false});
    });
    await page.waitForFunction(()=>voice.st==='listening');
    await page.evaluate(()=>visibility(true));
    await page.waitForFunction(async()=>(await commands()).some(i=>i.c==='qStop'));
    const stoppedAt = (await commands()).length;
    await page.evaluate(()=>{clients.forEach(c=>c.connect());visibility(false);});
    await page.clock.fastForward(45000);
    assert.equal((await commands()).length,stoppedAt);
    assert.equal(await page.evaluate(()=>Boolean(voice.grant) || voice.on || Boolean(voice.retryTimer)),false);
    await mic.click(); await page.keyboard.press('Escape');
    assert.equal((await commands()).length,stoppedAt);

    console.log('Hidden session and stale broker passed');
    // Foreground timeout clears start, retries, cached messages, and authority.
    await consent();
    await page.waitForFunction(()=>voice.startSent);
    await page.clock.fastForward(21000);
    await page.waitForFunction(()=>!voice.on && !voice.grant);
    assert.equal(await page.evaluate(()=>voice.outbox.length + voice.sent.length + voice.retryTimer + voice.aliveTimer),0);
    // An active target change must stop only the old confirmed Android session.
    await consent();
    await page.waitForFunction(()=>voice.startSent);
    await page.evaluate(()=>{
      const pair=JSON.parse(localStorage.getItem('tg.pair'));pair.t='new-target';
      localStorage.setItem('tg.pair',JSON.stringify(pair));
      window.dispatchEvent(new StorageEvent('storage',{key:'tg.pair'}));
    });
    await page.waitForFunction(()=>!voice.grant && !voice.on && !voice.links.length);
    assert((await commands()).every(i=>i.topic==='bkr/test-android/c'));
    assert.deepEqual(errors,[]);
    console.log('PASS old pairing, deliberate Android confirmation, cancel/default/Back, target mismatch, hidden, expired choice, pre-publish cancel, delayed encryption, late broker, idle timeout and stop-only-after-start.');
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
