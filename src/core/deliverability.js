/**
 * Fuse the per-result deliverability signals the tester already computes —
 * inbox/spam placement, SPF, DMARC, DNSBL blacklisting, and the content spam
 * score — into a single 0–100 deliverability score and an A–F grade, with a
 * breakdown of the factors. Pure; takes a tester Result.
 *
 * "Dead" has no score (it never sends). When deliverability checks weren't run,
 * the score still reflects placement/status so it's always meaningful.
 *
 * @param {object} result a tester Result
 * @returns {{score:number, grade:string, factors:{delta:number,label:string}[]}|null}
 */
export function deliverabilityScore(result) {
  if (!result || result.status === 'dead') return null;

  const factors = [];
  let score = 55; // neutral baseline (accepted-and-sent, nothing else known)
  const add = (delta, label) => {
    const d = Math.round(delta);
    if (!d) return;
    score += d;
    factors.push({ delta: d, label });
  };

  // Placement — the strongest real-world signal.
  switch (result.status) {
    case 'inbox': add(35, 'Landed in inbox'); break;
    case 'spam': add(-35, 'Landed in spam'); break;
    case 'unverified': add(-10, 'Sent but SPF/DMARC missing'); break;
    case 'limited': add(-10, 'Rate/quota-limited'); break;
    case 'unknown': add(-5, 'Placement unconfirmed'); break;
    default: break; // 'valid' — accepted, no placement data
  }

  const d = result.deliverability || {};

  if (d.spf) {
    if (d.spf.found && d.spf.result === 'pass') add(12, 'SPF passes');
    else if (d.spf.found && d.spf.result === 'fail') add(-15, 'SPF fails (-all)');
    else if (d.spf.found && (d.spf.result === 'softfail' || d.spf.result === 'neutral')) add(3, 'SPF soft/neutral');
    else if (d.spf.found) add(6, 'SPF present');
    else add(-12, 'No SPF record');
  }

  if (d.dmarc) {
    if (d.dmarc.found && (d.dmarc.policy === 'reject' || d.dmarc.policy === 'quarantine')) add(12, `DMARC ${d.dmarc.policy}`);
    else if (d.dmarc.found) add(6, 'DMARC present (p=none)');
    else add(-12, 'No DMARC record');
  }

  if (d.dnsbl && d.dnsbl.ip) {
    if (d.dnsbl.listed) add(Math.max(-24, -8 * (d.dnsbl.lists?.length || 1)), `Blacklisted on ${d.dnsbl.lists?.length || 1} list(s)`);
    else add(5, 'Not blacklisted');
  }

  const sc = result.spamScore;
  if (sc && typeof sc.score === 'number') {
    const max = sc.max || 13;
    add(8 - (sc.score / max) * 16, `Content spam score ${sc.score}/${max}`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade, factors };
}
