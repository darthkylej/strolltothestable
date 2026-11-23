// Photo download links: <a data-photo-download href="/api/.../photo-download/...">.
// On a phone that can share files (iPhone, Android), a single photo opens the
// share sheet, so it can go straight into the Photos app with "Save Image".
// Everywhere else, and for the zip of all photos, it is a normal file download.
(function () {
  function fileNameFrom(res, fallback) {
    const cd = res.headers.get('Content-Disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) { try { return decodeURIComponent(star[1]); } catch (e) { /* use plain name */ } }
    const plain = /filename="([^"]+)"/i.exec(cd);
    return plain ? plain[1] : fallback;
  }

  function canShareFiles() {
    try {
      return !!(navigator.canShare && navigator.share && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (e) { return false; }
  }

  document.addEventListener('click', async (e) => {
    const link = e.target.closest && e.target.closest('a[data-photo-download]');
    if (!link) return;
    e.stopPropagation();
    if (link.hasAttribute('data-zip') || !canShareFiles()) return; // normal download
    e.preventDefault();
    const href = link.href;
    let res;
    try {
      res = await fetch(href, { credentials: 'same-origin' });
    } catch (err) {
      window.location.href = href;
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (typeof showError === 'function') showError(data.error || 'Could not download that photo.');
      return;
    }
    try {
      const blob = await res.blob();
      const file = new File([blob], fileNameFrom(res, 'nativity-photo.jpg'), { type: blob.type || 'image/jpeg' });
      if (!navigator.canShare({ files: [file] })) { window.location.href = href; return; }
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // they closed the share sheet
      window.location.href = href; // fall back to a plain download
    }
  }, true);
})();
