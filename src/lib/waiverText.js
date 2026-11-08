// Single source of truth for the waiver wording. The PDF and the signing
// screen both render from this, so what people read is what they sign.
// Change AGREEMENT_VERSION whenever the wording changes.
export const AGREEMENT_VERSION = '2026-11-08.2';
export const ORGANIZER = 'City of Seguin';
export const CONTACT_EMAIL = 'submissions@strolltothestable.com';
export const ABANDON_DAYS = 30;

// Public event dates (used when admins have not set eventStart/eventEnd).
export const DEFAULT_EVENT = { start: '2026-11-27', end: '2026-12-06' };

export function formatDay(value) {
  if (!value) return 'the posted pick-up deadline';
  return new Date(value + 'T12:00:00Z').toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
  });
}

// Section number of the release, referenced by the PDF notice and the checkbox.
export const RELEASE_SECTION = 2;

// Returns the agreement as ordered sections. `release: true` marks the
// section that must be displayed conspicuously.
export function agreementSections(dates = {}) {
  const deadline = formatDay(dates.pickupDeadline);
  return [
    {
      title: 'Agreement',
      text: `I ("Lender") am lending the nativity set and pieces listed in this form ("Property") for display at A Stroll to the Stable, hosted by the ${ORGANIZER} ("Organizer"). "Released Parties" means the Organizer and its officials, employees, volunteers, sponsors and partners, and the owner of the event venue.`,
    },
    {
      title: '1. Ownership and Risk',
      text: 'I am at least 18 years old and own the Property or am authorized to lend it. The piece list and condition notes in this form are accurate. I am lending the Property voluntarily and accept the risk that it may be damaged, lost or stolen. The Released Parties do not insure the Property.',
    },
    {
      title: `${RELEASE_SECTION}. RELEASE OF LIABILITY - PLEASE READ CAREFULLY`,
      release: true,
      text: 'TO THE FULLEST EXTENT PERMITTED BY LAW, I RELEASE THE RELEASED PARTIES FROM ALL CLAIMS FOR LOSS OF, DAMAGE TO OR THEFT OF THE PROPERTY, AND FOR ANY INJURY TO ME, ARISING FROM THE EVENT, INCLUDING CLAIMS CAUSED BY THE NEGLIGENCE OF ANY RELEASED PARTY, AND I AGREE NOT TO SUE THEM FOR THOSE CLAIMS. THIS RELEASE DOES NOT COVER GROSS NEGLIGENCE OR INTENTIONAL MISCONDUCT.',
    },
    {
      title: '3. Photographs',
      text: 'The Organizer may photograph my display and use the images, including in the online Virtual Tour and in promotional materials, without payment to me.',
    },
    {
      title: '4. Pick-Up',
      text: `I am responsible for collecting the Property by ${deadline}. Property not collected within ${ABANDON_DAYS} days after that date is considered abandoned and becomes the property of the Organizer.`,
    },
    {
      title: '5. General Terms',
      text: `My electronic signature is legally binding; I may instead request a paper version from ${CONTACT_EMAIL}. Texas law governs this agreement. If any part is unenforceable, the rest remains in effect. This is the entire agreement about the loan of the Property.`,
    },
  ];
}

export const RELEASE_ACK = `I have read the RELEASE OF LIABILITY (section ${RELEASE_SECTION}), including that it covers claims caused by the Released Parties' negligence.`;
export const CONSENT_TEXT = 'I have reviewed this agreement, accept its terms, and agree to sign it electronically.';
