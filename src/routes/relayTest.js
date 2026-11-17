// TEMPORARY (2026-11-17): one-off live test of the admin-reply relay. Sends
// Tim Bird's real reply to the "Volunteers?" question, cleaned exactly as the
// relay does, to a single fixed test inbox. No database writes, no admin
// alerts. Remove after the test.
import { json, error } from '../lib/util.js';
import { adminReplyText } from './messages.js';
import { sendMessageCenterReply, REPLY_MARKER } from '../lib/email.js';

const KEY_SHA256 = '1fcb290ef36bf44ca2a37367c24f5fe4568b033dfcc70e1bacc601104ae837d9';
const TEST_TO = 'seguin1stwardbishop@gmail.com';

// Tim's reply as Gmail delivers it when he taps Reply on the alert: his text,
// Gmail's Drive link for the photo, then the quoted alert (with a sign-in
// link that must never be forwarded).
const TIM_RAW = [
  'Ashley,',
  'Yes, absolutely. We would love to have them',
  '',
  ' IMG_2351.HEIC',
  '<https://drive.google.com/open?id=1-L2UF9ktlYVyu_WhM4XKU2JUz3_JNaTP>',
  " be a host and we're finalizing that schedule now. Basically, the shifts",
  "are two hours long and can be scheduled anytime we're open. And we're",
  'asking our hosts to dress the part of old Bethlehem—something like the pics',
  'I have attached.',
  '',
  'On Tue, Nov 17, 2026 at 10:05 AM Stroll to the Stable <info@strolltothestable.com>',
  'wrote:',
  '',
  '> ' + REPLY_MARKER,
  '>',
  '> New message from seguin1stwardbishop@gmail.com',
  '> Subject: Volunteers?',
  '>',
  '> Is there time when you could use some more help? Is there a sign up for that?',
  '>',
  '> Reply to this email to answer seguin1stwardbishop@gmail.com.',
  '> Open the Message Center: https://strolltothestable.com/admin-email-login?token=TEST-NOT-REAL&next=%2Fadmin-messages.html',
].join('\n');

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function relayTest(request, env) {
  const key = request.headers.get('X-Test-Key') || '';
  if (!key || (await sha256Hex(key)) !== KEY_SHA256) return error('Not found.', 404);
  const bodyText = adminReplyText(TIM_RAW);
  if (!bodyText) return error('Relay would not send this reply.', 422);
  const result = await sendMessageCenterReply(env, {
    to: TEST_TO,
    fromAddress: 'info@strolltothestable.com',
    subject: 'Volunteers?',
    bodyText,
    threadCode: 'TEST',
    inReplyTo: '',
    references: '',
  });
  return json({ ok: true, to: TEST_TO, sentText: bodyText, messageId: result?.messageId || null });
}
