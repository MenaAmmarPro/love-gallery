"use strict";

/*
 * love-gallery — dependency-free Node test harness.
 * Run: node test/harness.js
 *
 * Loads js/app.js in a fake-DOM sandbox and checks the pure logic exposed on
 * window.MenaGallery (month grouping/sorting, downscale maths, byte formatting,
 * metadata export/import). No IndexedDB/canvas needed for these.
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const store = {};

function fakeEl() {
  const node = {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    remove() {},
    innerHTML: "",
    textContent: "",
    value: ""
  };
  return node;
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  Intl,
  Promise,
  Number,
  String,
  Array,
  Object,
  RegExp,
  isFinite,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  },
  document: {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => fakeEl(),
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } }
  },
  navigator: { language: "en", clipboard: { writeText: async () => {} } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0)
};

sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const files = process.argv.slice(2);
for (const f of (files.length ? files : [path.join(__dirname, "..", "js", "app.js")])) {
  vm.runInContext(fs.readFileSync(f, "utf8"), sandbox, { filename: f });
}

const G = sandbox.window.MenaGallery;
let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL: " + msg);
  } else {
    console.log("ok - " + msg);
  }
}
function eq(actual, expected, msg) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), msg + " (got " + JSON.stringify(actual) + ")");
}

assert(!!G, "namespace MenaGallery exposed");

/* ---- normalise / clamp ---- */
eq(G.normalizeDate("2026-09-02"), "2026-09-02", "normalizeDate keeps a valid date");
eq(G.normalizeDate("2026-13-01"), "", "normalizeDate rejects a bad month");
eq(G.normalizeDate(""), "", "normalizeDate of empty is empty");
eq(G.clampCaption("  hello  "), "hello", "clampCaption trims");
eq(G.clampCaption("x".repeat(200)).length, 140, "clampCaption caps at 140");

/* ---- month keys + labels ---- */
eq(G.monthKey("2026-09-02"), "2026-09", "monthKey slices the month");
eq(G.monthKey(""), "", "monthKey of undated is empty");
eq(G.monthLabel("2026-09"), "September 2026", "monthLabel names the month");
eq(G.monthLabel(""), "Undated", "monthLabel handles undated");
eq(G.monthLabel("nope"), "Undated", "monthLabel handles junk");
eq(G.prettyDate("2026-09-02"), "2 September 2026", "prettyDate formats the day");
eq(G.prettyDate(""), "Undated", "prettyDate handles undated");

/* ---- sortPhotos: newest date first, undated last ---- */
const raw = [
  { id: "a", date: "2026-09-02", createdAt: 5 },
  { id: "b", date: "2026-09-20", createdAt: 9 },
  { id: "c", date: "2026-08-11", createdAt: 1 },
  { id: "d", date: "", createdAt: 2 }
];
eq(G.sortPhotos(raw).map((p) => p.id), ["b", "a", "c", "d"], "sortPhotos orders newest first, undated last");

/* ---- groupByMonth ---- */
const groups = G.groupByMonth(raw);
eq(groups.map((g) => g.key), ["2026-09", "2026-08", ""], "groupByMonth orders months newest first, Undated last");
eq(groups[0].label, "September 2026", "first group labelled September 2026");
eq(groups[0].photos.map((p) => p.id), ["b", "a"], "September holds newest first");
eq(groups[1].photos.map((p) => p.id), ["c"], "August holds its photo");
eq(groups[2].label, "Undated", "undated bucket labelled");
eq(G.groupByMonth([]).length, 0, "groupByMonth of nothing is empty");

/* ---- same-day tie broken by createdAt desc ---- */
const tie = [
  { id: "old", date: "2026-01-01", createdAt: 1 },
  { id: "new", date: "2026-01-01", createdAt: 2 }
];
eq(G.sortPhotos(tie).map((p) => p.id), ["new", "old"], "same-day photos tie-break on createdAt desc");

/* ---- scaledSize ---- */
eq(G.scaledSize(4000, 2000, 1600), { w: 1600, h: 800 }, "scaledSize shrinks the long edge");
eq(G.scaledSize(800, 600, 1600), { w: 800, h: 600 }, "scaledSize keeps small images");
eq(G.scaledSize(1000, 3000, 1500), { w: 500, h: 1500 }, "scaledSize handles portrait");
eq(G.scaledSize(0, 0, 1600), { w: 0, h: 0 }, "scaledSize handles a zero image");

/* ---- byte formatting ---- */
eq(G.formatBytes(0), "0 B", "formatBytes zero");
eq(G.formatBytes(1024), "1.0 KB", "formatBytes KB");
eq(G.formatBytes(1536), "1.5 KB", "formatBytes rounds KB");
eq(G.formatBytes(1048576), "1.0 MB", "formatBytes MB");
eq(G.formatBytes(60 * 1024 * 1024), "60 MB", "formatBytes big MB");
eq(G.totalBytes([{ bytes: 100 }, { bytes: 250 }]), 350, "totalBytes sums bytes");

/* ---- export / import metadata ---- */
const exported = G.exportMeta(raw, Date.UTC(2026, 8, 21));
eq(exported.app, "love-gallery", "exportMeta tags the app");
eq(exported.version, 1, "exportMeta has a version");
eq(exported.photos.map((p) => p.id), ["b", "a", "c", "d"], "exportMeta sorts photos");
assert(!("blob" in exported.photos[0]), "exportMeta never includes the image blob");

const existing = [{ id: "a", caption: "kept", date: "2026-09-02", createdAt: 5 }];
const imported = G.importMeta({ photos: [
  { id: "a", caption: "dupe" },
  { id: "z", caption: "new", date: "2026-01-05", bytes: 10 }
] }, existing);
eq(imported.added, 1, "importMeta adds one new caption");
eq(imported.skipped, 1, "importMeta skips a duplicate id");
eq(imported.photos.length, 2, "importMeta merges");
eq(imported.photos[1].caption, "new", "importMeta keeps the new caption");
eq(G.importMeta({ photos: [{ caption: "no id" }, null] }, []).added, 0, "importMeta ignores malformed rows");
eq(G.importMeta(null, []).added, 0, "importMeta survives a null payload");

/* ---- uid ---- */
assert(/^p[0-9a-z]+$/.test(G.uid()), "uid has the expected shape");
assert(G.uid() !== G.uid(), "uid values differ");

if (failures) {
  console.error("\n" + failures + " assertion(s) failed");
  process.exitCode = 1;
} else {
  console.log("\nall assertions passed");
}
