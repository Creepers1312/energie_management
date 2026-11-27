"use strict";
// Schlichter PDF-Bericht ohne externe Bibliothek: A4 quer, Helvetica (Standardschrift jedes PDF-Programms,
// WinAnsi-Zeichensatz mit Umlauten und €), Titel, Kopfangaben und Tabellen mit Seitenumbruch und wiederholter
// Kopfzeile. Zu breite Tabellen werden kleiner gesetzt, zu lange Zellen gekürzt.
const W = 842, H = 595, M = 36;
// Zeichenbreiten Helvetica (1/1000 em) für ASCII 32–126
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
// Unicode → WinAnsi (Byte) für Zeichen außerhalb von ASCII, mit Breite
const WIN = { "€": [0x80, 556], "‚": [0x82, 222], "„": [0x84, 333], "…": [0x85, 1000], "‘": [0x91, 222], "’": [0x92, 222], "“": [0x93, 333], "”": [0x94, 333],
  "•": [0x95, 350], "–": [0x96, 556], "—": [0x97, 1000], "°": [0xB0, 400], "²": [0xB2, 333], "³": [0xB3, 333], "·": [0xB7, 278], "×": [0xD7, 584],
  "Ä": [0xC4, 667], "Ö": [0xD6, 778], "Ü": [0xDC, 722], "ß": [0xDF, 611], "ä": [0xE4, 556], "ö": [0xF6, 556], "ü": [0xFC, 556], "é": [0xE9, 556], "è": [0xE8, 556], "à": [0xE0, 556], " ": [0x20, 278] };
function width(text, size, bold) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? HW[c - 32] : WIN[ch] ? WIN[ch][1] : 556;
  }
  return w * size / 1000 * (bold ? 1.06 : 1);
}
function encode(text) {
  const out = [];
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c <= 126) { if (ch === "(" || ch === ")" || ch === "\\") out.push(0x5C); out.push(c); }
    else if (WIN[ch]) out.push(WIN[ch][0]);
    else out.push(0x3F);
  }
  return Buffer.from(out).toString("latin1");
}
function fit(text, max, size, bold) {
  text = String(text == null ? "" : text);
  if (width(text, size, bold) <= max) return text;
  while (text.length > 1 && width(text + "…", size, bold) > max) text = text.slice(0, -1);
  return text + "…";
}

// doc: { title, meta: [[k, v]], sections: [{ title, cols, num: [bool], rows: [[...]] , note }], foot }
function build(doc, fmtCell) {
  const pages = [];
  let ops = null, y = 0;
  const newPage = () => { ops = []; pages.push(ops); y = H - M; };
  const text = (x, yy, s, size, bold, color) => {
    ops.push(`BT ${color || "0.07 0.07 0.07"} rg /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${encode(s)}) Tj ET`);
  };
  const line = (x1, yy, x2, gray) => ops.push(`${gray || 0.8} G 0.5 w ${x1.toFixed(1)} ${yy.toFixed(1)} m ${x2.toFixed(1)} ${yy.toFixed(1)} l S`);
  const rect = (x, yy, w, h, gray) => ops.push(`${gray} g ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  newPage();
  text(M, y - 16, doc.title, 17, true); y -= 30;
  (doc.meta || []).forEach(([k, v]) => { text(M, y - 9, k, 8.5, true, "0.35 0.35 0.35"); text(M + 95, y - 9, fit(v, W - 2 * M - 95, 8.5), 8.5); y -= 12; });
  y -= 6;
  for (const s of doc.sections || []) {
    const cells = s.rows.map((r) => r.map((v, i) => fmtCell(v, s.num[i], s.cols[i])));
    // Schriftgröße so wählen, dass die Tabelle in die Breite passt
    let size = 8, colW;
    for (; size >= 5.5; size -= 0.5) {
      colW = s.cols.map((c, i) => Math.min(220, Math.max(width(c, size, true), ...cells.slice(0, 300).map((r) => width(r[i], size))) + 8));
      if (colW.reduce((a, b) => a + b, 0) <= W - 2 * M) break;
    }
    const total = colW.reduce((a, b) => a + b, 0);
    if (total > W - 2 * M) { const f = (W - 2 * M) / total; colW = colW.map((w) => w * f); }
    const rowH = size + 5.5;
    const head = () => {
      rect(M, y - rowH, colW.reduce((a, b) => a + b, 0), rowH, 0.94);
      let x = M;
      s.cols.forEach((c, i) => {
        const t = fit(c, colW[i] - 6, size, true);
        text(s.num[i] ? x + colW[i] - 3 - width(t, size, true) : x + 3, y - rowH + 3.8, t, size, true);
        x += colW[i];
      });
      y -= rowH;
    };
    if (y - 22 - rowH * 3 < M) newPage();
    text(M, y - 13, s.title, 11.5, true); y -= 20;
    head();
    if (!cells.length) { text(M + 3, y - rowH + 3.8, "Keine Einträge.", size, false, "0.4 0.4 0.4"); y -= rowH; }
    cells.forEach((r) => {
      if (y - rowH < M + 14) { newPage(); head(); }
      let x = M;
      r.forEach((v, i) => {
        const t = fit(v, colW[i] - 6, size);
        text(s.num[i] ? x + colW[i] - 3 - width(t, size) : x + 3, y - rowH + 3.8, t, size);
        x += colW[i];
      });
      y -= rowH;
      line(M, y, M + colW.reduce((a, b) => a + b, 0), 0.85);
    });
    if (s.note) { if (y - 14 < M) newPage(); text(M, y - 10, fit(s.note, W - 2 * M, 7.5), 7.5, false, "0.4 0.4 0.4"); y -= 14; }
    y -= 10;
  }
  // Fußzeile mit Seitenzahl
  pages.forEach((p, i) => {
    p.push(`BT 0.45 0.45 0.45 rg /F1 7.5 Tf ${M} 18 Td (${encode((doc.foot || "") + "  ·  Seite " + (i + 1) + " von " + pages.length)}) Tj ET`);
  });
  // PDF zusammensetzen
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = [];
  pages.forEach((p) => {
    const content = p.join("\n");
    const c = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info << /Title (${encode(doc.title)}) /Producer (Energie Management) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

module.exports = { build, width };
