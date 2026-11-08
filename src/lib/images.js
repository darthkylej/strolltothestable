import { error } from './util.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);

// Identify the image type from its bytes. The client-supplied Content-Type is
// never trusted, so an uploaded HTML/SVG file cannot be stored as an "image".
export function sniffImageType(b) {
  if (b.length < 12) return null;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg', ext: 'jpg' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image/png', ext: 'png' };
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return { type: 'image/gif', ext: 'gif' };
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { type: 'image/webp', ext: 'webp' };
  }
  return null;
}

// Reads a raw-body image upload. Throws a Response (handled in index.js).
export async function readImageUpload(request, maxBytes = MAX_IMAGE_BYTES) {
  const limitMb = Math.round(maxBytes / 1024 / 1024);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw error(`Image is too large (maximum ${limitMb} MB).`, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw error('Choose an image file.', 400);
  if (bytes.length > maxBytes) throw error(`Image is too large (maximum ${limitMb} MB).`, 413);
  const kind = sniffImageType(bytes);
  if (!kind) throw error('Only JPEG, PNG, WebP, or GIF images are allowed.', 415);
  return { bytes, ...kind };
}
