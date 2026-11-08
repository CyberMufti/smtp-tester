/**
 * Generates smart password mutations based on the base password, username, and domain.
 * Real people rarely use the exact leaked password; they append years, symbols, or capitalize it.
 */
export function generateMutations(basePass, user) {
  if (!basePass) return [];
  const pass = String(basePass);
  const userPart = user ? user.split('@')[0] : '';
  const domainPart = user ? user.split('@')[1] : '';
  const domainBase = domainPart ? domainPart.split('.')[0] : '';

  const set = new Set();

  // 1. Appending numbers & symbols
  const suffixes = ['1', '12', '123', '1234', '!', '!!', '!@#', '2024', '2025', '@'];
  for (const s of suffixes) set.add(pass + s);

  // 2. Prepending numbers & symbols
  const prefixes = ['!', '@', '1', '123'];
  for (const p of prefixes) set.add(p + pass);

  // 3. Capitalization changes
  set.add(pass.charAt(0).toUpperCase() + pass.slice(1));
  set.add(pass.toUpperCase());

  // 4. Combining with username or domain
  if (userPart) {
    set.add(pass + userPart);
    set.add(userPart + pass);
  }
  if (domainBase) {
    set.add(pass + domainBase);
    set.add(pass + domainBase + '1');
  }

  // 5. Leetspeak (replace letters with numbers)
  if (pass.length > 2) {
    const l33t = pass.replace(/a/gi, '@').replace(/e/gi, '3').replace(/i/gi, '1').replace(/o/gi, '0').replace(/s/gi, '$');
    if (l33t !== pass) {
      set.add(l33t);
      set.add(l33t + '1'); // Common combo
    }
  }

  // Remove the base password (we already tested it) and cap at 25 mutations.
  // Lockout protection means at most 2-3 will actually fire per account, so
  // the cap is mostly a generation-side guard against runaway arrays.
  set.delete(pass);
  return Array.from(set).slice(0, 25);
}
