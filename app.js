'use strict';

// Quran on Meta Ray-Ban Display.
// Two ways to follow an ayah, both gilding each word once it has been recited:
//   Follow the reciter: a reciter's recording plays and the words gild with Quran.com's timing.
//   Recite myself: the wearer recites aloud and gilds each word with a pinch or a swipe right as
//   they say it, like following with a finger; a swipe left takes one back. Hints help when stuck.
// Text, word meanings, translation, per-word timing and word-by-word audio come from Quran.com's
// public API while the app runs, and the recitation streams from QuranicAudio; this site stores
// none of it. What the wearer marks is kept only on the glasses (localStorage).
//
// Input (Neural Band or touchpad): swipe = move focus, pinch = press, system Back = one step back.
// Reader: in Follow the reciter focus starts on Play; in Recite myself it starts on the text.

const API = 'https://api.quran.com/api/v4';
const WORD_AUDIO = 'https://audio.qurancdn.com/';
const TRANSLATION = 20; // Saheeh International
const PAGE = 50;        // verses per request, the API's maximum
const HISTORY_LIMIT = 4;
const SESSION_GAP = 15 * 60 * 1000;  // a longer pause starts a new session
const ACTIVE_CAP = 60 * 1000;        // gaps longer than a minute count as a pause, not reciting time
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
// Marks that belong to the letter before them (vowels, Quranic signs), kept with it in hints.
const MARK = /[ؐ-ًؚ-ٰٟۖ-ۭ]/;

// Arabic typefaces (Options → Arabic font). Scheherazade New is the default: see style.css.
const SCRIPTS = [
  { id: 'scheherazade', name: 'Scheherazade', family: 'Scheherazade New', weight: 500 },
  { id: 'amiri', name: 'Amiri Quran', family: 'Amiri Quran', weight: 400 },
  { id: 'noto', name: 'Noto Naskh', family: 'Noto Naskh Arabic', weight: 500 },
];
const EFFECTS = ['full', 'calm', 'off'];
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
// The recommended settings, restored by Options → Reset to best settings.
const DEFAULTS = { reciter: 7, repeat: 1, speed: 1, meaning: true, gloss: true, memorise: false, size: 0, mode: 'listen', script: 'scheherazade', effects: 'full' };
// More reciters, timed word by word with Bakar's own alignment tools. Optional: ignored if absent.
const MANIFEST = 'https://baklarrrr.github.io/quran-timings/reciters.json';

const audio = $('audio');
const wordAudio = $('wordAudio');
const previewAudio = $('preview');
let settings = load('qg.settings', { ...DEFAULTS });
let pos = load('qg.pos', null);          // { ch, v, w } last place; w = words gilded in Recite myself
let chapters = load('qg.chapters', null); // [{ id, en, tn, ar, n }]
let progress = load('qg.progress', freshProgress());

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
let wantPlay = false;       // Play was pressed while the recitation was still loading
let loopTimer = 0;
let toastTimer = 0;
let tipFor = null;
let tipShow = 0;
let tipHide = 0;

// The drawn ayah: one span per word, and the class each currently has, so only changes are written.
let spans = [];
let spanCls = [];
let redrawing = false;      // a whole-ayah redraw: no gilding effects for words that were already gilded

// Reciter preview in Options.
let previewTimer = 0;       // the short wait after a flip, so quick flips do not each start a voice
let previewTick = 0;
let previewToken = 0;       // bumped on every stop, so a preview still loading never starts late
let previewStopAt = 0;      // seconds into the preview file
let previewNoted = false;   // the Options header says "Previewing …"
let previewUnlocked = false; // a preview has played, so this player may make sound without a press
let extraReady = Promise.resolve();
let resetArmed = 0;         // Reset waits this long for its second pinch

// Effects.
let fxParts = [];
let fxRaf = 0;
let fxLast = 0;

// Recite myself.
let reciteAt = 0;           // words gilded so far in this ayah
let hintStep = 0;           // hint steps used on the next word
let ayahDone = false;       // this visit's completion of the ayah is already recorded
let session = null;

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

// On a see-through display a message cannot cover the text under it, so the top line steps aside
// while a message shows.
function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  document.body.classList.add('toasting');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
    document.body.classList.remove('toasting');
  }, 1800);
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

function currentVerse() {
  return cur && verses.get(cur.ch) ? verses.get(cur.ch)[cur.v] : null;
}

function reciting() {
  return settings.mode === 'recite';
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
              words.push({ p: w.position, ar: w.text_uthmani, en: w.translation ? w.translation.text : '', tr: w.transliteration ? w.transliteration.text : '', au: w.audio_url || '' });
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
    let p;
    if (typeof rid === 'string' && rid.startsWith('x:')) {
      // A reciter from the alignment manifest: the same timing shape, from Bakar's own site.
      const known = RECITERS.find((x) => x.id === rid);
      p = (known ? Promise.resolve(known) : extraReady.then(() => RECITERS.find((x) => x.id === rid))).then((r) => {
        if (!r) throw new Error('unknown-reciter');
        const c = r.custom;
        if (c.chapters.length && !c.chapters.includes(ch)) throw new Error('not-recorded');
        return fetch(fill(c.timingsUrlTemplate, ch))
          .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
          .then((data) => parseTiming(data, c.audioUrlTemplate ? fill(c.audioUrlTemplate, ch) : null));
      });
    } else {
      p = getJson(`/chapter_recitations/${rid}/${ch}?segments=true`).then((data) => parseTiming(data, null));
    }
    p = p.catch((e) => { timings.delete(key); throw e; });
    timings.set(key, p);
  }
  return timings.get(key);
}

function fill(template, ch) {
  return template.replace('{ch3}', String(ch).padStart(3, '0')).replace('{ch}', String(ch));
}

function parseTiming(data, audioUrl) {
  const t = new Map();
  for (const s of data.audio_file.timestamps || []) {
    const v = Number(String(s.verse_key).split(':')[1]);
    // Some entries are placeholders like [1]; only [word, start, end] are timings.
    const segs = (s.segments || []).filter((x) => Array.isArray(x) && x.length >= 3).sort((a, b) => a[1] - b[1]);
    t.set(v, { from: s.timestamp_from, to: s.timestamp_to, segs });
  }
  return { url: audioUrl || data.audio_file.audio_url, t };
}

// Adds the alignment manifest's reciters to the list: first the copy kept on the glasses, then the
// current manifest when it can be reached. Without a manifest nothing changes.
async function loadExtraReciters() {
  mergeReciters(load('qg.extraReciters', null));
  try {
    const r = await fetch(MANIFEST, { cache: 'no-cache' });
    if (!r.ok) return;
    const data = await r.json();
    const list = Array.isArray(data) ? data : data && data.reciters;
    if (!Array.isArray(list)) return;
    save('qg.extraReciters', list);
    if (mergeReciters(list) && view.screen === 'options') renderOptions(true);
  } catch (e) { /* absent or offline: keep what was there */ }
}

function mergeReciters(list) {
  if (!Array.isArray(list)) return false;
  let added = false;
  for (const e of list) {
    if (!e || !e.id || !e.name || typeof e.timingsUrlTemplate !== 'string') continue;
    const id = `x:${e.id}`;
    if (RECITERS.some((x) => x.id === id)) continue;
    // Surah numbers may arrive as text; an empty or missing list means every surah.
    const chapters = Array.isArray(e.chapters) ? e.chapters.map(Number).filter((n) => n >= 1 && n <= 114) : [];
    RECITERS.push({ id, name: String(e.name), short: String(e.short || e.name), custom: { ...e, chapters } });
    added = true;
  }
  if (added) OPTIONS.find((o) => o.k === 'reciter').values = RECITERS.map((x) => x.id);
  return added;
}

// ---- what the wearer marks, kept on the glasses --------------------------------------------------

function freshProgress() {
  return { v: 1, ayahs: {}, sessions: [], totals: { recited: 0, words: 0, hints: 0, listened: 0, activeMs: 0 } };
}

function ayahRecord(ch, v) {
  const k = `${ch}:${v}`;
  if (!progress.ayahs[k]) progress.ayahs[k] = { r: 0, h: 0, l: 0 };
  return progress.ayahs[k];
}

// Counts one thing the wearer did. Time counts only between actions less than a minute apart, so a
// pause or a forgotten screen never inflates the reciting time. No timer runs for this.
function note(kind, delta = 1) {
  const now = Date.now();
  if (!session) {
    const last = progress.sessions[progress.sessions.length - 1];
    if (last && now - last.e < SESSION_GAP) session = last;
  }
  if (!session || now - session.e >= SESSION_GAP) {
    session = { s: now, e: now, a: 0, ch: cur ? cur.ch : 0, r: 0, w: 0, h: 0, l: 0 };
    progress.sessions.push(session);
    if (progress.sessions.length > 30) progress.sessions.shift();
  } else {
    const gap = Math.min(now - session.e, ACTIVE_CAP);
    if (kind !== 'listened') {
      session.a += gap;
      progress.totals.activeMs += gap;
    }
  }
  session.e = now;
  const t = progress.totals;
  if (kind === 'word') { session.w = Math.max(0, session.w + delta); t.words = Math.max(0, t.words + delta); }
  else if (kind === 'hint') { session.h++; t.hints++; ayahRecord(cur.ch, cur.v).h++; }
  else if (kind === 'recited') { session.r++; t.recited++; const a = ayahRecord(cur.ch, cur.v); a.r++; a.t = now; }
  else if (kind === 'listened') { session.l++; t.listened++; ayahRecord(cur.ch, cur.v).l++; }
  save('qg.progress', progress);
}

// ---- screens and Back ------------------------------------------------------------------------

function go(next) {
  if (depth < HISTORY_LIMIT) { history.pushState(next, ''); depth++; } else history.replaceState(next, '');
  render(next);
}

function render(next) {
  view = next || { screen: 'home' };
  const sc = view.screen;
  if (sc !== 'options') { stopPreview(true); disarmReset(); }
  if (sc !== 'reader') stopEffects();
  clearTips();
  for (const id of ['home', 'list', 'reader', 'progress', 'options']) $(id).hidden = id !== sc;
  if (sc === 'home') renderHome();
  else if (sc === 'list') renderList();
  else if (sc === 'reader') renderReader();
  else if (sc === 'progress') renderProgress();
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
    $('resumeMeta').textContent = reciting()
      ? `Ayah ${pos.v} of ${c.n} · word ${(pos.w || 0) + 1} · reciting yourself`
      : `${playing ? 'Reciting · ' : ''}Ayah ${pos.v} of ${c.n} · ${reciter().short}`;
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
      b.dataset.tip = `${c.tn} · ${c.n} ayahs`;
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
      b.dataset.tip = 'Pinch to open · swipe left or right to jump ten';
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
  applyMode();
  const ch = view.ch || (pos && pos.ch) || 1;
  const v = view.v || 1;
  const at = pos && pos.ch === ch && pos.v === v ? pos.w || 0 : 0;
  if (!cur || cur.ch !== ch || cur.v !== v) await moveTo(ch, v, playing && cur && cur.ch === ch, at);
  else drawAyah();
  focusFirst(view.focus && $(view.focus), reciting() ? 'textbox' : 'play');
}

// Shows ayah v of surah ch. While playing in the same surah the recitation jumps there too. In
// Recite myself, `at` words start gilded (-1: all of them, when stepping back from the next ayah).
async function moveTo(ch, v, keepPlaying, at = 0) {
  const surahChanged = !cur || cur.ch !== ch;
  cur = { ch, v };
  reciteAt = Math.max(0, at);
  hintStep = 0;
  ayahDone = false;
  savePos();
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
  const verse = currentVerse();
  if (at === -1) { reciteAt = verse.words.length; ayahDone = true; }
  reciteAt = Math.min(reciteAt, verse.words.length);
  savePos();
  drawAyah();
  if (!reciting() && !audioReady()) prepareAudio().catch(() => {});
  if (keepPlaying && playing && timing) {
    const tm = timing.t.get(v);
    if (tm) audio.currentTime = tm.from / 1000;
  }
}

function savePos() {
  if (!cur) return;
  pos = { ch: cur.ch, v: cur.v, w: reciting() ? reciteAt : 0 };
  save('qg.pos', pos);
}

function drawLoading(text) {
  const el = $('ayah');
  el.className = 'ayah loading';
  el.textContent = text || 'Loading…';
  spans = [];
  spanCls = [];
  $('gloss').textContent = '';
  $('meaning').textContent = '';
  drawTop();
}

function drawTop() {
  const c = cur && chapter(cur.ch);
  $('where').textContent = c ? `${c.id} ${c.en} · ${cur.v} of ${c.n}` : '';
  const verse = currentVerse();
  if (reciting()) {
    $('whoText').textContent = verse ? `${reciteAt} of ${verse.words.length} words${settings.memorise ? ' · memorise' : ''}` : '';
  } else {
    const extra = (settings.speed !== 1 ? ` · ${settings.speed}×` : '') + (settings.repeat !== 1 ? ` · ↻${settings.repeat === 0 ? '∞' : settings.repeat}` : '');
    $('whoText').textContent = reciter().short + extra;
  }
  $('liveDot').classList.toggle('live', playing && !reciting());
  shown($('playIcon'), !playing);
  shown($('pauseIcon'), playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  refreshTip();
}

function upcoming() {
  return settings.memorise ? 'w veiled' : 'w';
}

// Writes a word's class only when it changes, so a step redraws one or two words, not the ayah. A word
// that becomes gilded in a step (not a whole redraw) gets the light sweep.
function setCls(i, cls) {
  if (spanCls[i] === cls) return;
  const wasGilded = spanCls[i].includes('said');
  spans[i].className = cls;
  spanCls[i] = cls;
  if (!redrawing && !wasGilded && cls.includes('said')) sweep(spans[i]);
}

function drawAyah() {
  redrawing = true;
  try {
    drawAyahNow();
  } finally {
    redrawing = false;
  }
}

function drawAyahNow() {
  const verse = currentVerse();
  if (!verse) return;
  restComet();
  const el = $('ayah');
  el.className = 'ayah';
  el.textContent = '';
  spans = [];
  spanCls = [];
  verse.words.forEach((w, i) => {
    if (i) el.appendChild(document.createTextNode(' '));
    const s = document.createElement('span');
    s.dataset.p = String(w.p);
    s.textContent = w.ar;
    el.appendChild(s);
    spans.push(s);
    spanCls.push('');
  });
  if (verse.end) {
    el.appendChild(document.createTextNode(' '));
    const e = document.createElement('span');
    e.className = 'end';
    e.id = 'endMark';
    // U+06DD with the ayah number draws the ornamented end-of-ayah medallion (all three fonts).
    e.textContent = '۝' + verse.end;
    el.appendChild(e);
  }
  $('meaning').textContent = settings.meaning ? verse.meaning : '';
  shown($('meaning'), settings.meaning);
  $('gloss').textContent = '';
  shown($('gloss'), settings.gloss);
  if (reciting()) {
    paintRecite();
    showGloss(reciteAt > 0 ? verse.words[reciteAt - 1] : null);
  } else {
    const up = upcoming();
    spans.forEach((s, i) => setCls(i, up));
    litWord = -1;
    if (playing) highlight(audio.currentTime * 1000, true);
  }
  drawTop();
  fitAyah();
  keepInView();
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

// Keeps the word in play visible when a long ayah scrolls.
function keepInView() {
  const box = $('textbox');
  if (box.scrollHeight <= box.clientHeight) return;
  const i = reciting() ? Math.min(reciteAt, spans.length - 1) : litWord - 1;
  if (spans[i]) spans[i].scrollIntoView({ block: 'nearest' });
}

function showGloss(word, isNext) {
  const gloss = $('gloss');
  gloss.textContent = '';
  if (!word || !settings.gloss) return;
  const tr = document.createElement('span');
  tr.className = 'tr';
  tr.textContent = word.tr;
  gloss.append(...(isNext ? [document.createTextNode('Next: ')] : []), tr, document.createTextNode(`  ${word.en}`));
}

// Follow the reciter: everything before the word being said is gilded.
function highlight(t, force) {
  if (reciting()) return;
  const tm = timing && timing.t.get(cur.v);
  if (!tm || !tm.segs.length || !spans.length) return;
  let p = -1;
  for (const s of tm.segs) {
    if (s[1] <= t) p = s[0]; else break;
  }
  if (p === litWord && !force) return;
  const before = litWord;
  litWord = p;
  const up = upcoming();
  let from = null;
  let to = null;
  for (let i = 0; i < spans.length; i++) {
    const wp = Number(spans[i].dataset.p);
    if (wp === before) from = spans[i];
    if (wp === p) to = spans[i];
    setCls(i, wp < p ? 'w said' : wp === p ? 'w now' : up);
  }
  if (!force && before > 0 && p > before) trail(from, to);
  // The medallion gilds as the last word is said, with a few sparks: the ayah is complete while it is
  // still on screen.
  const end = $('endMark');
  const last = spans.length ? Number(spans[spans.length - 1].dataset.p) : -1;
  if (end) {
    end.classList.toggle('done', p === last);
    if (p === last && before !== last && !force) sparks(end);
  }
  keepInView();
  const verse = currentVerse();
  showGloss(verse && verse.words.find((w) => w.p === p));
}

// ---- Recite myself ----------------------------------------------------------------------------

function firstLetter(word) {
  let out = word.charAt(0);
  for (let i = 1; i < word.length && MARK.test(word.charAt(i)); i++) out += word.charAt(i);
  return out;
}

function paintRecite() {
  const verse = currentVerse();
  if (!verse || !spans.length) return;
  const up = upcoming();
  for (let i = 0; i < spans.length; i++) {
    let cls = up;
    if (i < reciteAt) cls = 'w said';
    else if (i === reciteAt) {
      if (settings.memorise && hintStep >= 2) cls = 'w hinted next';
      else if (settings.memorise && hintStep === 1) cls = 'w veiled next lettered';
      else cls = `${up} next`;
    }
    if (cls.includes('lettered')) spans[i].dataset.first = firstLetter(verse.words[i].ar);
    setCls(i, cls);
  }
  const end = $('endMark');
  if (end) end.classList.toggle('done', reciteAt >= verse.words.length);
}

function gildNext() {
  const verse = currentVerse();
  if (!verse) return;
  if (reciteAt >= verse.words.length) { nextReciteAyah(); return; }
  reciteAt++;
  hintStep = 0;
  note('word');
  paintRecite();
  trail(spans[reciteAt - 1], spans[reciteAt]);
  showGloss(verse.words[reciteAt - 1]);
  if (reciteAt === verse.words.length) finishAyah();
  savePos();
  drawTop();
  keepInView();
}

function undoWord() {
  const verse = currentVerse();
  if (!verse) return;
  if (reciteAt > 0) {
    reciteAt--;
    hintStep = 0;
    note('word', -1);
    paintRecite();
    showGloss(reciteAt > 0 ? verse.words[reciteAt - 1] : null);
    savePos();
    drawTop();
    keepInView();
    return;
  }
  if (cur.v > 1) moveTo(cur.ch, cur.v - 1, false, -1);
  else showToast('Start of the surah');
}

function finishAyah() {
  if (!ayahDone) {
    ayahDone = true;
    note('recited');
    sparks($('endMark'));
  }
  flashTip('Ayah complete · pinch for the next ayah');
}

function nextReciteAyah() {
  const c = chapter(cur.ch);
  if (c && cur.v < c.n) { moveTo(cur.ch, cur.v + 1, false, 0); return; }
  if (cur.ch < 114) {
    showToast(`${c ? c.en : 'Surah'} complete`);
    moveTo(cur.ch + 1, 1, false, 0);
  } else showToast('End of the Quran');
}

// Help when stuck, one step per press: in Memorise the first letter, then the word, then its sound;
// otherwise the word's reading and meaning, then its sound. Every step is counted as a hint.
function hint() {
  const verse = currentVerse();
  if (!verse || !reciting()) return;
  const w = verse.words[reciteAt];
  if (!w) { flashTip('Ayah complete · pinch for the next ayah'); return; }
  hintStep++;
  note('hint');
  const steps = settings.memorise ? ['letter', 'word', 'sound'] : ['word', 'sound'];
  const step = steps[Math.min(hintStep, steps.length) - 1];
  paintRecite();
  if (step !== 'letter') showGloss(w, true);
  if (step === 'sound') playWord(w);
  keepInView();
}

function playWord(w) {
  if (!w.au) { showToast('No audio for this word'); return; }
  wordAudio.src = WORD_AUDIO + w.au;
  wordAudio.play().catch(() => showToast('The word could not play'));
}

// ---- look: Arabic font and effects ---------------------------------------------------------------
// Effects run once on a change and stop: a light passing through each word as it is gilded, a soft
// streak from one word to the next, a few sparks when an ayah is complete. Nothing animates while the
// text is still, and nothing runs off screen.

function effects() {
  return REDUCED ? 'off' : settings.effects;
}

function applyEffects() {
  const fx = effects();
  for (const e of EFFECTS) document.documentElement.classList.toggle(`fx-${e}`, e === fx);
  if (fx !== 'full') stopEffects();
}

function applyScript() {
  const s = SCRIPTS.find((x) => x.id === settings.script) || SCRIPTS[0];
  document.documentElement.dataset.script = s.id;
  if (!document.fonts || !document.fonts.load) return;
  // Loading with Arabic sample text fetches the Arabic part of the font, not only its Latin part.
  document.fonts.load(`${s.weight} 44px "${s.family}"`, 'ٱلْحَمْدُ لِلَّهِ ۝١')
    .then(() => { if (view.screen === 'reader' && cur && settings.script === s.id) { fitAyah(); keepInView(); } })
    .catch(() => {});
}

function sweep(el) {
  if (effects() === 'off') return;
  el.classList.add('sweep');
  const done = () => el.classList.remove('sweep');
  el.addEventListener('animationend', done, { once: true });
  el.addEventListener('animationcancel', done, { once: true });
}

// The streak slides from the last word to the next one; a word on a new line takes it from its right,
// where reading comes from.
function trail(from, to) {
  if (effects() !== 'full' || !to || view.screen !== 'reader' || document.visibilityState !== 'visible') return;
  const box = $('textbox');
  const comet = $('comet');
  const b = box.getBoundingClientRect();
  const r = to.getBoundingClientRect();
  if (!r.width) return;
  const f = from && from.getBoundingClientRect();
  const sameLine = f && f.width && Math.abs(f.top - r.top) < r.height / 2;
  const dx = sameLine ? f.left + f.width / 2 - (r.left + r.width / 2) : r.width * 0.7;
  const s = comet.style;
  s.left = `${r.left - b.left + box.scrollLeft}px`;
  s.top = `${r.top - b.top + box.scrollTop}px`;
  s.width = `${r.width}px`;
  s.height = `${r.height}px`;
  for (const a of comet.getAnimations()) a.cancel();
  comet.animate([
    { opacity: 0.9, transform: `translateX(${dx}px) scaleX(1.7)` },
    { opacity: 0.55, transform: `translateX(${dx * 0.25}px) scaleX(1.2)`, offset: 0.45 },
    { opacity: 0, transform: 'translateX(0) scaleX(1)' },
  ], { duration: 420, easing: 'cubic-bezier(0.25, 0.5, 0.35, 1)' }).onfinish = restComet;
}

// Back to no size, so a streak left over from a long ayah never lengthens the next one's scroll area.
function restComet() {
  const comet = $('comet');
  for (const a of comet.getAnimations()) a.cancel();
  comet.style.cssText = '';
}

function sparks(el) {
  if (effects() !== 'full' || !el || view.screen !== 'reader' || document.visibilityState !== 'visible') return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  const canvas = $('fx');
  const c = canvas.getBoundingClientRect();
  if (!fxRaf) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(c.width * dpr);
    canvas.height = Math.round(c.height * dpr);
    fxLast = performance.now();
  }
  const x = r.left + r.width / 2 - c.left;
  const y = r.top + r.height / 2 - c.top;
  for (let i = 0; i < 18; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.7; // mostly upwards
    const v = 60 + Math.random() * 120;
    fxParts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 0.9 + Math.random() * 1.3, age: 0, life: 0.55 + Math.random() * 0.4 });
  }
  if (!fxRaf) fxRaf = requestAnimationFrame(fxFrame);
}

// One frame of sparks: each draws a short streak along its path (a little motion blur) with a faint
// glow, then fades. The loop ends with the last spark.
function fxFrame(now) {
  const canvas = $('fx');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const dt = Math.min(0.05, Math.max(0, (now - fxLast) / 1000));
  fxLast = now;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const p of fxParts) {
    p.age += dt;
    const drag = Math.max(0, 1 - 1.6 * dt);
    p.vx *= drag;
    p.vy = p.vy * drag + 70 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const k = Math.max(0, 1 - p.age / p.life);
    ctx.globalAlpha = k * 0.3;
    ctx.fillStyle = '#f4bf55';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = k;
    ctx.strokeStyle = '#fff1c4';
    ctx.lineWidth = p.r * 1.6;
    ctx.beginPath();
    ctx.moveTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  fxParts = fxParts.filter((p) => p.age < p.life);
  if (fxParts.length) fxRaf = requestAnimationFrame(fxFrame);
  else endSparks();
}

function endSparks() {
  if (fxRaf) cancelAnimationFrame(fxRaf);
  fxRaf = 0;
  fxParts = [];
  const canvas = $('fx');
  if (canvas.width) { canvas.width = 0; canvas.height = 0; } // clears it and frees its memory
}

function stopEffects() {
  endSparks();
  restComet();
}

// ---- modes -------------------------------------------------------------------------------------

function applyMode() {
  const r = reciting();
  $('play').hidden = r;
  $('hint').hidden = !r;
  $('textbox').tabIndex = r ? 0 : -1;
  shown($('modeListen'), !r);
  shown($('modeRecite'), r);
  $('mode').setAttribute('aria-label', r ? 'Follow the reciter instead' : 'Recite it yourself');
}

function setMode(m) {
  if (settings.mode === m) return;
  settings = { ...settings, mode: m };
  save('qg.settings', settings);
  if (m === 'recite' && playing) pause();
  hintStep = 0;
  applyMode();
  savePos();
  if (cur) drawAyah();
  if (m === 'listen' && cur && !audioReady()) prepareAudio().catch(() => {});
  if (view.screen === 'reader') focusFirst(m === 'recite' ? 'textbox' : 'play');
  showToast(m === 'recite' ? 'Recite yourself: pinch on each word you say' : 'Following the reciter');
}

// ---- playback --------------------------------------------------------------------------------

// The surah's timing is fetched and the audio pointed at its file as soon as a surah opens, so a
// pinch on Play reaches audio.play() at once: players often allow sound to start only from a press.
async function prepareAudio() {
  if (!cur) return null;
  const ch = cur.ch;
  const rid = settings.reciter;
  const t = await ensureTiming(rid, ch);
  if (!cur || cur.ch !== ch || settings.reciter !== rid) return null;
  timing = { ...t, ch, rid };
  if (audio.getAttribute('src') !== t.url) {
    audio.preload = 'metadata';
    audio.src = t.url;
  }
  return timing;
}

function audioReady() {
  return !!(timing && cur && timing.ch === cur.ch && timing.rid === settings.reciter && audio.getAttribute('src') === timing.url);
}

function play() {
  if (!cur || reciting()) return;
  if (audioReady()) { start(); return; }
  wantPlay = true;
  showToast('Getting the recitation ready…');
  prepareAudio()
    .then((t) => { if (t && wantPlay) start(); })
    .catch((e) => {
      wantPlay = false;
      showToast(e && e.message === 'not-recorded'
        ? `${reciter().short} has not recorded this surah. Pick another reciter in Options.`
        : 'Can’t load this recitation right now');
    });
}

function start() {
  wantPlay = false;
  const tm = timing.t.get(cur.v);
  if (!tm) { showToast('No timing for this ayah'); return; }
  audio.defaultPlaybackRate = settings.speed;
  audio.playbackRate = settings.speed;
  const now = audio.currentTime * 1000;
  if (!(now >= tm.from - 80 && now < tm.to - 80)) audio.currentTime = tm.from / 1000;
  playing = true;
  drawTop();
  loop();
  audio.play().catch((e) => {
    if (e && e.name === 'AbortError') return; // replaced by a newer request, such as another reciter
    playing = false;
    clearTimeout(loopTimer);
    loopTimer = 0;
    drawTop();
    // Blocked sound needs another press; anything else means the recording itself did not load.
    showToast(e && e.name === 'NotAllowedError' ? 'Pinch Play again to start the recitation' : 'This recording can’t be reached. Try another reciter in Options.');
  });
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
  if (!playing || !cur || !timing || reciting()) return;
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
    note('listened');
    const c = chapter(cur.ch);
    if (c && cur.v < c.n) {
      const next = cur.v + 1;
      if (verses.get(cur.ch)[next]) {
        cur = { ch: cur.ch, v: next };
        savePos();
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
    } else {
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

// ---- tips: every control says what it does when focus lands on it ---------------------------------
// The reader and home show tips on a line under their buttons. The list, Progress and Options show them
// in the header, where the tip stands in for the screen's own hint for a moment, then gives it back.

// Reader buttons whose meaning changes with the state; every other control carries data-tip.
const TIPS = {
  prevAyah: () => 'Previous ayah',
  play: () => (playing ? 'Pause' : 'Play the recitation'),
  hint: () => (settings.memorise ? 'Hint: first letter, then the word, then hear it' : 'Hint: the next word’s reading, then hear it'),
  nextAyah: () => 'Next ayah',
  mode: () => (reciting() ? 'Reciting yourself · pinch to follow the reciter' : 'Following the reciter · pinch to recite yourself'),
  readerOptions: () => 'Reciter, font, effects and more',
  textbox: () => 'Pinch or swipe right on each word you say · swipe left to undo',
};
const TIP_SLOT = { home: 'tip-home', list: 'tip-list', reader: 'tip', progress: 'tip-progress', options: 'tip-options' };

function tipText(el) {
  if (!el || !el.id) return '';
  if (TIPS[el.id]) return TIPS[el.id]();
  return el.dataset.tip || '';
}

function showTip(el) {
  clearTimeout(tipShow);
  clearTimeout(tipHide);
  const slot = $(TIP_SLOT[view.screen]);
  if (!slot) return;
  tipFor = tipText(el) ? el : null;
  if (!tipFor) { hideTip(slot); return; }
  tipShow = setTimeout(() => { if (tipFor === el) putTip(slot, tipText(el), slot.dataset.default ? 2600 : 2200); }, 160);
}

// A message in the reader's tip line, such as "Ayah complete".
function flashTip(text) {
  flashIn('tip', text, 2400);
}

function flashIn(id, text, ms) {
  clearTimeout(tipShow);
  tipFor = null;
  putTip($(id), text, ms);
}

// Shows a tip; with no time given it stays until it is replaced or hidden.
function putTip(slot, text, ms) {
  clearTimeout(tipHide);
  slot.textContent = text;
  slot.classList.add('on');
  if (ms) tipHide = setTimeout(() => hideTip(slot), ms);
}

function hideTip(slot) {
  slot.classList.remove('on');
  if (slot.dataset.default) slot.textContent = slot.dataset.default;
}

function clearTips() {
  clearTimeout(tipShow);
  clearTimeout(tipHide);
  tipFor = null;
  for (const slot of document.querySelectorAll('.tip, .headtip')) hideTip(slot);
}

function refreshTip() {
  if (tipFor && view.screen === 'reader' && $('tip').classList.contains('on')) $('tip').textContent = tipText(tipFor);
}

// ---- progress ---------------------------------------------------------------------------------

function minutes(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function progressRow(label, value, sub, fraction, tip) {
  const row = document.createElement('div');
  row.className = 'prow';
  row.tabIndex = 0;
  row.id = `prog-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  row.dataset.tip = tip || '';
  row.innerHTML = '<p class="lab"></p><p class="val"></p>';
  row.querySelector('.lab').textContent = label;
  row.querySelector('.val').textContent = value;
  if (sub) {
    const s = document.createElement('p');
    s.className = 'sub';
    s.textContent = sub;
    row.appendChild(s);
  }
  if (fraction != null) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.style.inlineSize = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
  }
  return row;
}

function renderProgress() {
  const body = $('progBody');
  body.textContent = '';
  const today = new Date().toDateString();
  const todays = progress.sessions.filter((s) => new Date(s.s).toDateString() === today);
  const sum = (k) => todays.reduce((a, s) => a + (s[k] || 0), 0);
  body.appendChild(progressRow(
    'Today',
    `${plural(sum('r'), 'ayah', 'ayahs')} recited yourself`,
    `${plural(sum('w'), 'word', 'words')} marked · ${plural(sum('h'), 'hint', 'hints')} · ${minutes(sum('a'))} reciting · ${plural(sum('l'), 'ayah', 'ayahs')} with the reciter`,
    null,
    'What you did today',
  ));
  if (pos && chapter(pos.ch)) {
    const c = chapter(pos.ch);
    let done = 0;
    const helped = [];
    for (let v = 1; v <= c.n; v++) {
      const a = progress.ayahs[`${c.id}:${v}`];
      if (a && a.r) done++;
      if (a && a.h) helped.push([v, a.h]);
    }
    helped.sort((x, y) => y[1] - x[1]);
    const help = helped.slice(0, 3).map(([v, h]) => `ayah ${v} (${plural(h, 'hint', 'hints')})`).join(', ');
    body.appendChild(progressRow(
      c.en,
      `${done} of ${c.n} ayahs recited yourself`,
      `You are at ayah ${pos.v}${pos.w ? `, word ${pos.w + 1}` : ''}${help ? ` · most hints: ${help}` : ''}`,
      done / c.n,
      'Your place in this surah and the ayahs you recited',
    ));
  }
  const t = progress.totals;
  body.appendChild(progressRow(
    'All time',
    `${plural(t.recited, 'ayah', 'ayahs')} recited yourself`,
    `${plural(t.words, 'word', 'words')} marked · ${plural(t.hints, 'hint', 'hints')} · ${minutes(t.activeMs)} reciting · ${plural(t.listened, 'ayah', 'ayahs')} with the reciter`,
    null,
    'Everything since you started',
  ));
  const recent = progress.sessions.slice(-4).reverse();
  if (recent.length) {
    const row = progressRow('Recent sessions', '', '', null, 'Your last four sessions');
    row.querySelector('.val').remove();
    const ol = document.createElement('ol');
    for (const s of recent) {
      const li = document.createElement('li');
      const when = new Date(s.s);
      const c = chapter(s.ch);
      li.textContent = `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · ${c ? c.en : 'Quran'} · ${plural(s.r, 'ayah', 'ayahs')} · ${minutes(s.a)} · ${plural(s.h, 'hint', 'hints')}`;
      ol.appendChild(li);
    }
    row.appendChild(ol);
    body.appendChild(row);
  }
  focusFirst(body.firstElementChild);
}

// ---- options ----------------------------------------------------------------------------------

const OPTIONS = [
  { k: 'mode', label: 'Mode', tip: 'Follow a reciter, or recite and pinch each word', values: ['listen', 'recite'], text: (v) => (v === 'recite' ? 'Recite myself' : 'Follow the reciter') },
  { k: 'reciter', label: 'Reciter', tip: 'Swipe to hear each reciter’s voice', values: RECITERS.map((r) => r.id), text: (v) => { const r = RECITERS.find((x) => x.id === v) || RECITERS[0]; return r.custom ? `${r.name} · aligned` : r.name; } },
  { k: 'repeat', label: 'Each ayah', tip: 'How many times each ayah plays', values: REPEATS, text: (v) => (v === 0 ? 'Repeat endlessly' : v === 1 ? 'Once' : `${v} times`) },
  { k: 'speed', label: 'Speed', tip: 'Speed of the recitation', values: SPEEDS, text: (v) => `${v}×` },
  { k: 'meaning', label: 'Meaning', tip: 'English meaning under the ayah', values: [true, false], text: (v) => (v ? 'Shown' : 'Hidden') },
  { k: 'gloss', label: 'Word meaning', tip: 'Reading and meaning of each word as it is said', values: [true, false], text: (v) => (v ? 'Shown' : 'Hidden') },
  { k: 'memorise', label: 'Memorise', tip: 'Each word stays hidden until it is recited', values: [false, true], text: (v) => (v ? 'Words appear as recited' : 'Off') },
  { k: 'size', label: 'Text size', tip: 'Size of the Arabic text', values: [0, 1], text: (v) => (v ? 'Medium' : 'Large') },
  { k: 'script', label: 'Arabic font', tip: 'Typeface of the Arabic, shown beside its name', values: SCRIPTS.map((s) => s.id), text: (v) => (SCRIPTS.find((s) => s.id === v) || SCRIPTS[0]).name },
  { k: 'effects', label: 'Effects', tip: 'Full: gold sweep, trail and sparks · Calm: sweep only', values: EFFECTS, text: (v) => (REDUCED ? 'Off · reduced motion' : { full: 'Full', calm: 'Calm', off: 'Off' }[v]) },
];
const RESET_TIP = 'Keeps your mode, your place and your progress';
const RESET_LIST = 'Alafasy · once · 1× · large Scheherazade · full effects';

function buildOptions() {
  const box = $('optRows');
  for (const o of OPTIONS) {
    const row = document.createElement('div');
    row.className = 'orow';
    row.id = `opt-${o.k}`;
    row.tabIndex = 0;
    row.dataset.k = o.k;
    row.dataset.tip = o.tip;
    row.setAttribute('role', 'slider');
    row.setAttribute('aria-label', `${o.label}. Swipe left or right to change.`);
    row.innerHTML = '<span class="lab"></span><span class="val"><span class="arrow" aria-hidden="true">‹</span><span class="v"></span><span class="arrow" aria-hidden="true">›</span></span>';
    row.querySelector('.lab').textContent = o.label;
    if (o.k === 'script') {
      // A word in the font itself, so the choice can be judged right here.
      const sample = document.createElement('span');
      sample.className = 'sample';
      sample.lang = 'ar';
      sample.dir = 'rtl';
      sample.textContent = 'ٱلْحَمْدُ لِلَّهِ';
      row.querySelector('.val').insertBefore(sample, row.querySelector('.val .arrow:last-child'));
    }
    box.appendChild(row);
  }
  const reset = document.createElement('div');
  reset.className = 'orow action';
  reset.id = 'opt-reset';
  reset.tabIndex = 0;
  reset.dataset.tip = RESET_TIP;
  reset.setAttribute('role', 'button');
  reset.innerHTML = '<span class="lab">Reset to best settings</span>';
  box.appendChild(reset);
  box.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.orow');
    if (!row || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Enter')) return;
    e.preventDefault();
    e.stopPropagation();
    if (row === reset) { if (e.key === 'Enter') pressReset(); return; }
    changeOption(row.dataset.k, e.key === 'ArrowLeft' ? -1 : 1);
  });
  box.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('.orow');
    if (!row || !e.detail) return;
    if (row === reset) pressReset(); else changeOption(row.dataset.k, 1);
  });
}

function changeOption(k, dir) {
  if (k === 'effects' && REDUCED) { flashIn('tip-options', 'Off: the system asks for reduced motion', 2600); return; }
  const o = OPTIONS.find((x) => x.k === k);
  const i = o.values.indexOf(settings[k]);
  const next = o.values[(Math.max(0, i) + dir + o.values.length) % o.values.length];
  if (k === 'mode') {
    setMode(next);
    renderOptions(true);
    return;
  }
  const before = settings[k];
  settings = { ...settings, [k]: next };
  save('qg.settings', settings);
  renderOptions(true);
  if (k === 'speed') audio.playbackRate = next;
  if (k === 'repeat') repeatLeft = next ? next - 1 : -1;
  if (k === 'reciter' && before !== next && !reciterChanged()) schedulePreview();
  if (k === 'script') applyScript();
  if (k === 'effects') applyEffects();
  if (cur && ['meaning', 'gloss', 'memorise', 'size'].includes(k)) drawAyah();
}

// A different recitation has its own audio file and timing. If it was playing, the new voice carries on
// at once (so no preview is needed); the answer says whether it was.
function reciterChanged() {
  const wasPlaying = playing;
  pause();
  timing = null;
  audio.removeAttribute('src');
  audio.load();
  if (wasPlaying) play();
  else if (!reciting()) prepareAudio().catch(() => {});
  return wasPlaying;
}

function renderOptions(keepFocus) {
  for (const o of OPTIONS) {
    const row = $(`opt-${o.k}`);
    const text = o.text(settings[o.k]);
    row.querySelector('.v').textContent = text;
    row.setAttribute('aria-valuetext', text);
  }
  if (!keepFocus) focusFirst(view.focus && $(view.focus), 'opt-mode');
}

// Reset asks for a second pinch within three seconds, and the header lists what it restores.
function pressReset() {
  const row = $('opt-reset');
  if (!resetArmed) {
    row.classList.add('armed');
    row.querySelector('.lab').textContent = 'Pinch again to reset';
    flashIn('tip-options', RESET_LIST, 3000);
    resetArmed = setTimeout(disarmReset, 3000);
    return;
  }
  disarmReset();
  resetSettings();
}

function disarmReset() {
  clearTimeout(resetArmed);
  resetArmed = 0;
  const row = $('opt-reset');
  if (!row) return;
  row.classList.remove('armed');
  row.querySelector('.lab').textContent = 'Reset to best settings';
}

// Settings only. The mode stays, since it is how the Quran is being followed right now (it has its own
// button in the reader), and so do the place in the Quran and the progress.
function resetSettings() {
  const before = settings;
  stopPreview();
  settings = { ...DEFAULTS, mode: before.mode };
  save('qg.settings', settings);
  audio.defaultPlaybackRate = settings.speed;
  audio.playbackRate = settings.speed;
  repeatLeft = settings.repeat ? settings.repeat - 1 : -1;
  if (before.reciter !== settings.reciter) reciterChanged();
  applyScript();
  applyEffects();
  if (cur) drawAyah();
  renderOptions(true);
  showToast('Best settings restored');
}

// ---- reciter preview ----------------------------------------------------------------------------
// Swiping through reciters plays about six seconds of each voice from the start of Al-Fatiha (or of the
// first surah a reciter recorded), which also starts soonest since the file plays from its beginning.
// It starts a moment after the swipes stop, ends where a word ends, and stops on leaving the reciter
// row or Options.

// Runs inside the swipe itself. Where sound may start only from a press, the swipe also unlocks the
// preview player (load() during a press does that, without playing anything), so the voice can start
// after the short wait.
function schedulePreview() {
  stopPreview();
  if (!previewUnlocked) previewAudio.load();
  clearTimeout(tipShow);
  putTip($('tip-options'), `Previewing ${reciter().name}`);
  previewNoted = true;
  previewTimer = setTimeout(previewReciter, 400);
  prefetchPreviews();
}

function previewSpot(r) {
  const chs = r.custom && r.custom.chapters.length ? r.custom.chapters : null;
  return { ch: !chs || chs.includes(1) ? 1 : chs[0], v: 1 };
}

// Where the preview ends, in ms: an ayah's end if one falls between 5.5 and 7.5 seconds, otherwise the
// first word's end after 5.5 seconds (running into the next ayah when the first is short).
function previewEnd(t, v) {
  const from = t.t.get(v).from;
  const want = from + 5500;
  const cap = from + 7500;
  for (let n = v; t.t.has(n); n++) {
    const tm = t.t.get(n);
    if (tm.to >= want && tm.to <= cap) return tm.to;
    for (const s of tm.segs) if (s[2] >= want) return Math.min(s[2] + 120, cap);
    if (tm.to > cap) return cap;
  }
  return cap;
}

async function previewReciter() {
  previewTimer = 0;
  const token = ++previewToken;
  const r = reciter();
  const spot = previewSpot(r);
  let t;
  try {
    t = await ensureTiming(r.id, spot.ch);
  } catch (e) {
    if (token === previewToken) previewFailed();
    return;
  }
  if (token !== previewToken || view.screen !== 'options' || settings.reciter !== r.id) return;
  const tm = t.t.get(spot.v);
  if (!tm) { previewFailed(); return; }
  previewStopAt = previewEnd(t, spot.v) / 1000;
  if (previewAudio.getAttribute('src') !== t.url) {
    previewAudio.preload = 'auto';
    previewAudio.src = t.url;
  }
  const begin = () => {
    if (token !== previewToken) return;
    previewAudio.currentTime = tm.from / 1000;
    previewAudio.volume = 1;
    previewAudio.play().then(() => {
      previewUnlocked = true;
      if (token !== previewToken) { previewAudio.pause(); return; }
      $('opt-reciter').classList.add('previewing');
      tickPreview();
    }).catch((e) => {
      if (token !== previewToken) return;
      if (e && e.name === 'NotAllowedError') {
        stopPreview();
        flashIn('tip-options', 'No preview: the glasses blocked the sound', 2600);
      } else previewFailed();
    });
  };
  if (previewAudio.readyState >= 1) begin();
  else previewAudio.addEventListener('loadedmetadata', begin, { once: true });
}

// Ends the preview on time with a short fade; it checks often only near the end.
function tickPreview() {
  clearTimeout(previewTick);
  if (previewAudio.paused) return;
  const left = previewStopAt - previewAudio.currentTime;
  if (left <= 0.02) { stopPreview(); return; }
  if (left < 0.25) previewAudio.volume = Math.max(0, left / 0.25);
  previewTick = setTimeout(tickPreview, left > 0.6 ? Math.min(250, (left - 0.4) * 1000) : 40);
}

function previewFailed() {
  stopPreview();
  flashIn('tip-options', 'No preview: the recording can’t be reached', 2600);
}

// Stops any preview, playing or still loading. Leaving Options also lets go of the file.
function stopPreview(release) {
  clearTimeout(previewTimer);
  clearTimeout(previewTick);
  previewTimer = 0;
  previewTick = 0;
  previewToken++;
  if (!previewAudio.paused) previewAudio.pause();
  previewAudio.volume = 1;
  if (release && previewAudio.getAttribute('src')) {
    previewAudio.removeAttribute('src');
    previewAudio.load();
  }
  const row = $('opt-reciter');
  if (row) row.classList.remove('previewing');
  if (previewNoted) {
    previewNoted = false;
    hideTip($('tip-options'));
  }
}

// The voices next to the current one are fetched ahead, so a swipe previews at once.
function prefetchPreviews() {
  const i = Math.max(0, RECITERS.findIndex((r) => r.id === settings.reciter));
  for (const d of [0, 1, -1]) {
    const r = RECITERS[(i + d + RECITERS.length) % RECITERS.length];
    ensureTiming(r.id, previewSpot(r).ch).catch(() => {});
  }
}

// ---- glasses battery ----------------------------------------------------------------------------
// Shown only when the browser reports it. Updates come from the battery's own events; nothing polls.
// Chromium answers "100%, charging, full now, never empties" when it has no battery data at all, so
// that exact answer hides the chip (a truly full battery on its charger looks the same, and loses
// nothing by hiding).

function watchBattery() {
  if (!navigator.getBattery) return;
  navigator.getBattery().then((b) => {
    const draw = () => {
      const unknown = b.level === 1 && b.charging && b.chargingTime === 0 && b.dischargingTime === Infinity;
      if (unknown) {
        for (const el of document.querySelectorAll('[data-batt]')) el.hidden = true;
        return;
      }
      const pct = Math.round(b.level * 100);
      const fill = Math.max(1.5, 13.5 * b.level);
      const bolt = b.charging ? '<path d="M10.6 1.6 6.4 6.6h2.9l-1.1 3.8 4.3-5.1H9.6z" fill="#000" stroke="#000" stroke-width="2.4" stroke-linejoin="round"/><path d="M10.6 1.6 6.4 6.6h2.9l-1.1 3.8 4.3-5.1H9.6z"/>' : '';
      for (const el of document.querySelectorAll('[data-batt]')) {
        el.innerHTML = `<svg viewBox="0 0 20 12" aria-hidden="true"><rect x="0.75" y="0.75" width="16.5" height="10.5" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="18.2" y="3.9" width="1.6" height="4.2" rx="0.8"/><rect x="2.25" y="2.25" width="${fill.toFixed(1)}" height="7.5" rx="1.1" opacity="${b.charging ? 0.55 : 1}"/>${bolt}</svg><span></span>`;
        el.lastChild.textContent = `${pct}%`;
        el.classList.toggle('charging', b.charging);
        el.classList.toggle('low', !b.charging && pct < 15);
        el.setAttribute('aria-label', `Glasses battery ${pct}%${b.charging ? ', charging' : ''}`);
        el.hidden = false;
      }
    };
    draw();
    for (const ev of ['levelchange', 'chargingchange', 'chargingtimechange', 'dischargingtimechange']) b.addEventListener(ev, draw);
  }).catch(() => {});
}

// ---- wiring -----------------------------------------------------------------------------------

function wire() {
  $('resume').addEventListener('click', () => { if (pos) openFrom('resume', { screen: 'reader', ch: pos.ch, v: pos.v }); });
  $('allSurahs').addEventListener('click', () => openFrom('allSurahs', { screen: 'list' }));
  $('homeProgress').addEventListener('click', () => openFrom('homeProgress', { screen: 'progress' }));
  $('homeOptions').addEventListener('click', () => openFrom('homeOptions', { screen: 'options' }));
  $('readerOptions').addEventListener('click', () => openFrom('readerOptions', { screen: 'options' }));
  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('hint').addEventListener('click', hint);
  $('prevAyah').addEventListener('click', () => stepAyah(-1));
  $('nextAyah').addEventListener('click', () => stepAyah(1));
  $('mode').addEventListener('click', () => setMode(reciting() ? 'listen' : 'recite'));

  // Recite myself: the text takes the pinches. Pinch or swipe right gilds the next word, swipe left
  // takes one back. Up and down still move between the text and the buttons.
  const box = $('textbox');
  box.addEventListener('keydown', (e) => {
    if (!reciting()) return;
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      gildNext();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      undoWord();
    }
  });
  box.addEventListener('click', (e) => { if (reciting() && e.detail) gildNext(); });

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
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return; // cleared on purpose (reciter change)
    if (playing) { pause(); showToast('The recitation stopped: connection problem'); }
    // Start over next time rather than retrying a file that failed.
    timing = null;
    audio.removeAttribute('src');
  });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* not supported here */ } };
    set('play', () => play());
    set('pause', () => pause());
    set('nexttrack', () => stepAyah(1));
    set('previoustrack', () => stepAyah(-1));
  }

  previewAudio.addEventListener('ended', () => stopPreview());
  previewAudio.addEventListener('pause', () => { const row = $('opt-reciter'); if (row) row.classList.remove('previewing'); });
  previewAudio.addEventListener('error', () => { if (previewAudio.getAttribute('src') && previewNoted) previewFailed(); });

  document.addEventListener('focusin', (e) => {
    showTip(e.target);
    if (e.target.id === 'opt-reciter') prefetchPreviews();
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.id === 'opt-reciter') stopPreview();
    if (e.target.id === 'opt-reset') disarmReset();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.screen !== 'home') { e.preventDefault(); history.back(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (playing) loop(); return; }
    stopPreview();
    stopEffects();
  });
  window.addEventListener('popstate', onPopState);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* optional */ }
}

async function main() {
  history.replaceState({ screen: 'home' }, '');
  applyScript();
  applyEffects();
  wire();
  buildOptions();
  extraReady = loadExtraReciters().then(() => {
    // A reciter that is no longer offered falls back to the recommended one.
    if (RECITERS.some((r) => r.id === settings.reciter)) return;
    settings = { ...settings, reciter: DEFAULTS.reciter };
    save('qg.settings', settings);
    if (view.screen === 'options') renderOptions(true);
  });
  applyMode();
  render({ screen: 'home' });
  registerServiceWorker();
  watchBattery();
  try {
    await ensureChapters();
    if (view.screen === 'home') render({ ...view });
  } catch (e) {
    $('homeNote').textContent = 'Can’t reach Quran.com';
  }
}

main();
