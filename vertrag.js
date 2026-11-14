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
      if (e.typ === 'slip' || e.typ === 'tausch' || e.typ === 'umstellen') ziel = { ...e.ziel, change_id: e.change_id };
      else if (e.typ === 'reset') ziel = null;
    }
    if (ziel && !ziel.von_shot && !ziel.wunschtempo && ziel.clip === shot.clip && ziel.src_in === shot.src_in) return null;
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
      : a.typ === 'umstellen' ? `Shot ${shot.nr} ← Shot ${n.von_nr} · ${n.clip} (Quelle ${q1})`
      : `Shot ${shot.nr} · ${shot.clip} → ${n.clip} (Quelle ${q1})`;
    return `${head} · Länge gleich · ${v} · Ton bleibt` + ersatzText(shot, a);
  }
  // Zusatz für Zeitlupe/Topaz (v4.9x Ersatzmedium, v4.9y Umstellen: Art des umgezogenen Inhalts) – gleich wie bt_v4.ersatz_text
  function ersatzText(shot, a) {
    const um = a.typ === 'umstellen';
    if (a.wunschtempo) {   // v5.1: Wunschtempo beim Verschieben – Länge bleibt, weniger/mehr Inhalt
      const art0 = um ? a.ersatz_art : shot.ersatz ? shot.ersatz.art : null;
      return ` · Tempo ${a.wunschtempo} % → ${fmtS(a.tempo || 1)}×` + (a.topaz_noetig || art0 === 'topaz' ? ' · TOPAZ NEU RECHNEN' : '');
    }
    if (!um && !shot.ersatz) return '';
    const art = um ? a.ersatz_art : shot.ersatz.art, t = a.tempo || 1;
    return (Math.abs(t - 1) > 1e-3 ? ` · Zeitlupe ${fmtS(t)}×` : '')
      + (art === 'topaz' ? (a.wiederverwenden ? ' · Topaz-Render bleibt' : ' · TOPAZ NEU RECHNEN') : '');
  }
  // Quellbilder des neuen Inhalts (v4.9y: Umstellen bringt seine eigene Länge n_src mit – Platzlänge × Tempo des Inhalts)
  const nSrcOf = (shot, z) => (Number.isInteger(z.n_src) ? z.n_src : Math.round((shot.src_out - shot.src_in) * z.src_fps / shot.src_fps));
  const tempoOf = (shot, z) => (z.von_shot || z.wunschtempo ? (z.tempo || 1.0) : shot.ersatz ? (shot.tempo || 1.0) : 1.0);
  function auftrag(version, shot, z, revision = 1) {
    const typ = z.von_shot ? 'umstellen' : z.clip === shot.clip ? 'slip' : 'tausch';
    const nSrc = shot.src_out - shot.src_in;
    const zOut = typ === 'slip' && !z.wunschtempo ? z.src_in + nSrc : z.src_in + nSrcOf(shot, z);
    const a = {
      change_id: z.change_id, revision, typ, shot: shot.id, nr: shot.nr, v_in: shot.v_in, v_out: shot.v_out,
      vorher: { clip: shot.clip, src_in: shot.src_in, src_out: shot.src_out, src_fps: shot.src_fps },
      nachher: { clip: z.clip, src_in: z.src_in, src_out: zOut, src_fps: z.src_fps, bereich: z.bereich || 'ganzer_clip' },
      tempo: tempoOf(shot, z), audio_policy: 'keep_version_audio', folgen: [...(shot.folgen || [])], pruefung: [],
    };
    if (Array.isArray(z.bereich_frames)) a.nachher.bereich_frames = [...z.bereich_frames];
    if (z.wunschtempo) { a.wunschtempo = z.wunschtempo; if (z.topaz) a.topaz_noetig = true; }
    if (typ === 'umstellen') {
      a.nachher.von_shot = z.von_shot; a.nachher.von_nr = z.von_nr;
      if (z.ersatz_art) a.ersatz_art = z.ersatz_art;
      a.wiederverwenden = !!z.wiederverwenden;
    }   // Shortlist-Grenze geht mit (apply_edits prüft)
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
    if (shot.editierbar === false) return 'Shot gesperrt';
    if (!z || !Number.isInteger(z.src_in) || !(z.src_fps > 0)) return 'Zielangaben ungültig';
    const c = projektClips[z.clip];
    if (!c) return 'Clip nicht im Projekt';
    const n = nSrcOf(shot, z);
    let lo = 0, hi = Math.round(c.dur * z.src_fps);
    // Shortlist-Bereich nur innerhalb der echten Clipgrenzen
    if (z.bereich_frames) { lo = Math.max(lo, z.bereich_frames[0]); hi = Math.min(hi, z.bereich_frames[1]); }
    if (z.src_in < lo || z.src_in + n > hi) return `Quellbereich reicht nicht (${z.src_in}+${n} außerhalb ${lo}–${hi})`;
    return null;
  }
  root.BTV = { fmtTc, fmtS, zielOf, markerText, auftrag, auftraege, checkZiel };
})(typeof window !== 'undefined' ? window : globalThis);
