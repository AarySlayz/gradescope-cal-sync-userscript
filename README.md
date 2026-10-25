# Gradescope → Google Calendar Sync

Every time you open Gradescope (at most once per 30 min), a Tampermonkey userscript reads the due dates in your current courses. It sends them to a small Google Apps Script running under your own Google account, which creates or updates one calendar event per assignment.

- **New assignment** → a new event, ending at the due time.
- **Due date changed / extension** → the event is moved.
- **You submitted** → the title gets a ✅ prefix.
- **Late due date** → listed in the event description.

## One-time setup (~5 min)

### 1. Apps Script (the calendar side)
1. Go to <https://script.google.com> → **New project**. Name it "Gradescope Sync".
2. Replace the contents of `Code.gs` with [apps-script/Code.gs](apps-script/Code.gs).
3. Change `SECRET_KEY` to a long random string. (Optional: set `CALENDAR_ID` to a dedicated "Gradescope" calendar.)
4. Choose the `authorize` function in the toolbar dropdown → **Run** → grant Calendar access.
   Google will show "Google hasn't verified this app". That's expected because it's your own script: click **Advanced → Go to Gradescope Sync (unsafe)** → **Allow**.
5. **Deploy → New deployment** → gear icon → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (the secret key is what protects it)
6. Copy the **Web app URL** (ends in `/exec`). Opening it in a browser should show `"ok": true`.

### 2. Userscript (the Gradescope side)
1. In Tampermonkey: **Create a new script**, paste [gradescope-gcal-sync.user.js](gradescope-gcal-sync.user.js), and save.
   On Chrome, also turn on **Allow User Scripts** for Tampermonkey in `chrome://extensions` → Tampermonkey → Details.
2. Open <https://www.gradescope.com>. A **📅 button** appears in the bottom-right corner, and the first time its panel opens on its own with a **Set up calendar sync** form:
   1. **Apps Script web app URL**: paste the Web app URL from step 1.6 (it looks like `https://script.google.com/macros/s/AKfy…/exec`).
   2. **Secret key**: paste the exact string you set as `SECRET_KEY` in step 1.3.
   3. Click **Save**. The first sync starts right away, and a green popup shows how many events were created.

   You don't edit the userscript file for these. Tampermonkey saves both values.
3. Check the **Upcoming** tab in the panel to confirm it found your assignments.

**To change the URL or key later** (for example, after making a new deployment instead of a new version, or changing `SECRET_KEY`): click **📅 → Settings**, update the fields, and click **Save**.

**If sync fails with "Wrong secret key"**, the key in Tampermonkey doesn't exactly match `SECRET_KEY` in Code.gs. Check for extra spaces, or make sure you deployed a new version after changing it. **If it fails with "Unexpected response"**, the URL is wrong or the deployment's access isn't set to **Anyone**.

After that it's automatic.

## Using it

**The 📅 button** (on every Gradescope page) opens a panel with:
- the last sync result and a **Sync now** button
- your to-do list
- **Settings**: Apps Script URL, secret key, and whether to show the to-do on the home page

A red number on the button counts work that's missing or due within 24 hours. A **!** means sync needs setup or the last sync failed.

**The to-do list** also appears at the top of the Gradescope home page, similar to Google Classroom's to-do:
- **Upcoming**: unsubmitted work, grouped into Today / Tomorrow / This week / Later. Times within 24 hours show in red.
- **Missing**: past-due work you haven't submitted. **Late OK** means the late deadline hasn't passed yet. **Missing** means it's fully closed.
- **Done**: work submitted in the last 14 days.

Click an assignment to open it. Click **✓** to mark something done yourself, which is useful for in-class exams or optional work that never shows "Submitted". It moves to Done, gets a ✅ on your calendar at the next sync, and can be undone from the Done tab. Use **↻** to re-read Gradescope right away; otherwise the list refreshes every 5 minutes.

## Notes
- **Editing Code.gs later:** do **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same. Just saving doesn't update the live web app.
- **Settings** are at the top of each file: sync interval, lookback window, event length, ✅ marking.
- **Deleted assignments** are left alone on your calendar. If you delete an event yourself, the next sync recreates it.
- **If the to-do finds 0 assignments** while you're logged in, Gradescope probably changed its page layout. The selectors are in `getCourses` / `parseAssignments`.
