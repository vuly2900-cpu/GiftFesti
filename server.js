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
const gameHistory = { hockey: [], drum: [], team_battle: [] };

function createUser(id, username) {
  return {
    id, username, photo_url: null,
    balance: 100, total_won: 0, wins: 0,
    completedTasks: new Set(),
    lastCaseOpenedAt: null,
    referredBy: null,
    referralRewarded: false,
    isAdmin: ADMIN_IDS.includes(String(id)),
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
      users.set(String(u.id), { ...u, completedTasks: new Set(u.completedTasks || []) });
    });
    (data.friends || []).forEach(([k, v]) => friends.set(k, v));
    tasks = data.tasks || [];
    promos = (data.promos || []).map(p => ({ ...p, usedBy: new Set(p.usedBy || []) }));
    if (data.gameHistory) Object.assign(gameHistory, data.gameHistory);
    if (data.gameNumbers) {
      hockeyState.game_number = data.gameNumbers.hockey || 1;
      drumState.game_number = data.gameNumbers.drum || 1;
      teamState.game_number = data.gameNumbers.team_battle || 1;
    }
    console.log(`DB yuklandi: ${users.size} foydalanuvchi, ${tasks.length} vazifa, ${promos.length} promo`);
  } catch (e) { console.error('DB yuklashda xatolik:', e.message); }
}

/* ============================================================
   YORDAMCHI FUNKSIYALAR
   ============================================================ */
function pickWeighted(players, key) {
  const total = players.reduce((s, p) => s + p[key], 0);
  let r = Math.random() * total;
  for (const p of players) {
    if (r < p[key]) return p;
    r -= p[key];
  }
  return players[players.length - 1];
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

/* ---- Kunlik case sovrinlari (server-authoritative) ---- */
const CASE_ITEMS = [
  { emoji: '🧸', value: 15, tier: 15 },
  { emoji: '💝', value: 15, tier: 15 },
  { emoji: '🎁', value: 25, tier: 25 },
  { emoji: '🌹', value: 25, tier: 25 },
  { emoji: '🎂', value: 50, tier: 50 },
  { emoji: '💐', value: 50, tier: 50 },
  { emoji: '🚀', value: 50, tier: 50 },
  { emoji: '🍾', value: 50, tier: 50 },
  { emoji: '🏆', value: 100, tier: 100 },
  { emoji: '💍', value: 100, tier: 100 },
  { emoji: '💎', value: 100, tier: 100 },
];
const CASE_TIER_WEIGHTS = { 100: 0.1, 50: 1, 25: 5, 15: 10 };
const CASE_STAR_WEIGHTS = { 10: 20, 7: 30, 5: 35, 3: 40, 1: 80, 0: 70 };
function pickCaseReward() {
  const tierCounts = {};
  CASE_ITEMS.forEach(i => { tierCounts[i.tier] = (tierCounts[i.tier] || 0) + 1; });
  const outcomes = [];
  CASE_ITEMS.forEach(item => {
    outcomes.push({ stars: item.value, emoji: item.emoji, isGift: true, tier: item.tier, weight: CASE_TIER_WEIGHTS[item.tier] / tierCounts[item.tier] });
  });
  Object.entries(CASE_STAR_WEIGHTS).forEach(([stars, weight]) => {
    outcomes.push({ stars: Number(stars), emoji: null, isGift: false, weight });
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
  const reward = pickCaseReward();
  user.balance += reward.stars;
  user.total_won += reward.stars;
  user.lastCaseOpenedAt = Date.now();
  res.json({ ok: true, reward });
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
    res.status(500).json({ error: 'server_error' });
  }
});

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
  if (state.players.length < 1) {
    // Hech kim tikmagan bo'lsa, o'yin kutishda qoladi (idle holatiga qaytariladi
    // emas, chunki status hali 'betting'ga o'tmagan bo'ladi — bu holat aslida
    // yuzaga kelmaydi, chunki taymer faqat birinchi tikish qilinganda ishga tushadi).
    return;
  }
  // 1 kishi tikkan bo'lsa ham raund hal qilinadi — pickWeighted bitta o'yinchi
  // bilan ham to'g'ri ishlaydi va u o'z tikkan summasini yutib oladi.
  resolveRound(game);
}

function resolveRound(game) {
  const state = getState(game);
  state.status = 'spinning_visual';

  if (game === 'hockey') {
    const winner = pickWeighted(state.players, 'stars');
    state.winner = { id: winner.id, username: winner.username, photo: winner.photo, stars: winner.stars };
    state.puckSeed = { angle: Math.random() * 360 };
  } else if (game === 'drum') {
    const winner = pickWeighted(state.players, 'stars');
    const total = state.players.reduce((s, p) => s + p.stars, 0) || 1;
    let cursor = 0, start = 0, end = 360;
    for (const p of state.players) {
      const size = p.stars / total * 360;
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
    if (wUser) { wUser.balance += pot; wUser.total_won += pot; wUser.wins += 1; }
    historyEntry.winner_id = winner.id;
    historyEntry.players = state.players.map(p => ({
      id: p.id, username: p.username, photo: p.photo, stars: p.stars,
      chance: pot ? Number(((p.stars / pot) * 100).toFixed(1)) : 0,
      won: p.id === winner.id ? pot : 0,
    }));
  } else if (game === 'team_battle') {
    historyEntry.winner_color = state.winner.color;
    const payouts = state.winner.payouts;
    state.players.forEach(p => {
      const won = payouts[String(p.id)] || 0;
      if (won > 0) {
        const u = users.get(String(p.id));
        if (u) { u.balance += won; u.total_won += won; u.wins += 1; }
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
  if (!amt || amt < 10) return res.status(400).json({ error: 'invalid_amount' });
  if (amt > user.balance) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

  const state = getState(game);
  if (state.status === 'spinning_visual' || state.status === 'cooldown') {
    return res.status(400).json({ error: 'GAME_NOT_ACCEPTING_BETS' });
  }

  user.balance -= amt;
  const existing = state.players.find(p => p.id === Number(user.id));
  if (existing) existing.stars += amt;
  else state.players.push({ id: Number(user.id), username: user.username, photo: user.photo_url, stars: amt, color: colorFor(state.players.length) });
  state.pot += amt;

  if (state.status === 'idle') {
    state.status = 'betting';
    state.bettingStartedAt = Date.now();
    startBettingTimer(game);
  }
  emitState(game);
  res.json({ ok: true, balance: user.balance });
});

/* ---- Tikish (team battle) ---- */
app.post('/api/place_team_bet', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const { amount, color } = req.body || {};
  if (!['red', 'green', 'blue'].includes(color)) return res.status(400).json({ error: 'invalid_color' });

  const amt = Number(amount);
  if (!amt || amt < 10) return res.status(400).json({ error: 'invalid_amount' });
  if (amt > user.balance) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

  const state = teamState;
  if (state.status === 'spinning_visual' || state.status === 'cooldown') {
    return res.status(400).json({ error: 'GAME_NOT_ACCEPTING_BETS' });
  }
  const existing = state.players.find(p => p.id === Number(user.id));
  if (existing && existing.color !== color) return res.status(400).json({ error: 'COLOR_LOCKED' });

  user.balance -= amt;
  if (existing) existing.stars += amt;
  else state.players.push({ id: Number(user.id), username: user.username, photo: user.photo_url, stars: amt, color });
  state.pot += amt;
  state.colorTotals[color] = (state.colorTotals[color] || 0) + amt;

  if (state.status === 'idle') {
    state.status = 'betting';
    state.bettingStartedAt = Date.now();
    startBettingTimer('team_battle');
  }
  emitState('team_battle');
  res.json({ ok: true, balance: user.balance });
});

/* ============================================================
   SOCKET.IO — ulanganda joriy holatni bir marta yuboramiz
   ============================================================ */
io.on('connection', (socket) => {
  socket.emit('hockey:state', hockeyState);
  socket.emit('drum:state', drumState);
  socket.emit('team_battle:state', teamState);

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
  });
});

/* ============================================================
   ISHGA TUSHIRISH
   ============================================================ */
loadDb();
setInterval(saveDb, 10000);
process.on('SIGINT', () => { saveDb(); process.exit(0); });
process.on('SIGTERM', () => { saveDb(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`GIFT FESTI APP server ${PORT}-portda ishga tushdi`);
  console.log(`Admin ID'lar: ${ADMIN_IDS.length ? ADMIN_IDS.join(', ') : "(hech biri belgilanmagan — .env dagi ADMIN_IDS ni to'ldiring)"}`);
  if (!BOT_TOKEN) console.warn("OGOHLANTIRISH: BOT_TOKEN sozlanmagan — initData tekshirilmaydi (faqat dev/test uchun xavfsiz)!");
});
