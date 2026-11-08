import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRandomTemplate } from '../src/core/templates.js';

// Hidden text (invisible token, white-on-white, zero size) is a spam signal
// that hurts deliverability — the test message must never use it.
const HIDDEN_PATTERNS = [
  /font-size:\s*0\b/i,
  /font-size:\s*1px/i,
  /opacity:\s*0\b/i,
  /color:\s*#fff(f{3})?\b/i,
  /display:\s*none/i,
  /visibility:\s*hidden/i,
];

test('templates embed the token visibly and contain no hidden/invisible text', () => {
  for (let i = 0; i < 50; i++) {
    const tpl = getRandomTemplate();
    assert.ok(tpl.subject && typeof tpl.subject === 'string', 'subject present');
    assert.ok(tpl.html.includes('{token}'), 'html carries the {token} placeholder');
    const html = tpl.html.replace('{token}', 'SMTPTEST-1-2-3-abc');
    assert.ok(html.includes('SMTPTEST-1-2-3-abc'), 'token renders into the body');
    for (const p of HIDDEN_PATTERNS) {
      assert.ok(!p.test(html), `template must not hide text (${p})`);
    }
  }
});
