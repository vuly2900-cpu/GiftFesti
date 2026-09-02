# GIFT FESTI APP — backend (Firebase o'rniga)

Bu loyiha avvalgi Firebase (Firestore) asosidagi frontendni o'zgartirmasdan,
**butun backendni shu server ichida** (Express + Socket.io) qayta yozilgan holda beradi.

## Nima o'zgardi

- Firestore **butunlay olib tashlandi** — na frontendda, na backendda ishlatilmaydi.
- Barcha ma'lumotlar (foydalanuvchilar, vazifalar, promo-kodlar, o'yin tarixi) shu
  serverning xotirasida saqlanadi va har 10 soniyada `db.json` fayliga yoziladi
  (server qayta ishga tushganda avtomatik o'qib olinadi — ma'lumot yo'qolmaydi).
- Xokkey / Baraban (drum) — bu ikkala o'yin ham endi Firestore
  `onSnapshot` o'rniga **Socket.io** orqali real vaqtda barcha foydalanuvchilarga
  translatsiya qilinadi.
- `public/index.html` — bitta faylning o'zi frontend, `server.js` esa uni xuddi
  shu portda serve qiladi (alohida frontend hosting kerak emas).

## O'rnatish

```bash
npm install
cp .env.example .env
# .env faylini to'ldiring: BOT_TOKEN, ADMIN_IDS, MAIN_CHANNEL
npm start
```

Server `http://localhost:3000` da (yoki `.env`dagi `PORT`) ishga tushadi va
frontendni ham, `/api/*` endpointlarini ham shu yerdan beradi.

## .env sozlamalari

| O'zgaruvchi | Tavsif |
|---|---|
| `BOT_TOKEN` | @BotFather dan olingan token. Telegram `initData`ni tekshirish, obuna tekshiruvi (`getChatMember`) va profil rasmini olish uchun **majburiy**. Bo'sh qoldirilsa, server faqat dev/test rejimida ishlaydi (imzo tekshirilmaydi, hamma "obuna" deb hisoblanadi) — **productionda hech qachon bo'sh qoldirmang**. |
| `MAIN_CHANNEL` | Case ochish uchun obuna talab qilinadigan asosiy kanal (`@username` shaklida). |
| `ADMIN_IDS` | Admin panelga kirish huquqi bo'lgan Telegram ID'lar, vergul bilan. |
| `PORT` | Server porti (Railway o'zi beradi). |
| `WEBAPP_URL` | Faqat `bot.js` uchun — Mini App manzili. |

## Fayllar

- `server.js` — asosiy backend: REST API + Socket.io + o'yin holat-mashinasi.
- `bot.js` — ixtiyoriy, alohida jarayon sifatida ishga tushiriladigan oddiy
  Telegram bot (`/start` va Mini App tugmasi). Agar botingiz allaqachon boshqa
  joyda ishlab turgan bo'lsa, bu faylni ishlatmasangiz ham bo'ladi.
- `public/index.html` — frontend (Firebase olib tashlangan, socket.io ulangan).

## API endpointlar (qisqacha)

```
POST /api/init_user            {initData, refBy}
POST /api/referral_reward      {initData, referrerId}
GET  /api/check_subscription   ?user_id=
POST /api/open_case            {initData}
GET  /api/tasks
POST /api/claim_task           {initData, taskId}
GET  /api/leaderboard
GET  /api/friends              ?user_id=
GET  /api/game_history/:game   (game = hockey | drum)
POST /api/redeem_promo         {initData, code}
POST /api/admin_action         {initData, action, payload}
POST /api/place_bet            {initData, game, amount}   (game = hockey | drum)
```

Real vaqt o'yin holati: socket.io orqali `hockey:state`, `drum:state`
eventlari barcha ulangan clientlarga yuboriladi.

## Muhim eslatma

`BOT_TOKEN` sozlanmagan holda server ishga tushsa ham ishlayveradi (dev/test
uchun qulay), lekin bu holda **hech qanday xavfsizlik tekshiruvi yo'q** —
istalgan kishi o'zini istalgan Telegram foydalanuvchisi qilib ko'rsata oladi.
Railway'ga joylashtirishdan oldin `.env`da `BOT_TOKEN`ni albatta to'ldiring.
