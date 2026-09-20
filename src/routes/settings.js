import { json } from '../lib/util.js';
import { getSiteSettings, submissionsAreOpen } from '../lib/siteSettings.js';

export async function getPublicSettings(request, env) {
  const settings = await getSiteSettings(env);
  return json(
    {
      submissionsOpen: submissionsAreOpen(settings),
      submissionsEnabled: settings.submissionsOpen,
      submissionStart: settings.submissionStart,
      submissionEnd: settings.submissionEnd,
      dropoffStart: settings.dropoffStart,
      dropoffEnd: settings.dropoffEnd,
      pickupStart: settings.pickupStart,
      pickupEnd: settings.pickupEnd,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' } }
  );
}
