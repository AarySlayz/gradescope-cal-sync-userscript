// ==UserScript==
// @name         Gradescope → Google Calendar Sync
// @namespace    gradescope-gcal-sync
// @version      1.0.0
// @description  Syncs your Gradescope due dates to Google Calendar whenever you open Gradescope.
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

  // ---- Config (Apps Script URL + secret key, stored in Tampermonkey) ----
  function getConfig({ reset = false } = {}) {
    let url = reset ? '' : GM_getValue('appsScriptUrl', '');
    let key = reset ? '' : GM_getValue('secretKey', '');
    if (!url) {
      url = (prompt('Gradescope → GCal: paste your Apps Script web app URL (ends in /exec):', GM_getValue('appsScriptUrl', '')) || '').trim();
      if (!url) return null;
      GM_setValue('appsScriptUrl', url);
    }
    if (!key) {
      key = (prompt('Gradescope → GCal: paste the SECRET_KEY you set in Code.gs:', GM_getValue('secretKey', '')) || '').trim();
      if (!key) return null;
      GM_setValue('secretKey', key);
    }
    return { url, key };
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
    const cutoff = Date.now() - LOOKBACK_DAYS * 864e5;
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
      if (!due || due.getTime() < cutoff) continue;

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
    const courses = getCourses(await fetchDoc('/'));
    if (!courses.length) return null;
    const all = [];
    for (const course of courses) {
      all.push(...parseAssignments(await fetchDoc(`/courses/${course.id}`), course));
    }
    return all;
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

  // ---- UI ----
  function toast(msg, isError = false) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
      maxWidth: '360px', padding: '10px 14px', borderRadius: '8px',
      font: '13px/1.4 system-ui, sans-serif', color: '#fff',
      background: isError ? '#b3261e' : '#1f6f43', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
      cursor: 'pointer',
    });
    el.onclick = () => el.remove();
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isError ? 15000 : 6000);
  }

  // ---- Main ----
  async function sync({ force = false } = {}) {
    if (!force && Date.now() - GM_getValue('lastSync', 0) < SYNC_INTERVAL_MIN * 60e3) return;
    const cfg = getConfig();
    if (!cfg) return;
    // Claim the slot up front so other Gradescope tabs opened meanwhile don't sync too.
    GM_setValue('lastSync', Date.now());

    try {
      const assignments = await scrapeAll();
      if (!assignments) {
        // Probably logged out; try again next time a page loads.
        GM_setValue('lastSync', 0);
        if (force) toast('Gradescope → GCal: no courses found. Are you logged in?', true);
        return;
      }
      const r = await post(cfg.url, { key: cfg.key, assignments });
      const summary = `${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged`;
      console.log(`[Gradescope → GCal] ${summary}`);
      if (force || r.created || r.updated) toast(`📅 Gradescope → GCal: ${summary}`);
    } catch (e) {
      console.error('[Gradescope → GCal]', e);
      toast(`Gradescope → GCal sync failed: ${e.message}`, true);
    }
  }

  GM_registerMenuCommand('🔄 Sync now', () => sync({ force: true }));
  GM_registerMenuCommand('👀 Preview scraped assignments', async () => {
    try {
      const a = await scrapeAll();
      console.table(a || []);
      alert(a ? `Found ${a.length} upcoming assignments. Full list is in the console (F12).` +
        (a.length ? '\n\n' + a.map((x) => `${x.course}: ${x.title} (${new Date(x.due).toLocaleString()})`).join('\n') : '')
        : 'No courses found. Are you logged in?');
    } catch (e) {
      alert(`Scrape failed: ${e.message}`);
    }
  });
  GM_registerMenuCommand('⚙️ Change Apps Script URL / key', () => getConfig({ reset: true }));

  sync();
})();
