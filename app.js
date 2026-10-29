'use strict';

const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSrZ3P8xU1MVKV9gd-mAVXCs2Qkgg7HcndbL_d-fD27wKP6Jp9s_qi5rsIkA83QQ0lng7YPsrLP9O1e/pub?gid=846289908&single=true&output=csv';

const KEYS = { cache: 'vt-cache-v1', progress: 'vt-progress-v1', settings: 'vt-settings-v1' };
const INTERVALS = [0, 1, 3, 7, 14]; // Wiederholungsabstand in Tagen für Fach 1–5
const MAX_BOX = INTERVALS.length;
const NEW_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

const state = {
  words: [],
  progress: loadJSON(KEYS.progress, {}),
  settings: { view: 'list', area: '', scope: 'all', dir: 'en-de', ...loadJSON(KEYS.settings, {}) },
  session: null,
};

const $ = (sel) => document.querySelector(sel);

// ---------- Hilfsfunktionen ----------

function loadJSON(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Speicher voll oder gesperrt – App funktioniert trotzdem weiter
  }
}

// Baut DOM-Elemente; Texte werden immer als Textknoten eingefügt (kein innerHTML).
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false && child !== '') node.append(child);
  }
  return node;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseDate(text) {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) return new Date(+m[1], m[2] - 1, +m[3]).getTime();
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
  if (m) return new Date(+m[3], m[2] - 1, +m[1]).getTime();
  return null;
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function makeId(vocab) {
  return vocab.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------- Sprachausgabe ----------

const canSpeak = 'speechSynthesis' in window;

function speak(text) {
  if (!canSpeak) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.replace(/\([^)]*\)/g, ' '));
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === 'en-GB') || voices.find((v) => v.lang.startsWith('en'));
  if (voice) utterance.voice = voice;
  utterance.lang = voice ? voice.lang : 'en-GB';
  utterance.rate = 0.95;
  speechSynthesis.speak(utterance);
}

function speakButton(text) {
  if (!canSpeak) return null;
  return el('button', {
    type: 'button',
    class: 'speak',
    title: 'Vorlesen',
    'aria-label': 'Vorlesen',
    onclick: (e) => { e.stopPropagation(); e.preventDefault(); speak(text); },
  }, '🔊');
}

// ---------- Daten laden ----------

function parseCsv(text) {
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.replace(/^﻿/, '').trim().normalize('NFC'),
    transform: (v) => v.trim(),
  });
  if (!result.meta.fields || !result.meta.fields.includes('Vokabel')) {
    throw new Error('Die Tabelle hat nicht das erwartete Format (Spalte „Vokabel“ fehlt).');
  }
  const seen = new Set();
  const words = [];
  for (const row of result.data) {
    if (!row.Vokabel) continue;
    const id = makeId(row.Vokabel);
    if (seen.has(id)) continue;
    seen.add(id);
    words.push({
      id,
      en: row.Vokabel,
      pos: row.Wortart || '',
      de: row.Deutsch || '',
      area: row.Bereich || '',
      expl: row['Erklärung'] || '',
      example: row.Beispielsatz || '',
      dateRaw: row.Datum || '',
      date: parseDate(row.Datum || ''),
    });
  }
  // Neueste zuerst
  return words.sort((a, b) => (b.date || 0) - (a.date || 0));
}

async function loadWords() {
  state.session = null;
  showNotice(null);
  $('#main').replaceChildren(el('div', { class: 'state' }, el('div', { class: 'spinner' }), 'Vokabeln werden geladen …'));

  if (typeof Papa === 'undefined') {
    showError(new Error('Der CSV-Parser (PapaParse) konnte nicht geladen werden. Bitte Internetverbindung prüfen.'));
    return;
  }

  try {
    // Zeitstempel + no-store, damit garantiert die aktuelle Version kommt
    const res = await fetch(`${CSV_URL}&t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Server antwortet mit Status ${res.status}.`);
    const text = await res.text();
    const words = parseCsv(text);
    if (!words.length) throw new Error('In der Tabelle wurden keine Vokabeln gefunden.');
    const loadedAt = Date.now();
    saveJSON(KEYS.cache, { text, time: loadedAt });
    setWords(words, loadedAt);
  } catch (err) {
    const cache = loadJSON(KEYS.cache, null);
    if (cache) {
      try {
        setWords(parseCsv(cache.text), cache.time);
        showNotice(`Die aktuelle Liste konnte nicht geladen werden (${err.message}). Angezeigt wird die gespeicherte Liste vom ${formatDateTime(cache.time)}.`);
        return;
      } catch {
        // Cache unbrauchbar – Fehler unten anzeigen
      }
    }
    showError(err);
  }
}

function setWords(words, loadedAt) {
  state.words = words;
  $('#loaded-at').textContent = `${words.length} Vokabeln · geladen ${formatDateTime(loadedAt)}`;
  fillSelect($('#f-area'), words.map((w) => w.area), 'area');
  fillSelect($('#f-pos'), words.map((w) => w.pos));
  render();
}

function fillSelect(select, values, settingKey) {
  const unique = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const current = settingKey ? state.settings[settingKey] : select.value;
  select.replaceChildren(select.options[0], ...unique.map((v) => el('option', { value: v }, v)));
  select.value = unique.includes(current) ? current : '';
  if (settingKey) state.settings[settingKey] = select.value;
}

function showError(err) {
  $('#main').replaceChildren(el('div', { class: 'state error' },
    el('p', {}, 'Die Vokabeln konnten nicht geladen werden.'),
    el('p', { class: 'small' }, err.message),
    location.protocol === 'file:' && el('p', { class: 'small' },
      'Hinweis: Google blockiert das Laden, wenn die Seite per Doppelklick als Datei geöffnet wird. ',
      'Starte die App stattdessen mit „start.bat“ (oder über GitHub Pages).'),
    el('button', { type: 'button', class: 'btn primary', onclick: loadWords }, 'Erneut versuchen'),
  ));
}

function showNotice(text) {
  const notice = $('#notice');
  notice.hidden = !text;
  notice.textContent = text || '';
}

// ---------- Lernfortschritt (Karteikasten) ----------

function isDue(word) {
  const p = state.progress[word.id];
  return !p || p.due <= Date.now();
}

function isNew(word) {
  return word.date != null && startOfToday() - word.date < NEW_DAYS * DAY;
}

function record(word, correct) {
  const p = state.progress[word.id] || { box: 0 };
  const box = correct ? Math.min(Math.max(p.box, 1) + 1, MAX_BOX) : 1;
  state.progress[word.id] = { box, due: startOfToday() + INTERVALS[box - 1] * DAY, last: Date.now() };
  saveJSON(KEYS.progress, state.progress);
  renderStats();
}

function boxLabel(word) {
  const p = state.progress[word.id];
  return p ? `Fach ${p.box}/${MAX_BOX}` : 'noch nicht geübt';
}

function renderStats() {
  const due = state.words.filter(isDue).length;
  const mastered = state.words.filter((w) => state.progress[w.id]?.box === MAX_BOX).length;
  $('#stats').replaceChildren(
    el('span', {}, el('b', {}, String(state.words.length)), ' gesamt'),
    el('span', {}, el('b', {}, String(due)), ' fällig'),
    el('span', {}, el('b', {}, String(mastered)), ' gemeistert'),
  );
}

// ---------- Filter ----------

function filteredWords() {
  const { area, scope } = state.settings;
  return state.words.filter((w) =>
    (!area || w.area === area) &&
    (scope === 'all' || (scope === 'due' ? isDue(w) : isNew(w))));
}

function saveSettings() {
  saveJSON(KEYS.settings, state.settings);
}

// ---------- Rendering ----------

function render() {
  const { view } = state.settings;
  document.body.dataset.view = view;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  renderStats();
  if (!state.words.length) return;
  $('#main').replaceChildren(view === 'list' ? renderList() : renderLearn());
}

function renderDetails(w) {
  return el('div', { class: 'details' },
    el('div', { class: 'detail-head' }, el('span', { class: 'word', lang: 'en' }, w.en), speakButton(w.en)),
    el('div', { class: 'de' }, w.de),
    el('div', { class: 'meta' }, [w.pos, w.area].filter(Boolean).join(' · ')),
    w.expl && el('p', { class: 'expl' }, w.expl),
    w.example && el('blockquote', { class: 'example', lang: 'en' }, w.example, speakButton(w.example)),
  );
}

function renderList() {
  const query = $('#f-search').value.trim().toLowerCase();
  const pos = $('#f-pos').value;
  const words = filteredWords().filter((w) =>
    (!pos || w.pos === pos) &&
    (!query || [w.en, w.de, w.expl, w.example, w.area].some((t) => t.toLowerCase().includes(query))));

  if (!words.length) return el('div', { class: 'state' }, 'Keine Vokabeln für diese Auswahl.');

  return el('div', { class: 'list' },
    el('p', { class: 'count' }, `${words.length} ${words.length === 1 ? 'Vokabel' : 'Vokabeln'}`),
    words.map((w) => el('details', { class: 'item' },
      el('summary', {},
        el('span', { class: 'word', lang: 'en' }, w.en),
        isNew(w) && el('span', { class: 'badge new' }, 'Neu'),
        el('span', { class: 'de' }, w.de),
        el('span', { class: 'box' }, boxLabel(w)),
      ),
      renderDetails(w),
      w.dateRaw && el('p', { class: 'date' }, `Hinzugefügt: ${w.dateRaw}`),
    )),
  );
}

// ---------- Lernmodi ----------

function startSession(queue = shuffle(filteredWords())) {
  state.session = { view: state.settings.view, queue, index: 0, correct: 0, wrong: [], keys: {} };
  resetQuestion(state.session);
}

function resetQuestion(s) {
  Object.assign(s, { flipped: false, answered: false, choice: null, options: null, typed: '', result: null, keys: {} });
}

function nextQuestion() {
  const s = state.session;
  s.index++;
  resetQuestion(s);
  render();
}

function answer(word, correct) {
  const s = state.session;
  record(word, correct);
  if (correct) s.correct++;
  else s.wrong.push(word);
}

function renderLearn() {
  if (!state.session || state.session.view !== state.settings.view) startSession();
  const s = state.session;

  if (!s.queue.length) return renderEmpty();
  if (s.index >= s.queue.length) return renderSummary(s);

  const word = s.queue[s.index];
  const body = { cards: renderCard, quiz: renderQuiz, write: renderWrite }[s.view](s, word);
  return el('div', { class: 'learn' },
    el('div', { class: 'progress' },
      el('span', {}, `${s.index + 1} / ${s.queue.length}`),
      el('div', { class: 'bar' }, el('div', { style: `width:${(s.index / s.queue.length) * 100}%` })),
    ),
    body,
  );
}

function renderEmpty() {
  const { scope } = state.settings;
  const text = scope === 'due' ? 'Für heute ist nichts mehr fällig – gut gemacht! 🎉'
    : scope === 'new' ? `Keine neuen Vokabeln in den letzten ${NEW_DAYS} Tagen.`
    : 'Keine Vokabeln für diese Auswahl.';
  return el('div', { class: 'state' },
    el('p', {}, text),
    scope !== 'all' && el('button', { type: 'button', class: 'btn primary', onclick: () => setScope('all') }, 'Alle Vokabeln üben'),
  );
}

function renderSummary(s) {
  const total = s.queue.length;
  const again = el('button', { type: 'button', class: 'btn primary', onclick: () => { startSession(); render(); } }, 'Neue Runde');
  setTimeout(() => again.focus());
  return el('div', { class: 'state summary' },
    el('h2', {}, 'Runde beendet'),
    el('p', { class: 'score' }, `${s.correct} von ${total} richtig`),
    el('div', { class: 'actions' },
      s.wrong.length > 0 && el('button', { type: 'button', class: 'btn', onclick: () => { startSession(shuffle(s.wrong)); render(); } },
        `Fehler wiederholen (${s.wrong.length})`),
      again,
    ),
  );
}

function wordPrompt(w, showEnglish) {
  return el('div', { class: 'prompt' },
    el('div', { class: 'prompt-word' },
      showEnglish ? [el('span', { class: 'word', lang: 'en' }, w.en), speakButton(w.en)] : el('span', { class: 'word' }, w.de)),
    el('div', { class: 'meta' }, [w.pos, w.area].filter(Boolean).join(' · ')),
  );
}

// Karteikarten
function renderCard(s, w) {
  const actions = el('div', { class: 'actions' });
  const card = el('div', {
    class: 'flashcard',
    tabindex: 0,
    role: 'button',
    'aria-label': 'Karte umdrehen',
    onclick: () => flip(),
  }, el('div', { class: 'inner' },
    el('div', { class: 'face front' },
      wordPrompt(w, state.settings.dir === 'en-de'),
      el('p', { class: 'hint' }, 'Tippen oder Leertaste zum Umdrehen')),
    el('div', { class: 'face back' }, renderDetails(w)),
  ));

  const rate = (correct) => { answer(w, correct); nextQuestion(); };

  function flip() {
    s.flipped = !s.flipped;
    card.classList.toggle('flipped', s.flipped);
    if (s.flipped && !actions.querySelector('.rate')) {
      actions.replaceChildren(
        el('button', { type: 'button', class: 'btn wrong rate', onclick: () => rate(false) }, 'Nicht gewusst', el('kbd', {}, '1')),
        el('button', { type: 'button', class: 'btn right rate', onclick: () => rate(true) }, 'Gewusst', el('kbd', {}, '2')),
      );
    }
  }

  actions.append(el('button', { type: 'button', class: 'btn primary', onclick: flip }, 'Umdrehen'));
  s.keys = {
    ' ': flip,
    Enter: flip,
    1: () => s.flipped && rate(false),
    2: () => s.flipped && rate(true),
  };
  return el('div', {}, card, actions);
}

// Quiz (Multiple Choice)
function quizOptions(w, field) {
  // Ablenker bevorzugt aus demselben Bereich, damit es nicht zu leicht wird
  const others = shuffle(state.words.filter((o) => o.id !== w.id && o[field] && o[field] !== w[field]))
    .sort((a, b) => (b.area === w.area) - (a.area === w.area));
  const picks = [];
  for (const o of others) {
    if (picks.length === 3) break;
    if (!picks.some((p) => p[field] === o[field])) picks.push(o);
  }
  return shuffle([w, ...picks]);
}

function renderQuiz(s, w) {
  if (state.words.length < 2) return el('div', { class: 'state' }, 'Für das Quiz werden mindestens zwei Vokabeln benötigt.');
  const enFirst = state.settings.dir === 'en-de';
  const field = enFirst ? 'de' : 'en';
  if (!s.options) s.options = quizOptions(w, field);

  const choose = (i) => {
    if (s.answered || !s.options[i]) return;
    s.answered = true;
    s.choice = i;
    answer(w, s.options[i] === w);
    render();
  };

  const options = el('div', { class: 'options' }, s.options.map((o, i) => {
    let cls = 'option';
    if (s.answered) {
      if (o === w) cls += ' right';
      else if (i === s.choice) cls += ' wrong';
    }
    return el('button', { type: 'button', class: cls, disabled: s.answered, onclick: () => choose(i), lang: enFirst ? null : 'en' },
      el('kbd', {}, String(i + 1)), o[field]);
  }));

  s.keys = Object.fromEntries(s.options.map((_, i) => [String(i + 1), () => choose(i)]));

  const parts = [wordPrompt(w, enFirst), options];
  if (s.answered) {
    const correct = s.options[s.choice] === w;
    const next = el('button', { type: 'button', class: 'btn primary', onclick: nextQuestion }, 'Weiter');
    setTimeout(() => next.focus());
    parts.push(
      el('p', { class: `feedback ${correct ? 'right' : 'wrong'}` }, correct ? 'Richtig!' : 'Leider falsch.'),
      renderDetails(w),
      el('div', { class: 'actions' }, next),
    );
  }
  return el('div', { class: 'panel' }, parts);
}

// Schreiben
function normalizeAnswer(text) {
  return text.toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\([^)]*\)/g, ' ')          // Klammerzusätze wie „(for sth.)“ ignorieren
    .replace(/[^a-z0-9äöüß']+/g, ' ')   // Bindestriche, Punkte usw. → Leerzeichen
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^to /, '');                // „to“ bei Verben optional
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function checkTyped(input, solution) {
  const given = normalizeAnswer(input);
  const variants = [solution, ...solution.split(/[/;]/)].map(normalizeAnswer).filter(Boolean);
  if (variants.includes(given)) return 'exact';
  const tolerance = (v) => (v.length >= 12 ? 2 : v.length >= 5 ? 1 : 0);
  if (variants.some((v) => levenshtein(v, given) <= tolerance(v))) return 'close';
  return 'wrong';
}

function renderWrite(s, w) {
  const input = el('input', {
    type: 'text', class: 'answer', lang: 'en', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'Englische Vokabel eingeben …', disabled: s.answered, 'aria-label': 'Antwort',
  });
  input.value = s.typed;

  const submit = (giveUp) => {
    if (s.answered) return;
    if (!giveUp && !input.value.trim()) { input.focus(); return; }
    s.typed = input.value;
    s.result = giveUp ? 'wrong' : checkTyped(input.value, w.en);
    s.answered = true;
    answer(w, s.result !== 'wrong');
    render();
  };

  const form = el('form', {
    class: 'write-form',
    onsubmit: (e) => { e.preventDefault(); if (s.answered) nextQuestion(); else submit(false); },
  }, input);

  if (!s.answered) {
    form.append(el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => submit(true) }, 'Weiß nicht'),
      el('button', { type: 'submit', class: 'btn primary' }, 'Prüfen'),
    ));
    setTimeout(() => input.focus());
    s.keys = {};
    return el('div', { class: 'panel' }, wordPrompt(w, false), form);
  }

  const messages = {
    exact: ['right', 'Richtig!'],
    close: ['right', 'Fast richtig – achte auf die Schreibweise.'],
    wrong: ['wrong', s.typed.trim() ? 'Leider falsch.' : 'Hier die Lösung:'],
  };
  const [cls, text] = messages[s.result];
  input.classList.add(cls);
  const next = el('button', { type: 'submit', class: 'btn primary' }, 'Weiter');
  form.append(el('div', { class: 'actions' }, next));
  setTimeout(() => next.focus());
  s.keys = {};
  return el('div', { class: 'panel' },
    wordPrompt(w, false),
    form,
    el('p', { class: `feedback ${cls}` }, text),
    renderDetails(w),
  );
}

// ---------- Events ----------

function setScope(scope) {
  state.settings.scope = scope;
  $('#f-scope').value = scope;
  saveSettings();
  state.session = null;
  render();
}

function setupEvents() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    state.settings.view = b.dataset.view;
    state.session = null;
    saveSettings();
    render();
  }));

  const area = $('#f-area');
  area.addEventListener('change', () => { state.settings.area = area.value; saveSettings(); state.session = null; render(); });
  const scope = $('#f-scope');
  scope.value = state.settings.scope;
  scope.addEventListener('change', () => setScope(scope.value));
  const dir = $('#f-dir');
  dir.value = state.settings.dir;
  dir.addEventListener('change', () => { state.settings.dir = dir.value; saveSettings(); state.session = null; render(); });
  $('#f-pos').addEventListener('change', render);
  $('#f-search').addEventListener('input', render);

  $('#btn-reload').addEventListener('click', loadWords);
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Gesamten Lernfortschritt wirklich löschen?')) return;
    state.progress = {};
    saveJSON(KEYS.progress, state.progress);
    state.session = null;
    render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : document.body;
    if (target.closest('input, select, textarea')) return;
    // Auf fokussierten Buttons lösen Enter/Leertaste ohnehin einen Klick aus
    if ((e.key === 'Enter' || e.key === ' ') && target.closest('button, summary')) return;
    const handler = state.session?.keys?.[e.key];
    if (state.settings.view !== 'list' && handler) {
      e.preventDefault();
      handler();
    }
  });
}

setupEvents();
render();
loadWords();
