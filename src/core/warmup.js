/**
 * Warm-up advisory for a working SMTP: a recommended safe daily send volume and
 * a ramp schedule. This is GUIDANCE, not a measured cap — real limits can only
 * be found by actually sending at volume. It blends well-known provider daily
 * limits with what the run observed (already-limited, or a tripped limit probe).
 *
 * @param {object} result a tester Result
 * @returns {{dailyCap:number, startVolume:number, rampDays:number, ramp:number[], note:string}|null}
 */

// Rough, widely-cited daily send ceilings by provider bucket (steady state).
const PROVIDER_DAILY_CAP = {
  'Gmail': 500,
  'Google Workspace': 2000,
  'Microsoft 365': 10000,
  'Microsoft Exchange': 5000,
  'Outlook/Hotmail': 300,
  'Yahoo/AOL': 500,
  'Zoho': 300,
  'iCloud': 200,
  'Proton Mail': 300,
  'Fastmail': 800,
  // Transactional ESPs — plan-dependent, advisory.
  'Mailgun': 5000, 'Mailjet': 5000, 'Brevo': 5000,
  // Hosting / self-hosted — conservative.
  'GoDaddy': 500, 'IONOS': 1000, 'OVH': 500, 'Rackspace': 10000, 'Namecheap': 500,
  'Network Solutions': 500, 'HostGator': 500, 'Bluehost': 500, 'Hostinger': 300,
  'SiteGround': 400, 'Intermedia': 2000,
  'cPanel/Exim': 500, 'Zimbra': 2000, 'Postfix': 1000,
  'Naver': 300, 'Daum': 300, 'UOL': 300, 'Terra': 300,
  'Comcast': 1000, 'AT&T': 1000, 'Verizon': 500, 'Orange': 300, 'Free': 200,
  'BT': 300, 'Libero': 300, 'Seznam': 300, 'Mail.ru': 300, 'Yandex': 500,
  'GMX/Web.de': 300, 'NetEase': 300, 'Tencent Exmail': 500, 'Alibaba Mail': 1000,
};
const DEFAULT_CAP = 300;

/** A geometric-ish ramp from start to cap over `days` (each day no more than ~2x). */
function buildRamp(start, cap, days) {
  if (cap <= start) return [cap];
  const ramp = [];
  let v = start;
  for (let d = 0; d < days; d++) {
    ramp.push(Math.min(cap, Math.round(v)));
    if (v >= cap) break;
    v = Math.min(cap, v * 1.6);
  }
  if (ramp[ramp.length - 1] < cap) ramp.push(cap);
  return ramp;
}

export function warmupRecommendation(result) {
  if (!result || result.status === 'dead') return null;

  const base = String(result.provider || '').split(' — ')[0];
  let cap = PROVIDER_DAILY_CAP[base] ?? DEFAULT_CAP;
  const notes = [];

  if (result.status === 'limited' || result.limited) {
    cap = Math.min(cap, 50);
    notes.push('server is already rate/quota-limiting — keep volume very low and warm up slowly');
  }
  if (result.limitProbe?.tripped) {
    const at = Number(result.limitProbe.at) || 1;
    cap = Math.min(cap, Math.max(20, at * 20));
    notes.push(`throttling detected around message ${at} in the probe`);
  }

  const startVolume = Math.max(10, Math.min(50, Math.round(cap * 0.1)));
  const rampDays = cap <= 100 ? 3 : cap <= 1000 ? 10 : 14;
  const ramp = buildRamp(startVolume, cap, rampDays);
  const note = notes.join('; ') || `advisory: start ~${startVolume}/day, ramp to ~${cap}/day over ~${rampDays} days`;
  return { dailyCap: cap, startVolume, rampDays, ramp, note };
}
