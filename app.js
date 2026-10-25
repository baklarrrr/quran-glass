'use strict';

// Quran on Meta Ray-Ban Display: follow a recitation word by word.
// Text, word meanings, translation and per-word timing come from Quran.com's public API while the app
// runs, and the recitation streams from QuranicAudio; this site stores none of it.
//
// Input (Neural Band or touchpad): swipe = move focus, pinch = press, system Back = one step back.
// Reader: focus starts on Play; Previous/Next step one ayah. Options: up/down picks a setting,
// left/right changes it. Surah list: left/right jumps ten.

const API = 'https://api.quran.com/api/v4';
const TRANSLATION = 20; // Saheeh International
const PAGE = 50;        // verses per request, the API's maximum
const HISTORY_LIMIT = 4;
const $ = (id) => document.getElementById(id);

// Reciters whose recordings have word-by-word timing on Quran.com.
const RECITERS = [
  { id: 7, name: 'Mishary Alafasy', short: 'Alafasy' },
  { id: 6, name: 'Mahmoud Al-Husary', short: 'Husary' },
  { id: 12, name: 'Al-Husary, teaching', short: 'Husary (teaching)' },
  { id: 2, name: 'Abdul Basit, murattal', short: 'Abdul Basit' },
  { id: 1, name: 'Abdul Basit, mujawwad', short: 'Abdul Basit (mujawwad)' },
  { id: 9, name: 'Al-Minshawi, murattal', short: 'Minshawi' },
  { id: 8, name: 'Al-Minshawi, mujawwad', short: 'Minshawi (mujawwad)' },
  { id: 3, name: 'Abdur-Rahman As-Sudais', short: 'Sudais' },
  { id: 4, name: 'Abu Bakr Ash-Shatri', short: 'Shatri' },
  { id: 5, name: 'Hani Ar-Rifai', short: 'Rifai' },
  { id: 10, name: "Sa'ud Ash-Shuraym", short: 'Shuraym' },
];
const REPEATS = [1, 3, 5, 10, 0]; // 0 = endless
const SPEEDS = [0.75, 0.9, 1, 1.15, 1.3];
const PICKS = [1, 36, 18, 67, 55, 112];

const audio = $('audio');
let settings = load('qg.settings', { reciter: 7, repeat: 1, speed: 1, meaning: true, gloss: true, memorise: false, size: 0 });
let pos = load('qg.pos', null);          // { ch, v } last ayah shown
let chapters = load('qg.chapters', null); // [{ id, en, tn, ar, n }]

const verses = new Map();   // ch -> array indexed by verse number (sparse until loaded)
const pages = new Map();    // `${ch}:${page}` -> Promise
const timings = new Map();  // `${reciter}:${ch}` -> Promise<{ url, t: Map(v -> { from, to, segs }) }>

let view = { screen: 'home' };
let depth = 0;
let cur = null;             // { ch, v } shown in the reader
let timing = null;          // timing for the reciter and surah being played
let playing = false;
let repeatLeft = 0;         // further plays of this ayah; -1 = endless
let litWord = -1;
let waitingForText = false; // paused on purpose until the next page of verses arrives
let loopTimer = 0;
let toastTimer = 0;
let tipFor = null;
let tipShow = 0;
let tipHide = 0;

// ---- small helpers -----------------------------------------------------------------------------

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (v == null) return fallback;
    // Settings gain any newer defaults; lists and positions come back as they were saved.
    const isPlain = (x) => x && typeof x === 'object' && !Array.isArray(x);
    return isPlain(fallback) && isPlain(v) ? { ...fallback, ...v } : v;
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode: fine for this session */ }
}

function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

function shown(el, on) {
  if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
}

function reciter() {
  return RECITERS.find((r) => r.id === settings.reciter) || RECITERS[0];
}

function chapter(ch) {
  return chapters && chapters[ch - 1];
}

function plainText(html) {
  // Footnote markers carry numbers that belong to the printed translation, not the meaning.
  return String(html || '').replace(/<sup[^>]*>.*?<\/sup>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function getJson(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- data from Quran.com -----------------------------------------------------------------------

async function ensureChapters() {
  if (chapters && chapters.length === 114) return chapters;
  const data = await getJson('/chapters?language=en');
  chapters = data.chapters.map((c) => ({ id: c.id, en: c.name_simple, tn: c.translated_name ? c.translated_name.name : '', ar: c.name_arabic, n: c.verses_count }));
  try { localStorage.setItem('qg.chapters', JSON.stringify(chapters)); } catch (e) { /* fine */ }
  return chapters;
}

function loadPage(ch, page) {
  const key = `${ch}:${page}`;
  if (!pages.has(key)) {
    const p = getJson(`/verses/by_chapter/${ch}?words=true&word_fields=text_uthmani&translations=${TRANSLATION}&fields=text_uthmani&per_page=${PAGE}&page=${page}`)
      .then((data) => {
        const list = verses.get(ch) || [];
        for (const v of data.verses) {
          const words = [];
          let end = '';
          for (const w of v.words) {
            if (w.char_type_name === 'end') end = w.text_uthmani || '';
            else if (w.char_type_name === 'word') {
              words.push({ p: w.position, ar: w.text_uthmani, en: w.translation ? w.translation.text : '', tr: w.transliteration ? w.transliteration.text : '' });
            }
          }
          list[v.verse_number] = { n: v.verse_number, key: v.verse_key, words, end, meaning: plainText(v.translations && v.translations[0] && v.translations[0].text) };
        }
        verses.set(ch, list);
      })
      .catch((e) => { pages.delete(key); throw e; });
    pages.set(key, p);
  }
  return pages.get(key);
}

async function ensureVerse(ch, v) {
  const list = verses.get(ch);
  if (!list || !list[v]) await loadPage(ch, Math.floor((v - 1) / PAGE) + 1);
  // Keep the next page coming before it is needed.
  const c = chapter(ch);
  if (c && v % PAGE > PAGE - 10 && v + 10 <= c.n) loadPage(ch, Math.floor((v - 1) / PAGE) + 2).catch(() => {});
  return verses.get(ch)[v];
}

function ensureTiming(rid, ch) {
  const key = `${rid}:${ch}`;
  if (!timings.has(key)) {
    const p = getJson(`/chapter_recitations/${rid}/${ch}?segments=true`).then((data) => {
      const t = new Map();
      for (const s of data.audio_file.timestamps || []) {
        const v = Number(String(s.verse_key).split(':')[1]);
        // Some entries are placeholders like [1]; only [word, start, end] are timings.
        const segs = (s.segments || []).filter((x) => Array.isArray(x) && x.length >= 3).sort((a, b) => a[1] - b[1]);
        t.set(v, { from: s.timestamp_from, to: s.timestamp_to, segs });
      }
      return { url: data.audio_file.audio_url, t };
    }).catch((e) => { timings.delete(key); throw e; });
    timings.set(key, p);
  }
  return timings.get(key);
}

// ---- screens and Back ------------------------------------------------------------------------

function go(next) {
  if (depth < HISTORY_LIMIT) { history.pushState(next, ''); depth++; } else history.replaceState(next, '');
  render(next);
}

function render(next) {
  view = next || { screen: 'home' };
  const sc = view.screen;
  for (const id of ['home', 'list', 'reader', 'options']) $(id).hidden = id !== sc;
  if (sc === 'home') renderHome();
  else if (sc === 'list') renderList();
  else if (sc === 'reader') renderReader();
  else if (sc === 'options') renderOptions();
}

function onPopState(e) {
  depth = Math.max(0, depth - 1);
  render(e.state || { screen: 'home' });
}

function openFrom(from, next) {
  history.replaceState({ ...view, focus: from }, '');
  go(next);
}

function focusFirst(...ids) {
  for (const id of ids) {
    const el = typeof id === 'string' ? $(id) : id;
    if (el && !el.hidden && !el.disabled) { el.focus(); return; }
  }
}

// ---- home -------------------------------------------------------------------------------------

function renderHome() {
  const card = $('resume');
  if (pos && chapter(pos.ch)) {
    const c = chapter(pos.ch);
    $('resumeName').textContent = c.en;
    $('resumeArabic').textContent = c.ar;
    $('resumeMeta').textContent = `${playing ? 'Reciting · ' : ''}Ayah ${pos.v} of ${c.n} · ${reciter().short}`;
    card.hidden = false;
  } else card.hidden = true;
  $('homeHint').hidden = !card.hidden;
  $('homeNote').textContent = chapters ? '' : 'Loading surahs…';

  const picks = $('picks');
  if (chapters && !picks.childElementCount) {
    for (const ch of PICKS) {
      const c = chapter(ch);
      const b = document.createElement('button');
      b.className = 'pick';
      b.id = `pick-${ch}`;
      b.setAttribute('aria-label', `${c.en}, surah ${ch}`);
      b.innerHTML = '<span class="ar-name" lang="ar" dir="rtl"></span><span class="en"></span>';
      b.querySelector('.ar-name').textContent = c.ar;
      b.querySelector('.en').textContent = c.en;
      b.addEventListener('click', () => openFrom(b.id, { screen: 'reader', ch, v: pos && pos.ch === ch ? pos.v : 1 }));
      picks.appendChild(b);
    }
  }
  focusFirst(view.focus && $(view.focus), card, 'allSurahs');
}

// ---- surah list --------------------------------------------------------------------------------

function renderList() {
  const list = $('surahs');
  if (chapters && !list.childElementCount) {
    for (const c of chapters) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.id = `surah-${c.id}`;
      b.dataset.ch = String(c.id);
      b.innerHTML = '<span class="num"></span><span class="names"><span class="en"></span><span class="sub"></span></span><span class="ar-name" lang="ar" dir="rtl"></span>';
      b.querySelector('.num').textContent = String(c.id);
      b.querySelector('.en').textContent = c.en;
      b.querySelector('.sub').textContent = `${c.tn} · ${c.n} ayahs`;
      b.querySelector('.ar-name').textContent = c.ar;
      b.addEventListener('click', () => openFrom(b.id, { screen: 'reader', ch: c.id, v: pos && pos.ch === c.id ? pos.v : 1 }));
      li.appendChild(b);
      list.appendChild(li);
    }
  }
  if (!chapters) {
    ensureChapters().then(() => { if (view.screen === 'list') renderList(); }).catch(() => showToast('Can’t reach Quran.com right now'));
    $('listTitle').focus();
    return;
  }
  focusFirst(view.focus && $(view.focus), pos && $(`surah-${pos.ch}`), 'surah-1');
}

// ---- reader -----------------------------------------------------------------------------------

async function renderReader() {
  const ch = view.ch || (pos && pos.ch) || 1;
  const v = view.v || 1;
  if (!cur || cur.ch !== ch || cur.v !== v) await moveTo(ch, v, playing && cur && cur.ch === ch);
  else drawAyah();
  focusFirst(view.focus && $(view.focus), 'play');
}

// Shows ayah v of surah ch; while playing in the same surah the recitation jumps there too.
async function moveTo(ch, v, keepPlaying) {
  const surahChanged = !cur || cur.ch !== ch;
  cur = { ch, v };
  pos = { ch, v };
  save('qg.pos', pos);
  history.replaceState({ ...view, ch, v }, '');
  view = { ...view, ch, v };
  litWord = -1;
  repeatLeft = settings.repeat ? settings.repeat - 1 : -1;
  if (surahChanged && playing) pause();
  drawLoading();
  try {
    await ensureChapters();
    await ensureVerse(ch, v);
  } catch (e) {
    drawLoading('Can’t reach Quran.com. Check your phone’s connection.');
    return;
  }
  if (cur.ch !== ch || cur.v !== v) return; // moved on while loading
  drawAyah();
  if (keepPlaying && playing && timing) {
    const tm = timing.t.get(v);
    if (tm) audio.currentTime = tm.from / 1000;
  }
}

function drawLoading(text) {
  const el = $('ayah');
  el.className = 'ayah loading';
  el.textContent = text || 'Loading…';
  $('gloss').textContent = '';
  $('meaning').textContent = '';
  drawTop();
}

function drawTop() {
  const c = cur && chapter(cur.ch);
  $('where').textContent = c ? `${c.id} ${c.en} · ${cur.v} of ${c.n}` : '';
  $('whoText').textContent = reciter().short + (settings.speed !== 1 ? ` · ${settings.speed}×` : '');
  $('liveDot').classList.toggle('live', playing);
  shown($('playIcon'), !playing);
  shown($('pauseIcon'), playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const badge = $('repeatBadge');
  badge.hidden = settings.repeat === 1;
  badge.textContent = settings.repeat === 0 ? '∞' : String(settings.repeat);
  refreshTip();
}

function drawAyah() {
  const verse = verses.get(cur.ch) && verses.get(cur.ch)[cur.v];
  if (!verse) return;
  const el = $('ayah');
  el.className = 'ayah';
  el.textContent = '';
  verse.words.forEach((w, i) => {
    if (i) el.appendChild(document.createTextNode(' '));
    const s = document.createElement('span');
    s.className = settings.memorise ? 'w veiled' : 'w';
    s.dataset.p = String(w.p);
    s.textContent = w.ar;
    el.appendChild(s);
  });
  if (verse.end) {
    el.appendChild(document.createTextNode(' '));
    const e = document.createElement('span');
    e.className = 'end';
    // U+06DD with the ayah number draws the ornamented end-of-ayah mark in Amiri Quran.
    e.textContent = '۝' + verse.end;
    el.appendChild(e);
  }
  $('meaning').textContent = settings.meaning ? verse.meaning : '';
  shown($('meaning'), settings.meaning);
  $('gloss').textContent = '';
  shown($('gloss'), settings.gloss);
  drawTop();
  fitAyah();
  if (playing) highlight(audio.currentTime * 1000, true);
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    const c = chapter(cur.ch);
    navigator.mediaSession.metadata = new MediaMetadata({ title: `${c ? c.en : 'Surah ' + cur.ch} ${cur.ch}:${cur.v}`, artist: reciter().name, album: 'Quran' });
  }
}

// Long ayahs get smaller type, then scroll with the recitation.
function fitAyah() {
  const box = $('textbox');
  const el = $('ayah');
  let size = settings.size ? 36 : 44;
  el.style.fontSize = `${size}px`;
  while (box.scrollHeight > box.clientHeight + 1 && size > 26) {
    size -= 2;
    el.style.fontSize = `${size}px`;
  }
  box.scrollTop = 0;
}

function highlight(t, force) {
  const tm = timing && timing.t.get(cur.v);
  if (!tm || !tm.segs.length) return;
  let p = -1;
  for (const s of tm.segs) {
    if (s[1] <= t) p = s[0]; else break;
  }
  if (p === litWord && !force) return;
  litWord = p;
  const verse = verses.get(cur.ch)[cur.v];
  for (const s of $('ayah').querySelectorAll('.w')) {
    const wp = Number(s.dataset.p);
    s.className = wp < p ? 'w said' : wp === p ? 'w now' : (settings.memorise ? 'w veiled' : 'w');
    if (wp === p) {
      const box = $('textbox');
      if (box.scrollHeight > box.clientHeight) s.scrollIntoView({ block: 'nearest' });
    }
  }
  const word = verse && verse.words.find((w) => w.p === p);
  const gloss = $('gloss');
  gloss.textContent = '';
  if (word && settings.gloss) {
    const tr = document.createElement('span');
    tr.className = 'tr';
    tr.textContent = word.tr;
    gloss.append(tr, document.createTextNode(`  ${word.en}`));
  }
}

// ---- playback --------------------------------------------------------------------------------

async function play() {
  if (!cur) return;
  const ch = cur.ch;
  try {
    timing = await ensureTiming(settings.reciter, ch);
  } catch (e) {
    showToast('Can’t load this recitation right now');
    return;
  }
  if (!cur || cur.ch !== ch) return;
  const tm = timing.t.get(cur.v);
  if (!tm) { showToast('No timing for this ayah'); return; }
  if (audio.getAttribute('src') !== timing.url) {
    audio.src = timing.url;
    await new Promise((resolve) => {
      if (audio.readyState >= 1) return resolve();
      audio.addEventListener('loadedmetadata', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
      audio.load();
    });
  }
  audio.playbackRate = settings.speed;
  const now = audio.currentTime * 1000;
  if (!(now >= tm.from - 80 && now < tm.to - 80)) audio.currentTime = tm.from / 1000;
  try {
    await audio.play();
  } catch (e) {
    showToast('The recitation could not start');
    return;
  }
  playing = true;
  drawTop();
  loop();
}

function pause() {
  audio.pause();
  playing = false;
  clearTimeout(loopTimer);
  loopTimer = 0;
  if (cur) drawTop();
}

function loop() {
  clearTimeout(loopTimer);
  loopTimer = 0;
  if (!playing) return;
  step();
  // Smooth word lighting only while the display shows it; audio events keep time otherwise.
  if (document.visibilityState === 'visible') loopTimer = setTimeout(loop, 60);
}

// The recitation is one file per surah, so the next ayah simply follows; repeats jump back.
function step() {
  if (!playing || !cur || !timing) return;
  const t = audio.currentTime * 1000;
  const tm = timing.t.get(cur.v);
  if (!tm) return;
  if (t >= tm.to - 40) {
    if (repeatLeft !== 0) {
      if (repeatLeft > 0) repeatLeft--;
      audio.currentTime = tm.from / 1000;
      litWord = -1;
      return;
    }
    const c = chapter(cur.ch);
    if (c && cur.v < c.n) {
      const next = cur.v + 1;
      if (verses.get(cur.ch)[next]) {
        cur = { ch: cur.ch, v: next };
        pos = { ...cur };
        save('qg.pos', pos);
        if (view.screen === 'reader') { history.replaceState({ ...view, ch: cur.ch, v: next }, ''); view = { ...view, ch: cur.ch, v: next }; }
        litWord = -1;
        repeatLeft = settings.repeat ? settings.repeat - 1 : -1;
        drawAyah();
      } else {
        // The next page is still on its way: wait for it rather than run ahead of the text.
        waitingForText = true;
        audio.pause();
        ensureVerse(cur.ch, next)
          .then(() => { waitingForText = false; if (playing) { audio.play().catch(() => {}); step(); } })
          .catch(() => { waitingForText = false; pause(); });
      }
    } else if (t >= tm.to - 40) {
      pause();
      showToast(`End of ${c ? c.en : 'the surah'}`);
    }
    return;
  }
  highlight(t);
}

function stepAyah(dir) {
  if (!cur) return;
  const c = chapter(cur.ch);
  const v = cur.v + dir;
  if (v < 1) { showToast('Start of the surah'); return; }
  if (c && v > c.n) {
    if (cur.ch < 114) moveTo(cur.ch + 1, 1, false).then(() => showToast(chapter(cur.ch).en));
    return;
  }
  moveTo(cur.ch, v, true);
}

// ---- button names in the reader ----------------------------------------------------------------

const TIPS = {
  prevAyah: () => 'Previous ayah',
  play: () => (playing ? 'Pause' : 'Play the recitation'),
  nextAyah: () => 'Next ayah',
  repeat: () => (settings.repeat === 1 ? 'Repeat each ayah: once' : settings.repeat === 0 ? 'Repeat each ayah: endless' : `Repeat each ayah: ${settings.repeat} times`),
  readerOptions: () => 'Reciter, speed and more',
};

function showTip(el) {
  const tip = $('tip');
  clearTimeout(tipShow);
  clearTimeout(tipHide);
  tipFor = el && TIPS[el.id] ? el.id : null;
  if (!tipFor) { tip.classList.remove('on'); return; }
  tipShow = setTimeout(() => {
    tip.textContent = TIPS[tipFor]();
    tip.classList.add('on');
    tipHide = setTimeout(() => tip.classList.remove('on'), 2200);
  }, 160);
}

function refreshTip() {
  if (tipFor && $('tip').classList.contains('on')) $('tip').textContent = TIPS[tipFor]();
}

// ---- options ----------------------------------------------------------------------------------

const OPTIONS = [
  { k: 'reciter', label: 'Reciter', values: RECITERS.map((r) => r.id), text: (v) => (RECITERS.find((r) => r.id === v) || RECITERS[0]).name },
  { k: 'repeat', label: 'Each ayah', values: REPEATS, text: (v) => (v === 0 ? 'Repeat endlessly' : v === 1 ? 'Once' : `${v} times`) },
  { k: 'speed', label: 'Speed', values: SPEEDS, text: (v) => `${v}×` },
  { k: 'meaning', label: 'Meaning', values: [true, false], text: (v) => (v ? 'Shown' : 'Hidden') },
  { k: 'gloss', label: 'Word meaning', values: [true, false], text: (v) => (v ? 'Shown' : 'Hidden') },
  { k: 'memorise', label: 'Memorise', values: [false, true], text: (v) => (v ? 'Words appear as recited' : 'Off') },
  { k: 'size', label: 'Text size', values: [0, 1], text: (v) => (v ? 'Medium' : 'Large') },
];

function buildOptions() {
  const box = $('optRows');
  for (const o of OPTIONS) {
    const row = document.createElement('div');
    row.className = 'orow';
    row.id = `opt-${o.k}`;
    row.tabIndex = 0;
    row.dataset.k = o.k;
    row.setAttribute('role', 'slider');
    row.setAttribute('aria-label', `${o.label}. Swipe left or right to change.`);
    row.innerHTML = '<span class="lab"></span><span class="val"><span class="arrow" aria-hidden="true">‹</span><span class="v"></span><span class="arrow" aria-hidden="true">›</span></span>';
    row.querySelector('.lab').textContent = o.label;
    box.appendChild(row);
  }
  box.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.orow');
    if (!row) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      changeOption(row.dataset.k, e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  box.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('.orow');
    if (row && e.detail) changeOption(row.dataset.k, 1);
  });
}

function changeOption(k, dir) {
  const o = OPTIONS.find((x) => x.k === k);
  const i = o.values.indexOf(settings[k]);
  const next = o.values[(Math.max(0, i) + dir + o.values.length) % o.values.length];
  const before = settings[k];
  settings = { ...settings, [k]: next };
  save('qg.settings', settings);
  renderOptions(true);
  if (k === 'speed') audio.playbackRate = next;
  if (k === 'repeat') repeatLeft = next ? next - 1 : -1;
  if (k === 'reciter' && before !== next) {
    // A different recitation has its own audio file and timing.
    const wasPlaying = playing;
    pause();
    timing = null;
    audio.removeAttribute('src');
    if (wasPlaying) play();
  }
  if (cur && ['meaning', 'gloss', 'memorise', 'size'].includes(k)) drawAyah();
}

function renderOptions(keepFocus) {
  for (const o of OPTIONS) {
    const row = $(`opt-${o.k}`);
    const text = o.text(settings[o.k]);
    row.querySelector('.v').textContent = text;
    row.setAttribute('aria-valuetext', text);
  }
  if (!keepFocus) focusFirst(view.focus && $(view.focus), 'opt-reciter');
}

// ---- wiring -----------------------------------------------------------------------------------

function wire() {
  $('resume').addEventListener('click', () => { if (pos) openFrom('resume', { screen: 'reader', ch: pos.ch, v: pos.v }); });
  $('allSurahs').addEventListener('click', () => openFrom('allSurahs', { screen: 'list' }));
  $('homeOptions').addEventListener('click', () => openFrom('homeOptions', { screen: 'options' }));
  $('readerOptions').addEventListener('click', () => openFrom('readerOptions', { screen: 'options' }));
  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('prevAyah').addEventListener('click', () => stepAyah(-1));
  $('nextAyah').addEventListener('click', () => stepAyah(1));
  $('repeat').addEventListener('click', () => {
    const i = REPEATS.indexOf(settings.repeat);
    settings = { ...settings, repeat: REPEATS[(i + 1) % REPEATS.length] };
    save('qg.settings', settings);
    repeatLeft = settings.repeat ? settings.repeat - 1 : -1;
    drawTop();
    showToast(TIPS.repeat().replace('Repeat each ayah: ', 'Each ayah ').replace('Each ayah endless', 'Each ayah repeats endlessly'));
  });

  // The surah list is one column, so sideways swipes jump ten at a time.
  $('surahs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const b = e.target.closest && e.target.closest('button');
    if (!b) return;
    e.preventDefault();
    const ch = Math.max(1, Math.min(114, Number(b.dataset.ch) + (e.key === 'ArrowRight' ? 10 : -10)));
    const target = $(`surah-${ch}`);
    if (target) target.focus();
  });

  audio.addEventListener('timeupdate', step);
  audio.addEventListener('ended', () => { if (playing) step(); pause(); });
  // The system may pause the audio itself (another app, the display going to sleep): follow it.
  audio.addEventListener('pause', () => { if (playing && !waitingForText) pause(); });
  audio.addEventListener('error', () => { if (playing) { pause(); showToast('The recitation stopped: connection problem'); } });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* not supported here */ } };
    set('play', () => play());
    set('pause', () => pause());
    set('nexttrack', () => stepAyah(1));
    set('previoustrack', () => stepAyah(-1));
  }

  document.addEventListener('focusin', (e) => { if (view.screen === 'reader') showTip(e.target); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.screen !== 'home') { e.preventDefault(); history.back(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && playing) loop(); });
  window.addEventListener('popstate', onPopState);
  if (document.fonts && document.fonts.load) {
    document.fonts.load('44px "Amiri Quran"').then(() => { if (view.screen === 'reader' && cur) fitAyah(); }).catch(() => {});
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* optional */ }
}

async function main() {
  history.replaceState({ screen: 'home' }, '');
  wire();
  buildOptions();
  render({ screen: 'home' });
  registerServiceWorker();
  try {
    await ensureChapters();
    if (view.screen === 'home') render({ ...view });
  } catch (e) {
    $('homeNote').textContent = 'Can’t reach Quran.com';
  }
}

main();
