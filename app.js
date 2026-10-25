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

const audio = $('audio');
const wordAudio = $('wordAudio');
let settings = load('qg.settings', { reciter: 7, repeat: 1, speed: 1, meaning: true, gloss: true, memorise: false, size: 0, mode: 'listen' });
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

// Writes a word's class only when it changes, so a step redraws one or two words, not the ayah.
function setCls(i, cls) {
  if (spanCls[i] !== cls) {
    spans[i].className = cls;
    spanCls[i] = cls;
  }
}

function drawAyah() {
  const verse = currentVerse();
  if (!verse) return;
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
    // U+06DD with the ayah number draws the ornamented end-of-ayah medallion in Amiri Quran.
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
  litWord = p;
  const up = upcoming();
  for (let i = 0; i < spans.length; i++) {
    const wp = Number(spans[i].dataset.p);
    setCls(i, wp < p ? 'w said' : wp === p ? 'w now' : up);
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
    .catch(() => { wantPlay = false; showToast('Can’t load this recitation right now'); });
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
  audio.play().catch(() => {
    playing = false;
    clearTimeout(loopTimer);
    loopTimer = 0;
    drawTop();
    showToast('Pinch Play again to start the recitation');
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

// ---- button names in the reader ----------------------------------------------------------------

const TIPS = {
  prevAyah: () => 'Previous ayah',
  play: () => (playing ? 'Pause' : 'Play the recitation'),
  hint: () => (settings.memorise ? 'Hint: first letter, then the word, then hear it' : 'Hint: the next word’s reading, then hear it'),
  nextAyah: () => 'Next ayah',
  mode: () => (reciting() ? 'Reciting yourself · pinch to follow the reciter' : 'Following the reciter · pinch to recite yourself'),
  readerOptions: () => 'Reciter, repeat, speed and more',
  textbox: () => 'Pinch or swipe right on each word you say · swipe left to undo',
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

function flashTip(text) {
  const tip = $('tip');
  clearTimeout(tipShow);
  clearTimeout(tipHide);
  tipFor = null;
  tip.textContent = text;
  tip.classList.add('on');
  tipHide = setTimeout(() => tip.classList.remove('on'), 2400);
}

function refreshTip() {
  if (tipFor && $('tip').classList.contains('on')) $('tip').textContent = TIPS[tipFor]();
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

function progressRow(label, value, sub, fraction) {
  const row = document.createElement('div');
  row.className = 'prow';
  row.tabIndex = 0;
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
    ));
  }
  const t = progress.totals;
  body.appendChild(progressRow(
    'All time',
    `${plural(t.recited, 'ayah', 'ayahs')} recited yourself`,
    `${plural(t.words, 'word', 'words')} marked · ${plural(t.hints, 'hint', 'hints')} · ${minutes(t.activeMs)} reciting · ${plural(t.listened, 'ayah', 'ayahs')} with the reciter`,
  ));
  const recent = progress.sessions.slice(-4).reverse();
  if (recent.length) {
    const row = progressRow('Recent sessions', '', '');
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
  { k: 'mode', label: 'Mode', values: ['listen', 'recite'], text: (v) => (v === 'recite' ? 'Recite myself' : 'Follow the reciter') },
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
  if (k === 'reciter' && before !== next) {
    // A different recitation has its own audio file and timing.
    const wasPlaying = playing;
    pause();
    timing = null;
    audio.removeAttribute('src');
    audio.load();
    if (wasPlaying) play();
    else if (!reciting()) prepareAudio().catch(() => {});
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
  if (!keepFocus) focusFirst(view.focus && $(view.focus), 'opt-mode');
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

  document.addEventListener('focusin', (e) => { if (view.screen === 'reader') showTip(e.target); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.screen !== 'home') { e.preventDefault(); history.back(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && playing) loop(); });
  window.addEventListener('popstate', onPopState);
  if (document.fonts && document.fonts.load) {
    document.fonts.load('44px "Amiri Quran"').then(() => { if (view.screen === 'reader' && cur) { fitAyah(); keepInView(); } }).catch(() => {});
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
  applyMode();
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
