/* Framepoint – Shortlist-Sequenz (Robert 10.11.2026): eigene Ansicht wie ein neues Projekt.
 * Nur die fertigen IN/OUT-Bereiche lückenlos hintereinander auf einer eigenen Zeitleiste (Sequenzzeit 0 … Gesamtlänge),
 * mit eigenem Abspielkopf: ziehen = durchsliden, antippen = dorthin springen. Filter ★/★★/★★★ blendet schwächere Bereiche aus.
 * Steuerung (Abspielen, Weiterspringen zwischen Bereichen) liegt in app.js (reel, reelGo); hier nur Ansicht + Gesten.
 * Die Sequenz ist eine Sicht auf die Shortlist – Sterne/Notizen/Kommentare gehören weiter zu den Bereichen. */
'use strict';
const seqCv = $('seqCv'), seqCtx = seqCv.getContext('2d');
const SEQ = { pad: 14, lineal: 22, drag: null, zoom: 1, ptr: new Map(), pinch: null };
// v4.9e Zoom (Robert 11.11.: „mit zwei Fingern ranzoomen, um präziser durch die Shortlist zu wandern“):
// zoom 1 = ganze Sequenz passt in die Breite (wie bisher: antippen/ziehen = Stelle). zoom > 1 = Abspielkopf bleibt mittig,
// Wischen spult (wie die Footage-Zeitleiste), kurzes Antippen springt an die getippte Stelle. Zwei Finger / Strg+Mausrad = zoomen.
function seqAnsicht(w, gesamt) {
  const breit = w - 2 * SEQ.pad, pps = breit / Math.max(gesamt, 0.1) * SEQ.zoom;
  const sicht = breit / pps;
  const v0 = SEQ.zoom <= 1 ? 0 : clamp(seqZeit() - sicht / 2, 0, Math.max(0, gesamt - sicht));
  return { pps, v0, x: (t) => SEQ.pad + (t - v0) * pps, t: (px) => v0 + (px - SEQ.pad) / pps };
}

// Bereiche der Sequenz mit Start (Sequenzzeit) und Länge
function seqTeile() {
  if (!reel) return { teile: [], gesamt: 0 };
  let t = 0;
  const teile = reel.list.map((s) => { const [a, b] = selRange(s); const d = Math.max(0.04, b - a); const x = { s, a, d, t0: t }; t += d; return x; });
  return { teile, gesamt: t };
}
// aktuelle Sequenzzeit aus der echten Footage-Zeit S.T
function seqZeit() {
  const { teile } = seqTeile(), p = teile[reel ? reel.i : 0];
  return p ? p.t0 + clamp(S.T - p.a, 0, p.d) : 0;
}
const seqFmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function seqOeffnen() {
  $('seqWrap').classList.remove('hidden');
  seqResize(); seqFilterZeigen(); seqZeichnen();
}
function seqResize() {
  const r = seqCv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  seqCv.width = Math.round(r.width * dpr); seqCv.height = Math.round(r.height * dpr);
  seqCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  seqZeichnen();
}
window.addEventListener('resize', () => reel && seqResize());

function seqZeichnen() {
  const wrap = $('seqWrap');
  if (!reel) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const dpr = window.devicePixelRatio || 1, w = seqCv.width / dpr, h = seqCv.height / dpr, g = seqCtx;
  const { teile, gesamt } = seqTeile();
  const { pps, v0, x } = seqAnsicht(w, gesamt);
  const y0 = SEQ.lineal + 8, bh = h - y0 - 14;
  g.clearRect(0, 0, w, h);
  // Lineal in Sequenzzeit (nur sichtbarer Bereich)
  g.fillStyle = '#8e8e93'; g.font = '600 11px -apple-system, Segoe UI, sans-serif'; g.textBaseline = 'middle';
  const schritt = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 70) || 600;
  const tBis = v0 + (w - SEQ.pad) / pps;
  for (let t = Math.floor(v0 / schritt) * schritt; t <= Math.min(gesamt, tBis) + 0.001; t += schritt) {
    if (x(t) < 0) continue;
    g.fillRect(x(t), SEQ.lineal - 6, 1, 6); g.fillText(schritt < 1 ? `${seqFmt(t)}.${Math.round((t % 1) * 10)}` : seqFmt(t), x(t) + 4, SEQ.lineal - 12);
  }
  // Bereiche als Blöcke mit Filmstreifen, Farbe der Kamera, Name + Sterne
  teile.forEach((p, i) => {
    const bx = x(p.t0), bw = Math.max(2, p.d * pps - 2);
    if (bx > w || bx + bw < 0) return;   // außerhalb der Ansicht
    const c = S.byId.get(p.s.clipId), tr = S.tracks.findIndex((t) => t.id === p.s.track);
    const farbe = (S.tracks[tr] && S.tracks[tr].color) || TRACK_COLORS[0];
    g.save(); g.beginPath(); g.rect(bx, y0, bw, bh); g.clip();
    g.fillStyle = '#1f2228'; g.fillRect(bx, y0, bw, bh);
    g.globalAlpha = 0.3; g.fillStyle = farbe; g.fillRect(bx, y0, bw, bh); g.globalAlpha = 1;   // Block auch ohne Filmstreifen gut sichtbar
    const img = c && S.sprites.get(c.id);
    if (img && img.complete && img.naturalWidth && c.spriteN) {
      const th = bh, tw = th * 16 / 9;
      for (let xx = bx + Math.max(0, Math.floor((-tw - bx) / tw)) * tw; xx < Math.min(bx + bw, w + tw); xx += tw) {
        const tq = p.s.inT + ((xx + tw / 2 - bx) / pps), idx = clamp(Math.floor(tq / c.spriteStep), 0, c.spriteN - 1);
        g.drawImage(img, idx * 160, 0, 160, 90, xx, y0, tw, th);
      }
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(bx, y0, bw, bh);
    }
    g.fillStyle = farbe; g.fillRect(bx, y0, bw, 4);
    if (bw > 46) {
      g.fillStyle = '#fff'; g.font = '600 12px -apple-system, Segoe UI, sans-serif'; g.textBaseline = 'top';
      g.fillText(`${i + 1} · ${(c && c.name) || ''}`.slice(0, Math.floor(bw / 7)), bx + 6, y0 + 9);
      if (p.s.stars) { g.fillStyle = '#f2c14e'; g.fillText('★'.repeat(p.s.stars), bx + 6, y0 + 26); }
      if (p.s.notes && p.s.notes.length && bw > 70) { g.fillStyle = '#fff'; g.fillText('🎙' + p.s.notes.length, bx + 6, y0 + bh - 20); }
    }
    g.restore();
    g.strokeStyle = farbe; g.lineWidth = 1; g.strokeRect(bx + 0.5, y0 + 0.5, bw - 1, bh - 1);
    if (i === reel.i) { g.strokeStyle = '#f2c14e'; g.lineWidth = 2; g.strokeRect(bx + 1, y0 + 1, bw - 2, bh - 2); }
  });
  // eigener Abspielkopf
  const px = x(seqZeit());
  g.fillStyle = '#ff453a'; g.fillRect(px - 1, SEQ.lineal - 4, 2, h - SEQ.lineal - 6);
  g.beginPath(); g.moveTo(px - 7, SEQ.lineal - 6); g.lineTo(px + 7, SEQ.lineal - 6); g.lineTo(px, SEQ.lineal + 3); g.fill();
  $('seqInfo').textContent = `${reel.i + 1}/${teile.length} · ${seqFmt(seqZeit())} / ${seqFmt(gesamt)}` + (SEQ.zoom > 1.05 ? ` · ${SEQ.zoom.toFixed(1)}×` : '');
}

// Sequenzzeit → Bereich + Position; beim Ziehen schnelles Bild, beim Loslassen genaues
function seqSpringe(t, genau) {
  const { teile, gesamt } = seqTeile();
  t = clamp(t, 0, Math.max(0, gesamt - 0.04));
  let i = teile.findIndex((p) => t < p.t0 + p.d); if (i < 0) i = teile.length - 1;
  const p = teile[i];
  if (i !== reel.i) { reel.i = i; S.curSel = p.s; S.activeTrack = p.s.track; renderSide(); }
  S.T = p.a + (t - p.t0);
  showFrame(!!genau); updateReelBar(); seqZeichnen();
}
// Bildschirm-x → Sequenzzeit in der aktuellen Ansicht (Zoom berücksichtigt)
const seqT = (e) => { const r = seqCv.getBoundingClientRect(), { gesamt } = seqTeile(); return seqAnsicht(r.width, gesamt).t(e.clientX - r.left); };
const seqAbstand = () => { const [a, b] = [...SEQ.ptr.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
seqCv.addEventListener('pointerdown', (e) => {
  if (!reel) return;
  try { seqCv.setPointerCapture(e.pointerId); } catch { /* egal */ }
  SEQ.ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (SEQ.ptr.size === 2) {                                   // zweiter Finger: Ziehen abbrechen, Zoom beginnt
    SEQ.pinch = { d0: seqAbstand(), z0: SEQ.zoom, warSpielend: SEQ.drag ? SEQ.drag.warSpielend : false };
    if (SEQ.drag && SEQ.drag.t0 != null) seqSpringe(SEQ.drag.t0, false);   // Sprung durch den ersten Finger zurücknehmen
    SEQ.drag = null; return;
  }
  if (SEQ.ptr.size > 2) return;
  const t0 = seqZeit();
  SEQ.drag = { warSpielend: S.playing, letzt: 0, x0: e.clientX, t0, bewegt: false };
  stopPlay();
  if (SEQ.zoom <= 1) seqSpringe(seqT(e), false);             // ganze Sequenz: Finger = Stelle (wie bisher)
});
seqCv.addEventListener('pointermove', (e) => {
  if (!reel || !SEQ.ptr.has(e.pointerId)) return;
  SEQ.ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (SEQ.pinch && SEQ.ptr.size === 2) {
    SEQ.zoom = clamp(SEQ.pinch.z0 * seqAbstand() / SEQ.pinch.d0, 1, 80);
    seqZeichnen(); return;
  }
  if (!SEQ.drag) return;
  if (Math.abs(e.clientX - SEQ.drag.x0) > 6) SEQ.drag.bewegt = true;
  const jetzt = performance.now(); if (jetzt - SEQ.drag.letzt < 40) return;   // ~25 Bilder/s beim Durchziehen
  SEQ.drag.letzt = jetzt;
  if (SEQ.zoom <= 1) { seqSpringe(seqT(e), false); return; }
  if (!SEQ.drag.bewegt) return;
  const r = seqCv.getBoundingClientRect(), { pps } = seqAnsicht(r.width, seqTeile().gesamt);
  seqSpringe(SEQ.drag.t0 - (e.clientX - SEQ.drag.x0) / pps, false);   // Wischen spult, Kopf bleibt mittig
});
const seqLos = (e) => {
  SEQ.ptr.delete(e.pointerId);
  if (!reel) return;
  if (SEQ.pinch) {
    if (SEQ.ptr.size === 0) { log('sequenz-zoom', { zoom: +SEQ.zoom.toFixed(2) }); const w = SEQ.pinch.warSpielend; SEQ.pinch = null; seqSpringe(seqZeit(), true); if (w) { lastToggle = 0; play(); } }
    return;
  }
  if (!SEQ.drag) return;
  const d = SEQ.drag; SEQ.drag = null;
  if (SEQ.zoom <= 1 || !d.bewegt) seqSpringe(seqT(e), true);   // Antippen = an die Stelle springen
  else { const r = seqCv.getBoundingClientRect(), { pps } = seqAnsicht(r.width, seqTeile().gesamt); seqSpringe(d.t0 - (e.clientX - d.x0) / pps, true); }
  log('sequenz-gezogen', { bereich: reel.i + 1, t: +seqZeit().toFixed(2), zoom: +SEQ.zoom.toFixed(2) });
  if (d.warSpielend) { lastToggle = 0; play(); }
};
seqCv.addEventListener('pointerup', seqLos); seqCv.addEventListener('pointercancel', seqLos);
// Am PC: Strg+Mausrad zoomt, Mausrad spult (wie die Footage-Zeitleiste)
seqCv.addEventListener('wheel', (e) => {
  if (!reel) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { SEQ.zoom = clamp(SEQ.zoom * Math.exp(-e.deltaY / 300), 1, 80); seqZeichnen(); return; }
  const r = seqCv.getBoundingClientRect(), { pps } = seqAnsicht(r.width, seqTeile().gesamt);
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  stopPlay(); seqSpringe(seqZeit() + d / pps, true);
}, { passive: false });

// Filter: nur Bereiche ab n Sternen (0 = alle); aktueller Bereich bleibt, wenn er noch drin ist
function seqFilterZeigen() { document.querySelectorAll('#seqFilter [data-min]').forEach((b) => b.classList.toggle('on', +b.dataset.min === (reel ? reel.min : 0))); }
document.querySelectorAll('#seqFilter [data-min]').forEach((b) => b.addEventListener('click', () => {
  if (!reel) return;
  const min = +b.dataset.min, list = reelListe(min);
  if (!list.length) { toast(min ? `Keine Bereiche mit ${'★'.repeat(min)}` : 'Keine fertigen Bereiche'); return; }
  const cur = reel.list[reel.i];
  stopPlay();
  reel.list = list; reel.min = min;
  const i = Math.max(0, list.indexOf(cur));
  log('sequenz-filter', { min, n: list.length });
  seqFilterZeigen(); reelGo(i, 0, false); seqZeichnen();
}));
$('seqZu').addEventListener('click', () => endReel(true));

// mitlaufen: beim Abspielen und nach jeder Änderung (Sterne, Notizen) neu zeichnen
const _seqDrawOrig = draw;
draw = function () { _seqDrawOrig(); if (reel) seqZeichnen(); };   // eslint-disable-line no-global-assign
// Vollbild an/aus ändert die Größe der Sequenz-Leiste ohne resize-Ereignis (iPad) → mit der Haupt-Zeitleiste neu vermessen
const _seqResizeOrig = resizeCanvas;
resizeCanvas = function () { _seqResizeOrig.apply(this, arguments); if (reel) seqResize(); };   // eslint-disable-line no-global-assign
