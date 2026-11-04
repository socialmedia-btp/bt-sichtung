/* BT Sichtung – Footage-Auswahl auf Tablet/PC.
 * Projekt = Ordner aus prepare.py (projekt.json + Proxies + Filmstreifen), einmal importiert → IndexedDB.
 * Zeiten: "real" = Sekunden Ortszeit (inkl. Spur-Versatz), "disp" = Timeline-Position mit gekürzten Lücken.
 * Auswahl-In/Out werden relativ zum Clip gespeichert (Sekunden im Original), damit Versatz-Änderungen sie nicht verschieben.
 */
'use strict';

const GAP = 2;                 // Lücken ohne Aufnahme werden auf max. 2 s gekürzt
const LONGPRESS_MS = 380;
const FINE_PX_PER_FRAME = 14;  // Lupe: so viele Pixel pro Bild
const TRACK_COLORS = ['#4c9aff', '#3dd68c', '#c084fc', '#ff8a4c', '#f472b6', '#22d3ee'];
const $ = (id) => document.getElementById(id);

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
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
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('abgebrochen'));
    });
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
  if (fps) s += ':' + pad((sec % 1) * fps + 1e-6);
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
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Zustand ---------- */
const S = {
  proj: null,          // Eintrag aus 'projects' (inkl. meta = projekt.json)
  clips: [],           // {id, track, name, file, s0, s (inkl. Versatz), dur, fps, ...}
  byId: new Map(),
  tracks: [],
  state: null,         // {selections, offsets, activeTrack, T, pps}
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

/* ---------- Projekte ---------- */
async function showHome() {
  stopPlay();
  $('editor').classList.add('hidden'); $('home').classList.remove('hidden');
  const projs = await DB.all('projects');
  const list = $('projList');
  list.innerHTML = projs.length ? '' : '<p class="hint">Noch kein Projekt. Importiere einen Projektordner.</p>';
  for (const p of projs.sort((a, b) => (b.opened || 0) - (a.opened || 0))) {
    const st = await DB.get('state', p.id);
    const n = st ? st.selections.length : 0;
    const el = document.createElement('div');
    el.className = 'proj';
    el.innerHTML = `<div class="info"><div class="name">${esc(p.meta.name)}</div>
      <div class="meta">${p.meta.clips.length} Clips · ${fmtGB(p.bytes || 0)} · ${n} Auswahl${p.missing ? ` · <span style="color:var(--red)">${p.missing} Dateien fehlen</span>` : ''}</div></div>
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

async function importFiles(fileList) {
  const files = [...fileList];
  const pj = files.find((f) => f.name.toLowerCase().endsWith('.json') && /projekt/i.test(f.name))
    || files.find((f) => f.name.toLowerCase().endsWith('.json'));
  if (!pj) { toast('projekt.json fehlt in der Auswahl'); return; }
  let meta;
  try { meta = JSON.parse(await pj.text()); } catch { toast('projekt.json ist nicht lesbar'); return; }
  if (meta.format === 'bt-sichtung-auswahl') { openSaveFileFromHome(pj); return; }
  if (meta.format !== 'bt-sichtung') { toast('Keine BT-Sichtung-Projektdatei'); return; }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  const id = meta.name + '|' + meta.created;
  const byName = new Map(files.map((f) => [f.name, f]));
  const needed = meta.clips.flatMap((c) => [c.file, c.sprite]);
  const have = new Set(await DB.keys('files'));
  modal(`<h2>Importiere ${esc(meta.name)}</h2><div class="progress"><div id="impBar"></div></div><p id="impTxt" class="hint"></p>`);
  let done = 0, bytes = 0;
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
  const missing = needed.filter((n) => !have.has(id + '/' + n)).length;
  const old = await DB.get('projects', id);
  await DB.put('projects', { id, meta, bytes: (old ? old.bytes : 0) + bytes, missing, opened: Date.now() });
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
      if (st) for (const s of st.selections) for (const n of s.notes || []) await DB.del('notes', n.id);
      await DB.del('state', p.id); await DB.del('projects', p.id);
      closeModal(); showHome();
    };
  });
}

/* ---------- Projekt öffnen ---------- */
async function openProject(id) {
  const p = await DB.get('projects', id);
  p.opened = Date.now(); DB.put('projects', p);
  S.proj = p;
  for (const u of S.urls.values()) URL.revokeObjectURL(u);
  S.urls.clear(); S.sprites.clear();
  S.tracks = p.meta.tracks.map((t, i) => ({ ...t, color: TRACK_COLORS[i % TRACK_COLORS.length] }));
  S.state = (await DB.get('state', id)) || { selections: [], offsets: {}, activeTrack: null, T: null, pps: 20 };
  S.clips = p.meta.clips.map((c) => ({ ...c, s0: isoToSec(c.start) }));
  S.byId = new Map(S.clips.map((c) => [c.id, c]));
  applyOffsets();
  S.activeTrack = S.state.activeTrack || S.tracks[0].id;
  S.pps = S.state.pps || 20;
  S.T = S.state.T ?? S.clips[0].s;
  S.curSel = null;

  // Blob-URLs + Filmstreifen
  for (const c of S.clips) {
    const v = await DB.get('files', id + '/' + c.file);
    c.missing = !v;
    if (v) S.urls.set(c.id, URL.createObjectURL(v));
    const sp = await DB.get('files', id + '/' + c.sprite);
    if (sp) { const img = new Image(); img.onload = requestDraw; img.src = URL.createObjectURL(sp); S.sprites.set(c.id, img); }
  }
  $('home').classList.add('hidden'); $('editor').classList.remove('hidden');
  $('projTitle').textContent = p.meta.name;
  resizeCanvas();
  showFrame(true);
  renderSide();
}

function applyOffsets() {
  for (const c of S.clips) c.s = c.s0 + (S.state.offsets[c.track] || 0);
  buildAxis();
}

let saveTimer = null;
function save() {
  if (!S.proj || !S.state) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    S.state.activeTrack = S.activeTrack; S.state.T = S.T; S.state.pps = S.pps;
    DB.put('state', S.state, S.proj.id);
  }, 400);
}

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
function nextClipStart(r) {
  let best = null;
  for (const c of S.clips) if (c.s > r + 1e-3 && (!best || c.s < best.s)) best = c;
  return best;
}
function prevClipStart(r) {
  let best = null;
  for (const c of S.clips) if (c.s < r - 0.25 && (!best || c.s > best.s)) best = c;
  return best;
}

/* ---------- Video ---------- */
const video = $('video');
let seekWanted = null;
function showFrame(exact) {
  const c = shownClip();
  $('noClip').classList.toggle('hidden', !!c);
  video.classList.toggle('hidden', !c);
  if (!c) { updateHud(null); return; }
  const local = clamp(S.T - c.s, 0, c.dur - 0.001);
  if (video.dataset.cid !== c.id) {
    if (c.missing) { $('noClip').textContent = 'Datei fehlt: ' + c.file; $('noClip').classList.remove('hidden'); video.classList.add('hidden'); updateHud(c); return; }
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
  const f = Math.floor(seekWanted * c.fps + 1e-6);
  video.currentTime = Math.min((f + 0.5) / c.fps, c.dur - 0.001);
  seekWanted = null;
}
video.addEventListener('seeked', () => { if (seekWanted != null && !S.playing) applySeek(); });

function updateHud(c) {
  const fps = c ? c.fps : 25;
  const tr = c && S.tracks.find((t) => t.id === c.track);
  $('hud').innerHTML = c ? `<span class="cam" style="color:${tr.color}">${esc(tr.label)}</span> · ${esc(c.name)}` : '';
  $('tc').innerHTML = `<b>${clock(S.T, fps)}</b>` + (c ? ` · Clip ${tcClip(S.T - c.s, fps)} / ${tcClip(c.dur, fps)} · ${fps} fps` : '');
}

function play() {
  const c = shownClip();
  if (!c) { const n = nextClipStart(S.T); if (!n) return; S.T = n.s; showFrame(true); }
  S.playing = true; $('btnPlay').textContent = '⏸';
  video.muted = S.muted;
  const p = video.play(); if (p) p.catch(() => {});
  clearInterval(S.playTimer); S.playTimer = setInterval(playTick, 33);
}
function stopPlay() {
  if (!S.playing) return;
  S.playing = false; $('btnPlay').textContent = '▶';
  clearInterval(S.playTimer); S.switching = false; video.pause(); save();
}
function playTick() {
  if (!S.playing) return;
  const c = S.byId.get(video.dataset.cid);
  if (c && !video.seeking && !S.switching) {
    S.T = c.s + video.currentTime;
    const want = shownClip(S.T + 0.001);
    const atEnd = video.ended || video.currentTime >= c.dur - 0.03;
    if (atEnd || (want && want.id !== c.id)) {
      let t = atEnd ? c.s + c.dur + 0.001 : S.T;
      if (!shownClip(t)) { const n = nextClipStart(t - 0.002); if (!n) { stopPlay(); requestDraw(); return; } t = n.s + 0.001; }
      S.T = t; S.switching = true; showFrame(true);
      video.addEventListener('seeked', () => { S.switching = false; if (S.playing) video.play().catch(() => {}); }, { once: true });
    }
    updateHud(shownClip());
  }
  requestDraw();
}

function stepFrames(n) {
  stopPlay();
  const c = shownClip(); const fps = c ? c.fps : 25;
  const local = c ? S.T - c.s : 0;
  const f = Math.round(local * fps) + n;
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
function snap(local, c) { return clamp(Math.round(local * c.fps) / c.fps, 0, c.dur); }
function markIn() {
  const c = clipAt(S.activeTrack, S.T) || shownClip();
  if (!c) { toast('Keine Aufnahme am Playhead'); return; }
  const t = snap(S.T - c.s, c);
  const cur = S.curSel && S.curSel.kind === 'range' && S.curSel.clipId === c.id && t < S.curSel.outT && S.curSel.open ? S.curSel : null;
  if (cur) { cur.inT = t; }
  else { S.curSel = { id: uid(), kind: 'range', clipId: c.id, track: c.track, inT: t, outT: snap(c.dur, c), open: true, stars: 0, text: '', notes: [], created: Date.now() }; sels().push(S.curSel); }
  S.activeTrack = c.track;
  changed();
}
function markOut() {
  const c = clipAt(S.activeTrack, S.T) || shownClip();
  if (!c) { toast('Keine Aufnahme am Playhead'); return; }
  const t = snap(S.T - c.s + 1 / c.fps, c); // Out schließt das aktuelle Bild ein
  const cur = S.curSel && S.curSel.kind === 'range' && S.curSel.clipId === c.id && t > S.curSel.inT ? S.curSel : null;
  if (cur) { cur.outT = t; cur.open = false; }
  else { S.curSel = { id: uid(), kind: 'range', clipId: c.id, track: c.track, inT: 0, outT: t, open: false, stars: 0, text: '', notes: [], created: Date.now() }; sels().push(S.curSel); }
  S.activeTrack = c.track;
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
  for (const n of s.notes) await DB.del('notes', n.id);
  S.state.selections = sels().filter((x) => x !== s);
  if (S.curSel === s) S.curSel = null;
  changed();
}
function changed() { save(); renderSide(); requestDraw(); markSaved(false); }
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
  if (s.kind === 'marker') return { dot: '#fff', l1: `⚑ Marker ${clock(s.t)}`, l2: s.text || '' };
  const c = S.byId.get(s.clipId); const tr = trackOf(s.track);
  return { dot: tr.color, l1: `${tr.label} · ${c.name}`, l2: `${clock(c.s + s.inT)} · ${durTxt(s.outT - s.inT)}${s.text ? ' · ' + s.text : ''}` };
}
function renderSide() {
  const list = $('selList');
  const all = [...sels()].sort((a, b) => selRange(a)[0] - selRange(b)[0]);
  $('selCount').textContent = `${all.filter((s) => s.kind === 'range').length} Clips · ${all.filter((s) => s.kind === 'marker').length} Marker`;
  list.innerHTML = '';
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
  const box = $('current'); const s = S.curSel;
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
  box.querySelector('#selText').onchange = () => renderSide();
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
    if (k.startsWith('dn')) { const n = s.notes[+k.slice(2)]; await DB.del('notes', n.id); s.notes = s.notes.filter((x) => x !== n); return changed(); }
  });
}
let selStop = null;
function playSelection(s) {
  jumpTo(s); play();
  const end = selRange(s)[1];
  clearInterval(selStop);
  selStop = setInterval(() => { if (!S.playing || S.T >= end) { clearInterval(selStop); stopPlay(); } }, 30);
}

/* ---------- Sprachnotizen ---------- */
let rec = null;
async function toggleRec() {
  if (rec) { rec.stop(); return; }
  let s = S.curSel && sels().includes(S.curSel) ? S.curSel : null;
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Kein Mikrofonzugriff – in den Einstellungen erlauben'); return; }
  stopPlay();
  if (!s) { s = addMarker(); toast('Keine Auswahl aktiv → Notiz als Marker gespeichert'); }
  const chunks = []; const t0 = Date.now();
  rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/mp4' });
    const n = { id: uid(), mime: blob.type, dur: (Date.now() - t0) / 1000, created: Date.now() };
    await DB.put('notes', blob, n.id);
    s.notes.push(n); rec = null;
    $('btnRec').classList.remove('on');
    changed();
  };
  rec.start();
  $('btnRec').classList.add('on');
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
  const lh = Math.max(34, Math.min(70, (h - RULER - 6) / S.tracks.length));
  return { lh, y: (i) => RULER + 4 + i * lh };
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
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#111214'; ctx.fillRect(0, 0, w, h);
  const dNow = viewD();
  const cx = HEAD + (w - HEAD) / 2;
  const dL = dNow - (cx - HEAD) / S.pps, dR = dNow + (w - cx) / S.pps;

  // Lanes
  S.tracks.forEach((t, i) => {
    ctx.fillStyle = t.id === S.activeTrack ? '#1d2127' : '#16181b';
    ctx.fillRect(HEAD, y(i), w - HEAD, lh - 4);
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
    ctx.restore();
    ctx.strokeStyle = trackOf(c.track).color; ctx.lineWidth = 1.5;
    ctx.beginPath(); roundRect(x0 + 0.5, yy + 0.5, Math.max(2, x1 - x0 - 1), hh - 1, 5); ctx.stroke();
    if (x1 - x0 > 70) {
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
    ctx.fillStyle = cur ? '#f2c14e55' : '#f2c14e30'; ctx.fillRect(x0, yy, x1 - x0, hh);
    ctx.fillStyle = '#f2c14e'; ctx.fillRect(x0, yy + hh - 5, x1 - x0, 5);
    ctx.fillRect(x0 - (cur ? 3 : 1.5), yy, cur ? 6 : 3, hh);
    ctx.fillRect(x1 - (cur ? 3 : 1.5), yy, cur ? 6 : 3, hh);
    if (s.stars || s.notes.length) {
      ctx.fillStyle = '#1a1400'; ctx.font = '700 11px sans-serif';
      ctx.fillText('★'.repeat(s.stars) + (s.notes.length ? ' 🎙' : ''), x0 + 6, yy + hh - 9);
    }
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
  ctx.fillStyle = '#1a1c1f'; ctx.fillRect(0, 0, w, RULER);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const st = steps.find((s) => s * S.pps >= 90) || 3600;
  ctx.fillStyle = '#8b9098'; ctx.strokeStyle = '#3a3f46'; ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
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
    ctx.fillStyle = t.id === S.activeTrack ? '#23262a' : '#1a1c1f'; ctx.fillRect(0, y(i), HEAD - 4, lh - 4);
    ctx.fillStyle = t.color; ctx.fillRect(0, y(i), 4, lh - 4);
    ctx.fillStyle = t.id === S.activeTrack ? '#fff' : '#b8bcc2'; ctx.font = '600 12px -apple-system, Segoe UI, sans-serif';
    wrapText(t.label, 10, y(i) + 16, HEAD - 16, 14);
    const off = S.state.offsets[t.id] || 0;
    if (off) { ctx.fillStyle = '#f2c14e'; ctx.font = '10px sans-serif'; ctx.fillText((off > 0 ? '+' : '') + off.toFixed(1) + ' s', 10, y(i) + lh - 10); }
  });
  ctx.fillStyle = '#1a1c1f'; ctx.fillRect(0, 0, HEAD - 4, RULER);
  ctx.fillStyle = '#8b9098'; ctx.font = '10px sans-serif'; ctx.fillText('Spuren', 10, 16);

  // Playhead
  const px = cx + (r2d(S.T) - dNow) * S.pps;
  ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  ctx.fillStyle = '#e5484d'; ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.fill();
}
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
  const { lh, y: ly } = laneGeom();
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
    const [a, b] = [...ptrs.values()];
    g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), pps0: S.pps };
    return;
  }
  const p = ptrs.get(e.pointerId);
  const h = hit(p.x, p.y);
  g = { ...h, x0: p.x, y0: p.y, lastX: p.x, moved: false, t0: performance.now(), fine: false, dT: r2d(S.T) };
  stopPlay();
  if (h.type === 'handle') {
    viewLock = r2d(S.T);
    S.curSel = h.s; renderSide(); requestDraw();
    g.lp = setTimeout(() => startFine(), LONGPRESS_MS);
    const c = S.byId.get(h.s.clipId);
    g.base = h.which === 'in' ? h.s.inT : h.s.outT;
    g.clip = c;
  }
});
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
  if (g.type === 'lane' || g.type === 'sel' || g.type === 'empty' || g.type === 'head') {
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
  $('loupe').classList.add('hidden');
  viewLock = null;
  if (!g.moved && !g.fine) {
    if (g.type === 'head' && g.track) offsetDialog(g.track);
    else if (g.type === 'sel' || g.type === 'handle') { S.curSel = g.s; S.activeTrack = g.track.id; }
    else if (g.type === 'lane') {
      S.activeTrack = g.track.id;
      // Tippen auf einen Clip: Playhead dorthin
      const r = rOfX(g.x0); const c = clipAt(g.track.id, r);
      if (c) S.T = r;
    }
    showFrame(true); renderSide();
  } else if (g.type === 'handle') { changed(); }
  else save();
  g = null; requestDraw();
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
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
        applyOffsets(); showFrame(true); requestDraw(); save(); show();
      });
      b.querySelector('#mOk').onclick = closeModal;
    });
  };
  S.activeTrack = track.id; show();
}

/* ---------- Export / Laden ---------- */
const blobToB64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });
async function buildExport() {
  const out = {
    format: 'bt-sichtung-auswahl', version: 1,
    project: S.proj.meta.name, projectCreated: S.proj.meta.created,
    exported: new Date().toISOString(), device: navigator.userAgent,
    offsets: S.state.offsets, tracks: S.proj.meta.tracks, selections: [],
  };
  for (const s of [...sels()].sort((a, b) => selRange(a)[0] - selRange(b)[0])) {
    const notes = [];
    for (const n of s.notes) {
      const b = await DB.get('notes', n.id);
      if (b) notes.push({ id: n.id, mime: n.mime, dur: n.dur, created: new Date(n.created).toISOString(), data: await blobToB64(b) });
    }
    const base = { id: s.id, kind: s.kind, stars: s.stars, text: s.text, created: new Date(s.created).toISOString(), notes };
    if (s.kind === 'marker') { out.selections.push({ ...base, clock: clock(s.t), t: s.t }); continue; }
    const c = S.byId.get(s.clipId);
    out.selections.push({
      ...base, track: s.track, clip: c.id, name: c.name, original: c.original, fps: c.fps,
      in: +s.inT.toFixed(4), out: +s.outT.toFixed(4),
      inFrame: Math.round(s.inT * c.fps), outFrame: Math.round(s.outT * c.fps),
      clockIn: clock(c.s + s.inT, c.fps), clockOut: clock(c.s + s.outT, c.fps),
    });
  }
  return out;
}
/* Speichern = Datei mit dem ganzen Arbeitsstand (Auswahl, Marker, Notizen, Versatz, Position).
 * Öffnen lädt sie wieder – auf jedem Gerät, auf dem das Projekt importiert ist, auch ohne Internet. */
function saveName() {
  const d = new Date();
  return `${S.proj.meta.name.replace(/[^\w-]+/g, '_')}_Stand_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}
function markSaved(saved) {
  S.dirty = !saved;
  $('btnSave').textContent = saved ? 'Speichern' : 'Speichern •';
}
async function saveFile() {
  stopPlay();
  const data = await buildExport();
  data.view = { T: S.T, activeTrack: S.activeTrack, pps: S.pps };
  const name = saveName();
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
  const nR = data.selections.filter((s) => s.kind === 'range').length;
  const nN = data.selections.reduce((a, s) => a + s.notes.length, 0);
  const summary = `${nR} Clips, ${data.selections.length - nR} Marker, ${nN} Sprachnotizen`;
  const download = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    markSaved(true);
  };
  const touch = matchMedia('(pointer: coarse)').matches;
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  if (!touch || !canShare) { download(); toast(`Gespeichert: ${name} (${summary}) – im Download-Ordner`, 4000); return; }
  // iPad: Teilen braucht einen frischen Fingertipp → kurzer Dialog
  modal(`<h2>Speichern</h2><p>${summary}.</p>
    <p class="hint">„Teilen“ → „In Dateien sichern“ → z. B. in den OneDrive-Projektordner. Mit „Öffnen“ machst du später genau hier weiter – auch auf einem anderen Gerät.</p>
    <div class="row"><button id="mClose">Abbrechen</button><button id="mDl">Herunterladen</button><button id="mShare" class="primary">Teilen</button></div>`, (b) => {
    b.querySelector('#mClose').onclick = closeModal;
    b.querySelector('#mDl').onclick = () => { download(); closeModal(); };
    b.querySelector('#mShare').onclick = () => navigator.share({ files: [file], title: name })
      .then(() => { markSaved(true); closeModal(); toast('Gespeichert'); }).catch(() => {});
  });
}
async function readSaveFile(f) {
  let d; try { d = JSON.parse(await f.text()); } catch { toast('Datei nicht lesbar'); return null; }
  if (d.format !== 'bt-sichtung-auswahl') { toast('Keine Speicherdatei der Sichtungs-App'); return null; }
  return d;
}
async function openSaveFile(f) {
  const d = await readSaveFile(f); if (!d) return;
  if (d.project !== S.proj.meta.name) { toast(`Die Datei gehört zum Projekt „${d.project}“`); return; }
  const apply = () => loadSelection(d);
  if (!sels().length || !S.dirty) return apply();
  modal(`<h2>Stand öffnen?</h2><p>Deine aktuelle, nicht gespeicherte Auswahl wird durch den Stand aus der Datei ersetzt.</p>
    <div class="row"><button id="mNo">Abbrechen</button><button id="mYes" class="primary">Öffnen</button></div>`, (b) => {
    b.querySelector('#mNo').onclick = closeModal;
    b.querySelector('#mYes').onclick = () => { closeModal(); apply(); };
  });
}
async function openSaveFileFromHome(f) {
  const d = await readSaveFile(f); if (!d) return;
  const p = (await DB.all('projects')).find((x) => x.meta.name === d.project);
  if (!p) { toast(`Projekt „${d.project}“ ist auf diesem Gerät noch nicht importiert – erst den Projektordner importieren`, 5000); return; }
  await openProject(p.id);
  await loadSelection(d);
}
async function loadSelection(d) {
  for (const s of sels()) for (const n of s.notes) await DB.del('notes', n.id);
  const list = []; let skipped = 0;
  for (const x of d.selections) {
    const notes = [];
    for (const n of x.notes || []) {
      const bin = Uint8Array.from(atob(n.data), (ch) => ch.charCodeAt(0));
      await DB.put('notes', new Blob([bin], { type: n.mime }), n.id);
      notes.push({ id: n.id, mime: n.mime, dur: n.dur, created: Date.parse(n.created) });
    }
    const base = { id: x.id, kind: x.kind, stars: x.stars || 0, text: x.text || '', notes, created: Date.parse(x.created) };
    if (x.kind === 'marker') list.push({ ...base, t: x.t });
    else if (S.byId.has(x.clip)) list.push({ ...base, clipId: x.clip, track: x.track, inT: x.in, outT: x.out, open: false });
    else skipped++;
  }
  S.state.selections = list; S.state.offsets = d.offsets || {};
  applyOffsets(); S.curSel = null;
  if (d.view) { S.T = d.view.T ?? S.T; S.activeTrack = d.view.activeTrack || S.activeTrack; S.pps = d.view.pps || S.pps; }
  closeModal(); changed(); showFrame(true); markSaved(true);
  toast(`Stand geöffnet: ${list.length} Einträge` + (skipped ? ` (${skipped} Clips fehlen im Projekt)` : ''), 3500);
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
    <li>Am PC: Leertaste = Play, ←/→ = ±1 Bild, Shift+←/→ = ±1 s, M = Marker.</li>
    <li>Alles wird automatisch auf diesem Gerät gespeichert. <b>Speichern</b> erstellt eine Datei mit deinem Stand; mit <b>Öffnen</b> machst du damit weiter – auch auf einem anderen Gerät, ohne Internet. Die Datei bekommt auch Claude.</li>
  </ul><div class="row"><button class="primary" onclick="closeModal()">OK</button></div>`);
}

/* ---------- Bedienung ---------- */
const ACT = {
  play: () => (S.playing ? stopPlay() : play()),
  backF: () => stepFrames(-1), fwdF: () => stepFrames(1),
  back1s: () => jumpSec(-1), fwd1s: () => jumpSec(1),
  prevClip: () => { stopPlay(); const c = prevClipStart(S.T); if (c) { S.T = c.s; showFrame(true); requestDraw(); save(); } },
  nextClip: () => { stopPlay(); const c = nextClipStart(S.T); if (c) { S.T = c.s; showFrame(true); requestDraw(); save(); } },
  in: markIn, out: markOut, marker: addMarker, rec: toggleRec,
  mute: () => { S.muted = !S.muted; video.muted = S.muted; $('btnMute').textContent = S.muted ? '🔇' : '🔊'; },
};
document.querySelectorAll('.transport button[data-act]').forEach((b) => b.addEventListener('click', () => ACT[b.dataset.act]()));
document.addEventListener('keydown', (e) => {
  if ($('editor').classList.contains('hidden') || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); ACT.play(); }
  else if (k === 'arrowleft') e.shiftKey ? ACT.back1s() : ACT.backF();
  else if (k === 'arrowright') e.shiftKey ? ACT.fwd1s() : ACT.fwdF();
  else if (k === 's' && (e.ctrlKey || e.metaKey)) saveFile();
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
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPlay(); save(); } });

/* ---------- Start ---------- */
(async () => {
  await DB.open();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  await showHome();
  // ?import=<Pfad>/ lädt einen Projektordner vom selben Server (Testserver am PC, ohne Dateiauswahl)
  const imp = new URLSearchParams(location.search).get('import');
  if (imp) {
    history.replaceState(null, '', location.pathname);
    const base = imp.endsWith('/') ? imp : imp + '/';
    const meta = await (await fetch(base + 'projekt.json')).json();
    const files = [new File([JSON.stringify(meta)], 'projekt.json')];
    const lazy = meta.clips.flatMap((c) => [c.file, c.sprite]).map((n) => ({
      name: n, arrayBuffer: async () => (await fetch(base + encodeURIComponent(n))).arrayBuffer(),
    }));
    importFiles([...files, ...lazy]);
  }
})();
