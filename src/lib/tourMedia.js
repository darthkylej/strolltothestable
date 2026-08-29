export const TOUR_MEDIA_PREFIX = 'tour-media/';
export const MAX_TOUR_MEDIA_BYTES = 95 * 1024 * 1024;

const MEDIA_TYPES = {
  'image/jpeg': { mediaType: 'image', ext: 'jpg' },
  'image/png': { mediaType: 'image', ext: 'png' },
  'image/webp': { mediaType: 'image', ext: 'webp' },
  'image/gif': { mediaType: 'image', ext: 'gif' },
  'video/mp4': { mediaType: 'video', ext: 'mp4' },
  'video/webm': { mediaType: 'video', ext: 'webm' },
  'video/quicktime': { mediaType: 'video', ext: 'mov' },
};

export function getTourMediaSpec(contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  const spec = MEDIA_TYPES[normalized];
  return spec ? { ...spec, contentType: normalized } : null;
}

export async function listTourMediaObjects(env) {
  const objects = [];
  let cursor;

  do {
    const page = await env.PHOTOS.list({
      prefix: TOUR_MEDIA_PREFIX,
      cursor,
      limit: 1000,
      include: ['httpMetadata', 'customMetadata'],
    });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
}

export function serializeTourMedia(object) {
  const contentType = object.httpMetadata?.contentType || 'application/octet-stream';
  const mediaType = object.customMetadata?.mediaType || (contentType.startsWith('video/') ? 'video' : 'image');
  return {
    type: 'media',
    key: object.key,
    url: `/${object.key}`,
    mediaType,
    contentType,
    title: object.customMetadata?.title || '',
    caption: object.customMetadata?.caption || '',
    uploadedAt: object.uploaded.toISOString(),
    size: object.size,
  };
}
