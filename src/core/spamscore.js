/**
 * Lightweight heuristic content spam-scorer.
 *
 * This is NOT SpamAssassin — it's a fast, transparent set of heuristics that
 * flags the content patterns most likely to hurt inbox placement. Use it to
 * sanity-check your own campaign copy (paste it in the UI), not as a guarantee
 * of how a specific provider will score a message.
 *
 * @typedef {{score:number, max:number, level:('low'|'medium'|'high'), reasons:string[]}} SpamScore
 */

const TRIGGERS = [
  'free', 'winner', 'guarantee', 'act now', 'limited time', 'click here',
  'risk-free', 'cash', 'earn money', 'viagra', 'order now', 'buy now',
  'cheap', 'prize', 'congratulations', 'urgent', 'no cost', 'credit card',
  '$$$', 'double your', 'extra income', 'this is not spam',
];

const SHORTENERS = ['bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly'];

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const MAX_SCORE = 13;

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

/** @param {{subject?:string, text?:string, html?:string}} content @returns {SpamScore} */
export function scoreContent({ subject = '', text = '', html = '' } = {}) {
  const reasons = [];
  let score = 0;

  const bodyText = `${text}\n${stripHtml(html)}`;
  const haystack = `${subject}\n${bodyText}`.toLowerCase();

  const subjectLetters = subject.replace(/[^a-z]/gi, '');
  if (subjectLetters.length >= 4 && subject === subject.toUpperCase()) {
    score += 2;
    reasons.push('Subject is in ALL CAPS');
  }

  const exclam = (subject.match(/!/g) || []).length + (bodyText.match(/!/g) || []).length;
  if (exclam >= 3) {
    score += 1;
    reasons.push(`Excessive exclamation marks (${exclam})`);
  }

  const matched = TRIGGERS.filter((t) => haystack.includes(t));
  if (matched.length) {
    score += Math.min(matched.length, 5);
    reasons.push(`Spam trigger words: ${matched.join(', ')}`);
  }

  const textUrls = (bodyText.match(URL_RE) || []).length;
  const htmlHrefs = (html.match(/href\s*=\s*["'][^"']+["']/gi) || []).length;
  const linkCount = Math.max(textUrls, htmlHrefs);
  if (linkCount > 10) {
    score += 2;
    reasons.push(`Many links (${linkCount})`);
  }

  if (SHORTENERS.some((s) => haystack.includes(s))) {
    score += 2;
    reasons.push('Shortened URLs present (bit.ly, t.co, …)');
  }

  const imgCount = (html.match(/<img/gi) || []).length;
  const visibleLen = stripHtml(html).replace(/\s+/g, ' ').trim().length + text.trim().length;
  if (imgCount >= 1 && visibleLen < 20) {
    score += 2;
    reasons.push('Image-heavy with very little text');
  }

  const hasLinks = linkCount > 0 || imgCount > 0;
  if (hasLinks && !haystack.includes('unsubscribe')) {
    score += 1;
    reasons.push('No unsubscribe link in a message with links/images');
  }

  score = Math.min(score, MAX_SCORE);
  const level = score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low';
  return { score, max: MAX_SCORE, level, reasons };
}
