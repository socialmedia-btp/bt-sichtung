/* Framepoint (ehem. Burning Balls) – Footage-Auswahl und Feedback auf Tablet/PC (Blue Tacit).
 * Projekt = Ordner aus prepare.py (projekt.json + Proxies + Filmstreifen), einmal importiert → IndexedDB.
 * Zeiten: "real" = Sekunden Ortszeit (inkl. Spur-Versatz), "disp" = Timeline-Position mit gekürzten Lücken.
 * Auswahl-In/Out werden relativ zum Clip gespeichert (Sekunden im Original), damit Versatz-Änderungen sie nicht verschieben.
 */
'use strict';

const GAP = 2;                 // Lücken ohne Aufnahme werden auf max. 2 s gekürzt
const LONGPRESS_MS = 380;
const FINE_PX_PER_FRAME = 14;  // Lupe: so viele Pixel pro Bild
const MARK_LONGPRESS_MS = 450; // langes Drücken auf einen Clip = In, nochmal = Out
const APP_VERSION = 'v4.4d';
const VBASE = Date.parse('2000-01-01T00:00:00.000Z') / 1000; // Zeitnullpunkt von Schnittversionen (Uhr zeigt 00:00:00)
const TRACK_COLORS = ['#4c9aff', '#3dd68c', '#c084fc', '#ff8a4c', '#f472b6', '#22d3ee'];
const $ = (id) => document.getElementById(id);

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
  offen: new Set(),
  gross: 0,           // >0 während Videos importiert werden (dann keine Sperr-Warnung)   // laufende Transaktionen – werden beim Verlassen der Seite abgebrochen (siehe pagehide)
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('bt-sichtung', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('files');
        db.createObjectStore('state');
        db.createObjectStore('notes');
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(store, mode, fn) {
    const p = new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode);
      DB.offen.add(t);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => { DB.offen.delete(t); res(r && r.result); };
      t.onerror = () => { DB.offen.delete(t); rej(t.error); };
      t.onabort = () => { DB.offen.delete(t); rej(t.error || new Error('abgebrochen')); };
    });
    // iPad (Chrome): ein Hintergrund-Tab kann den Speicher sperren → nicht endlos warten, sondern klar melden
    // (große Dateien beim Import brauchen länger; nur kleine Lese-/Schreibvorgänge im Zustand werden überwacht)
    if (store !== 'state' || DB.gross) return p; // während großer Importe warten Zustands-Zugriffe legitim länger
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => { DB.haengt(); rej(new Error('Speicher antwortet nicht')); }, 15000))]);
  },
  haengt() {
    if (DB.gemeldet) return; DB.gemeldet = true;
    try { log('speicher-haengt'); } catch { /* egal */ }
    modal(`<h2>Speicher blockiert</h2><p>Der App-Speicher antwortet gerade nicht – meist hält ein anderer Framepoint-Tab ihn fest.</p>
      <p><b>Bitte alle anderen Framepoint-Tabs schließen</b> oder den Browser einmal ganz beenden (App-Übersicht → wegwischen) und neu öffnen. Deine Daten bleiben erhalten.</p>
      <div class="row"><span class="grow"></span><button class="primary" onclick="location.reload()">Neu laden</button></div>`);
  },
  get: (s, k) => DB.req(s, 'readonly', (o) => o.get(k)),
  put: (s, v, k) => DB.req(s, 'readwrite', (o) => (k === undefined ? o.put(v) : o.put(v, k))),
  del: (s, k) => DB.req(s, 'readwrite', (o) => o.delete(k)),
  all: (s) => DB.req(s, 'readonly', (o) => o.getAll()),
  keys: (s) => DB.req(s, 'readonly', (o) => o.getAllKeys()),
};

/* ---------- Hilfen ---------- */
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
function clock(sec, fps) {
  sec = ((sec % 86400) + 86400) % 86400;
  let s = `${pad(sec / 3600)}:${pad((sec % 3600) / 60)}:${pad(sec % 60)}`;
  if (fps) s += ':' + pad((sec % 1) * fps + 1e-4);
  return s;
}
function tcClip(sec, fps) {
  const f = Math.round(sec * fps);
  const s = Math.floor(f / fps);
  return `${pad(s / 60)}:${pad(s % 60)}:${pad(f % fps)}`;
}
const durTxt = (s) => (s < 60 ? `${s.toFixed(1).replace('.', ',')} s` : `${Math.floor(s / 60)}:${pad(s % 60)} min`);
const fmtGB = (b) => (b / 1e9).toFixed(2).replace('.', ',') + ' GB';
function isoToSec(iso) { return Date.parse(iso + 'Z') / 1000; }
function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function modal(html, onReady) {
  $('modalBox').innerHTML = html; $('modal').classList.remove('hidden');
  if (onReady) onReady($('modalBox'));
}
function closeModal() { $('modal').classList.add('hidden'); $('modalBox').innerHTML = ''; }
async function sha1hex(data) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Feste Projekt-ID wie bt_v4.project_id_of: aus projekt.json, sonst aus Name + Anlagezeit
// Projekt-ID eines importierten Projekts: beim ersten Import festgeschrieben (überlebt neu erzeugte projekt.json)
async function projPid(p) {
  if (!p.project_id) { p.project_id = await projectIdOf(p.meta); await DB.put('projects', p); }
  return p.project_id;
}
async function projectIdOf(meta) {
  if (meta.project_id) return meta.project_id;
  return 'p-' + (await sha1hex(new TextEncoder().encode(`${meta.name || ''}|${meta.created || ''}`))).slice(0, 12);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Zustand ---------- */
const S = {
  proj: null,          // Eintrag aus 'projects' (inkl. meta = projekt.json)
  clips: [],           // {id, track, name, file, s0, s (inkl. Versatz), dur, fps, ...}
  byId: new Map(),
  tracks: [],
  ps: null,            // Projektzustand v4: {v:4, tab, activeVersion, revision, shortlist: Kontext, versions: [{…, ctx: Kontext}], wartend}
  state: null,         // aktiver Kontext {selections, offsets, takes, ereignisse?, activeTrack, T, pps} (zeigt in S.ps)
  ver: null,           // aktive Version im Edit-Tab (null = Shortlist)
  urls: new Map(),     // Clip-ID → Blob-URL
  sprites: new Map(),  // Clip-ID → Image
  axis: null,
  T: 0,                // Playhead (real)
  pps: 20,             // Pixel pro Sekunde
  activeTrack: null,
  curSel: null,
  playing: false,
  muted: false,
};
const CUT = { mode: false, rec: null, countdown: null };
const TAKE_H = 24; // Höhe einer Cut-Take-Zeile in der Timeline
const COM_H = 28;  // Kommentar-Zeile: antippen = Marker + Sprachnotiz am Abspielzeiger

/* ---------- Projekte ---------- */
async function showHome() {
  if (rec || recStarting) { toast('Erst die Sprachnotiz beenden'); return; }
  stopPlay();
  if (S.proj && S.dirty && !$('editor').classList.contains('hidden') && (await bkLink(await projPid(S.proj)))) await bkSend(true);
  await flushSave(); if (S.state) await save(true);
  S.logPid = null;
  $('editor').classList.add('hidden'); $('home').classList.remove('hidden');
  const projs = await DB.all('projects');
  const list = $('projList');
  list.innerHTML = projs.length ? '' : '<p class="hint">Noch kein Projekt. Importiere einen Projektordner.</p>';
  for (const p of projs.sort((a, b) => (b.opened || 0) - (a.opened || 0))) {
    const st = await DB.get('state', p.id);
    const n = st ? (st.shortlist || st).selections.length : 0;
    const nv = st && st.versions ? st.versions.length : 0;
    const el = document.createElement('div');
    el.className = 'proj';
    el.innerHTML = `<div class="info"><div class="name">${esc(p.meta.name)}</div>
      <div class="meta">${p.meta.kind === 'kunde' ? 'Video zum Prüfen' : `${p.meta.clips.length} Clips · ${fmtGB(p.bytes || 0)} · ${n} Auswahl`}${nv ? ` · ${nv} Version${nv > 1 ? 'en' : ''}` : ''}${p.missing ? ` · <span style="color:var(--red)">${p.missing} Dateien fehlen</span>` : ''}</div></div>
      <button class="primary">Öffnen</button><button class="ghost danger" title="Projekt vom Gerät löschen">✕</button>`;
    el.querySelector('.primary').onclick = () => openProject(p.id);
    el.querySelector('.danger').onclick = () => deleteProject(p);
    list.appendChild(el);
  }
  if (navigator.storage && navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    $('storageInfo').textContent = `Speicher dieser App: ${fmtGB(e.usage || 0)} belegt, ca. ${fmtGB(e.quota || 0)} verfügbar.`;
  }
}

async function importFiles(fileList, dirHandle) {
  const files = [...fileList];
  const pj = files.find((f) => f.name.toLowerCase().endsWith('.json') && /projekt/i.test(f.name))
    || files.find((f) => f.name.toLowerCase().endsWith('.json'));
  if (!pj) { toast('projekt.json fehlt in der Auswahl'); return; }
  let meta;
  try { meta = JSON.parse(await pj.text()); } catch { toast('projekt.json ist nicht lesbar'); return; }
  if (meta.format === 'bt-sichtung-auswahl') { openSaveFileFromHome(pj); return; }
  if (meta.format !== 'bt-sichtung') { toast('Keine Framepoint-Projektdatei'); return; }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  // Zuordnung über die feste Projekt-ID (F02). Ohne project_id in projekt.json (ältere prepare.py): gleicher Name = dasselbe
  // Projekt, auch wenn prepare.py es neu erzeugt hat – aber nur bei genau einem Treffer.
  const pid = await projectIdOf(meta), projs = await DB.all('projects');
  let same = projs.find((x) => x.project_id === pid || (meta.project_id && x.meta.project_id === meta.project_id));
  if (!same && !meta.project_id) {
    const byName = projs.filter((x) => x.meta.name === meta.name && !x.meta.project_id);
    if (byName.length > 1) { toast(`Mehrere Projekte heißen „${meta.name}“ – bitte das alte erst entfernen`, 5000); return; }
    same = byName[0];
  }
  const id = same ? same.id : meta.name + '|' + meta.created;
  log('import', { name: meta.name, dateien: files.length, vorhanden: !!same });
  const byName = new Map(files.map((f) => [f.name, f]));
  const needed = meta.clips.flatMap((c) => [c.file, c.sprite]);
  const have = new Set(await DB.keys('files'));
  modal(`<h2>Importiere ${esc(meta.name)}</h2><div class="progress"><div id="impBar"></div></div><p id="impTxt" class="hint"></p>`);
  let done = 0, bytes = 0;
  DB.gross++;
  try {
  for (const name of needed) {
    const f = byName.get(name);
    const key = id + '/' + name;
    if (f) {
      // Inhalt kopieren statt File-Referenz speichern (iOS löscht die Picker-Kopie später)
      const blob = new Blob([await f.arrayBuffer()], { type: name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4' });
      await DB.put('files', blob, key);
      have.add(key);
      bytes += blob.size;
    }
    done++;
    $('impBar').style.width = (100 * done / needed.length) + '%';
    $('impTxt').textContent = `${done} / ${needed.length} · ${name}`;
  }
  } finally { DB.gross--; }
  const missing = needed.filter((n) => !have.has(id + '/' + n)).length;
  const old = await DB.get('projects', id);
  const project_id = (old && old.project_id) || (old ? await projectIdOf(old.meta) : pid); // einmal vergeben, bleibt fest
  await DB.put('projects', { id, project_id, meta, bytes: (old ? old.bytes : 0) + bytes, missing, opened: Date.now() });
  if (dirHandle) await DB.put('state', dirHandle, '__dir__' + id);
  closeModal();
  toast(missing ? `Importiert – ${missing} Dateien fehlen noch` : 'Projekt importiert');
  showHome();
}

async function deleteProject(p) {
  modal(`<h2>Projekt löschen?</h2><p>„${esc(p.meta.name)}“ und deine Auswahl werden von diesem Gerät entfernt. Exportiere die Auswahl vorher, falls du sie noch brauchst.</p>
    <div class="row"><button id="mNo">Abbrechen</button><button id="mYes" class="primary">Löschen</button></div>`, (b) => {
    b.querySelector('#mNo').onclick = closeModal;
    b.querySelector('#mYes').onclick = async () => {
      const keys = (await DB.keys('files')).filter((k) => k.startsWith(p.id + '/'));
      for (const k of keys) await DB.del('files', k);
      const st = await DB.get('state', p.id);
      if (st) for (const ctx of contexts(st)) for (const s of ctx.selections) for (const n of s.notes || []) await DB.del('notes', n.id);
      await DB.del('state', p.id); await DB.del('projects', p.id);
      closeModal(); showHome();
    };
  });
}

/* ---------- Projekt öffnen ---------- */
async function openProject(id) {
  await flushSave();
  const p = await DB.get('projects', id);
  S.logPid = id;
  p.opened = Date.now(); DB.put('projects', p);
  S.proj = p; S.noSave = false;
  for (const u of S.urls.values()) URL.revokeObjectURL(u);
  S.urls.clear(); S.sprites.clear();
  S.footTracks = p.meta.tracks.map((t, i) => ({ ...t, color: TRACK_COLORS[i % TRACK_COLORS.length] }));
  S.footClips = p.meta.clips.map((c) => ({ ...c, s0: isoToSec(c.start) }));
  S.ps = await migrateState(await DB.get('state', id), id);
  // Footage-Zeiten auch dann setzen, wenn das Projekt im Edit-Tab startet (Export braucht sie)
  for (const c of S.footClips) c.s = c.s0 + (S.ps.shortlist.offsets[c.track] || 0);
  S.hist = {}; S.state = null; S.ver = null;

  // Blob-URLs + Filmstreifen
  for (const c of S.footClips) {
    const v = await DB.get('files', id + '/' + c.file);
    c.missing = !v;
    if (v) S.urls.set(c.id, URL.createObjectURL(v));
    const sp = await DB.get('files', id + '/' + c.sprite);
    if (sp) { const img = new Image(); img.onload = requestDraw; img.src = URL.createObjectURL(sp); S.sprites.set(c.id, img); }
  }
  $('projTitle').textContent = p.meta.name;
  $('tabs').classList.toggle('hidden', p.meta.kind === 'version' || p.meta.kind === 'kunde');
  if (!S.footClips.length && !S.ps.versions.length) { // Kunden-Projekt, Version noch nicht (mehr) da
    S.state = S.ps.shortlist; S.clips = []; S.byId = new Map(); markSaved(true);
    versionSheet(); return;
  }
  $('home').classList.add('hidden'); $('editor').classList.remove('hidden');
  let vOk = S.ps.tab === 'edit' && S.ps.versions.some((v) => v.version_id === S.ps.activeVersion);
  if (!S.footClips.length && !vOk) { S.ps.activeVersion = S.ps.versions[S.ps.versions.length - 1].version_id; vOk = true; } // ohne Footage immer Edit
  await enterContext(vOk ? 'edit' : 'shortlist', vOk ? S.ps.activeVersion : null);
  markSaved(true); ensureStandFile(); bkRender();
  log('projekt-offen', { name: p.meta.name, clips: S.footClips.length, auswahl: S.ps.shortlist.selections.length, versionen: S.ps.versions.length, tab: S.ps.tab });
}

/* ---------- Kontexte (v4) ----------
 * Ein Projekt = ein Dreh. Kontext „Shortlist“ = Footage (Ortszeit, gekürzte Lücken); je importierter Version ein eigener
 * Kontext mit fortlaufender Sequenzzeit (Kommentare, Cut-Takes, Änderungs-Ereignisse, Position, Zoom, Undo). */
const newCtx = (extra) => ({ selections: [], offsets: {}, takes: [], activeTrack: null, T: null, pps: null, ...extra });
const contexts = (ps) => (ps.v === 4 ? [ps.shortlist, ...ps.versions.map((v) => v.ctx)] : [ps]);
async function migrateState(raw, pid) {
  if (raw && raw.v === 4) return raw;
  const ps = { v: 4, tab: 'shortlist', activeVersion: null, revision: 0, versions: [], wartend: {},
    shortlist: newCtx(raw ? { ...raw, takes: raw.takes || [] } : { pps: 20 }) };
  try {
    // v3-Stand unverändert sichern und neuen Stand schreiben – beides oder nichts
    await DB.req('state', 'readwrite', (o) => { if (raw) o.put(raw, '__v3__' + pid); return o.put(JSON.parse(JSON.stringify(ps)), pid); });
    if (raw) log('migration-v3', { auswahl: raw.selections.length, takes: (raw.takes || []).length });
  } catch (e) {
    log('migration-fehler', { msg: String(e && e.message || e) });
    S.noSave = true;
    modal(`<h2>Gerätespeicher voll</h2><p>Dein bisheriger Stand ist unverändert, konnte aber nicht ins neue Format übernommen werden. Bitte jetzt <b>Speichern</b> (Datei sichern) und Platz schaffen, z. B. ein altes Projekt entfernen.</p><div class="row"><span class="grow"></span><button class="primary" onclick="closeModal()">OK</button></div>`);
  }
  return ps;
}
const ctxKey = () => (S.ver ? S.ver.version_id : 'shortlist');
const isVersionView = () => !!S.ver || S.proj.meta.kind === 'version';
function versionClip(ver) {
  const m = ver.manifest;
  return { id: 'v:' + ver.version_id, track: 'VERSION', name: m.sequenz, file: ver.file, sprite: null, s0: VBASE, s: VBASE,
    dur: ver.dur, fps: m.fps, original: ver.datei };
}
async function enterContext(tab, versionId) {
  if (rec || recStarting) { toast('Erst die Sprachnotiz beenden'); return false; }
  if (typeof SL !== 'undefined' && SL) slipClose();
  if (tab !== 'edit' && !S.footClips.length) { // Kunden-Projekt: es gibt keine Shortlist
    const v = S.ps.versions[S.ps.versions.length - 1]; if (!v) return false;
    tab = 'edit'; versionId = versionId || v.version_id;
  }
  $('home').classList.add('hidden'); $('editor').classList.remove('hidden');
  stopPlay(); endReel(); if (CUT.mode) toggleCutMode(false);
  if (S.state) { S.state.activeTrack = S.activeTrack; S.state.T = S.T; S.state.pps = S.pps; S.hist[ctxKey()] = { U: [...UNDO], R: [...REDO], last: lastSnap }; }
  const ver = tab === 'edit' ? S.ps.versions.find((v) => v.version_id === versionId) : null;
  S.ps.tab = ver ? 'edit' : 'shortlist';
  if (ver) {
    S.ps.activeVersion = ver.version_id; S.ver = ver; S.state = ver.ctx;
    ver.ctx.offsets = {}; // Versionen haben keinen Kamera-Versatz (F10)
    for (const x of ver.ctx.selections) if (x.clipId && x.clipId !== 'v:' + ver.version_id) x.clipId = 'v:' + ver.version_id; // v4.0a-Altlast
    S.tracks = [{ id: 'VERSION', label: 'Version', color: TRACK_COLORS[0] }];
    const c = versionClip(ver);
    if (!S.urls.has(c.id)) { const b = await DB.get('files', c.file); if (b) S.urls.set(c.id, URL.createObjectURL(b)); }
    c.missing = !S.urls.has(c.id);
    S.clips = [c];
    S.vsegs = visibleShots(ver.manifest);
  } else {
    S.ver = null; S.state = S.ps.shortlist; S.tracks = S.footTracks; S.clips = S.footClips; S.vsegs = null;
  }
  S.byId = new Map(S.clips.map((c) => [c.id, c]));
  applyOffsets();
  S.activeTrack = S.tracks.some((t) => t.id === S.state.activeTrack) ? S.state.activeTrack : S.tracks[0].id;
  // Version ohne gespeicherten Zoom: ganze Filmlänge ≈ Breite der Timeline (8–60 px/s)
  S.pps = S.state.pps || (ver ? clamp((cv.getBoundingClientRect().width - HEAD) / ver.dur, 8, 60) : 20);
  S.T = S.state.T ?? S.clips[0].s;
  S.curSel = null; S.selTake = null;
  const h = S.hist[ctxKey()];
  if (h) { UNDO.length = 0; UNDO.push(...h.U); REDO.length = 0; REDO.push(...h.R); lastSnap = h.last; updateUndoBtns(); } else resetHistory();
  renderTabs();
  $('listTitle').textContent = isVersionView() ? 'Kommentare' : 'Shortlist';
  log('kontext', { tab: S.ps.tab, version: ver ? ver.version_id : null });
  resizeCanvas(); showFrame(true); renderSide(); save(); bkRender();
}
// Sichtbarer Shot je Zeitpunkt = oberste Ebene; benachbarte Stücke desselben Shots zusammengefasst (Sekunden ab Versionsbeginn)
function visibleShots(m) {
  const lvl = (s) => +String(s.ebene).replace(/\D/g, '') || 0;
  // Bekannte Overlays (Kinobalken o. ä., stehen bei den Shots darunter als „overlay: <Name>“) verdecken nichts
  // Overlay = die konkrete Instanz auf höherer Ebene, die zeitlich über einem Shot mit „overlay: <Name>“ liegt (F13)
  const isOverlay = (o) => m.shots.some((t) => lvl(o) > lvl(t) && o.v_in < t.v_out && o.v_out > t.v_in
    && (t.folgen || []).includes('overlay: ' + o.name));
  const shots = m.shots.filter((x) => !isOverlay(x));
  const cuts = [...new Set(shots.flatMap((s) => [s.v_in, s.v_out]))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    const top = shots.filter((s) => s.v_in <= a && s.v_out >= b).sort((x, y) => lvl(y) - lvl(x))[0];
    if (!top) continue;
    const last = out[out.length - 1];
    if (last && last.shot === top && last.b === a / m.fps) last.b = b / m.fps;
    else out.push({ a: a / m.fps, b: b / m.fps, shot: top });
  }
  return out;
}
// +0,1 ms: Uhrzeiten um VBASE (~9,5·10⁸ s) haben Rundungsfehler, ein Sprung auf den Shot-Anfang landet sonst knapp davor
const shotAt = (sec) => { sec += 1e-4; return (S.vsegs || []).find((x) => sec >= x.a && sec < x.b) || null; };
function renderTabs() {
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.ps.tab));
  const av = S.ps.versions.find((v) => v.version_id === S.ps.activeVersion);
  $('verName').textContent = S.ver ? 'Version ' + verLabel(S.ver) : av ? 'Version ' + verLabel(av) : S.ps.versions.length ? 'Versionen' : '＋ Version';
}
const verLabel = (v) => (v.manifest.sequenz.match(/v\d+\w*$/i) || [v.manifest.sequenz])[0];

function applyOffsets() {
  for (const c of S.clips) c.s = c.s0 + (S.state.offsets[c.track] || 0);
  buildAxis();
}

let saveTimer = null, pendingWrite = null;
function save(now) {
  if (!S.proj || !S.ps || !S.state) return Promise.resolve();
  if (S.noSave) return Promise.resolve(); // Migration ohne Sicherung gescheitert → v3-Stand nicht überschreiben (F14)
  clearTimeout(saveTimer);
  const pid = S.proj.id, ps = S.ps, st = S.state; // Projekt jetzt festhalten – ein Projektwechsel darf nicht umlenken
  // Ausstehende Sicherung eines ANDEREN Projekts nie verwerfen, sondern sofort schreiben (F07)
  if (pendingWrite && pendingWrite.pid !== pid) pendingWrite();
  const write = () => {
    if (pendingWrite === write) pendingWrite = null;
    if (S.state === st) { st.activeTrack = S.activeTrack; st.T = S.T; st.pps = S.pps; }
    return DB.put('state', JSON.parse(JSON.stringify(ps)), pid)
      .catch((e) => { log('speichern-fehler', { msg: String(e && e.message || e) }); toast('Lokales Speichern fehlgeschlagen – bitte „Speichern“ (Datei) nutzen', 4000); });
  };
  write.pid = pid;
  if (now) return write();
  pendingWrite = write; saveTimer = setTimeout(write, 300);
  return Promise.resolve();
}
async function flushSave() { clearTimeout(saveTimer); if (pendingWrite) await pendingWrite(); }

/* ---------- Zeitachse mit gekürzten Lücken ---------- */
function buildAxis() {
  const iv = S.clips.map((c) => [c.s, c.s + c.dur]).sort((a, b) => a[0] - b[0]);
  const m = [];
  for (const x of iv) {
    if (m.length && x[0] <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], x[1]);
    else m.push([...x]);
  }
  const segs = []; const gaps = []; let d = 0;
  m.forEach((x, i) => {
    if (i) {
      const real = x[0] - m[i - 1][1]; const dd = Math.min(real, GAP);
      if (real > GAP) gaps.push({ d0: d, d1: d + dd, real });
      d += dd;
    }
    segs.push({ r0: x[0], r1: x[1], d0: d });
    d += x[1] - x[0];
  });
  S.axis = { segs, gaps, total: d };
}
function r2d(r) {
  const g = S.axis.segs;
  if (r <= g[0].r0) return r - g[0].r0;
  let lo = 0, hi = g.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g[mid].r0 <= r) lo = mid; else hi = mid - 1; }
  const s = g[lo];
  if (r <= s.r1 || lo === g.length - 1) return s.d0 + (r - s.r0);
  const n = g[lo + 1]; const dEnd = s.d0 + (s.r1 - s.r0);
  return dEnd + (r - s.r1) / (n.r0 - s.r1) * (n.d0 - dEnd);
}
function d2r(d) {
  const g = S.axis.segs;
  if (d <= 0) return g[0].r0 + d;
  let lo = 0, hi = g.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g[mid].d0 <= d) lo = mid; else hi = mid - 1; }
  const s = g[lo]; const dEnd = s.d0 + (s.r1 - s.r0);
  if (d <= dEnd || lo === g.length - 1) return s.r0 + (d - s.d0);
  const n = g[lo + 1];
  return s.r1 + (d - dEnd) / (n.d0 - dEnd) * (n.r0 - s.r1);
}

/* ---------- Clips am Playhead ---------- */
const clipAt = (track, r) => S.clips.find((c) => c.track === track && r >= c.s && r < c.s + c.dur);
function shownClip(r = S.T) {
  return clipAt(S.activeTrack, r) || S.tracks.map((t) => clipAt(t.id, r)).find(Boolean) || null;
}
// Edit-Tab: Shot-Anfänge wie Clips behandeln (⏮ ⏭ springen von Shot zu Shot)
const shotStarts = () => S.vsegs.map((x) => ({ s: S.clips[0].s + x.a }));
function nextClipStart(r) {
  if (S.ver && S.vsegs) return shotStarts().find((x) => x.s > r + 1e-3) || null;
  let best = null;
  for (const c of S.clips) if (c.s > r + 1e-3 && (!best || c.s < best.s)) best = c;
  return best;
}
function prevClipStart(r) {
  if (S.ver && S.vsegs) return shotStarts().filter((x) => x.s < r - 0.25).pop() || null;
  let best = null;
  for (const c of S.clips) if (c.s < r - 0.25 && (!best || c.s > best.s)) best = c;
  return best;
}

/* ---------- Video ---------- */
const video = $('video');
let seekWanted = null;

/* ---------- Log ----------
 * Ringpuffer, alle 2 s in IndexedDB gesichert; steckt auch in jeder Speicherdatei.
 * Ansehen/teilen über Hilfe → Log, Live-Log blendet die letzten Zeilen über dem Video ein. */
const LOG = []; const LOG_MAX = 4000; let logDirty = false;
function vstate() {
  return { cid: (video.dataset.cid || '').slice(0, 40), ct: +video.currentTime.toFixed(3), rs: video.readyState, ns: video.networkState,
    paused: video.paused, seeking: video.seeking, ended: video.ended, err: video.error ? video.error.code : 0,
    playing: S.playing, switching: !!S.switching, T: S.T ? clock(S.T) + '.' + pad((S.T % 1) * 1000, 3) : '' };
}
function log(ev, data) {
  LOG.push({ ...(data || {}), ev, t: Date.now(), ...(S.logPid ? { p: S.logPid } : {}) });
  if (LOG.length > LOG_MAX) LOG.splice(0, LOG.length - LOG_MAX);
  logDirty = true;
  if (S.liveLog) renderLiveLog();
}
function logLine(e) {
  const d = new Date(e.t);
  const rest = Object.entries(e).filter(([k]) => k !== 't' && k !== 'ev' && k !== 'p').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${e.ev} ${rest}`.trimEnd();
}
function renderLiveLog() {
  const el = $('liveLog'); if (!el) return;
  el.textContent = LOG.slice(-8).map(logLine).join('\n');
}
function flushLog() {
  if (!logDirty || !DB.db) return;
  logDirty = false;
  DB.put('state', LOG.slice(-LOG_MAX), '__log__').catch(() => { logDirty = true; });
}
setInterval(flushLog, 2000);
window.addEventListener('error', (e) => log('js-error', { msg: e.message, at: (e.filename || '').split('/').pop() + ':' + e.lineno }));
window.addEventListener('unhandledrejection', (e) => log('promise-error', { msg: String((e.reason && e.reason.message) || e.reason) }));
// Video-Ereignisse; Seeks nur beim Abspielen/Wechseln (beim Scrubben wären es Hunderte)
['loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'emptied', 'abort', 'seeking', 'seeked'].forEach((ev) =>
  video.addEventListener(ev, () => { if ((ev === 'seeking' || ev === 'seeked') && !S.playing && !S.switching) return; log('v:' + ev, vstate()); }));
// Video-Fehler: Datei neu anbinden statt hängen zu bleiben
video.addEventListener('error', async () => {
  const cid = video.dataset.cid; if (!cid || !S.proj) return;
  S.retry = S.retry || {}; S.retry[cid] = (S.retry[cid] || 0) + 1;
  if (S.retry[cid] > 2) { log('video-defekt', { cid }); stopPlay(); toast('Clip lässt sich nicht abspielen: ' + cid, 4000); return; }
  const c = S.byId.get(cid); const b = await DB.get('files', S.proj.id + '/' + c.file);
  if (!b) return;
  URL.revokeObjectURL(S.urls.get(cid)); S.urls.set(cid, URL.createObjectURL(b));
  video.dataset.cid = ''; log('video-recover', { cid }); showFrame(true);
});
// Wiedergabe von außen pausiert (z. B. iOS-Unterbrechung) → Zustand angleichen statt „hängen“
video.addEventListener('pause', () => {
  if (S.playing && !S.switching && !video.ended && !video.seeking) {
    setTimeout(() => { if (S.playing && video.paused && !S.switching) { log('pause-extern', vstate()); stopPlay(); } }, 400);
  }
});
function showFrame(exact) {
  const c = shownClip();
  $('noClip').classList.toggle('hidden', !!c);
  video.classList.toggle('hidden', !c);
  if (!c) { updateHud(null); return; }
  const local = clamp(S.T - c.s, 0, c.dur - 0.001);
  if (video.dataset.cid !== c.id) {
    if (c.missing) {
      $('noClip').textContent = 'Datei fehlt: ' + c.file; $('noClip').classList.remove('hidden'); video.classList.add('hidden');
      if (S.playing) stopPlay();
      video.removeAttribute('src'); video.dataset.cid = ''; video.load();
      log('datei-fehlt', { clip: c.id }); updateHud(c); return;
    }
    $('noClip').textContent = 'Keine Aufnahme an dieser Stelle';
    video.dataset.cid = c.id;
    video.src = S.urls.get(c.id);
    seekWanted = local;
    video.addEventListener('loadedmetadata', () => { applySeek(); }, { once: true });
  } else {
    seekWanted = local;
    if (exact || !video.seeking) applySeek();
  }
  updateHud(c);
}
function applySeek() {
  if (seekWanted == null || video.readyState < 1) return;
  const c = S.byId.get(video.dataset.cid);
  // in die Mitte des Bildes springen, damit der Browser sicher das richtige Bild zeigt
  const f = Math.floor(seekWanted * c.fps + 1e-4);
  video.currentTime = Math.min((f + 0.5) / c.fps, c.dur - 0.001);
  seekWanted = null;
}
video.addEventListener('seeked', () => { if (seekWanted != null && !S.playing) applySeek(); });

function updateNoteTarget() {
  const el = $('noteTarget'); if (!el) return;
  const cs = S.curSel && sels().includes(S.curSel) ? S.curSel : null;
  if (S.ver && !cs) {
    const sg = shotNow();
    if (sg) { el.innerHTML = `🎙 Notiz zu: <b>Shot ${sg.shot.nr}</b> ${esc(shotName(sg.shot))}`; el.classList.add('on'); return; }
  }
  const s = cs || selAtPlayhead();
  if (!s) { el.textContent = '🎙 keine Auswahl hier → wird Marker'; el.classList.remove('on'); return; }
  const L = selLabel(s);
  el.innerHTML = `🎙 Notiz zu: <b>${esc(L.l1.replace(/^.*· /, ''))}</b> ${esc(L.l2.split(' · ').slice(0, 2).join(' · '))}${s.notes.length ? ` · ${s.notes.length} Notiz${s.notes.length > 1 ? 'en' : ''}` : ''}`;
  el.classList.add('on');
}
function updateHud(c) {
  const fps = c ? c.fps : 25;
  const tr = c && S.tracks.find((t) => t.id === c.track);
  const sg = c && S.ver ? shotAt(S.T - c.s) : null;
  if (S.ver && (sg ? sg.shot.id : null) !== S.cardShot) {
    const cs = S.curSel && sels().includes(S.curSel) ? S.curSel : null;
    const inScene = cs && sg && (() => { const [a, b] = selRange(cs); return b >= c.s + sg.a && a < c.s + sg.b; })();
    if (cs && !inScene) { S.curSel = null; renderSide(); } else if (!S.curSel) renderCurrent();
    updateNoteTarget();
  }
  $('hud').innerHTML = !c ? '' : sg
    ? `<span class="cam">Shot ${sg.shot.nr}</span> · ${esc(shotName(sg.shot))} · <span class="${sg.shot.editierbar ? 'ok' : 'lock'}">${sg.shot.editierbar ? 'änderbar' : 'gesperrt: ' + esc(sg.shot.grund || '')}</span>`
    : `<span class="cam" style="color:${tr.color}">${esc(tr.label)}</span> · ${esc(c.name)}`;
  $('tc').innerHTML = `<b>${clock(S.T, fps)}</b>` + (c ? ` · Clip ${tcClip(S.T - c.s, fps)} / ${tcClip(c.dur, fps)} · ${fps} fps` : '');
}

function setPlayIcons(on) { document.querySelectorAll('[data-act=play]').forEach((b) => { b.textContent = on ? '⏸' : '▶'; }); }
async function play() {
  let c = shownClip();
  if (!c) { const n = nextClipStart(S.T); if (!n) { log('play-ende'); return; } S.T = n.s; showFrame(true); c = shownClip(); if (!c) return; }
  if (c.missing) { toast('Datei fehlt: ' + c.file); log('play-datei-fehlt', { clip: c.id }); return; }
  if (video.dataset.cid !== c.id) showFrame(true);
  S.playing = true; setPlayIcons(true);
  video.muted = S.muted;
  S.lastCT = -1; S.lastAdvance = performance.now();
  clearInterval(S.playTimer); S.playTimer = setInterval(playTick, 33);
  log('play', vstate());
  try { await video.play(); }
  catch (err) {
    log('play-rejected', { name: err.name, msg: err.message, ...vstate() });
    if (err.name === 'AbortError') return; // Quelle wurde gewechselt – der Wechsel startet neu
    if (err.name === 'NotAllowedError' && !video.muted) {
      video.muted = true;
      try { await video.play(); S.muted = true; updateMute(); toast('Ton wurde blockiert – 🔊 antippen'); return; }
      catch (e2) { log('play-rejected-muted', { name: e2.name }); }
    }
    stopPlay(); toast('Abspielen ging nicht – steht im Log');
  }
}
function stopPlay() {
  if (!S.playing) return;
  S.playing = false; setPlayIcons(false);
  clearInterval(S.playTimer); clearTimeout(S.switchTimer); video.removeEventListener('seeked', resumeAfterSwitch);
  S.switching = false; video.pause(); save();
  log('stop', vstate());
  if (CUT.rec) setTimeout(stopCutRec, 0);
  if (reel && !reel.stepping) { const r = reel; reel = null; document.body.classList.remove('reel'); updateReelBar(); log('shortlist-stopp', { bei: r.i + 1 }); }
}
function resumeAfterSwitch() {
  clearTimeout(S.switchTimer); video.removeEventListener('seeked', resumeAfterSwitch);
  S.switching = false;
  if (S.playing) video.play().catch((e) => {
    log('play-rejected', { name: e.name, msg: e.message, nach: 'wechsel', ...vstate() });
    if (e.name !== 'AbortError') { stopPlay(); toast('Abspielen ging nicht – steht im Log'); }
  });
}
function playTick() {
  if (!S.playing) return;
  // Wächter: laut App läuft es, aber die Videozeit bewegt sich nicht (egal ob seeking/switching)
  if (video.currentTime !== S.lastCT) { S.lastCT = video.currentTime; S.lastAdvance = performance.now(); }
  else if (performance.now() - S.lastAdvance > 2500) {
    S.stuck = (S.stuck || 0) + 1; S.lastAdvance = performance.now();
    log('steht', { versuch: S.stuck, ...vstate() });
    if (S.stuck > 3) { S.stuck = 0; stopPlay(); toast('Wiedergabe hängt – bitte nochmal Play (steht im Log)'); return; }
    S.switching = false; video.removeEventListener('seeked', resumeAfterSwitch);
    video.play().catch((e) => log('play-rejected', { name: e.name, nach: 'steht' }));
  }
  const c = S.byId.get(video.dataset.cid);
  if (c && !video.seeking && !S.switching) {
    S.T = c.s + video.currentTime;
    const want = shownClip(S.T + 0.001);
    const atEnd = video.ended || video.currentTime >= c.dur - 0.03;
    if (atEnd || (want && want.id !== c.id)) {
      let t = atEnd ? c.s + c.dur + 0.001 : S.T;
      if (!shownClip(t)) { const n = nextClipStart(t - 0.002); if (!n) { stopPlay(); requestDraw(); return; } t = n.s + 0.001; }
      S.T = t; S.switching = true; log('wechsel', { nach: (shownClip(t) || {}).id, ...vstate() });
      showFrame(true);
      video.removeEventListener('seeked', resumeAfterSwitch);
      video.addEventListener('seeked', resumeAfterSwitch, { once: true });
      // Wächter: kommt kein 'seeked' (iOS verschluckt es manchmal), nach 1,5 s trotzdem weiter
      clearTimeout(S.switchTimer);
      S.switchTimer = setTimeout(() => { if (S.switching) { log('wechsel-haengt', vstate()); resumeAfterSwitch(); } }, 1500);
    }
    if (video.currentTime > 0.05) S.stuck = 0;
    if (reel && !reel.stepping) {
      const s = reel.list[reel.i];
      if (s && S.T >= selRange(s)[1] - 0.02) { reel.i++; reelStep(); return; }
    }
    updateHud(shownClip());
  }
  requestDraw();
}

function stepFrames(n) {
  stopPlay();
  const c = shownClip(); const fps = c ? c.fps : 25;
  const local = c ? S.T - c.s : 0;
  const f = (c ? frameOf(local, c) : Math.floor(local * fps)) + n;
  S.T = c ? c.s + clamp(f / fps, 0, c.dur - 1 / fps) : S.T + n / fps;
  showFrame(true); requestDraw(); save();
}
function jumpSec(sec) {
  stopPlay();
  S.T = d2r(clamp(r2d(S.T) + sec, -1, S.axis.total));
  showFrame(true); requestDraw(); save();
}

/* ---------- Auswahl ---------- */
const sels = () => S.state.selections;
// Bildindex wie in applySeek(): das gerade angezeigte Bild ist floor(t·fps) → In/Out/±1 nutzen dieselbe Rundung
const frameOf = (local, c) => Math.floor(local * c.fps + 1e-4);
function snap(local, c) { return clamp(frameOf(local, c) / c.fps, 0, c.dur); }
function markIn() {
  const c = clipAt(S.activeTrack, S.T) || shownClip();
  if (!c) { toast('Keine Aufnahme am Playhead'); return; }
  const t = snap(S.T - c.s, c);
  const cur = S.curSel && S.curSel.kind === 'range' && S.curSel.clipId === c.id && t < S.curSel.outT && S.curSel.open ? S.curSel : null;
  if (cur) { cur.inT = t; }
  else newOpenSel(c, t);
  S.activeTrack = c.track;
  log('in', { clip: c.id, pos: t });
  changed();
}
function newOpenSel(c, t) {
  for (const s of sels()) if (s.open) s.open = false; // höchstens eine offene Auswahl
  S.curSel = { id: uid(), kind: 'range', clipId: c.id, track: c.track, inT: t, outT: snap(c.dur, c), open: true, stars: 0, text: '', notes: [], created: Date.now() };
  sels().push(S.curSel);
}
function markOut() {
  const c = clipAt(S.activeTrack, S.T) || shownClip();
  if (!c) { toast('Keine Aufnahme am Playhead'); return; }
  const t = snap(S.T - c.s + 1 / c.fps, c); // Out schließt das aktuelle Bild ein
  const cur = (S.curSel && S.curSel.kind === 'range' && S.curSel.clipId === c.id && t > S.curSel.inT ? S.curSel : null)
    || sels().find((x) => x.kind === 'range' && x.open && x.clipId === c.id && t > x.inT) || null;
  if (cur) { cur.outT = t; cur.open = false; S.curSel = cur; }
  else { S.curSel = { id: uid(), kind: 'range', clipId: c.id, track: c.track, inT: 0, outT: t, open: false, stars: 0, text: '', notes: [], created: Date.now() }; sels().push(S.curSel); }
  S.activeTrack = c.track;
  log('out', { clip: c.id, pos: t });
  changed();
}
function addMarker() {
  S.curSel = { id: uid(), kind: 'marker', t: S.T, stars: 0, text: '', notes: [], created: Date.now() };
  sels().push(S.curSel); changed(); return S.curSel;
}
function selRange(s) {   // real-Zeiten der Auswahl
  if (s.kind === 'marker') return [s.t, s.t];
  const c = S.byId.get(s.clipId); return [c.s + s.inT, c.s + s.outT];
}
async function deleteSel(s) {
  // Sprachnotizen bleiben gespeichert, damit „Rückgängig“ sie zurückholen kann
  log('loeschen', { id: s.id, kind: s.kind });
  S.state.selections = sels().filter((x) => x !== s);
  if (S.curSel === s) S.curSel = null;
  changed();
}
function changed() { S.rev = (S.rev || 0) + 1; save(); renderSide(); requestDraw(); markSaved(false); recordHistory(); }

/* ---------- Cut-Takt ----------
 * Schnittversion abspielen und bei jedem gewünschten Schnitt ✂ tippen. Jede Aufnahme = Take.
 * Ein neuerer Take ersetzt in seinem Zeitbereich die Cuts älterer Takes. */
function toggleCutMode(on = !CUT.mode) {
  if (!on) stopCutRec();
  CUT.mode = on; $('cutbar').classList.toggle('hidden', !on);
  log('cutmodus', { an: on });
  if (on) toast('▶ = Takt-Aufnahme nach 3-2-1 · ✂ = Cut (auch einzeln ohne Aufnahme) · ■ = Stopp', 4500);
  requestDraw();
}
function cutNow() { const c = S.byId.get(video.dataset.cid); return c && S.playing ? c.s + video.currentTime : S.T; }
function cutTap() {
  if (CUT.countdown) return;
  if (!CUT.rec) { singleCut(cutNow()); return; }
  const tNow = cutNow(); CUT.rec.cuts.push(tNow);
  log('cut', { pos: +tNow.toFixed(3) });
  const b = $('btnCut'); b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
  requestDraw();
}
// Einzel-Cut ohne Aufnahme: landet in der Zeile „Einzel-Cuts“, zählt mit seinem eigenen Zeitpunkt beim Ersetzen
function singleCut(tc) {
  let tk = S.state.takes.find((x) => x.single);
  if (!tk) { tk = { id: uid(), single: true, start: tc, end: tc, cuts: [], cutCreated: [], created: Date.now() }; S.state.takes.push(tk); }
  tk.cuts.push(tc); tk.cutCreated.push(Date.now());
  tk.start = Math.min(...tk.cuts); tk.end = Math.max(...tk.cuts);
  log('einzel-cut', { pos: +tc.toFixed(3) }); flash('✂ Cut gesetzt');
  const b = $('btnCut'); b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
  changed();
}
function startCutCountdown() {
  if (CUT.rec || CUT.countdown) return;
  stopPlay();
  let n = 3; const el = $('countdown'); el.textContent = n; el.classList.remove('hidden');
  log('cut-countdown', { pos: +S.T.toFixed(3) });
  CUT.countdown = setInterval(() => {
    n--; if (n > 0) { el.textContent = n; return; }
    clearInterval(CUT.countdown); CUT.countdown = null; el.classList.add('hidden');
    CUT.rec = { id: uid(), start: S.T, cuts: [], created: Date.now() };
    $('cutbar').classList.add('recording'); play(); requestDraw();
  }, 800);
}
function stopCutRec() {
  if (CUT.countdown) { clearInterval(CUT.countdown); CUT.countdown = null; $('countdown').classList.add('hidden'); return; }
  if (!CUT.rec) return;
  const take = { ...CUT.rec, end: S.T }; CUT.rec = null; $('cutbar').classList.remove('recording');
  stopPlay();
  if (take.end - take.start < 0.3) { toast('Aufnahme zu kurz – verworfen'); requestDraw(); return; }
  S.state.takes.push(take); S.selTake = take.id;
  log('cut-take', { cuts: take.cuts.length, von: +take.start.toFixed(2), bis: +take.end.toFixed(2) });
  changed(); toast(`${take.cuts.length} Cuts aufgenommen – Take antippen, ✕ löscht`);
}
function effectiveCuts(takes = S.state.takes) {
  const ev = [];
  for (const tk of takes || []) {
    if (tk.single) tk.cuts.forEach((ct, i) => ev.push({ id: tk.id, start: ct, end: ct, cuts: [ct], created: (tk.cutCreated || [])[i] || tk.created }));
    else ev.push(tk);
  }
  let cuts = [];
  for (const tk of ev.sort((a, b) => a.created - b.created)) {
    if (tk.end > tk.start) cuts = cuts.filter((c) => c.t < tk.start || c.t > tk.end);
    cuts.push(...tk.cuts.map((ct) => ({ t: ct, take: tk.id })));
  }
  return cuts.sort((a, b) => a.t - b.t);
}
function deleteTake(id) { S.state.takes = S.state.takes.filter((x) => x.id !== id); S.selTake = null; log('take-geloescht', { id }); changed(); }

/* ---------- Rückgängig / Wiederholen ----------
 * Nach jeder Änderung wird der Stand (Auswahl + Versatz) verglichen; Unterschiede kommen auf den Stapel. */
const UNDO = []; const REDO = []; let lastSnap = null;
const snapState = () => JSON.stringify({ sel: S.state.selections, off: S.state.offsets, takes: S.state.takes || [], ev: S.state.ereignisse, bew: S.state.bewertungen });
function resetHistory() { UNDO.length = 0; REDO.length = 0; lastSnap = snapState(); updateUndoBtns(); }
function recordHistory() {
  const now = snapState();
  if (lastSnap !== null && now !== lastSnap) { UNDO.push(lastSnap); if (UNDO.length > 300) UNDO.shift(); REDO.length = 0; }
  lastSnap = now; updateUndoBtns();
}
function restoreSnap(js) {
  const d = JSON.parse(js);
  const keep = S.curSel && S.curSel.id;
  S.state.selections = d.sel; S.state.offsets = d.off; S.state.takes = d.takes || []; lastSnap = js;
  if (d.ev) S.state.ereignisse = d.ev;
  if (d.bew || S.state.bewertungen) S.state.bewertungen = d.bew || {};
  S.curSel = sels().find((x) => x.id === keep) || null;
  applyOffsets(); save(); renderSide(); requestDraw(); markSaved(false); showFrame(true); updateUndoBtns();
}
function undo() { if (rec || recStarting) { toast('Erst die Aufnahme beenden'); return; } if (!UNDO.length) { toast('Nichts rückgängig zu machen'); return; } REDO.push(lastSnap); restoreSnap(UNDO.pop()); log('undo', { rest: UNDO.length }); toast('Rückgängig', 900); }
function redo() { if (rec || recStarting || !REDO.length) return; UNDO.push(lastSnap); restoreSnap(REDO.pop()); log('redo'); toast('Wiederholt', 900); }
function updateUndoBtns() {
  document.querySelectorAll('[data-act=undo]').forEach((b) => { b.disabled = !UNDO.length; });
  document.querySelectorAll('[data-act=redo]').forEach((b) => { b.disabled = !REDO.length; });
}
function nudge(s, which, frames) {
  const c = S.byId.get(s.clipId);
  if (which === 'in') s.inT = clamp(snap(s.inT + frames / c.fps, c), 0, s.outT - 1 / c.fps);
  else s.outT = clamp(snap(s.outT + frames / c.fps, c), s.inT + 1 / c.fps, c.dur);
  S.T = c.s + (which === 'in' ? s.inT : s.outT - 1 / c.fps);
  showFrame(true); changed();
}
function jumpTo(s) {
  stopPlay();
  S.curSel = s;
  if (s.kind === 'range') { S.activeTrack = s.track; S.T = S.byId.get(s.clipId).s + s.inT; }
  else S.T = s.t;
  showFrame(true); changed();
}

/* ---------- Seitenleiste ---------- */
function trackOf(id) { return S.tracks.find((t) => t.id === id) || { label: id, color: '#888' }; }
function selLabel(s) {
  if (s.kind === 'marker' && s.shot && S.ver) {
    const sh = S.ver.manifest.shots.find((x) => x.id === s.shot);
    return { dot: '#4c9aff', l1: `💬 Shot ${sh ? sh.nr : '?'} · ${sh ? shotName(sh) : ''}`, l2: s.text || '' };
  }
  if (s.kind === 'marker') return { dot: '#fff', l1: `⚑ Marker ${clock(s.t)}`, l2: s.text || '' };
  const c = S.byId.get(s.clipId); const tr = trackOf(s.track);
  return { dot: tr.color, l1: `${tr.label} · ${c.name}`, l2: `${clock(c.s + s.inT)} · ${s.open ? 'nur IN – OUT fehlt' : durTxt(s.outT - s.inT)}${s.text ? ' · ' + s.text : ''}` };
}
function renderSide() {
  const list = $('selList');
  const all = [...sels()].sort((a, b) => selRange(a)[0] - selRange(b)[0]);
  $('selCount').textContent = `${all.filter((s) => s.kind === 'range').length} ${isVersionView() ? 'Bereiche' : 'Clips'} · ${all.filter((s) => s.kind === 'marker').length} Marker`;
  list.innerHTML = changesHtml();
  list.querySelectorAll('.chg').forEach((el) => el.onclick = () => {
    const sg = S.vsegs.find((x) => x.shot.id === el.dataset.shot); if (!sg) return;
    stopPlay(); S.curSel = null; S.T = S.clips[0].s + sg.a; showFrame(true); renderSide(); requestDraw();
  });
  if (list.innerHTML && all.length) list.insertAdjacentHTML('beforeend', '<div class="list-sub">Kommentare</div>');
  for (const s of all) {
    const L = selLabel(s);
    const el = document.createElement('div');
    el.className = 'sel-item' + (s === S.curSel ? ' cur' : '');
    el.innerHTML = `<span class="dot" style="background:${L.dot}"></span><div class="t"><div class="l1">${esc(L.l1)}</div><div class="l2">${esc(L.l2)}</div></div>
      <span class="st">${'★'.repeat(s.stars)}${s.notes.length ? ' 🎙' + s.notes.length : ''}</span>`;
    el.onclick = () => jumpTo(s);
    list.appendChild(el);
  }
  renderCurrent();
}
function renderCurrent() {
  updateNoteTarget();
  const box = $('current'); const s = S.curSel;
  if ((!s || !sels().includes(s)) && S.ver) { renderShotCard(box); return; }
  if (!s || !sels().includes(s)) { box.innerHTML = ''; return; }
  const L = selLabel(s);
  let h = `<div class="card-title"><span class="dot" style="background:${L.dot}"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(L.l1)}</span>
    <button class="ghost danger" data-k="del" title="Auswahl löschen">🗑</button></div>`;
  if (s.kind === 'range') {
    const c = S.byId.get(s.clipId);
    h += `<div class="card-row"><span class="lbl">IN</span><span class="val">${clock(c.s + s.inT, c.fps)}</span>
        <button data-k="in-1">−1</button><button data-k="in+1">+1</button></div>
      <div class="card-row"><span class="lbl">OUT</span><span class="val">${clock(c.s + s.outT, c.fps)}</span>
        <button data-k="out-1">−1</button><button data-k="out+1">+1</button></div>
      <div class="card-row"><span class="lbl">Länge</span><span class="val">${durTxt(s.outT - s.inT)} · ${Math.round((s.outT - s.inT) * c.fps)} Bilder</span>
        <button data-k="playsel">▶ Auswahl</button></div>`;
  }
  h += `<div class="card-row stars">${[1, 2, 3].map((n) => `<button data-k="star${n}" class="${s.stars >= n ? 'on' : ''}">★</button>`).join('')}</div>
    <input type="text" id="selText" placeholder="Notiz (optional)" value="${esc(s.text)}">
    <div class="notes">${s.notes.map((n, i) => `<div class="note">🎙 Sprachnotiz ${i + 1} · ${n.dur ? n.dur.toFixed(0) + ' s' : ''}
      <button data-k="pn${i}">▶</button><button data-k="dn${i}" class="ghost danger">✕</button></div>`).join('')}</div>`;
  box.innerHTML = h;
  box.querySelector('#selText').oninput = (e) => { s.text = e.target.value; save(); };
  box.querySelector('#selText').onchange = () => changed();
  box.querySelectorAll('button[data-k]').forEach((b) => b.onclick = async () => {
    const k = b.dataset.k;
    if (k === 'del') return deleteSel(s);
    if (k === 'in-1') return nudge(s, 'in', -1);
    if (k === 'in+1') return nudge(s, 'in', 1);
    if (k === 'out-1') return nudge(s, 'out', -1);
    if (k === 'out+1') return nudge(s, 'out', 1);
    if (k === 'playsel') return playSelection(s);
    if (k.startsWith('star')) { const n = +k.slice(4); s.stars = s.stars === n ? 0 : n; return changed(); }
    if (k.startsWith('pn')) return playNote(s.notes[+k.slice(2)]);
    if (k.startsWith('dn')) { const n = s.notes[+k.slice(2)]; s.notes = s.notes.filter((x) => x !== n); return changed(); }
  });
}
/* ---------- Shot-Bewertung (Edit-Tab) ----------
 * Jeder Shot der Version: ★ 1–3 oder Rot (= muss auf jeden Fall raus; reine Markierung, es wird nichts entfernt). Gilt für den sichtbaren Shot am Abspielzeiger.
 * Gespeichert je Version in ctx.bewertungen {Shot-ID: {wert, t}}; geht mit in die Speicherdatei. */
const shotNow = () => (S.ver ? shotAt(S.T - S.clips[0].s) : null);
// Kommentar zur Szene = Marker mit shot-ID (einer je Szene); create=true legt ihn am Abspielzeiger an
function shotComment(sh, create) {
  let m = sels().find((x) => x.kind === 'marker' && x.shot === sh.id);
  if (!m && create) { m = { id: uid(), kind: 'marker', shot: sh.id, t: S.T, stars: 0, text: '', notes: [], created: Date.now() }; sels().push(m); }
  return m || null;
}
function renderShotCard(box) {
  const sg = shotNow();
  S.cardShot = sg ? sg.shot.id : null;
  if (!sg) { box.innerHTML = ''; return; }
  const sh = sg.shot, fps = S.ver.manifest.fps, b = (S.state.bewertungen || {})[sh.id], w = b ? b.wert : 0;
  box.innerHTML = `<div class="card-title"><span class="dot" style="background:${sh.editierbar ? '#4c9aff' : '#6b6f76'}"></span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Shot ${sh.nr} · ${esc(shotName(sh))}</span></div>
    <div class="card-row"><span class="val">${clock(sh.v_in / fps, fps)} – ${clock(sh.v_out / fps, fps)} · ${durTxt((sh.v_out - sh.v_in) / fps)}</span></div>
    <div class="hint" style="margin:2px 0 4px">${sh.editierbar ? 'Änderbar' : 'Gesperrt: ' + esc(sh.grund || '') + ' – kommentierbar'}</div>
    ${slipCardHtml(sh)}
    <div class="card-row stars">${[1, 2, 3].map((n) => `<button data-r="${n}" class="${w !== 'rot' && w >= n ? 'on' : ''}" title="${n} Stern${n > 1 ? 'e' : ''} (Taste ${n})">★</button>`).join('')}
      <button data-r="rot" class="rot${w === 'rot' ? ' on' : ''}" title="Muss auf jeden Fall raus (Taste X)">✕ Muss raus</button></div>
    <div class="hint">★ brauchbar · ★★ gut · ★★★ Favorit · <b>Muss raus</b> = darf auf keinen Fall drin bleiben (wird nur markiert). Ohne Bewertung = noch offen.</div>
    <input type="text" id="shotText" placeholder="Kommentar zu dieser Szene" value="${esc((shotComment(sh) || {}).text || '')}">
    <div class="notes">${((shotComment(sh) || {}).notes || []).map((n, i) => `<div class="note">🎙 Sprachnotiz ${i + 1} · ${n.dur ? n.dur.toFixed(0) + ' s' : ''}
      <button data-pn="${i}">▶</button><button data-dn="${i}" class="ghost danger">✕</button></div>`).join('')}
      <button data-k="rec" class="rec-scene">🎙 Sprachnotiz zu dieser Szene</button></div>`;
  box.querySelectorAll('[data-r]').forEach((x) => x.onclick = () => rateShot(x.dataset.r === 'rot' ? 'rot' : +x.dataset.r));
  slipCardBind(box, sh);
  const ti = box.querySelector('#shotText');
  ti.oninput = (e) => { const m = shotComment(sh, true); m.text = e.target.value; save(); };
  ti.onchange = () => { const m = shotComment(sh); if (m && !m.text && !m.notes.length) S.state.selections = sels().filter((x) => x !== m); changed(); };
  box.querySelector('[data-k=rec]').onclick = () => toggleRec();
  box.querySelectorAll('[data-pn]').forEach((x) => x.onclick = () => playNote(shotComment(sh).notes[+x.dataset.pn]));
  box.querySelectorAll('[data-dn]').forEach((x) => x.onclick = () => { const m = shotComment(sh); m.notes = m.notes.filter((_, i) => i !== +x.dataset.dn); changed(); });
}
function rateShot(wert) {
  const sg = shotNow(); if (!sg) { toast('Kein Shot am Abspielzeiger'); return; }
  const B = S.state.bewertungen = S.state.bewertungen || {};
  const id = sg.shot.id;
  if (B[id] && B[id].wert === wert) delete B[id]; else B[id] = { wert, t: Date.now() };
  log('shot-bewertung', { shot: id, nr: sg.shot.nr, wert: B[id] ? wert : null });
  if (B[id] && navigator.vibrate) navigator.vibrate(10);
  changed(); updateReelBar();
}
const RATE_COL = { 1: '#f2c14e', 2: '#f2c14e', 3: '#f2c14e', rot: '#ff453a' };

/* ---------- Shortlist abspielen ----------
 * Nur die In/Out-Stellen chronologisch hintereinander – zum Bewerten mit Sternen. */
let reel = null;
function playShortlist() {
  const list = sels().filter((s) => s.kind === 'range' && !s.open).sort((a, b) => selRange(a)[0] - selRange(b)[0]);
  if (!list.length) { toast('Noch keine fertige Auswahl (IN + OUT)'); return; }
  let i = list.indexOf(S.curSel); if (i < 0) i = 0;
  reel = { list, i }; log('shortlist-start', { n: list.length, ab: i + 1 });
  document.body.classList.add('reel'); reelStep();
}
function reelStep() {
  if (!reel) return;
  const s = reel.list[reel.i];
  if (!s) { endReel(); toast('Shortlist durch'); return; }
  reel.stepping = true; jumpTo(s); reel.stepping = false;
  updateReelBar(); lastToggle = 0; play();
}
function reelMove(d) { if (!reel) return false; reel.i = clamp(reel.i + d, 0, reel.list.length); reelStep(); return true; }
function endReel() { if (!reel) return; log('shortlist-ende', { bei: reel.i + 1 }); reel = null; document.body.classList.remove('reel'); stopPlay(); updateReelBar(); }
function updateReelBar() {
  const el = $('reelBar'); if (!el) return;
  if (!reel) { el.classList.add('hidden'); return; }
  const s = reel.list[reel.i]; el.classList.remove('hidden');
  el.querySelector('.reel-pos').textContent = `${reel.i + 1}/${reel.list.length}`;
  el.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('on', !!s && s.stars >= +b.dataset.star));
}
function setStars(n) {
  if (S.ver && !reel) { rateShot(n); return; } // Edit-Tab: Tasten/Leiste bewerten die Szene am Abspielzeiger (F11)
  const s = (reel && reel.list[reel.i]) || S.curSel;
  if (!s || s.kind !== 'range') return;
  s.stars = s.stars === n ? 0 : n; log('sterne', { id: s.id, n: s.stars }); changed(); updateReelBar();
}
let selStop = null;
function playSelection(s) {
  jumpTo(s); play();
  const end = selRange(s)[1];
  clearInterval(selStop);
  selStop = setInterval(() => { if (!S.playing || S.T >= end) { clearInterval(selStop); stopPlay(); } }, 30);
}

/* ---------- Sprachnotizen ---------- */
let rec = null; let recStarting = false;
// Auswahl unter dem Abspielzeiger (aktive Spur zuerst)
function selAtPlayhead() {
  const hits = sels().filter((x) => x.kind === 'range' && (() => { const [a, b] = selRange(x); return S.T >= a && S.T <= b; })());
  return hits.find((x) => x.track === S.activeTrack) || hits[0] || null;
}
const recBtns = (on) => document.querySelectorAll('[data-act=rec], .rec-scene').forEach((b) => b.classList.toggle('on', on));
async function toggleRec() {
  if (rec) { rec.stop(); return; }
  if (recStarting) return;
  recStarting = true;
  stopPlay();
  const ctxObj = S.state; // Ziel-Kontext vor dem ersten await festhalten (F01)
  let s = S.curSel && sels().includes(S.curSel) ? S.curSel : null;
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { recStarting = false; log('mikro-fehler', { name: e.name, msg: e.message }); toast('Kein Mikrofonzugriff – in den Einstellungen erlauben'); return; }
  if (!s && S.ver && shotNow()) s = shotComment(shotNow().shot, true); // Edit-Tab: Szene am Abspielzeiger
  if (!s) s = selAtPlayhead();
  if (!s) { s = addMarker(); toast('Keine Auswahl am Abspielzeiger → Notiz als Marker gespeichert'); }
  S.curSel = s.shot ? null : s; renderSide();
  const target = { pid: S.proj.id, ctx: ctxObj, selId: s.id, t: S.T };
  const chunks = []; const t0 = Date.now();
  let r;
  try { r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch (e) { recStarting = false; stream.getTracks().forEach((x) => x.stop()); log('mikro-fehler', { name: e.name }); toast('Aufnahme nicht möglich'); return; }
  r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  r.onstop = async () => {
    stream.getTracks().forEach((x) => x.stop());
    rec = null; recBtns(false);
    const blob = new Blob(chunks, { type: r.mimeType || mime || 'audio/mp4' });
    const n = { id: uid(), mime: blob.type, dur: (Date.now() - t0) / 1000, created: Date.now() };
    await DB.put('notes', blob, n.id);
    if (!S.proj || S.proj.id !== target.pid) { log('notiz-projekt-gewechselt', { pid: target.pid, sel: target.selId }); toast('Notiz gespeichert, aber Projekt gewechselt'); return; }
    // Ziel über die ID neu suchen – Undo/Löschen kann das alte Objekt ersetzt haben; immer im Kontext der Aufnahme
    const list = target.ctx.selections;
    let dest = list.find((x) => x.id === target.selId);
    if (!dest) { dest = { id: uid(), kind: 'marker', t: target.t, stars: 0, text: '', notes: [], created: Date.now() }; list.push(dest); toast('Auswahl war weg → Notiz als Marker gespeichert'); }
    dest.notes.push(n);
    if (S.state === target.ctx && !dest.shot) S.curSel = dest;
    log('notiz-ende', { s: n.dur.toFixed(1), zu: dest.id });
    changed();
  };
  rec = r; recStarting = false;
  r.start(); recBtns(true); log('notiz-start', { zu: s.id });
}
let noteAudio = null;
async function playNote(n) {
  const b = await DB.get('notes', n.id); if (!b) return;
  if (noteAudio) noteAudio.pause();
  noteAudio = new Audio(URL.createObjectURL(b)); noteAudio.play();
}

/* ---------- Timeline (Canvas) ---------- */
const cv = $('tl'); const ctx = cv.getContext('2d');
const RULER = 26, HEAD = 92;
let drawPending = false;
function requestDraw() { if (!drawPending) { drawPending = true; requestAnimationFrame(draw); } }
function resizeCanvas() {
  const r = cv.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestDraw();
}
window.addEventListener('resize', resizeCanvas);
function laneGeom() {
  const h = cv.height / (window.devicePixelRatio || 1);
  const nt = ((S.state && S.state.takes) ? S.state.takes.length : 0) + (CUT.rec ? 1 : 0);
  const lh = Math.max(30, Math.min(70, (h - RULER - 6 - COM_H - nt * TAKE_H) / S.tracks.length));
  const cy = RULER + 4 + S.tracks.length * lh;
  return { lh, y: (i) => RULER + 4 + i * lh, cy, ty: (k) => cy + COM_H + k * TAKE_H, nt };
}
const W = () => cv.width / (window.devicePixelRatio || 1);
// Beim Ziehen eines In/Out-Griffs bleibt die Ansicht stehen (viewLock), sonst läuft sie mit dem Playhead
let viewLock = null;
const viewD = () => (viewLock ?? r2d(S.T));
const xOf = (r) => HEAD + (W() - HEAD) / 2 + (r2d(r) - viewD()) * S.pps;
const rOfX = (x) => d2r(viewD() + (x - HEAD - (W() - HEAD) / 2) / S.pps);

function draw() {
  drawPending = false;
  if (!S.proj) return;
  const w = W(), h = cv.height / (window.devicePixelRatio || 1);
  const { lh, y } = laneGeom();
  const FS = S.fs; // Vollbild: Hintergrund durchsichtig, Clips halbtransparent über dem Video
  ctx.clearRect(0, 0, w, h);
  if (!FS) { ctx.fillStyle = '#111214'; ctx.fillRect(0, 0, w, h); }
  const dNow = viewD();
  const selByClip = new Map();
  for (const s of sels()) if (s.kind === 'range') { if (!selByClip.has(s.clipId)) selByClip.set(s.clipId, []); selByClip.get(s.clipId).push(s); }
  const cx = HEAD + (w - HEAD) / 2;
  const dL = dNow - (cx - HEAD) / S.pps, dR = dNow + (w - cx) / S.pps;

  // Lanes
  S.tracks.forEach((t, i) => {
    ctx.fillStyle = FS ? (t.id === S.activeTrack ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.03)') : (t.id === S.activeTrack ? '#1d2127' : '#16181b');
    ctx.fillRect(HEAD, y(i), w - HEAD, lh - 4);
    if (t.id === S.activeTrack) { ctx.fillStyle = t.color + '26'; ctx.fillRect(HEAD, y(i), w - HEAD, lh - 4); }
  });

  // Clips
  ctx.save(); ctx.beginPath(); ctx.rect(HEAD, 0, w - HEAD, h); ctx.clip();
  for (const c of S.clips) {
    const d0 = r2d(c.s), d1 = r2d(c.s + c.dur);
    if (d1 < dL || d0 > dR) continue;
    const ti = S.tracks.findIndex((t) => t.id === c.track); if (ti < 0) continue;
    const x0 = cx + (d0 - dNow) * S.pps, x1 = cx + (d1 - dNow) * S.pps;
    const yy = y(ti) + 2, hh = lh - 8;
    ctx.save(); ctx.beginPath(); roundRect(x0, yy, Math.max(2, x1 - x0), hh, 5); ctx.clip();
    if (FS) ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#2a2e34'; ctx.fillRect(x0, yy, x1 - x0, hh);
    const img = S.sprites.get(c.id);
    if (img && img.complete && img.naturalWidth) {
      const tw = hh * 16 / 9;
      const sx0 = Math.max(x0, HEAD - tw); const k0 = Math.floor((sx0 - x0) / tw);
      for (let x = x0 + k0 * tw; x < Math.min(x1, w); x += tw) {
        const tMid = ((x + tw / 2) - x0) / S.pps;
        const idx = clamp(Math.floor(tMid / c.spriteStep), 0, c.spriteN - 1);
        ctx.drawImage(img, idx * 160, 0, 160, 90, x, yy, tw, hh);
      }
    }
    ctx.fillStyle = c.missing ? '#000a' : '#0003'; ctx.fillRect(x0, yy, x1 - x0, hh);
    if (S.ver && S.vsegs) drawShots(c, yy, hh, w);
    // Clip hat Auswahl → alles außerhalb ausgrauen (bleibt sichtbar, nur gedämpft)
    const cs = selByClip.get(c.id);
    if (cs) {
      const iv = cs.map((s) => [xOf(c.s + s.inT), xOf(c.s + s.outT)]).sort((a, b) => a[0] - b[0]);
      if (isVersionView()) {
        // Review einer Schnittversion: der kommentierte Bereich wird dunkler, der Rest bleibt normal
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        for (const [a, b] of iv) ctx.fillRect(a, yy, b - a, hh);
      } else {
        ctx.fillStyle = 'rgba(14,15,17,0.68)';
        let cur = x0;
        for (const [a, b] of iv) { if (a > cur) ctx.fillRect(cur, yy, a - cur, hh); cur = Math.max(cur, b); }
        if (cur < x1) ctx.fillRect(cur, yy, x1 - cur, hh);
      }
    }
    ctx.restore();
    ctx.strokeStyle = trackOf(c.track).color; ctx.lineWidth = 1.5; if (FS) ctx.globalAlpha = 0.7;
    ctx.beginPath(); roundRect(x0 + 0.5, yy + 0.5, Math.max(2, x1 - x0 - 1), hh - 1, 5); ctx.stroke();
    ctx.globalAlpha = 1;
    if (x1 - x0 > 70 && !S.ver) {
      ctx.fillStyle = '#fff'; ctx.font = '600 11px -apple-system, Segoe UI, sans-serif';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
      ctx.fillText(c.name.replace(/_\d{6}_\w+\./, '.').replace(/\.(mov|mp4)$/i, ''), Math.max(x0, HEAD) + 5, yy + 13);
      ctx.shadowBlur = 0;
    }
  }

  // Auswahl
  for (const s of sels()) {
    if (s.kind === 'marker') {
      const x = xOf(s.t); if (x < HEAD || x > w) continue;
      ctx.strokeStyle = s === S.curSel ? '#f2c14e' : '#ffffffaa'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x + 10, RULER + 5); ctx.lineTo(x, RULER + 10); ctx.fill();
      continue;
    }
    const c = S.byId.get(s.clipId); if (!c) continue;
    const ti = S.tracks.findIndex((t) => t.id === c.track);
    const x0 = xOf(c.s + s.inT), x1 = xOf(c.s + s.outT);
    if (x1 < HEAD || x0 > w) continue;
    const yy = y(ti) + 2, hh = lh - 8, cur = s === S.curSel;
    if (s.open) {
      // nur In gesetzt: gestrichelt bis Clipende, Out kommt mit dem nächsten langen Drücken
      ctx.fillStyle = '#f2c14e22'; ctx.fillRect(x0, yy, x1 - x0, hh);
      ctx.strokeStyle = '#f2c14e'; ctx.setLineDash([5, 4]); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, yy + hh - 2); ctx.lineTo(x1, yy + hh - 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#f2c14e'; ctx.fillRect(x0 - 3, yy, 6, hh);
      ctx.font = '700 11px -apple-system, Segoe UI, sans-serif'; ctx.fillText('IN', x0 + 6, yy + 13);
      continue;
    }
    ctx.fillStyle = cur ? '#f2c14e40' : '#f2c14e1c'; ctx.fillRect(x0, yy, x1 - x0, hh);
    ctx.fillStyle = '#f2c14e'; ctx.fillRect(x0, yy + hh - 5, x1 - x0, 5);
    ctx.fillRect(x0 - (cur ? 3 : 1.5), yy, cur ? 6 : 3, hh);
    ctx.fillRect(x1 - (cur ? 3 : 1.5), yy, cur ? 6 : 3, hh);
    if (cur) {
      ctx.save(); ctx.shadowColor = '#f2c14e'; ctx.shadowBlur = 12; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); roundRect(x0 - 1, yy - 1, x1 - x0 + 2, hh + 2, 4); ctx.stroke(); ctx.restore();
    }
    if (s.stars || s.notes.length) {
      ctx.fillStyle = '#1a1400'; ctx.font = '700 11px sans-serif';
      ctx.fillText('★'.repeat(s.stars) + (s.notes.length ? ' 🎙' : ''), x0 + 6, yy + hh - 9);
    }
  }

  // Cut-Takes: eine Zeile je Aufnahme mit gelben Strichen; gültige Cuts zusätzlich als feine Linie über die Spuren
  {
    const G = laneGeom(); S.xbox = null;
    ctx.fillStyle = FS ? 'rgba(255,255,255,0.05)' : '#141518'; ctx.fillRect(HEAD, G.cy + 1, w - HEAD, COM_H - 3);
    for (const s of sels()) {
      if (s.kind !== 'marker') continue;
      const x = xOf(s.t); if (x < HEAD - 20 || x > w + 20) continue;
      const cur = s === S.curSel;
      ctx.fillStyle = cur ? '#f2c14e' : '#e8e8ec';
      ctx.beginPath(); roundRect(x - 2, G.cy + 4, 18, COM_H - 9, 4); ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = '700 10px sans-serif'; ctx.fillText(s.notes.length ? '🎙' : '⚑', x + 1, G.cy + 18);
    }
    const takes = [...(S.state.takes || [])]; if (CUT.rec) takes.push({ ...CUT.rec, end: S.T, live: true });
    const eff = new Set(effectiveCuts().map((c) => c.take + ':' + c.t));
    takes.forEach((tk, k) => {
      const yy = G.ty(k), x0 = xOf(tk.start), x1 = xOf(tk.end), sel = tk.id === S.selTake;
      ctx.fillStyle = sel ? 'rgba(242,193,78,0.25)' : 'rgba(255,255,255,0.07)'; ctx.fillRect(x0, yy + 1, Math.max(2, x1 - x0), TAKE_H - 3);
      if (tk.live) { ctx.strokeStyle = '#ff453a'; ctx.lineWidth = 2; ctx.strokeRect(x0, yy + 1, Math.max(2, x1 - x0), TAKE_H - 3); }
      for (const ct of tk.cuts) {
        const x = xOf(ct); const on = tk.live || eff.has(tk.id + ':' + ct);
        ctx.fillStyle = on ? '#f2c14e' : 'rgba(242,193,78,0.28)'; ctx.fillRect(x - 1.25, yy + 2, 2.5, TAKE_H - 5);
        if (on) { ctx.fillStyle = 'rgba(242,193,78,0.5)'; ctx.fillRect(x - 0.75, RULER, 1.5, G.ty(0) - RULER); }
      }
      if (sel) { // ✕ rechts oben im gewählten Take = löschen
        const bx = Math.min(x1, w - 4) - 26, by = yy + 1;
        ctx.fillStyle = '#ff453a'; ctx.beginPath(); roundRect(bx, by, 24, TAKE_H - 3, 5); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '700 13px sans-serif'; ctx.fillText('✕', bx + 6, by + 15);
        S.xbox = { id: tk.id, box: [bx, by, 24, TAKE_H - 3] };
      }
    });
  }

  // Lücken
  for (const g of S.axis.gaps) {
    const x = cx + ((g.d0 + g.d1) / 2 - dNow) * S.pps; if (x < HEAD - 40 || x > w + 40) continue;
    ctx.strokeStyle = '#555'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, h); ctx.stroke(); ctx.setLineDash([]);
    if ((g.d1 - g.d0) * S.pps > 4 || S.pps > 2) {
      ctx.fillStyle = '#8b9098'; ctx.font = '10px sans-serif';
      ctx.fillText('+' + (g.real >= 3600 ? (g.real / 3600).toFixed(1).replace('.', ',') + ' h' : g.real >= 60 ? Math.round(g.real / 60) + ' min' : Math.round(g.real) + ' s'), x + 3, RULER + 10);
    }
  }
  ctx.restore();

  // Lineal
  ctx.fillStyle = FS ? 'rgba(0,0,0,0.35)' : '#1a1c1f'; ctx.fillRect(0, 0, w, RULER);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const st = steps.find((s) => s * S.pps >= 90) || 3600;
  ctx.fillStyle = FS ? '#e8e8ec' : '#8b9098'; ctx.strokeStyle = FS ? '#ffffff88' : '#3a3f46'; ctx.font = (FS ? '600 ' : '') + '11px ui-monospace, Menlo, Consolas, monospace';
  for (const sg of S.axis.segs) {
    const sd1 = sg.d0 + sg.r1 - sg.r0; if (sd1 < dL || sg.d0 > dR) continue;
    for (let r = Math.ceil(sg.r0 / st) * st; r <= sg.r1; r += st) {
      const x = cx + (sg.d0 + r - sg.r0 - dNow) * S.pps; if (x < HEAD || x > w) continue;
      ctx.beginPath(); ctx.moveTo(x, RULER - 7); ctx.lineTo(x, RULER); ctx.stroke();
      ctx.fillText(clock(r).slice(0, st >= 60 ? 5 : 8), x + 3, 15);
    }
  }

  // Spurköpfe
  S.tracks.forEach((t, i) => {
    ctx.fillStyle = FS ? (t.id === S.activeTrack ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)') : (t.id === S.activeTrack ? '#23262a' : '#1a1c1f');
    ctx.fillRect(0, y(i), HEAD - 4, lh - 4);
    ctx.fillStyle = t.color; ctx.fillRect(0, y(i), t.id === S.activeTrack ? 7 : 4, lh - 4);
    ctx.fillStyle = t.id === S.activeTrack ? '#fff' : '#b8bcc2'; ctx.font = '600 12px -apple-system, Segoe UI, sans-serif';
    wrapText(t.label, 10, y(i) + 16, HEAD - 16, 14);
    const off = S.state.offsets[t.id] || 0;
    if (off) { ctx.fillStyle = '#f2c14e'; ctx.font = '10px sans-serif'; ctx.fillText((off > 0 ? '+' : '') + off.toFixed(1) + ' s', 10, y(i) + lh - 10); }
  });
  if (!FS) { ctx.fillStyle = '#1a1c1f'; ctx.fillRect(0, 0, HEAD - 4, RULER); }
  ctx.fillStyle = '#8b9098'; ctx.font = '10px sans-serif'; ctx.fillText('Spuren', 10, 16);
  { const G = laneGeom(); const n = (S.state.takes || []).length + (CUT.rec ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const live = CUT.rec && k === n - 1;
      ctx.fillStyle = FS ? 'rgba(0,0,0,0.45)' : '#1a1c1f'; ctx.fillRect(0, G.ty(k) + 1, HEAD - 4, TAKE_H - 3);
      ctx.fillStyle = live ? '#ff453a' : '#f2c14e'; ctx.font = '600 11px -apple-system, Segoe UI, sans-serif';
      const tk = (S.state.takes || [])[k];
      ctx.fillText(live ? '● Aufnahme' : (tk && tk.single ? '✂ Einzel-Cuts' : `✂ Take ${k + 1}`), 8, G.ty(k) + 16);
    }
    ctx.fillStyle = FS ? 'rgba(0,0,0,0.45)' : '#1a1c1f'; ctx.fillRect(0, G.cy + 1, HEAD - 4, COM_H - 3);
    ctx.fillStyle = '#e8e8ec'; ctx.font = '600 11px -apple-system, Segoe UI, sans-serif'; ctx.fillText('💬 Kommentar', 8, G.cy + 18);
  }

  // Playhead
  const px = cx + (r2d(S.T) - dNow) * S.pps;
  ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  ctx.fillStyle = '#e5484d'; ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.fill();
}
// Edit-Tab: Shots der Version auf der Spur – änderbare hell, gesperrte schraffiert (bleiben kommentierbar)
function drawShots(c, yy, hh, w) {
  for (const sg of S.vsegs) {
    const a = xOf(c.s + sg.a), b = xOf(c.s + sg.b);
    if (b < HEAD || a > w) continue;
    const sh = sg.shot;
    if (sh.editierbar) { ctx.fillStyle = 'rgba(76,154,255,0.22)'; ctx.fillRect(a, yy, b - a, hh); }
    else {
      ctx.save(); ctx.beginPath(); ctx.rect(a, yy, b - a, hh); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
      for (let x = a - hh; x < b; x += 8) { ctx.beginPath(); ctx.moveTo(x, yy + hh); ctx.lineTo(x + hh, yy); ctx.stroke(); }
      ctx.restore();
    }
    const bw = (S.state.bewertungen || {})[sh.id];
    if (bw) {
      ctx.fillStyle = bw.wert === 'rot' ? 'rgba(255,69,58,0.38)' : 'rgba(242,193,78,0.16)'; ctx.fillRect(a, yy, b - a, hh);
      ctx.fillStyle = RATE_COL[bw.wert]; ctx.fillRect(a, yy + hh - 5, b - a, 5);
      if (b - a > 26) { ctx.font = '700 11px sans-serif'; ctx.fillText(bw.wert === 'rot' ? '✕' : '★'.repeat(bw.wert), Math.max(a, HEAD) + 5, yy + hh - 9); }
    }
    ctx.fillStyle = '#0b0b0d'; ctx.fillRect(a - 1, yy, 2, hh);
    const az = effZiel(sh);
    if (az) {
      ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 2; ctx.strokeRect(a + 1, yy + 1, b - a - 2, hh - 2);
      if (b - a > 40) { ctx.fillStyle = '#f2c14e'; ctx.font = '700 11px sans-serif'; ctx.fillText('✎ ' + deltaTxt(sh, az.src_in), Math.max(a, HEAD) + 5, yy + hh / 2 + 4); }
    }
    if (b - a > 34) {
      ctx.save(); ctx.beginPath(); ctx.rect(a + 2, yy, b - a - 4, hh); ctx.clip();
      ctx.fillStyle = sh.editierbar ? '#fff' : '#9a9ea6'; ctx.font = '600 11px -apple-system, Segoe UI, sans-serif';
      ctx.fillText(`${sh.nr}`, Math.max(a, HEAD) + 5, yy + 13);
      if (b - a > 70) { ctx.font = '11px -apple-system, Segoe UI, sans-serif'; ctx.fillText(shotName(sh), Math.max(a, HEAD) + 5, yy + 27); }
      ctx.restore();
    }
  }
}
const shotName = (sh) => String(sh.name || sh.clip || '').replace(/_\d{6}_\w+$/, '').replace(/\.(mov|mp4|mxf)$/i, '');
function roundRect(x, y, w, h, r) {
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function wrapText(t, x, y, maxW, lh) {
  const words = t.split(' '); let line = '';
  for (const wd of words) {
    const test = line ? line + ' ' + wd : wd;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, y); line = wd; y += lh; } else line = test;
  }
  ctx.fillText(line, x, y);
}

/* ---------- Gesten ---------- */
const ptrs = new Map();
let g = null; // aktuelle Geste
function hit(x, y) {
  const G = laneGeom();
  if (y >= G.cy && y < G.cy + COM_H) {
    if (x < HEAD) return { type: 'comment' };
    const m = sels().filter((s) => s.kind === 'marker').map((s) => ({ s, d: Math.abs(xOf(s.t) + 7 - x) })).sort((a, b) => a.d - b.d)[0];
    return m && m.d < 18 ? { type: 'comment', marker: m.s } : { type: 'comment' };
  }
  if (G.nt && y >= G.ty(0)) {
    const tk = (S.state.takes || [])[Math.floor((y - G.ty(0)) / TAKE_H)];
    if (!tk) return { type: 'empty' };
    if (S.xbox && S.xbox.id === tk.id) { const [bx, , bw] = S.xbox.box; if (x >= bx - 8 && x <= bx + bw + 8) return { type: 'takex', take: tk }; }
    return { type: 'take', take: tk };
  }
  const { lh, y: ly } = G;
  const ti = Math.floor((y - RULER - 4) / lh);
  const track = S.tracks[ti];
  if (x < HEAD) return { type: 'head', track };
  if (!track) return { type: 'empty' };
  // Griffe der Auswahl (aktuelle zuerst)
  const cand = [...sels()].filter((s) => s.kind === 'range' && s.track === track.id).sort((a) => (a === S.curSel ? -1 : 1));
  for (const s of cand) {
    const c = S.byId.get(s.clipId);
    const xi = xOf(c.s + s.inT), xo = xOf(c.s + s.outT);
    if (Math.abs(x - xi) < 18) return { type: 'handle', s, which: 'in', track };
    if (Math.abs(x - xo) < 18) return { type: 'handle', s, which: 'out', track };
  }
  for (const s of cand) {
    const c = S.byId.get(s.clipId);
    if (x > xOf(c.s + s.inT) && x < xOf(c.s + s.outT)) return { type: 'sel', s, track };
  }
  return { type: 'lane', track };
}
cv.addEventListener('pointerdown', (e) => {
  try { cv.setPointerCapture(e.pointerId); } catch { /* synthetische Events */ }
  const r = cv.getBoundingClientRect();
  ptrs.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
  if (ptrs.size === 2) {
    if (g) clearTimeout(g.lp);
    viewLock = null; $('loupe').classList.add('hidden');
    const [a, b] = [...ptrs.values()];
    g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), pps0: S.pps };
    return;
  }
  const p = ptrs.get(e.pointerId);
  const h = hit(p.x, p.y);
  g = { ...h, x0: p.x, y0: p.y, lastX: p.x, moved: false, t0: performance.now(), fine: false, dT: r2d(S.T) };
  stopPlay();
  if (h.type === 'lane' || h.type === 'sel' || h.type === 'empty') g.lp = setTimeout(longPressMark, MARK_LONGPRESS_MS);
  if (h.type === 'handle') {
    viewLock = r2d(S.T);
    S.curSel = h.s; S.activeTrack = h.s.track; renderSide(); requestDraw();
    g.lp = setTimeout(() => startFine(), LONGPRESS_MS);
    const c = S.byId.get(h.s.clipId);
    g.base = h.which === 'in' ? h.s.inT : h.s.outT;
    g.clip = c;
  }
});
function longPressMark() {
  if (!g || g.moved || ptrs.size !== 1 || !['lane', 'sel', 'empty'].includes(g.type)) return;
  g.lpDone = true;
  markAtPlayhead();
}
// In bzw. Out am Abspielzeiger: erstes langes Drücken = In, zweites = Out (Timeline oder Video)
function markAtPlayhead() {
  stopPlay();
  const c = clipAt(S.activeTrack, S.T) || shownClip();
  if (!c) { toast('Am Abspielzeiger ist kein Clip'); return; }
  S.activeTrack = c.track;
  const t = snap(S.T - c.s, c);
  const open = sels().find((s) => s.kind === 'range' && s.open && s.clipId === c.id);
  if (open) {
    let a = Math.min(open.inT, t), b = Math.max(open.inT, t) + 1 / c.fps; // Out schließt das Bild ein
    open.inT = a; open.outT = Math.min(b, c.dur); open.open = false; S.curSel = open;
    flash('OUT gesetzt'); log('lang-out', { clip: c.id, in: a, out: open.outT });
  } else {
    newOpenSel(c, t);
    flash('IN gesetzt – nochmal lange drücken für OUT'); log('lang-in', { clip: c.id, pos: t });
  }
  if (navigator.vibrate) navigator.vibrate(15);
  showFrame(true); changed();
}
function flash(msg) {
  const L = $('loupe'); L.textContent = msg; L.classList.remove('hidden');
  clearTimeout(flash._t); flash._t = setTimeout(() => L.classList.add('hidden'), 1300);
}
function startFine() {
  if (!g || g.type !== 'handle') return;
  g.fine = true; g.fineX = g.lastX; g.base = g.which === 'in' ? g.s.inT : g.s.outT;
  showHandleFrame(); updateLoupe();
}
cv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId) || !g) return;
  const r = cv.getBoundingClientRect();
  const p = { x: e.clientX - r.left, y: e.clientY - r.top };
  ptrs.set(e.pointerId, p);
  if (g.type === 'pinch' && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    S.pps = clamp(g.pps0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, 0.3, 600);
    requestDraw(); return;
  }
  if (g.lpDone) return;
  const dx = p.x - g.x0;
  if (Math.abs(dx) > 6 || Math.abs(p.y - g.y0) > 6) { if (!g.moved && g.lp && !g.fine) clearTimeout(g.lp); g.moved = true; }
  g.lastX = p.x;
  if (g.type === 'handle') {
    const c = g.clip, s = g.s;
    let t = g.fine ? g.base + Math.round((p.x - g.fineX) / FINE_PX_PER_FRAME) / c.fps
      : (rOfX(p.x) - c.s);
    t = snap(t, c);
    if (g.which === 'in') s.inT = clamp(t, 0, s.outT - 1 / c.fps); else s.outT = clamp(t, s.inT + 1 / c.fps, c.dur);
    showHandleFrame(); if (g.fine) updateLoupe();
    requestDraw(); return;
  }
  if (g.type === 'lane' || g.type === 'sel' || g.type === 'empty' || g.type === 'head' || g.type === 'take' || g.type === 'takex' || g.type === 'comment') {
    if (!g.moved) return;
    S.T = d2r(clamp(g.dT - dx / S.pps, -1, S.axis.total + 1));
    showFrame(false); requestDraw();
  }
});
function showHandleFrame() {
  const s = g.s, c = g.clip;
  S.T = c.s + (g.which === 'in' ? s.inT : Math.max(s.inT, s.outT - 1 / c.fps));
  showFrame(true);
}
function updateLoupe() {
  const s = g.s, c = g.clip; const t = g.which === 'in' ? s.inT : s.outT;
  const L = $('loupe'); L.classList.remove('hidden');
  L.textContent = `${g.which.toUpperCase()} · ${clock(c.s + t, c.fps)} · Bild ${Math.round(t * c.fps)} · ziehen = ±1 Bild`;
}
function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (!g) return;
  if (g.type === 'pinch') { if (ptrs.size === 0) { g = null; save(); } return; }
  clearTimeout(g.lp);
  if (!g.lpDone) $('loupe').classList.add('hidden');
  viewLock = null;
  if (g.lpDone) { g = null; requestDraw(); return; }
  if (!g.moved && !g.fine && g.type === 'comment') {
    if (g.marker) { S.curSel = g.marker; log('kommentar-gewaehlt', { id: g.marker.id }); renderSide(); }
    else if (S.ver && shotNow()) { S.curSel = null; log('kommentar-szene', { pos: +S.T.toFixed(3) }); toggleRec(); }
    else { S.curSel = addMarker(); log('kommentar-neu', { pos: +S.T.toFixed(3) }); toggleRec(); }
    g = null; requestDraw(); return;
  }
  if (!g.moved && !g.fine && (g.type === 'take' || g.type === 'takex')) {
    if (g.type === 'takex') deleteTake(g.take.id);
    else { S.selTake = S.selTake === g.take.id ? null : g.take.id; log('take-gewaehlt', { id: S.selTake }); }
    g = null; requestDraw(); return;
  }
  if (!g.moved && !g.fine) {
    if (g.type === 'head' && g.track && !isVersionView()) offsetDialog(g.track);
    else if (g.type === 'sel' || g.type === 'handle') { S.curSel = g.s; S.activeTrack = g.track.id; }
    else if (g.type === 'lane') {
      S.activeTrack = g.track.id;
      // Tippen auf einen Clip: Playhead dorthin
      const r = rOfX(g.x0); const c = clipAt(g.track.id, r);
      if (c) S.T = r;
      if (S.curSel && S.curSel.kind === 'range' && S.curSel.track !== g.track.id) S.curSel = null; // Notizziel nicht auf fremder Spur lassen
      if (S.ver) S.curSel = null; // Edit-Tab: Tipp auf eine Szene zeigt deren Karte (F11)
      log('spur', { track: g.track.id, clip: c && c.id });
    }
    showFrame(true); renderSide();
  } else if (g.type === 'handle') { changed(); }
  else save();
  g = null; requestDraw();
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', (e) => {
  ptrs.delete(e.pointerId);
  if (g) { clearTimeout(g.lp); log('geste-abgebrochen', { typ: g.type }); }
  viewLock = null; $('loupe').classList.add('hidden'); g = null; requestDraw();
});
cv.addEventListener('wheel', (e) => {
  e.preventDefault(); stopPlay();
  if (e.ctrlKey || e.metaKey) { S.pps = clamp(S.pps * Math.exp(-e.deltaY / 300), 0.3, 600); }
  else { const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY); S.T = d2r(clamp(r2d(S.T) + d / S.pps, -1, S.axis.total + 1)); showFrame(false); }
  requestDraw(); save();
}, { passive: false });

/* ---------- Spur-Versatz ---------- */
function offsetDialog(track) {
  const show = () => {
    const off = S.state.offsets[track.id] || 0;
    modal(`<h2>${esc(track.label)} verschieben</h2>
      <p class="hint">Falls die Uhr dieser Kamera falsch ging: Spur so verschieben, dass gleichzeitige Momente übereinander liegen. Die Auswahl wandert mit.</p>
      <p style="font:700 22px ui-monospace,Menlo,monospace;text-align:center">${off > 0 ? '+' : ''}${off.toFixed(2)} s</p>
      <div class="row" style="justify-content:center">${[-60, -10, -1, -0.1, -0.02, 0.02, 0.1, 1, 10, 60].map((v) => `<button data-v="${v}">${v > 0 ? '+' : ''}${String(v).replace('.', ',')}</button>`).join('')}</div>
      <div class="row"><button data-v="reset">Zurücksetzen</button><button id="mOk" class="primary">Fertig</button></div>`, (b) => {
      b.querySelectorAll('button[data-v]').forEach((x) => x.onclick = () => {
        S.state.offsets[track.id] = x.dataset.v === 'reset' ? 0 : Math.round(((S.state.offsets[track.id] || 0) + +x.dataset.v) * 100) / 100;
        applyOffsets(); showFrame(true); changed(); show();
      });
      b.querySelector('#mOk').onclick = closeModal;
    });
  };
  S.activeTrack = track.id; show();
}

/* ---------- Export / Laden ---------- */
const blobToB64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });
/* Stand-Export „bt-stand“ (Vertrag 4): konsistenter Snapshot des ganzen Projekts mit stand_id/revision.
 * Shortlist-Kontext oben (wie v3 – import_auswahl.py liest das weiter), je Version ein Eintrag in `versionen`.
 * Was fehlt (Audio einer Notiz, Video einer Version, Footage), steht in `probleme` und wird beim Speichern angezeigt.
 * Der ganze Zustand wird VOR dem ersten await kopiert; danach kommen nur noch die Audio-Daten dazu (F04). */
// Zeitabbildung Export ↔ Import, immer paarweise (F09): Versionen/Videos relativ zum Videobeginn, Footage-Takes relativ
// zum Tagesbeginn des ersten Clips (nicht modulo 24 h – über Mitternacht bleibt der Tag erhalten)
const dayBase = (s0) => s0 - (((s0 % 86400) + 86400) % 86400);
const footView = (foot, legacy) => (!foot.length ? { clips: [], isVersion: false, base: 0, fps: 25 } // Kunden-Projekt ohne Footage
  : { clips: foot, isVersion: legacy, base: legacy ? foot[0].s0 : dayBase(foot[0].s0), fps: legacy ? foot[0].fps : 25 });
async function exportCtx(ctx, view, probleme, wo) {
  const byId = new Map(view.clips.map((c) => [c.id, c]));
  const at = (s) => (s.kind === 'marker' ? s.t : (byId.get(s.clipId) ? byId.get(s.clipId).s + s.inT : 0));
  const list = [...ctx.selections].sort((a, b) => at(a) - at(b));
  const rel = (x) => +(x - view.base).toFixed(3);
  const selections = []; let missingAudio = 0;
  for (const s of list) {
    const notes = [];
    for (const n of s.notes) {
      const b = await DB.get('notes', n.id);
      if (b) notes.push({ id: n.id, mime: n.mime, dur: n.dur, created: new Date(n.created).toISOString(), data: await blobToB64(b) });
      else missingAudio++;
    }
    const base = { id: s.id, kind: s.kind, stars: s.stars, text: s.text, created: new Date(s.created).toISOString(), notes, ...(s.shot ? { shot: s.shot } : {}) };
    if (s.kind === 'marker') {
      selections.push(view.isVersion ? { ...base, t: rel(s.t), frame: Math.round(rel(s.t) * view.fps), clock: clock(rel(s.t), view.fps) }
        : { ...base, clock: clock(s.t), t: s.t });
      continue;
    }
    const c = byId.get(s.clipId);
    if (!c) { probleme.push(`${wo}: Auswahl zu unbekanntem Clip ${s.clipId} ausgelassen`); continue; }
    const t0 = view.isVersion ? c.s - view.base : c.s; // Version: Uhr ab Videobeginn
    selections.push({
      ...base, track: s.track, clip: view.isVersion ? 'version' : c.id, name: c.name, original: c.original, fps: c.fps,
      in: +s.inT.toFixed(4), out: +s.outT.toFixed(4),
      inFrame: Math.round(s.inT * c.fps), outFrame: Math.round(s.outT * c.fps), open: !!s.open,
      clockIn: clock(t0 + s.inT, c.fps), clockOut: clock(t0 + s.outT, c.fps),
    });
  }
  if (missingAudio) probleme.push(`${wo}: ${missingAudio} Sprachnotiz(en) ohne Audio auf diesem Gerät`);
  const takes = (ctx.takes || []).map((tk) => ({ id: tk.id, single: !!tk.single, start: rel(tk.start), end: rel(tk.end), created: new Date(tk.created).toISOString(), cuts: tk.cuts.map(rel), cutCreated: tk.cutCreated || null }));
  const cuts = effectiveCuts(ctx.takes).map((c) => ({ t: rel(c.t), frame: Math.round(rel(c.t) * view.fps), tc: clock(rel(c.t), view.fps), take: c.take }));
  return { offsets: ctx.offsets || {}, selections, takes, cuts };
}
// Shot-Bewertungen lesbar + maschinenlesbar (Shot-Instanz, Clip, Sequenzbilder [in, out))
function shotRatings(v) {
  const shots = new Map(v.manifest.shots.map((s) => [s.id, s]));
  return Object.entries(v.ctx.bewertungen || {}).map(([id, b]) => {
    const sh = shots.get(id) || {};
    return { shot: id, nr: sh.nr, clip: sh.clip, name: sh.name, v_in: sh.v_in, v_out: sh.v_out, wert: b.wert, t: new Date(b.t).toISOString() };
  }).sort((a, b) => (a.v_in || 0) - (b.v_in || 0));
}
async function buildExport() {
  if (S.state) { S.state.activeTrack = S.activeTrack; S.state.T = S.T; S.state.pps = S.pps; }
  // Snapshot: alles, was exportiert wird, jetzt kopieren – Bedienung und Aufnahmen danach ändern ihn nicht mehr
  const proj = S.proj, meta = proj.meta, probleme = [];
  S.ps.revision = (S.ps.revision || 0) + 1;
  const ps = JSON.parse(JSON.stringify(S.ps));
  const foot = S.footClips.map((c) => ({ ...c }));
  const view = { tab: ps.tab, version_id: S.ver ? S.ver.version_id : null, T: S.T, activeTrack: S.activeTrack, pps: S.pps };
  save();
  const out = {
    format: 'bt-stand', contract: 4, stand_id: 's-' + uid(), revision: ps.revision,
    project_id: await projPid(proj), project: meta.name, projectCreated: meta.created,
    exported: new Date().toISOString(), device: navigator.userAgent, kind: meta.kind || 'footage',
    tracks: meta.tracks,
  };
  const legacy = meta.kind === 'version'; // „Schnittversion prüfen“: ein Video ohne Manifest
  Object.assign(out, await exportCtx(ps.shortlist, footView(foot, legacy), probleme, legacy ? 'Video' : 'Shortlist'));
  if (proj.missing) probleme.push(`Footage: ${proj.missing} Dateien fehlen auf diesem Gerät (Auswahl bleibt erhalten)`);
  out.versionen = [];
  for (const v of ps.versions) {
    const vv = { clips: [versionClip(v)], isVersion: true, base: VBASE, fps: v.manifest.fps };
    const x = await exportCtx(v.ctx, vv, probleme, verLabel(v));
    if (!(await DB.keys('files')).includes(v.file)) probleme.push(`${verLabel(v)}: Video fehlt auf diesem Gerät (Kommentare sind trotzdem gesichert)`);
    out.versionen.push({ version_id: v.version_id, export_id: v.export_id, sequenz: v.manifest.sequenz, datei: v.datei, fps: v.manifest.fps,
      timeline_fingerprint: v.manifest.timeline_fingerprint, importiert: new Date(v.imported).toISOString(),
      ereignisse: v.ctx.ereignisse || [], auftraege: BTV.auftraege(v.manifest, v.ctx.ereignisse || []),
      kommentare: x.selections, takes: x.takes, cuts: x.cuts, bewertungen: shotRatings(v) });
  }
  // Stände zu Versionen, die auf diesem Gerät (noch) nicht importiert sind, unverändert mitgeben – nichts geht verloren
  for (const w of Object.values(ps.wartend || {})) { out.versionen.push(w); probleme.push(`${w.sequenz || w.version_id}: nur Stand, Version auf diesem Gerät nicht importiert`); }
  out.probleme = probleme;
  out.view = view; out.app = APP_VERSION;
  if (probleme.length) log('export-probleme', { n: probleme.length, erste: probleme[0] });
  return out;
}
/* Speichern = Datei mit dem ganzen Arbeitsstand (Auswahl, Marker, Notizen, Versatz, Position).
 * Öffnen lädt sie wieder – auf jedem Gerät, auf dem das Projekt importiert ist, auch ohne Internet. */
const saveName = (proj = S.proj) => proj.meta.name.replace(/[^\w-]+/g, '_') + '_Stand.json';
function markSaved(saved) {
  S.dirty = !saved;
  $('btnSave').textContent = saved ? 'Speichern' : 'Speichern •';
  if (!saved && S.bkSent && $('btnSend').textContent === 'Gesendet ✓') $('btnSend').textContent = 'Senden';
}
async function saveFile() {
  if (rec || recStarting) { toast('Erst die Sprachnotiz beenden'); return; }
  stopPlay();
  const rev = S.rev, proj = S.proj;
  log('speichern-start', { eintraege: sels().length });
  const data = await buildExport();
  // Log nur mit Einträgen DIESES Projekts (F03)
  data.log = LOG.filter((e) => e.p === proj.id).slice(-1500).map(logLine);
  const nR = data.selections.filter((s) => s.kind === 'range').length;
  const nN = data.selections.reduce((a, s) => a + s.notes.length, 0)
    + data.versionen.reduce((a, v) => a + (v.kommentare || []).reduce((b, s) => b + (s.notes || []).length, 0), 0);
  const nK = data.versionen.reduce((a, v) => a + (v.kommentare || []).length, 0);
  const nB = data.versionen.reduce((a, v) => a + (v.bewertungen || []).length, 0);
  const summary = `${nR} Clips, ${data.selections.length - nR} Marker` + (data.versionen.length ? `, ${data.versionen.length} Version${data.versionen.length > 1 ? 'en' : ''} mit ${nK} Kommentaren und ${nB} Bewertungen` : '') + `, ${nN} Sprachnotizen`;
  const probHtml = data.probleme.length ? `<div class="problems"><b>${data.probleme.length} Hinweis${data.probleme.length > 1 ? 'e' : ''}:</b><ul>${data.probleme.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : '';
  const done = (wo) => {
    if (!data.probleme.length) { toast(`Gespeichert: ${wo} (${summary})`, 3500); return; }
    modal(`<h2>Gespeichert – mit Hinweisen</h2><p>${esc(wo)}<br>${summary}.</p>${probHtml}<div class="row"><span class="grow"></span><button class="primary" onclick="closeModal()">OK</button></div>`);
  };
  const dir = await projectDir(true, proj);
  if (dir) {
    try {
      await writeStand(dir, data, proj);
      if (S.rev === rev) markSaved(true);
      log('speichern-ordner', { datei: saveName(proj), stand: data.stand_id });
      done(`${dir.name}/${saveName(proj)}`); return;
    } catch (e) { log('speichern-ordner-fehler', { msg: e.message }); }
  }
  const name = saveName(proj);
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
  const download = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    if (S.rev === rev) markSaved(true);
    log('speichern-datei', { name, aktuell: S.rev === rev, stand: data.stand_id });
  };
  const touch = matchMedia('(pointer: coarse)').matches;
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  if (!touch || !canShare) { download(); done(`${name} im Download-Ordner`); return; }
  // iPad: Teilen braucht einen frischen Fingertipp → kurzer Dialog
  modal(`<h2>Speichern</h2><p>${summary}.</p>${probHtml}
    <p class="hint">„Teilen“ → „In Dateien sichern“ → z. B. in den OneDrive-Projektordner. Mit „Öffnen“ machst du später genau hier weiter – auch auf einem anderen Gerät.</p>
    <div class="row"><button id="mClose">Abbrechen</button><button id="mDl">Herunterladen</button><button id="mShare" class="primary">Teilen</button></div>`, (b) => {
    b.querySelector('#mClose').onclick = closeModal;
    b.querySelector('#mDl').onclick = () => { download(); closeModal(); };
    b.querySelector('#mShare').onclick = () => navigator.share({ files: [file], title: name })
      .then(() => { if (S.rev === rev) markSaved(true); log('speichern-geteilt', { name, stand: data.stand_id }); closeModal(); toast('An „Teilen“ übergeben'); }).catch((e) => log('teilen-abgebrochen', { name: e.name }));
  });
}
async function readSaveFile(f) {
  let d; try { d = JSON.parse(await f.text()); } catch { toast('Datei nicht lesbar'); return null; }
  if (d.format !== 'bt-sichtung-auswahl' && d.format !== 'bt-stand') { toast('Keine Framepoint-Speicherdatei'); return null; }
  if (d.format === 'bt-stand' && d.contract !== 4) { toast('Speicherdatei aus einer neueren App-Version – bitte App aktualisieren', 4500); return null; }
  if (!Array.isArray(d.selections)) { toast('Speicherdatei unvollständig'); return null; }
  return d;
}
// Gehört die Datei zu diesem Projekt? Ab Vertrag 4 über die feste Projekt-ID, ältere Dateien über den Namen (F02)
async function belongsTo(d, proj) {
  return d.format === 'bt-stand' && d.project_id ? d.project_id === await projPid(proj) : d.project === proj.meta.name;
}
const hasContent = (ps) => contexts(ps).some((c) => c.selections.length || (c.takes || []).length
  || Object.keys(c.bewertungen || {}).length || (c.ereignisse || []).length) || Object.keys(ps.wartend || {}).length > 0;
async function openSaveFile(f) { const d = await readSaveFile(f); if (d) await openStand(d, false); }
async function openStand(d, fromHome) {
  if (!(await belongsTo(d, S.proj))) { toast(`Die Datei gehört zu einem anderen Projekt („${d.project}“)`, 4000); return; }
  if (rec || recStarting) { toast('Erst die Sprachnotiz beenden'); return; }
  const apply = () => loadSelection(d);
  if (!hasContent(S.ps) || (!S.dirty && !fromHome)) return apply();
  modal(`<h2>Stand öffnen?</h2><p>${Array.isArray(d.versionen)
    ? 'Dein Stand auf diesem Gerät – Shortlist <b>und alle Versionen</b> mit Kommentaren und Bewertungen – wird durch den Stand aus der Datei ersetzt.'
    : 'Ältere Speicherdatei: Die <b>Shortlist</b> wird durch den Stand aus der Datei ersetzt, Versionen bleiben unverändert.'}</p>
    <div class="row"><button id="mNo">Abbrechen</button><button id="mYes" class="primary">Ersetzen</button></div>`, (b) => {
    b.querySelector('#mNo').onclick = closeModal;
    b.querySelector('#mYes').onclick = () => { closeModal(); apply(); };
  });
}
async function openSaveFileFromHome(f) {
  const d = await readSaveFile(f); if (!d) return;
  const projs = await DB.all('projects'), cands = [];
  for (const p of projs) if (await belongsTo(d, p)) cands.push(p);
  if (!cands.length) { toast(`Projekt „${d.project}“ ist auf diesem Gerät noch nicht importiert – erst den Projektordner importieren`, 5000); return; }
  if (cands.length > 1) { toast(`Mehrere Projekte heißen „${d.project}“ – bitte im Projekt selbst „Öffnen“ nutzen`, 5000); return; }
  await openProject(cands[0].id);
  await openStand(d, true);
}
// Auswahl/Kommentare aus einer Speicherdatei in Kontext-Form bringen (Audio der Notizen landet in IndexedDB)
async function importSels(arr, clipIdOf) {
  const list = []; let skipped = 0;
  for (const x of arr || []) {
    const notes = [];
    for (const n of x.notes || []) {
      if (n.data) {
        const bin = Uint8Array.from(atob(n.data), (ch) => ch.charCodeAt(0));
        await DB.put('notes', new Blob([bin], { type: n.mime }), n.id);
      }
      notes.push({ id: n.id, mime: n.mime, dur: n.dur, created: Date.parse(n.created) });
    }
    const base = { id: x.id, kind: x.kind, stars: x.stars || 0, text: x.text || '', notes, created: Date.parse(x.created) };
    if (x.kind === 'marker') { list.push({ ...base, t: x.t, ...(x.shot ? { shot: x.shot } : {}) }); continue; }
    const cid = clipIdOf(x);
    if (cid) list.push({ ...base, clipId: cid, track: x.track, inT: x.in, outT: x.out, open: !!x.open });
    else skipped++;
  }
  return { list, skipped };
}
const importTakes = (arr, base) => (arr || []).map((tk) => ({ id: tk.id, single: !!tk.single, start: base + tk.start, end: base + tk.end, created: Date.parse(tk.created) || Date.now(), cuts: tk.cuts.map((x) => base + x), ...(tk.cutCreated ? { cutCreated: tk.cutCreated } : {}) }));
const keepView = (c) => ({ T: c.T, pps: c.pps, activeTrack: c.activeTrack });
// Versions-Kontext aus einem `versionen`-Eintrag (Zeiten dort = Sekunden ab Versionsbeginn)
async function ctxFromStand(v, ver, keep) {
  const { list } = await importSels((v.kommentare || []).map((x) => (x.kind === 'marker' ? { ...x, t: VBASE + x.t } : x)), () => 'v:' + ver.version_id);
  return newCtx({ ...(keep || {}), selections: list, offsets: {}, takes: importTakes(v.takes, VBASE), ereignisse: v.ereignisse || [], activeTrack: 'VERSION',
    bewertungen: Object.fromEntries((v.bewertungen || []).map((b) => [b.shot, { wert: b.wert, t: Date.parse(b.t) || Date.now() }])) });
}
// Stand laden: erst den kompletten neuen Zustand vorbereiten, dann in einem Schritt übernehmen (F05).
// bt-stand = vollständige Wiederherstellung (Versionen, die nicht in der Datei sind, werden leer); v3-Datei = nur Shortlist.
async function loadSelection(d) {
  const legacy = S.proj.meta.kind === 'version';
  const f0 = S.footClips[0], fv = footView(S.footClips, legacy);
  const footIds = new Set(S.footClips.map((c) => c.id));
  // Legacy-Video in bt-stand: Marker stehen relativ zum Videobeginn → zurück auf die Basis (F09)
  const src = d.format === 'bt-stand' && legacy ? d.selections.map((x) => (x.kind === 'marker' ? { ...x, t: fv.base + x.t } : x)) : d.selections;
  const { list, skipped } = await importSels(src, (x) => (legacy ? f0.id : footIds.has(x.clip) ? x.clip : null));
  const shortlist = newCtx({ ...keepView(S.ps.shortlist), selections: list, offsets: d.offsets || {}, takes: importTakes(d.takes, fv.base) });
  if (d.view && (d.view.tab || 'shortlist') === 'shortlist') Object.assign(shortlist, { T: d.view.T ?? shortlist.T, activeTrack: d.view.activeTrack || shortlist.activeTrack, pps: d.view.pps || shortlist.pps });
  const full = Array.isArray(d.versionen);
  const verCtx = new Map(), wartend = {};
  for (const v of d.versionen || []) {
    const ver = S.ps.versions.find((x) => x.version_id === v.version_id);
    if (ver) verCtx.set(ver, await ctxFromStand(v, ver, keepView(ver.ctx))); else wartend[v.version_id] = v;
  }
  // Übernehmen
  const tab = S.ps.tab, av = S.ps.activeVersion;
  stopPlay(); endReel(); if (CUT.mode) toggleCutMode(false);
  S.state = null; S.hist = {};
  S.ps.shortlist = shortlist;
  if (full) {
    for (const ver of S.ps.versions) ver.ctx = verCtx.get(ver) || newCtx({ ...keepView(ver.ctx), ereignisse: [], activeTrack: 'VERSION' });
    S.ps.wartend = wartend;
  }
  for (const c of S.footClips) c.s = c.s0 + (shortlist.offsets[c.track] || 0);
  closeModal();
  const back = tab === 'edit' && S.ps.versions.some((v) => v.version_id === av);
  await enterContext(back ? 'edit' : 'shortlist', back ? av : null);
  await save(true); markSaved(true);
  log('stand-geoeffnet', { format: d.format, stand: d.stand_id, auswahl: list.length, versionen: verCtx.size, wartend: Object.keys(wartend).length, voll: full });
  const nv = verCtx.size, nw = Object.keys(wartend).length;
  toast(`Stand geöffnet: ${list.length} Einträge` + (nv ? ` · ${nv} Version${nv > 1 ? 'en' : ''}` : '') + (skipped ? ` (${skipped} Clips fehlen im Projekt)` : '')
    + (nw ? ` · ${nw} Version${nw > 1 ? 'en' : ''} noch importieren` : ''), 4500);
}

/* ---------- Hilfe ---------- */
function help() {
  modal(`<h2>So geht’s</h2><ul>
    <li><b>Timeline wischen</b> = spulen (Playhead bleibt in der Mitte). <b>Zwei Finger auseinander</b> = zoomen. Am PC: Mausrad spult, Strg+Mausrad zoomt.</li>
    <li><b>Spur antippen</b> = diese Kamera im Bild zeigen. Gleichzeitige Aufnahmen liegen übereinander.</li>
    <li><b>IN</b> / <b>OUT</b> setzen die Auswahl am Playhead (Tasten I / O). OUT schließt das aktuelle Bild ein.</li>
    <li><b>Gelben Rand ziehen</b> = In/Out verschieben. <b>Lange draufhalten</b> = Lupe: jede Fingerbewegung = 1 Bild.</li>
    <li>In der Seitenleiste: −1 / +1 Bild, Sterne, Text, Sprachnotizen (🎙, Taste N).</li>
    <li><b>⚑ Marker</b> = Notiz zu einer Stelle ohne Clip-Auswahl (z. B. „ab hier Essen“).</li>
    <li><b>Spurname antippen</b> = Spur verschieben, falls die Kamera-Uhr falsch ging.</li>
    <li>Lücken ohne Aufnahme sind auf 2 s gekürzt (gestrichelt, mit echter Dauer).</li>
    <li><b>Lange auf die Timeline oder aufs Video drücken</b> = IN am Abspielzeiger, nochmal lange drücken = OUT. Beliebig viele Stellen pro Clip; alles außerhalb wird ausgegraut. Lange auf einen gelben Rand drücken = Lupe zum Feinjustieren.</li>
    <li><b>Shortlist | Edit</b> oben: <b>Shortlist</b> = Footage sichten. <b>Edit</b> = eine Schnittversion dieses Drehs ansehen und kommentieren. Mit <b>Edit ▾</b> Versionen wählen oder importieren (im Ordner <i>Versionen</i> Video + gleichnamige .json auswählen). Jede Version hat eigene Kommentare, Cut-Takes, Position und Rückgängig. Die Spur zeigt die Shots der Version: blau = änderbar, schraffiert = gesperrt (kommentierbar). ⏮ ⏭ springen von Shot zu Shot. Rechts: Shot am Abspielzeiger mit <b>★ 1–3</b> oder <b>✕ Muss raus</b> (rot, nur Markierung – es wird nichts entfernt) bewerten, Tasten 1–3 / X.</li>
    <li><b>Schnittversion prüfen</b> (Startseite): ein fertiges Video laden. <b>✂</b> in der Leiste öffnet den Cut-Takt: <b>▶</b> startet die Takt-Aufnahme nach 3-2-1, <b>✂</b> setzt Cuts (ohne Aufnahme: ein einzelner Cut am Abspielzeiger), rotes <b>■</b> stoppt. Jede Aufnahme ist ein Take (gelbe Striche); neuere Takes ersetzen ältere in ihrem Bereich. Take antippen → ✕ löscht. Am PC: B = Aufnahme, C = Cut, V = Stopp.</li>
    <li><b>▶★ Shortlist abspielen</b>: spielt nur deine In/Out-Stellen nacheinander; oben ★★★ zum Bewerten (Taste 1–3), ⏮ ⏭ = vorige/nächste Stelle, Play/Pause beendet.</li>
    <li><b>💬 Kommentar-Zeile</b> unter den Spuren antippen = Marker am Abspielzeiger + Sprachnotiz startet sofort (🎙 nochmal = Ende). Vorhandenen Kommentar antippen = auswählen. Bereich kommentieren: IN/OUT setzen + Notiz – bei Schnittversionen wird der Bereich dunkler.</li>
    <li>Die Zeile <b>„🎙 Notiz zu …“</b> zeigt immer, wohin die nächste Sprachnotiz geht. Eintrag in der Shortlist oder auf der Timeline antippen = auswählen.</li>
    <li><b>↶</b> oben rechts = Rückgängig (auch Löschen), <b>↷</b> = Wiederholen.</li>
    <li><b>⛶ Vollbild</b>: Video bildschirmfüllend, Timeline durchsichtig darüber. <b>•••</b> klappt die Knöpfe aus. Aufs Video tippen = Play/Pause.</li>
    <li>Am PC: Leertaste = Play, ←/→ = ±1 Bild, Shift+←/→ = ±1 s, M = Marker, F = Vollbild, Strg+Z = Rückgängig.</li>
    <li>Alles wird automatisch auf diesem Gerät gespeichert. <b>Speichern</b> erstellt eine Datei mit deinem Stand; mit <b>Öffnen</b> machst du damit weiter – auch auf einem anderen Gerät, ohne Internet. Die Datei bekommt auch Claude.</li>
  </ul><p class="hint">Framepoint ${APP_VERSION} · Blue Tacit Productions</p>
  <div class="row"><button id="mLog">Log ansehen</button><button onclick="location.href='labor/sync.html'">Sync-Test (Labor)</button><span class="grow"></span><button class="primary" onclick="closeModal()">OK</button></div>`,
  (b) => { b.querySelector('#mLog').onclick = showLog; });
}

/* ---------- Bedienung ---------- */
let lastToggle = 0;
const ACT = {
  play: () => {
    const now = performance.now();
    if (now - lastToggle < 400) { log('play-doppelt-ignoriert'); return; } // iOS: Tipp + nachgereichter Klick
    lastToggle = now;
    return S.playing ? stopPlay() : play();
  },
  backF: () => stepFrames(-1), fwdF: () => stepFrames(1),
  back1s: () => jumpSec(-1), fwd1s: () => jumpSec(1),
  prevClip: () => { if (reelMove(-1)) return; stopPlay(); const c = prevClipStart(S.T); if (c) { S.T = c.s; showFrame(true); requestDraw(); save(); } },
  nextClip: () => { if (reelMove(1)) return; stopPlay(); const c = nextClipStart(S.T); if (c) { S.T = c.s; showFrame(true); requestDraw(); save(); } },
  in: markIn, out: markOut, marker: addMarker, rec: toggleRec,
  mute: () => { S.muted = !S.muted; video.muted = S.muted; updateMute(); },
  undo, redo,
  fs: () => toggleFS(),
  cutmode: () => toggleCutMode(),
  cutstop: () => stopCutRec(),
  cutrec: () => startCutCountdown(),
  reel: () => (reel ? endReel() : playShortlist()),
  more: () => document.body.classList.toggle('fs-open'),
};
function updateMute() { document.querySelectorAll('[data-act=mute]').forEach((b) => { b.textContent = S.muted ? '🔇' : '🔊'; }); }
document.querySelectorAll('#reelBar [data-star]').forEach((b) => b.addEventListener('click', () => setStars(+b.dataset.star)));
document.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => { log('knopf', { act: b.dataset.act }); ACT[b.dataset.act](); }));
// Aufs Video tippen = Play/Pause
let vPress = null;
$('videoWrap').addEventListener('pointerdown', (e) => {
  if (e.target.closest('button') || (typeof SL !== 'undefined' && SL)) return;
  vPress = { x: e.clientX, y: e.clientY, long: false };
  vPress.timer = setTimeout(() => { if (vPress) { vPress.long = true; log('knopf', { act: 'video-lang' }); markAtPlayhead(); } }, MARK_LONGPRESS_MS);
});
$('videoWrap').addEventListener('pointermove', (e) => { if (vPress && Math.hypot(e.clientX - vPress.x, e.clientY - vPress.y) > 10) { clearTimeout(vPress.timer); vPress = null; } });
$('videoWrap').addEventListener('pointerup', (e) => {
  if (!vPress) return; clearTimeout(vPress.timer); e.preventDefault();
  if (!vPress.long) { log('knopf', { act: 'video-tap' }); ACT.play(); }
  vPress = null;
});
$('videoWrap').addEventListener('pointercancel', () => { if (vPress) clearTimeout(vPress.timer); vPress = null; });
$('videoWrap').addEventListener('contextmenu', (e) => e.preventDefault());
// ✂ reagiert schon beim Berühren (nicht erst beim Loslassen) – sonst hinkt der Takt hinterher
$('btnCut').addEventListener('pointerdown', (e) => { e.preventDefault(); cutTap(); });

/* ---------- Vollbild ---------- */
function toggleFS(on = !S.fs) {
  S.fs = on;
  document.body.classList.toggle('fs', on);
  if (!on) document.body.classList.remove('fs-open');
  const el = document.documentElement;
  try {
    if (on && !document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch { /* iPhone: kein Fullscreen-API – reicht als App ohnehin */ }
  log('vollbild', { an: on });
  setTimeout(resizeCanvas, 60); setTimeout(resizeCanvas, 400);
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.fs) toggleFS(false); });

/* ---------- Log ansehen ---------- */
function showLog() {
  const txt = LOG.slice(-400).map(logLine).join('\n');
  modal(`<h2>Log</h2><p class="hint">${LOG.length} Einträge. Bei Problemen „Teilen“ und mir die Datei schicken – sie steckt auch in jeder Speicherdatei.</p>
    <pre class="logbox">${esc(txt)}</pre>
    <div class="row"><button id="lLive">${S.liveLog ? 'Live-Log aus' : 'Live-Log an'}</button><button id="lClr" class="ghost danger">Leeren</button>
    <span class="grow"></span><button id="lShare" class="primary">Teilen / Sichern</button><button id="lOk">Schließen</button></div>`, (b) => {
    const pre = b.querySelector('.logbox'); pre.scrollTop = pre.scrollHeight;
    b.querySelector('#lOk').onclick = closeModal;
    b.querySelector('#lClr').onclick = () => { LOG.length = 0; logDirty = true; log('log-geleert'); showLog(); };
    b.querySelector('#lLive').onclick = () => { S.liveLog = !S.liveLog; $('liveLog').classList.toggle('hidden', !S.liveLog); renderLiveLog(); closeModal(); };
    b.querySelector('#lShare').onclick = () => {
      const d = new Date();
      const name = `framepoint_log_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
      const file = new File([`Framepoint ${APP_VERSION}\n${navigator.userAgent}\n\n` + LOG.map(logLine).join('\n')], name, { type: 'text/plain' });
      if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: name }).catch(() => {});
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click(); }
    };
  });
}
document.addEventListener('keydown', (e) => {
  if ($('editor').classList.contains('hidden') || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); ACT.play(); }
  else if (k === 'arrowleft') e.shiftKey ? ACT.back1s() : ACT.backF();
  else if (k === 'arrowright') e.shiftKey ? ACT.fwd1s() : ACT.fwdF();
  else if (k === 's' && (e.ctrlKey || e.metaKey)) saveFile();
  else if (k === 'z' && (e.ctrlKey || e.metaKey)) (e.shiftKey ? redo() : undo());
  else if (k === 'y' && (e.ctrlKey || e.metaKey)) redo();
  else if (k === 'f') toggleFS();
  else if (k === 'c' && CUT.mode) cutTap();
  else if (k === 'b' && CUT.mode) startCutCountdown();
  else if (k === 'r') ACT.reel();
  else if (k === '1' || k === '2' || k === '3') setStars(+k);
  else if (k === 'v' && CUT.mode) stopCutRec();
  else if (k === 'x' && S.ver) rateShot('rot');
  else if (k === 'escape' && S.fs) toggleFS(false);
  else if (k === 'i') ACT.in(); else if (k === 'o') ACT.out(); else if (k === 'm') ACT.marker(); else if (k === 'n') ACT.rec();
  else if (k === 'arrowup') { const i = S.tracks.findIndex((t) => t.id === S.activeTrack); S.activeTrack = S.tracks[Math.max(0, i - 1)].id; showFrame(true); requestDraw(); }
  else if (k === 'arrowdown') { const i = S.tracks.findIndex((t) => t.id === S.activeTrack); S.activeTrack = S.tracks[Math.min(S.tracks.length - 1, i + 1)].id; showFrame(true); requestDraw(); }
  else return;
  e.preventDefault();
});
$('btnBack').onclick = showHome;
$('btnSave').onclick = saveFile;
$('openInput').onchange = (e) => { if (e.target.files[0]) openSaveFile(e.target.files[0]); e.target.value = ''; };
$('homeOpenInput').onchange = (e) => { if (e.target.files[0]) openSaveFileFromHome(e.target.files[0]); e.target.value = ''; };
$('btnHelp').onclick = help; $('btnHelp2').onclick = help;
$('importInput').onchange = (e) => { if (e.target.files.length) importFiles(e.target.files); e.target.value = ''; };
$('versionInput').onchange = (e) => {
  const fs = [...e.target.files]; e.target.value = '';
  // Video + .json (bt-version) = Version eines Projekts (auch ohne Footage, z. B. beim Kunden); nur Video = einfaches Prüf-Video
  if (fs.some((f) => /\.json$/i.test(f.name))) importKundenVersion(fs);
  else if (fs[0]) importVersion(fs[0]);
};
// Kunde hat nur Video + JSON: gehört die Version zu einem Projekt auf dem Gerät, dorthin; sonst ein Kunden-Projekt ohne Footage anlegen
async function importKundenVersion(files) {
  let m = null;
  for (const f of files.filter((x) => /\.json$/i.test(x.name))) {
    try { const d = JSON.parse(await f.text()); if (d.format === 'bt-version') { m = d; break; } } catch { /* nächste */ }
  }
  if (!m) { toast('In der Auswahl ist keine Versionsdatei (.json) – bitte Video und JSON zusammen auswählen', 5000); return; }
  const mf = m.contract === 4 ? manifestFehler(m) : `Vertrag ${m.contract}`;
  if (mf) { toast(`Versionsdatei ist fehlerhaft (${mf})`, 5000); return; }
  let p = null;
  for (const x of await DB.all('projects')) if ((await projPid(x)) === m.project_id) p = x;
  if (!p) {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    p = { id: m.project_id, project_id: m.project_id, bytes: 0, missing: 0, opened: Date.now(),
      meta: { format: 'bt-sichtung', version: 1, kind: 'kunde', name: m.projekt || m.sequenz, project_id: m.project_id, created: m.erstellt || '', tracks: [], clips: [] } };
    await DB.put('projects', p);
    log('kunden-projekt', { projekt: p.meta.name, pid: m.project_id });
  }
  await openProject(p.id);
  await importVersionPair(files);
}
// Schnittversion = ein fertiges/halbfertiges Video als eigenes Projekt (eine Spur), zum Prüfen und Cut-Takt-Tippen
async function importVersion(f) {
  const name = f.name.replace(/\.[^.]+$/, '');
  modal(`<h2>Importiere ${esc(name)}</h2><p class="hint">Video wird auf das Gerät kopiert …</p>`);
  const blob = new Blob([await f.arrayBuffer()], { type: f.type || 'video/mp4' });
  const dur = await new Promise((res) => {
    const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => res(v.duration); v.onerror = () => res(0); v.src = URL.createObjectURL(blob);
  });
  if (!dur || !isFinite(dur)) { closeModal(); toast('Video lässt sich nicht lesen (Format?)'); log('version-fehler', { name }); return; }
  const ext = (f.name.match(/\.[^.]+$/) || ['.mp4'])[0].toLowerCase();
  const meta = { format: 'bt-sichtung', version: 1, kind: 'version', name, created: new Date().toISOString().slice(0, 19),
    tracks: [{ id: 'VERSION', label: 'Schnittversion' }],
    clips: [{ id: 'version', track: 'VERSION', name: f.name, file: 'version' + ext, sprite: 'version.jpg', spriteN: 1, spriteStep: dur,
      start: '2000-01-01T00:00:00.000', dur, fps: 25, original: f.name }] };
  const same = (await DB.all('projects')).find((x) => x.meta.name === name);
  const id = same ? same.id : name + '|' + meta.created;
  await DB.put('files', blob, id + '/' + meta.clips[0].file);
  await DB.put('projects', { id, meta, bytes: blob.size, missing: 0, opened: Date.now() });
  log('version-import', { name, dauer: +dur.toFixed(2), mb: +(blob.size / 1e6).toFixed(1) });
  closeModal(); await showHome(); openProject(id);
}

/* ---------- Versionen (v4): MP4 + gleichnamige JSON aus OneDrive\Sichtung\<Projekt>\Versionen ----------
 * Import prüft das Paar (F01): Format/Vertrag, Projekt-ID, SHA-1 des Videos = export.sha1, Länge = dauer_frames.
 * Gleiche version_id (gleiche Timeline) mit neuem Export → Video wird ersetzt, Kommentare/Änderungen bleiben. */
function versionSheet() {
  const vs = S.ps.versions, w = Object.values(S.ps.wartend || {});
  const row = (v) => {
    const m = v.manifest, n = m.shots.length, ne = m.shots.filter((s) => s.editierbar).length;
    const nk = v.ctx.selections.length, nev = (v.ctx.ereignisse || []).length;
    const br = Object.values(v.ctx.bewertungen || {}), nrot = br.filter((x) => x.wert === 'rot').length;
    return `<div class="ver${S.ver === v ? ' cur' : ''}"><div class="info"><div class="name">${esc(m.sequenz)}</div>
      <div class="meta">${durTxt(m.dauer_frames / m.fps)} · ${ne} von ${n} Shots änderbar · ${nk} Kommentar${nk === 1 ? '' : 'e'}${nev ? ` · ${nev} Änderung${nev === 1 ? '' : 'en'}` : ''}${br.length ? ` · ${br.length} bewertet${nrot ? ` (${nrot} rot)` : ''}` : ''}<br>
      importiert ${new Date(v.imported).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</div></div>
      <button class="primary" data-open="${esc(v.version_id)}">Öffnen</button><button class="ghost danger" data-del="${esc(v.version_id)}" title="Version vom Gerät entfernen">✕</button></div>`;
  };
  modal(`<h2>Versionen</h2>
    <div class="ver-list">${vs.length ? vs.map(row).join('') : '<p class="hint">Noch keine Version in diesem Projekt.</p>'}
    ${w.map((x) => `<div class="ver wait"><div class="info"><div class="name">${esc(x.sequenz || x.version_id)}</div><div class="meta">Stand vorhanden – Video + JSON noch importieren</div></div></div>`).join('')}</div>
    <label class="import-btn"><input id="verInput" type="file" multiple accept=".json,.mp4,application/json,video/mp4"><span>＋ Version importieren</span></label>
    <p class="hint">Im Ordner <b>Versionen</b> das Video <b>und</b> die gleichnamige .json auswählen. Die App prüft, ob beide zusammengehören.</p>
    <div class="row"><span class="grow"></span><button id="mOk">Schließen</button></div>`, (b) => {
    b.querySelector('#mOk').onclick = closeModal;
    b.querySelector('#verInput').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) importVersionPair(fs); };
    b.querySelectorAll('[data-open]').forEach((x) => x.onclick = () => { closeModal(); enterContext('edit', x.dataset.open); });
    b.querySelectorAll('[data-del]').forEach((x) => x.onclick = () => deleteVersion(S.ps.versions.find((v) => v.version_id === x.dataset.del)));
  });
}
function importError(msg, data) {
  log('version-abgelehnt', { grund: msg, ...(data || {}) });
  modal(`<h2>Version nicht importiert</h2><p>${esc(msg)}</p><div class="row"><span class="grow"></span><button class="primary" id="mOk">OK</button></div>`,
    (b) => { b.querySelector('#mOk').onclick = versionSheet; });
}
// Manifest vollständig prüfen, BEVOR Medien angefasst werden (F08). Rückgabe: Fehlertext oder null.
function manifestFehler(m) {
  const int = (x) => Number.isInteger(x) && x >= 0;
  const e = m.export || {};
  if (typeof m.version_id !== 'string' || !m.version_id) return 'version_id fehlt';
  if (typeof m.sequenz !== 'string') return 'sequenz fehlt';
  if (!(m.fps > 0 && m.fps <= 120)) return 'fps ungültig';
  if (!int(m.dauer_frames) || !m.dauer_frames) return 'dauer_frames ungültig';
  if (typeof e.export_id !== 'string' || typeof e.sha1 !== 'string' || !/^[0-9a-f]{40}$/.test(e.sha1)) return 'export (export_id/sha1) ungültig';
  if (typeof e.datei !== 'string' || !e.datei || /[\\/]/.test(e.datei)) return 'export.datei ungültig';
  if (!Array.isArray(m.shots) || !m.shots.length) return 'keine Shots';
  const ids = new Set();
  for (const sh of m.shots) {
    if (typeof sh.id !== 'string' || ids.has(sh.id)) return `Shot-ID fehlt/doppelt (${sh.id})`;
    ids.add(sh.id);
    if (!int(sh.v_in) || !int(sh.v_out) || sh.v_out <= sh.v_in || sh.v_out > m.dauer_frames) return `Shot ${sh.id}: Zeiten ungültig`;
    if (!/^V\d+$/.test(String(sh.ebene))) return `Shot ${sh.id}: Ebene ungültig`;
  }
  return null;
}
async function importVersionPair(files) {
  try { await importVersionPairInner(files); }
  catch (e) { importError('Import abgebrochen: ' + (e && e.message || e) + ' – vorhandene Versionen sind unverändert.'); }
}
async function importVersionPairInner(files) {
  const jsons = files.filter((f) => /\.json$/i.test(f.name));
  const vids = files.filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name));
  if (!jsons.length) return importError('Die JSON-Datei zur Version fehlt. Bitte Video und gleichnamige .json zusammen auswählen.');
  if (!vids.length) return importError('Das Video zur Version fehlt. Bitte Video und gleichnamige .json zusammen auswählen.');
  let m = null;
  for (const f of jsons) {
    try { const d = JSON.parse(await f.text()); if (d.format === 'bt-version') { m = d; break; } } catch { /* nächste Datei */ }
  }
  if (!m) return importError('Keine Versionsdatei (bt-version) in der Auswahl.');
  if (m.contract !== 4) return importError(`Versionsdatei hat Vertrag ${m.contract}, die App erwartet 4 – bitte mit version_export.py neu erzeugen.`);
  const mf = manifestFehler(m);
  if (mf) return importError(`Versionsdatei ist fehlerhaft (${mf}).`);
  const pid = await projPid(S.proj);
  if (m.project_id !== pid) return importError(`Die Version gehört zu einem anderen Projekt („${m.projekt || m.project_id}“).`, { soll: pid, ist: m.project_id });
  const vf = vids.find((f) => f.name === m.export.datei) || (vids.length === 1 && jsons.length === 1 ? vids[0] : null);
  if (!vf) return importError(`Zur JSON gehört das Video „${m.export.datei}“ – es ist nicht in der Auswahl.`);
  modal(`<h2>Version ${esc(m.sequenz)}</h2><div class="progress"><div id="impBar" style="width:15%"></div></div><p id="impTxt" class="hint">Video wird auf das Gerät kopiert …</p>`);
  let buf;
  try { buf = await vf.arrayBuffer(); } catch (e) { return importError('Video ließ sich nicht lesen: ' + e.message); }
  $('impBar').style.width = '55%'; $('impTxt').textContent = 'Prüfsumme wird berechnet …';
  const sha = await sha1hex(buf);
  if (sha !== m.export.sha1) return importError('Video und JSON passen nicht zusammen (Prüfsumme). Vermutlich wurde das Video neu exportiert – JSON mit version_export.py neu erzeugen.', { video: sha.slice(0, 10), json: m.export.sha1.slice(0, 10) });
  const blob = new Blob([buf], { type: 'video/mp4' }); buf = null;
  $('impBar').style.width = '75%'; $('impTxt').textContent = 'Länge wird geprüft …';
  const dur = await new Promise((res) => {
    const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
    const done = (x) => { clearTimeout(to); URL.revokeObjectURL(v.src); res(x); };
    const to = setTimeout(() => done(0), 20000);
    v.onloadedmetadata = () => done(v.duration); v.onerror = () => done(0); v.src = URL.createObjectURL(blob);
  });
  const frames = Math.round(dur * m.fps);
  if (!dur || Math.abs(frames - m.dauer_frames) > 2) return importError(`Länge passt nicht (Video ${frames} Bilder, JSON ${m.dauer_frames}).`);
  const key = `${S.proj.id}/versionen/${m.export.export_id}.mp4`;
  DB.gross++;
  try { await DB.put('files', blob, key); } finally { DB.gross--; }
  $('impBar').style.width = '100%';
  let ver = S.ps.versions.find((v) => v.version_id === m.version_id);
  const info = { export_id: m.export.export_id, datei: vf.name, file: key, dur: m.dauer_frames / m.fps, imported: Date.now(), manifest: m };
  let neu = false;
  if (ver) {
    const oldFile = ver.file;
    Object.assign(ver, info);
    if (oldFile !== key) { await DB.del('files', oldFile).catch(() => {}); S.urls.delete('v:' + ver.version_id); }
  } else {
    ver = { version_id: m.version_id, ...info, ctx: newCtx({ ereignisse: [], activeTrack: 'VERSION' }) };
    const w = S.ps.wartend && S.ps.wartend[m.version_id];
    if (w) { ver.ctx = await ctxFromStand(w, ver); delete S.ps.wartend[m.version_id]; }
    S.ps.versions.push(ver); neu = true;
  }
  S.proj.bytes = (S.proj.bytes || 0) + blob.size; DB.put('projects', S.proj);
  log('version-import', { version: m.version_id, export: m.export.export_id, mb: +(blob.size / 1e6).toFixed(1), neu, shots: m.shots.length });
  closeModal();
  save(true);
  await enterContext('edit', ver.version_id);
  toast(neu ? `Version ${verLabel(ver)} importiert – ${m.shots.filter((s) => s.editierbar).length} Shots änderbar` : `Version ${verLabel(ver)} aktualisiert – Kommentare bleiben`, 4000);
}
function deleteVersion(v) {
  if (!v) return;
  const nk = v.ctx.selections.length + (v.ctx.ereignisse || []).length;
  modal(`<h2>Version entfernen?</h2><p>„${esc(v.manifest.sequenz)}“ wird von diesem Gerät entfernt${nk ? `, mit ${nk} Kommentaren/Änderungen. Vorher speichern, falls du sie noch brauchst` : ''}.</p>
    <div class="row"><button id="mNo">Abbrechen</button><button id="mYes" class="primary">Entfernen</button></div>`, (b) => {
    b.querySelector('#mNo').onclick = versionSheet;
    b.querySelector('#mYes').onclick = async () => {
      if (S.ver === v) await enterContext('shortlist');
      await DB.del('files', v.file).catch(() => {});
      for (const s of v.ctx.selections) for (const n of s.notes || []) await DB.del('notes', n.id).catch(() => {});
      S.urls.delete('v:' + v.version_id); delete S.hist[v.version_id];
      S.ps.versions = S.ps.versions.filter((x) => x !== v);
      log('version-entfernt', { version: v.version_id });
      save(true); renderTabs(); versionSheet();
    };
  });
}
document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
  if (!S.ps) return;
  log('knopf', { act: 'tab-' + b.dataset.tab });
  if (b.dataset.tab === 'shortlist') { if (S.ver) enterContext('shortlist'); return; }
  if (S.ver || !S.ps.versions.length) { versionSheet(); return; }
  const v = S.ps.versions.find((x) => x.version_id === S.ps.activeVersion) || S.ps.versions[S.ps.versions.length - 1];
  enterContext('edit', v.version_id);
}));

/* ---------- PC (Chrome/Edge): Projektordner direkt öffnen, Stand-Datei liegt im Ordner ----------
 * iPad-Safari kann nicht in Ordner schreiben → dort bleibt Speichern über „Teilen“. */
const canDir = 'showDirectoryPicker' in window;
if (canDir) $('btnDir').classList.remove('hidden');
$('btnDir').onclick = async () => {
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'bb-projekt', mode: 'readwrite' }); } catch { return; }
  const files = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.(json|mp4|jpg)$/i.test(name) && !/_Stand\.json$/i.test(name)) files.push(await h.getFile());
  log('ordner-import', { ordner: dir.name, dateien: files.length });
  importFiles(files, dir);
};
async function projectDir(ask, proj = S.proj) {
  if (!canDir || !proj) return null;
  const dir = await DB.get('state', '__dir__' + proj.id).catch(() => null);
  if (!dir) return null;
  let perm = await dir.queryPermission({ mode: 'readwrite' });
  if (perm === 'prompt' && ask) perm = await dir.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
  return perm === 'granted' ? dir : null;
}
async function writeStand(dir, data, proj = S.proj) {
  const fh = await dir.getFileHandle(saveName(proj), { create: true });
  const w = await fh.createWritable(); await w.write(JSON.stringify(data, null, 1)); await w.close();
}
// Beim Öffnen: Stand-Datei im Ordner anlegen (falls noch keine) bzw. Hinweis, dass es eine gibt
async function ensureStandFile() {
  const proj = S.proj, dir = await projectDir(true, proj); if (!dir) return;
  try {
    await dir.getFileHandle(saveName(proj));
    log('stand-datei-vorhanden', { datei: saveName(proj) });
    if (!hasContent(S.ps)) toast(`Im Ordner liegt ${saveName(proj)} – mit „Öffnen“ laden`, 4000);
  } catch {
    const data = await buildExport();
    await writeStand(dir, data, proj); log('stand-datei-angelegt', { datei: saveName(proj) });
    toast(`Speicherdatei ${saveName(proj)} im Projektordner angelegt`, 3500);
  }
}
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
// Chrome/Safari am iPad frieren eine verlassene Seite für „Zurück“ ein – auch mitten in einem Speichervorgang. Die eingefrorene
// Seite hält den Speicher dann fest und die nächste Seite hängt. Deshalb beim Verlassen offene Vorgänge abbrechen und den
// Speicher freigeben; kommt man per „Zurück“ wieder (eingefrorene Seite), neu laden.
window.addEventListener('pagehide', () => {
  for (const t of DB.offen) { try { t.abort(); } catch { /* schon fertig */ } }
  DB.offen.clear();
  try { DB.db && DB.db.close(); } catch { /* egal */ }
});
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
document.addEventListener('visibilitychange', () => {
  log(document.hidden ? 'app-hintergrund' : 'app-vordergrund', vstate());
  if (document.hidden) { stopPlay(); save(true); flushLog(); }
});

/* ---------- Briefkasten: Stand ohne Dialog an Blue Tacit senden ----------
 * Einrichtung per Link …/bt-sichtung/?bk=<Schlüssel> (je Kunde/Gerät ein Schlüssel, nur Schreiben). Der Schlüssel gehört zu
 * genau einem Projekt (project_id). „Senden“ schickt den kompletten Stand (bt-stand, ohne Diagnose-Log) an den Briefkasten;
 * Roberts PC holt ihn ab, legt ihn in OneDrive ab und transkribiert die Sprachnotizen (sichtung/briefkasten_abholen.py).
 * Ohne Netz bleibt der Stand in einer Warteschlange und wird beim nächsten Öffnen / sobald wieder Netz da ist gesendet. */
const BK_URL_DEFAULT = 'https://framepoint-briefkasten.bluetacit.workers.dev';
const bkOk = (u) => /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(u) || /^http:\/\/localhost:\d+$/.test(u);
const bkLink = async (pid) => (pid ? DB.get('state', '__bk__' + pid).catch(() => null) : null);
async function bkSetup(key, url) {
  url = url && bkOk(url) ? url : BK_URL_DEFAULT;
  let r;
  try { r = await (await fetch(`${url}/v1/link?k=${encodeURIComponent(key)}`)).json(); }
  catch { toast('Briefkasten nicht erreichbar – Link später noch einmal öffnen', 5000); log('bk-setup-netz'); return; }
  if (!r.ok) { toast('Dieser Senden-Link ist ungültig oder gesperrt', 5000); log('bk-setup-abgelehnt'); return; }
  await DB.put('state', { key, url, name: r.name, projekt: r.projekt, project_id: r.project_id, eingerichtet: Date.now() }, '__bk__' + r.project_id);
  log('bk-eingerichtet', { projekt: r.projekt, name: r.name });
  modal(`<h2>Senden eingerichtet</h2><p>Für <b>${esc(r.projekt)}</b> (${esc(r.name)}): Mit <b>„Senden“</b> geht dein Stand – Kommentare, Bewertungen und
    Sprachnotizen – direkt an Blue Tacit. Kein Speichern-Dialog nötig.</p>
    <p class="hint">Ohne Internet merkt sich die App den Stand und sendet ihn automatisch nach.</p>
    <div class="row"><span class="grow"></span><button class="primary" onclick="closeModal()">OK</button></div>`);
  if (S.proj && (await projPid(S.proj)) === r.project_id) bkRender();
}
async function bkRender() {
  const b = $('btnSend'); if (!S.proj) return;
  const pid = await projPid(S.proj), link = await bkLink(pid);
  b.classList.toggle('hidden', !link);
  $('btnSave').classList.toggle('primary', !link);
  if (!link) return;
  const q = await DB.get('state', '__bkq__' + pid).catch(() => null);
  const st = S.bkSent && S.bkSent.pid === pid ? S.bkSent : null;
  b.textContent = q ? 'Senden ⏳' : st && st.rev === S.rev ? 'Gesendet ✓' : 'Senden';
  b.title = q ? 'Wartet auf Internet – wird automatisch nachgesendet' : st ? `Zuletzt gesendet ${new Date(st.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : `An Blue Tacit senden (${link.name})`;
}
// Ein Stand-JSON an den Briefkasten. Rückgabe: 'ok' | 'netz' (→ Warteschlange) | Fehlertext (endgültig)
async function bkPost(link, body) {
  let r;
  try { r = await fetch(`${link.url}/v1/stand?k=${encodeURIComponent(link.key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); }
  catch { return 'netz'; }
  if (r.ok) return 'ok';
  const j = await r.json().catch(() => ({}));
  if (r.status >= 500 || r.status === 429) return 'netz';
  if (j.fehler === 'zu_gross') return 'Der Stand ist zu groß für den Briefkasten (viele lange Sprachnotizen). Bitte über „Speichern“ als Datei schicken.';
  if (j.fehler === 'veraltet') return 'Im Briefkasten liegt schon ein neuerer Stand (z. B. von einem anderen Gerät). Dieser ältere Stand wurde nicht gesendet.';
  return 'Senden abgelehnt: ' + (j.fehler || r.status);
}
async function bkSend(silent) {
  if (rec || recStarting) { if (!silent) toast('Erst die Sprachnotiz beenden'); return; }
  const proj = S.proj, pid = await projPid(proj), link = await bkLink(pid);
  if (!link) return;
  const rev = S.rev;
  if (!silent) { stopPlay(); $('btnSend').textContent = 'Senden …'; }
  const data = await buildExport(); // ohne Diagnose-Log (Astra F03)
  const body = JSON.stringify(data);
  const res = await bkPost(link, body);
  log('bk-senden', { ergebnis: res === 'ok' || res === 'netz' ? res : 'fehler', kb: Math.round(body.length / 1024), stand: data.stand_id });
  if (res === 'ok') {
    await DB.del('state', '__bkq__' + pid).catch(() => {});
    S.bkSent = { pid, rev, t: Date.now() };
    if (S.rev === rev) markSaved(true);
    if (!silent) toast('An Blue Tacit gesendet ✓', 2500);
  } else if (res === 'netz') {
    await DB.put('state', { body, t: Date.now(), rev }, '__bkq__' + pid);
    if (!silent) toast('Kein Internet – wird automatisch gesendet, sobald Netz da ist', 4000);
  } else if (!silent) {
    modal(`<h2>Nicht gesendet</h2><p>${esc(res)}</p><div class="row"><span class="grow"></span><button class="primary" onclick="closeModal()">OK</button></div>`);
  }
  if (S.proj === proj) await bkRender();
}
// Warteschlange: alle wartenden Stände (jedes Projekt) erneut senden
async function bkRetry() {
  const keys = (await DB.keys('state').catch(() => [])).filter((k) => typeof k === 'string' && k.startsWith('__bkq__'));
  for (const k of keys) {
    const pid = k.slice(7), q = await DB.get('state', k), link = await bkLink(pid);
    if (!q || !link) continue;
    const res = await bkPost(link, q.body);
    log('bk-nachsenden', { ergebnis: res === 'ok' || res === 'netz' ? res : 'fehler' });
    if (res !== 'netz') await DB.del('state', k);
    if (res === 'ok' && S.proj && (await projPid(S.proj)) === pid) S.bkSent = { pid, rev: q.rev, t: Date.now() };
    if (res !== 'ok' && res !== 'netz') toast('Ein wartender Stand wurde nicht angenommen – bitte „Senden“ erneut drücken', 5000);
  }
  if (S.proj) await bkRender();
}
window.addEventListener('online', bkRetry);
$('btnSend').onclick = () => bkSend(false);

/* ---------- Start ---------- */
(async () => {
  await DB.open();
  const oldLog = await DB.get('state', '__log__').catch(() => null);
  if (oldLog && oldLog.length) LOG.unshift(...oldLog.slice(-LOG_MAX + 50));
  log('app-start', { v: APP_VERSION, ua: navigator.userAgent.slice(0, 120), standalone: !!navigator.standalone || matchMedia('(display-mode: standalone)').matches });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  $('appVer').textContent = `Framepoint ${APP_VERSION}`;
  await showHome();
  { const hi = new Image(); hi.onload = () => $('hero').classList.add('has-img'); hi.src = 'hero.jpg'; }
  // ?import=<Pfad>/ lädt einen Projektordner vom selben Server (Testserver am PC, ohne Dateiauswahl)
  const q = new URLSearchParams(location.search);
  const imp = q.get('import');
  if (!imp && q.get('bk')) history.replaceState(null, '', location.pathname);
  bkRetry();
  if (imp && !/^[a-z]+:|^\/\//i.test(imp)) { // nur Ordner derselben Seite
    history.replaceState(null, '', location.pathname);
    const base = imp.endsWith('/') ? imp : imp + '/';
    const meta = await (await fetch(base + 'projekt.json')).json();
    const files = [new File([JSON.stringify(meta)], 'projekt.json')];
    const lazy = meta.clips.flatMap((c) => [c.file, c.sprite]).map((n) => ({
      name: n, arrayBuffer: async () => (await fetch(base + encodeURIComponent(n))).arrayBuffer(),
    }));
    await importFiles([...files, ...lazy]);
    // &version=<Pfad zur JSON> (mehrfach möglich): Version gleich mit importieren – für Tests ohne Dateiauswahl
    const vers = q.getAll('version');
    const mpid = await projectIdOf(meta);
    let p = null;
    for (const x of await DB.all('projects')) if ((await projPid(x)) === mpid) p = x;
    if (p && vers.length) {
      await openProject(p.id);
      for (const vj of vers) {
        if (/^[a-z]+:|^\/\//i.test(vj)) { log('version-url-abgelehnt', { vj }); continue; } // nur Pfade derselben Seite
        const jb = await (await fetch(vj)).blob();
        const m = JSON.parse(await jb.text());
        const dir = vj.slice(0, vj.lastIndexOf('/') + 1);
        const vb = await (await fetch(dir + encodeURIComponent(m.export.datei))).blob();
        await importVersionPair([new File([jb], vj.split('/').pop()), new File([vb], m.export.datei, { type: 'video/mp4' })]);
      }
    }
  }
  // ?bk=<Schlüssel>[&bkurl=…]: Senden an Blue Tacit einrichten – nach einem Import, damit der Hinweis sichtbar bleibt
  if (q.get('bk')) {
    const bkurl = q.get('bkurl');
    if (bkurl && bkOk(bkurl)) { try { localStorage.setItem('bk-url', bkurl); } catch { /* egal */ } }
    await bkSetup(q.get('bk'), bkurl || (() => { try { return localStorage.getItem('bk-url'); } catch { return null; } })());
  }
})();
