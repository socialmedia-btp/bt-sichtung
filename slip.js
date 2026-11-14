/* Framepoint v4 Stufe 4 – „Inhalt verschieben“ (Slip) und „Clip tauschen“ im Edit-Tab + Vorschau geänderter Shots.
 * Länge und Position des Shots bleiben, nur der Ausschnitt wandert (Slip: im selben Clip, Tausch: aus einem anderen Clip,
 * gewählt im Tausch-Blatt aus Shortlist-Bereichen oder allen Clips). Übernehmen = genau EIN Ereignis
 * {typ:'slip'|'tausch', ziel:{clip, src_in, src_fps, bereich?, bereich_frames?}} (ein Rückgängig-Schritt); Zielzustand/Marker rechnet vertrag.js (BTV).
 * Vorschau: Version läuft mit Ton weiter, in geänderten Shots liegt das Proxy-Bild darüber (#pv). Der Proxy startet unsichtbar
 * PRE s vorher und wird über das Tempo nachgeführt (wie Sync-Test); ist er nicht synchron, bleibt das Versionsbild sichtbar.
 * Gemessen am iPad (07.11.2026, Proxies ohne Ton): Proxy hinkt ~0,8 Bild nach → feste Korrektur LEAD. */
'use strict';
const SLIP_PRE = 1.2;                 // s: Proxy vor dem Shot unsichtbar anlaufen lassen
const SLIP_LEAD = 0;                  // s: feste Korrektur – nicht nötig, die Vorschau misst mit echten Anzeigezeiten und lernt den Vorhalt
const pv = $('pv'), pvLast = $('pvLast'), pvStill = $('pvStill');

/* ---------- Proxy im Arbeitsspeicher ----------
 * Version und Proxy gleichzeitig aus IndexedDB zu lesen lässt den Proxy am iPad alle ~1 s stocken (gemessen 07.11.).
 * Proxy-Clips sind klein (2–5 MB) → vor dem Abspielen komplett in den Arbeitsspeicher holen (die letzten 6 bleiben). */
const MEM = new Map(); // Clip-ID → Blob-URL im Arbeitsspeicher
async function memUrl(c) {
  const k = S.proj.id + '|' + c.id;                              // je Projekt + Clip (gleiche Clip-IDs in anderen Projekten, F06)
  if (MEM.has(k)) { const u = MEM.get(k); MEM.delete(k); MEM.set(k, u); return u; }
  const b = await DB.get('files', S.proj.id + '/' + c.file);
  if (!b) return S.urls.get(c.id);
  const u = URL.createObjectURL(new Blob([await b.arrayBuffer()], { type: 'video/mp4' }));
  MEM.set(k, u);
  while (MEM.size > 6) { const [k, old] = MEM.entries().next().value; URL.revokeObjectURL(old); MEM.delete(k); }
  return u;
}
async function pvLoad(el, c) {
  const k = S.proj.id + '|' + c.id;
  if (el.dataset.key === k) return;
  el.dataset.key = k; el.dataset.cid = c.id; el.dataset.mem = '1'; el.src = await memUrl(c);
}
// Projektwechsel: Vorschau-Videos und Speicher-Cache freigeben (von openProject aufgerufen)
function pvReset() {
  for (const el of [pv, pvLast, pvStill]) { el.pause(); el.removeAttribute('src'); el.load(); delete el.dataset.key; delete el.dataset.cid; }
  for (const u of MEM.values()) URL.revokeObjectURL(u);
  MEM.clear();
}

/* ---------- Alles beenden (F07) ----------
 * Vor jedem Projekt-, Tab- und Versionswechsel: Slip-Modus, „Im Zusammenhang“, Vorschau und Zeitgeber beenden, solange der alte
 * Kontext noch gültig ist. Die Sitzungsnummer macht noch laufende asynchrone Fortsetzungen (Laden nach await) ungültig. */
let SITZUNG = 0;
function stopAlles() {
  SITZUNG++;
  clearInterval(ctxStop); clearTimeout(ctxStart); clearTimeout(slipSeekTimer);
  if (typeof VE !== 'undefined') { VE.nur = null; pvHide(); }
  if (SL) {
    SL = null; document.body.classList.remove('slip'); $('slipBar').classList.add('hidden');
    pvLast.classList.add('hidden'); $('pvBadge').classList.add('hidden');
  }
}

/* ---------- Zielzustand je Shot ---------- */
function shotEvents(id) { return (S.state.ereignisse || []).filter((e) => e.shot === id); }
function effZiel(sh) { return BTV.zielOf(sh, shotEvents(sh.id)); }          // null = unverändert
function footClip(id) { return id ? S.footClips.find((c) => c.id === id) || null : null; }
function footClipOf(sh) { return footClip(sh.clip); }
// Wirksamer Inhalt eines Shots: Clip (Footage), erstes Quellbild, Quell-fps – nach Tausch der neue Clip
function inhalt(sh) {
  const z = effZiel(sh);
  return z ? { c: footClip(z.clip), srcIn: z.src_in, f: z.src_fps, z, t: tempoInhalt(sh, z) } : { c: footClipOf(sh), srcIn: sh.src_in, f: sh.src_fps, z: null, t: tempoInhalt(sh, null) };
}
// Tempo des wirksamen Inhalts (gleiche Regel wie vertrag.js tempoOf): Umstellen bringt sein Tempo mit, sonst das des Platzes
function tempoInhalt(sh, z) { return z && z.von_shot ? (z.tempo || 1) : sh.ersatz ? (sh.tempo || 1) : 1; }
function effSrcIn(sh) { return inhalt(sh).srcIn; }
const fpsOk = (f) => { const r = f / S.ver.manifest.fps; return Math.abs(r - Math.round(r)) < 1e-6 && Math.round(r) >= 1; };
// Darf dieser Shot verschoben werden? null = ja, sonst Grund
function slipGrund(sh) {
  if (!sh.editierbar) return sh.grund || 'gesperrt';
  if (!S.footClips.length) return 'nur im Projekt mit Footage';
  const c = footClipOf(sh);
  if (!c) return 'Clip nicht im Footage-Projekt';
  if (c.missing || !S.urls.has(c.id)) return 'Proxy fehlt auf diesem Gerät';
  // nur ganzzahlige Verhältnisse (50p in 25p = 2, 25p in 25p = 1); 29,97 in 25 o. ä. nicht annähern (F11)
  if (!fpsOk(sh.src_fps)) return `Bildraten ${sh.src_fps}/${S.ver.manifest.fps} nicht unterstützt`;
  return null;
}
// Darf der Shot getauscht werden? (Proxy des eigenen Clips ist dafür nicht nötig)
function tauschGrund(sh) {
  if (!sh.editierbar) return sh.grund || 'gesperrt';
  if (!S.footClips.length) return 'nur im Projekt mit Footage';
  if (!fpsOk(sh.src_fps)) return `Bildraten ${sh.src_fps}/${S.ver.manifest.fps} nicht unterstützt`;
  return null;
}
// Kann Clip c für Shot sh eingesetzt werden (ab lo bis hi, Quellbilder von c)? null = ja, sonst Grund
function clipGrund(sh, c, lo = 0, hi = null) {
  if (c.missing || !S.urls.has(c.id)) return 'Proxy fehlt';
  if (!fpsOk(c.fps)) return `${c.fps} fps nicht unterstützt`;
  const n = Math.round((sh.src_out - sh.src_in) * c.fps / sh.src_fps);
  const top = hi ?? Math.floor(c.dur * c.fps + 1e-6);
  if (top - lo < n) return `zu kurz (${BTV.fmtS((top - lo) / c.fps)} s, Shot ${BTV.fmtS(n / c.fps)} s)`;
  return null;
}
function auftragOf(sh) {
  const z = effZiel(sh); if (!z) return null;
  return BTV.auftrag(S.ver.manifest, sh, z, shotEvents(sh.id).length);
}
const deltaTxt = (sh, srcIn) => { const d = (srcIn - sh.src_in) / sh.src_fps; return `${d >= 0 ? '+' : '−'}${BTV.fmtS(Math.abs(d))} s`; };

/* ---------- Slip-Modus ---------- */
let SL = null; // {sh, c, f, srcIn, step, n, lo, hi, bereich, base, tausch, pps, drag}
// opt (Tausch): {c, srcIn, bereich: {id, lo, hi}} – sonst Slip im wirksamen Inhalt (nach Tausch: im neuen Clip)
async function startSlip(opt) {
  const sg = shotNow(); if (!sg) return;
  const sh = sg.shot, grund = opt || effZiel(sh) ? tauschGrund(sh) : slipGrund(sh);   // Proxy prüft unten (wirksamer Clip)
  if (grund) { toast((opt ? 'Tauschen' : 'Verschieben') + ' nicht möglich: ' + grund, 3500); return; }
  if (rec || recStarting) { toast('Erst die Sprachnotiz beenden'); return; }
  if (CUT.countdown || CUT.rec) stopCutRec();
  const sitzung = SITZUNG;
  if (CUT.mode) toggleCutMode(false);
  stopPlay();
  const fps = S.ver.manifest.fps, ih = inhalt(sh);
  const c = opt ? opt.c : ih.c, f = opt ? c.fps : ih.f;
  if (!c || c.missing || !S.urls.has(c.id)) { toast('Proxy fehlt auf diesem Gerät', 3500); return; }
  const step = Math.max(1, Math.round(f / fps));                  // kleinster sichtbarer Schritt: 1 Sequenzbild
  const n = !opt && ih.z && Number.isInteger(ih.z.n_src) ? Math.round(ih.z.n_src * f / ih.z.src_fps)
    : Math.round((sh.src_out - sh.src_in) * f / sh.src_fps), clipFrames = Math.floor(c.dur * f + 1e-6);
  // Grenzen: Shortlist-Bereich (beim Tausch, bewusst erweiterbar) bzw. ganzer Clip
  const zb = !opt && ih.z && ih.z.bereich_frames ? { id: ih.z.bereich, lo: ih.z.bereich_frames[0], hi: ih.z.bereich_frames[1] } : null;
  const bereich = opt ? opt.bereich || null : zb;
  const lo = bereich ? Math.max(0, bereich.lo) : 0, hi = bereich ? Math.min(clipFrames, bereich.hi) : clipFrames;
  const srcIn = opt ? clamp(opt.srcIn, lo, Math.max(lo, hi - n)) : ih.srcIn;
  SL = { sh, c, f, srcIn, step, n, lo, hi, bereich, fps, tausch: c.id !== sh.clip };
  SL.base = c.id === sh.clip ? sh.src_in : srcIn;                  // Raster „1 Sequenzbild“ rund um diesen Punkt
  document.body.classList.add('slip');
  $('slipBar').classList.remove('hidden');
  await pvLoad(pv, c); await pvLoad(pvLast, c);
  if (sitzung !== SITZUNG || !SL) return;                          // inzwischen gewechselt
  pv.style.opacity = ''; pv.classList.remove('hidden'); pvLast.classList.remove('hidden'); $('pvBadge').classList.remove('hidden');
  log('slip-start', { shot: sh.id, src_in: SL.srcIn });
  if (sh.ersatz) toast(sh.ersatz.art === 'topaz' ? '✨ Topaz-Shot: nach der Änderung kommt das Original mit gleicher Zeitlupe rein, markiert „Topaz neu rechnen“' : 'Zeitlupe/Ausschnitt: wird nach der Änderung aus dem Original neu erzeugt', 4500);
  slipResize(); slipUpdate(true); resizeCanvas();
}
// auf das Raster „1 Sequenzbild“ rund um den ursprünglichen Start einrasten, innerhalb des Clips bzw. Bereichs
function slipSnap(v) {
  const { step, n, base: b } = SL, max = SL.hi - n;
  const lo = b - Math.floor((b - SL.lo) / step) * step, hi = b + Math.floor((max - b) / step) * step;
  return clamp(b + Math.round((v - b) / step) * step, lo, Math.max(lo, hi));
}
function slipSet(v, seek = true) { SL.srcIn = slipSnap(v); slipUpdate(seek); }
let slipSeekT = 0;
function slipUpdate(seek) {
  const { sh, srcIn, n, f, c } = SL, grenze = SL.bereich ? 'Bereich' : 'Clip';
  $('slipInfo').innerHTML = `<b>Shot ${+sh.nr}</b> · ${SL.tausch ? `${esc(shotName(sh))} → <b>${esc(c.name || c.id)}</b>` : `${esc(shotName(sh))} · Inhalt <b>${deltaTxt(sh, srcIn)}</b>`}`
    + ` · Quelle ${BTV.fmtS(srcIn / f)}–${BTV.fmtS((srcIn + n) / f)} s`
    + (srcIn <= SL.lo ? ` · <span class="lock">${grenze}anfang</span>` : srcIn >= SL.hi - n ? ` · <span class="lock">${grenze}ende</span>` : '');
  $('slipWhole').classList.toggle('hidden', !SL.bereich);
  slipDraw();
  if (seek) {
    // beim Ziehen höchstens ~16 Sprünge/s, der letzte Stand wird immer nachgeholt
    clearTimeout(slipSeekTimer);
    const wait = 60 - (performance.now() - slipSeekT);
    if (wait > 0) { slipSeekTimer = setTimeout(() => SL && slipUpdate(true), wait); return; }
    slipSeekT = performance.now();
    // Mitte des Quellbilds ansteuern, das Premiere im Sequenzbild zeigt (bei 50p in 25p das ERSTE des Bildpaars)
    pv.currentTime = (srcIn + 0.5) / f;
    pvLast.currentTime = (srcIn + n - SL.step + 0.5) / f;
  }
}
let slipSeekTimer = null;
function slipResize() {
  const cvS = $('slipCv'), r = cvS.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cvS.width = Math.round(r.width * dpr); cvS.height = Math.round(r.height * dpr);
  cvS.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  if (SL) { SL.pps = (r.width * 0.42) / (SL.n / SL.f); slipDraw(); }
}
function slipDraw() {
  if (!SL) return;
  const cvS = $('slipCv'), g = cvS.getContext('2d'), w = cvS.width / (window.devicePixelRatio || 1), h = cvS.height / (window.devicePixelRatio || 1);
  const { sh, c, srcIn, n, pps, f } = SL;
  const winW = n / f * pps, winL = (w - winW) / 2, t0 = srcIn / f;          // Rahmen fest in der Mitte, Streifen wandert
  const xOfT = (t) => winL + (t - t0) * pps;
  g.clearRect(0, 0, w, h); g.fillStyle = '#0b0b0d'; g.fillRect(0, 0, w, h);
  const img = S.sprites.get(c.id), th = h - 16, tw = th * 16 / 9;
  const cx0 = xOfT(0), cx1 = xOfT(c.dur);
  g.fillStyle = '#2a2e34'; g.fillRect(cx0, 8, cx1 - cx0, th);
  if (img && img.complete && img.naturalWidth) {
    for (let x = Math.max(cx0, -tw); x < Math.min(cx1, w); x += tw) {
      const t = (x + tw / 2 - cx0) / pps, idx = clamp(Math.floor(t / c.spriteStep), 0, c.spriteN - 1);
      g.drawImage(img, idx * 160, 0, 160, 90, x, 8, Math.min(tw, cx1 - x), th);
    }
  }
  // außerhalb des Shortlist-Bereichs abdunkeln (Tausch)
  if (SL.bereich) { g.fillStyle = 'rgba(11,11,13,0.55)'; g.fillRect(cx0, 8, xOfT(SL.lo / f) - cx0, th); g.fillRect(xOfT(SL.hi / f), 8, cx1 - xOfT(SL.hi / f), th); }
  g.fillStyle = 'rgba(11,11,13,0.62)'; g.fillRect(0, 0, winL, h); g.fillRect(winL + winW, 0, w - winL - winW, h);
  // ursprünglicher Inhalt als dünner Strich, damit man sieht, wohin man geschoben hat
  if (c.id === sh.clip) { const bx = xOfT(sh.src_in / f); g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(bx, 4, 2, h - 8); }
  g.strokeStyle = '#f2c14e'; g.lineWidth = 3; g.strokeRect(winL, 4, winW, h - 8);
  g.fillStyle = '#f2c14e'; g.font = '600 11px -apple-system, Segoe UI, sans-serif';
  g.fillText('Shot-Länge', winL + 6, h - 8);
}
function slipApply() {
  const { sh, srcIn, c, f } = SL, cur = inhalt(sh);
  const curB = cur.z && cur.z.bereich_frames ? cur.z.bereich_frames.join('-') : '', newB = SL.bereich ? SL.lo + '-' + SL.hi : '';
  if (cur.c && cur.c.id === c.id && srcIn === cur.srcIn && curB === newB) { slipClose(); return; }   // nichts geändert
  const z = { clip: c.id, src_in: srcIn, src_fps: f };
  if (SL.bereich) { z.bereich = SL.bereich.id; z.bereich_frames = [SL.lo, SL.hi]; }
  const vz = cur.z && cur.z.von_shot && cur.z.clip === c.id ? cur.z : null;   // v4.9y: umgezogenen Inhalt weiter verschieben
  if (vz) for (const k of ['von_shot', 'von_nr', 'tempo', 'n_src', 'ersatz_art']) if (vz[k] !== undefined) z[k] = vz[k];
  const err = BTV.checkZiel(sh, z, { [c.id]: { dur: c.dur } });
  if (err) { toast(err, 3500); return; }
  const typ = vz ? 'umstellen' : c.id === sh.clip ? 'slip' : 'tausch';
  S.state.ereignisse = S.state.ereignisse || [];
  S.state.ereignisse.push({ change_id: 'c-' + uid(), shot: sh.id, typ, ziel: z, t: Date.now() });
  log(typ, { shot: sh.id, clip: c.id, von: cur.srcIn, nach: srcIn, bereich: z.bereich || null });
  slipClose(); changed();
  toast(typ === 'tausch' ? `Shot ${+sh.nr}: getauscht gegen ${c.name || c.id}` : `Shot ${+sh.nr}: Inhalt verschoben – übernommen`, 2500);
}
function slipClose() {
  SL = null; document.body.classList.remove('slip'); $('slipBar').classList.add('hidden');
  pvHide(); pvLast.classList.add('hidden'); $('pvBadge').classList.add('hidden');
  renderSide(); resizeCanvas(); showFrame(true);
}
function resetShot(sh) {
  S.state.ereignisse = S.state.ereignisse || [];
  S.state.ereignisse.push({ change_id: 'c-' + uid(), shot: sh.id, typ: 'reset', t: Date.now() });
  log('slip-reset', { shot: sh.id }); changed(); toast(`Shot ${+sh.nr} zurückgesetzt`, 2000);
}

/* Gesten auf dem Streifen: ziehen = Inhalt verschieben (nach links ziehen = späterer Inhalt) */
$('slipCv').addEventListener('pointerdown', (e) => {
  if (!SL) return; try { $('slipCv').setPointerCapture(e.pointerId); } catch { /* egal */ }
  SL.drag = { x0: e.clientX, src0: SL.srcIn };
});
$('slipCv').addEventListener('pointermove', (e) => {
  if (!SL || !SL.drag) return;
  const dx = e.clientX - SL.drag.x0;
  slipSet(SL.drag.src0 - dx / SL.pps * SL.f);
});
const slipUp = () => { if (SL && SL.drag) { SL.drag = null; slipSeekT = 0; slipUpdate(true); } };
$('slipCv').addEventListener('pointerup', slipUp); $('slipCv').addEventListener('pointercancel', slipUp);
$('slipEarlier').onclick = () => SL && slipSet(SL.srcIn - SL.step);
$('slipLater').onclick = () => SL && slipSet(SL.srcIn + SL.step);
$('slipCancel').onclick = () => { if (SL) { log('slip-abbruch', { shot: SL.sh.id }); slipClose(); } };
$('slipOk').onclick = () => SL && slipApply();
$('slipPlay').onclick = () => SL && playContext(SL.sh, SL.srcIn, SL.c, SL.f);
// Shortlist-Grenze bewusst aufheben → ganzer Clip (Robert-Frage 3)
$('slipWhole').onclick = () => {
  if (!SL || !SL.bereich) return;
  SL.bereich = null; SL.lo = 0; SL.hi = Math.floor(SL.c.dur * SL.f + 1e-6);
  log('tausch-ganzer-clip', { shot: SL.sh.id }); slipUpdate(false);
};
window.addEventListener('resize', () => SL && slipResize());
document.addEventListener('keydown', (e) => {
  if (!SL || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key, f = { ArrowLeft: () => slipSet(SL.srcIn - SL.step), ArrowRight: () => slipSet(SL.srcIn + SL.step),
    Enter: () => slipApply(), Escape: () => $('slipCancel').onclick(), ' ': () => playContext(SL.sh, SL.srcIn, SL.c, SL.f) }[k];
  if (!f) return;                                                  // andere Tasten (Tab …) normal weiterreichen (F15)
  f(); e.preventDefault(); e.stopImmediatePropagation();
}, true);

/* ---------- Vorschau: Proxy-Bild über der Version in geänderten Shots ----------
 * Am iPad (Chrome) vermessen 07.11.: Jedes Video stockt nach play() oder einem Sprung ~0,3–0,5 s und läuft danach exakt in
 * Echtzeit; Tempowechsel lösen ebenfalls Stocken aus. Deshalb: Proxy ~2 s vor dem Shot starten (mit gelernter Vorhaltezeit),
 * nach dem Stocken den Versatz im ruhigen Lauf messen, bei Bedarf EINMAL noch vor dem Shot neu ansetzen. Im Shot keine
 * Eingriffe – sichtbar nur, wenn ≤ 1,5 Bild Versatz; sonst bleibt das Versionsbild. Die Vorhaltezeit gilt für alle Shots. */
const VE = { cur: null, gestartet: 0, ruhigAb: 0, win: [], off: null, versuche: 0, vorhalt: 0.4, aMeta: null };
function pvHide() { pv.classList.add('hidden'); pv.style.opacity = 0; if (!pv.paused) pv.pause(); pvStill.classList.add('hidden'); pvStill.style.opacity = 0; VE.cur = null; VE.gestartet = 0; $('pvBadge').classList.toggle('hidden', !SL); }
// Vorschau-Ziele {sh, c, srcIn, f}: c = Clip des neuen Inhalts (nach Tausch der neue Clip)
const zielBereit = (z) => z.c && !z.c.missing && S.urls.has(z.c.id);
function changedShots() {
  return (S.vsegs || []).map((x) => x.shot).filter((sh, i, a) => a.indexOf(sh) === i && effZiel(sh))
    .map((sh) => ({ sh, ...inhalt(sh) })).filter(zielBereit);
}
const veFps = () => S.ver.manifest.fps;
const veSrcAt = (z, t) => z.srcIn / z.f + (t - z.sh.v_in / veFps()) * (z.t || 1) + SLIP_LEAD;   // gewünschte Proxy-Zeit (Zeitlupe: langsamer)
function veShow(on, still) {
  pv.style.opacity = on ? 1 : 0;
  pvStill.style.opacity = !on && still && VE.stillBereit ? 1 : 0;
  $('pvBadge').classList.toggle('hidden', !on && !(still && VE.stillBereit) && !SL);
}
function veStart(t) {
  pv.playbackRate = VE.cur.t || 1;
  pv.currentTime = Math.max(0, veSrcAt(VE.cur, t + VE.vorhalt));   // um die Stockzeit vorausspringen
  pv.play().catch(() => {});
  VE.gestartet = performance.now(); VE.ruhigAb = VE.gestartet + 900; VE.win = []; VE.off = null;
  veListen();
}
async function veVorbereiten(target) {
  const sitzung = SITZUNG;
  VE.cur = target; VE.gestartet = 0; VE.versuche = 0; VE.win = []; VE.off = null; veShow(false);
  if (!pv.paused) pv.pause();
  pv.muted = true; pv.classList.remove('hidden');
  VE.laedt = true; await pvLoad(pv, target.c); VE.laedt = false;
  if (sitzung !== SITZUNG) { VE.cur = null; pv.pause(); return; }
  // Standbild = erstes Bild des neuen Inhalts (wird gezeigt, solange der Proxy noch nicht synchron läuft)
  VE.stillBereit = false;
  await pvLoad(pvStill, target.c);
  if (sitzung !== SITZUNG || VE.cur !== target) return;
  pvStill.classList.remove('hidden');
  pvStill.currentTime = (target.srcIn + 0.5) / target.f;
  pvStill.addEventListener('seeked', () => { if (VE.cur === target) VE.stillBereit = true; }, { once: true });
}
function onMain(now, m) {
  if (veIds) veIds[0] = video.requestVideoFrameCallback(onMain);
  VE.rvfcMain = performance.now(); mainStep(m);
}
function mainStep(m) {
  if (!S.ver || !S.playing || (SL && !SL.ctx)) { if (VE.cur) { pv.pause(); VE.cur = null; VE.gestartet = 0; if (!SL) pvHide(); } return; }
  VE.aMeta = { t: m.mediaTime, d: m.expectedDisplayTime };
  const t = m.mediaTime, fps = veFps();
  const ctxZ = (SL && SL.ctx) || VE.nur;                          // „Im Zusammenhang“: nur dieser Shot
  const list = ctxZ ? [ctxZ] : changedShots();
  const target = list.find((z) => t >= z.sh.v_in / fps - 2.6 && t < z.sh.v_out / fps) || null;
  const zk = (z) => (z ? z.sh.id + '@' + z.c.id + '@' + z.srcIn : null);
  if (zk(target) !== zk(VE.cur)) {
    if (VE.cur) pv.pause();
    if (target) veVorbereiten(target); else { VE.cur = null; veShow(false); }
    return;
  }
  if (!VE.cur || VE.laedt) return;
  const vIn = VE.cur.sh.v_in / fps, vOut = VE.cur.sh.v_out / fps;
  // Start 2,1 s vor dem Shot – aber nicht vor dem Clipanfang (neuer Inhalt nahe am Clipanfang → später starten)
  const startAb = Math.max(vIn - 2.1, vIn - VE.cur.srcIn / VE.cur.f - VE.vorhalt + 0.02);
  if (!VE.gestartet && t >= startAb) veStart(t);
  const inShot = t >= vIn - 0.5 / fps && t < vOut - 0.5 / fps;
  const frisch = performance.now() - (VE.bildAt || 0) < 150 && !pv.seeking && !pv.paused && pv.readyState >= 2;   // F08
  veShow(inShot && frisch && VE.off !== null && Math.abs(VE.off) <= 1.5, inShot);
}
function onPV(now, m) {
  if (veIds) veIds[1] = pv.requestVideoFrameCallback(onPV);
  VE.rvfcPV = performance.now(); pvStep(m);
}
function pvStep(m) {
  if (m.mediaTime !== VE.letzteMedia) { VE.letzteMedia = m.mediaTime; VE.bildAt = performance.now(); }
  if (!VE.cur || !VE.aMeta || video.paused || !VE.gestartet) { VE.off = null; return; }
  const fps = veFps();
  const aT = VE.aMeta.t + (m.expectedDisplayTime - VE.aMeta.d) / 1000 * video.playbackRate;
  const off = (m.mediaTime - veSrcAt(VE.cur, aT)) * fps;         // Versatz in Sequenzbildern (+ = Proxy voraus)
  if (performance.now() < VE.ruhigAb) { VE.off = null; return; } // Stocken nach dem Start abwarten
  VE.win = VE.win.concat(off).slice(-4);
  const mean = VE.win.reduce((x, y) => x + y, 0) / VE.win.length;
  VE.off = VE.win.length >= 2 ? mean : null;
  const bisShot = VE.cur.sh.v_in / fps - aT;
  if (VE.win.length === 4 && Math.abs(mean) > 1.0 && bisShot > 0.95 && VE.versuche < 2) {
    // nur VOR dem Shot: Vorhalt lernen (hinkt → mehr) und einmal neu ansetzen – das Stocken fällt dann in den Vorlauf
    if (Math.abs(mean) < 15) VE.vorhalt = clamp(VE.vorhalt - mean / fps, 0.1, 0.9);
    VE.versuche++; veStart(aT);
  }
}
// Bild-Rückrufe gehen verloren, wenn ein Video eine neue Quelle bekommt (WebKit) → bei jedem Start frisch anmelden
let veIds = null;
function veListen() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;   // ältere Browser: nur Ersatztakt
  if (veIds) { try { video.cancelVideoFrameCallback(veIds[0]); pv.cancelVideoFrameCallback(veIds[1]); } catch { /* egal */ } }
  veIds = [video.requestVideoFrameCallback(onMain), pv.requestVideoFrameCallback(onPV)];
}
veListen();
video.addEventListener('play', () => { stillZiel = ''; veListen(); });
// Ersatztakt: liefert der Browser keine Bild-Rückmeldungen (ausgeblendetes Fenster, Browser ohne requestVideoFrameCallback),
// läuft die Vorschau über currentTime weiter (ungenauer, aber besser als gar nicht)
// Stillstand (Pause, Spulen, ±1 Bild): in geänderten Szenen das passende Bild aus dem neuen Inhalt zeigen
let stillZiel = '';
async function stillstandBild() {
  if (SL || !S.ver || S.playing || !S.clips[0]) { if (!S.playing && !SL && stillZiel) { stillZiel = ''; pvStill.style.opacity = 0; $('pvBadge').classList.add('hidden'); } return; }
  const t = S.T - S.clips[0].s, sg = shotAt(t), sh = sg && sg.shot;
  const z = sh && effZiel(sh) ? { sh, ...inhalt(sh) } : null;
  if (!z || !zielBereit(z)) { if (stillZiel) { stillZiel = ''; pvStill.style.opacity = 0; $('pvBadge').classList.add('hidden'); } return; }
  const f = z.f, fps = veFps();
  const bild = z.srcIn + Math.round(Math.floor((t - sh.v_in / fps) * fps + 1e-4) * (f / fps) * (z.t || 1));   // Quellbild zum Sequenzbild
  const key = sh.id + '@' + z.c.id + '@' + z.srcIn + '#' + bild;
  if (key === stillZiel) return;
  stillZiel = key;
  const sitzung = SITZUNG;
  await pvLoad(pvStill, z.c);
  if (sitzung !== SITZUNG || stillZiel !== key || S.playing) return;
  pvStill.classList.remove('hidden');
  pvStill.currentTime = (bild + 0.5) / f;
  pvStill.addEventListener('seeked', () => { if (stillZiel === key && !S.playing) { pvStill.style.opacity = 1; $('pvBadge').classList.remove('hidden'); } }, { once: true });
}
setInterval(() => {
  stillstandBild();
  if (!S.ver || !S.playing) return;
  const jetzt = performance.now();
  if (!(VE.rvfcMain > jetzt - 250)) mainStep({ mediaTime: video.currentTime, expectedDisplayTime: jetzt });
  if (VE.cur && !pv.paused && !(VE.rvfcPV > jetzt - 250)) pvStep({ mediaTime: pv.currentTime, expectedDisplayTime: jetzt });
}, 40);
video.addEventListener('pause', () => { if (VE.cur) { pv.pause(); VE.gestartet = 0; veShow(false); } });
// Shot mit 2,5 s Vor- und 1 s Nachlauf spielen (im Slip-Modus mit dem Entwurf, sonst mit dem wirksamen Zielzustand)
let ctxStop = null, ctxStart = null;
async function playContext(sh, srcIn, fc, f) {
  if (!fc) { const ih = inhalt(sh); fc = ih.c; f = ih.f; }
  const fps = S.ver.manifest.fps, c = S.clips[0];
  if (SL) SL.ctx = { sh, c: fc, srcIn, f }; else VE.nur = { sh, c: fc, srcIn, f };
  pvLast.classList.add('hidden');
  // Proxy vorladen, damit er beim Start schon bereit ist
  await pvLoad(pv, fc);
  if (pv.readyState < 1) await new Promise((r) => { pv.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000); });
  S.T = c.s + Math.max(0, sh.v_in / fps - 2.5); showFrame(true);   // 2,5 s Vorlauf: Proxy schwingt vor dem Shot ein
  const sitzung = SITZUNG;
  clearTimeout(ctxStart); ctxStart = setTimeout(() => { if (sitzung === SITZUNG) play(); }, 120);
  clearInterval(ctxStop);
  let lief = false;
  ctxStop = setInterval(() => {
    if (S.playing) lief = true;
    if (!lief) return;                                   // Start abwarten
    if (!S.playing || video.currentTime >= sh.v_out / fps + 1) {
      clearInterval(ctxStop); stopPlay(); VE.nur = null;
      if (SL) { SL.ctx = null; pvLast.classList.remove('hidden'); pv.classList.remove('hidden'); pv.style.opacity = 1; slipSeekT = 0; slipUpdate(true); }
    }
  }, 50);
  log('im-zusammenhang', { shot: sh.id, src_in: srcIn });
}

/* ---------- Änderungen sichtbar machen ---------- */
// Szenenkarte: Knöpfe + Zustand (wird von renderShotCard aufgerufen)
function slipCardHtml(sh) {
  const a = auftragOf(sh), tg = tauschGrund(sh), ih = inhalt(sh);
  // Verschieben im wirksamen Inhalt (nach Tausch: im neuen Clip) braucht dessen Proxy
  const grund = a ? (zielBereit(ih) ? null : 'Proxy fehlt auf diesem Gerät') : slipGrund(sh);
  if (grund && tg && !a) return sh.editierbar && S.footClips.length ? `<div class="hint">Ändern: ${esc(grund)}</div>` : '';
  const was = a ? (a.typ === 'slip' ? 'Inhalt ' + deltaTxt(sh, a.nachher.src_in) : a.typ === 'umstellen' ? `Inhalt von Shot ${a.nachher.von_nr}`
    : 'getauscht → ' + (ih.c ? ih.c.name || ih.c.id : a.nachher.clip)) : '';
  return `${a ? `<div class="change">✎ ${esc(was)} <span class="hint">· Länge gleich · Ton bleibt</span></div>` : ''}
    <div class="card-row slip-btns">
      ${grund ? '' : '<button data-s="slip" class="slip-go">⇆ Inhalt verschieben</button>'}
      ${tg ? '' : '<button data-s="tausch">⟲ Clip tauschen</button><button data-s="platz">⇄ Platz tauschen</button><button data-s="schieben">↦ Verschieben</button>'}
      ${a ? '<button data-s="ctx">▶ Im Zusammenhang</button><button data-s="reset" class="ghost danger">↺ Zurücksetzen</button>' : ''}
    </div>`;
}
function slipCardBind(box, sh) {
  box.querySelectorAll('[data-s]').forEach((b) => b.onclick = () => {
    const k = b.dataset.s;
    if (k === 'slip') startSlip();
    else if (k === 'tausch') openTausch(sh);
    else if (k === 'platz' || k === 'schieben') umFenster(sh, k);
    else if (k === 'ctx') playContext(sh, effSrcIn(sh));
    else if (k === 'reset') resetShot(sh);
  });
}
// Liste „Änderungen“ (Abschlussübersicht) oberhalb der Kommentare
function changesHtml() {
  if (!S.ver) return '';
  const list = BTV.auftraege(S.ver.manifest, S.state.ereignisse || []).filter((a) => !a.fehler);
  if (!list.length) return '';
  return `<div class="list-sub">Änderungen (${list.length})</div>` + list.map((a) => `<div class="sel-item chg" data-shot="${esc(a.shot)}">
    <span class="dot" style="background:#f2c14e"></span><div class="t"><div class="l1">✎ Shot ${+a.nr} · ${a.typ === 'slip' ? 'Inhalt ' + (a.delta_s >= 0 ? '+' : '−') + BTV.fmtS(Math.abs(a.delta_s)) + ' s' : (a.typ === 'umstellen' ? `Inhalt von Shot ${+a.nachher.von_nr}` : 'getauscht → ' + esc((footClip(a.nachher.clip) || {}).name || a.nachher.clip))}</div>
    <div class="l2">${esc(a.marker)}</div></div></div>`).join('');
}

/* ---------- Umstellen innerhalb der Version (Robert 14.11., v4.9y) ----------
 * „⇄ Platz tauschen“: zwei Shots tauschen ihren Inhalt. „↦ Verschieben“: der Shot kommt an den Platz eines anderen, die Shots dazwischen
 * rücken je einen Platz weiter. Die Schnittpunkte bleiben (Plätze behalten ihre Länge, Musik/Ton unverändert): der eingesetzte Inhalt
 * beginnt an seinem bisherigen Startbild und endet passend zum Platz (mit seinem Tempo); reicht das Material bis zum Clipende nicht,
 * rückt der Start so weit nach vorn wie nötig. Je Platz ein Ereignis {typ:'umstellen', ziel:{clip, src_in, src_fps, von_shot, von_nr,
 * tempo, n_src, ersatz_art?, wiederverwenden?}}, alle zusammen ein Rückgängig-Schritt. */
function umPlaetze() {
  return S.ver.manifest.shots.filter((s) => s.rolle !== 'grafik').slice().sort((a, b) => a.v_in - b.v_in || a.ebene.localeCompare(b.ebene));
}
function umInhalt(sh) {   // wirksamer Inhalt eines Shots (nach früheren Änderungen)
  const z = effZiel(sh);
  if (!z) return { clip: sh.clip, srcIn: sh.src_in, f: sh.src_fps, tempo: tempoInhalt(sh, null), art: sh.ersatz ? sh.ersatz.art : null, unveraendert: true };
  return { clip: z.clip, srcIn: z.src_in, f: z.src_fps, tempo: tempoInhalt(sh, z), art: z.von_shot ? z.ersatz_art || null : sh.ersatz ? sh.ersatz.art : null,
    unveraendert: false, wiederverwenden: !!z.wiederverwenden, quelle: z.von_shot || null };
}
// Ziel für Platz `platz`, der den Inhalt K von Shot X bekommt → {z} oder {fehler}
function umZiel(platz, K, X) {
  const fps = S.ver.manifest.fps, lenS = (platz.v_out - platz.v_in) / fps;
  const c = footClip(K.clip);
  if (!c) return { fehler: `Shot ${X.nr}: Clip nicht im Footage-Projekt` };
  if (!fpsOk(K.f)) return { fehler: `Shot ${X.nr}: ${K.f} fps nicht unterstützt` };
  const n = Math.round(lenS * K.tempo * K.f), max = Math.floor(c.dur * K.f + 1e-6);
  if (n > max) return { fehler: `Shot ${X.nr} hat zu wenig Material für den Platz von Shot ${platz.nr} (${BTV.fmtS(max / K.f / K.tempo)} s statt ${BTV.fmtS(lenS)} s)` };
  const srcIn = Math.max(0, Math.min(K.srcIn, max - n));
  // von_shot = Shot, aus dessen Basis der Inhalt stammt (zweimal umgezogen → der ursprüngliche) – dessen Medium/Look nutzt Premiere
  const Q = (K.quelle && S.ver.manifest.shots.find((s) => s.id === K.quelle)) || X;
  const z = { clip: K.clip, src_in: srcIn, src_fps: K.f, von_shot: Q.id, von_nr: Q.nr, tempo: K.tempo, n_src: n };
  if (K.art) z.ersatz_art = K.art;
  // gleicher Inhalt wie in der Basis von Q, gleiche Länge → vorhandenes Medium (z. B. Topaz-Render) unverändert weiterverwenden
  if (K.clip === Q.clip && srcIn === Q.src_in && K.tempo === tempoInhalt(Q, null) && platz.v_out - platz.v_in === Q.v_out - Q.v_in) z.wiederverwenden = true;
  return { z };
}
// Zuweisungen [[platz, X]] (Platz bekommt den Inhalt von X, Inhalte VOR der Änderung) → Ereignisse oder Fehler
function umPlan(paare) {
  const inh = new Map(paare.map(([, X]) => [X.id, umInhalt(X)]));
  const ev = [];
  for (const [platz, X] of paare) {
    const g = tauschGrund(platz); if (g) return { fehler: `Shot ${platz.nr} ist gesperrt (${g})` };
    const K = inh.get(X.id);
    if (X.id === platz.id) continue;   // bleibt, wie er ist
    // Inhalt kehrt unverändert an seinen Basisplatz zurück → einfach zurücksetzen
    if (K.clip === platz.clip && K.srcIn === platz.src_in && K.tempo === tempoInhalt(platz, null)) { if (effZiel(platz)) ev.push({ shot: platz.id, typ: 'reset' }); continue; }
    const r = umZiel(platz, K, X); if (r.fehler) return r;
    ev.push({ shot: platz.id, typ: 'umstellen', ziel: r.z });
  }
  return { ev };
}
function umAnwenden(plan, text) {
  if (plan.fehler) { toast(plan.fehler, 4500); return false; }
  S.state.ereignisse = S.state.ereignisse || [];
  const t = Date.now();
  for (const e of plan.ev) S.state.ereignisse.push({ change_id: 'c-' + uid(), ...e, t });
  log('umstellen', { n: plan.ev.length, text });
  closeModal(); changed(); toast(text, 3000);
  return true;
}
function umFenster(sh, art) {
  const L = umPlaetze(), fps = S.ver.manifest.fps, i = L.findIndex((s) => s.id === sh.id);
  const lenTxt = (s) => durTxt((s.v_out - s.v_in) / fps);
  const zeile = (s) => {
    const g = s.id === sh.id ? 'dieser Shot' : tauschGrund(s);
    const diff = (s.v_out - s.v_in) - (sh.v_out - sh.v_in);
    const d = !g && art === 'platz' && diff ? ` · <span class="hint">${diff > 0 ? 'länger' : 'kürzer'}</span>` : '';
    return `<button class="um-zeile${g ? ' aus' : ''}" data-um="${esc(s.id)}" ${g ? 'disabled' : ''}>
      <b>Shot ${+s.nr}</b> · ${BTV.fmtTc(s.v_in, fps)} · ${esc(shotName(s))} · ${lenTxt(s)}${d}${g && s.id !== sh.id ? ` <span class="hint">· gesperrt</span>` : ''}${s.id === sh.id ? ' <span class="hint">· dieser</span>' : ''}</button>`;
  };
  modal(`<h2>${art === 'platz' ? '⇄ Shot ' + (+sh.nr) + ' tauschen mit …' : '↦ Shot ' + (+sh.nr) + ' verschieben an den Platz von …'}</h2>
    <p class="hint">${art === 'platz' ? 'Die beiden Shots tauschen ihren Inhalt.' : 'Die Shots dazwischen rücken je einen Platz weiter.'}
      Die Schnitte bleiben, wo sie sind (Musik und Ton unverändert): Jeder Inhalt wird auf die Länge seines neuen Platzes gekürzt bzw. aus dem Footage verlängert.</p>
    <div class="um-liste">${L.map(zeile).join('')}</div>
    <div class="row"><button id="umZu">Abbrechen</button></div>`, (b) => {
    b.querySelector('#umZu').onclick = closeModal;
    const aktiv = b.querySelector(`[data-um="${CSS.escape(sh.id)}"]`); if (aktiv) aktiv.scrollIntoView({ block: 'center' });
    b.querySelectorAll('[data-um]:not([disabled])').forEach((x) => { x.onclick = () => {
      const j = L.findIndex((s) => s.id === x.dataset.um), Y = L[j];
      if (art === 'platz') { umAnwenden(umPlan([[sh, Y], [Y, sh]]), `Shot ${+sh.nr} ⇄ Shot ${+Y.nr} getauscht`); return; }
      const paare = [];
      if (j < i) { paare.push([L[j], sh]); for (let k = j + 1; k <= i; k++) paare.push([L[k], L[k - 1]]); }
      else { for (let k = i; k < j; k++) paare.push([L[k], L[k + 1]]); paare.push([L[j], sh]); }
      umAnwenden(umPlan(paare), `Shot ${+sh.nr} an den Platz von Shot ${+Y.nr} verschoben (${paare.length} Plätze)`);
    }; });
  });
}

/* ---------- Clip tauschen: Blatt mit Shortlist-Bereichen zuerst, darunter alle Clips ----------
 * Bereiche nach ★ und Zeit; nur Bereiche/Clips, die mindestens die Shot-Länge haben, sind normal wählbar. Ein zu kurzer
 * Bereich startet bewusst mit dem ganzen Clip (ab seinem In). Nach der Wahl öffnet der Verschiebe-Streifen für den neuen Clip. */
const TS = { sh: null, q: '', track: '' };
function thumbHtml(c, t) {
  const img = S.sprites.get(c.id);
  if (!img || !img.src || !c.spriteN) return '<span class="ts-th"></span>';
  const idx = clamp(Math.floor(t / (c.spriteStep || 1)), 0, c.spriteN - 1);
  return `<span class="ts-th" style="background-image:url(${img.src});background-size:${c.spriteN * 96}px 54px;background-position:-${idx * 96}px 0"></span>`;
}
// v4.9t (Robert 13.11.): Tauschen wählt man in der Shortlist-Sequenz des Footage (die kennt man), die Liste bleibt als Ausweg
function openTausch(sh) {
  const g = tauschGrund(sh); if (g) { toast('Tauschen nicht möglich: ' + g, 3500); return; }
  if ((S.ps.shortlist.selections || []).some((s) => s.kind === 'range' && !s.open)) { tauschUeberShortlist(sh); return; }
  openTauschListe(sh);
}
function openTauschListe(sh) {
  const g = tauschGrund(sh); if (g) { toast('Tauschen nicht möglich: ' + g, 3500); return; }
  TS.sh = sh; TS.q = ''; TS.track = '';
  modal(`<h2>Shot ${+sh.nr} tauschen</h2>
    <p class="hint">Länge bleibt ${durTxt((sh.v_out - sh.v_in) / S.ver.manifest.fps)} · Ton bleibt · danach Inhalt noch verschiebbar</p>${ersatzHinweis(sh, true)}
    <div class="ts-filter"><input id="tsQ" type="search" placeholder="Clip suchen"><span id="tsTracks" class="ts-tracks"></span></div>
    <div id="tsList" class="ts-list"></div>
    <div class="row"><button id="tsClose">Abbrechen</button></div>`, (b) => {
    b.querySelector('#tsClose').onclick = closeModal;
    b.querySelector('#tsQ').oninput = (e) => { TS.q = e.target.value.trim().toLowerCase(); tauschRender(); };
    b.querySelector('#tsTracks').innerHTML = [{ id: '', label: 'Alle' }, ...S.footTracks].map((t) => `<button data-tr="${esc(t.id)}">${esc(t.label)}</button>`).join('');
    b.querySelector('#tsTracks').onclick = (e) => { const x = e.target.closest('[data-tr]'); if (x) { TS.track = x.dataset.tr; tauschRender(); } };
    b.querySelector('#tsList').onclick = (e) => { const x = e.target.closest('[data-pick]'); if (x && !x.classList.contains('off')) tauschPick(x.dataset.pick); };
    tauschRender();
  });
  log('tausch-blatt', { shot: sh.id });
}
function tauschRender() {
  const sh = TS.sh, box = $('tsList'); if (!box || !sh) return;
  document.querySelectorAll('#tsTracks [data-tr]').forEach((x) => x.classList.toggle('on', x.dataset.tr === TS.track));
  const passt = (c) => (!TS.track || c.track === TS.track) && (!TS.q || (c.name || c.id).toLowerCase().includes(TS.q));
  const used = new Set(S.ver.manifest.shots.map((s) => s.clip).filter(Boolean));
  const trk = (c) => (S.footTracks.find((t) => t.id === c.track) || {}).label || c.track;
  const ranges = (S.ps.shortlist.selections || []).filter((s) => s.kind === 'range' && !s.open && footClip(s.clipId) && passt(footClip(s.clipId)))
    .sort((a, b) => (b.stars || 0) - (a.stars || 0) || (footClip(a.clipId).s0 + a.inT) - (footClip(b.clipId).s0 + b.inT));
  const row = (key, c, t, l1, l2, grund, kurz) => `<div class="ts-item${grund ? ' off' : ''}" data-pick="${esc(key)}">${thumbHtml(c, t)}
    <div class="t"><div class="l1">${l1}</div><div class="l2">${l2}${grund ? ` · <span class="lock">${esc(grund)}</span>` : kurz ? ` · <span class="lock">${esc(kurz)}</span>` : ''}</div></div></div>`;
  let h = `<div class="list-sub">Shortlist (${ranges.length})</div>`;
  h += ranges.map((s) => {
    const c = footClip(s.clipId), lo = Math.round(s.inT * c.fps), hi = Math.round(s.outT * c.fps);
    const grund = clipGrund(sh, c), kurz = !grund && clipGrund(sh, c, lo, hi) ? 'kürzer als der Shot → ganzer Clip ab In' : '';
    return row('r:' + s.id, c, s.inT, `${'★'.repeat(s.stars || 0)} ${esc(c.name || c.id)}`,
      `${esc(trk(c))} · ${BTV.fmtS(s.inT)}–${BTV.fmtS(s.outT)} s (${durTxt(s.outT - s.inT)})${s.text ? ' · ' + esc(s.text) : ''}${s.notes && s.notes.length ? ' · 🎙' : ''}${used.has(c.id) ? ' · ● schon verwendet' : ''}`, grund, kurz);
  }).join('') || '<div class="hint" style="padding:8px 12px">Keine passenden Shortlist-Bereiche</div>';
  const clips = S.footClips.filter(passt).sort((a, b) => a.s0 - b.s0);
  h += `<div class="list-sub">Alle Clips (${clips.length})</div>`;
  h += clips.map((c) => row('c:' + c.id, c, c.dur / 2, esc(c.name || c.id), `${esc(trk(c))} · ${durTxt(c.dur)}${used.has(c.id) ? ' · ● schon verwendet' : ''}${c.id === sh.clip ? ' · eigener Clip' : ''}`, clipGrund(sh, c), '')).join('');
  box.innerHTML = h;
}
function tauschPick(key) {
  const sh = TS.sh; if (!sh) return;
  let opt;
  if (key.startsWith('r:')) {
    const s = S.ps.shortlist.selections.find((x) => x.id === key.slice(2)); if (!s) return;
    const c = footClip(s.clipId), lo = Math.round(s.inT * c.fps), hi = Math.round(s.outT * c.fps);
    opt = { c, srcIn: lo, bereich: clipGrund(sh, c, lo, hi) ? null : { id: s.id, lo, hi } };
  } else {
    const c = footClip(key.slice(2)); if (!c) return;
    opt = { c, srcIn: c.id === sh.clip ? effSrcIn(sh) : 0, bereich: null };
  }
  closeModal(); log('tausch-wahl', { shot: sh.id, clip: opt.c.id, bereich: opt.bereich ? opt.bereich.id : null });
  startSlip(opt);
}

/* ---------- Tauschen über die Shortlist-Sequenz (v4.9t) ----------
 * „⟲ Clip tauschen“ wechselt ins Footage mit offener Shortlist-Sequenz (an der zuletzt benutzten Stelle). Grün = Stellen, die schon im
 * Schnitt dieser Version stecken. Abspielkopf an den gewünschten Anfang ziehen → „✓ Ab hier einsetzen“ → zurück in die Version, der
 * Verschiebe-Streifen öffnet mit dem neuen Clip ab genau diesem Bild (Grenzen = Shortlist-Bereich, wenn lang genug). */
let TAUSCH = null;   // {sh, verId, intern}
async function tauschUeberShortlist(sh) {
  if (CUT.mode) toggleCutMode(false);
  TAUSCH = { sh, verId: S.ver.version_id, intern: true };
  log('tausch-shortlist', { shot: sh.id });
  await enterContext('shortlist');
  TAUSCH.intern = false;
  if (!reel) playShortlist(true);
  if (!reel) { tauschEnde(); toast('Keine fertigen Shortlist-Bereiche'); return; }
  $('tauschInfo').innerHTML = `⟲ <b>Shot ${+sh.nr}</b> tauschen · Abspielkopf an den gewünschten Anfang ziehen · <span class="ts-gruen">grün</span> = schon im Schnitt`;
  $('tauschBar').classList.remove('hidden'); document.body.classList.add('tausch-wahl');
  seqZeichnen();
}
function tauschEnde() {
  TAUSCH = null;
  const b = $('tauschBar'); if (b) b.classList.add('hidden');
  document.body.classList.remove('tausch-wahl');
  if (typeof seqZeichnen === 'function' && reel) seqZeichnen();
}
async function tauschZurueck(wahl) {
  const t = TAUSCH; if (!t) return;
  t.intern = true;
  stopPlay();
  await enterContext('edit', t.verId);
  tauschEnde();
  const sh = S.ver && S.ver.manifest.shots.find((x) => x.id === t.sh.id);
  if (!sh) { toast('Shot nicht mehr da'); return; }
  if (wahl === 'liste') { openTauschListe(sh); return; }
  if (!wahl) return;
  const c = footClip(wahl.clipId); if (!c) return;
  const grund = clipGrund(sh, c); if (grund) { toast(`${c.name || c.id}: ${grund}`, 3500); return; }
  const bereich = clipGrund(sh, c, wahl.lo, wahl.hi) ? null : { id: wahl.rangeId, lo: wahl.lo, hi: wahl.hi };
  log('tausch-wahl', { shot: sh.id, clip: c.id, bereich: bereich ? bereich.id : null, ab: wahl.frame, weg: 'shortlist' });
  startSlip({ c, srcIn: wahl.frame, bereich });
}
function tauschHier() {
  if (!TAUSCH) return;
  if (!reel) { toast('Shortlist ist zu – erst wieder öffnen oder „Liste“ nehmen'); return; }
  const s = reel.list[reel.i], c = s && S.byId.get(s.clipId); if (!c) return;
  const lo = Math.round(s.inT * c.fps), hi = Math.round(s.outT * c.fps);
  const frame = clamp(Math.round((S.T - c.s) * c.fps), lo, hi);
  tauschZurueck({ clipId: c.id, rangeId: s.id, lo, hi, frame });
}
// Schon im Schnitt verwendete Stellen je Footage-Clip (Sekunden im Clip), für eine Version – nach Tausch/Verschieben der neue Inhalt
function verwendeteStellen(ver) {
  const m = new Map(); if (!ver || !ver.manifest) return m;
  const ev = (ver.ctx && ver.ctx.ereignisse) || [];
  for (const sh of ver.manifest.shots || []) {
    if (!(sh.src_fps > 0) || sh.src_out == null) continue;
    const len = (sh.src_out - sh.src_in) / sh.src_fps;
    let z = null; try { z = BTV.zielOf(sh, ev.filter((e) => e.shot === sh.id)); } catch { z = null; }
    const clip = z ? z.clip : sh.clip, a = z ? z.src_in / z.src_fps : sh.src_in / sh.src_fps;
    if (!clip) continue;
    if (!m.has(clip)) m.set(clip, []);
    m.get(clip).push([a, a + len]);
  }
  return m;
}
function seqVerwendung() {
  const vs = S.ps && S.ps.versions || []; if (!vs.length) return null;
  const ver = (TAUSCH && vs.find((v) => v.version_id === TAUSCH.verId)) || vs.find((v) => v.version_id === S.ps.activeVersion) || vs[vs.length - 1];
  return verwendeteStellen(ver);
}
$('tauschHier').onclick = () => tauschHier();
$('tauschListe').onclick = () => tauschZurueck('liste');
$('tauschAbbr').onclick = () => tauschZurueck(null);
