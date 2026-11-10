# 40K Inventory

A personal Warhammer 40,000 collection tracker. It lists the 10th and 11th edition units for every army and
lets you record how many models of each you own as NIB (new in box), NOS (new on sprue), Built or Painted,
plus how many are Damaged, with notes and photos. It runs in any browser, installs to an iPhone home screen,
works offline, and syncs to your own Google Drive.

Unofficial fan-made tool. Not affiliated with or endorsed by Games Workshop.

## Try it on this PC

```
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open <http://localhost:8040/>. Without Google Drive set up, data is saved in that browser only.

## One-time setup

### 1. Put the app online (GitHub Pages, free)

1. Sign in at <https://github.com> and create a new **public** repository called `wh40k-inventory`.
2. On the repository page choose **Add file > Upload files**, drag in everything inside this folder and commit.
3. Go to **Settings > Pages**, set **Source** to "Deploy from a branch", branch `main`, folder `/ (root)`, and save.
4. After a minute the app is live at `https://YOUR-USERNAME.github.io/wh40k-inventory/`.

### 2. Let the app save to your Google Drive

1. Open <https://console.cloud.google.com/>, create a project (any name), then enable the **Google Drive API**
   under **APIs & Services > Library**.
2. Under **Google Auth Platform** (OAuth consent screen): fill in the app name and your email, choose
   **External**, and add yourself as a test user (or publish the app; the Drive scope it uses needs no review).
3. Under **Clients**, create an **OAuth client ID** of type **Web application** and add:
   - Authorised JavaScript origins: `https://YOUR-USERNAME.github.io` and `http://localhost:8040`
   - Authorised redirect URIs: `https://YOUR-USERNAME.github.io/wh40k-inventory/` and `http://localhost:8040/`
     (the exact address is also shown in the app under Settings)
4. Copy the client ID into `config.js` (`googleClientId: '...'`) and upload that file to GitHub again.
5. Open the app, tap **Connect Drive**, and sign in. Do the same once on each device.

The app asks only for permission to manage files it creates itself. Your collection lives in
`WH40K Inventory/wh40k-collection.json` in your Drive, alongside any photos you add.

### 3. Install on the iPhone

Open the GitHub Pages address in Safari, tap **Share > Add to Home Screen**, then open it from the icon and
tap **Connect Drive**.

## How syncing behaves

- Every change is saved on the device straight away and pushed to Drive a few seconds later.
- Opening the app pulls the latest copy. If the phone and PC both changed things, the newest edit to each unit wins.
- Google sign-ins last about an hour; the app renews them by itself when it can, otherwise the pill at the top
  shows **Connect Drive** and one tap reconnects.
- Adding photos needs a connection; everything else works offline.
- **Settings > Export to file** makes a manual backup at any time.

## Updating the unit list

`tools\build-catalog.ps1` rebuilds `catalog.js` from the community BSData files (the `wh40k-10e` catalogues and
the `wh40k-11e-mfm` points list). Legends units are left out. Counts you have recorded are keyed by army and
unit name, so they survive a rebuild.
