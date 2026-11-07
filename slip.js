/* Framepoint v4 Stufe 4 – „Inhalt verschieben“ (Slip) im Edit-Tab + Vorschau geänderter Shots.
 * Länge und Position des Shots bleiben, nur der Ausschnitt aus dem Quellclip wandert. Übernehmen = genau EIN Ereignis
 * {typ:'slip', ziel:{clip, src_in, src_fps}} (ein Rückgängig-Schritt); Zielzustand/Marker rechnet vertrag.js (BTV).
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
function effSrcIn(sh) { const z = effZiel(sh); return z && z.clip === sh.clip ? z.src_in : sh.src_in; }
function footClipOf(sh) { return sh.clip ? S.footClips.find((c) => c.id === sh.clip) || null : null; }
// Darf dieser Shot verschoben werden? null = ja, sonst Grund
function slipGrund(sh) {
  if (!sh.editierbar) return sh.grund || 'gesperrt';
  if (!S.footClips.length) return 'nur im Projekt mit Footage';
  const c = footClipOf(sh);
  if (!c) return 'Clip nicht im Footage-Projekt';
  if (c.missing || !S.urls.has(c.id)) return 'Proxy fehlt auf diesem Gerät';
  // nur ganzzahlige Verhältnisse (50p in 25p = 2, 25p in 25p = 1); 29,97 in 25 o. ä. nicht annähern (F11)
  const r = sh.src_fps / S.ver.manifest.fps;
  if (!(Math.abs(r - Math.round(r)) < 1e-6 && Math.round(r) >= 1)) return `Bildraten ${sh.src_fps}/${S.ver.manifest.fps} nicht unterstützt`;
  return null;
}
function auftragOf(sh) {
  const z = effZiel(sh); if (!z) return null;
  return BTV.auftrag(S.ver.manifest, sh, z, shotEvents(sh.id).length);
}
const deltaTxt = (sh, srcIn) => { const d = (srcIn - sh.src_in) / sh.src_fps; return `${d >= 0 ? '+' : '−'}${BTV.fmtS(Math.abs(d))} s`; };

/* ---------- Slip-Modus ---------- */
let SL = null; // {sh, c, srcIn, step, n, max, pps, drag}
async function startSlip() {
  const sg = shotNow(); if (!sg) return;
  const sh = sg.shot, grund = slipGrund(sh);
  if (grund) { toast('Verschieben nicht möglich: ' + grund, 3500); return; }
  if (rec || recStarting) { toast('Erst die Sprachnotiz beenden'); return; }
  if (CUT.countdown || CUT.rec) stopCutRec();
  const sitzung = SITZUNG;
  if (CUT.mode) toggleCutMode(false);
  stopPlay();
  const c = footClipOf(sh), fps = S.ver.manifest.fps;
  const step = Math.max(1, Math.round(sh.src_fps / fps));         // kleinster sichtbarer Schritt: 1 Sequenzbild
  const n = sh.src_out - sh.src_in, clipFrames = Math.floor(c.dur * sh.src_fps + 1e-6);
  SL = { sh, c, srcIn: effSrcIn(sh), start: effSrcIn(sh), step, n, max: clipFrames - n, fps };
  document.body.classList.add('slip');
  $('slipBar').classList.remove('hidden');
  await pvLoad(pv, c); await pvLoad(pvLast, c);
  if (sitzung !== SITZUNG || !SL) return;                          // inzwischen gewechselt
  pv.style.opacity = ''; pv.classList.remove('hidden'); pvLast.classList.remove('hidden'); $('pvBadge').classList.remove('hidden');
  log('slip-start', { shot: sh.id, src_in: SL.srcIn });
  slipResize(); slipUpdate(true); resizeCanvas();
}
// auf das Raster „1 Sequenzbild“ rund um den ursprünglichen Start einrasten, innerhalb des Clips
function slipSnap(v) {
  const { sh, step, max } = SL, b = sh.src_in;
  const lo = b - Math.floor(b / step) * step, hi = b + Math.floor((max - b) / step) * step;
  return clamp(b + Math.round((v - b) / step) * step, lo, hi);
}
function slipSet(v, seek = true) { SL.srcIn = slipSnap(v); slipUpdate(seek); }
let slipSeekT = 0;
function slipUpdate(seek) {
  const { sh, srcIn, n } = SL, f = sh.src_fps;
  $('slipInfo').innerHTML = `<b>Shot ${+sh.nr}</b> · ${esc(shotName(sh))} · Inhalt <b>${deltaTxt(sh, srcIn)}</b> · Quelle ${BTV.fmtS(srcIn / f)}–${BTV.fmtS((srcIn + n) / f)} s`
    + (srcIn <= 0 ? ' · <span class="lock">Clipanfang</span>' : srcIn >= SL.max ? ' · <span class="lock">Clipende</span>' : '');
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
  if (SL) { SL.pps = (r.width * 0.42) / (SL.n / SL.sh.src_fps); slipDraw(); }
}
function slipDraw() {
  if (!SL) return;
  const cvS = $('slipCv'), g = cvS.getContext('2d'), w = cvS.width / (window.devicePixelRatio || 1), h = cvS.height / (window.devicePixelRatio || 1);
  const { sh, c, srcIn, n, pps } = SL, f = sh.src_fps;
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
  g.fillStyle = 'rgba(11,11,13,0.62)'; g.fillRect(0, 0, winL, h); g.fillRect(winL + winW, 0, w - winL - winW, h);
  // ursprünglicher Inhalt als dünner Strich, damit man sieht, wohin man geschoben hat
  const bx = xOfT(sh.src_in / f); g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(bx, 4, 2, h - 8);
  g.strokeStyle = '#f2c14e'; g.lineWidth = 3; g.strokeRect(winL, 4, winW, h - 8);
  g.fillStyle = '#f2c14e'; g.font = '600 11px -apple-system, Segoe UI, sans-serif';
  g.fillText('Shot-Länge', winL + 6, h - 8);
}
function slipApply() {
  const { sh, srcIn, c } = SL;
  if (srcIn === SL.start) { slipClose(); return; }
  const z = { clip: sh.clip, src_in: srcIn, src_fps: sh.src_fps };
  const err = BTV.checkZiel(sh, z, { [c.id]: { dur: c.dur } });
  if (err) { toast(err, 3500); return; }
  S.state.ereignisse = S.state.ereignisse || [];
  S.state.ereignisse.push({ change_id: 'c-' + uid(), shot: sh.id, typ: 'slip', ziel: z, t: Date.now() });
  log('slip', { shot: sh.id, von: SL.start, nach: srcIn });
  slipClose(); changed(); toast(`Shot ${+sh.nr}: Inhalt ${deltaTxt(sh, srcIn)} – übernommen`, 2500);
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
  slipSet(SL.drag.src0 - dx / SL.pps * SL.sh.src_fps);
});
const slipUp = () => { if (SL && SL.drag) { SL.drag = null; slipSeekT = 0; slipUpdate(true); } };
$('slipCv').addEventListener('pointerup', slipUp); $('slipCv').addEventListener('pointercancel', slipUp);
$('slipEarlier').onclick = () => SL && slipSet(SL.srcIn - SL.step);
$('slipLater').onclick = () => SL && slipSet(SL.srcIn + SL.step);
$('slipCancel').onclick = () => { if (SL) { log('slip-abbruch', { shot: SL.sh.id }); slipClose(); } };
$('slipOk').onclick = () => SL && slipApply();
$('slipPlay').onclick = () => SL && playContext(SL.sh, SL.srcIn);
window.addEventListener('resize', () => SL && slipResize());
document.addEventListener('keydown', (e) => {
  if (!SL || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key, f = { ArrowLeft: () => slipSet(SL.srcIn - SL.step), ArrowRight: () => slipSet(SL.srcIn + SL.step),
    Enter: () => slipApply(), Escape: () => $('slipCancel').onclick(), ' ': () => playContext(SL.sh, SL.srcIn) }[k];
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
function changedShots() { return (S.vsegs || []).map((x) => x.shot).filter((sh, i, a) => a.indexOf(sh) === i && effZiel(sh) && footClipOf(sh)); }
const veFps = () => S.ver.manifest.fps;
const veSrcAt = (z, t) => z.srcIn / z.sh.src_fps + (t - z.sh.v_in / veFps()) + SLIP_LEAD;   // gewünschte Proxy-Zeit
function veShow(on, still) {
  pv.style.opacity = on ? 1 : 0;
  pvStill.style.opacity = !on && still && VE.stillBereit ? 1 : 0;
  $('pvBadge').classList.toggle('hidden', !on && !(still && VE.stillBereit) && !SL);
}
function veStart(t) {
  pv.playbackRate = 1;
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
  VE.laedt = true; await pvLoad(pv, footClipOf(target.sh)); VE.laedt = false;
  if (sitzung !== SITZUNG) { VE.cur = null; pv.pause(); return; }
  // Standbild = erstes Bild des neuen Inhalts (wird gezeigt, solange der Proxy noch nicht synchron läuft)
  VE.stillBereit = false;
  await pvLoad(pvStill, footClipOf(target.sh));
  if (sitzung !== SITZUNG || VE.cur !== target) return;
  pvStill.classList.remove('hidden');
  pvStill.currentTime = (target.srcIn + 0.5) / target.sh.src_fps;
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
  const list = ctxZ ? [ctxZ] : changedShots().map((sh) => ({ sh, srcIn: effSrcIn(sh) }));
  const target = list.find((z) => t >= z.sh.v_in / fps - 2.6 && t < z.sh.v_out / fps) || null;
  const zk = (z) => (z ? z.sh.id + '@' + z.srcIn : null);
  if (zk(target) !== zk(VE.cur)) {
    if (VE.cur) pv.pause();
    if (target) veVorbereiten(target); else { VE.cur = null; veShow(false); }
    return;
  }
  if (!VE.cur || VE.laedt) return;
  const vIn = VE.cur.sh.v_in / fps, vOut = VE.cur.sh.v_out / fps;
  // Start 2,1 s vor dem Shot – aber nicht vor dem Clipanfang (neuer Inhalt nahe am Clipanfang → später starten)
  const startAb = Math.max(vIn - 2.1, vIn - VE.cur.srcIn / VE.cur.sh.src_fps - VE.vorhalt + 0.02);
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
  const z = sh && effZiel(sh) && footClipOf(sh) ? { sh, srcIn: effSrcIn(sh) } : null;
  if (!z) { if (stillZiel) { stillZiel = ''; pvStill.style.opacity = 0; $('pvBadge').classList.add('hidden'); } return; }
  const f = sh.src_fps, fps = veFps();
  const bild = z.srcIn + Math.floor((t - sh.v_in / fps) * fps + 1e-4) * Math.round(f / fps);   // Quellbild zum Sequenzbild
  const key = sh.id + '@' + z.srcIn + '#' + bild;
  if (key === stillZiel) return;
  stillZiel = key;
  const sitzung = SITZUNG;
  await pvLoad(pvStill, footClipOf(sh));
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
async function playContext(sh, srcIn) {
  const fps = S.ver.manifest.fps, c = S.clips[0], fc = footClipOf(sh);
  if (SL) SL.ctx = { sh, srcIn }; else VE.nur = { sh, srcIn };
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
  const grund = slipGrund(sh), a = auftragOf(sh);
  if (grund && !a) return sh.editierbar ? `<div class="hint">Inhalt verschieben: ${esc(grund)}</div>` : '';
  return `${a ? `<div class="change">✎ ${esc(a.typ === 'slip' ? 'Inhalt ' + deltaTxt(sh, a.nachher.src_in) : 'getauscht')} <span class="hint">· Länge gleich · Ton bleibt</span></div>` : ''}
    <div class="card-row slip-btns">
      ${grund ? '' : '<button data-s="slip" class="slip-go">⇆ Inhalt verschieben</button>'}
      ${a ? '<button data-s="ctx">▶ Im Zusammenhang</button><button data-s="reset" class="ghost danger">↺ Zurücksetzen</button>' : ''}
    </div>`;
}
function slipCardBind(box, sh) {
  box.querySelectorAll('[data-s]').forEach((b) => b.onclick = () => {
    const k = b.dataset.s;
    if (k === 'slip') startSlip();
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
    <span class="dot" style="background:#f2c14e"></span><div class="t"><div class="l1">✎ Shot ${+a.nr} · ${a.typ === 'slip' ? 'Inhalt ' + (a.delta_s >= 0 ? '+' : '−') + BTV.fmtS(Math.abs(a.delta_s)) + ' s' : 'getauscht'}</div>
    <div class="l2">${esc(a.marker)}</div></div></div>`).join('');
}
