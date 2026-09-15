# GIFT FESTI APP — backend (Firebase o'rniga)

Bu loyiha avvalgi Firebase (Firestore) asosidagi frontendni o'zgartirmasdan,
**butun backendni shu server ichida** (Express + Socket.io) qayta yozilgan holda beradi.

## Nima o'zgardi

- Firestore **butunlay olib tashlandi** — na frontendda, na backendda ishlatilmaydi.
- Barcha ma'lumotlar (foydalanuvchilar, vazifalar, promo-kodlar, o'yin tarixi) shu
  serverning xotirasida saqlanadi va har 10 soniyada **MongoDB Atlas**'ga (bepul
  tarif) yoziladi — server qayta ishga tushganda/deploy qilinganda avtomatik
  o'qib olinadi, ma'lumot yo'qolmaydi. `MONGODB_URI` sozlanmasa, zaxira sifatida
  local `db.json` fayli ishlatiladi, lekin bu Railway/Render kabi hostinglarda
  **restart'da yo'qoladi** — shuning uchun productionda `MONGODB_URI`ni albatta
  sozlang (qarang: "Ma'lumotlar bazasi (MongoDB)" bo'limi).
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
| `MONGODB_URI` | MongoDB Atlas connection string. **Productionda majburiy** — bo'sh bo'lsa ma'lumotlar restart'da yo'qoladi (pastga qarang). |
| `MONGODB_DB` | Ixtiyoriy, baza nomi (default: `giftfesti`). |

## Ma'lumotlar bazasi (MongoDB) — bepul, doimiy saqlash

Restart/deploy qilinganda ma'lumotlar o'chib ketmasligi uchun **MongoDB
Atlas**'da bepul cluster yarating (512MB, muddatsiz, so'rovlar soni
cheklanmagan):

1. https://www.mongodb.com/cloud/atlas -> ro'yxatdan o'ting -> **"M0 Free"**
   cluster yarating (istalgan region).
2. **Database Access** -> yangi user yarating (username/parol) -> "Read and
   write to any database" huquqi bilan.
3. **Network Access** -> **"Allow access from anywhere"** (`0.0.0.0/0`) qo'shing
   — aks holda Railway/Render'dan ulanib bo'lmaydi.
4. **Database -> Connect -> Drivers** -> Node.js -> connection string'ni
   nusxalang, `<password>` o'rniga haqiqiy parolingizni yozing.
5. Shu qiymatni hostingingizning **Environment Variables** bo'limiga
   `MONGODB_URI` nomi bilan qo'shing (Railway: Variables tab).
6. Serverni qayta ishga tushiring — konsolda `MongoDB'ga ulandi` yozuvini
   ko'rasiz. Shundan keyin restart/deploy qilsangiz ham barcha foydalanuvchi,
   balans va NFT ma'lumotlari saqlanib qoladi.

`MONGODB_URI` bo'sh qoldirilsa, server baribir ishlayveradi (local `db.json`
bilan) — bu faqat **local test** uchun mos, productionda ishlatmang.

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
GET  /api/ice_case_items
POST /api/open_ice_case        {initData}
POST /api/ice_case/create_invoice   {initData}   (Stars orqali)
POST /api/ice_case/claim_result     {initData}
POST /api/redeem_promo         {initData, code}
POST /api/admin_action         {initData, action, payload}
POST /api/place_bet            {initData, game, amount}   (game = hockey | drum)
POST /api/create_topup_invoice {initData, coins}          (Telegram Stars invoys havolasini qaytaradi)
POST /api/dice/create_room     {initData, maxPlayers, stake}
POST /api/dice/join_room       {initData, roomId}
POST /api/dice/leave_room      {initData, roomId}         (faqat "waiting" holatidagi xonadan, stavka to'liq qaytariladi)
```

Real vaqt o'yin holati: socket.io orqali `hockey:state`, `drum:state`,
`dice:state` eventlari barcha ulangan clientlarga yuboriladi.

## DICE — xona asosidagi ko'p o'yinchili tosh o'yini

Xona yaratuvchi 2-8 oralig'ida o'yinchilar sonini va har bir o'yinchi
to'laydigan stavka (coin) miqdorini tanlaydi. Xona to'lgach 15 soniyalik
taймer boshlanadi, so'ng o'yinchilar navbat bilan (2.2s aylanish
animatsiyasi bilan) tosh otadi. Eng ko'p son tushirgan(lar) qoladi,
qolganlar avtomatik yutqazadi; agar bir nechta o'yinchida eng katta son
teng chiqsa, faqat o'shalar yana tosh otadi — toki 1 kishi qolguncha.
G'olib butun pot (barcha stavkalar yig'indisi)ni yutib oladi.

## Balansni to'ldirish (Telegram Stars)

Foydalanuvchi "+" yoki "💳 To'ldirish" tugmasini bosganda alohida oyna
ochiladi va nechta coin to'ldirmoqchi ekanligi so'raladi (**1 ⭐ Stars =
100 coin**). "To'ldirish" bosilganda:

1. Frontend `/api/create_topup_invoice` ga so'rov yuboradi — server
   Telegram Bot API orqali (`createInvoiceLink`, valyuta `XTR`) invoys
   havolasi yaratadi.
2. Frontend shu havolani `Telegram.WebApp.openInvoice(...)` bilan ochadi —
   Telegram'ning o'zining to'lov oynasi chiqadi.
3. To'lov muvaffaqiyatli bo'lgach, Telegram `bot.js`ga `successful_payment`
   yangilanishini yuboradi; `bot.js` esa server.js dagi ichki
   `/api/internal_topup_credit` orqali foydalanuvchi balansiga coin
   qo'shadi va tasdiq xabari yuboradi.

**Muhim:** bu funksiya ishlashi uchun `bot.js` ham ishga tushirilgan
bo'lishi shart (`npm run bot`), chunki `successful_payment` xabarlarini
faqat u qabul qiladi.

## Muhim eslatma

`BOT_TOKEN` sozlanmagan holda server ishga tushsa ham ishlayveradi (dev/test
uchun qulay), lekin bu holda **hech qanday xavfsizlik tekshiruvi yo'q** —
istalgan kishi o'zini istalgan Telegram foydalanuvchisi qilib ko'rsata oladi.
Railway'ga joylashtirishdan oldin `.env`da `BOT_TOKEN`ni albatta to'ldiring.
