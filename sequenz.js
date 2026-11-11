/* Framepoint – Shortlist-Sequenz (Robert 10.11.2026): eigene Ansicht wie ein neues Projekt.
 * Nur die fertigen IN/OUT-Bereiche lückenlos hintereinander auf einer eigenen Zeitleiste (Sequenzzeit 0 … Gesamtlänge),
 * mit eigenem Abspielkopf: ziehen = durchsliden, antippen = dorthin springen. Filter ★/★★/★★★ blendet schwächere Bereiche aus.
 * Steuerung (Abspielen, Weiterspringen zwischen Bereichen) liegt in app.js (reel, reelGo); hier nur Ansicht + Gesten.
 * Die Sequenz ist eine Sicht auf die Shortlist – Sterne/Notizen/Kommentare gehören weiter zu den Bereichen. */
'use strict';
const seqCv = $('seqCv'), seqCtx = seqCv.getContext('2d');
const SEQ = { pad: 14, lineal: 22, drag: null };

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
  const pps = (w - 2 * SEQ.pad) / Math.max(gesamt, 0.1), x = (t) => SEQ.pad + t * pps;
  const y0 = SEQ.lineal + 8, bh = h - y0 - 14;
  g.clearRect(0, 0, w, h);
  // Lineal in Sequenzzeit
  g.fillStyle = '#8e8e93'; g.font = '600 11px -apple-system, Segoe UI, sans-serif'; g.textBaseline = 'middle';
  const schritt = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 70) || 600;
  for (let t = 0; t <= gesamt + 0.001; t += schritt) {
    g.fillRect(x(t), SEQ.lineal - 6, 1, 6); g.fillText(seqFmt(t), x(t) + 4, SEQ.lineal - 12);
  }
  // Bereiche als Blöcke mit Filmstreifen, Farbe der Kamera, Name + Sterne
  teile.forEach((p, i) => {
    const bx = x(p.t0), bw = Math.max(2, p.d * pps - 2);
    const c = S.byId.get(p.s.clipId), tr = S.tracks.findIndex((t) => t.id === p.s.track);
    const farbe = (S.tracks[tr] && S.tracks[tr].color) || TRACK_COLORS[0];
    g.save(); g.beginPath(); g.rect(bx, y0, bw, bh); g.clip();
    g.fillStyle = '#1f2228'; g.fillRect(bx, y0, bw, bh);
    g.globalAlpha = 0.3; g.fillStyle = farbe; g.fillRect(bx, y0, bw, bh); g.globalAlpha = 1;   // Block auch ohne Filmstreifen gut sichtbar
    const img = c && S.sprites.get(c.id);
    if (img && img.complete && img.naturalWidth && c.spriteN) {
      const th = bh, tw = th * 16 / 9;
      for (let xx = bx; xx < bx + bw; xx += tw) {
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
  $('seqInfo').textContent = `${reel.i + 1}/${teile.length} · ${seqFmt(seqZeit())} / ${seqFmt(gesamt)}`;
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
const seqT = (e) => { const r = seqCv.getBoundingClientRect(), { gesamt } = seqTeile(); return (e.clientX - r.left - SEQ.pad) / ((r.width - 2 * SEQ.pad) / Math.max(gesamt, 0.1)); };
seqCv.addEventListener('pointerdown', (e) => {
  if (!reel) return;
  try { seqCv.setPointerCapture(e.pointerId); } catch { /* egal */ }
  SEQ.drag = { warSpielend: S.playing, letzt: 0 };
  stopPlay(); seqSpringe(seqT(e), false);
});
seqCv.addEventListener('pointermove', (e) => {
  if (!reel || !SEQ.drag) return;
  const jetzt = performance.now(); if (jetzt - SEQ.drag.letzt < 40) return;   // ~25 Bilder/s beim Durchziehen
  SEQ.drag.letzt = jetzt; seqSpringe(seqT(e), false);
});
const seqLos = (e) => {
  if (!reel || !SEQ.drag) return;
  const weiter = SEQ.drag.warSpielend; SEQ.drag = null;
  seqSpringe(seqT(e), true); log('sequenz-gezogen', { bereich: reel.i + 1, t: +seqZeit().toFixed(2) });
  if (weiter) { lastToggle = 0; play(); }
};
seqCv.addEventListener('pointerup', seqLos); seqCv.addEventListener('pointercancel', seqLos);

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
$('seqZu').addEventListener('click', () => endReel());

// mitlaufen: beim Abspielen und nach jeder Änderung (Sterne, Notizen) neu zeichnen
const _seqDrawOrig = draw;
draw = function () { _seqDrawOrig(); if (reel) seqZeichnen(); };   // eslint-disable-line no-global-assign
// Vollbild an/aus ändert die Größe der Sequenz-Leiste ohne resize-Ereignis (iPad) → mit der Haupt-Zeitleiste neu vermessen
const _seqResizeOrig = resizeCanvas;
resizeCanvas = function () { _seqResizeOrig.apply(this, arguments); if (reel) seqResize(); };   // eslint-disable-line no-global-assign
