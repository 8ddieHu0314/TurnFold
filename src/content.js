/**
 * TurnFold — Notion-style toggles for claude.ai conversation turns.
 *
 * A "turn" = one user message plus everything that follows it (Claude's
 * answer, tool output, etc.) up to the next user message.
 *
 * Design constraints:
 *  - claude.ai is a React app, so we NEVER move or remove nodes React owns.
 *    We only toggle CSS classes on them and append our own small overlay
 *    elements. A MutationObserver + periodic tick re-applies state whenever
 *    React re-renders (streaming, edits, navigation).
 *  - We make NO assumptions about how deeply messages are nested or whether
 *    they are siblings. Each question anchors a turn; the elements to hide
 *    are computed as the subtrees sitting between that question and the
 *    next one in document order (see hideTargetsBetween).
 *  - Collapsed state is kept per conversation in chrome.storage.local so it
 *    survives reloads.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Selectors for claude.ai's DOM. If claude.ai ships a redesign, these are
  // the only things that should need updating.
  // ---------------------------------------------------------------------
  const USER_MSG_SELECTOR = '[data-testid="user-message"]';
  // Each rendered message sits in a wrapper carrying this attribute.
  const WRAPPER_SELECTOR = '[data-test-render-count]';
  // Never hide an element that is, or contains, any of these: the composer,
  // navigation, or another question. Belt-and-suspenders guard for the
  // tree walk in hideTargetsBetween.
  const UNSAFE_SELECTOR =
    'textarea, [contenteditable="true"], form, nav, [data-testid="user-message"]';

  const MAX_CLIMB = 12;           // levels to walk up from a question wrapper
  const SCAN_DEBOUNCE_MS = 300;
  const TICK_MS = 800;            // URL watcher; every 4th tick forces a scan
  const SAVE_DEBOUNCE_MS = 500;
  const MAX_STORED_CONVERSATIONS = 200;
  const LABEL_MAX_CHARS = 140;

  const CHEVRON_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M4.5 2.5 L11 8 L4.5 13.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const COLLAPSE_ALL_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M3 6.5 L8 2.5 L13 6.5 M3 13 L8 9 L13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const EXPAND_ALL_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M3 3 L8 7 L13 3 M3 9.5 L8 13.5 L13 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CLOSE_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const LIST_SVG =
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">' +
    '<path d="M5.5 4 H13.5 M5.5 8 H13.5 M5.5 12 H13.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M2.2 3.2 L3.8 4 L2.2 4.8 Z M2.2 7.2 L3.8 8 L2.2 8.8 Z M2.2 11.2 L3.8 12 L2.2 12.8 Z" fill="currentColor"/></svg>';

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let convId = null;          // conversation uuid from the URL, or null
  let collapsed = {};         // turnKey -> true (only for the active conv)
  let turns = [];             // [{ key, label, userWrapper, hideTargets[] }]
  let sidebarOpen = false;
  let lastHref = location.href;
  let lastOutlineSig = '';
  let tickCount = 0;
  let ui = null;              // { fab, panel, list, count }

  // Full conversation history from claude.ai's same-origin API. The DOM only
  // holds messages near the viewport (older ones lazy-load on scroll up), so
  // this is the source of truth for the outline and for turn identity.
  let fullTurns = null;       // [{ uuid, label, norm }] or null if unavailable
  let orgId = null;
  let apiFailed = false;
  let apiInFlight = false;
  let lastApiFetch = 0;
  let scrollSearchToken = 0;

  // ---------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------
  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (_) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    try {
      chrome.storage.local.set(obj);
    } catch (_) { /* extension reloaded / context gone — degrade gracefully */ }
  }

  function storageRemove(keys) {
    try {
      chrome.storage.local.remove(keys);
    } catch (_) { /* ignore */ }
  }

  function getConvId() {
    const m = location.pathname.match(/\/chat\/([\w-]+)/);
    return m ? m[1] : null;
  }

  function convStorageKey(id) {
    return 'tf-conv:' + id;
  }

  // First non-empty line of the user's question, used as the collapsed label.
  function firstLine(anchor) {
    const el = anchor.querySelector(USER_MSG_SELECTOR) || anchor;
    const block = el.querySelector('p, li, pre, h1, h2, h3, blockquote');
    const text = ((block && block.textContent) || el.textContent || '').trim();
    const line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
    return (line || 'Untitled').slice(0, LABEL_MAX_CHARS);
  }

  // Whitespace-free normalization for matching DOM questions to API
  // messages: textContent glues paragraphs with no separator while the API
  // text uses \n, so all whitespace must be ignored for equality.
  function normText(s) {
    return (s || '').replace(/\s+/g, '').slice(0, 200).toLowerCase();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------
  // Full history via claude.ai's same-origin API
  // ---------------------------------------------------------------------
  async function apiJson(url) {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function fetchFullTurns(id) {
    if (!id || apiFailed || apiInFlight) return;
    const now = Date.now();
    if (now - lastApiFetch < 4000) return;
    lastApiFetch = now;
    apiInFlight = true;
    try {
      let conv = null;
      if (orgId) {
        try { conv = await apiJson('https://claude.ai/api/organizations/' + orgId + '/chat_conversations/' + id); }
        catch (_) { orgId = null; }
      }
      if (!conv) {
        const orgs = await apiJson('https://claude.ai/api/organizations');
        for (const o of Array.isArray(orgs) ? orgs : []) {
          try {
            conv = await apiJson('https://claude.ai/api/organizations/' + o.uuid + '/chat_conversations/' + id);
            orgId = o.uuid;
            break;
          } catch (_) { /* conversation lives in another org */ }
        }
      }
      if (!conv || !Array.isArray(conv.chat_messages)) throw new Error('unexpected response shape');
      fullTurns = conv.chat_messages
        .filter((m) => m && m.sender === 'human')
        .map((m) => {
          const text = m.text ||
            (Array.isArray(m.content) ? m.content.map((b) => (b && b.text) || '').join('\n') : '');
          const line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0) || 'Untitled';
          return { uuid: m.uuid, label: line.slice(0, LABEL_MAX_CHARS), norm: normText(text) };
        });
      if (getConvId() === id) {
        console.info('[TurnFold] conversation has ' + fullTurns.length + ' turns (' +
          document.querySelectorAll(USER_MSG_SELECTOR).length + ' currently loaded in the DOM)');
        lastOutlineSig = '';
        scan();
      }
    } catch (e) {
      apiFailed = true; // DOM-only fallback for the rest of the session
      console.info('[TurnFold] full-history API unavailable (' + (e && e.message) + '); outline shows loaded messages only');
    } finally {
      apiInFlight = false;
    }
  }

  // ---------------------------------------------------------------------
  // Turn detection — structure-agnostic
  // ---------------------------------------------------------------------
  function lowestCommonAncestor(nodes) {
    let anc = nodes[0];
    for (let i = 1; i < nodes.length && anc; i++) {
      while (anc && !anc.contains(nodes[i])) anc = anc.parentElement;
    }
    return anc || null;
  }

  function isSafeToHide(el) {
    return !(el.matches(UNSAFE_SELECTOR) || el.querySelector(UNSAFE_SELECTOR));
  }

  /**
   * Elements whose subtrees sit strictly between `anchor` (this turn's
   * question wrapper) and `nextAnchor` (the next turn's question wrapper) in
   * document order. Walk up from the anchor; at each level collect following
   * siblings, stopping at the branch that contains the next question. For
   * the last turn, `container` (the conversation's common ancestor) bounds
   * the climb instead.
   */
  function hideTargetsBetween(anchor, nextAnchor, container) {
    if (!nextAnchor && !container) return []; // can't bound the walk safely
    const targets = [];
    const nextChain = new Set();
    for (let n = nextAnchor; n; n = n.parentElement) nextChain.add(n);

    let node = anchor;
    for (let depth = 0;
         node && node !== container && node !== document.body && depth < MAX_CLIMB;
         depth++) {
      let reachedNext = false;
      for (let s = node.nextElementSibling; s; s = s.nextElementSibling) {
        if (nextChain.has(s)) { reachedNext = true; break; }
        if (isSafeToHide(s)) targets.push(s);
      }
      if (reachedNext || !node.parentElement || nextChain.has(node.parentElement)) break;
      node = node.parentElement;
    }
    return targets;
  }

  function collectTurns() {
    const userEls = Array.from(document.querySelectorAll(USER_MSG_SELECTOR));
    if (userEls.length === 0) return [];

    // One anchor per question: its message wrapper (in document order).
    const anchors = [];
    const seen = new Set();
    for (const el of userEls) {
      const a = el.closest(WRAPPER_SELECTOR) || el.parentElement;
      if (a && !seen.has(a)) { seen.add(a); anchors.push(a); }
    }

    // Container bounding the last turn's hide-walk: the lowest common
    // ancestor of the question anchors, or — in single-question chats — of
    // all message wrappers (questions + answers).
    let container = null;
    if (anchors.length >= 2) {
      container = lowestCommonAncestor(anchors);
    } else {
      const wrappers = Array.from(document.querySelectorAll(WRAPPER_SELECTOR));
      if (wrappers.length >= 2) container = lowestCommonAncestor(wrappers);
    }
    if (container === document.body || container === document.documentElement) {
      container = null;
    }

    // Key = content hash + occurrence count, NOT position: claude.ai
    // virtualizes long chats (offscreen messages unmount while scrolling),
    // so mounted indices shift constantly. Content-based keys keep fold
    // state attached to the right turn; edits reset it harmlessly.
    const occurrences = {};
    const list = anchors.map((a, i) => {
      const label = firstLine(a);
      const h = hash(label);
      occurrences[h] = (occurrences[h] || 0) + 1;
      return {
        userWrapper: a,
        label,
        key: h + ':' + occurrences[h],
        hideTargets: hideTargetsBetween(a, anchors[i + 1] || null, container),
      };
    });
    alignKeysToApi(list);
    return list;
  }

  // Upgrade mounted turns to server-UUID keys by matching them (in order)
  // against the API's message list. UUID keys survive any amount of
  // mounting/unmounting; unmatched turns keep their content-hash key.
  function alignKeysToApi(list) {
    if (!fullTurns) return;
    let j = 0;
    let unmatched = false;
    for (const t of list) {
      const el = t.userWrapper.querySelector(USER_MSG_SELECTOR) || t.userWrapper;
      const norm = normText(el.textContent);
      let found = false;
      for (let k = j; k < fullTurns.length; k++) {
        if (fullTurns[k].norm === norm) {
          t.key = 'u:' + fullTurns[k].uuid;
          j = k + 1;
          found = true;
          break;
        }
      }
      if (!found) unmatched = true;
    }
    // A mounted question the API doesn't know about = a message sent after
    // our last fetch (or an edit). Refresh, throttled.
    if (unmatched && convId) fetchFullTurns(convId);
  }

  // ---------------------------------------------------------------------
  // Applying collapse state to the DOM
  // ---------------------------------------------------------------------
  function ensureToggleButton(wrapper) {
    if (wrapper.querySelector(':scope > .tf-toggle')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tf-toggle';
    btn.title = 'Fold / unfold this turn (TurnFold)';
    btn.setAttribute('aria-label', 'Fold or unfold this conversation turn');
    btn.innerHTML = CHEVRON_SVG;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTurnByWrapper(wrapper);
    });
    wrapper.appendChild(btn);
  }

  function applyAll() {
    const toHide = new Set();
    for (const t of turns) {
      if (collapsed[t.key]) for (const el of t.hideTargets) toHide.add(el);
    }
    // Clear classes that no longer apply (nodes replaced, turns re-grouped).
    for (const el of document.querySelectorAll('.tf-hidden')) {
      if (!toHide.has(el)) el.classList.remove('tf-hidden');
    }
    const anchorSet = new Set(turns.map((t) => t.userWrapper));
    for (const el of document.querySelectorAll('.tf-turn')) {
      if (!anchorSet.has(el)) el.classList.remove('tf-turn', 'tf-collapsed');
    }
    // React recycles DOM nodes between messages: a wrapper that stops being
    // a question anchor may keep the chevron we appended — an invisible but
    // clickable button bound to a stale wrapper. Remove such ghosts.
    for (const btn of document.querySelectorAll('.tf-toggle')) {
      if (!anchorSet.has(btn.parentElement)) btn.remove();
    }
    for (const el of toHide) el.classList.add('tf-hidden');
    for (const t of turns) {
      t.userWrapper.classList.add('tf-turn');
      t.userWrapper.classList.toggle('tf-collapsed', !!collapsed[t.key]);
      ensureToggleButton(t.userWrapper);
    }
    updateUi();
  }

  function toggleTurnByWrapper(wrapper) {
    // Rescan synchronously so the toggle acts on the CURRENT structure, not
    // a snapshot from up to 300ms ago — React may have remounted messages
    // (streaming, virtualization) since the last scan.
    turns = collectTurns();
    const t = turns.find((x) => x.userWrapper === wrapper || x.userWrapper.contains(wrapper));
    if (!t) return;
    collapsed[t.key] = !collapsed[t.key];
    if (!collapsed[t.key]) delete collapsed[t.key];
    applyAll();
    saveState();
  }

  function setAll(isCollapsed) {
    collapsed = {};
    if (isCollapsed) {
      // UUID keys cover the whole conversation, so turns that are not
      // currently loaded fold the moment they lazy-load into the DOM.
      if (fullTurns) for (const f of fullTurns) collapsed['u:' + f.uuid] = true;
      for (const t of turns) collapsed[t.key] = true;
    }
    applyAll();
    saveState();
  }

  function toggleKey(key) {
    collapsed[key] = !collapsed[key];
    if (!collapsed[key]) delete collapsed[key];
    turns = collectTurns();
    applyAll();
    saveState();
  }

  function flashAndScroll(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('tf-flash');
    void el.offsetWidth; // restart the highlight animation
    el.classList.add('tf-flash');
  }

  function jumpToKey(key) {
    const t = turns.find((x) => x.key === key);
    if (t) { flashAndScroll(t.userWrapper); return; }
    scrollUntilLoaded(key);
  }

  function findScroller() {
    const probe = turns[0] ? turns[0].userWrapper : document.querySelector(WRAPPER_SELECTOR);
    let n = probe;
    while (n && n !== document.body) {
      if (n.scrollHeight > n.clientHeight + 100) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') return n;
      }
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Jump to a turn that isn't in the DOM yet: step-scroll toward it so
  // claude.ai lazy-loads history, rescanning after each step, until the
  // target mounts or we hit the end of the scroller.
  async function scrollUntilLoaded(key) {
    if (!fullTurns) return;
    const token = ++scrollSearchToken;
    const targetIdx = fullTurns.findIndex((f) => 'u:' + f.uuid === key);
    if (targetIdx < 0) return;
    const scroller = findScroller();
    if (!scroller) return;
    const mountedIdxs = turns
      .map((t) => fullTurns.findIndex((f) => 'u:' + f.uuid === t.key))
      .filter((i) => i >= 0);
    const goUp = mountedIdxs.length === 0 || targetIdx < Math.min(...mountedIdxs);
    for (let step = 0; step < 80; step++) {
      if (token !== scrollSearchToken || getConvId() !== convId) return;
      const t = turns.find((x) => x.key === key);
      if (t) { flashAndScroll(t.userWrapper); return; }
      const before = scroller.scrollTop;
      scroller.scrollTop = before + (goUp ? -1 : 1) * scroller.clientHeight * 0.85;
      await sleep(300);
      scan(); // pick up whatever just lazy-loaded
      if (Math.abs(scroller.scrollTop - before) < 2) return; // hit the end
    }
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------
  const saveState = debounce(() => {
    if (!convId) return; // brand-new chat with no id yet: in-memory only
    storageSet({ [convStorageKey(convId)]: { c: collapsed, ts: Date.now() } });
  }, SAVE_DEBOUNCE_MS);

  async function loadState(id) {
    if (!id) { collapsed = {}; return; }
    const res = await storageGet(convStorageKey(id));
    const entry = res[convStorageKey(id)];
    collapsed = (entry && entry.c && typeof entry.c === 'object') ? entry.c : {};
  }

  async function pruneOldConversations() {
    const all = await storageGet(null);
    const entries = Object.entries(all).filter(([k]) => k.startsWith('tf-conv:'));
    if (entries.length <= MAX_STORED_CONVERSATIONS) return;
    entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const excess = entries.slice(0, entries.length - MAX_STORED_CONVERSATIONS);
    storageRemove(excess.map(([k]) => k));
  }

  // ---------------------------------------------------------------------
  // Sidebar + floating button (our own UI, mounted outside React's tree)
  // ---------------------------------------------------------------------
  function buildUi() {
    if (ui) return;

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'tf-fab';
    fab.title = 'TurnFold outline (Alt+Shift+O)';
    fab.setAttribute('aria-label', 'Toggle TurnFold outline sidebar');
    fab.innerHTML = LIST_SVG;
    fab.addEventListener('click', () => setSidebarOpen(!sidebarOpen));

    const panel = document.createElement('div');
    panel.className = 'tf-panel';
    panel.innerHTML =
      '<div class="tf-panel-head">' +
      '  <span class="tf-panel-title">Outline <span class="tf-panel-count"></span></span>' +
      '  <span class="tf-panel-actions">' +
      '    <button type="button" class="tf-icon-btn tf-collapse-all" title="Collapse all turns (Alt+Shift+C)">' + COLLAPSE_ALL_SVG + '</button>' +
      '    <button type="button" class="tf-icon-btn tf-expand-all" title="Expand all turns (Alt+Shift+E)">' + EXPAND_ALL_SVG + '</button>' +
      '    <button type="button" class="tf-icon-btn tf-close" title="Close">' + CLOSE_SVG + '</button>' +
      '  </span>' +
      '</div>' +
      '<div class="tf-panel-list" role="list"></div>';

    panel.querySelector('.tf-collapse-all').addEventListener('click', () => setAll(true));
    panel.querySelector('.tf-expand-all').addEventListener('click', () => setAll(false));
    panel.querySelector('.tf-close').addEventListener('click', () => setSidebarOpen(false));

    const list = panel.querySelector('.tf-panel-list');
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.tf-item');
      if (!item || !item.dataset.key) return;
      if (e.target.closest('.tf-item-chevron')) toggleKey(item.dataset.key);
      else jumpToKey(item.dataset.key);
    });

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    ui = { fab, panel, list, count: panel.querySelector('.tf-panel-count') };
  }

  function setSidebarOpen(open) {
    sidebarOpen = open;
    updateUi();
    storageSet({ 'tf-ui': { open: sidebarOpen } });
  }

  // Outline rows: the API's full history when available (unloaded turns
  // render dimmed), otherwise just what's mounted in the DOM.
  function outlineItems() {
    if (!fullTurns) {
      return turns.map((t) => ({ key: t.key, label: t.label, mounted: true }));
    }
    const mountedKeys = new Set(turns.map((t) => t.key));
    const items = fullTurns.map((f) => ({
      key: 'u:' + f.uuid,
      label: f.label,
      mounted: mountedKeys.has('u:' + f.uuid),
    }));
    // Mounted questions the API hasn't returned yet (just-sent messages).
    for (const t of turns) {
      if (!t.key.startsWith('u:')) items.push({ key: t.key, label: t.label, mounted: true });
    }
    return items;
  }

  function updateUi() {
    if (!ui) return;
    const hasTurns = turns.length > 0 || (fullTurns && fullTurns.length > 0);
    ui.fab.classList.toggle('tf-visible', !!hasTurns);
    ui.panel.classList.toggle('tf-open', !!hasTurns && sidebarOpen);
    if (!hasTurns || !sidebarOpen) { lastOutlineSig = ''; return; }

    const items = outlineItems();
    const sig = convId + '|' +
      items.map((x) => x.key + (x.mounted ? 'm' : '') + (collapsed[x.key] ? '1' : '0')).join('|');
    if (sig === lastOutlineSig) return;
    lastOutlineSig = sig;

    ui.count.textContent = fullTurns
      ? turns.length + '/' + items.length + ' loaded'
      : String(items.length);
    ui.list.textContent = '';
    items.forEach((x, i) => {
      const item = document.createElement('div');
      item.className = 'tf-item' +
        (collapsed[x.key] ? ' tf-item-collapsed' : '') +
        (x.mounted ? '' : ' tf-item-ghost');
      item.dataset.key = x.key;
      item.setAttribute('role', 'listitem');
      if (!x.mounted) item.title = 'Not loaded yet — click to scroll until claude.ai loads it';

      const chev = document.createElement('button');
      chev.type = 'button';
      chev.className = 'tf-item-chevron';
      chev.title = collapsed[x.key] ? 'Unfold this turn' : 'Fold this turn';
      chev.innerHTML = CHEVRON_SVG;

      const num = document.createElement('span');
      num.className = 'tf-item-num';
      num.textContent = String(i + 1);

      const label = document.createElement('span');
      label.className = 'tf-item-label';
      label.textContent = x.label;
      label.title = label.title || x.label;

      item.append(chev, num, label);
      ui.list.appendChild(item);
    });
  }

  // ---------------------------------------------------------------------
  // Scanning / navigation
  // ---------------------------------------------------------------------
  function scan() {
    turns = collectTurns();
    applyAll();
  }
  const debouncedScan = debounce(scan, SCAN_DEBOUNCE_MS);

  async function onNavigate() {
    convId = getConvId();
    lastOutlineSig = '';
    fullTurns = null;
    scrollSearchToken++;      // cancel any in-flight jump search
    lastApiFetch = 0;         // navigation bypasses the API throttle
    await loadState(convId);
    scan();
    if (convId) fetchFullTurns(convId);
  }

  // Expand a collapsed turn by clicking its (clamped) question text.
  document.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('.tf-toggle')) return;
    const wrapper = e.target.closest('.tf-turn.tf-collapsed');
    if (!wrapper) return;
    if (!e.target.closest(USER_MSG_SELECTOR)) return;
    if (String(window.getSelection())) return; // don't hijack text selection
    e.preventDefault();
    e.stopPropagation();
    toggleTurnByWrapper(wrapper);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyO') { e.preventDefault(); setSidebarOpen(!sidebarOpen); }
    else if (e.code === 'KeyC') { e.preventDefault(); setAll(true); }
    else if (e.code === 'KeyE') { e.preventDefault(); setAll(false); }
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  async function init() {
    // Version marker: lets diagnostics confirm which build is live in this
    // tab (a reloaded extension silently orphans already-open tabs).
    let version = 'dev';
    try { version = chrome.runtime.getManifest().version; } catch (_) { /* ignore */ }
    document.documentElement.setAttribute('data-tf-version', version);
    console.info('[TurnFold] v' + version + ' active');

    buildUi();
    const res = await storageGet('tf-ui');
    sidebarOpen = !!(res['tf-ui'] && res['tf-ui'].open);
    await onNavigate();
    pruneOldConversations();

    // childList catches added/replaced messages; the class filter catches
    // React re-renders that rewrite className and would silently strip our
    // tf-* classes. Re-applying is idempotent (classList.add of an existing
    // class fires no mutation), so this settles instead of looping.
    // Fast path: when a question node mounts (lazy-loaded history), scan
    // immediately so a collapsed turn folds without a visible flash.
    let lastFastScan = 0;
    new MutationObserver((muts) => {
      debouncedScan();
      const now = Date.now();
      if (now - lastFastScan < 150) return;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 &&
              (n.matches(USER_MSG_SELECTOR) ||
               (n.querySelector && n.querySelector(USER_MSG_SELECTOR)))) {
            lastFastScan = now;
            scan();
            return;
          }
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    // Safety net: catch SPA navigations and any re-render the observer's
    // debounce swallowed during long streaming responses.
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onNavigate();
        return;
      }
      if (++tickCount % 4 === 0) scan();
    }, TICK_MS);
  }

  // Test hook: only populated when a harness pre-defines window.__TF_TEST__.
  if (window.__TF_TEST__) {
    Object.assign(window.__TF_TEST__, {
      collectTurns,
      hideTargetsBetween,
      lowestCommonAncestor,
      firstLine,
      normText,
      outlineItems,
      scan,
      applyAll,
      setAll,
      getTurns: () => turns,
      setCollapsed: (c) => { collapsed = c; },
      getCollapsed: () => collapsed,
      setFullTurns: (f) => { fullTurns = f; },
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
