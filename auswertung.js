// ==UserScript==
// @name         Raubzug-Auswertung (Die Stämme)
// @namespace    die-staemme-raubzug-auswertung
// @version      1.0.0
// @description  Wertet gesammelte Rohstoffe (Raubzüge) pro Stamm aus der Rangliste aus, inkl. Raubzugsquote, BB-Code und CSV
// @match        https://*.die-staemme.de/game.php*
// @grant        none
// ==/UserScript==

/*
 * Raubzug-Auswertung für Die Stämme
 *
 * Nutzung:
 *  - Schnellleiste: javascript:$.getScript('https://DEINE-URL/raubzug-auswertung.js');void(0);
 *  - Tampermonkey: Datei als Userscript einfügen und USERSCRIPT_MODE auf true setzen
 *    (dann erscheint unten links ein kleiner Button, der das Fenster öffnet).
 *
 * Das Skript liest nur öffentliche Daten (map/player.txt, map/ally.txt) und die
 * Ranglistenseiten. Es führt keine Aktionen im Spiel aus.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Einstellungen
  const USERSCRIPT_MODE = false; // true = Button einblenden statt sofort öffnen

  const CFG = {
    pauseMs: 250,      // Pause zwischen zwei Seitenaufrufen
    maxSeiten: 400,    // Sicherheitsgrenze pro Rangliste
    // Ranglisten-Typen (falls die Welt andere Namen nutzt, hier anpassen):
    typRaubzug: 'scavenge',   // Gesammelte Rohstoffe (Raubzüge)
    // Soll-Modell für Raubzüge (siehe sollProTag):
    sollMax: 44000,    // feste Formel / Rückfallwert: 100 %-Beute pro Dorf und Tag bei großen Dörfern
    sollP0: 2000,      // Kurvenform: ab ca. 4.000 Punkten pro Dorf ist ein Dorf fast voll ausgelastet
    // Welt-Eichung: Median der Top-100-Rekorde (nur junge Rekorde) soll genau eichZiel % ergeben
    eichTop: 100,        // Plätze der Rekordliste, die als Vergleich dienen
    eichMaxAlter: 14,    // nur Rekorde der letzten X Tage (alte Rekorde passen nicht mehr zu den heutigen Punkten/Dörfern)
    eichMinAnzahl: 30,   // so viele Vergleichsspieler mindestens, sonst feste Formel
    eichZiel: 200,       // der Median der Vergleichsspieler entspricht dieser Quote in %
    eichTage: 7,         // Eichung höchstens so alt (danach automatisch neu)
    eichMin: 25000,      // Plausibilitätsgrenzen für die berechnete Eichung
    eichMax: 80000,
  };

  // ---------------------------------------------------------------- Grundlagen
  const gd = window.game_data;
  if (window.top !== window.self) return;
  if (!gd) { alert('Bitte im Spiel ausführen (game.php).'); return; }
  if (window.__rzAuswertung) { if (!USERSCRIPT_MODE) window.__rzAuswertung.open(); return; }

  const nf = new Intl.NumberFormat('de-DE');
  const fmt = (n) => (n == null ? '–' : nf.format(Math.round(n)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NUM = /^(\d+|\d{1,3}(\.\d{3})+)$/;   // "1001" oder "5.222.447"
  const q = (sel) => document.querySelector('#rz-box ' + sel);

  // ---------------------------------------------------------------- Soll-Modell
  // Soll (= 100 %) pro Dorf und Tag = C * (1 - exp(-Punkte pro Dorf / sollP0)):
  // größere Dörfer schaffen mehr, ab ca. 4.000 Punkten pro Dorf flacht die Kurve ab.
  // C ist entweder fest (sollMax) oder wird aus der Rekordliste der Welt geeicht (siehe berechneEichung).
  function sollProTag(punkte, doerfer, C) {
    if (!doerfer || !punkte) return 0;
    const pd = punkte / doerfer;
    return doerfer * C * (1 - Math.exp(-pd / CFG.sollP0));
  }

  // ---------------------------------------------------------------- Daten holen
  async function holeText(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' bei ' + url);
    return r.text();
  }

  const dec = (s) => decodeURIComponent((s || '').replace(/\+/g, ' '));

  async function ladeWeltdaten() {
    const [pt, at] = await Promise.all([
      holeText(location.origin + '/map/player.txt'),
      holeText(location.origin + '/map/ally.txt'),
    ]);
    const players = pt.trim().split('\n').map((l) => {
      const c = l.split(',');
      return { id: c[0], name: dec(c[1]), ally: c[2], doerfer: +c[3], punkte: +c[4] };
    });
    const allies = at.trim().split('\n').map((l) => {
      const c = l.split(',');
      return { id: c[0], name: dec(c[1]), tag: dec(c[2]) };
    });
    return { players, allies };
  }

  // Liest NUR die Ranglisten-Tabelle (id endet auf "ranking_table"), nicht das Menü links.
  function parseRangliste(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [];
    const t = doc.querySelector('table[id$="ranking_table"]');
    if (!t) return { rows };
    const kopf = [...(t.querySelector('tr') ? t.querySelector('tr').children : [])].map((c) => c.textContent.trim().toLowerCase());
    const iW = kopf.findIndex((h) => h.startsWith('punkte'));
    const iD = kopf.findIndex((h) => h.startsWith('datum'));
    const zahl = (x) => { const z = String(x || '').replace(/\s/g, ''); return NUM.test(z) ? parseInt(z.replace(/\./g, ''), 10) : null; };
    t.querySelectorAll('tr').forEach((tr) => {
      const a = tr.querySelector('a[href*="screen=info_player"]');
      if (!a) return;
      const m = (a.getAttribute('href') || '').match(/[?&]id=(\d+)/);
      if (!m) return;
      const cells = [...tr.children].map((td) => td.textContent.trim().replace(/\s+/g, ' '));
      let wert = iW >= 0 ? zahl(cells[iW]) : null;
      if (wert == null) for (let i = cells.length - 1; i >= 1; i--) { const z = zahl(cells[i]); if (z != null) { wert = z; break; } }
      if (wert == null) return;
      rows.push({ id: m[1], wert, rang: zahl(cells[0]), datum: iD >= 0 ? cells[iD] : '' });
    });
    return { rows };
  }

  // Lädt eine "An einem Tag"-Rangliste vollständig: 25 Plätze pro Seite, immer ab dem ersten fehlenden Platz.
  // Ergebnis: Map Spieler-ID -> { wert, datum }
  async function ladeRangliste(mode, type, label, fortschritt, diag) {
    const basis = `${location.origin}/game.php?village=${gd.village.id}&screen=ranking&mode=${mode}&type=${type}`;
    const werte = new Map();
    const raenge = new Set();
    const d = { label, mode, type, seiten: [], param: 'offset', gesamt: 0, hoechsterRang: 0 };
    diag.push(d);
    let n = 0;
    const lueckenlos = () => { let k = 0; while (raenge.has(k + 1)) k++; return k; };

    async function seite(offset) {
      const url = `${basis}&offset=${offset}`;
      const html = await holeText(url);
      n++;
      const { rows } = parseRangliste(html);
      const vorher = werte.size, rvorher = raenge.size;
      rows.forEach((r) => {
        const alt = werte.get(r.id);
        if (!alt || alt.wert < r.wert) werte.set(r.id, { wert: r.wert, datum: r.datum, rang: r.rang });
        if (r.rang != null) raenge.add(r.rang);
      });
      const rr = rows.map((r) => r.rang).filter((x) => x != null);
      d.seiten.push({
        url: url.replace(location.origin, '').replace(/village=\d+&/, ''),
        zeilen: rows.length, neu: werte.size - vorher, neueRaenge: raenge.size - rvorher,
        rang: rr.length ? Math.min(...rr) + '-' + Math.max(...rr) : '?',
      });
      fortschritt(`${label}: Seite ${n} geladen (${werte.size} Spieler)…`);
      await sleep(CFG.pauseMs);
      return { rows, neueRaenge: raenge.size - rvorher };
    }

    let leer = 0;
    while (n < CFG.maxSeiten) {
      const t = await seite(lueckenlos());   // Seite beginnt bei Platz k+1
      if (n === 1 && !t.rows.length) throw new Error(`Keine Ranglisten-Zeilen erkannt (${label}).`);
      if (!t.rows.length) break;
      if (t.neueRaenge === 0) { if (++leer >= 2) break; } else leer = 0;   // hinter dem Listenende liefert das Spiel die letzte Seite erneut
    }
    if (!raenge.size) throw new Error(`Keine Platznummern erkannt (${label}).`);
    d.gesamt = werte.size;
    d.hoechsterRang = Math.max(...raenge);
    return werte;
  }

  const heuteDatum = () => { const t = new Date(); return [t.getDate(), t.getMonth() + 1, t.getFullYear()].map((x, i) => String(x).padStart(i < 2 ? 2 : 4, '0')).join('.'); };
  const istHeute = (datum) => /^heute$/i.test(datum || '') || (datum || '').trim() === heuteDatum();
  // "Heute"/"Gestern" -> echtes Datum (für BB-Code und CSV, die später gelesen werden)
  const datumAbs = (datum) => {
    const t = (datum || '').trim();
    const f = (d) => [d.getDate(), d.getMonth() + 1, d.getFullYear()].map((x, i) => String(x).padStart(i < 2 ? 2 : 4, '0')).join('.');
    if (/^heute$/i.test(t)) return f(new Date());
    if (/^gestern$/i.test(t)) { const d = new Date(); d.setDate(d.getDate() - 1); return f(d); }
    return t || '–';
  };

  // ---------------------------------------------------------------- Welt-Eichung
  const EKEY = 'rz_eich_' + gd.world;
  const median = (a) => { const t = [...a].sort((x, y) => x - y); const m = t.length >> 1; return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2; };
  const alterInTagen = (datum) => {
    const t = (datum || '').trim();
    if (/^heute$/i.test(t)) return 0;
    if (/^gestern$/i.test(t)) return 1;
    const m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!m) return null;
    const h = new Date(); h.setHours(0, 0, 0, 0);
    return Math.round((h - new Date(+m[3], +m[2] - 1, +m[1])) / 864e5);
  };
  // Vergleich mit der Welt: Rekord pro Dorf der Top-100 (nur Rekorde der letzten Tage, damit Punkte/Dörfer noch passen),
  // geteilt durch die Kurve. Der MEDIAN ist unempfindlich gegen Ausreißer (z. B. Spieler, die viele Dörfer verloren haben).
  function berechneEichung(raub, players) {
    const byId = new Map(players.map((p) => [p.id, p]));
    const werte = [];
    raub.forEach((e, id) => {
      if (e.rang == null || e.rang > CFG.eichTop) return;
      const a = alterInTagen(e.datum);
      if (a == null || a > CFG.eichMaxAlter) return;
      const p = byId.get(id);
      if (!p || !p.doerfer || !p.punkte) return;
      werte.push(e.wert / p.doerfer / (1 - Math.exp(-(p.punkte / p.doerfer) / CFG.sollP0)));
    });
    if (werte.length < CFG.eichMinAnzahl) return null;
    const c = median(werte) / (CFG.eichZiel / 100);
    if (!(c >= CFG.eichMin && c <= CFG.eichMax)) return null;
    return { C: Math.round(c), n: werte.length, t: Date.now() };
  }
  const datumKurz = (t) => new Date(t).toLocaleDateString('de-DE');

  // ---------------------------------------------------------------- Auswertung
  let ergebnis = null;
  let sort = { k: 'quote', dir: -1 };

  async function starten() {
    const modus = q('input[name=rz-modus]:checked').value;
    const tags = q('#rz-tags').value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!tags.length) return setStatus('Bitte mindestens einen Stamm-Tag eingeben.', true);
    q('#rz-start').disabled = true;
    const hinweise = [];
    try {
      setStatus('Lade Welt-Daten…');
      const welt = await ladeWeltdaten();
      const tl = tags.map((t) => t.toLowerCase());
      const allies = welt.allies.filter((a) => tl.includes(a.tag.toLowerCase()));
      const gef = allies.map((a) => a.tag.toLowerCase());
      tags.filter((t) => !gef.includes(t.toLowerCase())).forEach((t) => hinweise.push(`Stamm-Tag "${t}" nicht gefunden.`));
      const tagVon = {}; allies.forEach((a) => (tagVon[a.id] = a.tag));
      const members = welt.players.filter((p) => tagVon[p.ally]);
      if (!members.length) throw new Error('Keine Spieler zu den eingegebenen Tags gefunden.');

      const diag = [];
      const raub = await ladeRangliste('in_a_day', CFG.typRaubzug, 'Raubzüge', setStatus, diag);

      // Messlatte (C): Welt-Eichung (höchstens eichTage alt) oder feste Formel
      let C = CFG.sollMax;
      let eichText = `Messlatte: feste Formel (C = ${fmt(C)} je Dorf)`;
      if (q('input[name=rz-latte]:checked').value === 'welt') {
        let e = null;
        try { e = JSON.parse(localStorage.getItem(EKEY)); } catch (x) { e = null; }
        if (!(e && e.C)) e = null;
        const frisch = e && (Date.now() - e.t) < CFG.eichTage * 864e5 && !q('#rz-neueichen').checked;
        let alt = false;
        if (!frisch) {
          const neu = berechneEichung(raub, welt.players);
          if (neu) { e = neu; try { localStorage.setItem(EKEY, JSON.stringify(e)); } catch (x) { /* ignorieren */ } }
          else if (e) alt = true;
          else { e = null; hinweise.push('Welt-Eichung nicht möglich (zu wenige junge Rekorde in den Top 100) – feste Formel verwendet.'); }
        }
        if (e) {
          C = e.C;
          eichText = `Messlatte: Welt-Eichung vom ${datumKurz(e.t)} (C = ${fmt(C)} je Dorf; Median von ${e.n} Top-100-Spielern = ${CFG.eichZiel} %)` +
            (alt ? ' – Neuberechnung gerade nicht möglich, alte Eichung verwendet' : '');
        }
      }
      hinweise.unshift(eichText);

      const jetzt = new Date();
      const stundenHeute = Math.max((jetzt.getHours() * 60 + jetzt.getMinutes()) / 60, 0.25);
      const heute = modus === 'heute';
      // Wert eines Spielers: nicht in der Liste = nie etwas erbeutet = 0.
      // Heute-Modus: nur exakt, wenn der Rekord von heute ist (dann ist Rekord = Wert seit 0 Uhr).
      const wertVon = (liste, id) => {
        const e = liste.get(id);
        if (!e) return { v: 0, datum: '' };
        if (!heute) return { v: e.wert, datum: e.datum };
        return istHeute(e.datum) ? { v: e.wert, datum: e.datum } : { v: null, datum: e.datum };
      };
      const rows = members.map((p) => {
        const r2 = wertVon(raub, p.id);
        const sollTag = sollProTag(p.punkte, p.doerfer, C);
        const soll = heute ? sollTag * stundenHeute / 24 : sollTag;
        const r = {
          id: p.id, name: p.name, tag: tagVon[p.ally], punkte: p.punkte, doerfer: p.doerfer,
          raubzug: r2.v,
          soll, datum: r2.datum, quote: null,
        };
        r.quote = soll > 0 && r2.v != null ? (r2.v / soll) * 100 : null;
        return r;
      });

      if (heute) {
        const unbekannt = rows.filter((r) => r.raubzug == null).length;
        hinweise.push('Tagesaktuell: Das Spiel liefert nur den Tagesrekord, keinen Wert "seit 0 Uhr". Exakt sind daher nur Spieler, deren Rekord von heute ist (oder die noch nie etwas erbeutet haben).');
        if (unbekannt) hinweise.push(`${unbekannt} von ${rows.length} Spielern haben heute keinen neuen Rekord gesetzt: Ihr Tageswert ist nicht ablesbar (Anzeige "–"), er liegt höchstens beim Rekordwert.`);
      }
      diag[0].treffer = members.filter((p) => raub.has(p.id)).length;
      diag.forEach((x) => { x.mitglieder = members.length; });
      ergebnis = { rows, modus, hinweise, diag, eichText };
      zeigeErgebnis();
    } catch (e) {
      console.error(e);
      setStatus('Fehler: ' + e.message, true);
    } finally {
      q('#rz-start').disabled = false;
    }
  }

  // ---------------------------------------------------------------- Ausgabe
  const SPALTEN = [
    { k: 'name', t: 'Spieler' }, { k: 'tag', t: 'Stamm' },
    { k: 'punkte', t: 'Punkte', n: 1 }, { k: 'doerfer', t: 'Dörfer', n: 1 },
    { k: 'raubzug', t: 'Raubzüge', n: 1 }, { k: 'soll', t: 'Soll Raubzug', n: 1 },
    { k: 'quote', t: 'Quote', n: 1 },
  ];

  function sortiert() {
    const { k, dir } = sort;
    return [...ergebnis.rows].sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return x.localeCompare(y, 'de') * dir;
      return (x - y) * dir;
    });
  }

  function klasse(r, ziel) {
    if (r.quote == null) return '';
    if (r.quote >= ziel) return 'rz-ok';
    if (r.quote >= ziel * 0.75) return 'rz-mid';
    return 'rz-bad';
  }
  const farbe = { 'rz-ok': '#2e7d32', 'rz-mid': '#e08a00', 'rz-bad': '#c62828', '': '#000000' };

  function zeigeErgebnis() {
    q('#rz-setup').style.display = 'none';
    q('#rz-result').style.display = 'block';
    renderTabelle();
  }

  function renderTabelle() {
    const ziel = +q('#rz-ziel').value;
    const rows = sortiert();
    const heute = ergebnis.modus === 'heute';
    const ok = rows.filter((r) => r.quote != null && r.quote >= ziel).length;
    const bewertet = rows.filter((r) => r.quote != null).length;
    const hinweisHtml = ergebnis.hinweise.length ? '<span style="color:#8a5a00">' + ergebnis.hinweise.map(esc).join('<br>') + '</span>' : '';
    q('#rz-summary').innerHTML = (heute && bewertet === 0)
      ? '<b>Noch keine Auswertung möglich.</b><br>' + hinweisHtml
      : `<b>${ok} von ${bewertet}</b> Spielern erreichen mindestens <b>${ziel} %</b> der Raubzugsquote ` +
        `(Modus: ${heute ? 'tagesaktuell' : 'Rekordwert (Tagesbester)'}).` + (hinweisHtml ? '<br>' + hinweisHtml : '');
    q('#rz-diag').value = diagText();
    const cols = heute ? SPALTEN : [...SPALTEN, { k: 'datum', t: 'Raubzug-Rekord am' }];
    let h = '<table class="rz-tab"><thead><tr><th>#</th>' +
      cols.map((c) => `<th data-k="${c.k}" style="cursor:pointer">${c.t}${sort.k === c.k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead><tbody>';
    rows.forEach((r, i) => {
      const cls = klasse(r, ziel);
      h += `<tr class="${cls}"><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.tag)}</td>` +
        `<td class="n">${fmt(r.punkte)}</td><td class="n">${fmt(r.doerfer)}</td>` +
        `<td class="n">${fmt(r.raubzug)}</td>` +
        `<td class="n">${fmt(r.soll)}</td><td class="n"><b>${r.quote == null ? '–' : r.quote.toFixed(0) + ' %'}</b></td>` +
        (heute ? '' : `<td>${esc(r.datum || '–')}</td>`) + '</tr>';
    });
    q('#rz-table').innerHTML = h + '</tbody></table>';
    q('#rz-table').querySelectorAll('th[data-k]').forEach((th) => {
      th.onclick = () => { const k = th.dataset.k; sort = { k, dir: sort.k === k ? -sort.dir : (k === 'name' || k === 'tag' ? 1 : -1) }; renderTabelle(); };
    });
  }

  function diagText() {
    return (ergebnis.eichText || '') + '\n' + (ergebnis.diag || []).map((d) => {
      const kopf = `${d.label} (mode=${d.mode}, type=${d.type}): ${d.seiten.length} Seite(n), ${d.gesamt} Spieler, höchster Rang ${d.hoechsterRang}, ` +
        `Treffer im Stamm ${d.treffer}/${d.mitglieder}, Parameter: ${d.param || 'keiner'}`;
      const z = (x) => `  ${x.url} -> Zeilen ${x.zeilen}, neu ${x.neu}, Ränge ${x.rang}`;
      const sp = d.seiten.length > 14 ? [...d.seiten.slice(0, 8), null, ...d.seiten.slice(-4)] : d.seiten;
      return kopf + '\n' + sp.map((x) => (x ? z(x) : '  …')).join('\n');
    }).join('\n');
  }

  function bbCode() {
    const ziel = +q('#rz-ziel').value;
    const heute = ergebnis.modus === 'heute';
    const rows = sortiert();
    let t = `[b]Raubzug-Auswertung Welt ${gd.world}[/b] – ${heute ? 'tagesaktuell' : 'Rekordwerte (Tagesbester)'}, Zielquote ${ziel} %\n`;
    t += '[table]\n[**]#[||]Spieler[||]Stamm[||]Punkte[||]Raubzüge[||]Soll[||]Quote[||]Rekord am[/**]\n';
    rows.forEach((r, i) => {
      const c = farbe[klasse(r, ziel)];
      const alt = alterInTagen(r.datum);
      const dc = alt == null ? farbe[''] : alt > 14 ? farbe['rz-bad'] : alt > 7 ? farbe['rz-mid'] : farbe['rz-ok'];   // gleiche Farben wie die Quote: grün bis 7 Tage, gelb/orange über 7, rot über 14
      t += `[*]${i + 1}[|][player]${r.name}[/player][|]${r.tag}[|]${fmt(r.punkte)}[|]${fmt(r.raubzug)}[|]${fmt(r.soll)}[|][color=${c}][b]${r.quote == null ? '–' : r.quote.toFixed(0) + ' %'}[/b][/color][|][color=${dc}]${datumAbs(r.datum)}[/color]\n`;
    });
    return t + '[/table]';
  }

  function csv() {
    const heute = ergebnis.modus === 'heute';
    const z = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const nz = (v) => (v == null ? '' : String(Math.round(v)));
    const kopf = ['Rang', 'Spieler', 'Stamm', 'Punkte', 'Doerfer', 'Raubzuege', 'Soll_Raubzug', 'Quote_Prozent'];
    if (!heute) kopf.push('Raubzug_Rekord_am');
    const lines = [kopf.map(z).join(';')];
    sortiert().forEach((r, i) => {
      const l = [i + 1, r.name, r.tag, nz(r.punkte), nz(r.doerfer), nz(r.raubzug), nz(r.soll), r.quote == null ? '' : r.quote.toFixed(1).replace('.', ',')];
      if (!heute) l.push(datumAbs(r.datum));
      lines.push(l.map(z).join(';'));
    });
    return '\ufeff' + lines.join('\r\n');
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function kopieren(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    const ta = q('#rz-bb'); ta.select(); document.execCommand('copy');
  }

  function setStatus(t, fehler) {
    const el = q('#rz-status');
    el.textContent = t; el.style.color = fehler ? '#c62828' : '#000';
  }

  // ---------------------------------------------------------------- Fenster
  function bauen() {
    if (document.getElementById('rz-box')) return;
    const style = document.createElement('style');
    style.textContent = `
      #rz-box{position:fixed;top:4vh;left:50%;transform:translateX(-50%);width:min(1100px,96vw);max-height:92vh;overflow:auto;z-index:99999;background:#f4e4bc;border:2px solid #7d510f;padding:12px;font-size:12px;color:#000;box-shadow:0 4px 20px rgba(0,0,0,.5)}
      #rz-box h3{margin:0 0 8px}
      #rz-box .rz-close{position:absolute;right:8px;top:6px;cursor:pointer;font-size:18px;font-weight:bold}
      #rz-box label{margin-right:12px}
      #rz-box textarea{width:100%;box-sizing:border-box}
      #rz-box .rz-tab{border-collapse:collapse;width:100%}
      #rz-box .rz-tab th{background:#c1a264;padding:3px 6px;text-align:left;white-space:nowrap}
      #rz-box .rz-tab td{padding:2px 6px;border-bottom:1px solid #d8c18a}
      #rz-box .rz-tab td.n{text-align:right}
      #rz-box .rz-ok td{background:#d9efd6}#rz-box .rz-mid td{background:#fbe8b8}#rz-box .rz-bad td{background:#f2cccc}
      #rz-box button{margin:4px 6px 4px 0;cursor:pointer}
      #rz-table{max-height:55vh;overflow:auto;margin-top:6px}
    `;
    document.head.appendChild(style);
    const zielOpt = []; for (let p = 100; p >= 10; p -= 5) zielOpt.push(`<option value="${p}"${p === 70 ? ' selected' : ''}>${p} %</option>`);
    const box = document.createElement('div');
    box.id = 'rz-box';
    box.innerHTML = `
      <span class="rz-close" title="Schließen">×</span>
      <h3>Raubzug-Auswertung – Welt ${esc(gd.world)}</h3>
      <div id="rz-setup">
        <p><b>1. Wert wählen</b><br>
          <label><input type="radio" name="rz-modus" value="rekord" checked> Maximalwert (Tagesrekord aus der Rangliste)</label><br>
          <label><input type="radio" name="rz-modus" value="heute"> Tagesaktuell (0 Uhr bis jetzt; exakt nur für Spieler mit Rekord von heute)</label></p>
        <p><b>2. Stamm-Tags</b> (einer pro Zeile oder mit Komma getrennt)<br>
          <textarea id="rz-tags" rows="3" placeholder="z. B. ABC, XYZ"></textarea></p>
        <p><b>3. Zielquote</b> (ab diesem Wert gilt ein Spieler als zufriedenstellend)
          <select id="rz-ziel-setup">${zielOpt.join('')}</select></p>
        <p><b>4. Messlatte</b> (was 100 % bedeutet)<br>
          <label><input type="radio" name="rz-latte" value="welt" checked> Welt-Eichung: Median der Top 100 der Rekordliste = ${CFG.eichZiel} % (höchstens alle ${CFG.eichTage} Tage neu berechnet)</label><br>
          <label><input type="radio" name="rz-latte" value="fest"> Feste Formel</label><br>
          <label><input type="checkbox" id="rz-neueichen"> Eichung jetzt neu berechnen</label></p>
        <button id="rz-start">Auswerten</button>
        <div id="rz-status" style="margin-top:6px"></div>
      </div>
      <div id="rz-result" style="display:none">
        <div>Zielquote: <select id="rz-ziel">${zielOpt.join('')}</select>
          <button id="rz-bbbtn">BB-Code</button><button id="rz-csvbtn">CSV herunterladen</button><button id="rz-neu">Neue Auswertung</button></div>
        <div id="rz-summary" style="margin:6px 0"></div>
        <div id="rz-bbwrap" style="display:none"><textarea id="rz-bb" rows="8" readonly></textarea><button id="rz-copy">In Zwischenablage kopieren</button></div>
        <div id="rz-table"></div>
        <details style="margin-top:8px"><summary>Diagnose (bei Problemen kopieren und mir schicken)</summary><textarea id="rz-diag" rows="9" readonly></textarea></details>
        <p style="margin:8px 0 0;color:#555">Quote = Raubzug-Beute ÷ Soll. Das Soll (100 %) pro Dorf = C × (1 − e^(−Punkte pro Dorf ÷ ${CFG.sollP0})), mal Dörferzahl. Bei der Welt-Eichung ist C so gewählt, dass der Median der Top 100 (Rekorde der letzten ${CFG.eichMaxAlter} Tage) ${CFG.eichZiel} % ergibt. Bei „tagesaktuell“ wird das Soll auf die seit 0 Uhr vergangene Zeit umgerechnet.</p>
      </div>`;
    document.body.appendChild(box);
    q('.rz-close').onclick = () => (box.style.display = 'none');
    q('#rz-start').onclick = () => { q('#rz-ziel').value = q('#rz-ziel-setup').value; starten(); };
    q('#rz-ziel').onchange = renderTabelle;
    q('#rz-bbbtn').onclick = () => {
      const w = q('#rz-bbwrap'); w.style.display = 'block'; q('#rz-bb').value = bbCode();
    };
    q('#rz-copy').onclick = () => { kopieren(q('#rz-bb').value); };
    q('#rz-csvbtn').onclick = () => download(`raubzug_${gd.world}_${ergebnis.modus}_${new Date().toISOString().slice(0, 10)}.csv`, csv());
    q('#rz-neu').onclick = () => { q('#rz-result').style.display = 'none'; q('#rz-setup').style.display = 'block'; q('#rz-status').textContent = ''; };
  }

  function open() { bauen(); document.getElementById('rz-box').style.display = 'block'; }

  window.__rzAuswertung = { open };

  if (USERSCRIPT_MODE) {
    const b = document.createElement('button');
    b.textContent = 'Raubzug-Auswertung';
    b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99998;cursor:pointer';
    b.onclick = open;
    document.body.appendChild(b);
  } else {
    open();
  }
})();
