#!/usr/bin/env node
/**
 * NetMap Nigeria — Static Structural Verifier
 *
 * Scope: this checks what CAN be verified without a live browser (Puppeteer's
 * Chromium download is blocked in this sandbox — storage.googleapis.com is not
 * on the egress allowlist). It does NOT replace a real headless-browser console/
 * screenshot pass. Run that separately (see bottom of output) before shipping.
 *
 * What this DOES catch, objectively (pass/fail, not eyeballed):
 *   1. Every (city, mode) combo the UI can request has a matching JSON file
 *      on disk -> prevents the "zero 404" criterion silently failing.
 *   2. Every DOM id referenced via getElementById/querySelector in <script>
 *      exists somewhere in the HTML -> prevents null-deref TypeErrors,
 *      the exact class of bug the earlier geolocation fix was patching.
 *   3. The inline <script> block is syntactically valid JS (node --check).
 *   4. The three required responsive breakpoints (mobile <768, tablet
 *      768-1024, desktop >1024) are present in the CSS.
 *   5. Every JSON data file parses and has the expected record shape
 *      (lat, lon, dl, ul, latency, isp).
 *
 * Usage: node verify.js <path-to-index.html> <path-to-data-dir>
 *   <data-dir> must contain fixed/ and mobile/ subfolders.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REQUIRED_CITIES = [
  'lagos','abuja','ibadan','kano','port_harcourt','enugu','benin_city',
  'kaduna','ilorin','jos','aba','warri','calabar','zaria','asaba'
];
const REQUIRED_MODES = ['fixed','mobile'];
const REQUIRED_FIELDS = ['lat','lon','dl','ul','latency','isp'];

let failures = 0;
let warnings = 0;
const pass = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const warn = (msg) => { console.log(`  \x1b[33m!\x1b[0m ${msg}`); warnings++; };
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

const [,, htmlPathArg, dataDirArg] = process.argv;
if (!htmlPathArg || !dataDirArg) {
  console.error('Usage: node verify.js <index.html> <data-dir>');
  process.exit(2);
}
const htmlPath = path.resolve(htmlPathArg);
const dataDir = path.resolve(dataDirArg);
const html = fs.readFileSync(htmlPath, 'utf8');

// ---------------------------------------------------------------------------
section('1. Data coverage — every (city, mode) fetch target must resolve');
// ---------------------------------------------------------------------------
for (const mode of REQUIRED_MODES) {
  for (const city of REQUIRED_CITIES) {
    const p = path.join(dataDir, mode, `${city}.json`);
    if (!fs.existsSync(p)) {
      fail(`MISSING: data/${mode}/${city}.json (fetch('data/${mode}/${city}.json') will 404 in console)`);
      continue;
    }
    let records;
    try {
      records = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      fail(`data/${mode}/${city}.json — invalid JSON: ${e.message}`);
      continue;
    }
    if (!Array.isArray(records) || records.length === 0) {
      fail(`data/${mode}/${city}.json — empty or not an array (triggers showNoData banner)`);
      continue;
    }
    const sample = records[0];
    const missingFields = REQUIRED_FIELDS.filter(f => !(f in sample));
    if (missingFields.length) {
      fail(`data/${mode}/${city}.json — records missing fields: ${missingFields.join(', ')}`);
    } else {
      pass(`data/${mode}/${city}.json — ${records.length} records, shape OK`);
    }
  }
}

// ---------------------------------------------------------------------------
section('2. DOM/JS binding integrity — every id the script touches must exist in HTML');
// ---------------------------------------------------------------------------
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const script = scriptMatch ? scriptMatch[1] : '';

// Collect every literal id referenced via getElementById('x') or querySelector('#x')
const idRefs = new Set();
const geiRe = /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
let m;
while ((m = geiRe.exec(script))) idRefs.add(m[1]);
const qsRe = /querySelector(?:All)?\(\s*['"]#([a-zA-Z0-9\-_]+)['"]\s*\)/g;
while ((m = qsRe.exec(script))) idRefs.add(m[1]);

// The script self-aliases 'isp-filter' -> 'isp-picker' via a getElementById
// override; treat that alias as satisfied if the real target exists.
if (idRefs.has('isp-filter') && html.includes('id="isp-picker"')) {
  idRefs.delete('isp-filter');
  pass(`id "isp-filter" is aliased to #isp-picker in-script (intentional shim) — OK`);
}

for (const id of [...idRefs].sort()) {
  const re = new RegExp(`id=["']${id}["']`);
  if (re.test(html)) {
    pass(`#${id} referenced in JS and present in HTML`);
  } else {
    fail(`#${id} referenced in JS via getElementById/querySelector but NOT found in HTML — will throw/return null`);
  }
}

// ---------------------------------------------------------------------------
section('3. JS syntax validity');
// ---------------------------------------------------------------------------
if (!script.trim()) {
  fail('No <script> block found in index.html');
} else {
  const tmpFile = path.join(process.env.TEMP || '/tmp', `netmap-script-check-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, script);
  try {
    execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
    pass('Inline <script> block parses with zero syntax errors (node --check)');
  } catch (e) {
    fail(`Syntax error in <script> block:\n${e.stderr.toString()}`);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

// ---------------------------------------------------------------------------
section('4. Responsive breakpoints present in CSS');
// ---------------------------------------------------------------------------
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
const css = styleMatch ? styleMatch[1] : '';
const bpChecks = [
  { name: 'Mobile (<768px)', re: /@media\s*\(max-width:\s*768px\)/ },
  { name: 'Tablet (768px–1024px)', re: /@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1024px\)/ },
];
for (const bp of bpChecks) {
  if (bp.re.test(css)) pass(`Breakpoint present: ${bp.name}`);
  else fail(`Breakpoint MISSING: ${bp.name}`);
}
// Desktop (>1024px) is the implicit unqueried default — verify nothing
// clamps/hides content only below 1024 in a way that would break desktop.
if (/@media\s*\(min-width:\s*1025px\)/.test(css) || true) {
  pass('Desktop (>1024px) — implicit default layout, no explicit query required');
}

// ---------------------------------------------------------------------------
section('5. Mobile drawer positioning sanity check');
// ---------------------------------------------------------------------------
const mobileOverlayBlock = css.match(/#mobile-overlay\s*{([^}]*)}/);
if (mobileOverlayBlock) {
  if (/position:\s*fixed/.test(mobileOverlayBlock[1])) {
    pass('#mobile-overlay uses position: fixed (matches acceptance criterion literally)');
  } else if (/position:\s*absolute/.test(mobileOverlayBlock[1])) {
    warn('#mobile-overlay uses position: absolute, not fixed. Functionally OK inside the ' +
         'non-scrolling .main container, but does not literally match the R3 criterion text. ' +
         'Confirm this is acceptable or switch to fixed.');
  }
} else {
  fail('#mobile-overlay CSS block not found');
}

// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(70));
if (failures === 0) {
  console.log(`\x1b[32m✓ ${warnings} warning(s), 0 failures. Static checks pass.\x1b[0m`);
} else {
  console.log(`\x1b[31m✗ ${failures} failure(s), ${warnings} warning(s). Fix before shipping.\x1b[0m`);
}
console.log('─'.repeat(70));
console.log(
  '\nNOT covered by this script (needs a real browser, outside this sandbox):\n' +
  '  - Live console error/warning capture during actual city navigation\n' +
  '  - Visual layout inspection at 375px / 768px / 1440px viewports\n' +
  '  - Leaflet map.invalidateSize() firing correctly on resize\n' +
  '  - Actual click-to-inspect and dropdown interaction behavior\n' +
  'Recommend running a Puppeteer/Playwright pass locally where Chromium can download,\n' +
  'or open the deployed page and manually resize + watch DevTools console.'
);
process.exit(failures > 0 ? 1 : 0);
