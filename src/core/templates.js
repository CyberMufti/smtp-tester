export const SUBJECTS = [
  "Action Required: Account Verification",
  "Invoice #8842 Attached",
  "Meeting Notes & Next Steps",
  "Security Alert: New Login Detected",
  "Your Weekly Summary Report",
  "Document Shared With You",
  "Pending Payment Notification"
];

export const HTML_BODIES = [
  // Template 1: Basic Notification
  `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
    <h2 style="color:#0056b3;">Account Notification</h2>
    <p>Hello,</p>
    <p>Please review the recent activity on your account.</p>
    <p>Reference ID: <span style="color:#fff;font-size:1px;">{token}</span></p>
    <p>If you have questions, contact support.</p>
  </div>`,
  
  // Template 2: Invoice Style
  `<div style="font-family:Helvetica,Arial,sans-serif;max-width:650px;margin:0 auto;border:1px solid #ddd;padding:20px;color:#444;">
    <div style="background:#f4f4f4;padding:15px;text-align:center;">
      <h3 style="margin:0;">Invoice Attached</h3>
    </div>
    <p>Dear Customer,</p>
    <p>Please find your recent invoice below.</p>
    <table style="width:100%;border-collapse:collapse;margin-top:15px;">
      <tr><td style="padding:8px;border-bottom:1px solid #ddd;">Order ID:</td><td style="padding:8px;border-bottom:1px solid #ddd;">{token}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #ddd;">Status:</td><td style="padding:8px;border-bottom:1px solid #ddd;">Processed</td></tr>
    </table>
  </div>`,

  // Template 3: Security Alert
  `<div style="font-family:Verdana,sans-serif;max-width:550px;margin:0 auto;color:#222;">
    <div style="background:#ff4d4d;color:white;padding:20px;text-align:center;">
      <h2 style="margin:0;">Security Alert</h2>
    </div>
    <p>We detected a new login to your account.</p>
    <p>Incident Hash: <span style="opacity:0;font-size:0;">{token}</span></p>
    <p>If this was not you, please reset your password immediately.</p>
  </div>`
];

export function getRandomTemplate() {
  const subj = SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)];
  const html = HTML_BODIES[Math.floor(Math.random() * HTML_BODIES.length)];
  return { subject: subj, html: html };
}
