# Gradescope → Google Calendar Sync

Tampermonkey script that copies Gradescope due dates into Google Calendar whenever you open Gradescope, and adds a to-do list (upcoming / missing / done) to the home page.

## Setup

**Apps Script**

1. Create a new project at [script.google.com](https://script.google.com) and paste in [apps-script/Code.gs](apps-script/Code.gs).
2. Set `SECRET_KEY` to some random string.
3. Run the `authorize` function and allow Calendar access (Advanced → Go to project, since it's unverified).
4. Deploy → New deployment → Web app, execute as Me, access Anyone. Copy the `/exec` URL.

**Userscript**

1. Add [gradescope-gcal-sync.user.js](gradescope-gcal-sync.user.js) to Tampermonkey. On Chrome, enable "Allow User Scripts" for Tampermonkey in `chrome://extensions`.
2. Open Gradescope, click the 📅 button in the bottom left, and enter the URL and key under Settings.

## Notes

- Click ✓ on an assignment to mark it done yourself (useful for exams).
- After editing Code.gs, deploy it as a new version under Manage deployments, or the changes won't take effect.
- "Wrong secret key" means the keys don't match. "Unexpected response" usually means the URL is wrong or access isn't set to Anyone.
- If the to-do is empty while you're logged in, Gradescope probably changed its HTML. Check `getCourses` and `parseAssignments`.
