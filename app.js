(() => {
  'use strict';

  // ------------------------------------------------------------------ setup
  const CFG = window.APP_CONFIG || {};
  const CATALOG = window.CATALOG || { armies: [] };
  const STAGES = [
    { k: 'nib', label: 'NIB', long: 'New in box' },
    { k: 'nos', label: 'NOS', long: 'New on sprue' },
    { k: 'built', label: 'Built', long: 'Assembled, unpainted' },
    { k: 'painted', label: 'Painted', long: 'Finished' }
  ];
  const ROLE_ORDER = ['Epic Heroes', 'Characters', 'Battleline', 'Infantry', 'Mounted', 'Beasts & Swarms',
    'Monsters', 'Vehicles', 'Transports', 'Aircraft', 'Fortifications', 'Other'];
  const SIDES = ['Imperium', 'Chaos', 'Xenos'];

  const DRIVE_FOLDER = 'WH40K Inventory';
  const DRIVE_FILE = 'wh40k-collection.json';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const LS = {
    state: 'wh40k.state', clientId: 'wh40k.clientId', token: 'wh40k.token', tokenExp: 'wh40k.tokenExp',
    connected: 'wh40k.connected', folderId: 'wh40k.folderId', fileId: 'wh40k.fileId',
    oauthState: 'wh40k.oauthState', silentTry: 'wh40k.silentTry', lastSync: 'wh40k.lastSync',
    armyScope: 'wh40k.armyScope'
  };

  const unitIndex = new Map();   // "army/unit" -> { army, unit }
  for (const army of CATALOG.armies) {
    for (const unit of army.units) unitIndex.set(army.id + '/' + unit.id, { army, unit });
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }
  };

  let state = { version: 1, updatedAt: 0, units: {} };
  const ui = { armyId: null, search: '', filter: 'all', edition: 'all', armyScope: ls.get(LS.armyScope) || 'all' };
  let syncState = 'off';
  let authError = '';

  // ------------------------------------------------------- local persistence
  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('wh40k-inventory', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => reject(req.error);
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const req = db.transaction('kv').objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async set(key, value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };

  async function loadLocal() {
    let saved = null;
    try { saved = await idb.get('state'); } catch (e) { /* fall through */ }
    if (!saved) { try { saved = JSON.parse(ls.get(LS.state) || 'null'); } catch (e) { saved = null; } }
    if (saved && saved.units) state = normalizeState(saved);
  }

  let saveTimer = 0;
  function saveLocalSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocal, 250);
  }
  async function saveLocal() {
    clearTimeout(saveTimer);
    try { await idb.set('state', state); }
    catch (e) { ls.set(LS.state, JSON.stringify(state)); }
  }

  // ------------------------------------------------------------- data model
  function blankEntry() {
    return { c: { nib: 0, nos: 0, built: 0, painted: 0 }, d: 0, notes: '', photos: [], t: 0 };
  }
  function normalizeEntry(e) {
    const out = blankEntry();
    if (!e || typeof e !== 'object') return out;
    for (const s of STAGES) out.c[s.k] = clampInt(e.c && e.c[s.k]);
    out.d = Math.min(clampInt(e.d), totalOf(out));
    out.notes = typeof e.notes === 'string' ? e.notes : '';
    out.photos = Array.isArray(e.photos) ? e.photos.filter((p) => p && p.id) : [];
    out.t = Number(e.t) || 0;
    return out;
  }
  function normalizeState(s) {
    const out = { version: 1, updatedAt: Number(s.updatedAt) || 0, units: {} };
    for (const k of Object.keys(s.units || {})) out.units[k] = normalizeEntry(s.units[k]);
    return out;
  }
  function clampInt(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(9999, n)) : 0;
  }
  function totalOf(e) { return e ? e.c.nib + e.c.nos + e.c.built + e.c.painted : 0; }
  function entryFor(key) { return state.units[key] || blankEntry(); }
  function hasContent(e) { return !!e && (totalOf(e) > 0 || e.notes.trim() !== '' || e.photos.length > 0); }

  function touch(key, entry) {
    entry.d = Math.min(entry.d, totalOf(entry));
    entry.t = Date.now();
    state.units[key] = entry;
    state.updatedAt = entry.t;
    saveLocalSoon();
    scheduleSync(2500);
  }

  function totals(filterFn) {
    const t = { nib: 0, nos: 0, built: 0, painted: 0, damaged: 0, total: 0, units: 0 };
    for (const key of Object.keys(state.units)) {
      const ref = unitIndex.get(key);
      if (!ref || (filterFn && !filterFn(ref))) continue;
      const e = state.units[key];
      const n = totalOf(e);
      if (!n) continue;
      for (const s of STAGES) t[s.k] += e.c[s.k];
      t.damaged += e.d; t.total += n; t.units += 1;
    }
    return t;
  }

  // Last-write-wins per unit, so edits made on the phone and the PC both survive.
  function mergeStates(local, remote) {
    const out = { version: 1, updatedAt: 0, units: {} };
    let localChanged = false;
    let remoteStale = !remote;
    const r = (remote && remote.units) || {};
    for (const k of new Set([...Object.keys(local.units), ...Object.keys(r)])) {
      const a = local.units[k];
      const b = r[k];
      if (a && (!b || (a.t || 0) > (Number(b.t) || 0))) { out.units[k] = a; remoteStale = true; }
      else if (b && (!a || (Number(b.t) || 0) > (a.t || 0))) { out.units[k] = normalizeEntry(b); localChanged = true; }
      else out.units[k] = a;
      out.updatedAt = Math.max(out.updatedAt, out.units[k].t || 0);
    }
    return { merged: out, localChanged, remoteStale };
  }

  // ---------------------------------------------------------- Google sign-in
  function clientId() { return String(CFG.googleClientId || ls.get(LS.clientId) || '').trim(); }
  function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  function token() { return Number(ls.get(LS.tokenExp)) > Date.now() ? ls.get(LS.token) : null; }
  function clearToken() { ls.del(LS.token); ls.del(LS.tokenExp); }

  function startAuth(silent) {
    if (!clientId()) { openSettings(); return; }
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    ls.set(LS.oauthState, st);
    const p = new URLSearchParams({
      client_id: clientId(), redirect_uri: redirectUri(), response_type: 'token',
      scope: SCOPE, state: st, include_granted_scopes: 'true'
    });
    if (silent) { p.set('prompt', 'none'); ls.set(LS.silentTry, String(Date.now())); }
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
  }

  // Google sends the sign-in result back in the URL fragment.
  function consumeAuthHash() {
    const h = location.hash.replace(/^#/, '');
    if (!/(^|&)(access_token|error)=/.test(h)) return;
    const p = new URLSearchParams(h);
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('state') !== ls.get(LS.oauthState)) return;
    ls.del(LS.oauthState);
    if (p.get('access_token')) {
      const secs = Number(p.get('expires_in')) || 3600;
      ls.set(LS.token, p.get('access_token'));
      ls.set(LS.tokenExp, String(Date.now() + (secs - 90) * 1000));
      ls.set(LS.connected, '1');
    } else {
      const err = p.get('error') || '';
      // "interaction_required" style errors just mean a silent refresh was not possible.
      if (!/required|login/.test(err)) authError = err;
    }
  }

  function needAuth() {
    setSync('auth');
    const lastTry = Number(ls.get(LS.silentTry)) || 0;
    const busy = document.querySelector('dialog[open]');
    if (ls.get(LS.connected) && !busy && Date.now() - lastTry > 10 * 60 * 1000) startAuth(true);
  }

  function disconnect() {
    clearToken();
    for (const k of [LS.connected, LS.folderId, LS.fileId, LS.lastSync, LS.silentTry]) ls.del(k);
    setSync(clientId() ? 'auth' : 'off');
  }

  // ------------------------------------------------------------ Google Drive
  class AuthError extends Error {}

  async function gfetch(url, opts = {}) {
    const tk = token();
    if (!tk) throw new AuthError('Not signed in');
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + tk } });
    if (res.status === 401) { clearToken(); throw new AuthError('Sign-in expired'); }
    if (!res.ok) {
      const err = new Error('Google Drive error ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async function driveFind(q) {
    const url = API + '/files?spaces=drive&pageSize=5&fields=files(id,name)&q=' + encodeURIComponent(q);
    const data = await (await gfetch(url)).json();
    return data.files && data.files[0] ? data.files[0].id : null;
  }

  async function ensureFolder() {
    let id = ls.get(LS.folderId);
    if (id) return id;
    id = await driveFind(`name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    if (!id) {
      const res = await gfetch(API + '/files?fields=id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' })
      });
      id = (await res.json()).id;
    }
    ls.set(LS.folderId, id);
    return id;
  }

  async function uploadNew(name, folderId, blob) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name, parents: [folderId] })], { type: 'application/json' }));
    form.append('file', blob);
    const res = await gfetch(UPLOAD + '/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
    return (await res.json()).id;
  }

  let syncing = false;
  let syncQueued = false;
  let syncTimer = 0;

  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay);
  }

  async function sync(retried) {
    clearTimeout(syncTimer);
    if (!clientId()) return setSync('off');
    if (!navigator.onLine) return setSync('offline');
    if (!token()) return needAuth();
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    setSync('syncing');
    let retry = false;
    try {
      const folderId = await ensureFolder();
      let fileId = ls.get(LS.fileId) || await driveFind(`name='${DRIVE_FILE}' and '${folderId}' in parents and trashed=false`);
      let remote = null;
      if (fileId) remote = await (await gfetch(`${API}/files/${fileId}?alt=media`)).json();
      // No awaits between reading `state` and replacing it, so edits made mid-sync are never lost.
      const { merged, localChanged, remoteStale } = mergeStates(state, remote);
      state = merged;
      const body = new Blob([JSON.stringify(merged)], { type: 'application/json' });
      if (localChanged) { await saveLocal(); render(); }
      if (!fileId) fileId = await uploadNew(DRIVE_FILE, folderId, body);
      else if (remoteStale) {
        await gfetch(`${UPLOAD}/files/${fileId}?uploadType=media`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
        });
      }
      ls.set(LS.fileId, fileId);
      ls.set(LS.lastSync, String(Date.now()));
      setSync('ok');
    } catch (e) {
      if (e instanceof AuthError) needAuth();
      else if (e.status === 404 && !retried) { ls.del(LS.fileId); ls.del(LS.folderId); retry = true; }
      else { console.error(e); setSync(navigator.onLine ? 'error' : 'offline'); }
    } finally {
      syncing = false;
    }
    if (retry) return sync(true);
    if (syncQueued) { syncQueued = false; scheduleSync(500); }
  }

  function setSync(s) {
    syncState = s;
    const pill = $('#syncPill');
    const labels = {
      off: 'Local only', offline: 'Offline', auth: 'Connect Drive', syncing: 'Syncing…', ok: 'Synced', error: 'Sync error'
    };
    pill.dataset.state = s;
    pill.textContent = labels[s] || s;
    if ($('#settingsDialog').open) renderSettings();
  }

  // ------------------------------------------------------------------ photos
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      img.src = url;
    });
  }
  function scaled(img, maxSide, quality, asDataUrl) {
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    if (asDataUrl) return Promise.resolve(cv.toDataURL('image/jpeg', quality));
    return new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', quality));
  }

  async function addPhotos(key, files) {
    if (!files.length) return;
    if (!clientId() || !token() || !navigator.onLine) {
      toast('Photos are stored in Google Drive. Connect Drive (and be online) to add them.');
      return;
    }
    const ref = unitIndex.get(key);
    let added = 0;
    for (const file of files) {
      try {
        toast('Uploading photo…', 60000);
        const img = await loadImage(file);
        const blob = await scaled(img, 1600, 0.85, false);
        const thumb = await scaled(img, 220, 0.7, true);
        const folderId = await ensureFolder();
        const name = `${ref ? ref.unit.n : 'photo'} ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.jpg`;
        const id = await uploadNew(name, folderId, blob);
        const entry = normalizeEntry(state.units[key]);
        entry.photos.push({ id, thumb, at: Date.now() });
        touch(key, entry);
        added += 1;
        if (currentKey === key) renderUnitDialog();
      } catch (e) {
        console.error(e);
        if (e instanceof AuthError) { toast('Google sign-in expired. Reconnect Drive and try again.'); needAuth(); return; }
        toast('Photo upload failed: ' + e.message);
        return;
      }
    }
    if (added) toast(added === 1 ? 'Photo saved to Drive' : added + ' photos saved to Drive');
  }

  async function photoBlob(id) {
    const cacheKey = '/__photo__/' + id;
    let cache = null;
    try { cache = await caches.open('wh40k-inventory-photos'); } catch (e) { cache = null; }
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit.blob();
    }
    const res = await gfetch(`${API}/files/${id}?alt=media`);
    const blob = await res.blob();
    if (cache) { try { await cache.put(cacheKey, new Response(blob)); } catch (e) { /* cache full */ } }
    return blob;
  }

  let viewerUrl = '';
  async function openPhoto(key, photoId) {
    const dlg = $('#photoDialog');
    const entry = entryFor(key);
    const photo = entry.photos.find((p) => p.id === photoId);
    if (!photo) return;
    dlg.innerHTML = `
      <div class="pv-bar">
        <button class="btn danger" data-act="photo-delete" type="button">Delete</button>
        <button class="btn" data-act="photo-close" type="button">Close</button>
      </div>
      <div class="pv-body"><img alt="Photo of ${esc(unitName(key))}" src="${esc(photo.thumb)}"></div>`;
    dlg.dataset.key = key;
    dlg.dataset.photo = photoId;
    dlg.showModal();
    try {
      const blob = await photoBlob(photoId);
      if (dlg.dataset.photo !== photoId || !dlg.open) return;
      if (viewerUrl) URL.revokeObjectURL(viewerUrl);
      viewerUrl = URL.createObjectURL(blob);
      $('img', dlg).src = viewerUrl;
    } catch (e) { /* keep showing the thumbnail when offline or signed out */ }
  }

  async function deletePhoto(key, photoId) {
    if (!confirm('Delete this photo? It will also be moved to the bin in Google Drive.')) return;
    const entry = normalizeEntry(state.units[key]);
    entry.photos = entry.photos.filter((p) => p.id !== photoId);
    touch(key, entry);
    $('#photoDialog').close();
    if (currentKey === key) renderUnitDialog();
    try {
      await gfetch(`${API}/files/${photoId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
      });
    } catch (e) { toast('Removed here; could not remove the file in Drive (delete it there manually).'); }
  }

  // --------------------------------------------------------------- rendering
  function unitName(key) { const ref = unitIndex.get(key); return ref ? ref.unit.n : key; }

  function barHtml(t, mini) {
    if (!t.total) return `<div class="bar${mini ? ' mini' : ''}"></div>`;
    const segs = STAGES.filter((s) => t[s.k] > 0)
      .map((s) => `<span class="seg-${s.k}" style="width:${(t[s.k] / t.total * 100).toFixed(2)}%"></span>`).join('');
    return `<div class="bar${mini ? ' mini' : ''}" role="img" aria-label="${esc(STAGES.map((s) => `${t[s.k]} ${s.label}`).join(', '))}">${segs}</div>`;
  }

  function summaryHtml(t, label) {
    const pct = t.total ? Math.round(t.painted / t.total * 100) : 0;
    return `
      <section class="summary">
        <div class="summary-head">
          <div class="summary-total">${t.total} <small>models in ${t.units} unit${t.units === 1 ? '' : 's'}${label ? ' · ' + esc(label) : ''}</small></div>
          <div class="kv">${pct}% painted</div>
        </div>
        ${barHtml(t, false)}
        <div class="legend">
          ${STAGES.map((s) => `<span><i class="dot ${s.k}"></i>${s.label} <b>${t[s.k]}</b></span>`).join('')}
          <span><i class="dot damaged"></i>Damaged <b>${t.damaged}</b></span>
        </div>
      </section>`;
  }

  function unitRowHtml(key, showArmy) {
    const { army, unit } = unitIndex.get(key);
    const e = state.units[key];
    const n = totalOf(e);
    const tags = [];
    if (e) {
      for (const s of STAGES) if (e.c[s.k]) tags.push(`<span class="tag ${s.k}">${e.c[s.k]} ${s.label}</span>`);
      if (e.d) tags.push(`<span class="tag damaged">${e.d} damaged</span>`);
      if (e.photos.length) tags.push(`<span class="tag extra">${e.photos.length} photo${e.photos.length === 1 ? '' : 's'}</span>`);
      if (e.notes.trim()) tags.push('<span class="tag extra">note</span>');
    }
    const sub = [showArmy ? army.name : '', unit.g || ''].filter(Boolean).join(' · ');
    return `
      <button class="unit${n ? ' owned' : ''}" type="button" data-act="unit" data-key="${esc(key)}">
        <span class="unit-name">${esc(unit.n)}${unit.e.map((x) => `<span class="ed">${x}th</span>`).join('')}
          ${sub ? `<span class="unit-sub">${esc(sub)}</span>` : ''}</span>
        <span class="tags">${tags.join('')}</span>
      </button>`;
  }

  function matchesFilters(key) {
    const { unit } = unitIndex.get(key);
    const e = state.units[key];
    if (ui.edition !== 'all' && !unit.e.includes(Number(ui.edition))) return false;
    if (ui.search && !unit.n.toLowerCase().includes(ui.search.toLowerCase())) return false;
    switch (ui.filter) {
      case 'owned': return totalOf(e) > 0;
      case 'unowned': return totalOf(e) === 0;
      case 'damaged': return !!e && e.d > 0;
      case 'nib': case 'nos': case 'built': case 'painted': return !!e && e.c[ui.filter] > 0;
      default: return true;
    }
  }

  function chipsHtml() {
    const filters = [['all', 'All'], ['owned', 'Owned'], ['unowned', 'Not owned'], ['nib', 'NIB'], ['nos', 'NOS'],
      ['built', 'Built'], ['painted', 'Painted'], ['damaged', 'Damaged']];
    const eds = [['all', 'Both editions'], ['10', '10th'], ['11', '11th']];
    return `
      <div class="chips" role="group" aria-label="Status filter">
        ${filters.map(([v, l]) => `<button class="chip" type="button" data-act="filter" data-v="${v}" aria-pressed="${ui.filter === v}">${l}</button>`).join('')}
      </div>
      <div class="chips" role="group" aria-label="Edition filter">
        ${eds.map(([v, l]) => `<button class="chip" type="button" data-act="edition" data-v="${v}" aria-pressed="${ui.edition === v}">${l}</button>`).join('')}
      </div>`;
  }

  function searchHtml(placeholder) {
    return `<div class="controls"><input id="search" class="search" type="search" placeholder="${esc(placeholder)}"
      value="${esc(ui.search)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${esc(placeholder)}"></div>`;
  }

  function renderHome() {
    const t = totals();
    let body = '';
    if (ui.search.trim()) {
      const keys = [...unitIndex.keys()].filter(matchesFilters).slice(0, 150);
      body = keys.length
        ? `<div class="role-title"><span>Matching units</span><span>${keys.length}${keys.length === 150 ? '+' : ''}</span></div>
           <div class="unit-list">${keys.map((k) => unitRowHtml(k, true)).join('')}</div>`
        : '<p class="empty">No units match that search.</p>';
    } else {
      const perArmy = new Map();
      for (const army of CATALOG.armies) perArmy.set(army.id, totals((ref) => ref.army.id === army.id));
      const mineOnly = ui.armyScope === 'mine';
      for (const side of SIDES) {
        const list = CATALOG.armies.filter((a) => a.side === side && (!mineOnly || perArmy.get(a.id).total > 0));
        if (!list.length) continue;
        body += `<h2 class="side-title">${side}</h2><div class="army-grid">` + list.map((a) => {
          const at = perArmy.get(a.id);
          return `
            <button class="army" type="button" data-act="army" data-id="${a.id}">
              <span class="army-name"><span>${esc(a.name)}</span><span class="count">${at.total || ''}</span></span>
              <span class="army-meta">${a.units.length} units${at.units ? ` · ${at.units} owned` : ''}</span>
              ${barHtml(at, true)}
            </button>`;
        }).join('') + '</div>';
      }
      if (!body) body = '<p class="empty">Nothing recorded yet. Switch to "All armies" and tap an army to start.</p>';
    }
    $('#view').innerHTML = summaryHtml(t, 'whole collection') + searchHtml('Search every unit…') + `
      <div class="chips" role="group" aria-label="Army list">
        <button class="chip" type="button" data-act="scope" data-v="all" aria-pressed="${ui.armyScope === 'all'}">All armies</button>
        <button class="chip" type="button" data-act="scope" data-v="mine" aria-pressed="${ui.armyScope === 'mine'}">My armies</button>
      </div>` + body;
  }

  function renderArmy(army) {
    const t = totals((ref) => ref.army.id === army.id);
    const keys = army.units.map((u) => army.id + '/' + u.id).filter(matchesFilters);
    const byRole = new Map();
    for (const k of keys) {
      const role = unitIndex.get(k).unit.r || 'Other';
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(k);
    }
    const roles = [...byRole.keys()].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
    const lists = roles.map((role) => `
      <div class="role-title"><span>${esc(role)}</span><span>${byRole.get(role).length}</span></div>
      <div class="unit-list">${byRole.get(role).map((k) => unitRowHtml(k, false)).join('')}</div>`).join('');
    $('#view').innerHTML = summaryHtml(t, army.name) + searchHtml(`Search ${army.name}…`) + chipsHtml() +
      (lists || '<p class="empty">No units match these filters.</p>');
  }

  function render() {
    const army = ui.armyId ? CATALOG.armies.find((a) => a.id === ui.armyId) : null;
    $('#backBtn').hidden = !army;
    $('#title').textContent = army ? army.name : '40K Inventory';
    const active = document.activeElement;
    const hadSearchFocus = active && active.id === 'search';
    const caret = hadSearchFocus ? active.selectionStart : 0;
    if (army) renderArmy(army); else renderHome();
    if (hadSearchFocus) {
      const s = $('#search');
      s.focus();
      try { s.setSelectionRange(caret, caret); } catch (e) { /* not supported for this input type */ }
    }
  }

  // ------------------------------------------------------------- unit editor
  let currentKey = null;

  function openUnit(key) {
    if (!unitIndex.has(key)) return;
    currentKey = key;
    renderUnitDialog();
    const dlg = $('#unitDialog');
    if (!dlg.open) dlg.showModal();
  }

  function renderUnitDialog() {
    const dlg = $('#unitDialog');
    const key = currentKey;
    const { army, unit } = unitIndex.get(key);
    const e = entryFor(key);
    const n = totalOf(e);
    const keepNotes = document.activeElement && document.activeElement.id === 'notes';
    const sizes = unit.m && unit.m.length ? `Unit size ${unit.m.join(' / ')} · ` : '';
    const rows = STAGES.map((s, i) => {
      const next = STAGES[i + 1];
      return `
        <div class="stage">
          <div class="stage-label"><i class="dot ${s.k}"></i>${s.label}<span class="stage-long">${s.long}</span></div>
          <div class="stepper">
            <button type="button" data-act="dec" data-k="${s.k}" aria-label="One fewer ${s.label}">−</button>
            <input type="number" inputmode="numeric" min="0" max="9999" data-k="${s.k}" value="${e.c[s.k]}" aria-label="${s.label} count">
            <button type="button" data-act="inc" data-k="${s.k}" aria-label="One more ${s.label}">+</button>
          </div>
          ${next ? `<button class="advance" type="button" data-act="advance" data-k="${s.k}" ${e.c[s.k] ? '' : 'disabled'}>Move 1 to ${next.label} ›</button>` : ''}
        </div>`;
    }).join('');
    const html = `
      <div class="sheet-head">
        <h2 id="unitTitle">${esc(unit.n)}</h2>
        <button class="btn" type="button" data-act="close">Done</button>
      </div>
      <div class="sheet-sub">${esc(army.name)}${unit.g ? ' · ' + esc(unit.g) : ''} · ${sizes}${unit.e.map((x) => x + 'th').join(' & ')} edition ·
        <b>${n}</b> model${n === 1 ? '' : 's'} owned</div>
      ${rows}
      <div class="stage">
        <div class="stage-label"><i class="dot damaged"></i>Damaged<span class="stage-long">Needs repair (of ${n})</span></div>
        <div class="stepper">
          <button type="button" data-act="dec" data-k="d" aria-label="One fewer damaged">−</button>
          <input type="number" inputmode="numeric" min="0" max="${n}" data-k="d" value="${e.d}" aria-label="Damaged count">
          <button type="button" data-act="inc" data-k="d" aria-label="One more damaged">+</button>
        </div>
      </div>
      <h3>Notes</h3>
      <textarea id="notes" placeholder="Loadouts, paint scheme, where it is stored…">${esc(e.notes)}</textarea>
      <h3>Photos</h3>
      <div class="photos">
        ${e.photos.map((p) => `<button class="photo" type="button" data-act="photo" data-id="${esc(p.id)}"><img alt="Photo of ${esc(unit.n)}" src="${esc(p.thumb)}"></button>`).join('')}
        <label class="photo-add"><div><span>+</span>Add photo</div><input id="photoInput" type="file" accept="image/*" multiple hidden></label>
      </div>
      <p class="hint">Photos are saved to the "${DRIVE_FOLDER}" folder in your Google Drive.</p>`;
    const caret = keepNotes ? document.activeElement.selectionStart : 0;
    dlg.innerHTML = html;
    if (keepNotes) {
      const notes = $('#notes', dlg);
      notes.focus();
      notes.setSelectionRange(caret, caret);
    }
  }

  function changeCount(k, fn) {
    const entry = normalizeEntry(state.units[currentKey]);
    if (k === 'd') entry.d = Math.min(clampInt(fn(entry.d)), totalOf(entry));
    else entry.c[k] = clampInt(fn(entry.c[k]));
    touch(currentKey, entry);
    renderUnitDialog();
  }

  // ---------------------------------------------------------------- settings
  function openSettings() {
    renderSettings();
    const dlg = $('#settingsDialog');
    if (!dlg.open) dlg.showModal();
  }

  function renderSettings() {
    const dlg = $('#settingsDialog');
    if (document.activeElement && document.activeElement.id === 'clientIdInput') return;
    const cid = clientId();
    const connected = !!token();
    const last = Number(ls.get(LS.lastSync)) || 0;
    const status = !cid ? 'Not set up yet. Your collection is saved on this device only.'
      : connected ? `Connected. ${last ? 'Last synced ' + new Date(last).toLocaleString() + '.' : ''}`
        : 'Not connected on this device.';
    dlg.innerHTML = `
      <div class="sheet-head">
        <h2 id="settingsTitle">Settings</h2>
        <button class="btn" type="button" data-act="close">Done</button>
      </div>
      <h3>Google Drive</h3>
      <p class="kv">${esc(status)}${authError ? ' Google reported: ' + esc(authError) + '.' : ''}
        ${syncState === 'error' ? ' The last sync failed; check your connection and try again.' : ''}</p>
      ${CFG.googleClientId ? '' : `
        <label class="kv" for="clientIdInput">Google OAuth client ID</label>
        <input id="clientIdInput" class="text-input" type="text" value="${esc(ls.get(LS.clientId) || '')}"
          placeholder="1234567890-abc.apps.googleusercontent.com" autocomplete="off" autocapitalize="off" spellcheck="false">`}
      <p class="kv">Authorised redirect URI for this copy of the app: <code>${esc(redirectUri())}</code></p>
      <div class="btn-row">
        ${connected
          ? '<button class="btn primary" type="button" data-act="sync-now">Sync now</button><button class="btn" type="button" data-act="disconnect">Disconnect</button>'
          : '<button class="btn primary" type="button" data-act="connect">Connect Google Drive</button>'}
      </div>
      <p class="hint">Data is kept in "${DRIVE_FOLDER}/${DRIVE_FILE}" in your Drive. The app can only see files it created itself.</p>
      <h3>Backup</h3>
      <div class="btn-row">
        <button class="btn" type="button" data-act="export">Export to file</button>
        <label class="btn">Import from file<input id="importInput" type="file" accept="application/json,.json" hidden></label>
      </div>
      <h3>About</h3>
      <p class="kv">${unitIndex.size} units in ${CATALOG.armies.length} armies. Catalogue built ${esc(CATALOG.generated || '')}
        from community data (${esc((CATALOG.sources || []).join(', '))}). Legends units are not included.</p>
      <p class="kv">Unofficial fan-made tool. Not affiliated with or endorsed by Games Workshop.</p>`;
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wh40k-collection-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function importData(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.units !== 'object') throw new Error('not a collection file');
      if (!confirm('Replace the collection on this device (and in Drive at the next sync) with this file?')) return;
      const incoming = normalizeState(data);
      const now = Date.now();
      const next = { version: 1, updatedAt: now, units: {} };
      for (const k of Object.keys(state.units)) { next.units[k] = blankEntry(); next.units[k].t = now; }
      for (const k of Object.keys(incoming.units)) { next.units[k] = incoming.units[k]; next.units[k].t = now; }
      state = next;
      await saveLocal();
      render();
      scheduleSync(300);
      toast('Collection imported');
    } catch (e) { toast('Import failed: ' + e.message); }
  }

  let toastTimer = 0;
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3500);
  }

  // ------------------------------------------------------------------ events
  function route() {
    const m = location.hash.match(/^#\/army\/([a-z0-9-]+)/);
    const next = m && CATALOG.armies.some((a) => a.id === m[1]) ? m[1] : null;
    if (next !== ui.armyId) { ui.search = ''; ui.filter = 'all'; ui.edition = 'all'; }
    ui.armyId = next;
    render();
    window.scrollTo(0, 0);
  }

  function bindEvents() {
    window.addEventListener('hashchange', route);
    $('#backBtn').addEventListener('click', () => { location.hash = '#/'; });
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#syncPill').addEventListener('click', () => {
      if (syncState === 'off') openSettings();
      else if (syncState === 'auth') startAuth(false);
      else sync();
    });

    const view = $('#view');
    view.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'army') location.hash = '#/army/' + el.dataset.id;
      else if (act === 'unit') openUnit(el.dataset.key);
      else if (act === 'filter') { ui.filter = el.dataset.v; render(); }
      else if (act === 'edition') { ui.edition = el.dataset.v; render(); }
      else if (act === 'scope') { ui.armyScope = el.dataset.v; ls.set(LS.armyScope, ui.armyScope); render(); }
    });
    view.addEventListener('input', (ev) => {
      if (ev.target.id === 'search') { ui.search = ev.target.value; render(); }
    });

    const unitDlg = $('#unitDialog');
    unitDlg.addEventListener('click', (ev) => {
      if (ev.target === unitDlg) { unitDlg.close(); return; }   // tap on the backdrop
      const el = ev.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      const k = el.dataset.k;
      if (act === 'close') unitDlg.close();
      else if (act === 'inc') changeCount(k, (n) => n + 1);
      else if (act === 'dec') changeCount(k, (n) => n - 1);
      else if (act === 'advance') {
        const i = STAGES.findIndex((s) => s.k === k);
        const entry = normalizeEntry(state.units[currentKey]);
        if (i >= 0 && STAGES[i + 1] && entry.c[k] > 0) {
          entry.c[k] -= 1;
          entry.c[STAGES[i + 1].k] += 1;
          touch(currentKey, entry);
          renderUnitDialog();
        }
      } else if (act === 'photo') openPhoto(currentKey, el.dataset.id);
    });
    unitDlg.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.id === 'photoInput') { const files = [...t.files]; t.value = ''; addPhotos(currentKey, files); }
      else if (t.matches('input[type="number"]')) changeCount(t.dataset.k, () => t.value);
    });
    unitDlg.addEventListener('input', (ev) => {
      if (ev.target.id !== 'notes') return;
      const entry = normalizeEntry(state.units[currentKey]);
      entry.notes = ev.target.value;
      touch(currentKey, entry);
    });
    unitDlg.addEventListener('close', () => { currentKey = null; render(); });

    const photoDlg = $('#photoDialog');
    photoDlg.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'photo-close') photoDlg.close();
      else if (el.dataset.act === 'photo-delete') deletePhoto(photoDlg.dataset.key, photoDlg.dataset.photo);
    });

    const setDlg = $('#settingsDialog');
    setDlg.addEventListener('click', (ev) => {
      if (ev.target === setDlg) { setDlg.close(); return; }
      const el = ev.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'close') setDlg.close();
      else if (act === 'connect') {
        const input = $('#clientIdInput', setDlg);
        if (input) ls.set(LS.clientId, input.value.trim());
        if (!clientId()) { toast('Paste your Google OAuth client ID first.'); return; }
        authError = '';
        startAuth(false);
      } else if (act === 'sync-now') sync();
      else if (act === 'disconnect') { disconnect(); renderSettings(); }
      else if (act === 'export') exportData();
    });
    setDlg.addEventListener('change', (ev) => {
      if (ev.target.id === 'importInput' && ev.target.files[0]) { importData(ev.target.files[0]); ev.target.value = ''; }
      else if (ev.target.id === 'clientIdInput') ls.set(LS.clientId, ev.target.value.trim());
    });

    window.addEventListener('online', () => sync());
    window.addEventListener('offline', () => setSync(clientId() ? 'offline' : 'off'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sync(); else saveLocal();
    });
    window.addEventListener('pagehide', () => { saveLocal(); });
  }

  // -------------------------------------------------------------------- boot
  async function boot() {
    consumeAuthHash();
    await loadLocal();
    bindEvents();
    route();
    setSync(clientId() ? (navigator.onLine ? 'auth' : 'offline') : 'off');
    if (authError) toast('Google sign-in failed: ' + authError, 6000);
    sync();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    }
  }

  boot();
})();
