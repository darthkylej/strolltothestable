import { json } from '../lib/util.js';
import { getSiteSettings } from '../lib/siteSettings.js';

export async function getPublicSettings(request, env) {
  const settings = await getSiteSettings(env);
  return json(
    { submissionsOpen: settings.submissionsOpen },
    { headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' } }
  );
}
