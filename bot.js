/* ============================================================
   GIFT FESTI APP — Telegram bot
   - /start   -> xush kelibsiz xabari + Mini App tugmasi (referral start param bilan)
   - /admin90 -> admin panel (statistika, hammaga xabar yuborish)
   Asosiy o'yin mantig'i server.js da. Botni alohida process sifatida
   ishga tushiring (masalan alohida Railway xizmati sifatida).
   ============================================================ */
require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || ''; // masalan: https://sizning-domen.up.railway.app
const SERVER_URL = process.env.SERVER_URL || WEBAPP_URL || 'http://localhost:3000';
const INTERNAL_KEY = process.env.INTERNAL_KEY || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN .env faylida ko\'rsatilmagan. bot.js ishga tushmaydi.');
  process.exit(1);
}
if (!WEBAPP_URL) {
  console.warn('OGOHLANTIRISH: WEBAPP_URL sozlanmagan — Mini App tugmasi ishlamaydi.');
}
if (!INTERNAL_KEY) {
  console.warn('OGOHLANTIRISH: INTERNAL_KEY sozlanmagan — /admin90 statistikasi ishlamaydi.');
}
if (!ADMIN_IDS.length) {
  console.warn('OGOHLANTIRISH: ADMIN_IDS bo\'sh — hech kim /admin90 ni ishlata olmaydi.');
}

function apiCall(method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function sendMessage(chatId, text, extra = {}) {
  return apiCall('sendMessage', { chat_id: chatId, text, ...extra });
}
function answerCallback(id, text) {
  return apiCall('answerCallbackQuery', { callback_query_id: id, text, show_alert: false });
}
function isAdmin(userId) { return ADMIN_IDS.includes(String(userId)); }

/* ---- server.js dagi ichki API bilan gaplashish (voucherlar uchun) ---- */
function internalApiGet(pathName) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, SERVER_URL);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(url, { headers: { 'x-internal-key': INTERNAL_KEY } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}
function internalApiPost(pathName, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, SERVER_URL);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const data = JSON.stringify(payload);
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-internal-key': INTERNAL_KEY },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ---- Telegram kanal/chatga a'zolikni tekshirish (voucher shartlari uchun) ---- */
function toTelegramChatId(target) {
  if (!target) return target;
  const m = String(target).match(/t\.me\/([A-Za-z0-9_]+)/);
  if (m) return '@' + m[1];
  return target;
}
async function isUserSubscribed(target, userId) {
  try {
    const res = await apiCall('getChatMember', { chat_id: toTelegramChatId(target), user_id: userId });
    if (!res.ok) return false;
    return ['creator', 'administrator', 'member'].includes(res.result.status);
  } catch (e) { return false; }
}

function voucherDisplayName(from) {
  const parts = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return parts || (from.username ? '@' + from.username : `user${from.id}`);
}

function voucherRequireButton(v) {
  const target = String(v.requireTarget || '');
  let url;
  if (target.startsWith('http')) url = target;
  else if (target.startsWith('@')) url = `https://t.me/${target.slice(1)}`;
  else url = `https://t.me/${target}`;
  const labelMap = { channel: "📢 Kanalga o'tish", chat: "💬 Chatga o'tish", bot: "🤖 Botni ishga tushirish" };
  return { text: labelMap[v.requireType] || "O'tish", url };
}

async function sendVoucherRequirement(chatId, voucherId, v) {
  await sendMessage(chatId,
    `🎁 Voucherni olish uchun avval quyidagi shartni bajaring:\n\n${v.requireLabel || ''}\n\nBajargach "✅ Tekshirish" tugmasini bosing.`,
    {
      reply_markup: {
        inline_keyboard: [
          [voucherRequireButton(v)],
          [{ text: '✅ Tekshirish', callback_data: `voucher:check:${voucherId}` }],
        ],
      },
    });
}

async function claimVoucherNow(chatId, userId, username, voucherId) {
  let result;
  try {
    result = await internalApiPost('/api/internal_voucher_claim', { voucherId, userId, username });
  } catch (e) {
    return sendMessage(chatId, "⚠️ Xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
  }
  if (!result || result.error === 'NOT_FOUND') return sendMessage(chatId, "⚠️ Bu voucher topilmadi yoki muddati o'tgan.");
  if (result.error === 'EXHAUSTED') return sendMessage(chatId, "😔 Afsuski, bu voucherning barcha aktivatsiyalari tugagan.");
  if (result.error === 'ALREADY_USED') return sendMessage(chatId, "ℹ️ Siz bu voucherni allaqachon ishlatgansiz.");
  if (result.error === 'NOT_SUBSCRIBED') {
    return sendVoucherRequirement(chatId, voucherId, result);
  }
  if (result.ok) {
    return sendMessage(chatId,
      `🎉 Tabriklaymiz! Sizga *${result.reward} coin* berildi.\n\n💰 Joriy balansingiz: *${result.balance}*`,
      { parse_mode: 'Markdown' });
  }
  return sendMessage(chatId, "⚠️ Xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
}

async function handleVoucherStart(msg, voucherId) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = voucherDisplayName(msg.from);

  const info = await internalApiGet(`/api/internal_voucher_info?id=${encodeURIComponent(voucherId)}`);
  if (!info || info.error) return sendMessage(chatId, "⚠️ Bu voucher topilmadi yoki muddati o'tgan.");
  if (info.used >= info.maxUses) return sendMessage(chatId, "😔 Afsuski, bu voucherning barcha aktivatsiyalari tugagan.");

  if (info.requireType) return sendVoucherRequirement(chatId, voucherId, info);
  return claimVoucherNow(chatId, userId, username, voucherId);
}

async function handleVoucherCheck(chatId, userId, username, voucherId) {
  const info = await internalApiGet(`/api/internal_voucher_info?id=${encodeURIComponent(voucherId)}`);
  if (!info || info.error) return sendMessage(chatId, "⚠️ Bu voucher topilmadi yoki muddati o'tgan.");
  if (info.used >= info.maxUses) return sendMessage(chatId, "😔 Afsuski, bu voucherning barcha aktivatsiyalari tugagan.");

  if (info.requireType === 'channel' || info.requireType === 'chat') {
    const subscribed = await isUserSubscribed(info.requireTarget, userId);
    if (!subscribed) {
      await sendMessage(chatId, "❗️ Hali shart bajarilmadi. Iltimos avval qo'shiling, so'ngra qayta tekshiring.");
      return sendVoucherRequirement(chatId, voucherId, info);
    }
  }
  // requireType 'bot' — tashqi botni tekshirib bo'lmaydi, shuning uchun
  // foydalanuvchi "✅ Tekshirish" bosgani ishonch sifatida qabul qilinadi.
  return claimVoucherNow(chatId, userId, username, voucherId);
}

/* ============================================================
   Botga /start yozgan barcha chat ID'lar (broadcast uchun kerak)
   ============================================================ */
const CHATIDS_FILE = path.join(__dirname, 'chatids.json');
let chatIds = new Set();
function loadChatIds() {
  if (fs.existsSync(CHATIDS_FILE)) {
    try { chatIds = new Set(JSON.parse(fs.readFileSync(CHATIDS_FILE, 'utf8'))); }
    catch (e) { console.error('chatids.json o\'qishda xatolik:', e.message); }
  }
}
function saveChatIds() { fs.writeFileSync(CHATIDS_FILE, JSON.stringify(Array.from(chatIds))); }
loadChatIds();

const awaitingBroadcast = new Set();

/* ============================================================
   /start
   ============================================================ */
async function handleStart(msg) {
  chatIds.add(msg.chat.id);
  saveChatIds();

  const parts = msg.text.split(' ');
  const startParam = parts[1] || '';

  if (startParam.startsWith('voucher_')) {
    return handleVoucherStart(msg, startParam.slice('voucher_'.length));
  }

  let url = WEBAPP_URL;
  if (startParam) url += (url.includes('?') ? '&' : '?') + `startapp=${encodeURIComponent(startParam)}`;

  await sendMessage(msg.chat.id,
    "🎁 GIFT FESTI ga xush kelibsiz!\n\nKunlik case oching, xokkey/baraban/team battle o'ynang va yulduzlar (⭐) yig'ing.",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "🎮 O'yinni ochish", web_app: { url } }]],
      },
    });
}

/* ============================================================
   /admin90 — admin panel
   ============================================================ */
function sendAdminPanel(chatId) {
  return sendMessage(chatId, '🛠 *Admin panel*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Statistika', callback_data: 'admin:stats' }],
        [{ text: '📢 Xabar yuborish', callback_data: 'admin:broadcast' }],
      ],
    },
  });
}

function fetchStats() {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/internal_stats', SERVER_URL);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(url, { headers: { 'x-internal-key': INTERNAL_KEY } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) return reject(new Error(data.error || `HTTP ${res.statusCode}`));
          resolve(data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function handleStats(chatId) {
  try {
    const s = await fetchStats();
    const gameLine = (label, g) => `${label} — ${g.round}-raund, ${g.status}, hozir ${g.players} kishi tikkan`;
    const text =
      `📊 *Statistika*\n\n` +
      `👥 Foydalanuvchilar: *${s.totalUsers}*\n` +
      `⭐ Umumiy yulduzlar: *${s.totalStars}*\n` +
      `🛡 Adminlar: *${s.adminCount}*\n\n` +
      `📋 Vazifalar soni: *${s.tasksCount}*\n` +
      `🎟 Faol promokodlar: *${s.activePromos}*\n` +
      `🎁 Faol voucherlar: *${s.activeVouchers ?? 0}*\n\n` +
      `🏒 ${gameLine('Xokkey', s.hockey)}\n` +
      `🥁 ${gameLine('Baraban', s.drum)}\n` +
      `⚔️ ${gameLine('Team Battle', s.teamBattle)}\n\n` +
      `📩 Botga start bosganlar: *${chatIds.size}*`;
    await sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    await sendMessage(chatId, `⚠️ Statistikani olishda xatolik: ${e.message}\n\nServer ishlab turganini va INTERNAL_KEY server.js bilan bot.js da bir xil ekanini tekshiring.`);
  }
}

async function startBroadcastFlow(chatId) {
  awaitingBroadcast.add(chatId);
  await sendMessage(chatId, "📢 Hammaga yubormoqchi bo'lgan xabaringizni yozing.\n\nBekor qilish uchun /bekor yozing.");
}

async function broadcastToAll(fromChatId, text) {
  const ids = Array.from(chatIds);
  let ok = 0, fail = 0;
  await sendMessage(fromChatId, `⏳ ${ids.length} kishiga yuborilyapti...`);
  for (const id of ids) {
    try {
      const res = await sendMessage(id, text);
      if (res.ok) ok++; else fail++;
    } catch (e) { fail++; }
    await new Promise(r => setTimeout(r, 40)); // flood-limitga tushmaslik uchun
  }
  await sendMessage(fromChatId, `✅ Xabar yuborildi.\n\nMuvaffaqiyatli: ${ok}\nXatolik: ${fail}`);
}

/* ============================================================
   Yangilanishlarni qabul qilish
   ============================================================ */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  if (text.startsWith('/start')) return handleStart(msg);

  if (text.startsWith('/admin90')) {
    if (!isAdmin(userId)) return;
    return sendAdminPanel(chatId);
  }

  if (text.startsWith('/bekor')) {
    if (awaitingBroadcast.has(chatId)) {
      awaitingBroadcast.delete(chatId);
      return sendMessage(chatId, '❌ Bekor qilindi.');
    }
    return;
  }

  if (isAdmin(userId) && awaitingBroadcast.has(chatId) && text) {
    awaitingBroadcast.delete(chatId);
    return broadcastToAll(chatId, text);
  }
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;

  if (cq.data && cq.data.startsWith('voucher:check:')) {
    await answerCallback(cq.id);
    const voucherId = cq.data.slice('voucher:check:'.length);
    const username = voucherDisplayName(cq.from);
    return handleVoucherCheck(chatId, userId, username, voucherId);
  }

  if (!isAdmin(userId)) return answerCallback(cq.id, "Sizda ruxsat yo'q.");
  await answerCallback(cq.id);
  if (cq.data === 'admin:stats') return handleStats(chatId);
  if (cq.data === 'admin:broadcast') return startBroadcastFlow(chatId);
}

async function handleUpdate(update) {
  if (update.message) return handleMessage(update.message);
  if (update.callback_query) return handleCallback(update.callback_query);
}

let offset = 0;
async function poll() {
  try {
    const res = await apiCall('getUpdates', { offset, timeout: 30 });
    if (res.ok) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        handleUpdate(update).catch((e) => console.error('Update ishlov berishda xatolik:', e.message));
      }
    }
  } catch (e) {
    console.error('getUpdates xatoligi:', e.message);
  }
  setTimeout(poll, 500);
}

console.log("GIFT FESTI bot ishga tushdi (long polling). /start va /admin90 buyruqlarini kuting...");
poll();
