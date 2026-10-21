/**
 * Gradescope → Google Calendar relay.
 * Deploy as a web app (Execute as: Me, Who has access: Anyone). The userscript
 * POSTs scraped assignments here; this creates/updates the matching events.
 */

// ---- Settings ----
const SECRET_KEY = 'CHANGE-ME-to-a-long-random-string'; // must match what you enter in the userscript
const CALENDAR_ID = 'primary';  // or a dedicated calendar's ID (Calendar settings → Integrate calendar)
const EVENT_MINUTES = 30;       // event ends at the due time and starts this many minutes earlier
const MARK_SUBMITTED = true;    // prefix the title with ✅ once you've submitted

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Bad JSON' });
  }
  if (body.key !== SECRET_KEY) return json({ ok: false, error: 'Wrong secret key' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json({ ok: false, error: 'Another sync is running' });
  try {
    return json(Object.assign({ ok: true }, syncAssignments(body.assignments || [])));
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Visiting the /exec URL in a browser should show this, which confirms the deployment works.
function doGet() {
  return json({ ok: true, message: 'Gradescope → GCal relay is running.' });
}

function syncAssignments(assignments) {
  const cal = CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error('Calendar not found: ' + CALENDAR_ID);

  // Maps Gradescope assignment id → calendar event id, one property per assignment.
  const props = PropertiesService.getScriptProperties();
  const map = props.getProperties();
  const newMappings = {};
  const counts = { created: 0, updated: 0, unchanged: 0 };

  for (const a of assignments) {
    const end = new Date(a.due);
    if (isNaN(end)) continue;
    const start = new Date(end.getTime() - EVENT_MINUTES * 60000);
    const title = (MARK_SUBMITTED && a.submitted ? '✅ ' : '') + '[' + a.course + '] ' + a.title;
    const description = [
      'Due: ' + formatDate(end),
      a.lateDue ? 'Late due: ' + formatDate(new Date(a.lateDue)) : null,
      a.status ? 'Status: ' + a.status : null,
      a.url,
      '',
      '(Synced from Gradescope. Edits here get overwritten.)',
    ].filter(function (x) { return x !== null; }).join('\n');

    const eventId = map['gs:' + a.id];
    const ev = eventId ? cal.getEventById(eventId) : null;
    if (!ev) {
      const created = cal.createEvent(title, start, end, { description: description });
      newMappings['gs:' + a.id] = created.getId();
      counts.created++;
      continue;
    }

    let changed = false;
    if (ev.getStartTime().getTime() !== start.getTime() || ev.getEndTime().getTime() !== end.getTime()) {
      ev.setTime(start, end);
      changed = true;
    }
    if (ev.getTitle() !== title) { ev.setTitle(title); changed = true; }
    if (ev.getDescription() !== description) { ev.setDescription(description); changed = true; }
    changed ? counts.updated++ : counts.unchanged++;
  }

  if (Object.keys(newMappings).length) props.setProperties(newMappings);
  return counts;
}

function formatDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "EEE MMM d, h:mm a z");
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run this once from the editor to grant Calendar access before deploying.
function authorize() {
  const cal = CALENDAR_ID === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(CALENDAR_ID);
  Logger.log('Authorized. Syncing to calendar: ' + cal.getName());
}

// Forgets which events belong to which assignments. Next sync then creates fresh events,
// so delete the old ones first if you don't want duplicates.
function resetMappings() {
  PropertiesService.getScriptProperties().deleteAllProperties();
}
