# CF Combined Bot

ربات تلگرام ترکیبی: **پیامرسان** + **آپلودر محتوا** — اجرا روی Cloudflare Workers

## ✅ قابلیت‌ها

### 📨 بخش پیامرسان
- ارسال پیام عادی (با اطلاعات کاربر)
- ارسال پیام ناشناس (بدون اطلاعات)
- پاسخ ادمین به کاربر
- بن/آنبلاک کاربر
- پیام همگانی

### 📚 بخش محتوای آموزشی
- دکمه‌ها و زیرمجموعه‌های تو در تو
- آپلود محتوا (عکس، ویدیو، فایل، صوت، ویس، استیکر، گیف، متن)
- آپلود گروهی با تایید نهایی
- صفحه‌بندی جلسه‌ها
- protect_content (جلوگیری از فوروارد)
- فعال/غیرفعال کردن دکمه‌ها

### 🔰 پنل مدیریت
- مدیریت دکمه‌ها (ایجاد، ویرایش، حذف)
- آمار کلی
- بن/آزادسازی
- عضویت اجباری

## 🏗️ ساختار پروژه

```
cf-combined-bot/
├── wrangler.toml          # تنظیمات Cloudflare Worker
├── schema.sql             # Schema دیتابیس D1
├── src/
│   ├── index.js           # نقطه ورودی اصلی
│   ├── db.js              # لایه دیتابیس D1
│   ├── handlers/
│   │   ├── user.js        # منوی کاربر + ناوبری محتوا
│   │   ├── messenger.js   # پیامرسان (عادی/ناشناس)
│   │   └── admin.js       # پنل مدیریت
│   ├── services/
│   │   ├── keyboard.js    # ساخت کیبوردها
│   │   └── content.js     # تشخیص و ارسال محتوا
│   └── utils/
│       ├── telegram.js    # Telegram Bot API helper
│       └── common.js      # ابزارهای عمومی
└── README.md
```

## 🚀 نحوه راه‌اندازی

### ۱. پیش‌نیازها
- اکانت Cloudflare
- توکن ربات تلگرام (از @BotFather)
- Node.js 18+
- Wrangler CLI

### ۲. نصب Wrangler
```bash
npm install -g wrangler
wrangler login
```

### ۳. ساخت D1 Database
```bash
cd cf-combined-bot
wrangler d1 create combined-bot-db
```
آیدی دیتابیس رو از خروجی کپی کن و توی `wrangler.toml` جایگزین کن.

### ۴. اعمال Schema
```bash
wrangler d1 execute combined-bot-db --remote --file=schema.sql
```

### ۵. تنظیم متغیرها
توی `wrangler.toml` مقادیر زیر رو پر کن:
```toml
[vars]
BOT_TOKEN = "توکن_ربات"
MAIN_ADMIN_ID = "آیدی_ادمین"
ADMIN_IDS = "آیدی_ادمین1,آیدی_ادمین2"
```

### ۶. Deploy
```bash
wrangler deploy
```

### ۷. تنظیم Webhook
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://cf-combined-bot.<SUBDOMAIN>.workers.dev/webhook"
```

### ۸. تست
1. ربات رو باز کن و `/start` بزن
2. بخش پیامرسان و محتوا رو ببین
3. با `/admin` وارد پنل مدیریت شو

## 📋 محیط‌ها

| متغیر | توضیح |
|--------|-------|
| `BOT_TOKEN` | توکن ربات تلگرام |
| `MAIN_ADMIN_ID` | آیدی عددی ادمین اصلی |
| `ADMIN_IDS` | لیست ادمین‌ها (با کاما) |

## 📊 آمار

| مورد | مقدار |
|------|-------|
| کل فایل‌ها | ۱۱ |
| کل خطوط کد | ~۲۱۰۰ |
| زبان | JavaScript (ES Modules) |
| پلتفرم | Cloudflare Workers |
| دیتابیس | Cloudflare D1 (SQLite) |
