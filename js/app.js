"use strict";

/*
 * love-gallery — page logic.
 *
 * "Our Gallery": a photo timeline grouped by month. Pictures are downscaled
 * on a canvas and kept in IndexedDB on this device; the captions and dates
 * live in localStorage. Nothing is ever uploaded anywhere.
 *
 * All the pure helpers are exposed on window.MenaGallery so they can be
 * exercised in a bare Node context (see test/harness.js).
 */

(function () {
  var META_KEY = "mena-gallery";
  var DB_NAME = "mena-gallery-db";
  var STORE = "photos";
  var MAX_DIM = 1600;          // longest edge of a stored photo
  var QUALITY = 0.82;          // jpeg quality
  var SOFT_BUDGET = 60 * 1024 * 1024; // meter fills around 60 MB

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  var state = { photos: [] };
  var staged = [];
  var dbPromise = null;
  var memStore = {};
  var thumbUrls = {};
  var lightboxIndex = -1;

  /* ======================= pure helpers ======================= */

  function uid() {
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function normalizeDate(value) {
    var s = String(value || "").trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return "";
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
    return m[1] + "-" + m[2] + "-" + m[3];
  }

  function monthKey(date) {
    var iso = normalizeDate(date);
    return iso ? iso.slice(0, 7) : "";
  }

  function monthLabel(key) {
    var parts = String(key || "").split("-");
    if (parts.length !== 2) return "Undated";
    var y = Number(parts[0]);
    var mo = Number(parts[1]);
    if (!y || mo < 1 || mo > 12) return "Undated";
    return MONTHS[mo - 1] + " " + y;
  }

  function prettyDate(iso) {
    var d = normalizeDate(iso);
    if (!d) return "Undated";
    var parts = d.split("-");
    return Number(parts[2]) + " " + MONTHS[Number(parts[1]) - 1] + " " + parts[0];
  }

  function clampCaption(text) {
    return String(text || "").trim().slice(0, 140);
  }

  function sortPhotos(photos) {
    return (photos || []).slice().sort(function (a, b) {
      var ad = normalizeDate(a && a.date);
      var bd = normalizeDate(b && b.date);
      if (ad && bd) {
        if (ad !== bd) return ad < bd ? 1 : -1;   // newest date first
      } else if (ad) {
        return -1;                                 // dated before undated
      } else if (bd) {
        return 1;
      }
      var ac = (a && a.createdAt) || 0;
      var bc = (b && b.createdAt) || 0;
      return bc - ac;
    });
  }

  function groupByMonth(photos) {
    var sorted = sortPhotos(photos);
    var order = [];
    var map = {};
    sorted.forEach(function (p) {
      var key = monthKey(p && p.date);
      if (!map[key]) {
        map[key] = { key: key, label: monthLabel(key), photos: [] };
        order.push(key);
      }
      map[key].photos.push(p);
    });
    // Push the "Undated" bucket (empty key) to the very end.
    order.sort(function (a, b) {
      if (a === b) return 0;
      if (a === "") return 1;
      if (b === "") return -1;
      return a < b ? 1 : -1; // newest month first
    });
    return order.map(function (k) { return map[k]; });
  }

  function formatBytes(n) {
    var bytes = Number(n) || 0;
    if (bytes < 1024) return bytes + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var value = bytes / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + units[i];
  }

  function totalBytes(photos) {
    return (photos || []).reduce(function (sum, p) {
      return sum + (Number(p && p.bytes) || 0);
    }, 0);
  }

  function scaledSize(w, h, maxDim) {
    var width = Number(w) || 0;
    var height = Number(h) || 0;
    var max = Number(maxDim) || MAX_DIM;
    if (width <= 0 || height <= 0) return { w: 0, h: 0 };
    var longest = Math.max(width, height);
    if (longest <= max) return { w: Math.round(width), h: Math.round(height) };
    var scale = max / longest;
    return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
  }

  function publicPhoto(p) {
    return {
      id: p.id,
      caption: clampCaption(p.caption),
      date: normalizeDate(p.date),
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      bytes: Number(p.bytes) || 0,
      mime: String(p.mime || "image/jpeg"),
      createdAt: Number(p.createdAt) || 0
    };
  }

  function exportMeta(photos, now) {
    return {
      app: "love-gallery",
      version: 1,
      exportedAt: new Date(now || Date.now()).toISOString(),
      photos: sortPhotos(photos || []).map(publicPhoto)
    };
  }

  function importMeta(raw, existing) {
    var current = (existing || []).slice();
    var have = {};
    current.forEach(function (p) { if (p && p.id) have[p.id] = true; });
    var incoming = raw && Array.isArray(raw.photos) ? raw.photos : [];
    var added = 0;
    var skipped = 0;
    incoming.forEach(function (p) {
      if (!p || typeof p.caption !== "string" || !p.id) { skipped += 1; return; }
      if (have[p.id]) { skipped += 1; return; }
      have[p.id] = true;
      current.push({
        id: String(p.id),
        caption: clampCaption(p.caption),
        date: normalizeDate(p.date),
        width: Number(p.width) || 0,
        height: Number(p.height) || 0,
        bytes: Number(p.bytes) || 0,
        mime: String(p.mime || "image/jpeg"),
        createdAt: Number(p.createdAt) || 0
      });
      added += 1;
    });
    return { photos: current, added: added, skipped: skipped };
  }

  /* ======================= metadata storage ======================= */

  function load() {
    state.photos = [];
    var raw = null;
    try { raw = localStorage.getItem(META_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    var list = parsed && Array.isArray(parsed.photos) ? parsed.photos : [];
    list.forEach(function (p) {
      if (p && typeof p.id === "string") state.photos.push(publicPhoto(p));
    });
  }

  function save() {
    try { localStorage.setItem(META_KEY, JSON.stringify({ v: 1, photos: state.photos })); } catch (e) { /* ignore */ }
  }

  /* ======================= photo store (IndexedDB) ======================= */

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      var idb;
      try { idb = typeof indexedDB !== "undefined" ? indexedDB : null; } catch (e) { idb = null; }
      if (!idb) { resolve(null); return; }
      var req;
      try { req = idb.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
    return dbPromise;
  }

  function withStore(mode, fn) {
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var result;
        try { result = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(result && result.result !== undefined ? result.result : result); };
        tx.onerror = function () { reject(tx.error); };
        if (result && typeof result.onsuccess === "function") {
          result.onsuccess = function () { resolve(result.result); };
          result.onerror = function () { reject(result.error); };
        }
      });
    });
  }

  function putPhoto(id, blob) {
    return withStore("readwrite", function (store) { store.put(blob, id); })
      .then(function () { memStore[id] = blob; });
  }

  function getPhoto(id) {
    return withStore("readonly", function (store) { return store.get(id); })
      .then(function (blob) { return blob || memStore[id] || null; });
  }

  function deletePhoto(id) {
    return withStore("readwrite", function (store) { store.delete(id); })
      .then(function () { delete memStore[id]; });
  }

  function clearStore() {
    return withStore("readwrite", function (store) { store.clear(); })
      .then(function () { memStore = {}; });
  }

  /* ======================= canvas downscale ======================= */

  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("not an image")); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) { resolve(blob); }, "image/jpeg", QUALITY);
        return;
      }
      try {
        var data = canvas.toDataURL("image/jpeg", QUALITY);
        var bin = atob(data.split(",")[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: "image/jpeg" }));
      } catch (e) {
        resolve(null);
      }
    });
  }

  function buildRecord(file, caption, date) {
    return readImage(file).then(function (read) {
      var img = read.img;
      var dims = scaledSize(img.naturalWidth || img.width, img.naturalHeight || img.height, MAX_DIM);
      var canvas = document.createElement("canvas");
      canvas.width = dims.w;
      canvas.height = dims.h;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, dims.w, dims.h);
      URL.revokeObjectURL(read.url);
      return canvasToBlob(canvas).then(function (blob) {
        if (!blob) return null;
        var rec = {
          id: uid(),
          caption: clampCaption(caption),
          date: normalizeDate(date) || todayISO(),
          width: dims.w,
          height: dims.h,
          bytes: blob.size,
          mime: "image/jpeg",
          createdAt: Date.now()
        };
        return putPhoto(rec.id, blob).then(function () { return rec; });
      });
    });
  }

  /* ======================= DOM helpers ======================= */

  function $(id) { return document.getElementById(id); }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = String(value);
  }

  function note(id, message) { setText(id, message); }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function revokeThumb(id) {
    if (thumbUrls[id]) {
      try { URL.revokeObjectURL(thumbUrls[id]); } catch (e) { /* ignore */ }
      delete thumbUrls[id];
    }
  }

  /* ======================= rendering ======================= */

  function renderTimeline() {
    var list = $("timeline-list");
    if (!list) return;
    list.textContent = "";

    var groups = groupByMonth(state.photos);
    if (!groups.length) {
      var empty = el("p", "gallery-empty");
      empty.textContent = "No photos yet — add the first one and it'll appear right here.";
      list.appendChild(empty);
    } else {
      groups.forEach(function (group) {
        var section = el("section", "month-section");
        var heading = el("h3", "month-heading");
        heading.appendChild(document.createTextNode(group.label));
        var count = el("span", "month-note");
        count.textContent = group.photos.length + (group.photos.length === 1 ? " photo" : " photos");
        heading.appendChild(count);
        section.appendChild(heading);

        var grid = el("div", "photo-grid");
        group.photos.forEach(function (photo) {
          grid.appendChild(renderCard(photo));
        });
        section.appendChild(grid);
        list.appendChild(section);
      });
    }

    setText("photo-count", state.photos.length);
    setText("month-count", groupByMonth(state.photos).filter(function (g) { return g.key; }).length);
    renderStorage();
  }

  function renderCard(photo) {
    var card = el("figure", "photo-card");
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", photo.caption || "A photo");

    var img = el("img", "photo-thumb");
    img.alt = photo.caption || "A photo of us";
    card.appendChild(img);
    loadThumb(photo.id, img);

    var cap = el("figcaption");
    var caption = el("p", "photo-caption");
    caption.textContent = photo.caption || "\u2014";
    cap.appendChild(caption);
    var date = el("span", "photo-date");
    date.textContent = prettyDate(photo.date);
    cap.appendChild(date);
    card.appendChild(cap);

    function open() { openLightbox(photo.id); }
    card.addEventListener("click", open);
    card.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
    });

    return card;
  }

  function loadThumb(id, img) {
    getPhoto(id).then(function (blob) {
      if (!blob) {
        img.classList.add("is-missing");
        img.alt = "Photo not on this device";
        return;
      }
      var url = URL.createObjectURL(blob);
      revokeThumb(id);
      thumbUrls[id] = url;
      img.src = url;
    });
  }

  function renderStorage() {
    var used = totalBytes(state.photos);
    var pct = Math.min(100, (used / SOFT_BUDGET) * 100);
    var fill = $("storage-fill");
    if (fill) fill.style.width = pct.toFixed(2) + "%";
    setText("storage-label", formatBytes(used) + " used \u00b7 " + state.photos.length +
      (state.photos.length === 1 ? " photo" : " photos"));
  }

  /* ======================= lightbox ======================= */

  function orderedPhotos() { return sortPhotos(state.photos); }

  function openLightbox(id) {
    var list = orderedPhotos();
    var idx = list.findIndex(function (p) { return p.id === id; });
    if (idx < 0) return;
    lightboxIndex = idx;
    showLightbox();
  }

  function showLightbox() {
    var box = $("lightbox");
    if (!box) return;
    var list = orderedPhotos();
    var photo = list[lightboxIndex];
    if (!photo) return;

    box.hidden = false;
    box.setAttribute("aria-hidden", "false");

    var img = $("lightbox-img");
    getPhoto(photo.id).then(function (blob) {
      if (!img) return;
      if (blob) {
        img.src = URL.createObjectURL(blob);
        img.alt = photo.caption || "A photo of us";
      } else {
        img.removeAttribute("src");
        img.alt = "Photo not on this device";
      }
    });

    setText("lightbox-caption", photo.caption || "\u2014");
    setText("lightbox-date", prettyDate(photo.date) + " \u00b7 " + formatBytes(photo.bytes));
  }

  function closeLightbox() {
    var box = $("lightbox");
    if (box) { box.hidden = true; box.setAttribute("aria-hidden", "true"); }
    var img = $("lightbox-img");
    if (img && img.src) { try { URL.revokeObjectURL(img.src); } catch (e) { /* ignore */ } img.removeAttribute("src"); }
    lightboxIndex = -1;
  }

  function stepLightbox(delta) {
    var list = orderedPhotos();
    if (!list.length) return;
    lightboxIndex = (lightboxIndex + delta + list.length) % list.length;
    showLightbox();
  }

  function downloadCurrent() {
    var photo = orderedPhotos()[lightboxIndex];
    if (!photo) return;
    getPhoto(photo.id).then(function (blob) {
      if (!blob) { setText("lightbox-date", "This photo isn't on this device."); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "mena-" + (photo.date || "photo") + ".jpg";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  function deleteCurrent() {
    var photo = orderedPhotos()[lightboxIndex];
    if (!photo) return;
    removePhoto(photo.id).then(function () {
      closeLightbox();
      renderTimeline();
      note("save-note", "That photo is gone from this device.");
    });
  }

  /* ======================= actions ======================= */

  function removePhoto(id) {
    revokeThumb(id);
    return deletePhoto(id).then(function () {
      state.photos = state.photos.filter(function (p) { return p.id !== id; });
      save();
    });
  }

  function addStaged() {
    if (!staged.length) { note("add-note", "Choose a photo first \u2665"); return; }
    var captionEl = $("caption-input");
    var dateEl = $("date-input");
    var caption = captionEl ? captionEl.value : "";
    var date = dateEl && dateEl.value ? dateEl.value : todayISO();

    var btn = $("add-photo");
    if (btn) btn.disabled = true;
    note("add-note", "Saving " + staged.length + (staged.length === 1 ? " photo\u2026" : " photos\u2026"));

    var files = staged.slice();
    var done = 0;
    var failed = 0;

    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return buildRecord(file, caption, date)
          .then(function (rec) {
            if (rec) { state.photos.push(rec); done += 1; }
            else failed += 1;
          })
          .catch(function () { failed += 1; });
      });
    });

    chain.then(function () {
      save();
      staged = [];
      var input = $("file-input");
      if (input) input.value = "";
      updateFileCount();
      renderTimeline();
      if (btn) btn.disabled = true;
      var msg = "Added " + done + (done === 1 ? " photo \u2665" : " photos \u2665");
      if (failed) msg += " (" + failed + " couldn't be read)";
      note("add-note", msg);
      if (captionEl) captionEl.value = "";
    });
  }

  function updateFileCount() {
    var label = staged.length
      ? staged.length + (staged.length === 1 ? " photo chosen" : " photos chosen") + " \u2014 give them a caption and press add."
      : "No photos chosen yet.";
    setText("file-count", label);
    var btn = $("add-photo");
    if (btn) btn.disabled = !staged.length;
  }

  function exportCaptions() {
    var data = exportMeta(state.photos);
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "love-gallery-captions.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    note("save-note", "Exported " + state.photos.length + " captions \u2665");
  }

  function importCaptions(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = null;
      try { parsed = JSON.parse(String(reader.result)); } catch (e) { parsed = null; }
      if (!parsed) { note("save-note", "That file didn't look like our captions."); return; }
      var merged = importMeta(parsed, state.photos);
      state.photos = merged.photos;
      save();
      renderTimeline();
      note("save-note", "Imported " + merged.added + " caption" + (merged.added === 1 ? "" : "s") +
        (merged.skipped ? " (" + merged.skipped + " skipped)" : "") +
        ". The pictures themselves weren't in the export.");
    };
    reader.readAsText(file);
  }

  function clearAll() {
    clearStore().then(function () {
      Object.keys(thumbUrls).forEach(revokeThumb);
      state.photos = [];
      save();
      renderTimeline();
      note("save-note", "The gallery is empty \u2014 a fresh wall whenever you're ready.");
    });
  }

  /* ======================= events ======================= */

  function wire() {
    var fileInput = $("file-input");
    if (fileInput) fileInput.addEventListener("change", function () {
      staged = Array.prototype.slice.call(fileInput.files || []);
      updateFileCount();
    });

    var addBtn = $("add-photo");
    if (addBtn) addBtn.addEventListener("click", addStaged);

    var dateInput = $("date-input");
    if (dateInput && !dateInput.value) dateInput.value = todayISO();

    var exp = $("export-meta");
    if (exp) exp.addEventListener("click", exportCaptions);

    var imp = $("import-meta");
    if (imp) imp.addEventListener("change", function () {
      if (imp.files && imp.files[0]) importCaptions(imp.files[0]);
      imp.value = "";
    });

    var clear = $("clear-gallery");
    if (clear) clear.addEventListener("click", clearAll);

    var close = $("lightbox-close");
    if (close) close.addEventListener("click", closeLightbox);
    var prev = $("lightbox-prev");
    if (prev) prev.addEventListener("click", function () { stepLightbox(-1); });
    var next = $("lightbox-next");
    if (next) next.addEventListener("click", function () { stepLightbox(1); });
    var dl = $("lightbox-download");
    if (dl) dl.addEventListener("click", downloadCurrent);
    var del = $("lightbox-delete");
    if (del) del.addEventListener("click", deleteCurrent);

    var box = $("lightbox");
    if (box) box.addEventListener("click", function (ev) {
      if (ev.target === box) closeLightbox();
    });

    document.addEventListener("keydown", function (ev) {
      var open = $("lightbox") && !$("lightbox").hidden;
      if (!open) return;
      if (ev.key === "Escape") closeLightbox();
      if (ev.key === "ArrowLeft") stepLightbox(-1);
      if (ev.key === "ArrowRight") stepLightbox(1);
    });
  }

  function boot() {
    load();
    renderTimeline();
    wire();
  }

  /* ======================= expose ======================= */

  window.MenaGallery = {
    uid: uid,
    todayISO: todayISO,
    normalizeDate: normalizeDate,
    monthKey: monthKey,
    monthLabel: monthLabel,
    prettyDate: prettyDate,
    clampCaption: clampCaption,
    sortPhotos: sortPhotos,
    groupByMonth: groupByMonth,
    formatBytes: formatBytes,
    totalBytes: totalBytes,
    scaledSize: scaledSize,
    exportMeta: exportMeta,
    importMeta: importMeta,
    MONTHS: MONTHS
  };

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
