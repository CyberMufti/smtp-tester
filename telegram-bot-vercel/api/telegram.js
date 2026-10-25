import { sign as cryptoSign, createPrivateKey } from 'node:crypto';

/**
 * Telegram license bot as a Vercel serverless webhook.
 *
 * Telegram POSTs each update here. The function signs machine-bound license
 * keys with the owner's Ed25519 private key (from env) and talks back to the
 * user via the Bot API. No long-running process, no server to babysit.
 *
 * Required env vars (set in Vercel):
 *   TELEGRAM_BOT_TOKEN       - bot token from @BotFather
 *   ADMIN_CHAT_IDS           - comma-separated admin Telegram ids
 *   LICENSE_PRIVATE_KEY_B64  - base64 of owner-keys/private.pem
 *   TELEGRAM_WEBHOOK_SECRET  - shared secret; Telegram echoes it in a header
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMINS = (process.env.ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const PRIVATE_KEY = process.env.LICENSE_PRIVATE_KEY_B64
  ? Buffer.from(process.env.LICENSE_PRIVATE_KEY_B64, 'base64').toString('utf8')
  : '';

const API = `https://api.telegram.org/bot${TOKEN}`;
const isAdmin = (id) => ADMINS.includes(String(id));

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function issueLicense(hwid, expMs = null) {
  const payload = JSON.stringify({ hwid, exp: expMs });
  const sig = cryptoSign(null, Buffer.from(payload, 'utf8'), createPrivateKey(PRIVATE_KEY));
  return `SPL1.${b64url(payload)}.${b64url(sig)}`;
}

function normalizeHwid(text) {
  const t = String(text || '').trim().toUpperCase().replace(/\s+/g, '');
  return /^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/.test(t) ? t : null;
}

async function tg(method, body) {
  await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const send = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

function approvalKeyboard(hwid, requesterChatId) {
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

  if (text === '/whoami') return send(chatId, `Your chat id is <code>${chatId}</code>`);
  if (text === '/start') {
    return send(
      chatId,
      'Welcome. Open <b>SMTP Tester</b>, copy your <b>Hardware ID (HWID)</b> from the activation screen, and send it here to request a license.',
    );
  }
  if (text.startsWith('/issue')) {
    if (!isAdmin(chatId)) return send(chatId, 'Not authorized.');
    const parts = text.split(/\s+/).slice(1);
    const hwid = normalizeHwid(parts[0] || '');
    const days = Number(parts[1]) || 0;
    if (!hwid) return send(chatId, 'Usage: /issue &lt;HWID&gt; [days]');
    return send(chatId, `License for <code>${hwid}</code>:\n\n<code>${issueLicense(hwid, days ? Date.now() + days * 86400000 : null)}</code>`);
  }

  const hwid = normalizeHwid(text);
  if (hwid) {
    if (isAdmin(chatId)) {
      return send(chatId, `License for <code>${hwid}</code>:\n\n<code>${issueLicense(hwid)}</code>`);
    }
    await send(chatId, `Thanks! Your request for <code>${hwid}</code> was sent for approval. You'll get your key here.`);
    for (const admin of ADMINS) {
      await send(admin, `License request from ${who} (<code>${chatId}</code>)\nHWID: <code>${hwid}</code>`, {
        reply_markup: approvalKeyboard(hwid, chatId),
      });
    }
    return undefined;
  }

  return send(chatId, 'Send me your Hardware ID (HWID), e.g. <code>16DA-426B-8DEA-32BA-1A4F-939A</code>.');
}

async function handleCallback(cq) {
  const pressedBy = cq.from?.id;
  const data = cq.data || '';
  const [action, a] = data.split('|');
  if (!isAdmin(pressedBy)) {
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not authorized', show_alert: true });
  }

  if (action === 'a') {
    const days = Number(a) || 0;
    const requester = data.split('|')[2];
    const hwid = data.split('|').slice(3).join('|');
    const key = issueLicense(hwid, days ? Date.now() + days * 86400000 : null);
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('SMTP Tester license bot is running.');
  if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
    return res.status(401).send('unauthorized');
  }
  try {
    const update = req.body;
    if (update?.message) await handleMessage(update.message);
    else if (update?.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error('handler error:', err?.message);
  }
  return res.status(200).json({ ok: true });
}
