// ==UserScript==
// @name         Raubzug-Auswertung (Die Stämme)
// @namespace    die-staemme-raubzug-auswertung
// @version      1.0.0
// @description  Wertet erbeutete Rohstoffe (Plündern & Raubzüge) pro Stamm aus der Rangliste aus, inkl. Raubzugsquote, BB-Code und CSV
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
    maxSeiten: 150,    // Sicherheitsgrenze pro Rangliste
    historieTage: 3,   // so lange werden Messpunkte für "tagesaktuell" gespeichert
    // Ranglisten-Typen (falls die Welt andere Namen nutzt, hier anpassen):
    typPlundern: 'loot_res',  // Rohstoffe durch Farmen von Dörfern
    typRaubzug: 'scavenge',   // Rohstoffe durch Raubzüge
    // Soll-Modell für Raubzüge (siehe sollProTag):
    sollMax: 45000,    // max. sinnvolle Raubzug-Beute pro Dorf und Tag bei sehr großen Dörfern
    sollP0: 3500,      // Dorfpunkte, ab denen das Dorf "gut" ausgelastet ist
    sollFaktor: 1,     // globaler Faktor, z. B. 1.2 bei schnelleren Welten
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
  const NUM = /^\d{1,3}(\.\d{3})*$/;
  const q = (sel) => document.querySelector('#rz-box ' + sel);

  // ---------------------------------------------------------------- Soll-Modell
  // Idee: Truppen-Bevölkerung ~ 0,6 x Dorfpunkte, davon ~40 % für Raubzüge nutzbar,
  // ~20 Beute pro Einwohner, im Schnitt ~1,75 Kapazitäten pro Tag => ca. 8 x Dorfpunkte.
  // Weil Raubzüge zeitlich begrenzt sind, wird das mit einer Sättigungskurve gedeckelt:
  //   Soll/Dorf/Tag = sollMax * (1 - exp(-Punkte pro Dorf / sollP0))
  //   1.000-Punkte-Dorf ~ 11.000, 4.000-Punkte-Dorf ~ 31.000, 10.000er ~ 42.000
  function sollProTag(punkte, doerfer) {
    if (!doerfer || !punkte) return 0;
    const pd = punkte / doerfer;
    return doerfer * CFG.sollMax * (1 - Math.exp(-pd / CFG.sollP0)) * CFG.sollFaktor;
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

  function parseRangliste(html, mode, type) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [];
    doc.querySelectorAll('tr').forEach((tr) => {
      const a = tr.querySelector('a[href*="screen=info_player"]');
      if (!a) return;
      const m = (a.getAttribute('href') || '').match(/[?&]id=(\d+)/);
      if (!m) return;
      const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s/g, ''));
      let wert = null;
      for (let i = cells.length - 1; i >= 0; i--) {
        if (NUM.test(cells[i])) { wert = parseInt(cells[i].replace(/\./g, ''), 10); break; }
      }
      if (wert != null) rows.push({ id: m[1], wert });
    });
    const links = [];
    doc.querySelectorAll('a[href*="screen=ranking"]').forEach((a) => {
      const h = a.getAttribute('href') || '';
      if (!h.includes('mode=' + mode) || !h.includes('type=' + type)) return;
      const fm = h.match(/[?&]from=(\d+)/);
      if (!fm) return;
      links.push({ key: +fm[1], url: new URL(h.replace(/&amp;/g, '&'), location.href).href });
    });
    return { rows, links };
  }

  async function ladeRangliste(mode, type, label, fortschritt) {
    const basis = `${location.origin}/game.php?village=${gd.village.id}&screen=ranking&mode=${mode}&type=${type}`;
    const werte = new Map();
    const queue = [{ key: 0, url: basis }];
    const gesehen = new Set([0]);
    let n = 0, pager = false, schritt = 0;
    while (queue.length && n < CFG.maxSeiten) {
      queue.sort((a, b) => a.key - b.key);
      const { key, url } = queue.shift();
      const html = await holeText(url);
      n++;
      const { rows, links } = parseRangliste(html, mode, type);
      if (n === 1) {
        if (!rows.length) throw new Error(`Keine Ranglisten-Zeilen erkannt (${label}). URL: ${url}`);
        schritt = rows.length;
      }
      rows.forEach((r) => { if (!werte.has(r.id) || werte.get(r.id) < r.wert) werte.set(r.id, r.wert); });
      links.forEach((l) => { pager = true; if (!gesehen.has(l.key)) { gesehen.add(l.key); queue.push(l); } });
      if (!pager && schritt > 0 && rows.length >= schritt) {
        const nk = key + schritt;
        if (!gesehen.has(nk)) { gesehen.add(nk); queue.push({ key: nk, url: basis + '&from=' + nk }); }
      }
      fortschritt(`${label}: Seite ${n} geladen (${werte.size} Spieler)…`);
      await sleep(CFG.pauseMs);
    }
    return werte;
  }

  // ---------------------------------------------------------------- Verlauf (für "tagesaktuell")
  const HKEY = 'rz_hist_' + gd.world;
  function ladeHist() { try { return JSON.parse(localStorage.getItem(HKEY)) || {}; } catch (e) { return {}; } }
  function speichereHist(h) { try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch (e) { /* ignorieren */ } }

  function basisFuer(h, pid, jetzt) {
    const list = h[pid] || [];
    const mid = new Date(jetzt); mid.setHours(0, 0, 0, 0);
    const heute = list.filter((e) => e.t >= mid.getTime());
    if (heute.length) return { e: heute[0], genau: true };
    const frueher = list.filter((e) => e.t < mid.getTime());
    if (frueher.length) return { e: frueher[frueher.length - 1], genau: false };
    return null;
  }

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

      const rm = modus === 'rekord' ? 'in_a_day' : 'kill_player';
      const plund = await ladeRangliste(rm, CFG.typPlundern, 'Plündern', setStatus);
      const raub = await ladeRangliste(rm, CFG.typRaubzug, 'Raubzüge', setStatus);

      const jetzt = Date.now();
      const hist = ladeHist();
      const rows = members.map((p) => {
        const l = plund.get(p.id) || 0;
        const s = raub.get(p.id) || 0;
        const sollTag = sollProTag(p.punkte, p.doerfer);
        const r = { id: p.id, name: p.name, tag: tagVon[p.ally], punkte: p.punkte, doerfer: p.doerfer, plunder: l, raubzug: s, gesamt: l + s, soll: sollTag, quote: null, seit: null };
        if (modus === 'heute') {
          const b = basisFuer(hist, p.id, jetzt);
          if (b) {
            r.plunder = Math.max(0, l - b.e.l);
            r.raubzug = Math.max(0, s - b.e.s);
            r.gesamt = r.plunder + r.raubzug;
            const std = Math.max((jetzt - b.e.t) / 3600000, 0.25);
            r.soll = sollTag * std / 24;
            r.seit = new Date(b.e.t);
            r.ungenau = !b.genau;
          } else {
            r.plunder = null; r.raubzug = null; r.gesamt = null; r.soll = null;
          }
        }
        r.quote = r.soll > 0 && r.raubzug != null ? (r.raubzug / r.soll) * 100 : null;
        return r;
      });

      if (modus === 'heute') {
        // Messpunkt speichern (höchstens alle 10 Minuten je Spieler), alte Einträge entfernen
        const grenze = jetzt - CFG.historieTage * 86400000;
        members.forEach((p) => {
          const list = (hist[p.id] || []).filter((e) => e.t >= grenze);
          if (!list.length || jetzt - list[list.length - 1].t > 600000) list.push({ t: jetzt, l: plund.get(p.id) || 0, s: raub.get(p.id) || 0 });
          hist[p.id] = list;
        });
        speichereHist(hist);
        const ohne = rows.filter((r) => r.raubzug == null).length;
        if (ohne === rows.length) hinweise.push('Erste Messung gespeichert. Starte das Skript später erneut – dann siehst du den Zuwachs seit dieser Messung. Am genauesten wird es, wenn du es einmal früh am Tag (kurz nach 0 Uhr) laufen lässt.');
        else if (ohne) hinweise.push(`${ohne} Spieler hatten noch keine Basis-Messung (Anzeige "–").`);
        if (rows.some((r) => r.ungenau)) hinweise.push('Bei Spielern mit Basis von gestern ist der Zeitraum länger als seit 0 Uhr (siehe Spalte "Seit").');
      }
      ergebnis = { rows, modus, hinweise };
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
    { k: 'plunder', t: 'Plündern (Dörfer)', n: 1 }, { k: 'raubzug', t: 'Raubzüge', n: 1 },
    { k: 'gesamt', t: 'Gesamt', n: 1 }, { k: 'soll', t: 'Soll Raubzug', n: 1 },
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
    q('#rz-summary').innerHTML =
      `<b>${ok} von ${bewertet}</b> Spielern erreichen mindestens <b>${ziel} %</b> der Raubzugsquote ` +
      `(Modus: ${heute ? 'tagesaktuell' : 'Rekordwert (Tagesbester)'}).` +
      (ergebnis.hinweise.length ? '<br><span style="color:#8a5a00">' + ergebnis.hinweise.map(esc).join('<br>') + '</span>' : '');
    const cols = heute ? [...SPALTEN, { k: 'seit', t: 'Seit' }] : SPALTEN;
    let h = '<table class="rz-tab"><thead><tr><th>#</th>' +
      cols.map((c) => `<th data-k="${c.k}" style="cursor:pointer">${c.t}${sort.k === c.k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead><tbody>';
    rows.forEach((r, i) => {
      const cls = klasse(r, ziel);
      h += `<tr class="${cls}"><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.tag)}</td>` +
        `<td class="n">${fmt(r.punkte)}</td><td class="n">${fmt(r.doerfer)}</td>` +
        `<td class="n">${fmt(r.plunder)}</td><td class="n">${fmt(r.raubzug)}</td><td class="n">${fmt(r.gesamt)}</td>` +
        `<td class="n">${fmt(r.soll)}</td><td class="n"><b>${r.quote == null ? '–' : r.quote.toFixed(0) + ' %'}</b></td>` +
        (heute ? `<td>${r.seit ? r.seit.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'}</td>` : '') + '</tr>';
    });
    q('#rz-table').innerHTML = h + '</tbody></table>';
    q('#rz-table').querySelectorAll('th[data-k]').forEach((th) => {
      th.onclick = () => { const k = th.dataset.k; sort = { k, dir: sort.k === k ? -sort.dir : (k === 'name' || k === 'tag' ? 1 : -1) }; renderTabelle(); };
    });
  }

  function bbCode() {
    const ziel = +q('#rz-ziel').value;
    const heute = ergebnis.modus === 'heute';
    const rows = sortiert();
    let t = `[b]Raubzug-Auswertung Welt ${gd.world}[/b] – ${heute ? 'tagesaktuell' : 'Rekordwerte (Tagesbester)'}, Zielquote ${ziel} %\n`;
    t += '[table]\n[**]#[||]Spieler[||]Stamm[||]Dörfer[||]Plündern[||]Raubzüge[||]Soll[||]Quote[/**]\n';
    rows.forEach((r, i) => {
      const c = farbe[klasse(r, ziel)];
      t += `[*]${i + 1}[|][player]${r.name}[/player][|]${r.tag}[|]${fmt(r.doerfer)}[|]${fmt(r.plunder)}[|]${fmt(r.raubzug)}[|]${fmt(r.soll)}[|][color=${c}][b]${r.quote == null ? '–' : r.quote.toFixed(0) + ' %'}[/b][/color]\n`;
    });
    return t + '[/table]';
  }

  function csv() {
    const heute = ergebnis.modus === 'heute';
    const z = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const nz = (v) => (v == null ? '' : String(Math.round(v)));
    const kopf = ['Rang', 'Spieler', 'Stamm', 'Punkte', 'Doerfer', 'Plundern', 'Raubzuege', 'Gesamt', 'Soll_Raubzug', 'Quote_Prozent'];
    if (heute) kopf.push('Seit');
    const lines = [kopf.map(z).join(';')];
    sortiert().forEach((r, i) => {
      const l = [i + 1, r.name, r.tag, nz(r.punkte), nz(r.doerfer), nz(r.plunder), nz(r.raubzug), nz(r.gesamt), nz(r.soll), r.quote == null ? '' : r.quote.toFixed(1).replace('.', ',')];
      if (heute) l.push(r.seit ? r.seit.toLocaleString('de-DE') : '');
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
          <label><input type="radio" name="rz-modus" value="heute"> Tagesaktuell (Zuwachs seit 0 Uhr bzw. seit der ersten gespeicherten Messung)</label></p>
        <p><b>2. Stamm-Tags</b> (einer pro Zeile oder mit Komma getrennt)<br>
          <textarea id="rz-tags" rows="3" placeholder="z. B. ABC, XYZ"></textarea></p>
        <p><b>3. Zielquote</b> (ab diesem Wert gilt ein Spieler als zufriedenstellend)
          <select id="rz-ziel-setup">${zielOpt.join('')}</select></p>
        <button id="rz-start">Auswerten</button>
        <div id="rz-status" style="margin-top:6px"></div>
      </div>
      <div id="rz-result" style="display:none">
        <div>Zielquote: <select id="rz-ziel">${zielOpt.join('')}</select>
          <button id="rz-bbbtn">BB-Code</button><button id="rz-csvbtn">CSV herunterladen</button><button id="rz-neu">Neue Auswertung</button></div>
        <div id="rz-summary" style="margin:6px 0"></div>
        <div id="rz-bbwrap" style="display:none"><textarea id="rz-bb" rows="8" readonly></textarea><button id="rz-copy">In Zwischenablage kopieren</button></div>
        <div id="rz-table"></div>
        <p style="margin:8px 0 0;color:#555">Quote = Raubzug-Beute ÷ Soll. Das Soll (100 %) wird aus Dörferzahl und Punkten pro Dorf geschätzt (Sättigungsmodell); bei „tagesaktuell“ wird es auf den gemessenen Zeitraum umgerechnet.</p>
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
