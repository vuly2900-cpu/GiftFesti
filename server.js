/* ============================================================
   GIFT FESTI APP — to'liq backend (Firebase O'RNIGA)
   Express (REST API) + Socket.io (real-vaqt o'yin holati)
   Frontend (public/index.html) shu server bilan bitta portda serve qilinadi.
   ============================================================ */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const MAIN_CHANNEL = process.env.MAIN_CHANNEL || '@GiftFesti';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INTERNAL_KEY = process.env.INTERNAL_KEY || '';
const WEBAPP_URL = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
const DB_FILE = path.join(__dirname, 'db.json');
const REFERRAL_REWARD = 10;
const CASE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/* ============================================================
   MA'LUMOTLAR BAZASI (in-memory, db.json ga davriy saqlanadi)
   ============================================================ */
const users = new Map();     // id(string) -> user
const friends = new Map();   // referrerId(string) -> [{id,username,photo_url,joined_at,stars}]
let tasks = [];              // [{id, channel_link, channel_title, stars_reward}]
let promos = [];             // [{code, reward, maxUses, used, usedBy:Set}]
let vouchers = [];           // [{id, reward, maxUses, used, usedBy:Set, requireType, requireTarget, requireLabel, createdAt}]
const gameHistory = { hockey: [], drum: [], team_battle: [], crash: [] };

function createUser(id, username) {
  return {
    id, username, photo_url: null,
    balance: 100, total_won: 0, wins: 0,
    completedTasks: new Set(),
    lastCaseOpenedAt: null,
    referredBy: null,
    referralRewarded: false,
    isAdmin: ADMIN_IDS.includes(String(id)),
    nftInventory: {},      // itemId(NFT_CATALOG dagi) -> dona soni
    nftInstancePrices: {}, // itemId -> [narx1, narx2, ...] (raketa o'yinidan yutilgan NFT'larning haqiqiy narxi)
    nftInitialized: false, // starter (tekin) NFT'lar berilganmi
  };
}
function serializeUser(u) {
  return {
    telegram_id: Number(u.id),
    username: u.username,
    photo_url: u.photo_url,
    balance: u.balance,
    total_won: u.total_won,
    wins: u.wins,
    completed_tasks: Array.from(u.completedTasks),
    lastCaseOpenedAt: u.lastCaseOpenedAt ? { seconds: Math.floor(u.lastCaseOpenedAt / 1000) } : null,
    isAdmin: u.isAdmin,
  };
}

/* ---- saqlash / yuklash ---- */
function serializeState() {
  return {
    users: Array.from(users.values()).map(u => ({ ...u, completedTasks: Array.from(u.completedTasks) })),
    friends: Array.from(friends.entries()),
    tasks,
    promos: promos.map(p => ({ ...p, usedBy: Array.from(p.usedBy) })),
    vouchers: vouchers.map(v => ({ ...v, usedBy: Array.from(v.usedBy) })),
    gameHistory,
    gameNumbers: { hockey: hockeyState.game_number, drum: drumState.game_number, team_battle: teamState.game_number },
  };
}
function saveDb() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(serializeState(), null, 2)); }
  catch (e) { console.error('DB saqlashda xatolik:', e.message); }
}
function loadDb() {
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    (data.users || []).forEach(u => {
      users.set(String(u.id), {
        ...u,
        completedTasks: new Set(u.completedTasks || []),
        nftInventory: u.nftInventory || {},
        nftInstancePrices: u.nftInstancePrices || {},
        nftInitialized: u.nftInitialized || false,
      });
    });
    (data.friends || []).forEach(([k, v]) => friends.set(k, v));
    tasks = data.tasks || [];
    promos = (data.promos || []).map(p => ({ ...p, usedBy: new Set(p.usedBy || []) }));
    vouchers = (data.vouchers || []).map(v => ({ ...v, usedBy: new Set(v.usedBy || []) }));
    if (data.gameHistory) Object.assign(gameHistory, data.gameHistory);
    if (data.gameNumbers) {
      hockeyState.game_number = data.gameNumbers.hockey || 1;
      drumState.game_number = data.gameNumbers.drum || 1;
      teamState.game_number = data.gameNumbers.team_battle || 1;
    }
    console.log(`DB yuklandi: ${users.size} foydalanuvchi, ${tasks.length} vazifa, ${promos.length} promo, ${vouchers.length} voucher`);
  } catch (e) { console.error('DB yuklashda xatolik:', e.message); }
}

/* ============================================================
   YORDAMCHI FUNKSIYALAR
   ============================================================ */
function pickWeighted(players, keyOrFn) {
  const val = (p) => typeof keyOrFn === 'function' ? keyOrFn(p) : p[keyOrFn];
  const total = players.reduce((s, p) => s + val(p), 0);
  let r = Math.random() * total;
  for (const p of players) {
    if (r < val(p)) return p;
    r -= val(p);
  }
  return players[players.length - 1];
}

/* ---- Hockey/drum o'yinlarida bitta o'yinchining umumiy "og'irligi"
   (coin tikkani + tikkan NFT'larining narxi) — g'olibni tanlashda ham,
   ehtimollik (%) ko'rsatishda ham shu ishlatiladi. ---- */
function playerWeight(p) {
  const nftValue = (p.nfts || []).reduce((s, n) => s + n.price, 0);
  return round2((p.stars || 0) + nftValue);
}

const PALETTE = ['#FF6B6B', '#4DABF7', '#69DB7C', '#FFD43B', '#DA77F2', '#FF922B', '#38D9A9', '#F783AC', '#748FFC', '#94D82D'];
function colorFor(idx) { return PALETTE[idx % PALETTE.length]; }

function displayName(tgUser) {
  return [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ')
    || tgUser.username || `Foydalanuvchi${tgUser.id}`;
}

/* ---- Telegram WebApp initData tekshiruvi ---- */
function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckArr = [];
    for (const [k, v] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${k}=${v}`);
    }
    const dataCheckString = dataCheckArr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;
    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (e) { return null; }
}
function parseInitDataUnsafe(initData) {
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (e) { return null; }
}
function getTgUserFromInitData(initData) {
  if (!initData) return null;
  if (BOT_TOKEN) {
    const validated = validateInitData(initData, BOT_TOKEN);
    if (validated) return validated;
    // Imzo noto'g'ri bo'lsa ham, agar BOT_TOKEN hali sozlanmagan bo'lsa
    // (dev muhit) pastga tushmaymiz — xavfsizlik uchun rad etamiz.
    return null;
  }
  return parseInitDataUnsafe(initData); // faqat dev/test uchun (BOT_TOKEN yo'q bo'lsa)
}

/* ---- Telegram kanalga obuna tekshiruvi ---- */
function toChannelId(link) {
  if (!link) return MAIN_CHANNEL;
  const m = String(link).match(/t\.me\/([A-Za-z0-9_]+)/);
  if (m) return '@' + m[1];
  if (link.startsWith('@')) return link;
  return link;
}
async function isSubscribed(telegramUserId, channel) {
  if (!BOT_TOKEN) return true; // dev rejimida har doim "obuna" deb hisoblanadi
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${telegramUserId}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return false;
    return ['creator', 'administrator', 'member'].includes(data.result.status);
  } catch (e) { return false; }
}

/* ---- VOUCHER: kanalga post qilish uchun yordamchi funksiyalar ---- */
let cachedBotUsername = process.env.BOT_USERNAME || null;
async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok && data.result && data.result.username) {
      cachedBotUsername = data.result.username;
      return cachedBotUsername;
    }
  } catch (e) { console.error('getBotUsername xatolik:', e.message); }
  return null;
}

function voucherRequireLabel(v) {
  if (!v.requireType) return null;
  if (v.requireType === 'channel') return `📢 Kanalga obuna: ${v.requireTarget}`;
  if (v.requireType === 'chat') return `💬 Chatga a'zolik: ${v.requireTarget}`;
  if (v.requireType === 'bot') return `🤖 Botni ishga tushirish: ${v.requireTarget}`;
  return null;
}

async function postVoucherToChannel(voucher) {
  if (!BOT_TOKEN) { console.error('Voucher kanalga post qilinmadi: BOT_TOKEN sozlanmagan'); return; }
  const username = await getBotUsername();
  if (!username) { console.error('Voucher kanalga post qilinmadi: bot username aniqlanmadi'); return; }
  if (!WEBAPP_URL) { console.error('Voucher kanalga post qilinmadi: WEBAPP_URL sozlanmagan (rasm uchun kerak)'); return; }

  const deepLink = `https://t.me/${username}?start=voucher_${voucher.id}`;
  const photoUrl = `${WEBAPP_URL}/voucher.png`;
  const reqLabel = voucherRequireLabel(voucher);
  const caption =
    `🎁 *Yangi voucher yaratildi!*\n\n` +
    `🎟 Aktivatsiyalar soni: *${voucher.maxUses}*\n` +
    `⭐ Har bir aktivatsiyaga: *${voucher.reward} coin*` +
    (reqLabel ? `\n\n📌 Shart: ${reqLabel}` : '');

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: MAIN_CHANNEL,
        photo: photoUrl,
        caption,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🎁 Olish uchun bosing', url: deepLink }]] },
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error('Voucherni kanalga post qilishda Telegram xatoligi:', data.description);
  } catch (e) { console.error('Voucherni kanalga post qilishda xatolik:', e.message); }
}

/* ---- Telegram profil rasmini olish (fon rejimida, bloklamaydi) ---- */
async function fetchTelegramPhoto(userId) {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUserProfilePhotos?user_id=${userId}&limit=1`);
    const data = await res.json();
    if (!data.ok || !data.result || !data.result.total_count) return null;
    const fileId = data.result.photos[0][0].file_id;
    const fRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fData = await fRes.json();
    if (!fData.ok) return null;
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${fData.result.file_path}`;
  } catch (e) { return null; }
}
function refreshPhotoAsync(user) {
  fetchTelegramPhoto(user.id).then(url => { if (url) user.photo_url = url; }).catch(() => {});
}

/* ============================================================
   NFT INVENTAR (Telegram premium custom emoji asosida)
   — bu real Telegram NFT/gift emas, faqat ilova ichida beriladigan
   kolleksiya predmeti: sotib qo'shib bo'lmaydi, faqat sotib coin olish
   mumkin. Animatsiya Telegram custom emoji fayli orqali chiziladi.
   ============================================================ */
const NFT_CATALOG = [
  { id: 'lol_pop', name: 'Lol Pop', custom_emoji_id: '5278223019590850728', sell_price: 3.8 },
  { id: 'spy_agaric', name: 'Spy Agaric', custom_emoji_id: '5278253651297600475', sell_price: 5.4 },
  { id: 'witch_hat', name: 'Witch Hat', custom_emoji_id: '5278396652233723315', sell_price: 5 },

  // ---- Case'dan chiqadigan gift'lar (endi coin emas, inventoryga tushadi) ----
  { id: 'teddy', name: 'Ayiqcha', custom_emoji_id: '5278547100643137176', sell_price: 0.13, tier: 15 },
  { id: 'heart_gift', name: 'Yurakcha', custom_emoji_id: '5278414927319566863', sell_price: 0.13, tier: 15 },
  { id: 'gift_box', name: 'Sovg\'a', custom_emoji_id: '5278248132264635804', sell_price: 0.22, tier: 25 },
  { id: 'rose', name: 'Atirgul', custom_emoji_id: '5276522285556080471', sell_price: 0.22, tier: 25 },
  { id: 'cake', name: 'Tort', custom_emoji_id: '5278534529273859992', sell_price: 0.50, tier: 50 },
  { id: 'bouquet', name: 'Gullar', custom_emoji_id: '5278412273029782354', sell_price: 0.50, tier: 50 },
  { id: 'rocket', name: 'Raketa', custom_emoji_id: '5278245624003725921', sell_price: 0.50, tier: 50 },
  { id: 'champagne', name: 'Vino', custom_emoji_id: '5278604064794380612', sell_price: 0.50, tier: 50 },
  { id: 'trophy', name: 'Kubok', custom_emoji_id: '5278692270537739766', sell_price: 1, tier: 100 },
  { id: 'ring', name: 'Uzuk', custom_emoji_id: '5276492074756120077', sell_price: 1, tier: 100 },
  { id: 'diamond', name: 'Olmos', custom_emoji_id: '5278313338458118113', sell_price: 1, tier: 100 },

  // ---- Yangi NFT'lar (hozircha hech kimga berilmaydi — case yoki starter
  // packga qo'shilmagan, keyinchalik qo'lda (masalan admin panel orqali)
  // foydalanuvchi inventoriga qo'shiladi) ----
  { id: 'mood_pack', name: 'Mood Pack', custom_emoji_id: '5278572170367243303', sell_price: 4.4 },
  { id: 'timeless_book', name: 'Timeless Book', custom_emoji_id: '5278733519403649810', sell_price: 4.4 },
  { id: 'fine_pen', name: 'Fine Pen', custom_emoji_id: '5278356498584472070', sell_price: 8.4 },
  { id: 'pool_float', name: 'Pool Float', custom_emoji_id: '5278758099501495237', sell_price: 3.7 },
  { id: 'surge_board', name: 'Surge Board', custom_emoji_id: '5278537162088812151', sell_price: 6.8 },
];
const NFT_BY_ID = new Map(NFT_CATALOG.map(i => [i.id, i]));
const CASE_ITEM_IDS = ['teddy', 'heart_gift', 'gift_box', 'rose', 'cake', 'bouquet', 'rocket', 'champagne', 'trophy', 'ring', 'diamond'];

function ensureNftStarterPack(user) {
  if (!user.nftInventory) user.nftInventory = {};
  if (!user.nftInstancePrices) user.nftInstancePrices = {};
  if (user.nftInitialized) return;
  NFT_CATALOG.forEach(item => {
    if (item.free) user.nftInventory[item.id] = (user.nftInventory[item.id] || 0) + 1;
  });
  user.nftInitialized = true;
}

/* ---- Bitta NFT dona sifatida foydalanuvchi inventoriga qo'shish.
   customPrice berilsa (masalan raketa o'yinida yutilgan bo'lsa), bu dona
   sotilganda katalogdagi standart narx emas, aynan shu narx qo'llanadi. ---- */
function grantNftToUser(user, itemId, customPrice = null) {
  ensureNftStarterPack(user);
  user.nftInventory[itemId] = (user.nftInventory[itemId] || 0) + 1;
  if (customPrice !== null && customPrice !== undefined) {
    if (!user.nftInstancePrices[itemId]) user.nftInstancePrices[itemId] = [];
    user.nftInstancePrices[itemId].push(round2(customPrice));
  }
}

/* ---- Bir martalik migratsiya: eski "bepul starter" NFT'lar (lol_pop,
   spy_agaric, witch_hat) endi tarqatilmaydi — hozirda mavjud bo'lgan
   foydalanuvchilarning ushbu 3ta NFT soni 0 ga tushiriladi. ---- */
const RETIRED_STARTER_NFT_IDS = ['lol_pop', 'spy_agaric', 'witch_hat'];
function resetRetiredStarterNfts() {
  users.forEach(u => {
    if (!u.nftInventory) return;
    RETIRED_STARTER_NFT_IDS.forEach(id => {
      if (u.nftInventory[id]) u.nftInventory[id] = 0;
      if (u.nftInstancePrices && u.nftInstancePrices[id]) u.nftInstancePrices[id] = [];
    });
  });
}

/* ---- Coin logotipi uchun premium animatsiyali emoji ---- */
const COIN_CUSTOM_EMOJI_ID = '5460720028288557729';

/* ---- Raketa (Crash) o'yini uchun premium animatsiyali emojilar
   (har bir raundda ikkalasi navbat bilan almashib turadi) ---- */
const ROCKET_CUSTOM_EMOJI_IDS = ['5188481279963715781', '5463424023734014980'];

/* ---- Reytingdagi top 1/2/3 medal ikonkalari uchun premium animatsiyali emoji ---- */
const MEDAL_EMOJI_IDS = {
  1: '5440539497383087970',
  2: '5447203607294265305',
  3: '5453902265922376865',
};

/* ---- Telegram custom emoji fayli: metadata + fayl keshi ---- */
const NFT_MEDIA_CACHE_DIR = path.join(__dirname, 'nft_media_cache');
if (!fs.existsSync(NFT_MEDIA_CACHE_DIR)) fs.mkdirSync(NFT_MEDIA_CACHE_DIR, { recursive: true });
const emojiMetaCache = new Map(); // custom_emoji_id -> {is_video, is_animated}

async function fetchCustomEmojiSticker(customEmojiId) {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getCustomEmojiStickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_emoji_ids: [customEmojiId] }),
    });
    const data = await res.json();
    if (!data.ok || !data.result || !data.result[0]) return null;
    return data.result[0];
  } catch (e) { console.error('getCustomEmojiStickers xatolik:', e.message); return null; }
}

async function getEmojiMeta(customEmojiId) {
  if (emojiMetaCache.has(customEmojiId)) return emojiMetaCache.get(customEmojiId);
  const sticker = await fetchCustomEmojiSticker(customEmojiId);
  const meta = sticker ? { is_video: !!sticker.is_video, is_animated: !!sticker.is_animated } : { is_video: false, is_animated: true };
  emojiMetaCache.set(customEmojiId, meta);
  return meta;
}

function cachedNftMediaPath(customEmojiId) {
  const found = fs.readdirSync(NFT_MEDIA_CACHE_DIR).find(f => f.startsWith(customEmojiId + '.'));
  return found ? path.join(NFT_MEDIA_CACHE_DIR, found) : null;
}

async function downloadAndCacheNftMedia(customEmojiId) {
  const sticker = await fetchCustomEmojiSticker(customEmojiId);
  if (!sticker) return null;
  const fRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${sticker.file_id}`);
  const fData = await fRes.json();
  if (!fData.ok) return null;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fData.result.file_path}`;
  const mediaRes = await fetch(fileUrl);
  const buffer = Buffer.from(await mediaRes.arrayBuffer());
  const ext = path.extname(fData.result.file_path) || (sticker.is_video ? '.webm' : '.tgs');
  const outPath = path.join(NFT_MEDIA_CACHE_DIR, customEmojiId + ext);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

/* ---- Kunlik case sovrinlari (server-authoritative) — faqat gift'lar, coin tushmaydi ---- */
const CASE_TIER_WEIGHTS = { 100: 0.1, 50: 1, 25: 5, 15: 10 };
function pickCaseReward() {
  const caseItems = CASE_ITEM_IDS.map(id => NFT_BY_ID.get(id));
  const tierCounts = {};
  caseItems.forEach(i => { tierCounts[i.tier] = (tierCounts[i.tier] || 0) + 1; });
  const outcomes = [];
  caseItems.forEach(item => {
    outcomes.push({ itemId: item.id, stars: item.sell_price, isGift: true, tier: item.tier, weight: CASE_TIER_WEIGHTS[item.tier] / tierCounts[item.tier] });
  });
  const totalWeight = outcomes.reduce((s, o) => s + o.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const o of outcomes) {
    if (rand < o.weight) return o;
    rand -= o.weight;
  }
  return outcomes[outcomes.length - 1];
}

/* ============================================================
   EXPRESS + SOCKET.IO SETUP
   ============================================================ */
/* ---- Coin miqdorlarini 2 xonagacha yaxlitlash (float xatoliklarining oldini olish uchun) ---- */
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

function requireUser(req, res) {
  const tgUser = getTgUserFromInitData(req.body.initData || req.query.initData);
  if (!tgUser) { res.status(401).json({ error: 'invalid_auth' }); return null; }
  const id = String(tgUser.id);
  let user = users.get(id);
  if (!user) { res.status(401).json({ error: 'invalid_auth' }); return null; }
  // Har safar so'rov kelganda ismni yangilab turamiz (foydalanuvchi Telegramda ismini o'zgartirgan bo'lishi mumkin)
  user.username = displayName(tgUser) || user.username;
  return user;
}

/* ============================================================
   FOYDALANUVCHI: init / referral
   ============================================================ */
app.post('/api/init_user', (req, res) => {
  const { initData, refBy } = req.body || {};
  const tgUser = getTgUserFromInitData(initData);
  if (!tgUser) return res.status(401).json({ ok: false, error: 'invalid_auth' });

  const id = String(tgUser.id);
  let created = false;
  let user = users.get(id);
  if (!user) {
    created = true;
    user = createUser(id, displayName(tgUser));
    if (refBy && String(refBy) !== id) user.referredBy = String(refBy);
    users.set(id, user);
    refreshPhotoAsync(user);
  } else {
    user.username = displayName(tgUser) || user.username;
  }
  res.json({ ok: true, created, user: serializeUser(user) });
});

app.post('/api/referral_reward', (req, res) => {
  const { initData, referrerId } = req.body || {};
  const tgUser = getTgUserFromInitData(initData);
  if (!tgUser) return res.status(401).json({ ok: false, error: 'invalid_auth' });
  const id = String(tgUser.id);
  const newUser = users.get(id);
  const referrer = users.get(String(referrerId));
  if (!newUser || !referrer || String(referrerId) === id) return res.json({ ok: false });
  if (newUser.referralRewarded) return res.json({ ok: false });

  newUser.referralRewarded = true;
  referrer.balance += REFERRAL_REWARD;
  if (!friends.has(referrer.id)) friends.set(referrer.id, []);
  friends.get(referrer.id).push({
    id: Number(newUser.id), username: newUser.username, photo_url: newUser.photo_url,
    joined_at: Date.now(), stars: REFERRAL_REWARD,
  });
  res.json({ ok: true });
});

/* ============================================================
   OBUNA TEKSHIRISH
   ============================================================ */
app.get('/api/check_subscription', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.json({ subscribed: false });
  const subscribed = await isSubscribed(userId, MAIN_CHANNEL);
  res.json({ subscribed });
});

/* ============================================================
   KUNLIK CASE
   ============================================================ */
app.post('/api/open_case', async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const subscribed = await isSubscribed(user.id, MAIN_CHANNEL);
  if (!subscribed) return res.status(403).json({ error: 'not_subscribed' });

  if (user.lastCaseOpenedAt && Date.now() - user.lastCaseOpenedAt < CASE_COOLDOWN_MS) {
    return res.status(400).json({ error: 'CASE_NOT_READY' });
  }
  ensureNftStarterPack(user);
  const reward = pickCaseReward();
  user.lastCaseOpenedAt = Date.now();
  user.total_won += reward.stars; // reytingda ko'rsatiladigan umumiy qiymat

  if (reward.isGift) {
    // MUHIM: endi gift avtomatik coinga aylanmaydi — inventoryga tushadi,
    // foydalanuvchi o'zi xohlasa keyinroq /api/sell_nft orqali sotadi.
    grantNftToUser(user, reward.itemId);
    const item = NFT_BY_ID.get(reward.itemId);
    const meta = await getEmojiMeta(item.custom_emoji_id);
    reward.name = item.name;
    reward.custom_emoji_id = item.custom_emoji_id;
    reward.sell_price = item.sell_price;
    reward.is_video = meta.is_video;
  } else {
    user.balance = round2(user.balance + reward.stars);
  }
  res.json({ ok: true, reward });
});

/* ---- Case'dagi mumkin bo'lgan gift'lar ro'yxati (frontend uchun) ---- */
app.get('/api/case_items', async (req, res) => {
  const items = [];
  for (const id of CASE_ITEM_IDS) {
    const item = NFT_BY_ID.get(id);
    const meta = await getEmojiMeta(item.custom_emoji_id);
    items.push({
      id: item.id, name: item.name, custom_emoji_id: item.custom_emoji_id,
      sell_price: item.sell_price, tier: item.tier, is_video: meta.is_video,
    });
  }
  res.json({ ok: true, items, tierWeights: CASE_TIER_WEIGHTS });
});

/* ============================================================
   VAZIFALAR
   ============================================================ */
app.get('/api/tasks', (req, res) => {
  res.json({ tasks: tasks.map(t => ({ id: t.id, channel_link: t.channel_link, channel_title: t.channel_title, stars_reward: t.stars_reward })) });
});

app.post('/api/claim_task', async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const { taskId } = req.body || {};
  const task = tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: 'NOT_FOUND' });
  if (user.completedTasks.has(taskId)) return res.status(400).json({ error: 'ALREADY_CLAIMED' });

  const subscribed = await isSubscribed(user.id, toChannelId(task.channel_link));
  if (!subscribed) return res.status(403).json({ error: 'NOT_SUBSCRIBED' });

  user.completedTasks.add(taskId);
  user.balance += task.stars_reward;
  res.json({ ok: true, reward: task.stars_reward });
});

/* ============================================================
   NFT INVENTAR
   ============================================================ */
app.get('/api/inventory', async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  ensureNftStarterPack(user);

  const items = [];
  for (const item of NFT_CATALOG) {
    const count = user.nftInventory[item.id] || 0;
    if (count <= 0) continue;
    const meta = await getEmojiMeta(item.custom_emoji_id);
    const customPrices = user.nftInstancePrices && user.nftInstancePrices[item.id];
    // Sotilganda birinchi navbatda ishlatiladigan narx (raketa'dan yutilgan
    // bo'lsa aynan shu maxsus narx, aks holda katalogdagi standart narx).
    const nextSellPrice = (customPrices && customPrices.length) ? customPrices[0] : item.sell_price;
    items.push({
      id: item.id,
      name: item.name,
      custom_emoji_id: item.custom_emoji_id,
      sell_price: nextSellPrice,
      count,
      is_video: meta.is_video,
    });
  }
  res.json({ ok: true, items });
});

/* ---- Admin panelda NFT tanlash hamda yutuq oynachasida ikonka
   ko'rsatish uchun to'liq katalog ro'yxati (custom_emoji_id bilan) ---- */
app.get('/api/nft_catalog', async (req, res) => {
  const items = [];
  for (const item of NFT_CATALOG) {
    const meta = await getEmojiMeta(item.custom_emoji_id);
    items.push({
      id: item.id, name: item.name, sell_price: item.sell_price,
      custom_emoji_id: item.custom_emoji_id, is_video: meta.is_video,
    });
  }
  res.json({ ok: true, items });
});

app.post('/api/sell_nft', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const { itemId } = req.body || {};
  const item = NFT_BY_ID.get(itemId);
  if (!item) return res.status(404).json({ error: 'NOT_FOUND' });

  ensureNftStarterPack(user);
  const have = user.nftInventory[itemId] || 0;
  if (have <= 0) return res.status(400).json({ error: 'NOT_OWNED' });

  user.nftInventory[itemId] = have - 1;
  // Agar shu dona raketa o'yinida maxsus narxda yutilgan bo'lsa (masalan
  // 3.44), o'sha aniq narx qo'llanadi; aks holda katalogdagi standart narx.
  let sellPrice = item.sell_price;
  const customPrices = user.nftInstancePrices && user.nftInstancePrices[itemId];
  if (customPrices && customPrices.length) sellPrice = customPrices.shift();

  user.balance = round2(user.balance + sellPrice);
  res.json({ ok: true, balance: user.balance, sold_for: sellPrice });
});

/* ---- Reyting top 1/2/3 medal ikonkalarining animatsiya metadatasi ---- */
app.get('/api/medal_emojis', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN_MISSING' });
  try {
    const results = await Promise.all(
      Object.entries(MEDAL_EMOJI_IDS).map(async ([place, customEmojiId]) => {
        const meta = await getEmojiMeta(customEmojiId);
        return { place: Number(place), custom_emoji_id: customEmojiId, is_video: meta.is_video, is_animated: meta.is_animated };
      })
    );
    res.json({ ok: true, medals: results });
  } catch (e) {
    console.error('medal_emojis xatolik:', e.message);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ---- Coin logo uchun animatsiya metadatasi (video/tgs ekanligini frontendga aytadi) ---- */
app.get('/api/coin_emoji', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN_MISSING' });
  try {
    const meta = await getEmojiMeta(COIN_CUSTOM_EMOJI_ID);
    res.json({ custom_emoji_id: COIN_CUSTOM_EMOJI_ID, is_video: meta.is_video, is_animated: meta.is_animated });
  } catch (e) {
    console.error('coin_emoji xatolik:', e.message);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/rocket_emoji', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN_MISSING' });
  try {
    const emojis = await Promise.all(ROCKET_CUSTOM_EMOJI_IDS.map(async (id) => {
      const meta = await getEmojiMeta(id);
      return { custom_emoji_id: id, is_video: meta.is_video, is_animated: meta.is_animated };
    }));
    res.json({ emojis });
  } catch (e) {
    console.error('rocket_emoji xatolik:', e.message);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ---- NFT animatsiya faylini proksi qilish (bot token frontendga chiqmaydi) ---- */
app.get('/api/nft_media/:customEmojiId', async (req, res) => {
  const customEmojiId = req.params.customEmojiId;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN_MISSING' });
  try {
    let filePath = cachedNftMediaPath(customEmojiId);
    if (!filePath) filePath = await downloadAndCacheNftMedia(customEmojiId);
    if (!filePath) return res.status(404).json({ error: 'NOT_FOUND' });
    res.sendFile(filePath);
  } catch (e) {
    console.error('nft_media xatolik:', e.message);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ============================================================
   REYTING / DO'STLAR
   ============================================================ */
app.get('/api/leaderboard', (req, res) => {
  const list = Array.from(users.values())
    .filter(u => u.username !== 'demo_user')
    .sort((a, b) => b.total_won - a.total_won)
    .slice(0, 50)
    .map((u, i) => ({ place: i + 1, username: u.username, stars: u.total_won, photo_url: u.photo_url }));
  res.json({ leaderboard: list });
});

app.get('/api/friends', (req, res) => {
  const userId = String(req.query.user_id || '');
  const list = (friends.get(userId) || []).slice().sort((a, b) => b.joined_at - a.joined_at);
  res.json({ friends: list });
});

/* ============================================================
   O'YIN TARIXI
   ============================================================ */
app.get('/api/game_history/:game', (req, res) => {
  const game = req.params.game;
  if (!gameHistory[game]) return res.json({ rounds: [] });
  res.json({ rounds: gameHistory[game] });
});

/* ============================================================
   PROMOKOD
   ============================================================ */
app.post('/api/redeem_promo', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const { code } = req.body || {};
  const promo = promos.find(p => p.code === code);
  if (!promo) return res.status(404).json({ error: 'PROMO_NOT_FOUND' });
  if (promo.used >= promo.maxUses) return res.status(400).json({ error: 'PROMO_EXHAUSTED' });
  if (promo.usedBy.has(user.id)) return res.status(400).json({ error: 'ALREADY_USED' });

  promo.used += 1;
  promo.usedBy.add(user.id);
  user.balance += promo.reward;
  res.json({ ok: true, reward_stars: promo.reward });
});

/* ============================================================
   ADMIN AMALLARI
   ============================================================ */
function requireAdmin(req, res) {
  const tgUser = getTgUserFromInitData(req.body.initData);
  if (!tgUser || !ADMIN_IDS.includes(String(tgUser.id))) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}
function resetGameState(game) {
  if (game === 'hockey') { clearTimeout(gameTimers.hockey); hockeyState = defaultHockeyState(); emitState('hockey'); }
  else if (game === 'drum') { clearTimeout(gameTimers.drum); drumState = defaultDrumState(); emitState('drum'); }
  else if (game === 'team_battle') { clearTimeout(gameTimers.team_battle); teamState = defaultTeamState(); emitState('team_battle'); }
  gameHistory[game] = [];
}

/* ---- Bot uchun ichki statistika API (faqat INTERNAL_KEY bilan, /admin90 uchun) ---- */
app.get('/api/internal_stats', (req, res) => {
  if (!INTERNAL_KEY || req.get('x-internal-key') !== INTERNAL_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const allUsers = Array.from(users.values());
  const totalStars = allUsers.reduce((s, u) => s + (u.balance || 0), 0);
  res.json({
    totalUsers: allUsers.length,
    totalStars,
    adminCount: allUsers.filter(u => u.isAdmin).length,
    tasksCount: tasks.length,
    activePromos: promos.filter(p => p.used < p.maxUses).length,
    activeVouchers: vouchers.filter(v => v.used < v.maxUses).length,
    hockey: { status: hockeyState.status, players: hockeyState.players.length, round: hockeyState.game_number },
    drum: { status: drumState.status, players: drumState.players.length, round: drumState.game_number },
    teamBattle: { status: teamState.status, players: teamState.players.length, round: teamState.game_number },
  });
});

app.post('/api/admin_action', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { action, payload = {} } = req.body || {};
  try {
    switch (action) {
      case 'give_stars': {
        const target = users.get(String(payload.userId));
        if (target) target.balance += Number(payload.amount) || 0;
        break;
      }
      case 'create_promo': {
        promos.push({ code: payload.code, reward: Number(payload.reward) || 0, maxUses: Number(payload.maxUses) || 1, used: 0, usedBy: new Set() });
        break;
      }
      case 'create_voucher': {
        const maxUses = Number(payload.maxUses) || 1;
        const reward = Number(payload.reward) || 0;
        const requireType = ['channel', 'chat', 'bot'].includes(payload.requireType) ? payload.requireType : null;
        const requireTarget = requireType ? String(payload.requireTarget || '').trim() : null;
        if (requireType && !requireTarget) throw new Error('MISSING_REQUIRE_TARGET');

        const voucher = {
          id: crypto.randomBytes(5).toString('hex'),
          reward, maxUses, used: 0, usedBy: new Set(),
          requireType, requireTarget,
          createdAt: Date.now(),
        };
        voucher.requireLabel = voucherRequireLabel(voucher);
        vouchers.push(voucher);
        postVoucherToChannel(voucher).catch(e => console.error('postVoucherToChannel xatolik:', e.message));
        break;
      }
      case 'add_task': {
        tasks.push({ id: crypto.randomBytes(6).toString('hex'), channel_link: payload.link, channel_title: payload.title || '', stars_reward: Number(payload.reward) || 0 });
        break;
      }
      case 'delete_task': {
        tasks = tasks.filter(t => t.id !== payload.taskId);
        break;
      }
      case 'delete_all_tasks': {
        tasks = [];
        break;
      }
      case 'reset_rating': {
        users.forEach(u => { u.total_won = 0; u.wins = 0; });
        break;
      }
      case 'reset_game': {
        resetGameState(payload.game);
        break;
      }
      case 'reset_case_cooldowns': {
        users.forEach(u => { u.lastCaseOpenedAt = null; });
        break;
      }
      case 'give_nft': {
        const target = users.get(String(payload.userId));
        if (!target) throw new Error('USER_NOT_FOUND');
        const item = NFT_BY_ID.get(payload.itemId);
        if (!item) throw new Error('ITEM_NOT_FOUND');
        const amount = Math.max(1, parseInt(payload.amount) || 1);
        for (let i = 0; i < amount; i++) grantNftToUser(target, item.id);
        break;
      }
      case 'reset_everything': {
        users.forEach(u => { u.balance = 0; u.total_won = 0; u.wins = 0; u.completedTasks = new Set(); u.lastCaseOpenedAt = null; });
        resetGameState('hockey'); resetGameState('drum'); resetGameState('team_battle');
        break;
      }
      default:
        return res.status(400).json({ error: 'unknown_action' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('admin_action xatolik:', e);
    res.status(400).json({ error: e.message || 'server_error' });
  }
});

/* ============================================================
   VOUCHER — bot.js (ichki, INTERNAL_KEY bilan himoyalangan) uchun API
   ============================================================ */
function requireInternal(req, res) {
  if (!INTERNAL_KEY || req.get('x-internal-key') !== INTERNAL_KEY) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

app.get('/api/internal_voucher_info', (req, res) => {
  if (!requireInternal(req, res)) return;
  const voucher = vouchers.find(v => v.id === String(req.query.id || ''));
  if (!voucher) return res.json({ error: 'NOT_FOUND' });
  res.json({
    id: voucher.id, reward: voucher.reward, maxUses: voucher.maxUses, used: voucher.used,
    requireType: voucher.requireType, requireTarget: voucher.requireTarget, requireLabel: voucher.requireLabel,
  });
});

/* ---- Mini App uchun ochiq voucher endpointlari (initData bilan autentifikatsiya) ---- */
app.get('/api/voucher_info', (req, res) => {
  const voucher = vouchers.find(v => v.id === String(req.query.id || ''));
  if (!voucher) return res.json({ error: 'NOT_FOUND' });
  res.json({
    id: voucher.id, reward: voucher.reward, maxUses: voucher.maxUses, used: voucher.used,
    requireType: voucher.requireType, requireTarget: voucher.requireTarget, requireLabel: voucher.requireLabel,
  });
});

app.post('/api/claim_voucher', async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const { voucherId } = req.body || {};
  const voucher = vouchers.find(v => v.id === String(voucherId || ''));
  if (!voucher) return res.json({ error: 'NOT_FOUND' });
  if (voucher.used >= voucher.maxUses) return res.json({ error: 'EXHAUSTED' });

  const uid = String(user.id);
  if (voucher.usedBy.has(uid)) return res.json({ error: 'ALREADY_USED' });

  if (voucher.requireType === 'channel' || voucher.requireType === 'chat') {
    const subscribed = await isSubscribed(uid, voucher.requireTarget);
    if (!subscribed) {
      return res.json({
        error: 'NOT_SUBSCRIBED',
        requireType: voucher.requireType, requireTarget: voucher.requireTarget, requireLabel: voucher.requireLabel,
      });
    }
  }

  user.balance += voucher.reward;
  voucher.used += 1;
  voucher.usedBy.add(uid);
  res.json({ ok: true, reward: voucher.reward, balance: user.balance });
});

app.post('/api/internal_voucher_claim', async (req, res) => {
  if (!requireInternal(req, res)) return;
  const { voucherId, userId, username } = req.body || {};
  const voucher = vouchers.find(v => v.id === String(voucherId || ''));
  if (!voucher) return res.json({ error: 'NOT_FOUND' });
  if (voucher.used >= voucher.maxUses) return res.json({ error: 'EXHAUSTED' });

  const uid = String(userId);
  if (voucher.usedBy.has(uid)) return res.json({ error: 'ALREADY_USED' });

  // Xavfsizlik uchun serverda ham qayta tekshiramiz (kanal/chat turi uchun —
  // "bot" turini tashqi botda tekshirib bo'lmaydi, shuning uchun ishonchga
  // asoslanadi va bot.js darajasida foydalanuvchiga ko'rsatiladi).
  if (voucher.requireType === 'channel' || voucher.requireType === 'chat') {
    const subscribed = await isSubscribed(uid, voucher.requireTarget);
    if (!subscribed) {
      return res.json({
        error: 'NOT_SUBSCRIBED',
        requireType: voucher.requireType, requireTarget: voucher.requireTarget, requireLabel: voucher.requireLabel,
      });
    }
  }

  let user = users.get(uid);
  if (!user) { user = createUser(uid, username || `user${uid}`); users.set(uid, user); }
  user.balance += voucher.reward;
  voucher.used += 1;
  voucher.usedBy.add(uid);

  res.json({ ok: true, reward: voucher.reward, balance: user.balance });
});

/* ============================================================
   HOCKEY — tosh (puck) qayerda to'xtasa, o'sha zonaning egasi yutadi.
   Bu funksiyalar public/index.html dagi bir xil nomli funksiyalarning
   ANIQ NUSXASI (bir xil matematika) — shu tufayli mijozda ko'rsatiladigan
   tosh parvozi va zonalar bilan SERVERDA hisoblangan g'olib har doim
   ANIQ mos keladi (oldin bular bir-biridan mustaqil edi — shu narsa
   "tosh boshqa zonaga tushyapti, lekin boshqasi yutyapti" xatosining
   sababi edi).
   ============================================================ */
function hkPolygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

function hkClipPolygonHalfPlane(poly, dx, dy, c, keepGreaterEqual) {
  if (!poly.length) return poly;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const currVal = dx * curr[0] + dy * curr[1];
    const prevVal = dx * prev[0] + dy * prev[1];
    const currIn = keepGreaterEqual ? currVal >= c - 1e-6 : currVal <= c + 1e-6;
    const prevIn = keepGreaterEqual ? prevVal >= c - 1e-6 : prevVal <= c + 1e-6;
    if (currIn) {
      if (!prevIn) {
        const t = (c - prevVal) / (currVal - prevVal);
        out.push([prev[0] + t * (curr[0] - prev[0]), prev[1] + t * (curr[1] - prev[1])]);
      }
      out.push(curr);
    } else if (prevIn) {
      const t = (c - prevVal) / (currVal - prevVal);
      out.push([prev[0] + t * (curr[0] - prev[0]), prev[1] + t * (curr[1] - prev[1])]);
    }
  }
  return out;
}

function hkComputeDiagonalTreemap(items, dirAngleDeg) {
  const rad = dirAngleDeg * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const corners = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const projections = corners.map(([x, y]) => x * dx + y * dy);
  const minP = Math.min(...projections), maxP = Math.max(...projections);
  const TOTAL_AREA = 10000;

  function areaBelow(p) {
    let poly = [[0, 0], [100, 0], [100, 100], [0, 100]];
    poly = hkClipPolygonHalfPlane(poly, dx, dy, p, false);
    return hkPolygonArea(poly);
  }
  function findCut(targetArea) {
    let lo = minP, hi = maxP;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (areaBelow(mid) < targetArea) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  let cum = 0, prevCut = minP;
  const results = [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    cum += item.value;
    const isLast = idx === items.length - 1;
    const targetArea = isLast ? TOTAL_AREA : (cum / total) * TOTAL_AREA;
    const cut = isLast ? maxP : findCut(targetArea);
    let poly = [[0, 0], [100, 0], [100, 100], [0, 100]];
    poly = hkClipPolygonHalfPlane(poly, dx, dy, prevCut, true);
    poly = hkClipPolygonHalfPlane(poly, dx, dy, cut, false);
    results.push({ index: item.index, polygon: poly });
    prevCut = cut;
  }
  return results;
}

function hkComputeTreemap(items, startVertical) {
  const sorted = items.slice().sort((a, b) => b.value - a.value);
  const rects = {};
  function recurse(list, x, y, w, h, vertical) {
    if (list.length === 1) {
      rects[list[0].index] = { x, y, w, h };
      return;
    }
    const sum = list.reduce((s, i) => s + i.value, 0) || 1;
    let cum = 0, bestIdx = 1, bestDiff = Infinity;
    for (let i = 0; i < list.length - 1; i++) {
      cum += list[i].value;
      const diff = Math.abs(cum - sum / 2);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i + 1; }
    }
    const groupA = list.slice(0, bestIdx);
    const groupB = list.slice(bestIdx);
    const sumA = groupA.reduce((s, i) => s + i.value, 0);
    if (vertical) {
      const wA = w * sumA / sum;
      recurse(groupA, x, y, wA, h, !vertical);
      recurse(groupB, x + wA, y, w - wA, h, !vertical);
    } else {
      const hA = h * sumA / sum;
      recurse(groupA, x, y, w, hA, !vertical);
      recurse(groupB, x, y + hA, w, h - hA, !vertical);
    }
  }
  recurse(sorted, 0, 0, 100, 100, startVertical !== false);
  return rects;
}

function hkPointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Toshning uchish yo'lini boshidan oxirigacha (bitta sinxron siklda)
// hisoblab, to'xtagan (final) nuqtasini qaytaradi. public/index.html dagi
// runPuckFlight() ichidagi fizika bilan BIR XIL: shu tufayli mijozda
// ko'rinadigan animatsiya oxiri bilan bu funksiya natijasi mos keladi.
function hkSimulatePuckFinalPosition(angle) {
  const flightDuration = 7000;
  const tickMs = 1000 / 60;
  const totalSteps = Math.round(flightDuration / tickMs);
  const rad = 2.2;

  let speed = 11.5;
  let vx = Math.cos(angle * Math.PI / 180) * speed;
  let vy = Math.sin(angle * Math.PI / 180) * speed;

  let px = 50, py = 50;
  for (let i = 0; i < totalSteps; i++) {
    const stepProgress = i / totalSteps;
    const currentFriction = 0.992 - (stepProgress * 0.012);

    px += vx;
    py += vy;

    if (px - rad <= 0) { px = rad; vx *= -1; }
    if (px + rad >= 100) { px = 100 - rad; vx *= -1; }
    if (py - rad <= 0) { py = rad; vy *= -1; }
    if (py + rad >= 100) { py = 100 - rad; vy *= -1; }

    vx *= currentFriction;
    vy *= currentFriction;
  }

  return { x: px, y: py };
}

// Berilgan yakuniy nuqta (finalPos) qaysi o'yinchining zonasi ustida
// to'xtaganini aniqlaydi — public/index.html dagi renderHockeyArena() bilan
// AYNAN BIR XIL joylashuv (game_number juftligi/toqligi asosida diagonal
// yoki to'g'ri burchakli treemap) ishlatiladi.
function hkResolveZoneWinner(players, gameNumber, finalPos) {
  if (!players.length) return null;
  const items = players.map((p, idx) => ({ index: idx, value: p.stars || 1 }));
  const roundSeed = gameNumber || 0;
  const useDiagonal = (roundSeed % 2 === 0);

  if (useDiagonal) {
    const diagAngle = (roundSeed % 4 < 2) ? 45 : 135;
    const zones = hkComputeDiagonalTreemap(items, diagAngle);
    for (const z of zones) {
      if (z.polygon.length >= 3 && hkPointInPolygon([finalPos.x, finalPos.y], z.polygon)) {
        return players[z.index];
      }
    }
    // Chekka holatlarda (masalan, chiziq ustida) eng yaqin zonani tanlaymiz.
    return players[zones[zones.length - 1].index];
  } else {
    const startVertical = (Math.floor(roundSeed / 2) % 2 === 0);
    const rectsMap = hkComputeTreemap(items, startVertical);
    for (let idx = 0; idx < players.length; idx++) {
      const r = rectsMap[idx];
      if (finalPos.x >= r.x - 1e-6 && finalPos.x <= r.x + r.w + 1e-6 &&
          finalPos.y >= r.y - 1e-6 && finalPos.y <= r.y + r.h + 1e-6) {
        return players[idx];
      }
    }
    return players[players.length - 1];
  }
}

/* ============================================================
   O'YINLAR: umumiy holat mashinasi (hockey, drum, team_battle)
   idle -> betting -> spinning_visual -> cooldown -> idle
   ============================================================ */
const WAIT_SECONDS = { hockey: 15, drum: 15, team_battle: 20 };
const ANIM_MS = { hockey: 9250, drum: 6150, team_battle: 7250 };
const COOLDOWN_MS = 5000;
const gameTimers = { hockey: null, drum: null, team_battle: null };

function defaultHockeyState() { return { status: 'idle', players: [], pot: 0, game_number: 1, bettingStartedAt: null, cooldownStartedAt: null, winner: null, puckSeed: null }; }
function defaultDrumState() { return { status: 'idle', players: [], pot: 0, game_number: 1, bettingStartedAt: null, cooldownStartedAt: null, winner: null, drumSeed: null }; }
function defaultTeamState() { return { status: 'idle', players: [], pot: 0, game_number: 1, bettingStartedAt: null, cooldownStartedAt: null, winner: null, teamSeed: null, colorTotals: { red: 0, green: 0, blue: 0 } }; }

let hockeyState = defaultHockeyState();
let drumState = defaultDrumState();
let teamState = defaultTeamState();

function getState(game) { return game === 'hockey' ? hockeyState : game === 'drum' ? drumState : teamState; }
function emitState(game) { io.emit(`${game}:state`, getState(game)); }

function startBettingTimer(game) {
  clearTimeout(gameTimers[game]);
  gameTimers[game] = setTimeout(() => onBettingTimeout(game), WAIT_SECONDS[game] * 1000);
}
function onBettingTimeout(game) {
  const state = getState(game);
  // Taймер endi faqat 2+ o'yinchi tikkandan keyingina boshlanadi (yuqoridagi
  // /api/place_bet va /api/place_team_bet ga qarang), shuning uchun bu yerga
  // 2 kishidan kam bilan kelib qolish odatda mumkin emas. Baribir xavfsizlik
  // uchun tekshiruv qoldirilgan.
  if (state.players.length < 2) return;
  resolveRound(game);
}

function resolveRound(game) {
  const state = getState(game);
  state.status = 'spinning_visual';

  if (game === 'hockey') {
    // MUHIM (bug fix): g'olib endi tosh AMALDA to'xtagan zonaga qarab
    // aniqlanadi — avval g'olib pickWeighted bilan mustaqil tanlanardi va
    // burchak esa alohida tasodifiy qiymat edi, shu sabab vizual tosh
    // ko'pincha boshqa zonaga tushib, lekin boshqa odam yutgandek ko'rinardi.
    // Endi burchak (angle) tasodifiy tanlanadi, so'ng AYNAN mijozdagi bilan
    // bir xil fizika/joylashuv hisobi bilan tosh qayerda to'xtashi
    // hisoblanadi va o'sha zonaning egasi yutadi.
    const angle = Math.random() * 360;
    const finalPos = hkSimulatePuckFinalPosition(angle);
    const winner = hkResolveZoneWinner(state.players, state.game_number, finalPos) || pickWeighted(state.players, playerWeight);
    state.winner = { id: winner.id, username: winner.username, photo: winner.photo, stars: winner.stars };
    state.puckSeed = { angle };
  } else if (game === 'drum') {
    const winner = pickWeighted(state.players, playerWeight);
    const total = state.players.reduce((s, p) => s + playerWeight(p), 0) || 1;
    let cursor = 0, start = 0, end = 360;
    for (const p of state.players) {
      const size = playerWeight(p) / total * 360;
      if (p.id === winner.id) { start = cursor; end = cursor + size; break; }
      cursor += size;
    }
    const angle = start + Math.random() * Math.max(end - start, 0.001);
    state.winner = { id: winner.id, username: winner.username, photo: winner.photo, stars: winner.stars };
    state.drumSeed = { angle };
  } else if (game === 'team_battle') {
    const colors = ['red', 'green', 'blue'];
    const totals = state.colorTotals;
    const totalAll = colors.reduce((s, c) => s + (totals[c] || 0), 0) || 1;
    let r = Math.random() * totalAll;
    let winColor = colors[colors.length - 1];
    for (const c of colors) {
      const w = totals[c] || 0;
      if (r < w) { winColor = c; break; }
      r -= w;
    }
    const winners = state.players.filter(p => p.color === winColor);
    const winTotal = totals[winColor] || 1;
    const payouts = {};
    let distributed = 0;
    winners.forEach((p, idx) => {
      let amt;
      if (idx === winners.length - 1) amt = state.pot - distributed;
      else amt = Math.floor(state.pot * (p.stars / winTotal));
      distributed += amt;
      payouts[String(p.id)] = amt;
    });
    state.winner = { color: winColor, payouts };
    state.teamSeed = { angle: Math.random() * 360 };
  }

  emitState(game);
  setTimeout(() => finalizeRound(game), ANIM_MS[game]);
}

function finalizeRound(game) {
  const state = getState(game);
  const pot = state.pot;
  const historyEntry = { game_number: state.game_number, pot, players: [] };

  if (game === 'hockey' || game === 'drum') {
    const winner = state.winner;
    const wUser = users.get(String(winner.id));
    // Coin qismi — tikilgan barcha coin'lar yig'indisi (NFT qiymati emas!)
    const coinPot = round2(state.players.reduce((s, p) => s + (p.stars || 0), 0));
    let wonNftsCount = 0;
    if (wUser) {
      wUser.balance = round2(wUser.balance + coinPot);
      wUser.total_won = round2((wUser.total_won || 0) + coinPot);
      wUser.wins += 1;
      // Barcha o'yinchilar (g'olibning o'zi ham) tikkan NFT'lar — hammasi
      // g'olibning inventoriga o'tadi, narxi ham qulflangan holicha saqlanadi.
      state.players.forEach(p => {
        (p.nfts || []).forEach(n => {
          grantNftToUser(wUser, n.itemId, n.price);
          wonNftsCount += 1;
        });
      });
    }
    historyEntry.winner_id = winner.id;
    historyEntry.wonNftsCount = wonNftsCount;
    historyEntry.players = state.players.map(p => ({
      id: p.id, username: p.username, photo: p.photo, stars: p.stars, nfts: p.nfts || [],
      chance: pot ? Number(((playerWeight(p) / pot) * 100).toFixed(1)) : 0,
      won: p.id === winner.id ? coinPot : 0,
    }));
  } else if (game === 'team_battle') {
    historyEntry.winner_color = state.winner.color;
    const payouts = state.winner.payouts;
    state.players.forEach(p => {
      const won = payouts[String(p.id)] || 0;
      if (won > 0) {
        const u = users.get(String(p.id));
        if (u) { u.balance = round2(u.balance + won); u.total_won += won; u.wins += 1; }
      }
    });
    historyEntry.players = state.players.map(p => ({
      id: p.id, username: p.username, photo: p.photo, stars: p.stars, color: p.color,
      chance: pot ? Number(((p.stars / pot) * 100).toFixed(1)) : 0,
      won: payouts[String(p.id)] || 0,
    }));
  }

  gameHistory[game].unshift(historyEntry);
  if (gameHistory[game].length > 10) gameHistory[game].length = 10;

  state.status = 'cooldown';
  state.cooldownStartedAt = Date.now();
  emitState(game);

  setTimeout(() => {
    const gnum = state.game_number + 1;
    if (game === 'hockey') hockeyState = { ...defaultHockeyState(), game_number: gnum };
    else if (game === 'drum') drumState = { ...defaultDrumState(), game_number: gnum };
    else teamState = { ...defaultTeamState(), game_number: gnum };
    emitState(game);
  }, COOLDOWN_MS);
}

/* ---- Tikish (hockey / drum) ---- */
app.post('/api/place_bet', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const { game, amount } = req.body || {};
  if (game !== 'hockey' && game !== 'drum') return res.status(400).json({ error: 'invalid_game' });

  const amt = Number(amount);
  if (!amt || amt < 0.1) return res.status(400).json({ error: 'invalid_amount' });
  if (amt > user.balance) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

  const state = getState(game);
  if (state.status === 'spinning_visual' || state.status === 'cooldown') {
    return res.status(400).json({ error: 'GAME_NOT_ACCEPTING_BETS' });
  }

  user.balance = round2(user.balance - amt);
  const existing = state.players.find(p => p.id === Number(user.id));
  if (existing) existing.stars = round2(existing.stars + amt);
  else state.players.push({ id: Number(user.id), username: user.username, photo: user.photo_url, stars: amt, color: colorFor(state.players.length) });
  state.pot = round2(state.pot + amt);

  if (state.status === 'idle') {
    // 1-o'yinchi tikkanda o'yin "betting" holatiga o'tadi (pot va o'yinchi
    // ko'rinadi), LEKIN taймer hali boshlanmaydi — kamida 2-o'yinchi
    // tikmaguncha kutamiz (pastga qarang).
    state.status = 'betting';
  }
  if (state.players.length >= 2 && !state.bettingStartedAt) {
    // 2-o'yinchi (yoki undan ko'p) tikkanda taймер endi boshlanadi.
    state.bettingStartedAt = Date.now();
    startBettingTimer(game);
  }
  emitState(game);
  res.json({ ok: true, balance: user.balance });
});

/* ---- Tikish — NFT bilan (hockey / drum). Bir yoki bir nechta NFT
   itemId'sini (takrorlansa bir nechta dona) inventoriydan olib, joriy
   davrga tikadi. Yutgan o'yinchi bu NFT'larning HAMMASINI (o'zinikini ham,
   raqiblarnikini ham) o'z inventoriga oladi. ---- */
app.post('/api/place_bet_nft', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const { game, itemIds } = req.body || {};
  if (game !== 'hockey' && game !== 'drum') return res.status(400).json({ error: 'invalid_game' });
  if (!Array.isArray(itemIds) || !itemIds.length) return res.status(400).json({ error: 'invalid_items' });

  const state = getState(game);
  if (state.status === 'spinning_visual' || state.status === 'cooldown') {
    return res.status(400).json({ error: 'GAME_NOT_ACCEPTING_BETS' });
  }

  ensureNftStarterPack(user);

  // Avval — hech narsani kamaytirmasdan — hammasi yetarlimi tekshiramiz.
  const needCounts = {};
  for (const id of itemIds) needCounts[id] = (needCounts[id] || 0) + 1;
  for (const [id, need] of Object.entries(needCounts)) {
    const item = NFT_BY_ID.get(id);
    if (!item) return res.status(404).json({ error: 'ITEM_NOT_FOUND' });
    if ((user.nftInventory[id] || 0) < need) return res.status(400).json({ error: 'NOT_ENOUGH_NFT' });
  }

  // Endi haqiqatan ayiramiz va narxlarini "qulflaymiz" (keyinchalik katalog
  // narxi o'zgarsa ham, bu dona aynan shu narxda hisoblanadi).
  const staked = [];
  for (const id of itemIds) {
    const item = NFT_BY_ID.get(id);
    user.nftInventory[id] -= 1;
    let price = item.sell_price;
    const customPrices = user.nftInstancePrices && user.nftInstancePrices[id];
    if (customPrices && customPrices.length) price = customPrices.shift();
    staked.push({ itemId: id, name: item.name, custom_emoji_id: item.custom_emoji_id, price: round2(price) });
  }
  const nftValue = round2(staked.reduce((s, n) => s + n.price, 0));

  let existing = state.players.find(p => p.id === Number(user.id));
  if (!existing) {
    existing = { id: Number(user.id), username: user.username, photo: user.photo_url, stars: 0, nfts: [], color: colorFor(state.players.length) };
    state.players.push(existing);
  }
  existing.nfts = (existing.nfts || []).concat(staked);
  state.pot = round2(state.pot + nftValue);

  if (state.status === 'idle') state.status = 'betting';
  if (state.players.length >= 2 && !state.bettingStartedAt) {
    state.bettingStartedAt = Date.now();
    startBettingTimer(game);
  }
  emitState(game);
  res.json({ ok: true, staked });
});


app.post('/api/place_team_bet', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const { amount, color } = req.body || {};
  if (!['red', 'green', 'blue'].includes(color)) return res.status(400).json({ error: 'invalid_color' });

  const amt = Number(amount);
  if (!amt || amt < 0.1) return res.status(400).json({ error: 'invalid_amount' });
  if (amt > user.balance) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

  const state = teamState;
  if (state.status === 'spinning_visual' || state.status === 'cooldown') {
    return res.status(400).json({ error: 'GAME_NOT_ACCEPTING_BETS' });
  }
  const existing = state.players.find(p => p.id === Number(user.id));
  if (existing && existing.color !== color) return res.status(400).json({ error: 'COLOR_LOCKED' });

  user.balance = round2(user.balance - amt);
  if (existing) existing.stars = round2(existing.stars + amt);
  else state.players.push({ id: Number(user.id), username: user.username, photo: user.photo_url, stars: amt, color });
  state.pot = round2(state.pot + amt);
  state.colorTotals[color] = round2((state.colorTotals[color] || 0) + amt);

  if (state.status === 'idle') {
    // 1-o'yinchi tikkanda o'yin "betting" holatiga o'tadi, LEKIN taймer
    // hali boshlanmaydi — kamida 2-o'yinchi tikmaguncha kutamiz.
    state.status = 'betting';
  }
  if (state.players.length >= 2 && !state.bettingStartedAt) {
    state.bettingStartedAt = Date.now();
    startBettingTimer('team_battle');
  }
  emitState('team_battle');
  res.json({ ok: true, balance: user.balance });
});

/* ============================================================
   RAKETA (CRASH) — bitta umumiy raundda barcha ulangan
   foydalanuvchilar real vaqtda ishtirok etadigan multiplayer o'yin.
   Har bir raund 3 bosqichdan iborat:
     waiting  -> tikish qabul qilinadi (CRASH_WAIT_MS)
     running  -> multiplikator o'sadi, istalgan payt "OLISH" mumkin
     crashed  -> "portlash" — ulgurmagan o'yinchilar tikkanini yutqizadi
   Portlash nuqtasi (crashSecretCrashPoint) HECH QACHON clientga
   oldindan yuborilmaydi — faqat serverda saqlanadi, shu bilan
   natijani oldindan bilib olib firibgarlik qilish oldi olinadi.
   ============================================================ */
const CRASH_MIN_BET = 0.1;
const CRASH_WAIT_MS = 7000;       // tikish uchun ochiq bo'lgan vaqt
const CRASH_COOLDOWN_MS = 4000;   // portlashdan keyingi natija ko'rsatiladigan vaqt
const CRASH_TICK_MS = 100;        // multiplikator qancha tez-tez broadcast qilinadi
const CRASH_GROWTH = 0.13;        // multiplikator o'sish tezligi (katta = tezroq o'sadi)
const CRASH_HOUSE_EDGE = 0.04;    // 4% — raundlarning 4% i darhol 1.00x da "portlaydi"
const CRASH_MAX_MULTIPLIER = 500;
// NFT yutish: tikilgan summa qancha bo'lishidan qat'iy nazar (endi faqat
// 1 ga tenglik shart emas), "OLISH" bosilgan paytdagi YUTILGAN QIYMAT
// (bet * multiplikator) hisoblanadi va shu qiymatga eng yaqin narxdagi
// NFT katalogdan tanlanadi. Moslik nisbiy tolerantlik bilan tekshiriladi
// (qiymat qancha katta bo'lsa, ruxsat etilgan farq ham shuncha katta
// bo'ladi), shu bilan kichik tikkanlarga arzon NFT, katta tikkanlarga
// qimmat NFT to'g'ri keladi. NFT'ning narxi esa aynan shu yutilgan qiymat
// bo'lib qoladi (masalan 5.34), xuddi referensdagi botdagidek.
const CRASH_NFT_MIN_VALUE = 0.1;      // bundan kichik yutuqlarga NFT berilmaydi (juda arzon bo'lib ko'rinmasin)
const CRASH_NFT_MATCH_RELATIVE_TOLERANCE = 0.35; // qiymatning ±35% i ichida bo'lsa moslik hisoblanadi
const CRASH_NFT_MATCH_MIN_TOLERANCE = 0.15;      // kichik qiymatlar uchun minimal ruxsat etilgan farq

function findNftMatchForValue(value) {
  if (value < CRASH_NFT_MIN_VALUE) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const item of NFT_CATALOG) {
    const tolerance = Math.max(CRASH_NFT_MATCH_MIN_TOLERANCE, item.sell_price * CRASH_NFT_MATCH_RELATIVE_TOLERANCE);
    const diff = Math.abs(item.sell_price - value);
    if (diff <= tolerance && diff < bestDiff) {
      best = item;
      bestDiff = diff;
    }
  }
  return best;
}

let crashState = { status: 'waiting', players: [], multiplier: 1.00, startedAt: null, waitingStartedAt: Date.now(), round_number: 1 };
let crashSecretCrashPoint = null; // MAXFIY — sanitizeCrashState() bu qiymatni hech qachon qaytarmaydi
let crashLastResult = null;
let crashWaitTimer = null;
let crashRunInterval = null;

function generateCrashPoint() {
  // Klassik "crash" o'yinlarida ishlatiladigan taqsimot: uzun quyruqli
  // (kamdan-kam holda juda katta multiplikatorlar chiqadi), CRASH_HOUSE_EDGE
  // ulushida esa raund 1.00x da darhol tugaydi.
  if (Math.random() < CRASH_HOUSE_EDGE) return 1.00;
  const r = Math.random();
  let cp = (1 - CRASH_HOUSE_EDGE) / (1 - r);
  cp = Math.max(1.00, Math.min(cp, CRASH_MAX_MULTIPLIER));
  return Math.round(cp * 100) / 100;
}

function currentCrashMultiplier() {
  if (crashState.status !== 'running' || !crashState.startedAt) return crashState.multiplier || 1.00;
  const elapsedSec = (Date.now() - crashState.startedAt) / 1000;
  let mult = Math.exp(CRASH_GROWTH * elapsedSec);
  return Math.round(mult * 100) / 100;
}

function sanitizeCrashState() {
  return {
    status: crashState.status,
    players: crashState.players.map(p => ({
      id: p.id, username: p.username, photo: p.photo, bet: p.bet,
      cashedOutAt: p.cashedOutAt, won: p.won, wonNft: p.wonNft || null,
    })),
    multiplier: crashState.multiplier,
    startedAt: crashState.startedAt,
    waitingStartedAt: crashState.waitingStartedAt,
    waitMs: CRASH_WAIT_MS,
    round_number: crashState.round_number,
    lastResult: crashLastResult,
  };
}
function emitCrashState() { io.emit('crash:state', sanitizeCrashState()); }

function startCrashWaiting() {
  clearTimeout(crashWaitTimer); clearInterval(crashRunInterval);
  const nextRound = (crashState.round_number || 0) + 1;
  crashState = { status: 'waiting', players: [], multiplier: 1.00, startedAt: null, waitingStartedAt: Date.now(), round_number: nextRound };
  crashSecretCrashPoint = generateCrashPoint();
  emitCrashState();
  crashWaitTimer = setTimeout(startCrashRunning, CRASH_WAIT_MS);
}

function startCrashRunning() {
  crashState.status = 'running';
  crashState.startedAt = Date.now();
  emitCrashState();
  crashRunInterval = setInterval(() => {
    const mult = currentCrashMultiplier();
    crashState.multiplier = mult;
    if (mult >= crashSecretCrashPoint) {
      clearInterval(crashRunInterval);
      finalizeCrashRound();
      return;
    }
    emitCrashState();
  }, CRASH_TICK_MS);
}

function finalizeCrashRound() {
  crashState.status = 'crashed';
  crashState.multiplier = crashSecretCrashPoint;

  const historyEntry = {
    round_number: crashState.round_number,
    crashPoint: crashSecretCrashPoint,
    players: crashState.players.map(p => ({ id: p.id, username: p.username, photo: p.photo, bet: p.bet, cashedOutAt: p.cashedOutAt, won: p.won, wonNft: p.wonNft || null })),
  };
  crashLastResult = { round_number: crashState.round_number, crashPoint: crashSecretCrashPoint };
  gameHistory.crash.unshift(historyEntry);
  if (gameHistory.crash.length > 10) gameHistory.crash.length = 10;

  emitCrashState();
  crashWaitTimer = setTimeout(startCrashWaiting, CRASH_COOLDOWN_MS);
}

/* ---- Tikish (raketa/crash) — faqat "waiting" bosqichida qabul qilinadi ---- */
app.post('/api/crash/bet', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const amt = Number(req.body?.amount);
  if (!amt || amt < CRASH_MIN_BET) return res.status(400).json({ error: 'invalid_amount' });
  if (amt > user.balance) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });
  if (crashState.status !== 'waiting') return res.status(400).json({ error: 'GAME_NOT_ACCEPTING_BETS' });
  if (crashState.players.find(p => p.id === Number(user.id))) return res.status(400).json({ error: 'ALREADY_BET' });

  user.balance = round2(user.balance - amt);
  crashState.players.push({ id: Number(user.id), username: user.username, photo: user.photo_url, bet: amt, cashedOutAt: null, won: 0, wonNft: null });
  emitCrashState();
  res.json({ ok: true, balance: user.balance });
});

/* ============================================================
   MINES 1vs1 — real vaqtli, server-authoritative 2 o'yinchi o'yini
   (mina joylashuvi hech qachon clientga oldindan yuborilmaydi —
   faqat ochilgan katak natijasi yuboriladi, shu bilan haqiqiy pul/
   stars tikiladigan o'yinda firibgarlik oldi olinadi)
   ============================================================ */
const minesRooms = new Map(); // roomId -> room
const MINES_MIN_BET = 0.1;
const MINES_ALLOWED_SIZES = [25, 30, 35, 40];
const MINES_ALLOWED_BOMBS = [1, 2, 3];
const MINES_BOT_MOVE_DELAY_MS = 900;
const MINES_ROOM_PREFIX = 'mines_';
const MINES_TURN_TIMEOUT_MS = 30000; // 30 soniya — shu vaqtda katak tanlamasa avtomatik yutqizadi
const MINES_EXTREMAL_DELAY_MS = 3000; // "Extremal" rejimda har bir katak ochilishidan oldingi hayajonli kutish

function getSocketUser(initData) {
  const tgUser = getTgUserFromInitData(initData);
  if (!tgUser) return null;
  const id = String(tgUser.id);
  const user = users.get(id);
  if (!user) return null;
  user.username = displayName(tgUser) || user.username;
  return user;
}

function createMinesRoomId() {
  let id;
  do { id = crypto.randomBytes(5).toString('hex'); } while (minesRooms.has(id));
  return id;
}

function publicMinesRoomList() {
  return Array.from(minesRooms.values())
    .filter(r => r.status === 'waiting' && !r.vsBot)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(r => ({
      id: r.id,
      hostId: r.host.id,
      hostName: r.host.username,
      hostPhoto: r.host.photo_url,
      bet: r.bet,
      bank: r.bank,
      totalCells: r.totalCells,
      bombCount: r.bombCount,
      extremal: r.extremal,
    }));
}

function broadcastMinesRooms() {
  io.emit('mines:rooms', publicMinesRoomList());
}

function sanitizeMinesRoom(room) {
  return {
    id: room.id,
    bet: room.bet,
    bank: room.bank,
    totalCells: room.totalCells,
    bombCount: room.bombCount,
    extremal: room.extremal,
    vsBot: room.vsBot,
    status: room.status,
    revealed: room.revealed,
    turn: room.turn,
    turnDeadline: room.turnDeadline || null,
    winner: room.winner || null,
    players: room.players.map(p => ({ id: p.id, username: p.username, photo_url: p.photo_url })),
  };
}

function emitMinesRoom(room) {
  io.to(MINES_ROOM_PREFIX + room.id).emit('mines:state', sanitizeMinesRoom(room));
}

function pickMinesBombs(total, count) {
  const pool = Array.from({ length: total }, (_, i) => i);
  const picked = [];
  const n = Math.min(count, total);
  for (let k = 0; k < n; k++) {
    const r = Math.floor(Math.random() * pool.length);
    picked.push(pool[r]);
    pool.splice(r, 1);
  }
  return picked;
}

function refundMinesRoom(room) {
  const host = users.get(String(room.host.id));
  if (host) host.balance = round2(host.balance + room.bet);
}

function removeMinesRoom(room) {
  minesRooms.delete(room.id);
}

function clearMinesTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnDeadline = null;
}

function startMinesTurnTimer(room) {
  clearMinesTurnTimer(room);
  // Bot navbatida odam kutmaydi — bot baribir tez yuradi, taymer shart emas
  const turnPlayer = room.players[room.turn];
  if (!turnPlayer || turnPlayer.id === 'bot') return;

  room.turnDeadline = Date.now() + MINES_TURN_TIMEOUT_MS;
  room.turnTimer = setTimeout(() => {
    const current = minesRooms.get(room.id);
    if (!current || current.status !== 'playing') return;
    handleMinesTurnTimeout(current);
  }, MINES_TURN_TIMEOUT_MS);
}

function handleMinesTurnTimeout(room) {
  clearMinesTurnTimer(room);
  const loser = room.players[room.turn];
  const winner = room.players[room.turn === 0 ? 1 : 0];
  if (!loser || !winner) return;
  io.to(MINES_ROOM_PREFIX + room.id).emit('mines:timeout', {
    loserId: loser.id, winnerId: winner.id, vsBot: room.vsBot,
  });
  finishMinesRoom(room, winner, loser);
}

function startMinesRound(room) {
  room.bombIndices = pickMinesBombs(room.totalCells, room.bombCount);
  room.revealed = new Array(room.totalCells).fill(false);
  room.turn = 0;
  room.status = 'playing';
  room.winner = null;
  startMinesTurnTimer(room);
  emitMinesRoom(room);
  if (room.vsBot && room.turn === 1) scheduleMinesBotMove(room);
}

function scheduleMinesBotMove(room) {
  setTimeout(() => {
    const current = minesRooms.get(room.id);
    if (!current || current.status !== 'playing') return;
    const options = [];
    current.revealed.forEach((rev, idx) => { if (!rev) options.push(idx); });
    if (!options.length) return;
    const idx = options[Math.floor(Math.random() * options.length)];
    resolveMinesReveal(current, idx, current.players[1].id);
  }, MINES_BOT_MOVE_DELAY_MS);
}

function finishMinesRoom(room, winnerPlayer, loserPlayer) {
  clearMinesTurnTimer(room);
  room.status = 'finished';
  room.winner = { id: winnerPlayer.id, username: winnerPlayer.username };
  // Bot bilan o'yin — DEMO: real balans va statistikaga tegilmaydi,
  // faqat ekranda "yutdingiz/yutqazdingiz" natijasi ko'rsatiladi.
  if (!room.vsBot) {
    const winnerUser = users.get(String(winnerPlayer.id));
    if (winnerUser) {
      winnerUser.balance = round2(winnerUser.balance + room.bank);
      winnerUser.total_won += room.bank;
      winnerUser.wins += 1;
    }
  }
  emitMinesRoom(room);
  setTimeout(() => removeMinesRoom(room), 15000);
}

function resolveMinesReveal(room, idx, requesterId) {
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  if (room.pendingReveal) return { error: 'PENDING' };
  if (idx < 0 || idx >= room.totalCells || room.revealed[idx]) return { error: 'INVALID_CELL' };
  const currentPlayer = room.players[room.turn];
  if (String(currentPlayer.id) !== String(requesterId)) return { error: 'NOT_YOUR_TURN' };

  room.revealed[idx] = true;

  if (room.extremal) {
    room.pendingReveal = true;
    clearMinesTurnTimer(room); // extremal kutish vaqtida navbat taymeri to'xtatiladi
    io.to(MINES_ROOM_PREFIX + room.id).emit('mines:pending', { idx });
    setTimeout(() => {
      room.pendingReveal = false;
      finalizeMinesReveal(room, idx);
    }, MINES_EXTREMAL_DELAY_MS);
  } else {
    finalizeMinesReveal(room, idx);
  }
  return { ok: true };
}

function finalizeMinesReveal(room, idx) {
  const isBomb = room.bombIndices.includes(idx);

  if (isBomb) {
    const loser = room.players[room.turn];
    const winner = room.players[room.turn === 0 ? 1 : 0];
    io.to(MINES_ROOM_PREFIX + room.id).emit('mines:reveal', {
      idx, bomb: true, bombIndices: room.bombIndices,
      loserId: loser.id, winnerId: winner.id, vsBot: room.vsBot,
    });
    finishMinesRoom(room, winner, loser);
  } else {
    room.turn = room.turn === 0 ? 1 : 0;
    startMinesTurnTimer(room);
    io.to(MINES_ROOM_PREFIX + room.id).emit('mines:reveal', { idx, bomb: false, nextTurn: room.turn });
    emitMinesRoom(room);
    if (room.vsBot && room.turn === 1) scheduleMinesBotMove(room);
  }
}

function handleMinesDisconnect(socketId) {
  for (const room of Array.from(minesRooms.values())) {
    if (room.status === 'waiting' && room.host.socketId === socketId) {
      refundMinesRoom(room);
      removeMinesRoom(room);
      broadcastMinesRooms();
      continue;
    }
    if (room.status === 'playing' && !room.vsBot) {
      const idx = room.players.findIndex(p => p.socketId === socketId);
      if (idx !== -1) {
        const loser = room.players[idx];
        const winner = room.players[idx === 0 ? 1 : 0];
        io.to(MINES_ROOM_PREFIX + room.id).emit('mines:opponent_left', { winnerId: winner.id });
        finishMinesRoom(room, winner, loser);
      }
    }
  }
}

/* ============================================================
   SOCKET.IO — ulanganda joriy holatni bir marta yuboramiz
   ============================================================ */
io.on('connection', (socket) => {
  socket.emit('hockey:state', hockeyState);
  socket.emit('drum:state', drumState);
  socket.emit('team_battle:state', teamState);
  socket.emit('crash:state', sanitizeCrashState());

  // MUHIM (bug fix): yuqoridagi emit faqat socket ULANGAN paytda bir marta
  // yuboriladi. Agar foydalanuvchi keyinroq (masalan, boshqa sahifada bir oz
  // vaqt o'tkazgach) Hokkey/Baraban/Team Battle sahifasiga o'tsa, o'sha
  // eventni allaqachon "o'tkazib yuborgan" bo'ladi va navbatdagi haqiqiy
  // holat o'zgarishigacha (masalan, kimdir tikish qilmaguncha) "Yuklanmoqda..."
  // holatida qolib ketadi. Shu sababli mijoz sahifaga har safar kirganda
  // joriy holatni aniq so'rab olishi uchun alohida event qo'shildi.
  socket.on('get_state', (game) => {
    if (game === 'hockey') socket.emit('hockey:state', hockeyState);
    else if (game === 'drum') socket.emit('drum:state', drumState);
    else if (game === 'team_battle') socket.emit('team_battle:state', teamState);
    else if (game === 'crash') socket.emit('crash:state', sanitizeCrashState());
  });

  /* -------- RAKETA (CRASH) — "OLISH" real vaqtda, socket orqali -------- */
  socket.on('crash:cash_out', async (payload = {}, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const user = getSocketUser(payload.initData);
    if (!user) return ack({ error: 'invalid_auth' });
    if (crashState.status !== 'running') return ack({ error: 'NOT_RUNNING' });
    const p = crashState.players.find(pl => pl.id === Number(user.id));
    if (!p) return ack({ error: 'NO_BET' });
    if (p.cashedOutAt) return ack({ error: 'ALREADY_CASHED_OUT' });

    // Xavfsizlik: "OLISH" so'rovi kelgan lahzadagi multiplikator hech qachon
    // maxfiy portlash nuqtasidan katta bo'lib qolmasligi kerak (tarmoq
    // kechikishi tufayli so'rov biroz kech kelib qolishi mumkin).
    let mult = Math.min(currentCrashMultiplier(), crashSecretCrashPoint);
    mult = Math.round(mult * 100) / 100;
    p.cashedOutAt = mult;

    // Tikilgan summa qancha bo'lishidan qat'iy nazar: yutilgan qiymat
    // (bet * multiplikator) hisoblanadi va shu qiymatga yaqin narxdagi NFT
    // bo'lsa — coin o'rniga o'sha NFT beriladi, uning narxi esa aynan shu
    // yutilgan qiymat (masalan 5.34) bo'ladi.
    const wonValue = round2(p.bet * mult);
    const nftMatch = findNftMatchForValue(wonValue);

    let won = 0;
    let wonNft = null;
    if (nftMatch) {
      grantNftToUser(user, nftMatch.id, wonValue);
      // Popup'da NFT'ning haqiqiy animatsiyasini ko'rsatish uchun
      // custom_emoji_id / is_video ma'lumotini ham qo'shib yuboramiz.
      const nftMeta = await getEmojiMeta(nftMatch.custom_emoji_id);
      wonNft = {
        id: nftMatch.id,
        name: nftMatch.name,
        price: wonValue,
        custom_emoji_id: nftMatch.custom_emoji_id,
        is_video: nftMeta.is_video,
      };
    } else {
      won = wonValue;
      user.balance = round2(user.balance + won);
      user.total_won = round2((user.total_won || 0) + won);
    }
    p.won = won;
    p.wonNft = wonNft;
    user.wins = (user.wins || 0) + 1;
    emitCrashState();
    ack({ ok: true, multiplier: mult, won, wonNft, balance: user.balance });
  });

  /* -------- MINES 1vs1 -------- */
  socket.on('mines:get_rooms', () => {
    socket.emit('mines:rooms', publicMinesRoomList());
  });

  socket.on('mines:create_room', (payload = {}, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const user = getSocketUser(payload.initData);
    if (!user) return ack({ error: 'invalid_auth' });

    const bet = Number(payload.bet);
    const totalCells = MINES_ALLOWED_SIZES.includes(Number(payload.totalCells)) ? Number(payload.totalCells) : 25;
    const bombCount = MINES_ALLOWED_BOMBS.includes(Number(payload.bombCount)) ? Number(payload.bombCount) : 1;
    const extremal = !!payload.extremal;
    const vsBot = !!payload.vsBot;

    if (!bet || bet < MINES_MIN_BET) return ack({ error: 'INVALID_AMOUNT' });
    // Bot bilan o'ynash — DEMO rejim: real balans tekshirilmaydi va
    // undan hech narsa yechilmaydi, faqat vizual (o'yin ichidagi) raqamlar
    // uchun ishlatiladi.
    if (!vsBot) {
      if (bet > user.balance) return ack({ error: 'INSUFFICIENT_BALANCE' });
      user.balance = round2(user.balance - bet);
    }

    const room = {
      id: createMinesRoomId(),
      host: { id: Number(user.id), username: user.username, photo_url: user.photo_url, socketId: socket.id },
      bet, bank: bet * 2, totalCells, bombCount, extremal, vsBot,
      status: 'waiting',
      players: [{ id: Number(user.id), username: user.username, photo_url: user.photo_url, socketId: socket.id }],
      bombIndices: [], revealed: [], turn: 0, winner: null, pendingReveal: false,
      createdAt: Date.now(),
    };
    minesRooms.set(room.id, room);
    socket.join(MINES_ROOM_PREFIX + room.id);

    if (vsBot) {
      room.players.push({ id: 'bot', username: 'Bot 🤖', photo_url: null, socketId: null });
      startMinesRound(room);
    } else {
      broadcastMinesRooms();
    }

    ack({ ok: true, roomId: room.id, balance: user.balance, room: sanitizeMinesRoom(room) });
  });

  socket.on('mines:cancel_room', (payload = {}, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const user = getSocketUser(payload.initData);
    if (!user) return ack({ error: 'invalid_auth' });
    const room = minesRooms.get(payload.roomId);
    if (!room) return ack({ error: 'NOT_FOUND' });
    if (String(room.host.id) !== String(user.id)) return ack({ error: 'NOT_FOUND' });
    if (room.status !== 'waiting') {
      // Xona allaqachon boshlangan (raqib bekor qilish bosilgan lahzada
      // qo'shilib ulgurgan) — pul yechilmaydi, o'yin davom etadi, klientga
      // joriy holatni qaytaramiz shunda u to'g'ridan-to'g'ri o'yin
      // ekraniga o'tadi.
      return ack({ error: 'ALREADY_STARTED', room: sanitizeMinesRoom(room) });
    }
    refundMinesRoom(room);
    removeMinesRoom(room);
    broadcastMinesRooms();
    ack({ ok: true, balance: user.balance });
  });

  socket.on('mines:join_room', (payload = {}, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const user = getSocketUser(payload.initData);
    if (!user) return ack({ error: 'invalid_auth' });
    const room = minesRooms.get(payload.roomId);
    if (!room || room.status !== 'waiting') return ack({ error: 'NOT_FOUND' });
    if (String(room.host.id) === String(user.id)) return ack({ error: 'CANT_JOIN_OWN_ROOM' });
    if (room.bet > user.balance) return ack({ error: 'INSUFFICIENT_BALANCE' });

    user.balance = round2(user.balance - room.bet);
    room.players.push({ id: Number(user.id), username: user.username, photo_url: user.photo_url, socketId: socket.id });
    socket.join(MINES_ROOM_PREFIX + room.id);
    broadcastMinesRooms();
    startMinesRound(room);
    ack({ ok: true, roomId: room.id, balance: user.balance, room: sanitizeMinesRoom(room) });
  });

  socket.on('mines:reveal', (payload = {}, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const user = getSocketUser(payload.initData);
    if (!user) return ack({ error: 'invalid_auth' });
    const room = minesRooms.get(payload.roomId);
    if (!room) return ack({ error: 'NOT_FOUND' });
    const result = resolveMinesReveal(room, Number(payload.idx), user.id);
    ack(result);
  });

  socket.on('disconnect', () => {
    handleMinesDisconnect(socket.id);
  });
});

/* ============================================================
   ISHGA TUSHIRISH
   ============================================================ */
loadDb();
resetRetiredStarterNfts();
setInterval(saveDb, 10000);
process.on('SIGINT', () => { saveDb(); process.exit(0); });
process.on('SIGTERM', () => { saveDb(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`GIFT FESTI APP server ${PORT}-portda ishga tushdi`);
  console.log(`Admin ID'lar: ${ADMIN_IDS.length ? ADMIN_IDS.join(', ') : "(hech biri belgilanmagan — .env dagi ADMIN_IDS ni to'ldiring)"}`);
  if (!BOT_TOKEN) console.warn("OGOHLANTIRISH: BOT_TOKEN sozlanmagan — initData tekshirilmaydi (faqat dev/test uchun xavfsiz)!");
  // Raketa (Crash) — barcha foydalanuvchilar uchun umumiy raund tsikli
  // server ishga tushgan zahoti avtomatik boshlanadi (haqiqiy kazino
  // o'yinlariga o'xshab, o'yinchi kutib o'tirmasdan ham raundlar davom etadi).
  startCrashWaiting();
});
