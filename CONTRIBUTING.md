# ENCM Volunteer Kiosk: developer quick start

## Prerequisites
- Git, Node 22, and pnpm 10 (`npm install -g pnpm`). If you use mise, `mise install` picks up the versions in `.mise.toml`.
- A Google account with **Editor** access to the kiosk's Apps Script project. Ask the project owner to share it with you.
- Turn on the Apps Script API for that account at https://script.google.com/home/usersettings

## 1. Clone and install
```
git clone https://github.com/encm-volunteer-kiosk/volunteer-check-in.git
cd volunteer-check-in
pnpm install
npm install -g @google/clasp
```

## 2. Work locally
```
pnpm dev     # front end only, with fake volunteers kept in the browser (Shift+D opens test tools)
pnpm test    # server logic and kiosk tests (Node)
```
- Front end (React + Tailwind): `src/`
- Back end (Google Apps Script): `apps-script/`
- Full docs: `README.md`

## 3. Sign in to clasp
```
clasp login
```
If more than one Google account is signed in to your browser, open the login link in an incognito window and sign in with only the account that has Editor access. Otherwise the push fails with "Drive ACL permission denied".

## 4. Push code to Apps Script
```
pnpm push    # builds the kiosk into apps-script/Index.html, then runs clasp push
```
- `.clasp.json` (committed) sets which script you push to.
- A push **replaces the whole remote project**. Always edit code in the repo, never in the online Apps Script editor.
- After a push, the Sheet's **Kiosk admin** menu and the `/dev` URL run the new code right away.

## 5. Deploy to the live kiosk (`/exec` URL)
```
clasp deployments                                  # find the web app's deployment ID (the one with a version number, not @HEAD)
clasp deploy -i <deployment-id> -d "What changed"  # point it at a new version; the URL stays the same
```
Or in the Apps Script editor: **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**.

Then reload the kiosk on the iPad.

## 6. If the Log's columns changed
Run `setupSheets` from the Apps Script editor *after* deploying (see "Updating a sheet that's already in use" in the README).

## 7. Commit
```
git checkout -b my-change
git add -A && git commit -m "Describe the change"
git push -u origin my-change   # then open a pull request
```
