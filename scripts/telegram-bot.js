#!/usr/bin/env node
/**
 * Owner-side Telegram license bot.
 *
 * Runs wherever your private key lives (your PC/server) — NEVER ship it to
 * users. A user sends their HWID to the bot; you get a message with
 * Approve/Deny buttons; one tap signs a license and the bot delivers the key
 * straight to the user. You can also issue directly with `/issue <HWID> [days]`.
 *
 * Setup:
 *   1. Create a bot with @BotFather on Telegram, copy its token.
 *   2. Find your numeric Telegram id: message the bot `/whoami` (it replies with
 *      your chat id), or use @userinfobot.
 *   3. Run:
 *        TELEGRAM_BOT_TOKEN=123:ABC ADMIN_CHAT_IDS=111111111 node scripts/telegram-bot.js
 *      (ADMIN_CHAT_IDS is comma-separated if you have more than one admin.)
 *
 * Dependency-free: uses the Telegram Bot API over fetch with long polling.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { issueLicense } from '../src/core/license.js';
import { normalizeHwid } from '../src/core/hwid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMINS = (process.env.ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!TOKEN) {
  console.error('Set TELEGRAM_BOT_TOKEN (from @BotFather).');
  process.exit(1);
}
if (!ADMINS.length) {
  console.warn('No ADMIN_CHAT_IDS set yet — message the bot /whoami to get your id, then set it.');
}

let PRIVATE_KEY;
try {
  PRIVATE_KEY = readFileSync(join(__dirname, '..', 'owner-keys', 'private.pem'), 'utf8');
} catch {
  console.error('Could not read owner-keys/private.pem — keep your private key there.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const isAdmin = (id) => ADMINS.includes(String(id));

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const send = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

function mint(hwid, days) {
  const expMs = days ? Date.now() + days * 86400000 : null;
  return issueLicense(hwid, PRIVATE_KEY, { expMs });
}

function approvalKeyboard(hwid, requesterChatId) {
  // callback_data must stay under 64 bytes: a|<days>|<requester>|<hwid>
  const mk = (days, label) => ({ text: label, callback_data: `a|${days}|${requesterChatId}|${hwid}` });
  return {
    inline_keyboard: [
      [mk(0, '✅ Activate (never expires)'), mk(30, '✅ 30 days')],
      [{ text: '❌ Deny', callback_data: `d|${requesterChatId}` }],
    ],
  };
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const who = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'user';

  if (text === '/whoami') {
    return send(chatId, `Your chat id is <code>${chatId}</code>`);
  }
  if (text === '/start') {
    return send(
      chatId,
      'Welcome. Open <b>SMTP Tester</b>, copy your <b>Hardware ID (HWID)</b> from the activation screen, and send it here to request a license.',
    );
  }

  // Admin shortcut: /issue <HWID> [days]
  if (text.startsWith('/issue')) {
    if (!isAdmin(chatId)) return send(chatId, 'Not authorized.');
    const parts = text.split(/\s+/).slice(1);
    const hwid = normalizeHwid(parts[0] || '');
    const days = Number(parts[1]) || 0;
    if (!hwid) return send(chatId, 'Usage: /issue &lt;HWID&gt; [days]');
    return send(chatId, `License for <code>${hwid}</code>:\n\n<code>${mint(hwid, days)}</code>`);
  }

  const hwid = normalizeHwid(text);
  if (hwid) {
    if (isAdmin(chatId)) {
      // An admin pasting a bare HWID just gets the key immediately.
      return send(chatId, `License for <code>${hwid}</code>:\n\n<code>${mint(hwid, 0)}</code>`);
    }
    // A user requesting — tell them, and ping every admin with Approve/Deny.
    await send(chatId, `Thanks! Your request for <code>${hwid}</code> was sent for approval. You'll get your key here.`);
    for (const admin of ADMINS) {
      await send(admin, `License request from ${who} (<code>${chatId}</code>)\nHWID: <code>${hwid}</code>`, {
        reply_markup: approvalKeyboard(hwid, chatId),
      });
    }
    if (!ADMINS.length) await send(chatId, 'No admin is configured yet — please try again shortly.');
    return undefined;
  }

  return send(chatId, 'Send me your Hardware ID (HWID), e.g. <code>16DA-426B-8DEA-32BA-1A4F-939A</code>.');
}

async function handleCallback(cq) {
  const pressedBy = cq.from?.id;
  const [action, a, b] = (cq.data || '').split('|');
  if (!isAdmin(pressedBy)) {
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not authorized', show_alert: true });
  }

  if (action === 'a') {
    const days = Number(a) || 0;
    const requester = b;
    const hwid = cq.data.split('|').slice(3).join('|'); // hwid is the remainder
    const key = mint(hwid, days);
    await send(requester, `✅ Your license is activated!\n\nPaste this key into SMTP Tester:\n\n<code>${key}</code>`);
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Activated ✓' });
    return tg('editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: `${cq.message.text}\n\n✅ Activated (${days ? days + ' days' : 'never expires'}) and sent to the user.`,
      parse_mode: 'HTML',
    });
  }

  if (action === 'd') {
    const requester = a;
    await send(requester, '❌ Your license request was declined. Contact @splean_tool for details.');
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Denied' });
    return tg('editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: `${cq.message.text}\n\n❌ Denied.`,
      parse_mode: 'HTML',
    });
  }
  return tg('answerCallbackQuery', { callback_query_id: cq.id });
}

async function main() {
  const me = await tg('getMe', {});
  console.log(`License bot running as @${me.result?.username}. Admins: ${ADMINS.join(', ') || '(none yet — /whoami)'}`);
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await tg('getUpdates', { offset, timeout: 30 });
      for (const u of res.result || []) {
        offset = u.update_id + 1;
        try {
          if (u.message) await handleMessage(u.message);
          else if (u.callback_query) await handleCallback(u.callback_query);
        } catch (err) {
          console.error('handler error:', err.message);
        }
      }
    } catch (err) {
      console.error('poll error:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main();
