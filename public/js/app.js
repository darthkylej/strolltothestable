// Small fetch wrapper. Shows the error banner (an element with
// data-error-banner) on failure instead of a raw alert().
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function showError(message) {
  const banner = document.querySelector('[data-error-banner]');
  if (!banner) { alert(message); return; }
  banner.textContent = message;
  banner.style.display = 'block';
}

function hideError() {
  const banner = document.querySelector('[data-error-banner]');
  if (banner) banner.style.display = 'none';
}

// Resizes an image file in the browser before upload — keeps every photo
// well under ~300KB so 500 nativities x ~10 photos each stays a couple GB,
// comfortably inside Cloudflare R2's free tier.
function resizeImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
      else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadPhotoTo(file, url) {
  const blob = await resizeImage(file);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Photo upload failed.');
  return data;
}

async function uploadPhoto(file) {
  const data = await uploadPhotoTo(file, '/api/upload-photo');
  return data.key;
}


// Donors whose account is missing contact details or an address (for example
// one a volunteer created at the walk-in desk) fill them in on My Account
// before going any further. Only the pages a donor works in are gated.
(function () {
  const GATED = ['/dashboard.html', '/my-nativity.html', '/waiver.html', '/lend-photo.html', '/lend-pieces.html'];
  if (!GATED.includes(location.pathname)) return;
  fetch('/api/account', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((account) => {
      if (!account || account.profileComplete !== false) return;
      location.replace('/account.html?complete=1&next=' + encodeURIComponent(location.pathname + location.search));
    })
    .catch(() => {});
})();
