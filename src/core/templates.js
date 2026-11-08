/**
 * Subject lines and HTML bodies for the deliverability test message.
 *
 * Design goals that directly affect placement:
 *  - NO hidden or invisible text. Earlier templates hid the token with
 *    font-size:1px / opacity:0 / white-on-white; hidden text is a well-known
 *    spam/phishing signal and sinks the very deliverability the tool measures.
 *    The token is shown as a normal, visible reference line instead.
 *  - NO alarming / phishing-style subjects ("Security Alert: New Login"). They
 *    read as deceptive to spam filters. Subjects are neutral and transactional.
 *  - The message plainly states it is an automated delivery test, so a human
 *    who receives it understands what it is.
 */
export const SUBJECTS = [
  'Delivery test',
  'Automated delivery check',
  'Message delivery verification',
  'Mailbox delivery test',
  'Test message',
];

const body = (token, intro) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;line-height:1.5;">
  <p style="margin:0 0 12px;">${intro}</p>
  <p style="margin:0 0 12px;">You can safely ignore this message. It was sent to confirm whether delivery to this mailbox succeeds.</p>
  <p style="margin:0 0 4px;color:#555;">Reference ID:</p>
  <p style="margin:0 0 16px;font-family:monospace;font-size:14px;color:#111;">${token}</p>
  <p style="margin:0;color:#888;font-size:12px;">Automated delivery test &mdash; no action is required.</p>
</div>`;

export const HTML_BODIES = [
  (token) => body(token, 'This is an automated message sent to verify email delivery to this mailbox.'),
  (token) => body(token, 'Hello &mdash; this is a routine delivery test. No response is needed.'),
  (token) => body(token, 'This automated test message confirms that delivery to your mailbox is working.'),
];

export function getRandomTemplate() {
  const subject = SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)];
  const build = HTML_BODIES[Math.floor(Math.random() * HTML_BODIES.length)];
  // html carries a {token} placeholder for the caller's existing
  // `.replace('{token}', token)` path, so the token is always embedded.
  return { subject, html: build('{token}') };
}
