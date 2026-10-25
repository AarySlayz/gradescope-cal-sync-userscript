// ==UserScript==
// @name         Gradescope → Google Calendar Sync
// @namespace    gradescope-gcal-sync
// @version      1.2.0
// @description  Syncs your Gradescope due dates to Google Calendar and adds a Classroom-style to-do list to Gradescope.
// @match        https://www.gradescope.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- Settings ----
  const SYNC_INTERVAL_MIN = 30; // at most one automatic sync per this many minutes
  const LOOKBACK_DAYS = 2;      // also sync assignments due up to this many days ago (catches extensions)
  const TERMS_TO_SCAN = 1;      // how many of the newest terms on the dashboard to scan
  const CACHE_MAX_AGE_MIN = 5;  // re-read Gradescope if the saved assignment list is older than this
  const DONE_DAYS = 14;         // the "Done" tab shows work due within the last this-many days

  // ---- Config (Apps Script URL + secret key, stored in Tampermonkey) ----
  function getConfig() {
    const url = GM_getValue('appsScriptUrl', '');
    const key = GM_getValue('secretKey', '');
    return url && key ? { url, key } : null;
  }

  // Assignments you've marked done by hand (exams, optional work, etc.).
  function getDismissed() {
    return new Set(GM_getValue('dismissed', []));
  }

  function setDismissed(id, on) {
    const set = getDismissed();
    on ? set.add(id) : set.delete(id);
    GM_setValue('dismissed', [...set]);
    // Push the ✅ change to the calendar on the next page load.
    GM_setValue('lastSync', 0);
    rerender();
  }

  // ---- Scraping ----
  async function fetchDoc(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  // Gradescope uses "2024-01-17 23:59:00 -0500", which Date() can't parse reliably.
  function parseGsDate(s) {
    if (!s) return null;
    const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})$/);
    const d = m ? new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : new Date(s);
    return isNaN(d) ? null : d;
  }

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function getCourses(doc) {
    // The dashboard has a list per role (student/instructor), each grouped by term, newest first.
    const lists = [...doc.querySelectorAll('.courseList')];
    const scopes = lists.length
      ? lists.flatMap((l) => [...l.querySelectorAll('.courseList--coursesForTerm')].slice(0, TERMS_TO_SCAN))
      : [doc];
    const courses = new Map();
    for (const scope of scopes.length ? scopes : [doc]) {
      for (const a of scope.querySelectorAll('a[href^="/courses/"]')) {
        const m = a.getAttribute('href').match(/^\/courses\/(\d+)\/?$/);
        if (!m || courses.has(m[1])) continue;
        const name = clean(a.querySelector('.courseBox--shortname')?.textContent || a.textContent);
        courses.set(m[1], { id: m[1], name });
      }
    }
    return [...courses.values()];
  }

  function parseAssignments(doc, course) {
    const rows = doc.querySelectorAll('#assignments-student-table tbody tr');
    const out = [];
    for (const row of rows) {
      const link = row.querySelector('a[href*="/assignments/"]');
      const btn = row.querySelector('[data-assignment-id]');
      const assignmentId = btn?.dataset.assignmentId || link?.getAttribute('href').match(/\/assignments\/(\d+)/)?.[1];
      const title = clean(btn?.dataset.assignmentTitle || row.querySelector('th')?.textContent || link?.textContent);
      if (!title) continue;

      // Each row has a release <time> and one or two due <time>s ("Due Date" / "Late Due Date").
      let due = null;
      let lateDue = null;
      for (const t of row.querySelectorAll('time[datetime]')) {
        if (/release/i.test(t.className)) continue;
        const d = parseGsDate(t.getAttribute('datetime'));
        if (!d) continue;
        if (/late/i.test(t.textContent + ' ' + (t.getAttribute('aria-label') || ''))) lateDue = d;
        else if (!due) due = d;
        else if (!lateDue) lateDue = d;
      }
      if (!due) continue;

      const status = clean(row.querySelector('.submissionStatus')?.textContent);
      out.push({
        id: `${course.id}-${assignmentId || title.toLowerCase().replace(/\W+/g, '-')}`,
        course: course.name,
        title,
        due: due.toISOString(),
        lateDue: lateDue ? lateDue.toISOString() : null,
        status,
        submitted: !!status && !/no submission/i.test(status),
        url: location.origin + (link?.getAttribute('href') || `/courses/${course.id}`),
      });
    }
    return out;
  }

  async function scrapeAll() {
    // On the dashboard the course list is already on screen, so skip fetching it again.
    const dashboard = document.querySelector('.courseList') ? document : await fetchDoc('/');
    const courses = getCourses(dashboard);
    if (!courses.length) return null;
    const all = [];
    for (const course of courses) {
      all.push(...parseAssignments(await fetchDoc(`/courses/${course.id}`), course));
    }
    return all;
  }

  // Returns the saved list if it's recent, otherwise re-reads Gradescope. null means logged out.
  let inflight = null;
  function getAssignments({ fresh = false } = {}) {
    const cache = GM_getValue('cache', null);
    if (!fresh && cache && Date.now() - cache.time < CACHE_MAX_AGE_MIN * 60e3) return Promise.resolve(cache);
    inflight = inflight || scrapeAll()
      .then((assignments) => {
        if (!assignments) return null;
        const fresh = { time: Date.now(), assignments };
        GM_setValue('cache', fresh);
        return fresh;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  // ---- Talking to Apps Script ----
  function post(url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        data: JSON.stringify(body),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        timeout: 120000,
        onload: (r) => {
          let j;
          try { j = JSON.parse(r.responseText); } catch {
            return reject(new Error(`Unexpected response (HTTP ${r.status}). Is the web app deployed with access "Anyone"?`));
          }
          j.ok ? resolve(j) : reject(new Error(j.error || 'Unknown error'));
        },
        onerror: () => reject(new Error('Network error contacting Apps Script')),
        ontimeout: () => reject(new Error('Apps Script timed out')),
      });
    });
  }

  // ---- State ----
  const state = { assignments: null, updatedAt: null, loading: false, error: null, syncing: false };
  const todoRoots = new Set();

  async function loadAssignments({ fresh = false } = {}) {
    state.loading = true;
    rerender();
    try {
      const data = await getAssignments({ fresh });
      if (data) {
        state.assignments = data.assignments;
        state.updatedAt = data.time;
        state.error = null;
      } else {
        state.error = 'No courses found. Are you logged in?';
      }
    } catch (e) {
      state.error = e.message;
    } finally {
      state.loading = false;
      rerender();
    }
  }

  async function sync({ force = false } = {}) {
    if (state.syncing) return;
    if (!force && Date.now() - GM_getValue('lastSync', 0) < SYNC_INTERVAL_MIN * 60e3) return;
    const cfg = getConfig();
    if (!cfg) {
      if (force) openPanel();
      return;
    }
    // Claim the slot up front so other Gradescope tabs opened meanwhile don't sync too.
    GM_setValue('lastSync', Date.now());
    state.syncing = true;
    rerender();

    try {
      const data = await getAssignments({ fresh: force });
      if (!data) {
        // Probably logged out; try again next time a page loads.
        GM_setValue('lastSync', 0);
        if (force) toast('Gradescope → GCal: no courses found. Are you logged in?', true);
        return;
      }
      state.assignments = data.assignments;
      state.updatedAt = data.time;

      const cutoff = Date.now() - LOOKBACK_DAYS * 864e5;
      const dismissed = getDismissed();
      const assignments = data.assignments
        .filter((a) => Date.parse(a.due) >= cutoff)
        .map((a) => ({ ...a, submitted: a.submitted || dismissed.has(a.id) }));
      const r = await post(cfg.url, { key: cfg.key, assignments });
      const summary = `${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged`;
      GM_setValue('lastResult', { time: Date.now(), summary });
      console.log(`[Gradescope → GCal] ${summary}`);
      if (force || r.created || r.updated) toast(`📅 Gradescope → GCal: ${summary}`);
    } catch (e) {
      console.error('[Gradescope → GCal]', e);
      GM_setValue('lastResult', { time: Date.now(), error: e.message });
      toast(`Gradescope → GCal sync failed: ${e.message}`, true);
    } finally {
      state.syncing = false;
      rerender();
    }
  }

  // ---- Helpers for building UI ----
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c != null && c !== false) el.append(c);
    }
    return el;
  }

  function dayDiff(d) {
    const a = new Date(d);
    const b = new Date();
    a.setHours(0, 0, 0, 0);
    b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / 864e5);
  }

  function formatWhen(d) {
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const days = dayDiff(d);
    if (days === 0) return `Today, ${time}`;
    if (days === 1) return `Tomorrow, ${time}`;
    if (days === -1) return `Yesterday, ${time}`;
    if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })}, ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }

  function timeAgo(t) {
    const min = Math.round((Date.now() - t) / 60e3);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    if (min < 1440) return `${Math.round(min / 60)} h ago`;
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ---- To-do list ----
  function categorize(list) {
    const now = Date.now();
    const dismissed = getDismissed();
    const upcoming = [];
    const missing = [];
    const done = [];
    for (const a of list) {
      const due = Date.parse(a.due);
      if (a.submitted || dismissed.has(a.id)) {
        if (due > now - DONE_DAYS * 864e5) done.push(a);
      } else if (due > now) {
        upcoming.push(a);
      } else {
        // Includes work that still accepts late submissions; the row says which.
        missing.push(a);
      }
    }
    upcoming.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
    missing.sort((a, b) => Date.parse(b.due) - Date.parse(a.due));
    done.sort((a, b) => Date.parse(b.due) - Date.parse(a.due));
    return { upcoming, missing, done };
  }

  function itemEl(a, kind, dismissed) {
    const due = new Date(a.due);
    const lateDue = a.lateDue ? new Date(a.lateDue) : null;
    let when;
    let badge = null;
    let urgent = false;
    if (kind === 'upcoming') {
      when = formatWhen(due);
      urgent = due - Date.now() < 864e5;
    } else if (kind === 'missing') {
      if (lateDue && lateDue > Date.now()) {
        when = `Late until ${formatWhen(lateDue)}`;
        badge = h('span', { class: 'gcs-badge gcs-warn' }, 'Late OK');
      } else {
        when = `Was due ${formatWhen(due)}`;
        badge = h('span', { class: 'gcs-badge gcs-bad' }, 'Missing');
      }
    } else {
      when = dismissed.has(a.id) && !a.submitted ? 'Marked done' : a.status || 'Submitted';
    }

    let action = null;
    if (kind !== 'done') {
      action = h('button', {
        class: 'gcs-icon-btn gcs-check', title: 'Mark as done', 'aria-label': `Mark ${a.title} as done`,
        onclick: () => setDismissed(a.id, true),
      }, '✓');
    } else if (dismissed.has(a.id)) {
      action = h('button', {
        class: 'gcs-link-btn', title: 'Move back to your to-do list',
        onclick: () => setDismissed(a.id, false),
      }, 'Undo');
    }

    return h('li', { class: 'gcs-item' },
      h('a', { class: 'gcs-item-main', href: a.url },
        h('span', { class: 'gcs-item-title' }, a.title),
        h('span', { class: 'gcs-item-meta' },
          h('span', { class: 'gcs-course' }, a.course), ' · ',
          h('span', { class: urgent ? 'gcs-urgent' : null }, when),
          badge ? [' ', badge] : null)),
      action);
  }

  function renderTodo(root) {
    const tab = GM_getValue('todoTab', 'upcoming');
    const dismissed = getDismissed();
    const groups = categorize(state.assignments || []);
    const tabs = [['upcoming', 'Upcoming'], ['missing', 'Missing'], ['done', 'Done']];

    let body;
    if (!state.assignments) {
      body = h('p', { class: 'gcs-empty' }, state.loading ? 'Loading assignments…' : state.error || 'No data yet.');
    } else if (!groups[tab].length) {
      body = h('p', { class: 'gcs-empty' }, {
        upcoming: 'Nothing due. 🎉',
        missing: 'No missing work.',
        done: `Nothing submitted in the last ${DONE_DAYS} days.`,
      }[tab]);
    } else if (tab === 'upcoming') {
      const buckets = [['Today', (d) => d === 0], ['Tomorrow', (d) => d === 1], ['This week', (d) => d < 7], ['Later', () => true]];
      const sorted = buckets.map(([label]) => [label, []]);
      for (const a of groups.upcoming) {
        const d = dayDiff(new Date(a.due));
        sorted[buckets.findIndex(([, test]) => test(d))][1].push(a);
      }
      body = sorted.filter(([, items]) => items.length).map(([label, items]) => [
        h('div', { class: 'gcs-group' }, label),
        h('ul', { class: 'gcs-list' }, items.map((a) => itemEl(a, 'upcoming', dismissed))),
      ]);
    } else {
      body = h('ul', { class: 'gcs-list' }, groups[tab].map((a) => itemEl(a, tab, dismissed)));
    }

    root.replaceChildren(
      h('div', { class: 'gcs-todo-head' },
        h('div', { class: 'gcs-tabs', role: 'tablist' }, tabs.map(([id, label]) => {
          const n = groups[id].length;
          return h('button', {
            class: 'gcs-tab' + (id === tab ? ' gcs-on' : ''), role: 'tab', 'aria-selected': String(id === tab),
            onclick: () => { GM_setValue('todoTab', id); rerender(); },
          }, label, n && id !== 'done' ? h('span', { class: 'gcs-count' + (id === 'missing' ? ' gcs-count-bad' : '') }, n) : null);
        })),
        h('button', {
          class: 'gcs-icon-btn', title: 'Refresh from Gradescope', 'aria-label': 'Refresh from Gradescope',
          disabled: state.loading, onclick: () => loadAssignments({ fresh: true }),
        }, state.loading ? '…' : '↻')),
      h('div', { class: 'gcs-todo-body' }, body),
      state.updatedAt ? h('div', { class: 'gcs-foot' },
        `Updated ${timeAgo(state.updatedAt)}`,
        state.error && state.assignments ? h('span', { class: 'gcs-err' }, ` · ${state.error}`) : null) : null);
  }

  // ---- Dashboard to-do ----
  let dashTodo = null;
  let dashTodoRoot = null;
  let dashToggle = null;
  let dashSummary = null;

  function applyDashCollapsed() {
    const collapsed = GM_getValue('todoCollapsed', false);
    dashTodoRoot.hidden = collapsed;
    dashTodo.classList.toggle('gcs-collapsed', collapsed);
    dashToggle.setAttribute('aria-expanded', String(!collapsed));
  }

  function renderDashSummary() {
    if (!dashSummary || !state.assignments) return;
    const { upcoming, missing } = categorize(state.assignments);
    dashSummary.textContent = `${upcoming.length} upcoming · ${missing.length} missing`;
  }

  function mountDashboardTodo() {
    const anchor = document.querySelector('.courseList');
    if (!anchor || !GM_getValue('showDashboardTodo', true)) return false;
    if (!dashTodo) {
      dashTodoRoot = h('div', { class: 'gcs-todo', id: 'gcs-dash-todo' });
      dashSummary = h('span', { class: 'gcs-dash-summary' });
      dashToggle = h('button', {
        class: 'gcs-dash-toggle', 'aria-controls': 'gcs-dash-todo',
        onclick: () => {
          GM_setValue('todoCollapsed', !GM_getValue('todoCollapsed', false));
          applyDashCollapsed();
        },
      }, h('span', { class: 'gcs-chevron', 'aria-hidden': 'true' }, '▾'), 'To-do');
      dashTodo = h('section', { class: 'gcs-dash', 'aria-label': 'To-do' },
        h('h2', { class: 'gcs-dash-title' }, dashToggle, dashSummary), dashTodoRoot);
      applyDashCollapsed();
    }
    anchor.before(dashTodo);
    todoRoots.add(dashTodoRoot);
    renderTodo(dashTodoRoot);
    return true;
  }

  function unmountDashboardTodo() {
    dashTodo?.remove();
    todoRoots.delete(dashTodoRoot);
  }

  // ---- Floating button + panel ----
  let fab, fabBadge, panel, panelStatus, panelTodo, settingsEl;

  function buildSettings() {
    const cfg = getConfig() || {};
    const url = h('input', {
      class: 'gcs-input', type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec',
      value: GM_getValue('appsScriptUrl', ''), 'aria-label': 'Apps Script web app URL',
    });
    const key = h('input', {
      class: 'gcs-input', type: 'password', placeholder: 'SECRET_KEY from Code.gs',
      value: GM_getValue('secretKey', ''), 'aria-label': 'Secret key', autocomplete: 'off',
    });
    const msg = h('span', { class: 'gcs-msg' });
    const summary = h('summary', null, cfg.url ? 'Settings' : 'Set up calendar sync');
    const showTodo = h('input', {
      type: 'checkbox', checked: GM_getValue('showDashboardTodo', true),
      onchange: () => {
        GM_setValue('showDashboardTodo', showTodo.checked);
        showTodo.checked ? mountDashboardTodo() : unmountDashboardTodo();
      },
    });

    const form = h('form', {
      class: 'gcs-form',
      onsubmit: (e) => {
        e.preventDefault();
        const u = url.value.trim();
        const k = key.value.trim();
        if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(u)) {
          msg.textContent = 'The URL should start with https://script.google.com/ and end in /exec.';
          msg.className = 'gcs-msg gcs-err';
          return;
        }
        if (!k) {
          msg.textContent = 'Enter the secret key.';
          msg.className = 'gcs-msg gcs-err';
          return;
        }
        const firstTime = !getConfig();
        GM_setValue('appsScriptUrl', u);
        GM_setValue('secretKey', k);
        msg.textContent = 'Saved.';
        msg.className = 'gcs-msg gcs-ok';
        summary.textContent = 'Settings';
        rerender();
        if (firstTime) sync({ force: true });
      },
    },
      h('label', { class: 'gcs-label' }, 'Apps Script web app URL', url),
      h('label', { class: 'gcs-label' }, 'Secret key', key),
      h('div', { class: 'gcs-row' }, h('button', { class: 'gcs-btn', type: 'submit' }, 'Save'), msg),
      h('label', { class: 'gcs-check-label' }, showTodo, ' Show to-do on the Gradescope home page'));

    return h('details', { class: 'gcs-settings', open: !cfg.url }, summary, form);
  }

  function buildPanel() {
    panelStatus = h('div', { class: 'gcs-sync' });
    panelTodo = h('div', { class: 'gcs-todo' });
    settingsEl = buildSettings();
    panel = h('div', { class: 'gcs-panel', role: 'dialog', 'aria-label': 'Gradescope to-do and calendar sync', hidden: true },
      h('div', { class: 'gcs-panel-head' },
        h('strong', null, 'Gradescope → Google Calendar'),
        h('button', { class: 'gcs-icon-btn', 'aria-label': 'Close', onclick: closePanel }, '×')),
      panelStatus, panelTodo, settingsEl);
    document.body.append(panel);
    todoRoots.add(panelTodo);
  }

  function renderPanelStatus() {
    if (!panelStatus) return;
    const cfg = getConfig();
    const last = GM_getValue('lastResult', null);
    let text;
    if (!cfg) text = 'Calendar sync isn\'t set up yet. Add your Apps Script URL and key below.';
    else if (state.syncing) text = 'Syncing…';
    else if (!last) text = 'Not synced yet.';
    else if (last.error) text = `Last sync failed (${timeAgo(last.time)}): ${last.error}`;
    else text = `Synced ${timeAgo(last.time)}: ${last.summary}`;
    panelStatus.replaceChildren(
      h('span', { class: 'gcs-sync-status' + (cfg && last?.error ? ' gcs-err' : '') }, text),
      h('button', { class: 'gcs-btn', disabled: !cfg || state.syncing, onclick: () => sync({ force: true }) },
        state.syncing ? 'Syncing…' : 'Sync now'));
  }

  function updateBadge() {
    if (!fabBadge) return;
    const last = GM_getValue('lastResult', null);
    let text = '';
    let title = 'Gradescope to-do and calendar sync';
    if (!getConfig()) {
      text = '!';
      title = 'Calendar sync needs setup';
    } else if (last?.error) {
      text = '!';
      title = 'Last calendar sync failed';
    } else if (state.assignments) {
      const { upcoming, missing } = categorize(state.assignments);
      const n = missing.length + upcoming.filter((a) => Date.parse(a.due) - Date.now() < 864e5).length;
      if (n) {
        text = String(n);
        title = `${n} due within 24 h or missing`;
      }
    }
    fabBadge.textContent = text;
    fabBadge.hidden = !text;
    fab.title = title;
  }

  function openPanel() {
    if (!panel) buildPanel();
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    rerender();
    const cache = GM_getValue('cache', null);
    if (!state.loading && (!cache || Date.now() - cache.time > CACHE_MAX_AGE_MIN * 60e3)) loadAssignments();
  }

  function closePanel() {
    if (!panel) return;
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
  }

  function mountFab() {
    fabBadge = h('span', { class: 'gcs-fab-badge', hidden: true });
    fab = h('button', {
      class: 'gcs-fab', 'aria-label': 'Open Gradescope to-do and calendar sync', 'aria-expanded': 'false',
      onclick: () => (panel && !panel.hidden ? closePanel() : openPanel()),
    }, '📅', fabBadge);
    document.body.append(fab);

    document.addEventListener('mousedown', (e) => {
      if (panel && !panel.hidden && !panel.contains(e.target) && !fab.contains(e.target)) closePanel();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel();
    });
  }

  function rerender() {
    for (const root of todoRoots) renderTodo(root);
    renderDashSummary();
    renderPanelStatus();
    updateBadge();
  }

  function toast(msg, isError = false) {
    const el = h('div', { class: 'gcs-toast' + (isError ? ' gcs-toast-err' : ''), role: 'status' }, msg);
    el.onclick = () => el.remove();
    document.body.append(el);
    setTimeout(() => el.remove(), isError ? 15000 : 6000);
  }

  function injectStyles() {
    document.head.append(h('style', null, `
      .gcs-fab, .gcs-panel, .gcs-dash, .gcs-toast { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2328; box-sizing: border-box; }
      .gcs-panel *, .gcs-dash *, .gcs-toast * { box-sizing: border-box; }
      /* Sits in Gradescope's left sidebar, just above the Account menu. */
      .gcs-fab { position: fixed; left: 20px; bottom: 84px; z-index: 2147483646; width: 48px; height: 48px; border-radius: 50%; border: none; background: #0f766e; color: #fff; font-size: 22px; box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
      .gcs-fab:hover { background: #115e59; }
      .gcs-fab:focus-visible, .gcs-panel button:focus-visible, .gcs-dash button:focus-visible, .gcs-item-main:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
      .gcs-fab-badge { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: #b3261e; color: #fff; font: 600 12px/20px system-ui, sans-serif; text-align: center; }
      .gcs-fab-badge[hidden], .gcs-panel[hidden] { display: none; }
      .gcs-panel { position: fixed; left: 16px; bottom: 144px; z-index: 2147483646; width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 160px); overflow: auto; background: #fff; border: 1px solid #d0d7de; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.2); }
      .gcs-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #eaeef2; position: sticky; top: 0; background: #fff; z-index: 1; }
      .gcs-sync { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #eaeef2; font-size: 13px; color: #57606a; }
      .gcs-sync-status { flex: 1; }
      .gcs-btn { flex: none; border: 1px solid #0f766e; background: #0f766e; color: #fff; border-radius: 6px; padding: 5px 12px; font: 600 13px system-ui, sans-serif; cursor: pointer; }
      .gcs-btn:hover:not(:disabled) { background: #115e59; }
      .gcs-btn:disabled { opacity: .5; cursor: default; }
      .gcs-icon-btn { border: none; background: none; color: #57606a; font-size: 18px; line-height: 1; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; padding: 0; flex: none; }
      .gcs-icon-btn:hover:not(:disabled) { background: #f0f3f6; color: #1f2328; }
      .gcs-link-btn { border: none; background: none; color: #0f766e; font: 600 13px system-ui, sans-serif; cursor: pointer; padding: 4px 6px; flex: none; }
      .gcs-todo-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px 0; border-bottom: 1px solid #eaeef2; }
      .gcs-tabs { display: flex; gap: 2px; }
      .gcs-tab { border: none; background: none; padding: 8px 10px; font: 600 13px system-ui, sans-serif; color: #57606a; border-bottom: 2px solid transparent; cursor: pointer; display: flex; align-items: center; gap: 6px; }
      .gcs-tab:hover { color: #1f2328; }
      .gcs-tab.gcs-on { color: #0f766e; border-bottom-color: #0f766e; }
      .gcs-count { background: #eaeef2; color: #1f2328; border-radius: 10px; padding: 0 7px; font-size: 12px; line-height: 18px; }
      .gcs-count-bad { background: #ffe1df; color: #a1251b; }
      .gcs-todo-body { padding: 4px 0 6px; }
      .gcs-group { padding: 10px 14px 2px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #57606a; }
      .gcs-list { list-style: none; margin: 0; padding: 0; }
      .gcs-item { display: flex; align-items: center; gap: 6px; padding: 0 8px 0 0; }
      .gcs-item:hover { background: #f6f8fa; }
      .gcs-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 7px 14px; text-decoration: none !important; color: inherit !important; border-radius: 6px; }
      .gcs-item-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .gcs-item-meta { font-size: 12.5px; color: #57606a; }
      .gcs-course { font-weight: 600; color: #0f766e; }
      .gcs-urgent { color: #a1251b; font-weight: 600; }
      .gcs-check { font-size: 15px; color: #8c959f; }
      .gcs-check:hover { color: #0f766e !important; background: #e6f4f1 !important; }
      .gcs-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 0 6px; border-radius: 4px; line-height: 17px; vertical-align: 1px; }
      .gcs-warn { background: #fff4d6; color: #7a4d00; }
      .gcs-bad { background: #ffe1df; color: #a1251b; }
      .gcs-empty { margin: 0; padding: 18px 14px; color: #57606a; text-align: center; }
      .gcs-foot { padding: 6px 14px 10px; font-size: 12px; color: #8c959f; }
      .gcs-err { color: #a1251b; }
      .gcs-ok { color: #1f6f43; }
      .gcs-settings { border-top: 1px solid #eaeef2; padding: 0 14px; }
      .gcs-settings summary { padding: 10px 0; font-weight: 600; cursor: pointer; color: #1f2328; }
      .gcs-form { display: flex; flex-direction: column; gap: 10px; padding-bottom: 14px; }
      .gcs-label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; font-weight: 600; color: #57606a; margin: 0; }
      .gcs-input { font: 13px system-ui, sans-serif; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; width: 100%; color: #1f2328; background: #fff; }
      .gcs-input:focus { outline: 2px solid #0f766e; outline-offset: -1px; border-color: #0f766e; }
      .gcs-row { display: flex; align-items: center; gap: 10px; }
      .gcs-msg { font-size: 12.5px; }
      .gcs-check-label { font-size: 13px; color: #1f2328; display: flex; align-items: center; gap: 6px; margin: 0; font-weight: normal; }
      .gcs-dash { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; margin: 0 0 24px; max-width: 760px; overflow: hidden; }
      .gcs-dash-title { margin: 0; padding: 6px 8px 0; font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
      .gcs-dash.gcs-collapsed .gcs-dash-title { padding-bottom: 6px; }
      .gcs-dash-toggle { border: none; background: none; font: 700 16px system-ui, sans-serif; color: #1f2328; padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; }
      .gcs-dash-toggle:hover { background: #f0f3f6; }
      .gcs-chevron { display: inline-block; font-size: 14px; color: #57606a; transition: transform .15s; }
      .gcs-collapsed .gcs-chevron { transform: rotate(-90deg); }
      .gcs-dash-summary { font-size: 13px; font-weight: 400; color: #57606a; }
      .gcs-dash:not(.gcs-collapsed) .gcs-dash-summary { display: none; }
      .gcs-dash .gcs-todo-body { max-height: 360px; overflow: auto; }
      .gcs-toast { position: fixed; left: 80px; bottom: 84px; z-index: 2147483647; max-width: 360px; padding: 10px 14px; border-radius: 8px; color: #fff; background: #1f6f43; box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: pointer; font-size: 13px; }
      .gcs-toast-err { background: #b3261e; }
    `));
  }

  // ---- Start ----
  GM_registerMenuCommand('📅 Open to-do & sync panel', openPanel);
  GM_registerMenuCommand('🔄 Sync now', () => sync({ force: true }));

  injectStyles();
  const cache = GM_getValue('cache', null);
  if (cache) {
    state.assignments = cache.assignments;
    state.updatedAt = cache.time;
  }
  mountFab();
  const onDashboard = mountDashboardTodo();
  rerender();

  // First run: open the panel so the setup form is right there.
  if (!getConfig() && !GM_getValue('setupPrompted', false)) {
    GM_setValue('setupPrompted', true);
    openPanel();
  }

  (async () => {
    // Only read Gradescope on load if the home-page to-do needs it; sync() reads it when it's due.
    if (onDashboard) await loadAssignments();
    sync();
  })();
})();
