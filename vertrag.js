/* Framepoint v4 – Datenvertrag in der App (gleiche Regeln wie bt_v4.py, geprüft gegen tests/vectors.json mit
 * tests/test_vertrag_js.mjs). Pro Shot-Instanz EIN wirksamer Zielzustand; Ereignisse sind nur Historie;
 * Marker-Text wird nur aus dem Zielzustand erzeugt. Zeiten: Sequenz in ganzen Bildern, Quelle in Bildern der nativen fps. */
(function (root) {
  'use strict';
  const fmtTc = (frames, fps) => { // 0:41,12 (Minuten:Sekunden,Bild)
    const f = Math.round(fps), n = Math.trunc(frames), s = Math.floor(n / f), b = n - s * f;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')},${String(b).padStart(2, '0')}`;
  };
  const fmtS = (sec) => sec.toFixed(2).replace('.', ',');

  // Wirksamer Zielzustand eines Shots aus seinen Ereignissen (in Reihenfolge); null = Basis unverändert
  function zielOf(shot, ereignisse) {
    let ziel = null;
    for (const e of ereignisse) {
      if (e.typ === 'slip' || e.typ === 'tausch') ziel = { ...e.ziel, change_id: e.change_id };
      else if (e.typ === 'reset') ziel = null;
    }
    if (ziel && ziel.clip === shot.clip && ziel.src_in === shot.src_in) return null;
    return ziel;
  }
  function markerText(version, shot, a) {
    const fps = version.fps;
    const v = `Version ${fmtTc(shot.v_in, fps)}–${fmtTc(shot.v_out, fps)}`;
    const sf = a.vorher.src_fps, n = a.nachher;
    const q0 = `${fmtS(a.vorher.src_in / sf)}–${fmtS(a.vorher.src_out / sf)}`;
    const q1 = `${fmtS(n.src_in / n.src_fps)}–${fmtS(n.src_out / n.src_fps)}`;
    const head = a.typ === 'slip'
      ? `Shot ${shot.nr} · ${shot.clip} · Inhalt ${a.delta_s >= 0 ? '+' : '−'}${fmtS(Math.abs(a.delta_s))} s (Quelle ${q0} → ${q1})`
      : `Shot ${shot.nr} · ${shot.clip} → ${n.clip} (Quelle ${q1})`;
    return `${head} · Länge gleich · ${v} · Ton bleibt`;
  }
  function auftrag(version, shot, z, revision = 1) {
    const typ = z.clip === shot.clip ? 'slip' : 'tausch';
    const nSrc = shot.src_out - shot.src_in;
    const zOut = typ === 'tausch' ? z.src_in + Math.round(nSrc * z.src_fps / shot.src_fps) : z.src_in + nSrc;
    const a = {
      change_id: z.change_id, revision, typ, shot: shot.id, nr: shot.nr, v_in: shot.v_in, v_out: shot.v_out,
      vorher: { clip: shot.clip, src_in: shot.src_in, src_out: shot.src_out, src_fps: shot.src_fps },
      nachher: { clip: z.clip, src_in: z.src_in, src_out: zOut, src_fps: z.src_fps, bereich: z.bereich || 'ganzer_clip' },
      tempo: 1.0, audio_policy: 'keep_version_audio', folgen: [...(shot.folgen || [])], pruefung: [],
    };
    if (typ === 'slip') {
      a.delta_src_frames = z.src_in - shot.src_in;
      a.delta_s = Math.round(a.delta_src_frames / shot.src_fps * 1e4) / 1e4;
    }
    if (shot.o_ton) a.pruefung.push('synchroner O-Ton im Shot – Bild ändert sich, Ton bleibt');
    a.marker = markerText(version, shot, a);
    return a;
  }
  // Alle wirksamen Aufträge einer Version nach Sequenzzeit
  function auftraege(version, ereignisse) {
    const shots = new Map(version.shots.map((s) => [s.id, s]));
    const byShot = new Map();
    for (const e of ereignisse) { if (!byShot.has(e.shot)) byShot.set(e.shot, []); byShot.get(e.shot).push(e); }
    const out = [];
    for (const [sid, evs] of byShot) {
      const shot = shots.get(sid);
      if (!shot) { out.push({ shot: sid, fehler: 'Shot nicht in der Version' }); continue; }
      const z = zielOf(shot, evs);
      if (z) out.push(auftrag(version, shot, z, evs.length));
    }
    return out.sort((a, b) => (a.v_in || 0) - (b.v_in || 0));
  }
  // Ist der Zielzustand umsetzbar? Quellbereich innerhalb des Clips bzw. gewählten Bereichs. null = ok, sonst Grund
  function checkZiel(shot, z, projektClips) {
    const c = projektClips[z.clip];
    if (!c) return 'Clip nicht im Projekt';
    const n = Math.round((shot.src_out - shot.src_in) * z.src_fps / shot.src_fps);
    let lo = 0, hi = Math.round(c.dur * z.src_fps);
    if (z.bereich_frames) [lo, hi] = z.bereich_frames;
    if (z.src_in < lo || z.src_in + n > hi) return `Quellbereich reicht nicht (${z.src_in}+${n} außerhalb ${lo}–${hi})`;
    return null;
  }
  root.BTV = { fmtTc, fmtS, zielOf, markerText, auftrag, auftraege, checkZiel };
})(typeof window !== 'undefined' ? window : globalThis);
