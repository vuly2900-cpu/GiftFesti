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
      `🎟 Faol promokodlar: *${s.activePromos}*\n\n` +
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
