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
    return anchors.map((a, i) => {
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
    if (isCollapsed) for (const t of turns) collapsed[t.key] = true;
    applyAll();
    saveState();
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
      const chev = e.target.closest('.tf-item-chevron');
      const item = e.target.closest('.tf-item');
      if (!item) return;
      const t = turns[Number(item.dataset.index)];
      if (!t) return;
      if (chev) {
        toggleTurnByWrapper(t.userWrapper);
        return;
      }
      t.userWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
      t.userWrapper.classList.remove('tf-flash');
      void t.userWrapper.offsetWidth; // restart the highlight animation
      t.userWrapper.classList.add('tf-flash');
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

  function updateUi() {
    if (!ui) return;
    const hasTurns = turns.length > 0;
    ui.fab.classList.toggle('tf-visible', hasTurns);
    ui.panel.classList.toggle('tf-open', hasTurns && sidebarOpen);
    if (!hasTurns || !sidebarOpen) { lastOutlineSig = ''; return; }

    const sig = convId + '|' + turns.map((t) => t.key + (collapsed[t.key] ? '1' : '0')).join('|');
    if (sig === lastOutlineSig) return;
    lastOutlineSig = sig;

    ui.count.textContent = String(turns.length);
    ui.list.textContent = '';
    turns.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = 'tf-item' + (collapsed[t.key] ? ' tf-item-collapsed' : '');
      item.dataset.index = String(i);
      item.setAttribute('role', 'listitem');

      const chev = document.createElement('button');
      chev.type = 'button';
      chev.className = 'tf-item-chevron';
      chev.title = collapsed[t.key] ? 'Unfold this turn' : 'Fold this turn';
      chev.innerHTML = CHEVRON_SVG;

      const num = document.createElement('span');
      num.className = 'tf-item-num';
      num.textContent = String(i + 1);

      const label = document.createElement('span');
      label.className = 'tf-item-label';
      label.textContent = t.label;
      label.title = t.label;

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
    await loadState(convId);
    scan();
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
    new MutationObserver(debouncedScan).observe(document.body, {
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
      scan,
      applyAll,
      getTurns: () => turns,
      setCollapsed: (c) => { collapsed = c; },
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
