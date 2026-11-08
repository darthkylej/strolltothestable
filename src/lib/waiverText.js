// Single source of truth for the waiver wording. The PDF and the signing
// screen both render from this, so what people read is what they sign.
// Change AGREEMENT_VERSION whenever the wording changes.
export const AGREEMENT_VERSION = '2026-11-08';
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

// Returns the agreement as ordered sections. `release: true` marks the
// section that must be displayed conspicuously.
export function agreementSections(dates = {}) {
  const deadline = formatDay(dates.pickupDeadline);
  return [
    {
      title: 'Parties',
      text: `I, the participant named in this form ("Lender"), am lending the nativity set and pieces listed in this form ("Property") for display at A Stroll to the Stable ("Event"), hosted by the ${ORGANIZER} ("Organizer"). In this agreement, "Released Parties" means the Organizer and its officials, employees and agents; the Event's organizers, volunteers, sponsors and partner organizations; and the owners and operators of the Event venue.`,
    },
    {
      title: '1. Ownership and Authority',
      text: 'I am at least 18 years old. I own the Property or am authorized by its owner to lend it and to sign this agreement. The piece list and condition notes in this form are accurate to the best of my knowledge.',
    },
    {
      title: '2. Voluntary Loan and Assumption of Risk',
      text: 'I am lending the Property voluntarily. I understand that items on public display can be damaged, lost or stolen during transport, setup, display, storage and return, and I knowingly accept those risks.',
    },
    {
      title: '3. RELEASE OF LIABILITY - PLEASE READ CAREFULLY',
      release: true,
      text: 'TO THE FULLEST EXTENT PERMITTED BY LAW, I RELEASE, WAIVE AND DISCHARGE THE RELEASED PARTIES FROM ALL CLAIMS, DEMANDS AND LIABILITY FOR LOSS OF, DAMAGE TO, OR THEFT OF THE PROPERTY, AND FOR ANY INJURY TO ME, ARISING FROM MY PARTICIPATION IN THE EVENT, INCLUDING CLAIMS CAUSED IN WHOLE OR IN PART BY THE NEGLIGENCE OF ANY RELEASED PARTY. I AGREE NOT TO SUE ANY RELEASED PARTY FOR ANY CLAIM RELEASED BY THIS AGREEMENT. THIS RELEASE DOES NOT APPLY TO GROSS NEGLIGENCE OR INTENTIONAL MISCONDUCT.',
    },
    {
      title: '4. No Insurance',
      text: 'The Released Parties do not insure the Property. I am responsible for any insurance I want on it, and I may wish to check whether my homeowner\'s or renter\'s policy covers it.',
    },
    {
      title: '5. Care of the Property',
      text: 'The Organizer will take reasonable precautions to protect the Property but cannot guarantee it against damage, loss or theft.',
    },
    {
      title: '6. Photographs',
      text: 'The Organizer may photograph and record my display and use those images, including in the online Virtual Tour and in promotional materials, without payment to me. I may remove my display from the online Virtual Tour at any time from My Nativities.',
    },
    {
      title: '7. Pick-Up and Unclaimed Property',
      text: `I will collect the Property by the pick-up deadline of ${deadline}. If I do not, the Organizer will try to contact me by email and phone. Property not collected within ${ABANDON_DAYS} days after the pick-up deadline will be considered abandoned and becomes the property of the Organizer, which may keep, donate or dispose of it.`,
    },
    {
      title: '8. Electronic Records',
      text: `I agree to sign and receive this agreement electronically, and that my electronic signature has the same effect as a handwritten signature. I may instead ask for a paper copy, or sign a paper version at drop-off, by contacting ${CONTACT_EMAIL}.`,
    },
    {
      title: '9. General Terms',
      text: 'This agreement is governed by the laws of the State of Texas. If any part of it is found unenforceable, the rest remains in effect. It is the entire agreement about the loan of the Property and replaces any earlier statements about it.',
    },
  ];
}

export const RELEASE_ACK = 'I have read the RELEASE OF LIABILITY (section 3) and understand that it releases the Released Parties from claims, including claims caused by their negligence.';
export const CONSENT_TEXT = 'I have reviewed the complete Registration, Loan and Release Agreement, understand its terms, and agree that my electronic signature is legally binding.';
