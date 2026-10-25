/* ==========================================================================
   News Deck — glanceable UK news for 600×600 smart-glasses displays

   Data comes from /api/news (api/news.js on Vercel). No keys live here.
   Add ?demo to the URL (or open the file locally) for sample stories.

   Input: focus-first spatial navigation. Swipes arrive as arrow keys and a
   pinch as Enter; adjust CONFIG.keys if your runtime sends something else.
   ========================================================================== */
(() => {
  'use strict';

  // Tabs shown before the first load. After that, the list comes from the
  // server (SECTIONS in api/news.js), so new topics only need adding there.
  const DEFAULT_SECTIONS = [
    { key: 'top', label: 'Top' },
    { key: 'uk', label: 'UK' },
    { key: 'local', label: 'Surrey' },
    { key: 'world', label: 'World' },
    { key: 'tech', label: 'Tech' },
    { key: 'gaming', label: 'Gaming' },
  ];
  const SECTIONS_STORE = 'newsdeck-sections-v1';
  let SECTIONS = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SECTIONS_STORE));
      if (Array.isArray(saved) && saved.length) return saved;
    } catch { /* storage unavailable */ }
    return DEFAULT_SECTIONS;
  })();

  const CONFIG = {
    endpoint: '/api/news',
    staleMs: 10 * 60 * 1000, // refetch a section if older than this
    tabFocusDelay: 280,      // ms a tab must stay focused before it loads
    voiceLang: 'en-GB',
    keys: {
      up: ['ArrowUp'],
      down: ['ArrowDown'],
      left: ['ArrowLeft'],
      right: ['ArrowRight'],
      select: ['Enter', ' ', 'NumpadEnter', 'Select'],
      back: ['Escape', 'Backspace', 'GoBack', 'BrowserBack'],
    },
  };

  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo') || location.protocol === 'file:';
  const STORE = 'newsdeck-cache-v1';

  // Optional app key (only needed if APP_KEY is set in Vercel): taken from
  // ?key= once, then remembered on this device and hidden from the address bar.
  const APP_KEY = (() => {
    const fromUrl = params.get('key');
    let key = fromUrl || '';
    try {
      if (fromUrl) localStorage.setItem('newsdeck-app-key', fromUrl);
      else key = localStorage.getItem('newsdeck-app-key') || '';
    } catch { /* storage unavailable */ }
    if (fromUrl) history.replaceState(null, '', location.pathname);
    return key;
  })();

  const $ = (s) => document.querySelector(s);
  const dom = {
    title: $('#viewTitle'), sub: $('#viewSub'), back: $('#backBtn'),
    dot: $('#statusDot'), statusText: $('#statusText'), clock: $('#clock'),
    tabs: $('#tabs'), list: $('#list'), toast: $('#toast'),
    viewList: $('#view-list'), viewStory: $('#view-story'),
    meta: $('#storyMeta'), storyTitle: $('#storyTitle'), summary: $('#storySummary'),
    prev: $('#prevBtn'), speak: $('#speakBtn'), next: $('#nextBtn'),
  };

  const state = {
    section: 'top',
    view: 'list',
    cache: loadCache(), // { [section]: { data, at } }
    storyIndex: 0,
    listFocusKey: null,
    loading: null,
    speakingId: null,
  };

  /* ---------------------------------------------------------------------
     Data
     --------------------------------------------------------------------- */
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }
  function saveCache() {
    try { localStorage.setItem(STORE, JSON.stringify(state.cache)); } catch { /* full or blocked */ }
  }

  async function fetchSection(key) {
    if (DEMO) { await new Promise((r) => setTimeout(r, 250)); return demoData(key); }
    const res = await fetch(`${CONFIG.endpoint}?section=${encodeURIComponent(key)}`, {
      headers: APP_KEY ? { 'X-App-Key': APP_KEY } : {},
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error(APP_KEY ? 'App key is wrong' : 'Open with ?key=… to connect');
    if (!res.ok) {
      if (res.status === 404) syncSections(data.sections); // section was removed on the server
      throw new Error(data.error || `News request failed (${res.status})`);
    }
    return data;
  }

  async function loadSection(key, { force = false } = {}) {
    const cached = state.cache[key];
    const fresh = cached && Date.now() - cached.at < CONFIG.staleMs;
    if (cached) { syncSections(cached.data.sections); renderList(key); }
    if (fresh && !force) { setStatus(DEMO ? 'demo' : 'live', cached); return; }

    const token = Symbol(key);
    state.loading = token;
    setStatus('loading');
    try {
      const data = await fetchSection(key);
      syncSections(data.sections);
      state.cache[key] = { data, at: Date.now() };
      saveCache();
      if (data.failed?.length) toast(`Couldn’t reach ${data.failed.join(', ')}`, true);
      if (state.loading === token && state.section === key) {
        renderList(key);
        setStatus(DEMO ? 'demo' : 'live', state.cache[key]);
      }
    } catch (err) {
      console.error(err);
      if (state.section !== key) return;
      if (cached) { setStatus('cached', cached); toast('Offline — showing saved news', true); }
      else { setStatus('offline'); renderError(err); }
    } finally {
      if (state.loading === token) state.loading = null;
    }
  }

  const sectionData = () => state.cache[state.section]?.data || null;

  /* ---------------------------------------------------------------------
     Rendering
     --------------------------------------------------------------------- */
  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return 'Now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  function syncSections(list) {
    if (!Array.isArray(list) || !list.length) return;
    const clean = list.filter((s) => s && s.key).map((s) => ({ key: String(s.key), label: String(s.label || s.key) }));
    if (JSON.stringify(clean) === JSON.stringify(SECTIONS)) return;
    SECTIONS = clean;
    try { localStorage.setItem(SECTIONS_STORE, JSON.stringify(clean)); } catch { /* ignore */ }
    for (const k of Object.keys(state.cache)) if (!clean.some((s) => s.key === k)) delete state.cache[k];
    saveCache();
    renderTabs();
    if (!clean.some((s) => s.key === state.section)) {
      selectSection(clean[0].key).then(() => { if (state.view === 'list') focusFirstCard(); });
    }
  }

  function renderTabs() {
    const focusedKey = dom.tabs.contains(document.activeElement) ? document.activeElement.dataset.section : null;
    const tabs = SECTIONS.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab focusable';
      b.textContent = s.label;
      b.dataset.section = s.key;
      b._select = () => { selectSection(s.key); focusFirstCard(); };
      b.addEventListener('focus', () => {
        clearTimeout(b._timer);
        b._timer = setTimeout(() => { if (document.activeElement === b) selectSection(s.key); }, CONFIG.tabFocusDelay);
      });
      return b;
    });
    dom.tabs.replaceChildren(...tabs);
    markActiveTab();
    if (focusedKey) {
      const again = dom.tabs.querySelector(`[data-section="${CSS.escape(focusedKey)}"]`);
      if (again) focusEl(again);
    }
  }

  function markActiveTab() {
    for (const t of dom.tabs.children) t.classList.toggle('is-active', t.dataset.section === state.section);
  }

  function makeCard(cls, titleText, metaHtml) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `card focusable ${cls}`.trim();
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = titleText;
    const meta = document.createElement('span');
    meta.className = 'card-meta';
    meta.innerHTML = metaHtml; // built only from escaped values below
    b.append(title, meta);
    return b;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderList(key) {
    if (key !== state.section) return;
    const data = sectionData();
    if (!data) return;

    const hadFocus = dom.list.contains(document.activeElement);
    const focusKey = hadFocus ? document.activeElement.dataset.key : null;

    const brief = makeCard('card-brief', 'Listen to briefing', '');
    brief.dataset.key = 'brief';
    brief.querySelector('.card-meta').remove();
    brief.insertAdjacentHTML('afterbegin', '<svg class="ico" aria-hidden="true"><use href="#i-speak"/></svg>');
    const words = (data.briefing || '').split(/\s+/).length;
    const sub = document.createElement('span');
    sub.className = 'card-meta';
    sub.textContent = `≈${Math.max(10, Math.round(words / 2.6 / 5) * 5)} sec`;
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:0';
    wrap.append(brief.querySelector('.card-title'), sub);
    brief.append(wrap);
    brief._select = () => toggleSpeak('brief', data.briefing, brief);
    brief.classList.toggle('is-speaking', state.speakingId === 'brief');

    const cards = data.items.map((item, i) => {
      const ago = timeAgo(item.published);
      const c = makeCard('', item.title, `<b>${esc(item.source)}</b>${ago ? ` · ${esc(ago)}` : ''}`);
      c.dataset.key = item.id;
      c._select = () => openStory(i);
      return c;
    });

    if (!cards.length) {
      const p = document.createElement('p');
      p.className = 'notice';
      p.textContent = 'No stories right now';
      dom.list.replaceChildren(brief, p);
    } else {
      dom.list.replaceChildren(brief, ...cards);
    }
    updateHud();

    if (focusKey) {
      const again = dom.list.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (again) focusEl(again);
    }
  }

  function renderError(err) {
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = err.message || 'Couldn’t load the news';
    const retry = makeCard('', 'Try again', 'Reload this section');
    retry.dataset.key = 'retry';
    retry._select = () => loadSection(state.section, { force: true });
    dom.list.replaceChildren(p, retry);
  }

  function renderLoading() {
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = 'Loading headlines…';
    dom.list.replaceChildren(p);
  }

  function updateHud() {
    const data = sectionData();
    if (state.view === 'list') {
      dom.title.textContent = 'News';
      dom.sub.textContent = data?.label || SECTIONS.find((s) => s.key === state.section)?.label || '';
    } else {
      dom.title.textContent = data?.label || 'Story';
      dom.sub.textContent = data ? `${state.storyIndex + 1} of ${data.items.length}` : '';
    }
  }

  function setStatus(mode, entry) {
    dom.dot.dataset.status = mode;
    const time = entry ? new Date(entry.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    dom.statusText.textContent = {
      live: time ? `@${time}` : 'Live',
      cached: 'Saved',
      offline: 'Offline',
      demo: 'Demo',
      loading: 'Loading',
    }[mode];
  }

  /* ---------------------------------------------------------------------
     Views
     --------------------------------------------------------------------- */
  function selectSection(key) {
    if (key === state.section && sectionData()) return Promise.resolve();
    stopSpeaking();
    state.section = key;
    markActiveTab();
    dom.list.scrollTop = 0;
    if (!state.cache[key]) renderLoading();
    updateHud();
    return loadSection(key);
  }

  function focusFirstCard() {
    const first = dom.list.querySelector('.card:not(.card-brief)') || dom.list.querySelector('.focusable');
    if (first) focusEl(first);
  }

  function openStory(i) {
    const data = sectionData();
    if (!data?.items[i]) return;
    stopSpeaking();
    state.storyIndex = i;
    state.view = 'story';
    dom.viewList.hidden = true;
    dom.viewStory.hidden = false;
    dom.back.hidden = false;
    paintStory();
    focusEl(dom.next.disabled ? dom.speak : dom.next);
  }

  function paintStory() {
    const data = sectionData();
    const item = data.items[state.storyIndex];
    const ago = timeAgo(item.published);
    dom.meta.innerHTML = `<b>${esc(item.source)}</b>${ago ? ` · ${esc(ago)}` : ''}`;
    dom.storyTitle.textContent = item.title;
    dom.summary.textContent = item.summary || 'No summary available for this story.';
    dom.prev.disabled = state.storyIndex === 0;
    dom.next.disabled = state.storyIndex >= data.items.length - 1;
    setSpeakLabel(state.speakingId === item.id);
    updateHud();
  }

  function stepStory(dir) {
    const data = sectionData();
    const i = state.storyIndex + dir;
    if (!data || i < 0 || i >= data.items.length) { bump(document.activeElement); return; }
    stopSpeaking();
    state.storyIndex = i;
    paintStory();
    if (document.activeElement?.disabled) focusEl(dom.speak);
  }

  function backToList() {
    stopSpeaking();
    const item = sectionData()?.items[state.storyIndex];
    state.view = 'list';
    dom.viewStory.hidden = true;
    dom.viewList.hidden = false;
    dom.back.hidden = true;
    updateHud();
    const card = item && dom.list.querySelector(`[data-key="${CSS.escape(item.id)}"]`);
    focusEl(card || dom.list.querySelector('.focusable'));
  }

  function goBack() {
    if (state.view === 'story') backToList();
    else if (dom.list.contains(document.activeElement)) focusEl(dom.tabs.querySelector('.is-active'));
    else bump(document.activeElement);
  }

  /* ---------------------------------------------------------------------
     Speech (speechSynthesis — supported on the Display for short content)
     --------------------------------------------------------------------- */
  const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  let voice = null;
  function pickVoice() {
    if (!canSpeak) return;
    const voices = speechSynthesis.getVoices();
    voice = voices.find((v) => v.lang === CONFIG.voiceLang) ||
            voices.find((v) => v.lang?.startsWith('en')) || null;
  }
  if (canSpeak) { pickVoice(); speechSynthesis.addEventListener?.('voiceschanged', pickVoice); }

  function toggleSpeak(id, text, el) {
    if (!canSpeak) { toast('Speech isn’t available here', true); return; }
    if (state.speakingId === id) { stopSpeaking(); return; }
    stopSpeaking();
    if (!text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = CONFIG.voiceLang;
    if (voice) u.voice = voice;
    u.rate = 1.02;
    const done = () => { if (state.speakingId === id) stopSpeaking(); };
    u.onend = done;
    u.onerror = done;
    state.speakingId = id;
    el?.classList.add('is-speaking');
    if (state.view === 'story') setSpeakLabel(true);
    speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    if (canSpeak) speechSynthesis.cancel();
    state.speakingId = null;
    dom.list.querySelector('.is-speaking')?.classList.remove('is-speaking');
    setSpeakLabel(false);
  }

  function setSpeakLabel(on) {
    dom.speak.querySelector('use').setAttribute('href', on ? '#i-stop' : '#i-speak');
    dom.speak.querySelector('.key-label').textContent = on ? 'Stop' : 'Listen';
  }

  /* ---------------------------------------------------------------------
     Navigation (geometric: nearest focusable in the swipe direction)
     --------------------------------------------------------------------- */
  function focusables() {
    const root = state.view === 'list' ? dom.viewList : dom.viewStory;
    return [...root.querySelectorAll('.focusable'), dom.back]
      .filter((el) => !el.hidden && !el.disabled && el.offsetParent !== null);
  }

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  function move(dir) {
    const items = focusables();
    const cur = document.activeElement;
    if (!items.includes(cur)) { focusEl(items[0]); return; }
    // Sideways on a story card changes section rather than jumping up to a tab.
    if (state.view === 'list' && (dir === 'left' || dir === 'right') && dom.list.contains(cur)) {
      cycleSection(dir === 'right' ? 1 : -1);
      return;
    }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - cx;
      const dy = b.top + b.height / 2 - cy;
      const along = { up: -dy, down: dy, left: -dx, right: dx }[dir];
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along <= 1) continue;
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    // Leaving the list upwards lands on the current section's tab, not whichever is nearest.
    if (best?.classList.contains('tab') && dom.list.contains(cur)) best = dom.tabs.querySelector('.is-active') || best;
    if (best) focusEl(best);
    else bump(cur);
  }

  function cycleSection(dir) {
    const i = SECTIONS.findIndex((s) => s.key === state.section);
    const next = SECTIONS[(i + dir + SECTIONS.length) % SECTIONS.length];
    toast(next.label);
    focusEl(dom.tabs.querySelector(`[data-section="${next.key}"]`)); // hold focus while loading
    selectSection(next.key).then(() => {
      if (state.section === next.key && state.view === 'list') focusFirstCard();
    });
  }

  function activate(el) {
    if (!el || el.disabled || typeof el._select !== 'function') return;
    pressFx(el);
    el._select();
  }

  function pressFx(el) {
    el.classList.remove('is-pressed');
    void el.offsetWidth;
    el.classList.add('is-pressed');
    setTimeout(() => el.classList.remove('is-pressed'), 150);
  }

  function bump(el) {
    if (!el?.classList) return;
    el.classList.remove('is-bump');
    void el.offsetWidth;
    el.classList.add('is-bump');
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    dom.toast.textContent = msg;
    dom.toast.classList.toggle('is-error', isError);
    dom.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), 2200);
  }

  function bindInput() {
    const keyMap = new Map();
    for (const [action, keys] of Object.entries(CONFIG.keys)) keys.forEach((k) => keyMap.set(k, action));

    document.addEventListener('keydown', (e) => {
      const action = keyMap.get(e.key);
      if (!action) return;
      e.preventDefault();
      if (e.repeat && (action === 'select' || action === 'back')) return;
      if (action === 'back') { goBack(); return; }
      if (action === 'select') {
        const el = document.activeElement;
        if (el?.classList?.contains('focusable')) activate(el);
        else focusEl(focusables()[0]);
        return;
      }
      move(action);
    });
    document.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });

    document.addEventListener('click', (e) => {
      const el = e.target.closest('.focusable');
      if (el) activate(el);
    });

    dom.back._select = backToList;
    dom.prev._select = () => stepStory(-1);
    dom.next._select = () => stepStory(1);
    dom.speak._select = () => {
      const item = sectionData()?.items[state.storyIndex];
      if (item) toggleSpeak(item.id, `${item.title}. ${item.summary || ''}`);
    };
  }

  function startClock() {
    const tick = () => {
      dom.clock.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    setInterval(tick, 10000);
  }

  /* ---------------------------------------------------------------------
     Demo data
     --------------------------------------------------------------------- */
  function demoData(key) {
    const now = Date.now();
    const ago = (m) => new Date(now - m * 60000).toISOString();
    const label = { top: 'Top stories' }[key] || SECTIONS.find((s) => s.key === key)?.label || key;
    const base = [
      ['BBC', 'Sample headline: rail operator announces new timetable for spring', 'Demo text. A real summary would explain what is changing, who is affected and when it starts.'],
      ['Guardian', 'Sample headline: council sets out plans for new cycle routes', 'Demo text. Summaries are written from each outlet’s own standfirst, kept to one or two sentences.'],
      ['BBC', 'Sample headline: weather warning issued for heavy rain', 'Demo text. Pinch Next to keep reading through the section without going back to the list.'],
      ['Guardian', 'Sample headline: report finds rise in community volunteering', 'Demo text. Pinch Listen to hear this story read aloud through the glasses speaker.'],
      ['BBC', 'Sample headline: new library opens after two-year refurbishment', 'Demo text. Swipe left or right on a story card to jump between sections.'],
    ];
    return {
      section: key,
      label,
      updated: new Date(now).toISOString(),
      ai: false,
      failed: [],
      briefing: `This is a demo briefing for ${label}. When the app is connected, this will be a short spoken round-up of the most important stories in this section.`,
      items: base.map(([source, title, summary], i) => ({
        id: `${key}-${i}`, title: `${title}`, summary, source, link: '#', published: ago(12 + i * 47),
      })),
    };
  }

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */
  function init() {
    startClock();
    bindInput();
    renderTabs();
    if (!state.cache.top) renderLoading();
    updateHud();
    loadSection('top').then(focusFirstCard);
    focusFirstCard();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadSection(state.section);
      else stopSpeaking();
    });
    if (DEMO) toast('Demo mode — sample stories');
  }

  init();
})();
