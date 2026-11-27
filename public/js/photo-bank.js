// Display photo bank helpers: resize, capture time from EXIF, and a small
// colour "fingerprint" used to suggest which nativity a bank photo shows.
// The pure functions also load in Node for testing (module.exports below).
(function (root) {
  const FP_VERSION = 1;
  const HUE_BINS = 12;
  const HIST_BINS = HUE_BINS * 4 + 4; // 12 hues x (2 saturation x 2 brightness) + 4 greys
  const GRID = 4;
  const FP_SIZE = 64;

  // ── Capture time ────────────────────────────────────────────────────
  // Reads DateTimeOriginal from a JPEG's EXIF block. Returns a Date in the
  // phone's local time, or null.
  function exifDate(buffer) {
    try {
      const v = new DataView(buffer);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
      let p = 2;
      while (p + 4 <= v.byteLength) {
        const marker = v.getUint16(p);
        if ((marker & 0xff00) !== 0xff00) return null;
        const len = v.getUint16(p + 2);
        if (marker === 0xffe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966) {
          return readTiffDate(v, p + 10);
        }
        if (marker === 0xffda) return null; // image data starts; no EXIF
        p += 2 + len;
      }
    } catch (_) { /* not a readable JPEG */ }
    return null;
  }

  function readTiffDate(v, t) {
    const little = v.getUint16(t) === 0x4949;
    const u16 = (o) => v.getUint16(t + o, little);
    const u32 = (o) => v.getUint32(t + o, little);
    const readAscii = (entry) => {
      const count = u32(entry + 4);
      const off = count > 4 ? u32(entry + 8) : entry + 8;
      let s = '';
      for (let i = 0; i < count - 1 && i < 32; i++) s += String.fromCharCode(v.getUint8(t + off + i));
      return s;
    };
    const scan = (ifd, wanted) => {
      const n = u16(ifd);
      const found = {};
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(e);
        if (wanted.includes(tag)) found[tag] = e;
      }
      return found;
    };
    const ifd0 = u32(4);
    const top = scan(ifd0, [0x8769, 0x0132]);
    let text = '';
    if (top[0x8769]) {
      const exif = scan(u32(top[0x8769] + 8), [0x9003, 0x9004]);
      if (exif[0x9003]) text = readAscii(exif[0x9003]);
      else if (exif[0x9004]) text = readAscii(exif[0x9004]);
    }
    if (!text && top[0x0132]) text = readAscii(top[0x0132]);
    const m = text.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d) ? null : d;
  }

  // ── Fingerprint ─────────────────────────────────────────────────────
  // rgba: pixel bytes of a FP_SIZE x FP_SIZE centre crop. Returns base64.
  function fingerprintFromPixels(rgba, size) {
    const hist = new Float64Array(HIST_BINS);
    const grid = new Float64Array(GRID * GRID * 3);
    const gridW = new Float64Array(GRID * GRID);
    const sigma2 = 2 * 0.38 * 0.38;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
        const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
        const w = Math.exp(-(dx * dx + dy * dy) / sigma2); // centre counts most
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        const s = max ? d / max : 0;
        let bin;
        if (s < 0.18 || max < 0.12) {
          bin = HUE_BINS * 4 + Math.min(3, Math.floor(max * 4));
        } else {
          let h;
          if (max === r) h = ((g - b) / d) % 6;
          else if (max === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h = (h * 60 + 360) % 360;
          const hb = Math.min(HUE_BINS - 1, Math.floor(h / (360 / HUE_BINS)));
          bin = hb * 4 + (s >= 0.5 ? 2 : 0) + (max >= 0.6 ? 1 : 0);
        }
        hist[bin] += w;
        const c = Math.min(GRID - 1, Math.floor((y / size) * GRID)) * GRID + Math.min(GRID - 1, Math.floor((x / size) * GRID));
        grid[c * 3] += r; grid[c * 3 + 1] += g; grid[c * 3 + 2] += b; gridW[c]++;
      }
    }
    let total = 0;
    for (const h of hist) total += h;
    const out = new Uint8Array(1 + HIST_BINS + GRID * GRID * 3);
    out[0] = FP_VERSION;
    for (let k = 0; k < HIST_BINS; k++) out[1 + k] = Math.round(255 * Math.sqrt(total ? hist[k] / total : 0));
    for (let c = 0; c < GRID * GRID; c++) {
      for (let ch = 0; ch < 3; ch++) out[1 + HIST_BINS + c * 3 + ch] = Math.round(255 * (gridW[c] ? grid[c * 3 + ch] / gridW[c] : 0));
    }
    return toBase64(out);
  }

  function toBase64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
  }

  function fromBase64(text) {
    try {
      const s = typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary');
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    } catch (_) { return null; }
  }

  function decode(fp) {
    const b = typeof fp === 'string' ? fromBase64(fp) : fp;
    if (!b || b[0] !== FP_VERSION || b.length !== 1 + HIST_BINS + GRID * GRID * 3) return null;
    return { hist: b.subarray(1, 1 + HIST_BINS), grid: b.subarray(1 + HIST_BINS) };
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  // Layout: correlation of the 4x4 colour grids after removing each photo's
  // overall brightness, so lighting differences matter less.
  function gridCorrelation(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let dot = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; dot += x * y; va += x * x; vb += y * y; }
    return va && vb ? dot / Math.sqrt(va * vb) : 0;
  }

  // 0..1, higher means more alike. Null when either fingerprint is missing.
  function similarity(fpA, fpB) {
    const a = decode(fpA), b = decode(fpB);
    if (!a || !b) return null;
    return 0.7 * cosine(a.hist, b.hist) + 0.3 * ((gridCorrelation(a.grid, b.grid) + 1) / 2);
  }

  // ── Browser helpers ─────────────────────────────────────────────────
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not open that photo.'));
      img.src = src;
    });
  }

  function fingerprintImage(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const side = Math.min(w, h) * 0.85;
    const canvas = document.createElement('canvas');
    canvas.width = FP_SIZE; canvas.height = FP_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, FP_SIZE, FP_SIZE);
    return fingerprintFromPixels(ctx.getImageData(0, 0, FP_SIZE, FP_SIZE).data, FP_SIZE);
  }

  // Resizes a picked file for upload and fingerprints it from the same decode.
  async function prepareFile(file, maxDim = 2000, quality = 0.82) {
    let takenAt = null;
    try { takenAt = exifDate(await file.slice(0, 256 * 1024).arrayBuffer()); } catch (_) {}
    if (!takenAt && file.lastModified) takenAt = new Date(file.lastModified);
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare that photo.'))), 'image/jpeg', quality));
      canvas.width = canvas.height = 0;
      return { blob, fingerprint: fingerprintImage(img), takenAt };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function fingerprintUrl(src) {
    return fingerprintImage(await loadImage(src));
  }

  const api = { exifDate, fingerprintFromPixels, similarity, decode, prepareFile, fingerprintUrl, FP_SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoBank = api;
})(typeof window !== 'undefined' ? window : globalThis);
