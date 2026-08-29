const SETTINGS_KEY = '_settings/site.json';
const ADMIN_NOTE_PREFIX = '_admin-notes/';

const DEFAULT_SETTINGS = {
  submissionsOpen: true,
};

export async function getSiteSettings(env) {
  const object = await env.PHOTOS.get(SETTINGS_KEY);
  if (!object) return { ...DEFAULT_SETTINGS };

  try {
    const stored = JSON.parse(await object.text());
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      submissionsOpen: stored.submissionsOpen !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSubmissionsOpen(env, submissionsOpen, updatedBy = '') {
  const settings = {
    ...(await getSiteSettings(env)),
    submissionsOpen: !!submissionsOpen,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  await env.PHOTOS.put(SETTINGS_KEY, JSON.stringify(settings), {
    httpMetadata: { contentType: 'application/json' },
  });

  return settings;
}

export async function getAdminNote(env, nativityId) {
  const object = await env.PHOTOS.get(`${ADMIN_NOTE_PREFIX}${nativityId}.txt`);
  return object ? object.text() : '';
}

export async function setAdminNote(env, nativityId, note, updatedBy = '') {
  const key = `${ADMIN_NOTE_PREFIX}${nativityId}.txt`;
  const value = String(note || '').trim();

  if (!value) {
    await env.PHOTOS.delete(key);
    return '';
  }

  await env.PHOTOS.put(key, value, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    customMetadata: {
      updatedBy,
      updatedAt: new Date().toISOString(),
    },
  });

  return value;
}

export async function deleteAdminNote(env, nativityId) {
  await env.PHOTOS.delete(`${ADMIN_NOTE_PREFIX}${nativityId}.txt`);
}
