// Erzeugt die Bilder der Anwenderdoku (frontend/docs/*.webp) im lokalen Modus mit Testdaten.
// Aufruf aus dem Projektordner:  node tools/doku-screenshots.js
// Braucht Playwright (Chromium) und Python mit Pillow für die Umwandlung nach WebP.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'doku-')) + '/';
const W = 1440, H = 900;
(async () => {
  const b = await chromium.launch({ args: ['--lang=de-DE'] });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'de-DE' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const wait = (ms) => p.waitForTimeout(ms);
  const shot = async (name, opt = {}) => { await p.screenshot({ path: R + name + '.png', ...opt }); console.log('✓', name); };
  const box = async (sel, pad = 16) => { const r = await p.locator(sel).first().boundingBox(); return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(W, r.width + 2 * pad), height: r.height + 2 * pad }; };
  await p.goto('file://' + path.join(ROOT, 'frontend/index.html')); await wait(1200);
  await shot('anmeldung', { clip: await box('.login-card', 24) });
  await p.click('#modeToggle'); await p.fill('#lFull', 'Anna Admin'); await p.fill('#lName', 'anna');
  await p.fill('#lPass', 'geheim-12345'); await p.fill('#lPass2', 'geheim-12345'); await p.click('#loginSubmit'); await wait(1800);
  await p.mouse.move(W - 5, H - 5);
  await shot('kopfzeile', { clip: { x: 0, y: 0, width: W, height: 96 } });
  await shot('dashboard');
  await p.click('#dashMenuBtn'); await wait(400);
  { const r1 = await p.locator('#dashMenuBtn').boundingBox(), r2 = await p.locator('#dashMenu').boundingBox();
    const x = Math.min(r1.x, r2.x) - 24, y = r1.y - 20; await shot('dashboard-menue', { clip: { x, y, width: Math.max(r1.x + r1.width, r2.x + r2.width) - x + 24, height: r2.y + r2.height - y + 24 } }); }
  await p.click('#dashEditBtn'); await wait(400);
  await p.evaluate(() => scrollTo(0, document.querySelector('#dashToolbar').getBoundingClientRect().top + scrollY - 16)); await wait(300);
  await shot('dashboard-anpassen');
  await p.click('#dashAddBtn'); await wait(400); await shot('widget-hinzufuegen', { clip: await box('dialog[open]', 28) }); await p.keyboard.press('Escape'); await wait(200);
  await p.click('#dashEditDone'); await p.evaluate(() => scrollTo(0, 0));
  // Zähler
  await p.click('.tab[data-view="meters"]'); await wait(700); await shot('zaehler');
  await p.click('#mtViewSeg [data-view="tree"]'); await wait(500); await shot('zaehlerbaum');
  await p.click('#mtViewSeg [data-view="list"]'); await wait(400);
  await p.click('.me-more summary'); await p.click('.me-more-menu >> text=Zählerwechsel'); await wait(400); await shot('zaehlerwechsel', { clip: await box('dialog[open]', 28) });
  await p.keyboard.press('Escape'); await wait(200);
  // Ablesung mit Prüfliste (W-220: Stand kleiner als vorher)
  await p.click('.tab[data-view="readings"]'); await wait(700); await shot('ablesung');
  for (const r of await p.$$('#rdTable tbody tr')) if ((await r.innerText()).includes('W-220')) await (await r.$('.rd-input')).fill('5000');
  await p.click('#rdSave'); await wait(500); await shot('pruefliste', { clip: await box('dialog[open]', 28) });
  await p.keyboard.press('Escape'); await wait(200);
  // ILV
  await p.click('.tab[data-view="ilv"]'); await wait(500);
  await p.locator('#ilvTable tbody tr.trk-row').first().click(); await wait(400); await shot('ilv');
  await p.click('#ilvTabs [data-itab="rules"]'); await wait(400); await shot('regeln');
  await p.click('#ilvTabs [data-itab="prices"]'); await wait(400); await shot('preise');
  // Vorschau einer rückwirkenden Faktoränderung (wird nicht übernommen)
  await p.click('.tab[data-view="meters"]'); await wait(400);
  for (const r of await p.$$('#mtTable tbody tr')) if ((await r.innerText()).includes('E-110')) { await r.click(); break; }
  await wait(300); await p.click('.me-more summary'); await p.click('.me-more-menu >> text=Messfaktor / Überlauf'); await wait(300);
  await p.fill('#ppFactor', '1,05');
  const m3 = await p.evaluate(() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 7); });
  await p.fill('#ppFrom', m3); await p.click('#ppSave'); await wait(600);
  await shot('vorschau', { clip: await box('dialog[open]', 28) });
  await p.keyboard.press('Escape'); await wait(200);
  // Maßnahmen
  // Abrechnung, Auswertung, Berichte
  await p.click('.tab[data-view="billing"]'); await wait(600); await shot('abrechnung');
  await p.click('.tab[data-view="cc"]'); await wait(600); await shot('auswertung');
  await p.click('#cvTabs [data-ctab="reports"]'); await wait(600); await shot('berichte');
  await p.click('.tab[data-view="readings"]'); await wait(400); await p.click('#rdImportBtn'); await wait(300); await p.click('.im-opts summary'); await wait(200);
  await shot('import', { clip: await box('dialog[open]', 28) }); await p.keyboard.press('Escape'); await wait(200);
  await p.click('.tab[data-view="actions"]'); await wait(600); await shot('massnahmen');
  await p.locator('#kanban .kcard').first().click(); await wait(500); await shot('massnahme', { clip: await box('dialog[open]', 28) }); await p.keyboard.press('Escape'); await wait(200);
  // Tracking
  await p.click('.tab[data-view="tracking"]'); await wait(800); await shot('tracking');
  // Einstellungen
  await p.click('.tab[data-view="settings"]'); await wait(500);
  for (const [pane, name] of [['stamm', 'stammdaten'], ['users', 'benutzer'], ['mail', 'email'], ['online', 'online'], ['db', 'datenbank']]) {
    await p.click(`.side-item[data-spane="${pane}"]`); await wait(500); await shot(name);
  }
  // Zählerfenster: Reiter „Online-Anbindung“
  await p.click('.tab[data-view="meters"]'); await wait(600);
  await p.click('.me-actions >> text=Bearbeiten'); await wait(400);
  await p.click('#meterDialog .dtab[data-tab="onl"]'); await wait(300);
  await shot('online-zaehler', { clip: await box('dialog[open]', 28) });
  await p.keyboard.press('Escape'); await wait(200);
  console.log(errs.join('\n') || 'keine Seitenfehler');
  await b.close();
  // PNG → WebP (Qualität 80) nach frontend/docs/
  execFileSync('python3', ['-c', [
    'import sys, glob, os', 'from PIL import Image',
    'for f in glob.glob(os.path.join(sys.argv[1], "*.png")):',
    '    Image.open(f).convert("RGB").save(os.path.join(sys.argv[2], os.path.basename(f)[:-4] + ".webp"), "WEBP", quality=80, method=6)'
  ].join('\n'), R, path.join(ROOT, 'frontend/docs')], { stdio: 'inherit' });
  fs.rmSync(R, { recursive: true, force: true });
  console.log('Bilder aktualisiert: frontend/docs/');
})();
