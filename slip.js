/* Framepoint v4 Stufe 4 – „Inhalt verschieben“ (Slip) im Edit-Tab + Vorschau geänderter Shots.
 * Länge und Position des Shots bleiben, nur der Ausschnitt aus dem Quellclip wandert. Übernehmen = genau EIN Ereignis
 * {typ:'slip', ziel:{clip, src_in, src_fps}} (ein Rückgängig-Schritt); Zielzustand/Marker rechnet vertrag.js (BTV).
 * Vorschau: Version läuft mit Ton weiter, in geänderten Shots liegt das Proxy-Bild darüber (#pv). Der Proxy startet unsichtbar
 * PRE s vorher und wird über das Tempo nachgeführt (wie Sync-Test); ist er nicht synchron, bleibt das Versionsbild sichtbar.
 * Gemessen am iPad (07.11.2026, Proxies ohne Ton): Proxy hinkt ~0,8 Bild nach → feste Korrektur LEAD. */
'use strict';
const SLIP_PRE = 1.2;                 // s: Proxy vor dem Shot unsichtbar anlaufen lassen
const SLIP_LEAD = 0.8 / 25;           // s: Ausgleich des gemessenen Nachlaufs
const pv = $('pv'), pvLast = $('pvLast');

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
  return null;
}
function auftragOf(sh) {
  const z = effZiel(sh); if (!z) return null;
  return BTV.auftrag(S.ver.manifest, sh, z, shotEvents(sh.id).length);
}
const deltaTxt = (sh, srcIn) => { const d = (srcIn - sh.src_in) / sh.src_fps; return `${d >= 0 ? '+' : '−'}${BTV.fmtS(Math.abs(d))} s`; };

/* ---------- Slip-Modus ---------- */
let SL = null; // {sh, c, srcIn, step, n, max, pps, drag}
function startSlip() {
  const sg = shotNow(); if (!sg) return;
  const sh = sg.shot, grund = slipGrund(sh);
  if (grund) { toast('Verschieben nicht möglich: ' + grund, 3500); return; }
  if (rec || recStarting) { toast('Erst die Sprachnotiz beenden'); return; }
  stopPlay();
  const c = footClipOf(sh), fps = S.ver.manifest.fps;
  const step = Math.max(1, Math.round(sh.src_fps / fps));         // kleinster sichtbarer Schritt: 1 Sequenzbild
  const n = sh.src_out - sh.src_in, clipFrames = Math.floor(c.dur * sh.src_fps + 1e-6);
  SL = { sh, c, srcIn: effSrcIn(sh), start: effSrcIn(sh), step, n, max: clipFrames - n, fps };
  document.body.classList.add('slip');
  $('slipBar').classList.remove('hidden');
  pv.src = S.urls.get(c.id); pvLast.src = S.urls.get(c.id);
  pv.dataset.cid = c.id; pv.style.opacity = ''; pv.classList.remove('hidden'); pvLast.classList.remove('hidden'); $('pvBadge').classList.remove('hidden');
  log('slip-start', { shot: sh.id, src_in: SL.srcIn });
  slipResize(); slipUpdate(true);
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
  $('slipInfo').innerHTML = `<b>Shot ${sh.nr}</b> · ${esc(shotName(sh))} · Inhalt <b>${deltaTxt(sh, srcIn)}</b> · Quelle ${BTV.fmtS(srcIn / f)}–${BTV.fmtS((srcIn + n) / f)} s`
    + (srcIn <= 0 ? ' · <span class="lock">Clipanfang</span>' : srcIn >= SL.max ? ' · <span class="lock">Clipende</span>' : '');
  slipDraw();
  if (seek) {
    // beim Ziehen höchstens ~16 Sprünge/s, der letzte Stand wird immer nachgeholt
    clearTimeout(slipSeekTimer);
    const wait = 60 - (performance.now() - slipSeekT);
    if (wait > 0) { slipSeekTimer = setTimeout(() => SL && slipUpdate(true), wait); return; }
    slipSeekT = performance.now();
    // Bildmitte ansteuern, damit sicher das richtige Bild erscheint
    pv.currentTime = (srcIn + SL.step / 2) / f;
    pvLast.currentTime = (srcIn + n - SL.step / 2) / f;
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
  slipClose(); changed(); toast(`Shot ${sh.nr}: Inhalt ${deltaTxt(sh, srcIn)} – übernommen`, 2500);
}
function slipClose() {
  SL = null; document.body.classList.remove('slip'); $('slipBar').classList.add('hidden');
  pvHide(); pvLast.classList.add('hidden'); $('pvBadge').classList.add('hidden');
  renderSide(); requestDraw(); showFrame(true);
}
function resetShot(sh) {
  S.state.ereignisse = S.state.ereignisse || [];
  S.state.ereignisse.push({ change_id: 'c-' + uid(), shot: sh.id, typ: 'reset', t: Date.now() });
  log('slip-reset', { shot: sh.id }); changed(); toast(`Shot ${sh.nr} zurückgesetzt`, 2000);
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
  if (!SL) return;
  const k = e.key;
  if (k === 'ArrowLeft') slipSet(SL.srcIn - SL.step); else if (k === 'ArrowRight') slipSet(SL.srcIn + SL.step);
  else if (k === 'Enter') slipApply(); else if (k === 'Escape') $('slipCancel').onclick();
  else if (k === ' ') playContext(SL.sh, SL.srcIn);
  e.preventDefault(); e.stopImmediatePropagation();
}, true);

/* ---------- Vorschau: Proxy-Bild über der Version in geänderten Shots ---------- */
let PV = null; // {sh, srcIn, c, synced}
function pvHide() { pv.classList.add('hidden'); pv.style.opacity = 0; if (!pv.paused) pv.pause(); PV = null; $('pvBadge').classList.toggle('hidden', !SL); }
function changedShots() { return (S.vsegs || []).map((x) => x.shot).filter((sh, i, a) => a.indexOf(sh) === i && effZiel(sh) && footClipOf(sh)); }
// läuft bei jeder Wiedergabe im Edit-Tab mit (auch „Im Zusammenhang spielen“)
function pvTick() {
  if (!S.ver || !S.playing || SL && !SL.ctx) { if (PV && !SL) pvHide(); return; }
  const t = video.currentTime, fps = S.ver.manifest.fps;
  const ctxSh = SL && SL.ctx ? SL.ctx : null;
  const list = ctxSh ? [ctxSh] : changedShots().map((sh) => ({ sh, srcIn: effSrcIn(sh) }));
  const cur = list.find(({ sh }) => t >= sh.v_in / fps - SLIP_PRE && t < sh.v_out / fps);
  if (!cur) { if (PV) pvHide(); return; }
  const { sh, srcIn } = cur, c = footClipOf(sh), f = sh.src_fps;
  if (!PV || PV.sh !== sh) {
    PV = { sh, synced: false };
    if (pv.dataset.cid !== c.id) { pv.src = S.urls.get(c.id); pv.dataset.cid = c.id; }
    pv.muted = true; pv.classList.remove('hidden'); pv.style.opacity = 0; pv.playbackRate = 1;
  }
  const want = srcIn / f + (t - sh.v_in / fps) + SLIP_LEAD;      // gewünschte Proxy-Zeit
  if (want < 0) return;
  if (pv.paused) { pv.currentTime = want; pv.play().catch(() => {}); return; }
  const diff = pv.currentTime - want;
  if (Math.abs(diff) > 0.3 && !pv.seeking) { pv.currentTime = want + 0.1; PV.synced = false; return; }
  pv.playbackRate = clamp(1 - diff * 1.5, 0.9, 1.1);             // sanft nachführen statt springen
  const inShot = t >= sh.v_in / fps && t < sh.v_out / fps;
  PV.synced = Math.abs(diff) < 1.5 / fps;
  pv.style.opacity = inShot && PV.synced ? 1 : 0;                 // nicht synchron → Versionsbild bleibt sichtbar
  $('pvBadge').classList.toggle('hidden', !(inShot && PV.synced) && !SL);
}
setInterval(pvTick, 33); // fester Takt wie playTick (rAF ruht in Hintergrund-Tabs)
// Shot mit 1 s Vor- und Nachlauf spielen (im Slip-Modus mit dem Entwurf, sonst mit dem wirksamen Zielzustand)
let ctxStop = null;
function playContext(sh, srcIn) {
  const fps = S.ver.manifest.fps, c = S.clips[0];
  if (SL) SL.ctx = { sh, srcIn };
  pvLast.classList.add('hidden');
  S.T = c.s + Math.max(0, sh.v_in / fps - 1); showFrame(true);
  setTimeout(() => play(), 120);
  clearInterval(ctxStop);
  let lief = false;
  ctxStop = setInterval(() => {
    if (S.playing) lief = true;
    if (!lief) return;                                   // Start abwarten
    if (!S.playing || video.currentTime >= sh.v_out / fps + 1) {
      clearInterval(ctxStop); stopPlay();
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
    <span class="dot" style="background:#f2c14e"></span><div class="t"><div class="l1">✎ Shot ${a.nr} · ${a.typ === 'slip' ? 'Inhalt ' + (a.delta_s >= 0 ? '+' : '−') + BTV.fmtS(Math.abs(a.delta_s)) + ' s' : 'getauscht'}</div>
    <div class="l2">${esc(a.marker)}</div></div></div>`).join('');
}
