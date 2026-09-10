// ══════════════════════════════════════════════════════════════════════════
// ═══════ CF Combined Bot: Single-File Full Cloudflare Worker Bot ═══════
// ══════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const payload = await request.json();
        if (payload.message) {
          ctx.waitUntil(handleMessage(payload.message, env).catch(e => console.error("Msg fail:", e)));
        }
        if (payload.callback_query) {
          ctx.waitUntil(handleCallback(payload.callback_query, env).catch(e => console.error("CB fail:", e)));
        }
      } catch (err) {
        console.error("Error parsing JSON body:", err);
      }
    }
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoBackup(env).catch(e => console.error("AutoBackup fail:", e)));
  }
};

// ═══════ TELEGRAM API HELPERS ═══════

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function chunkArray21(items) {
  const rows = [];
  let index = 0;
  let rowSize = 2; // Alternates: 2, 1, 2, 1...
  while (index < items.length) {
    const chunk = items.slice(index, index + rowSize);
    rows.push(chunk);
    index += rowSize;
    rowSize = (rowSize === 2) ? 1 : 2;
  }
  return rows;
}

async function tg(method, body, env) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function getBotUsername(env) {
  try {
    const res = await tg("getMe", {}, env);
    if (res && res.ok && res.result && res.result.username) {
      return res.result.username;
    }
  } catch (e) {}
  return "Bot";
}

async function sendMsg(chatId, text, env, extra = {}) {
  const body = { chat_id: chatId, text, ...extra };
  if (!body.parse_mode) body.parse_mode = "HTML";
  if (body.reply_markup && typeof body.reply_markup !== "string") {
    body.reply_markup = JSON.stringify(body.reply_markup);
  }
  return tg("sendMessage", body, env);
}

async function editMsg(chatId, msgId, text, env, extra = {}) {
  const body = { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", ...extra };
  if (body.reply_markup && typeof body.reply_markup !== "string") {
    body.reply_markup = JSON.stringify(body.reply_markup);
  }
  return tg("editMessageText", body, env);
}

async function safeEditMsg(chatId, msgId, text, env, extra = {}) {
  try {
    const res = await editMsg(chatId, msgId, text, env, extra);
    if (res && res.ok) return res;
    if (res && res.description && res.description.includes("not modified")) {
      return res;
    }
    return await sendMsg(chatId, text, env, extra);
  } catch (e) {
    console.error("safeEditMsg exception:", e);
    return await sendMsg(chatId, text, env, extra);
  }
}

async function answerCb(cbId, env, text = "", showAlert = false) {
  if (!cbId) return { ok: false };
  return tg("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: showAlert });
}

async function sendDocumentFile(chatId, fileBuffer, fileName, caption, env) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  if (caption) formData.append("caption", caption);
  formData.append("parse_mode", "HTML");
  formData.append("document", new Blob([fileBuffer], { type: "application/json" }), fileName);

  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData,
  });
  return r.json();
}

// ═══════ D1 HELPERS ═══════

async function dbRun(env, sql, params = []) {
  return env.BOT_DB.prepare(sql).bind(...params).run();
}

async function dbFirst(env, sql, params = []) {
  return (await env.BOT_DB.prepare(sql).bind(...params).first()) || null;
}

async function dbAll(env, sql, params = []) {
  const { results } = await env.BOT_DB.prepare(sql).bind(...params).all();
  return results || [];
}

async function ensureTables(env) {
  const t = [
    `CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, blocked INTEGER DEFAULT 0, chat_mode TEXT DEFAULT 'normal', updated_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS admins (user_id INTEGER PRIMARY KEY, role TEXT DEFAULT 'admin')`,
    `CREATE TABLE IF NOT EXISTS buttons (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER DEFAULT 0, name TEXT NOT NULL, is_active INTEGER DEFAULT 1, protect_content INTEGER DEFAULT 0, order_index INTEGER DEFAULT 0, upload_completed INTEGER DEFAULT 0, downloads INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS button_contents (id INTEGER PRIMARY KEY AUTOINCREMENT, button_id INTEGER NOT NULL, order_index INTEGER DEFAULT 0, content_kind TEXT DEFAULT 'text', content_text TEXT DEFAULT '', content_file_id TEXT DEFAULT '', archive_chat_id TEXT DEFAULT '', archive_message_id TEXT DEFAULT '', downloads INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS user_states (user_id INTEGER PRIMARY KEY, state TEXT DEFAULT '', data TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS forced_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL UNIQUE, channel_ref TEXT)`,
  ];
  for (const s of t) {
    try { await dbRun(env, s); } catch (e) { /* ignore */ }
  }
  try { await dbRun(env, "ALTER TABLE buttons ADD COLUMN upload_completed INTEGER DEFAULT 0"); } catch (e) {}
  try { await dbRun(env, "ALTER TABLE buttons ADD COLUMN protect_content INTEGER DEFAULT 0"); } catch (e) {}
  try { await dbRun(env, "ALTER TABLE buttons ADD COLUMN downloads INTEGER DEFAULT 0"); } catch (e) {}
  try { await dbRun(env, "ALTER TABLE button_contents ADD COLUMN downloads INTEGER DEFAULT 0"); } catch (e) {}
  try { await dbRun(env, "ALTER TABLE button_contents ADD COLUMN archive_chat_id TEXT DEFAULT ''"); } catch (e) {}
  try { await dbRun(env, "ALTER TABLE button_contents ADD COLUMN archive_message_id TEXT DEFAULT ''"); } catch (e) {}
}

// ═══════ ADMIN CHECK ═══════

async function isAdmin(userId, env) {
  if (!userId) return false;
  const uidStr = String(userId).trim();
  const main = String(env.MAIN_ADMIN_ID || "").trim();
  if (main && uidStr === main) return true;
  if (env.ADMIN_IDS) {
    const ids = String(env.ADMIN_IDS).split(",").map(s => s.trim());
    if (ids.includes(uidStr)) return true;
  }
  try {
    const row = await dbFirst(env, "SELECT user_id FROM admins WHERE user_id = ?", [userId]);
    if (row) return true;
  } catch (e) {}
  return false;
}

function isOwner(userId, env) {
  const main = String(env.MAIN_ADMIN_ID || "").trim();
  return main && String(userId).trim() === main;
}

// ═══════ FORCE JOIN CHECK ═══════

async function checkForceJoin(userId, env) {
  if (await isAdmin(userId, env)) return { ok: true, unjoined: [] };
  const channels = await dbAll(env, "SELECT channel, channel_ref FROM forced_channels");
  if (!channels || channels.length === 0) return { ok: true, unjoined: [] };

  const unjoined = [];
  for (const item of channels) {
    const rawCh = (item.channel || item.channel_ref || "").trim();
    if (!rawCh) continue;
    let chatRef = rawCh;
    if (!chatRef.startsWith("@") && !chatRef.startsWith("-100") && !chatRef.startsWith("t.me/")) {
      chatRef = "@" + chatRef;
    }
    if (chatRef.startsWith("t.me/")) {
      chatRef = "@" + chatRef.replace("t.me/", "");
    }
    try {
      const res = await tg("getChatMember", { chat_id: chatRef, user_id: userId }, env);
      if (res && res.ok && res.result) {
        const st = res.result.status;
        if (["left", "kicked", "banned"].includes(st)) {
          unjoined.push(chatRef);
        }
      } else {
        unjoined.push(chatRef);
      }
    } catch (e) {
      unjoined.push(chatRef);
    }
  }
  return { ok: unjoined.length === 0, unjoined };
}

async function sendForceJoinMessage(chatId, unjoined, env, payload = "") {
  const rows = [];
  for (const ch of unjoined) {
    const cleanHandle = ch.replace("@", "");
    const url = ch.startsWith("http") ? ch : `https://t.me/${cleanHandle}`;
    rows.push([{ text: `📌 عضویت در کانال ${ch}`, url }]);
  }
  rows.push([{ text: "✅ تایید عضویت", callback_data: `check_force_join:${payload || "none"}` }]);
  const txt = `⚠️ <b>عضویت اجباری</b>\n\nبرای استفاده از ربات و دریافت محتوا، ابتدا باید در کانال(های) زیر عضو شوید:\n\nپس از عضویت، روی دکمه <b>«✅ تایید عضویت»</b> کلیک کنید.`;
  await sendMsg(chatId, txt, env, { reply_markup: { inline_keyboard: rows } });
}

// ═══════ USER STATE ═══════

async function getState(userId, env) {
  const row = await dbFirst(env, "SELECT state, data FROM user_states WHERE user_id = ?", [userId]);
  if (!row) return null;
  let parsedData = {};
  try { parsedData = JSON.parse(row.data || "{}"); } catch (e) {}
  return { state: row.state, data: parsedData };
}

async function setState(userId, state, data, env) {
  const jsonStr = JSON.stringify(data || {});
  await dbRun(
    env,
    "INSERT INTO user_states (user_id, state, data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=datetime('now')",
    [userId, state, jsonStr]
  );
}

async function clearState(userId, env) {
  await dbRun(env, "DELETE FROM user_states WHERE user_id = ?", [userId]);
}

// ═══════ KEYBOARDS ═══════

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "📚 محتوای آموزشی" }, { text: "📨 ارسال پیام" }]
    ],
    resize_keyboard: true,
  };
}

function msgTypeKeyboard() {
  return {
    keyboard: [
      [{ text: "💌 پیام ناشناس" }, { text: "🫶🏻 پیام عادی" }],
      [{ text: "🔙 بازگشت" }]
    ],
    resize_keyboard: true,
  };
}

function cancelKeyboard() {
  return { keyboard: [[{ text: "لغو" }]], resize_keyboard: true };
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "➕ افزودن دکمه اصلی", callback_data: "admin:btn:add:0" },
        { text: "📋 مدیریت دکمه‌ها", callback_data: "admin:btn:manage:0" }
      ],
      [
        { text: "🧠 آرشیو هوشمند", callback_data: "admin:smartarchive:menu" },
        { text: "📣 پیام همگانی", callback_data: "admin:broadcast:start" }
      ],
      [
        { text: "🚫 بن/آزادسازی کاربر", callback_data: "admin:ban:menu" },
        { text: "📌 عضویت اجباری", callback_data: "admin:forcejoin:menu" }
      ],
      [
        { text: "🗄️ کانال آرشیو محتوا", callback_data: "admin:archive:menu" },
        { text: "🗃️ بکاپ و بازیابی", callback_data: "admin:backup:menu" }
      ],
      [
        { text: "📊 آمار کلی", callback_data: "admin:stats" }
      ],
      [
        { text: "🏠 منوی اصلی", callback_data: "menu:home" }
      ]
    ]
  };
}

function adminManageButtonsKeyboard(buttons, parentId, parentParentId) {
  const flat = [];
  for (const b of buttons) {
    if (Number(b.id) === 0) continue;
    const statusIcon = b.is_active ? "🟢" : "🔴";
    const protectIcon = b.protect_content ? "🔒" : "";
    flat.push({
      text: `${statusIcon}${protectIcon} ${b.name}`,
      callback_data: `admin:btn:edit:${b.id}`
    });
  }

  const chunked = chunkArray21(flat);

  chunked.push([{ text: "➕ افزودن زیرمجموعه", callback_data: `admin:btn:add:${parentId}` }]);
  
  if (Number(parentId) !== 0) {
    chunked.push([{ text: "🔙 بازگشت به لایه قبل", callback_data: `admin:btn:manage:${Number(parentParentId || 0)}` }]);
  }
  chunked.push([{ text: "🔙 بازگشت به پنل مدیریت", callback_data: "admin:panel" }]);

  return { inline_keyboard: chunked };
}

function adminEditButtonKeyboard(buttonId, parentId, isActive, isProtected, isUploadCompleted) {
  const toggleText = isActive ? "🔴 غیرفعال‌سازی" : "🟢 فعال‌سازی";
  const protectText = isProtected ? "🔒 قفل محتوا و زیرمجموعه‌ها: فعال" : "🔓 قفل محتوا: غیرفعال";
  const uploadDoneText = isUploadCompleted ? "🟢 آپلود: تکمیل" : "🔴 آپلود: در جریان";

  return {
    inline_keyboard: [
      [{ text: "✏️ تغییر نام دکمه", callback_data: `admin:btn:rename:${buttonId}` }],
      [
        { text: "🔗 لینک مستقیم", callback_data: `admin:btn:deeplink:${buttonId}` },
        { text: "📣 اطلاع‌رسانی آپدیت", callback_data: `admin:btn:notify:${buttonId}` }
      ],
      [
        { text: "📤 آپلود محتوا", callback_data: `admin:btn:append:${buttonId}` },
        { text: uploadDoneText, callback_data: `admin:btn:uploaddone:${buttonId}` }
      ],
      [
        { text: "📁 مدیریت زیردکمه‌ها", callback_data: `admin:btn:manage:${buttonId}` },
        { text: "🧩 ایجاد جلسه گروهی", callback_data: `admin:btn:sessions:${buttonId}` }
      ],
      [
        { text: protectText, callback_data: `admin:btn:protect:${buttonId}` },
        { text: toggleText, callback_data: `admin:btn:toggle:${buttonId}` }
      ],
      [{ text: "📦 انتقال به چنل آرشیو", callback_data: `admin:btn:archivepush:${buttonId}` }],
      [{ text: "🗑️ حذف کامل دکمه", callback_data: `admin:btn:delete:${buttonId}` }],
      [
        { text: "🔙 بازگشت به لیست دکمه‌ها", callback_data: `admin:btn:manage:${parentId}` },
        { text: "🔙 پنل مدیریت", callback_data: "admin:panel" }
      ]
    ]
  };
}

function adminUploadReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "✅ اتمام آپلود" }, { text: "📋 نمایش لیست" }],
      [{ text: "❌ لغو کل آپلود" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function broadcastConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ ارسال کن", callback_data: "admin:broadcast:confirm" },
        { text: "❌ لغو", callback_data: "admin:broadcast:cancel" }
      ]
    ]
  };
}

function backToPanelKeyboard() {
  return { inline_keyboard: [[{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]] };
}

// ═══════ WELCOME TEXT ═══════

function welcomeText(from) {
  const name = escapeHtml(from?.first_name || from?.username || "عزیز");
  return `🧡 › درود ${name} رفیق من :)

اینجا میتونی درخواست و پیشنهاداتو برای ما بفرستی و ما در کمترین زمان ممکن میخونیمیش و حتماً پاسخ میدیم .
<blockquote>💌 › پیــام ناشنــاس : رفیق من پیامتو که میفرستی ناشناس ارسال میشه و هیچ اطلاعاتی از اکانت شما برای ما معلوم نیست .</blockquote>
<blockquote>🫶🏻 › پیـــام عـــادی : رفیق من پیامتو ک میفرستی اسم اکانتت مشخصه و برای ما پیداست که از سمت کی پیام دریافت کردیم .</blockquote>
<blockquote>📚 › محتــوای آموزشی : در این قسمت میتونی محتوای های مختلفی همچون " پادکست های مشاوره ای ، برنامه های راهبردی و تحصلی ، جزوات و پکیج های درسی و مصاحبه ای و ... " رو ببینی و دریافت کنی .</blockquote>`;
}

// ═══════ HELPER FUNCTIONS ═══════

function shortKind(kind) {
  const labels = { text: "متن", photo: "عکس", video: "ویدیو", document: "فایل", audio: "صوت", voice: "ویس", sticker: "استیکر", animation: "گیف" };
  return labels[kind] || kind || "نامشخص";
}

function buildUploadListText(pending) {
  if (!pending || pending.length === 0) return "📭 هنوز هیچ محتوایی در لیست موقت ندارید.";
  const lines = pending.slice(0, 30).map((item, i) => {
    const k = shortKind(item.kind);
    const cap = (item.text || "").replace(/\n/g, " ").trim();
    return `${i + 1}. ${k}${cap ? " | " + escapeHtml(cap.substring(0, 50)) + (cap.length > 50 ? "…" : "") : ""}`;
  });
  if (pending.length > 30) lines.push(`… و ${pending.length - 30} مورد دیگر`);
  return `📋 لیست موقت آپلودها (${pending.length} مورد):\n\n` + lines.join("\n");
}

// Send an individual item to Archive Channel and return API response
async function sendContentItemToArchive(archiveChatId, item, env) {
  const { kind, text, file_id } = item;
  const extra = { chat_id: archiveChatId };
  if (text) extra.caption = text;
  extra.parse_mode = "HTML";

  switch (kind) {
    case "text":
      return sendMsg(archiveChatId, text || "📝", env);
    case "photo":
      return tg("sendPhoto", { photo: file_id, ...extra }, env);
    case "video":
      return tg("sendVideo", { video: file_id, ...extra }, env);
    case "document":
      return tg("sendDocument", { document: file_id, ...extra }, env);
    case "audio":
      return tg("sendAudio", { audio: file_id, ...extra }, env);
    case "voice":
      return tg("sendVoice", { voice: file_id, ...extra }, env);
    case "sticker":
      return tg("sendSticker", { sticker: file_id, chat_id: archiveChatId }, env);
    case "animation":
      return tg("sendAnimation", { animation: file_id, ...extra }, env);
    default:
      if (text) return sendMsg(archiveChatId, text, env);
      return { ok: false };
  }
}

async function savePendingContents(env, buttonId, pending) {
  let success = 0, fail = 0;

  // Check if archive channel is configured
  const arSetting = await dbFirst(env, "SELECT value FROM settings WHERE key = 'archive_channel_id'");
  const archiveChatId = (arSetting && arSetting.value) ? arSetting.value.trim() : null;

  for (const item of pending) {
    try {
      const order = await dbFirst(env, "SELECT COALESCE(MAX(order_index), 0) + 1 as n FROM button_contents WHERE button_id = ?", [buttonId]);

      let archChat = "", archMsgId = "";
      if (archiveChatId) {
        try {
          const archRes = await sendContentItemToArchive(archiveChatId, item, env);
          if (archRes && archRes.ok && archRes.result) {
            archChat = archiveChatId;
            archMsgId = String(archRes.result.message_id);
          }
        } catch (e) {
          console.error("Auto archive push error:", e);
        }
      }

      await dbRun(
        env,
        "INSERT INTO button_contents (button_id, order_index, content_kind, content_text, content_file_id, archive_chat_id, archive_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [buttonId, order ? order.n : 1, item.kind || "text", item.text || "", item.file_id || "", archChat, archMsgId]
      );
      success++;
    } catch (e) {
      fail++;
    }
  }
  if (success > 0) {
    try { await dbRun(env, "UPDATE buttons SET upload_completed = 0 WHERE id = ?", [buttonId]); } catch (e) {}
  }
  return { success, fail };
}

async function getButtonPath(env, buttonId) {
  if (!buttonId || Number(buttonId) === 0) return "🏠 ریشه";
  const parts = [];
  let cur = buttonId;
  while (cur && Number(cur) !== 0) {
    const b = await dbFirst(env, "SELECT id, name, parent_id FROM buttons WHERE id = ?", [cur]);
    if (!b) break;
    parts.unshift(b.name);
    cur = b.parent_id;
  }
  return parts.length > 0 ? parts.join(" > ") : "🏠 ریشه";
}

async function getParentParentId(env, parentId) {
  if (!parentId || Number(parentId) === 0) return 0;
  const b = await dbFirst(env, "SELECT parent_id FROM buttons WHERE id = ?", [parentId]);
  return b ? (Number(b.parent_id) || 0) : 0;
}

async function setProtectContentRecursive(env, buttonId, protectValue) {
  await dbRun(env, "UPDATE buttons SET protect_content = ? WHERE id = ?", [protectValue, buttonId]);
  const children = await dbAll(env, "SELECT id FROM buttons WHERE parent_id = ?", [buttonId]);
  for (const child of children) {
    await setProtectContentRecursive(env, child.id, protectValue);
  }
}

async function deleteButtonTree(env, buttonId) {
  const children = await dbAll(env, "SELECT id FROM buttons WHERE parent_id = ?", [buttonId]);
  for (const child of children) {
    await deleteButtonTree(env, child.id);
  }
  await dbRun(env, "DELETE FROM button_contents WHERE button_id = ?", [buttonId]);
  await dbRun(env, "DELETE FROM buttons WHERE id = ?", [buttonId]);
}

async function getNextSessionIndex(env, parentId) {
  const children = await dbAll(env, "SELECT name FROM buttons WHERE parent_id = ?", [parentId]);
  let maxIdx = -1;
  const re = /جلسه\s*:\s*([0-9]+)/;
  for (const ch of children) {
    const m = (ch.name || "").match(re);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v > maxIdx) maxIdx = v;
    }
  }
  return maxIdx >= 0 ? maxIdx + 1 : children.length + 1;
}

function sessionNameForIndex(idx) {
  const emojis = ["🔸", "🔹", "🔺"];
  const symbol = emojis[(Math.floor(idx / 3)) % emojis.length];
  return `${symbol} جلسه : ${String(idx).padStart(2, "0")} ${symbol}`;
}

function parseCallback(data, prefix) {
  if (!data || !data.startsWith(prefix)) return null;
  return data.slice(prefix.length);
}

// ═══════ BACKUP EXPORT & AUTO BACKUP ═══════

async function runAutoBackup(env) {
  const br = await dbFirst(env, "SELECT value FROM settings WHERE key = 'backup_chat_ref'");
  const targetChat = (br && br.value) ? br.value : env.MAIN_ADMIN_ID;
  if (!targetChat) return;

  const users = await dbAll(env, "SELECT * FROM users");
  const buttons = await dbAll(env, "SELECT * FROM buttons");
  const contents = await dbAll(env, "SELECT * FROM button_contents");
  const settings = await dbAll(env, "SELECT * FROM settings");

  const data = JSON.stringify({ timestamp: new Date().toISOString(), users, buttons, contents, settings }, null, 2);
  const fileName = `backup_${new Date().toISOString().slice(0, 10)}.json`;
  await sendDocumentFile(targetChat, data, fileName, "📦 <b>بکاپ خودکار دیتابیس ربات</b>", env);
}

// ═══════ TWO-WAY SUPPORT REPLIES & QUOTE HELPERS ═══════

function extractTargetFromReply(replyMsg) {
  if (!replyMsg) return null;

  // 1. Check inline keyboard callback_data
  if (replyMsg.reply_markup && replyMsg.reply_markup.inline_keyboard) {
    for (const row of replyMsg.reply_markup.inline_keyboard) {
      for (const btn of row) {
        if (btn.callback_data && btn.callback_data.startsWith("reply:")) {
          const parts = btn.callback_data.split(":");
          return { target: parseInt(parts[1]), mode: parts[2] || "normal" };
        }
      }
    }
  }

  // 2. Regex search in text or caption
  const fullText = replyMsg.text || replyMsg.caption || "";
  const m1 = fullText.match(/(?:🆔\s*آیدی:|🆔|آیدی:)\s*(?:<code>)?(\d+)(?:<\/code>)?/u);
  if (m1) {
    const isAnon = fullText.includes("پیام ناشناس");
    return { target: parseInt(m1[1]), mode: isAnon ? "anon" : "normal" };
  }

  const m2 = fullText.match(/reply:([0-9]+):(normal|anon)/);
  if (m2) {
    return { target: parseInt(m2[1]), mode: m2[2] };
  }

  return null;
}

function extractOriginalSnippet(replyMsg) {
  if (!replyMsg) return "";
  let txt = replyMsg.text || replyMsg.caption || "";
  if (!txt) {
    if (replyMsg.photo) return "[عکس]";
    if (replyMsg.video) return "[ویدیو]";
    if (replyMsg.document) return "[فایل]";
    if (replyMsg.voice) return "[ویس]";
    if (replyMsg.audio) return "[صوت]";
    if (replyMsg.sticker) return "[استیکر]";
    if (replyMsg.animation) return "[گیف]";
    return "";
  }

  // If text contains "💬 پیام:\n", extract text after "💬 پیام:"
  const msgMarker = txt.indexOf("💬 پیام:");
  if (msgMarker !== -1) {
    txt = txt.substring(msgMarker + 8).trim();
  } else {
    // Filter out header lines
    let lines = txt.split("\n");
    lines = lines.filter(l => {
      const trimmed = l.trim();
      return !trimmed.startsWith("📨") && 
             !trimmed.startsWith("🎭") && 
             !trimmed.startsWith("👤 نام:") && 
             !trimmed.startsWith("📌 یوزرنیم:") && 
             !trimmed.startsWith("🆔 آیدی:") && 
             !trimmed.startsWith("💬 در پاسخ به");
    });
    txt = lines.join("\n").trim();
  }

  // Remove existing blockquotes to avoid infinite nesting
  txt = txt.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, "").trim();
  // Strip remaining HTML tags
  txt = txt.replace(/<[^>]+>/g, "").trim();

  if (txt.length > 150) txt = txt.substring(0, 150) + "…";
  return txt;
}

async function deliverSupportReply(target, mode, originalSnippet, message, env) {
  const modeHeader = mode === "anon" ? "🎭 <b>پاسخ از طرف پشتیبانی:</b>" : "📨 <b>پاسخ از طرف پشتیبانی:</b>";
  
  let quoteBlock = "";
  if (originalSnippet) {
    quoteBlock = `💬 <b>در پاسخ به پیام شما:</b>\n<blockquote>${escapeHtml(originalSnippet)}</blockquote>\n\n`;
  }

  let kind = "text", fileId = null, contentText = message.caption || message.text || "";
  if (message.photo) { kind = "photo"; fileId = message.photo[message.photo.length - 1].file_id; }
  else if (message.video) { kind = "video"; fileId = message.video.file_id; }
  else if (message.document) { kind = "document"; fileId = message.document.file_id; }
  else if (message.audio) { kind = "audio"; fileId = message.audio.file_id; }
  else if (message.voice) { kind = "voice"; fileId = message.voice.file_id; }
  else if (message.sticker) { kind = "sticker"; fileId = message.sticker.file_id; }
  else if (message.animation) { kind = "animation"; fileId = message.animation.file_id; }

  const fullCaption = `${quoteBlock}${modeHeader}${contentText ? "\n\n" + escapeHtml(contentText) : ""}`;

  switch (kind) {
    case "text":
      return sendMsg(target, fullCaption, env);
    case "photo":
      return tg("sendPhoto", { chat_id: target, photo: fileId, caption: fullCaption, parse_mode: "HTML" }, env);
    case "video":
      return tg("sendVideo", { chat_id: target, video: fileId, caption: fullCaption, parse_mode: "HTML" }, env);
    case "document":
      return tg("sendDocument", { chat_id: target, document: fileId, caption: fullCaption, parse_mode: "HTML" }, env);
    case "audio":
      return tg("sendAudio", { chat_id: target, audio: fileId, caption: fullCaption, parse_mode: "HTML" }, env);
    case "voice":
      await sendMsg(target, `${quoteBlock}${modeHeader}`, env);
      return tg("sendVoice", { chat_id: target, voice: fileId }, env);
    case "sticker":
      await sendMsg(target, `${quoteBlock}${modeHeader}`, env);
      return tg("sendSticker", { chat_id: target, sticker: fileId }, env);
    case "animation":
      return tg("sendAnimation", { chat_id: target, animation: fileId, caption: fullCaption, parse_mode: "HTML" }, env);
    default:
      return sendMsg(target, fullCaption, env);
  }
}

async function deliverUserSupportMessage(userId, mode, originalSnippet, message, env) {
  const adminId = parseInt(env.MAIN_ADMIN_ID || "0");
  if (!adminId) return false;

  const userObj = message.from || {};
  const name = escapeHtml(userObj.first_name || "");
  const username = userObj.username ? "@" + escapeHtml(userObj.username) : "ندارد";

  let quoteBlock = "";
  if (originalSnippet) {
    quoteBlock = `💬 <b>در پاسخ به:</b>\n<blockquote>${escapeHtml(originalSnippet)}</blockquote>\n\n`;
  }

  const isAnon = mode === "anon";
  const header = isAnon
    ? `${quoteBlock}🎭 <b>پیام ناشناس جدید</b>`
    : `${quoteBlock}📨 <b>پیام جدید (عادی)</b>\n\n👤 نام: ${name}\n📌 یوزرنیم: ${username}\n🆔 آیدی: <code>${userId}</code>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [{ text: "✅ پاسخ", callback_data: `reply:${userId}:${isAnon ? "anon" : "normal"}` }],
      [{ text: "🚫 مسدود کردن", callback_data: `block:${userId}` }]
    ]
  };

  let kind = "text", fileId = null, contentText = message.caption || message.text || "";
  if (message.photo) { kind = "photo"; fileId = message.photo[message.photo.length - 1].file_id; }
  else if (message.video) { kind = "video"; fileId = message.video.file_id; }
  else if (message.document) { kind = "document"; fileId = message.document.file_id; }
  else if (message.audio) { kind = "audio"; fileId = message.audio.file_id; }
  else if (message.voice) { kind = "voice"; fileId = message.voice.file_id; }
  else if (message.sticker) { kind = "sticker"; fileId = message.sticker.file_id; }
  else if (message.animation) { kind = "animation"; fileId = message.animation.file_id; }

  const bodyText = contentText ? `\n\n💬 پیام:\n${escapeHtml(contentText)}` : "";
  const fullCaption = `${header}${bodyText}`;

  switch (kind) {
    case "text":
      return sendMsg(adminId, fullCaption, env, { reply_markup: inlineKeyboard });
    case "photo":
      return tg("sendPhoto", { chat_id: adminId, photo: fileId, caption: fullCaption, parse_mode: "HTML", reply_markup: inlineKeyboard }, env);
    case "video":
      return tg("sendVideo", { chat_id: adminId, video: fileId, caption: fullCaption, parse_mode: "HTML", reply_markup: inlineKeyboard }, env);
    case "document":
      return tg("sendDocument", { chat_id: adminId, document: fileId, caption: fullCaption, parse_mode: "HTML", reply_markup: inlineKeyboard }, env);
    case "audio":
      return tg("sendAudio", { chat_id: adminId, audio: fileId, caption: fullCaption, parse_mode: "HTML", reply_markup: inlineKeyboard }, env);
    case "voice":
      await sendMsg(adminId, header, env);
      return tg("sendVoice", { chat_id: adminId, voice: fileId, reply_markup: inlineKeyboard }, env);
    case "sticker":
      await sendMsg(adminId, header, env);
      return tg("sendSticker", { chat_id: adminId, sticker: fileId, reply_markup: inlineKeyboard }, env);
    case "animation":
      return tg("sendAnimation", { chat_id: adminId, animation: fileId, caption: fullCaption, parse_mode: "HTML", reply_markup: inlineKeyboard }, env);
    default:
      return sendMsg(adminId, fullCaption, env, { reply_markup: inlineKeyboard });
  }
}

// ═══════ MESSAGE HANDLER ═══════

async function handleMessage(message, env) {
  await ensureTables(env);
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text || "";

  await dbRun(
    env,
    "INSERT INTO users (user_id, username, first_name, last_name) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name, updated_at=datetime('now')",
    [userId, message.from.username || "", message.from.first_name || "", message.from.last_name || ""]
  );

  const user = await dbFirst(env, "SELECT blocked FROM users WHERE user_id = ?", [userId]);
  if (user && user.blocked) return;

  if (env.MAIN_ADMIN_ID) {
    try {
      await dbRun(env, "INSERT INTO admins (user_id, role) VALUES (?, 'owner') ON CONFLICT(user_id) DO UPDATE SET role=excluded.role", [parseInt(env.MAIN_ADMIN_ID)]);
    } catch (e) {}
  }

  // Native Admin Swipe-to-Reply Handling (Admin replies directly on a Telegram message)
  if (message.reply_to_message && await isAdmin(userId, env)) {
    const nativeTarget = extractTargetFromReply(message.reply_to_message);
    if (nativeTarget && nativeTarget.target) {
      const snippet = extractOriginalSnippet(message.reply_to_message);
      try {
        let kindName = "متن";
        if (message.photo) kindName = "عکس";
        else if (message.video) kindName = "ویدیو";
        else if (message.document) kindName = "فایل";
        else if (message.audio) kindName = "صوت";
        else if (message.voice) kindName = "ویس";
        else if (message.sticker) kindName = "استیکر";
        else if (message.animation) kindName = "گیف";

        await deliverSupportReply(nativeTarget.target, nativeTarget.mode, snippet, message, env);
        await sendMsg(chatId, `✅ پاسخ (${kindName}) با ریپلای مستقیم برای کاربر <code>${nativeTarget.target}</code> ارسال شد.`, env);
        return;
      } catch (e) {
        console.error("Native admin reply error:", e);
      }
    }
  }

  // Native User Swipe-to-Reply Handling (User replies directly on a Bot/Admin message)
  if (message.reply_to_message && !await isAdmin(userId, env)) {
    const snippet = extractOriginalSnippet(message.reply_to_message);
    const replyText = message.reply_to_message.text || message.reply_to_message.caption || "";
    const mode = (replyText.includes("🎭") || replyText.includes("ناشناس")) ? "anon" : "normal";
    try {
      await clearState(userId, env);
      await deliverUserSupportMessage(userId, mode, snippet, message, env);
      await sendMsg(chatId, "✅ پاسخ شما با موفقیت به پشتیبانی ارسال شد.\n⏳ منتظر پاسخ باشید.", env, { reply_markup: mainKeyboard() });
      return;
    } catch (e) {
      console.error("Native user reply error:", e);
    }
  }

  // /start command with Deep Linking
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    if (parts.length > 1 && parts[1].trim()) {
      const arg = parts[1].trim();
      if (arg.startsWith("btn_")) {
        const bid = parseInt(arg.replace("btn_", ""));
        if (bid) {
          const fj = await checkForceJoin(userId, env);
          if (!fj.ok) {
            await sendForceJoinMessage(chatId, fj.unjoined, env, `start_btn_${bid}`);
            return;
          }
          await clearState(userId, env);
          await showContentFolder(chatId, bid, env);
          return;
        }
      }
    }

    await clearState(userId, env);
    await sendMsg(chatId, welcomeText(message.from), env, { reply_markup: mainKeyboard() });
    return;
  }

  // /admin
  if (text === "/admin") {
    if (!await isAdmin(userId, env)) {
      await sendMsg(chatId, "❌ دسترسی ندارید.", env);
      return;
    }
    await clearState(userId, env);
    await sendMsg(
      chatId,
      `👨‍💼 <b>پنل مدیریت</b>\n👤 نقش شما: <b>${isOwner(userId, env) ? "owner" : "admin"}</b>\n\nیکی از گزینه‌ها را انتخاب کنید:`,
      env,
      { reply_markup: adminPanelKeyboard() }
    );
    return;
  }

  // /cancel or لغو
  if (text === "/cancel" || text === "لغو") {
    await clearState(userId, env);
    await sendMsg(chatId, "❌ عملیات لغو شد.", env, { reply_markup: mainKeyboard() });
    return;
  }

  const st = await getState(userId, env);

  // ─── STATE: add_button ───
  if (st && st.state === "add_button") {
    if (!await isAdmin(userId, env)) return;
    if (!text) {
      await sendMsg(chatId, "❌ فقط متن (نام دکمه) ارسال کنید.", env);
      return;
    }
    const name = text.trim();
    const pid = (st.data.parent_id && Number(st.data.parent_id) > 0) ? Number(st.data.parent_id) : 0;
    if (pid > 0) {
      const p = await dbFirst(env, "SELECT id FROM buttons WHERE id = ?", [pid]);
      if (!p) {
        await clearState(userId, env);
        await sendMsg(chatId, "⚠️ مسیر والد نامعتبر است.", env, { reply_markup: backToPanelKeyboard() });
        return;
      }
    }
    const order = await dbFirst(env, "SELECT COALESCE(MAX(order_index), 0) + 1 as n FROM buttons WHERE parent_id = ?", [pid]);
    await dbRun(env, "INSERT INTO buttons (parent_id, name, order_index) VALUES (?, ?, ?)", [pid, name, order ? order.n : 1]);
    await clearState(userId, env);
    await sendMsg(chatId, `✅ دکمه «<b>${escapeHtml(name)}</b>» با موفقیت اضافه شد.`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── STATE: rename_button ───
  if (st && st.state === "rename_button") {
    if (!await isAdmin(userId, env)) return;
    if (!text) {
      await sendMsg(chatId, "❌ فقط متن ارسال کنید.", env);
      return;
    }
    await dbRun(env, "UPDATE buttons SET name = ? WHERE id = ?", [text.trim(), st.data.button_id]);
    await clearState(userId, env);
    await sendMsg(chatId, "✅ نام دکمه تغییر کرد.", env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── STATE: delete_confirm ───
  if (st && st.state === "delete_confirm") {
    if (!await isAdmin(userId, env)) return;
    if (!text || text.trim() !== "حذف") {
      await sendMsg(chatId, "❌ برای تایید حذف، دقیقا عبارت <code>حذف</code> را ارسال کنید.", env);
      return;
    }
    await deleteButtonTree(env, st.data.button_id);
    await clearState(userId, env);
    await sendMsg(chatId, "✅ دکمه و تمام زیرمجموعه‌های آن با موفقیت حذف شدند.", env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── STATE: upload_content ───
  if (st && st.state === "upload_content") {
    if (!await isAdmin(userId, env)) return;
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    const trimmed = text.trim();

    if (trimmed === "✅ اتمام آپلود") {
      if (pending.length === 0) {
        await sendMsg(chatId, "❌ هنوز هیچ محتوایی آپلود نشده است.", env, { reply_markup: adminUploadReplyKeyboard() });
        return;
      }
      await setState(userId, "upload_confirm", { button_id: buttonId, pending_files: pending }, env);
      await sendMsg(
        chatId,
        `⚠️ آماده ثبت نهایی <b>${pending.length}</b> مورد هستید؟\nبا تایید نهایی ذخیره می‌شود؛ با انصراف همه موارد موقت حذف خواهد شد.`,
        env,
        {
          reply_markup: {
            keyboard: [
              [{ text: "✅ تایید نهایی" }],
              [{ text: "↩️ بازگشت به آپلود" }, { text: "❌ انصراف و حذف لیست" }]
            ],
            resize_keyboard: true
          }
        }
      );
      return;
    }

    if (trimmed === "📋 نمایش لیست") {
      await sendMsg(chatId, buildUploadListText(pending), env, { reply_markup: adminUploadReplyKeyboard() });
      return;
    }

    if (trimmed === "❌ لغو کل آپلود") {
      await clearState(userId, env);
      await sendMsg(chatId, `❌ آپلود لغو شد و ${pending.length} مورد ذخیره‌نشده پاک گردید.`, env, { reply_markup: removeKeyboard() });
      return;
    }

    let kind = "text", fileId = null, contentText = "";
    if (message.photo) { kind = "photo"; fileId = message.photo[message.photo.length - 1].file_id; contentText = message.caption || ""; }
    else if (message.video) { kind = "video"; fileId = message.video.file_id; contentText = message.caption || ""; }
    else if (message.document) { kind = "document"; fileId = message.document.file_id; contentText = message.caption || ""; }
    else if (message.audio) { kind = "audio"; fileId = message.audio.file_id; contentText = message.caption || ""; }
    else if (message.voice) { kind = "voice"; fileId = message.voice.file_id; contentText = message.caption || ""; }
    else if (message.sticker) { kind = "sticker"; fileId = message.sticker.file_id; }
    else if (message.animation) { kind = "animation"; fileId = message.animation.file_id; contentText = message.caption || ""; }
    else if (message.text) { kind = "text"; contentText = text; }
    else {
      await sendMsg(chatId, "❌ این نوع پیام پشتیبانی نمی‌شود.", env, { reply_markup: adminUploadReplyKeyboard() });
      return;
    }

    pending.push({ kind, text: contentText, file_id: fileId });
    await setState(userId, "upload_content", { button_id: buttonId, pending_files: pending }, env);
    await sendMsg(chatId, `✅ دریافت شد. تعداد موارد موقت: <b>${pending.length}</b>`, env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  // ─── STATE: upload_confirm ───
  if (st && st.state === "upload_confirm") {
    if (!await isAdmin(userId, env)) return;
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    const trimmed = text.trim();

    if (trimmed === "✅ تایید نهایی") {
      if (pending.length === 0) {
        await clearState(userId, env);
        await sendMsg(chatId, "❌ لیست خالی است.", env, { reply_markup: removeKeyboard() });
        return;
      }
      const r = await savePendingContents(env, buttonId, pending);
      await clearState(userId, env);
      await sendMsg(chatId, `✅ ذخیره نهایی انجام شد.\nموفق: <b>${r.success}</b>\nناموفق: <b>${r.fail}</b>`, env, { reply_markup: removeKeyboard() });
      return;
    }

    if (trimmed === "↩️ بازگشت به آپلود") {
      await setState(userId, "upload_content", { button_id: buttonId, pending_files: pending }, env);
      await sendMsg(chatId, "↩️ به حالت آپلود برگشتید.", env, { reply_markup: adminUploadReplyKeyboard() });
      return;
    }

    if (trimmed === "❌ انصراف و حذف لیست") {
      await clearState(userId, env);
      await sendMsg(chatId, `❌ عملیات لغو شد و ${pending.length} مورد موقت حذف شد.`, env, { reply_markup: removeKeyboard() });
      return;
    }

    await sendMsg(
      chatId,
      "⚠️ از دکمه‌های پایین برای تایید یا لغو استفاده کنید.",
      env,
      {
        reply_markup: {
          keyboard: [
            [{ text: "✅ تایید نهایی" }],
            [{ text: "↩️ بازگشت به آپلود" }, { text: "❌ انصراف و حذف لیست" }]
          ],
          resize_keyboard: true
        }
      }
    );
    return;
  }

  // ─── STATE: broadcast_wait ───
  if (st && st.state === "broadcast_wait") {
    if (!await isAdmin(userId, env)) return;
    let kind = "text", fileId = null, contentText = text;
    if (message.photo) { kind = "photo"; fileId = message.photo[message.photo.length - 1].file_id; contentText = message.caption || ""; }
    else if (message.video) { kind = "video"; fileId = message.video.file_id; contentText = message.caption || ""; }
    else if (message.document) { kind = "document"; fileId = message.document.file_id; contentText = message.caption || ""; }
    else if (message.audio) { kind = "audio"; fileId = message.audio.file_id; contentText = message.caption || ""; }
    else if (message.voice) { kind = "voice"; fileId = message.voice.file_id; contentText = message.caption || ""; }
    else if (message.sticker) { kind = "sticker"; fileId = message.sticker.file_id; }
    else if (message.animation) { kind = "animation"; fileId = message.animation.file_id; contentText = message.caption || ""; }

    const userCount = await dbFirst(env, "SELECT COUNT(*) as c FROM users WHERE blocked = 0");
    await setState(userId, "broadcast_confirm", { kind, file_id: fileId, text: contentText }, env);
    await sendMsg(
      chatId,
      `✅ آماده ارسال همگانی به <b>${userCount ? userCount.c : 0}</b> کاربر.\nآیا تایید می‌کنید؟`,
      env,
      { reply_markup: broadcastConfirmKeyboard() }
    );
    return;
  }

  // ─── STATE: broadcast_confirm ───
  if (st && st.state === "broadcast_confirm") {
    if (!await isAdmin(userId, env)) return;
    await sendMsg(chatId, "⚠️ از دکمه‌های زیر استفاده کنید.", env, { reply_markup: broadcastConfirmKeyboard() });
    return;
  }

  // ─── STATE: admin_reply (Multi-Media Support Reply via Button State) ───
  if (st && st.state === "admin_reply") {
    if (!await isAdmin(userId, env)) return;
    const target = st.data.target, mode = st.data.mode, snippet = st.data.snippet || "";
    await clearState(userId, env);

    try {
      let kindName = "متن";
      if (message.photo) kindName = "عکس";
      else if (message.video) kindName = "ویدیو";
      else if (message.document) kindName = "فایل";
      else if (message.audio) kindName = "صوت";
      else if (message.voice) kindName = "ویس";
      else if (message.sticker) kindName = "استیکر";
      else if (message.animation) kindName = "گیف";

      await deliverSupportReply(target, mode, snippet, message, env);
      await sendMsg(chatId, `✅ پاسخ (${kindName}) با موفقیت برای کاربر <code>${target}</code> ارسال شد.`, env);
    } catch (e) {
      console.error("Admin reply error:", e);
      await sendMsg(chatId, `❌ خطا در ارسال پاسخ به کاربر: ${escapeHtml(e.message || "خطای ناشناخته")}`, env);
    }
    return;
  }

  // ─── STATE: ban_menu ───
  if (st && st.state === "ban_menu") {
    if (!await isAdmin(userId, env)) return;
    if (!text) {
      await sendMsg(chatId, "❌ آیدی عددی کاربر را ارسال کنید.", env);
      return;
    }
    let target;
    try { target = parseInt(text.trim()); } catch (e) { target = null; }
    if (!target) {
      await sendMsg(chatId, "❌ آیدی عددی نامعتبر.", env);
      return;
    }
    const row = await dbFirst(env, "SELECT blocked FROM users WHERE user_id = ?", [target]);
    const nowBlocked = !(row && row.blocked);
    if (!row) {
      await dbRun(env, "INSERT INTO users (user_id, blocked) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET blocked=excluded.blocked", [target, nowBlocked ? 1 : 0]);
    } else {
      await dbRun(env, "UPDATE users SET blocked = ? WHERE user_id = ?", [nowBlocked ? 1 : 0, target]);
    }
    await sendMsg(chatId, `✅ وضعیت کاربر ${target}: <b>${nowBlocked ? "مسدود شد 🚫" : "آزاد شد 🟢"}</b>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── STATE: forcejoin_menu ───
  if (st && st.state === "forcejoin_menu") {
    if (!await isAdmin(userId, env) || !text) return;
    const t = text.trim();
    if (t.toLowerCase().startsWith("حذف ")) {
      const ch = t.split(" ", 2)[1]?.trim();
      if (ch) {
        try { await dbRun(env, "DELETE FROM forced_channels WHERE channel = ? OR channel_ref = ?", [ch, ch]); } catch (e) {}
        await sendMsg(chatId, "✅ کانال حذف شد.", env, { reply_markup: backToPanelKeyboard() });
      }
    } else {
      try {
        await dbRun(env, "INSERT OR IGNORE INTO forced_channels (channel, channel_ref) VALUES (?, ?)", [t, t]);
        await sendMsg(chatId, `✅ کانال <code>${escapeHtml(t)}</code> اضافه شد.`, env, { reply_markup: backToPanelKeyboard() });
      } catch (e) {
        await sendMsg(chatId, "⚠️ این کانال قبلا ثبت شده است.", env, { reply_markup: backToPanelKeyboard() });
      }
    }
    return;
  }

  // ─── STATE: archive_menu ───
  if (st && st.state === "archive_menu") {
    if (!await isAdmin(userId, env) || !text) return;
    const raw = text.trim();
    if (["off", "none", "null", "disable", "remove", "del", "حذف", "خاموش"].includes(raw.toLowerCase())) {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('archive_channel_id', '') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      await sendMsg(chatId, "✅ کانال آرشیو غیرفعال شد.", env, { reply_markup: backToPanelKeyboard() });
    } else {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('archive_channel_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [raw]);
      await sendMsg(chatId, `✅ کانال آرشیو خصوصی ثبت شد: <code>${escapeHtml(raw)}</code>\n\n⚠️ حتما ربات را در این کانال ادمین (Post Messages) کنید.`, env, { reply_markup: backToPanelKeyboard() });
    }
    return;
  }

  // ─── STATE: backup_set_chat ───
  if (st && st.state === "backup_set_chat") {
    if (!await isAdmin(userId, env) || !text) return;
    const raw = text.trim();
    if (["off", "none", "null", "disable", "remove", "del", "حذف", "خاموش"].includes(raw.toLowerCase())) {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('backup_chat_ref', '') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      await clearState(userId, env);
      await sendMsg(chatId, "✅ مقصد بکاپ غیرفعال شد.", env, { reply_markup: backToPanelKeyboard() });
    } else {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('backup_chat_ref', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [raw]);
      await clearState(userId, env);
      await sendMsg(chatId, `✅ مقصد بکاپ ثبت شد: <code>${escapeHtml(raw)}</code>`, env, { reply_markup: backToPanelKeyboard() });
    }
    return;
  }

  // ─── STATE: session_batch_count ───
  if (st && st.state === "session_batch_count") {
    if (!await isAdmin(userId, env)) return;
    const raw = text.trim();
    if (raw === "لغو") {
      await clearState(userId, env);
      await sendMsg(chatId, "❌ لغو شد.", env);
      return;
    }
    let count;
    try { count = parseInt(raw); } catch (e) { count = null; }
    if (!count || count < 1 || count > 500) {
      await sendMsg(chatId, "❌ تعداد نامعتبر. عدد ۱ تا ۵۰۰ ارسال کنید.\nلغو: <code>لغو</code>", env);
      return;
    }
    const startIdx = await getNextSessionIndex(env, st.data.button_id);
    const endIdx = startIdx + count - 1;
    await setState(userId, "session_batch_confirm", { button_id: st.data.button_id, count, start_index: startIdx, end_index: endIdx }, env);
    const path = await getButtonPath(env, st.data.button_id);
    await sendMsg(
      chatId,
      `⚠️ <b>تایید ایجاد جلسه گروهی</b>\n\nمسیر: <b>${escapeHtml(path)}</b>\nتعداد: <b>${count}</b>\nبازه: <b>${String(startIdx).padStart(2, "0")}</b> تا <b>${String(endIdx).padStart(2, "0")}</b>\n\nارسال کلمه <code>تایید</code> یا <code>لغو</code>`,
      env
    );
    return;
  }

  // ─── STATE: session_batch_confirm ───
  if (st && st.state === "session_batch_confirm") {
    if (!await isAdmin(userId, env)) return;
    const raw = text.trim();
    if (raw === "لغو") {
      await clearState(userId, env);
      await sendMsg(chatId, "❌ لغو شد.", env);
      return;
    }
    if (raw !== "تایید") {
      await sendMsg(chatId, "لطفاً عبارت <code>تایید</code> یا <code>لغو</code> را ارسال کنید.", env);
      return;
    }
    const buttonId = st.data.button_id, count = st.data.count;
    const startIdx = await getNextSessionIndex(env, buttonId);
    let created = 0, failed = 0;
    for (let idx = startIdx; idx < startIdx + count; idx++) {
      try {
        const o = await dbFirst(env, "SELECT COALESCE(MAX(order_index), 0) + 1 as n FROM buttons WHERE parent_id = ?", [buttonId]);
        await dbRun(env, "INSERT INTO buttons (parent_id, name, order_index) VALUES (?, ?, ?)", [buttonId, sessionNameForIndex(idx), o ? o.n : 1]);
        created++;
      } catch (e) {
        failed++;
      }
    }
    await clearState(userId, env);
    await sendMsg(
      chatId,
      `✅ جلسات ایجاد شدند: <b>${created}</b>\nبازه: <b>${String(startIdx).padStart(2, "0")}</b> تا <b>${String(startIdx + created - 1).padStart(2, "0")}</b>\nناموفق: <b>${failed}</b>`,
      env,
      { reply_markup: backToPanelKeyboard() }
    );
    return;
  }

  // ─── USER REPLIES ───
  if (text === "📨 ارسال پیام") {
    const fj = await checkForceJoin(userId, env);
    if (!fj.ok) {
      await sendForceJoinMessage(chatId, fj.unjoined, env);
      return;
    }
    await clearState(userId, env);
    await sendMsg(chatId, "یکی از حالت‌های ارسال پیام را انتخاب کنید:", env, { reply_markup: msgTypeKeyboard() });
    return;
  }

  if (text === "💌 پیام ناشناس") {
    await setState(userId, "waiting_anon", {}, env);
    await sendMsg(chatId, "📝 پیام خود را بنویسید:\n\n🔒 اطلاعات شما کاملاً مخفی خواهد بود.", env, { reply_markup: cancelKeyboard() });
    return;
  }

  if (text === "🫶🏻 پیام عادی") {
    await setState(userId, "waiting_normal", {}, env);
    await sendMsg(chatId, "📝 پیام خود را بنویسید:\n\n⚠️ اطلاعات شما برای پشتیبانی نمایش داده می‌شود.", env, { reply_markup: cancelKeyboard() });
    return;
  }

  if (text === "📚 محتوای آموزشی") {
    const fj = await checkForceJoin(userId, env);
    if (!fj.ok) {
      await sendForceJoinMessage(chatId, fj.unjoined, env);
      return;
    }
    await clearState(userId, env);
    await showContentRoot(chatId, env);
    return;
  }

  if (text === "🔙 بازگشت") {
    await clearState(userId, env);
    await sendMsg(chatId, welcomeText(message.from), env, { reply_markup: mainKeyboard() });
    return;
  }

  // Anonymous support message
  if (st && st.state === "waiting_anon") {
    await clearState(userId, env);
    const snip = message.reply_to_message ? extractOriginalSnippet(message.reply_to_message) : "";
    await deliverUserSupportMessage(userId, "anon", snip, message, env);
    await sendMsg(chatId, "✅ پیام شما به صورت ناشناس ارسال شد.\n⏳ منتظر پاسخ باشید.", env, { reply_markup: mainKeyboard() });
    return;
  }

  // Normal support message
  if (st && st.state === "waiting_normal") {
    await clearState(userId, env);
    const snip = message.reply_to_message ? extractOriginalSnippet(message.reply_to_message) : "";
    await deliverUserSupportMessage(userId, "normal", snip, message, env);
    await sendMsg(chatId, "✅ پیام شما ارسال شد.\n⏳ منتظر پاسخ باشید.", env, { reply_markup: mainKeyboard() });
    return;
  }
}

// ═══════ CALLBACK HANDLER ═══════

async function handleCallback(callback, env) {
  const cbId = callback.id;
  let answered = false;
  const ack = async (text = "", showAlert = false) => {
    if (!answered) {
      answered = true;
      try { await answerCb(cbId, env, text, showAlert); } catch (e) {}
    }
  };

  try {
    const chatId = callback.message?.chat?.id;
    const msgId = callback.message?.message_id;
    const data = callback.data || "";
    const userId = callback.from.id;

    if (!chatId || !msgId) {
      await ack();
      return;
    }

    await dbRun(
      env,
      "INSERT INTO users (user_id, username, first_name, last_name) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, updated_at=datetime('now')",
      [userId, callback.from.username || "", callback.from.first_name || "", callback.from.last_name || ""]
    );

    // check_force_join:payload
    const cfjParam = parseCallback(data, "check_force_join:");
    if (cfjParam !== null) {
      const fj = await checkForceJoin(userId, env);
      if (!fj.ok) {
        await ack("❌ هنوز در تمام کانال‌ها عضو نشده‌اید.", true);
        return;
      }
      await ack("✅ عضویت تایید شد!");
      if (cfjParam.startsWith("start_btn_")) {
        const bid = parseInt(cfjParam.replace("start_btn_", ""));
        if (bid) {
          await showContentFolder(chatId, bid, env, msgId);
          return;
        }
      }
      await safeEditMsg(chatId, msgId, welcomeText(callback.from), env, { reply_markup: mainKeyboard() });
      return;
    }

    // menu:home / back_main
    if (data === "menu:home" || data === "back_main") {
      await clearState(userId, env);
      await safeEditMsg(chatId, msgId, welcomeText(callback.from), env, { reply_markup: mainKeyboard() });
      await ack();
      return;
    }

    // noop
    if (data === "noop") {
      await ack();
      return;
    }

    // Support Reply: reply:123456:mode
    const replyParam = parseCallback(data, "reply:");
    if (replyParam) {
      const parts = replyParam.split(":");
      const target = parseInt(parts[0]);
      const mode = parts[1] || "normal";
      if (!await isAdmin(userId, env)) {
        await ack("❌ دسترسی ندارید.", true);
        return;
      }
      const snippet = extractOriginalSnippet(callback.message);
      await setState(userId, "admin_reply", { target, mode, snippet }, env);
      await ack("📝 پاسخ را ارسال کنید.");
      await sendMsg(
        chatId,
        `📝 پاسخ خود را به کاربر <code>${target}</code> ارسال کنید:\n\n(می‌توانید متن، عکس، ویدیو، فایل PDF، صوت، ویس، گیف یا استیکر بفرستید)`,
        env,
        { reply_markup: cancelKeyboard() }
      );
      return;
    }

    // Support Block: block:123456
    const blockParam = parseCallback(data, "block:");
    if (blockParam) {
      const target = parseInt(blockParam);
      if (!await isAdmin(userId, env)) {
        await ack("❌ دسترسی ندارید.", true);
        return;
      }
      await dbRun(env, "UPDATE users SET blocked = 1 WHERE user_id = ?", [target]);
      await ack(`🚫 کاربر ${target} مسدود شد.`, true);
      return;
    }

    // ─── USER CONTENT NAVIGATION ───
    if (data.startsWith("content:")) {
      const fj = await checkForceJoin(userId, env);
      if (!fj.ok) {
        await ack();
        await sendForceJoinMessage(chatId, fj.unjoined, env);
        return;
      }

      await ack();
      const parts = data.split(":");
      const action = parts[1];
      const id = parseInt(parts[2]) || 0;

      if (action === "root") {
        await showContentRoot(chatId, env, msgId);
      } else if (action === "open") {
        const children = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = ? AND is_active = 1 ORDER BY order_index", [id]);
        const contents = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [id]);
        if (children.length > 0) {
          await showContentFolder(chatId, id, env, msgId);
        } else if (contents.length > 0) {
          for (const c of contents) {
            await sendContentItem(chatId, c, env);
          }
        } else {
          await sendMsg(chatId, "📝 این بخش هنوز محتوایی ندارد.", env);
        }
      } else if (action === "folder") {
        await showContentFolder(chatId, id, env, msgId);
      } else if (action === "showitems") {
        const contents = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [id]);
        for (const c of contents) {
          await sendContentItem(chatId, c, env);
        }
      } else if (action === "back") {
        const btn = await dbFirst(env, "SELECT parent_id FROM buttons WHERE id = ?", [id]);
        const pid = btn && btn.parent_id ? Number(btn.parent_id) : 0;
        if (pid === 0) {
          await showContentRoot(chatId, env, msgId);
        } else {
          await showContentFolder(chatId, pid, env, msgId);
        }
      }
      return;
    }

    // ═══════ ADMIN CALLBACKS ═══════
    if (!await isAdmin(userId, env)) {
      await ack("❌ دسترسی ندارید.", true);
      return;
    }

    // admin:panel
    if (data === "admin:panel") {
      await clearState(userId, env);
      await safeEditMsg(
        chatId,
        msgId,
        `👨‍💼 <b>پنل مدیریت</b>\n👤 نقش شما: <b>${isOwner(userId, env) ? "owner" : "admin"}</b>\n\nیکی از گزینه‌ها را انتخاب کنید:`,
        env,
        { reply_markup: adminPanelKeyboard() }
      );
      await ack();
      return;
    }

    // admin:btn:add:pid
    const addPidStr = parseCallback(data, "admin:btn:add:");
    if (addPidStr !== null) {
      const pid = parseInt(addPidStr) || 0;
      await ack();
      await setState(userId, "add_button", { parent_id: pid }, env);
      await sendMsg(chatId, "➕ نام دکمه جدید را ارسال کنید:", env, { reply_markup: cancelKeyboard() });
      return;
    }

    // admin:btn:manage:pid
    const managePidStr = parseCallback(data, "admin:btn:manage:");
    if (managePidStr !== null) {
      const pid = parseInt(managePidStr) || 0;
      await ack();
      const ppid = await getParentParentId(env, pid);
      const buttons = await dbAll(env, "SELECT id, name, is_active, protect_content FROM buttons WHERE parent_id = ? ORDER BY order_index", [pid]);
      const path = await getButtonPath(env, pid);
      await safeEditMsg(
        chatId,
        msgId,
        `📋 <b>مدیریت دکمه‌ها</b>\nمسیر: <b>${escapeHtml(path)}</b>\n\nروی هر دکمه بزنید تا ویرایش کنید:`,
        env,
        { reply_markup: adminManageButtonsKeyboard(buttons, pid, ppid) }
      );
      return;
    }

    // admin:btn:edit:bid
    const editBidStr = parseCallback(data, "admin:btn:edit:");
    if (editBidStr !== null) {
      const bid = parseInt(editBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
      if (!b) {
        await safeEditMsg(chatId, msgId, "❌ دکمه یافت نشد.", env, { reply_markup: backToPanelKeyboard() });
        return;
      }
      const path = await getButtonPath(env, bid);
      const cnt = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]);
      const cCount = cnt ? cnt.c : 0;
      await safeEditMsg(
        chatId,
        msgId,
        `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${escapeHtml(b.name)}</b>\nمسیر: <b>${escapeHtml(path)}</b>\nوضعیت: <b>${b.is_active ? "فعال 🟢" : "غیرفعال 🔴"}</b>\nخصوصی/قفل: <b>${b.protect_content ? "فعال 🔒" : "غیرفعال 🔓"}</b>\nبازدید/دانلود: <b>👁 ${b.downloads || 0}</b>\nاتمام آپلود: <b>${b.upload_completed ? "تکمیل 🟢" : "در جریان 🔴"}</b>\nمحتوا: <b>${cCount > 0 ? cCount + " مورد" : "---"}</b>`,
        env,
        { reply_markup: adminEditButtonKeyboard(b.id, b.parent_id || 0, !!b.is_active, !!b.protect_content, !!b.upload_completed) }
      );
      return;
    }

    // admin:btn:deeplink:bid
    const deeplinkBidStr = parseCallback(data, "admin:btn:deeplink:");
    if (deeplinkBidStr !== null) {
      const bid = parseInt(deeplinkBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT name FROM buttons WHERE id = ?", [bid]);
      if (!b) return;
      const botUsername = await getBotUsername(env);
      const link = `https://t.me/${botUsername}?start=btn_${bid}`;
      await sendMsg(
        chatId,
        `🔗 <b>لینک مستقیم دکمه «${escapeHtml(b.name)}»</b>\n\n<code>${link}</code>\n\nمیتوانید این لینک را در کانال‌ها یا گروه‌ها قرار دهید تا کاربران مستقیما به این بخش هدایت شوند.`,
        env,
        { reply_markup: backToPanelKeyboard() }
      );
      return;
    }

    // admin:btn:notify:bid (Prompt Notification)
    const notifyBidStr = parseCallback(data, "admin:btn:notify:");
    if (notifyBidStr !== null) {
      const bid = parseInt(notifyBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT name FROM buttons WHERE id = ?", [bid]);
      if (!b) return;
      await safeEditMsg(
        chatId,
        msgId,
        `📣 <b>اطلاع‌رسانی آپدیت جدید</b>\n\nدکمه: <b>${escapeHtml(b.name)}</b>\n\nآیا می‌خواهید به تمام کاربران ربات اطلاع‌رسانی ارسال شود که محتوای جدید در این بخش قرار گرفته است؟`,
        env,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ بله، ارسال اطلاع‌رسانی", callback_data: `admin:btn:sendnotify:${bid}` },
                { text: "❌ انصراف", callback_data: `admin:btn:edit:${bid}` }
              ]
            ]
          }
        }
      );
      return;
    }

    // admin:btn:sendnotify:bid (Execute Broadcast Notification for button update)
    const sendnotifyBidStr = parseCallback(data, "admin:btn:sendnotify:");
    if (sendnotifyBidStr !== null) {
      const bid = parseInt(sendnotifyBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT name FROM buttons WHERE id = ?", [bid]);
      if (!b) return;
      const botUsername = await getBotUsername(env);
      const directLink = `https://t.me/${botUsername}?start=btn_${bid}`;
      const users = await dbAll(env, "SELECT user_id FROM users WHERE blocked = 0");
      
      let ok = 0, fail = 0;
      for (const u of users) {
        if (u.user_id === userId) continue;
        try {
          await sendMsg(
            u.user_id,
            `🔔 <b>محتوای جدید اضافه شد!</b>\n\nبخش: «<b>${escapeHtml(b.name)}</b>» به روزرسانی شد.\nبرای مشاهده مستقیم روی دکمه زیر کلیک کنید:`,
            env,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🔗 مشاهده محتوای جدید", url: directLink }]
                ]
              }
            }
          );
          ok++;
        } catch (e) {
          fail++;
        }
      }

      await sendMsg(
        chatId,
        `✅ <b>اطلاع‌رسانی آپدیت با موفقیت ارسال شد.</b>\n\nدکمه: <b>${escapeHtml(b.name)}</b>\nموفق: <b>${ok}</b>\nناموفق: <b>${fail}</b>`,
        env,
        { reply_markup: backToPanelKeyboard() }
      );
      return;
    }

    // admin:btn:rename:bid
    const renameBidStr = parseCallback(data, "admin:btn:rename:");
    if (renameBidStr !== null) {
      const bid = parseInt(renameBidStr);
      await ack();
      await setState(userId, "rename_button", { button_id: bid }, env);
      await sendMsg(chatId, "✏️ نام جدید دکمه را ارسال کنید:", env, { reply_markup: cancelKeyboard() });
      return;
    }

    // admin:btn:toggle:bid
    const toggleBidStr = parseCallback(data, "admin:btn:toggle:");
    if (toggleBidStr !== null) {
      const bid = parseInt(toggleBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
      if (!b) return;
      await dbRun(env, "UPDATE buttons SET is_active = ? WHERE id = ?", [b.is_active ? 0 : 1, bid]);
      const nb = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
      const path = await getButtonPath(env, bid);
      const cnt = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]);
      await safeEditMsg(
        chatId,
        msgId,
        `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${escapeHtml(nb.name)}</b>\nمسیر: <b>${escapeHtml(path)}</b>\nوضعیت: <b>${nb.is_active ? "فعال 🟢" : "غیرفعال 🔴"}</b>\nخصوصی/قفل: <b>${nb.protect_content ? "فعال 🔒" : "غیرفعال 🔓"}</b>\nبازدید/دانلود: <b>👁 ${nb.downloads || 0}</b>\nاتمام آپلود: <b>${nb.upload_completed ? "تکمیل 🟢" : "در جریان 🔴"}</b>\nمحتوا: <b>${cnt && cnt.c > 0 ? cnt.c + " مورد" : "---"}</b>`,
        env,
        { reply_markup: adminEditButtonKeyboard(nb.id, nb.parent_id || 0, !!nb.is_active, !!nb.protect_content, !!nb.upload_completed) }
      );
      return;
    }

    // admin:btn:protect:bid (Recursive Toggle!)
    const protectBidStr = parseCallback(data, "admin:btn:protect:");
    if (protectBidStr !== null) {
      const bid = parseInt(protectBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
      if (!b) return;
      const newProtect = b.protect_content ? 0 : 1;
      await setProtectContentRecursive(env, bid, newProtect);
      const nb = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
      const path = await getButtonPath(env, bid);
      const cnt = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]);
      await safeEditMsg(
        chatId,
        msgId,
        `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${escapeHtml(nb.name)}</b>\nمسیر: <b>${escapeHtml(path)}</b>\nوضعیت: <b>${nb.is_active ? "فعال 🟢" : "غیرفعال 🔴"}</b>\nخصوصی/قفل: <b>${nb.protect_content ? "فعال 🔒 (روی تمام زیرمجموعه‌ها اعمال شد)" : "غیرفعال 🔓"}</b>\nبازدید/دانلود: <b>👁 ${nb.downloads || 0}</b>\nاتمام آپلود: <b>${nb.upload_completed ? "تکمیل 🟢" : "در جریان 🔴"}</b>\nمحتوا: <b>${cnt && cnt.c > 0 ? cnt.c + " مورد" : "---"}</b>`,
        env,
        { reply_markup: adminEditButtonKeyboard(nb.id, nb.parent_id || 0, !!nb.is_active, !!nb.protect_content, !!nb.upload_completed) }
      );
      return;
    }

    // admin:btn:uploaddone:bid
    const uploadDoneBidStr = parseCallback(data, "admin:btn:uploaddone:");
    if (uploadDoneBidStr !== null) {
      const bid = parseInt(uploadDoneBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
      if (!b) return;
      await dbRun(env, "UPDATE buttons SET upload_completed = ? WHERE id = ?", [b.upload_completed ? 0 : 1, bid]);
      const nb = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
      const path = await getButtonPath(env, bid);
      const cnt = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]);
      await safeEditMsg(
        chatId,
        msgId,
        `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${escapeHtml(nb.name)}</b>\nمسیر: <b>${escapeHtml(path)}</b>\nوضعیت: <b>${nb.is_active ? "فعال 🟢" : "غیرفعال 🔴"}</b>\nخصوصی/قفل: <b>${nb.protect_content ? "فعال 🔒" : "غیرفعال 🔓"}</b>\nبازدید/دانلود: <b>👁 ${nb.downloads || 0}</b>\nاتمام آپلود: <b>${nb.upload_completed ? "تکمیل 🟢" : "در جریان 🔴"}</b>\nمحتوا: <b>${cnt && cnt.c > 0 ? cnt.c + " مورد" : "---"}</b>`,
        env,
        { reply_markup: adminEditButtonKeyboard(nb.id, nb.parent_id || 0, !!nb.is_active, !!nb.protect_content, !!nb.upload_completed) }
      );
      return;
    }

    // admin:btn:append:bid
    const appendBidStr = parseCallback(data, "admin:btn:append:");
    if (appendBidStr !== null) {
      const bid = parseInt(appendBidStr);
      await ack();
      await setState(userId, "upload_content", { button_id: bid, pending_files: [] }, env);
      await sendMsg(
        chatId,
        `📤 <b>آپلود محتوا</b>\n\nمحتواهای خود را به این چت ارسال کنید. موارد به صورت موقت ذخیره می‌شوند.\n\n• ✅ اتمام آپلود\n• 📋 نمایش لیست\n• ❌ لغو کل آپلود`,
        env,
        { reply_markup: adminUploadReplyKeyboard() }
      );
      return;
    }

    // admin:btn:delete:bid
    const deleteBidStr = parseCallback(data, "admin:btn:delete:");
    if (deleteBidStr !== null) {
      const bid = parseInt(deleteBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT name FROM buttons WHERE id = ?", [bid]);
      if (!b) return;
      await setState(userId, "delete_confirm", { button_id: bid }, env);
      await sendMsg(
        chatId,
        `⚠️ آیا از حذف کامل '<b>${escapeHtml(b.name)}</b>' و تمام زیرمجموعه‌های آن مطمئن هستید؟\n\nبرای تایید نهایی: <code>حذف</code>`,
        env,
        { reply_markup: cancelKeyboard() }
      );
      return;
    }

    // admin:btn:sessions:bid
    const sessionsBidStr = parseCallback(data, "admin:btn:sessions:");
    if (sessionsBidStr !== null) {
      const bid = parseInt(sessionsBidStr);
      await ack();
      const b = await dbFirst(env, "SELECT id FROM buttons WHERE id = ?", [bid]);
      if (!b) return;
      const startIdx = await getNextSessionIndex(env, bid);
      const path = await getButtonPath(env, bid);
      await setState(userId, "session_batch_count", { button_id: bid, button_path: path, next_index: startIdx }, env);
      await sendMsg(
        chatId,
        `🧩 <b>ایجاد جلسه گروهی</b>\n\nمسیر: <b>${escapeHtml(path)}</b>\nشماره جلسه بعدی: <b>${String(startIdx).padStart(2, "0")}</b>\n\nتعداد جلسات مورد نظر را ارسال کنید (عدد ۱ تا ۵۰۰):\nلغو: <code>لغو</code>`,
        env,
        { reply_markup: cancelKeyboard() }
      );
      return;
    }

    // admin:btn:archivepush:bid (Manual Push Button Contents to Archive Channel)
    const archivepushBidStr = parseCallback(data, "admin:btn:archivepush:");
    if (archivepushBidStr !== null) {
      const bid = parseInt(archivepushBidStr);
      await ack();
      const ar = await dbFirst(env, "SELECT value FROM settings WHERE key = 'archive_channel_id'");
      if (!ar || !ar.value) {
        await ack("❌ کانال آرشیو تنظیم نشده است.", true);
        return;
      }
      const archiveChatId = ar.value.trim();
      const items = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [bid]);
      if (!items || items.length === 0) {
        await ack("❌ این دکمه محتوایی ندارد.", true);
        return;
      }

      await sendMsg(chatId, `📦 <b>در حال انتقال ${items.length} فایل به کانال آرشیو...</b>`, env);
      let okCount = 0, failCount = 0;
      for (const item of items) {
        try {
          const archRes = await sendContentItemToArchive(archiveChatId, { kind: item.content_kind, text: item.content_text, file_id: item.content_file_id }, env);
          if (archRes && archRes.ok && archRes.result) {
            await dbRun(env, "UPDATE button_contents SET archive_chat_id = ?, archive_message_id = ? WHERE id = ?", [archiveChatId, String(archRes.result.message_id), item.id]);
            okCount++;
          } else {
            failCount++;
          }
        } catch (e) {
          failCount++;
        }
      }

      const path = await getButtonPath(env, bid);
      await sendMsg(
        chatId,
        `📦 <b>نتیجه انتقال به کانال آرشیو</b>\n\nمسیر: <b>${escapeHtml(path)}</b>\nکانال مقصد: <code>${escapeHtml(archiveChatId)}</code>\n\nموفق: <b>${okCount}</b>\nناموفق: <b>${failCount}</b>`,
        env,
        { reply_markup: backToPanelKeyboard() }
      );
      return;
    }

    // admin:smartarchive:menu
    if (data === "admin:smartarchive:menu") {
      await ack();
      const all = await dbAll(env, "SELECT id, upload_completed FROM buttons WHERE id != 0");
      const completed = all.filter(b => b.upload_completed);
      const withContentRes = await dbAll(env, "SELECT DISTINCT button_id FROM button_contents");
      const archivedRes = await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE archive_message_id != '' AND archive_message_id IS NOT NULL");
      await safeEditMsg(
        chatId,
        msgId,
        `🧠 <b>آرشیو هوشمند دیتابیس</b>\n\nکل دکمه‌ها: <b>${all.length}</b>\nاتمام آپلود: <b>${completed.length}</b>\nدر حال آپلود: <b>${all.length - completed.length}</b>\nدارای محتوا: <b>${withContentRes.length}</b>\nفایل‌های ذخیره‌شده در آرشیو: <b>${archivedRes[0]?.c || 0}</b>`,
        env,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 بروزرسانی", callback_data: "admin:smartarchive:menu" }],
              [{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]
            ]
          }
        }
      );
      return;
    }

    // admin:broadcast:start
    if (data === "admin:broadcast:start") {
      await ack();
      await setState(userId, "broadcast_wait", {}, env);
      await sendMsg(chatId, "📣 محتوای پیام همگانی را ارسال کنید (متن، عکس، ویدیو، فایل و...):", env, { reply_markup: cancelKeyboard() });
      return;
    }

    // admin:broadcast:confirm
    if (data === "admin:broadcast:confirm") {
      await ack();
      const st = await getState(userId, env);
      if (!st || st.state !== "broadcast_confirm") {
        await sendMsg(chatId, "❌ پیام همگانی منقضی شده یا یافت نشد.", env);
        return;
      }
      const payload = st.data;
      await clearState(userId, env);
      const users = await dbAll(env, "SELECT user_id FROM users WHERE blocked = 0");
      let ok = 0, fail = 0;
      for (const u of users) {
        if (u.user_id === userId) continue;
        try {
          if (payload.kind === "text") {
            await sendMsg(u.user_id, `📣 <b>پیام همگانی:</b>\n\n${escapeHtml(payload.text || "")}`, env);
          } else if (payload.kind === "photo") {
            await tg("sendPhoto", { chat_id: u.user_id, photo: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
          } else if (payload.kind === "video") {
            await tg("sendVideo", { chat_id: u.user_id, video: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
          } else if (payload.kind === "document") {
            await tg("sendDocument", { chat_id: u.user_id, document: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
          } else if (payload.kind === "audio") {
            await tg("sendAudio", { chat_id: u.user_id, audio: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
          } else if (payload.kind === "voice") {
            await tg("sendVoice", { chat_id: u.user_id, voice: payload.file_id }, env);
          } else if (payload.kind === "sticker") {
            await tg("sendSticker", { chat_id: u.user_id, sticker: payload.file_id }, env);
          } else if (payload.kind === "animation") {
            await tg("sendAnimation", { chat_id: u.user_id, animation: payload.file_id, caption: payload.text || "" }, env);
          }
          ok++;
        } catch (e) {
          fail++;
        }
      }
      await sendMsg(chatId, `✅ پایان ارسال همگانی.\nموفق: <b>${ok}</b>\nناموفق: <b>${fail}</b>`, env, { reply_markup: backToPanelKeyboard() });
      return;
    }

    // admin:broadcast:cancel
    if (data === "admin:broadcast:cancel") {
      await ack();
      await clearState(userId, env);
      await sendMsg(chatId, "❌ ارسال همگانی لغو شد.", env, { reply_markup: backToPanelKeyboard() });
      return;
    }

    // admin:ban:menu
    if (data === "admin:ban:menu") {
      await ack();
      await setState(userId, "ban_menu", {}, env);
      const blocked = await dbAll(env, "SELECT user_id FROM users WHERE blocked = 1 LIMIT 30");
      await safeEditMsg(
        chatId,
        msgId,
        `🚫 <b>مدیریت بن/آزادسازی</b>\n\nبرای بن یا آزاد کردن کاربر، آیدی عددی او را ارسال کنید.\n\nلیست بن شده‌ها:\n<code>${blocked.map(b => b.user_id).join(", ") || "هیچ موردی ثبت نشده"}</code>`,
        env,
        { reply_markup: backToPanelKeyboard() }
      );
      return;
    }

    // admin:forcejoin:menu
    if (data === "admin:forcejoin:menu") {
      await ack();
      await setState(userId, "forcejoin_menu", {}, env);
      const ch = await dbAll(env, "SELECT channel, channel_ref FROM forced_channels");
      const listText = ch.map(c => `• <code>${escapeHtml(c.channel || c.channel_ref)}</code>`).join("\n") || "هیچ کانالی ثبت نشده است.";
      await safeEditMsg(
        chatId,
        msgId,
        `📌 <b>عضویت اجباری کانال‌ها</b>\n\n${listText}\n\n• برای افزودن: آیدی یا آدرس کانال (مثلا <code>@channel</code>) را بفرستید.\n• برای حذف: عبارت <code>حذف @channel</code> را بفرستید.`,
        env,
        { reply_markup: backToPanelKeyboard() }
      );
      return;
    }

    // admin:archive:menu
    if (data === "admin:archive:menu") {
      await ack();
      const cur = await dbFirst(env, "SELECT value FROM settings WHERE key = 'archive_channel_id'");
      await setState(userId, "archive_menu", {}, env);
      await safeEditMsg(
        chatId,
        msgId,
        `🗄️ <b>کانال آرشیو محتوا</b>\n\nوضعیت فعلی: <b>${(cur && cur.value) ? escapeHtml(cur.value) : "غیرفعال"}</b>\n\nآدرس جدید بفرستید (مانند <code>@channel</code> یا <code>-100xxx</code>)\nبرای غیرفعال کردن: <code>off</code>`,
        env,
        { reply_markup: backToPanelKeyboard() }
      );
      return;
    }

    // admin:backup:menu
    if (data === "admin:backup:menu") {
      await ack();
      const br = await dbFirst(env, "SELECT value FROM settings WHERE key = 'backup_chat_ref'");
      await safeEditMsg(
        chatId,
        msgId,
        `🗃️ <b>بکاپ و بازیابی</b>\n\nمقصد فعلی بکاپ: <b>${(br && br.value) ? escapeHtml(br.value) : "غیرفعال"}</b>`,
        env,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📥 دریافت فوری بکاپ کامل (JSON)", callback_data: "admin:backup:export" }],
              [{ text: "⚙️ تنظیم مقصد بکاپ خودکار", callback_data: "admin:backup:setchat" }],
              [{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]
            ]
          }
        }
      );
      return;
    }

    // admin:backup:export (Instant Manual Backup Download)
    if (data === "admin:backup:export") {
      await ack("⏳ در حال تولید و ارسال بکاپ...");
      const users = await dbAll(env, "SELECT * FROM users");
      const buttons = await dbAll(env, "SELECT * FROM buttons");
      const contents = await dbAll(env, "SELECT * FROM button_contents");
      const settings = await dbAll(env, "SELECT * FROM settings");

      const backupStr = JSON.stringify({ timestamp: new Date().toISOString(), users, buttons, contents, settings }, null, 2);
      const fileName = `backup_${new Date().toISOString().slice(0, 10)}.json`;
      await sendDocumentFile(chatId, backupStr, fileName, "📥 <b>بکاپ کامل دیتابیس ربات</b>", env);
      return;
    }

    // admin:backup:setchat
    if (data === "admin:backup:setchat") {
      await ack();
      await setState(userId, "backup_set_chat", {}, env);
      await sendMsg(chatId, "📍 مقصد بکاپ را ارسال کنید:\n<code>@channel</code> / <code>-100xxx</code> / <code>off</code>", env, { reply_markup: cancelKeyboard() });
      return;
    }

    // admin:stats
    if (data === "admin:stats") {
      await ack();
      const ut = await dbFirst(env, "SELECT COUNT(*) as c FROM users");
      const ua = await dbFirst(env, "SELECT COUNT(*) as c FROM users WHERE blocked = 0");
      const ub = await dbFirst(env, "SELECT COUNT(*) as c FROM users WHERE blocked = 1");
      const bt = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0");
      const ba = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0 AND is_active = 1");
      const bi = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0 AND is_active = 0");
      const ct = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents");
      const bc = await dbFirst(env, "SELECT COUNT(DISTINCT button_id) as c FROM button_contents");
      const dl = await dbFirst(env, "SELECT SUM(downloads) as s FROM button_contents");
      await safeEditMsg(
        chatId,
        msgId,
        `📊 <b>آمار جامع ربات</b>\n\n👥 کل کاربران: <b>${ut?.c || 0}</b> | ✅ فعال: <b>${ua?.c || 0}</b> | 🚫 بن: <b>${ub?.c || 0}</b>\n\n🔘 کل دکمه‌ها: <b>${bt?.c || 0}</b> | 🟢 فعال: <b>${ba?.c || 0}</b> | 🔴 غیرفعال: <b>${bi?.c || 0}</b>\n📂 دکمه‌های دارای محتوا: <b>${bc?.c || 0}</b>\n📎 مجموع فایل‌ها: <b>${ct?.c || 0}</b>\n👁 کل دانلودها/بازدیدها: <b>${dl?.s || 0}</b>`,
        env,
        { reply_markup: backToPanelKeyboard() }
      );
      return;
    }

    await ack();
  } catch (err) {
    console.error("handleCallback unhandled error:", err);
    await ack("❌ خطایی در پردازش درخواست رخ داد.", true);
  }
}

// ═══════ CONTENT DISPLAY ═══════

async function showContentRoot(chatId, env, editMsgId) {
  const buttons = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = 0 AND is_active = 1 ORDER BY order_index");
  const children = buttons.filter(b => Number(b.id) !== 0);
  if (children.length === 0) {
    const emptyTxt = "📂 هنوز هیچ محتوای آموزشی ثبت نشده است.";
    if (editMsgId) await safeEditMsg(chatId, editMsgId, emptyTxt, env);
    else await sendMsg(chatId, emptyTxt, env);
    return;
  }

  const flatItems = children.map(b => ({
    text: `${b.protect_content ? "🔒 " : ""}${b.name}`,
    callback_data: `content:open:${b.id}`
  }));

  const rows = chunkArray21(flatItems);
  rows.push([{ text: "🏠 منوی اصلی", callback_data: "back_main" }]);

  const kb = { inline_keyboard: rows };
  const txt = "📚 <b>بخش محتوای آموزشی</b>\n\nلطفاً یکی از دسته‌بندی‌های زیر را انتخاب کنید:";
  if (editMsgId) await safeEditMsg(chatId, editMsgId, txt, env, { reply_markup: kb });
  else await sendMsg(chatId, txt, env, { reply_markup: kb });
}

async function showContentFolder(chatId, parentId, env, editMsgId) {
  const children = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = ? AND is_active = 1 ORDER BY order_index", [parentId]);
  const contents = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [parentId]);
  const btn = await dbFirst(env, "SELECT name, downloads FROM buttons WHERE id = ?", [parentId]);
  const title = btn ? `📁 <b>${escapeHtml(btn.name)}</b>` : "📁 منو";

  const flatItems = children.map(b => ({
    text: `${b.protect_content ? "🔒 " : ""}${b.name}`,
    callback_data: `content:open:${b.id}`
  }));

  const rows = [];
  if (contents.length > 0) {
    rows.push([{ text: `📎 مشاهده ${contents.length} محتوا`, callback_data: `content:showitems:${parentId}` }]);
  }
  rows.push(...chunkArray21(flatItems));
  rows.push([
    { text: "🔙 بازگشت", callback_data: `content:back:${parentId}` },
    { text: "🏠 منوی اصلی", callback_data: "back_main" }
  ]);

  const kb = { inline_keyboard: rows };
  const txt = `${title}\n\nگزینه مورد نظر را انتخاب کنید:`;

  if (editMsgId) await safeEditMsg(chatId, editMsgId, txt, env, { reply_markup: kb });
  else await sendMsg(chatId, txt, env, { reply_markup: kb });
}

async function sendContentItem(chatId, item, env) {
  const { id, button_id, content_kind, content_text, content_file_id, archive_chat_id, archive_message_id } = item;

  // Increment download / view count for item and button
  try {
    await dbRun(env, "UPDATE button_contents SET downloads = COALESCE(downloads, 0) + 1 WHERE id = ?", [id]);
    await dbRun(env, "UPDATE buttons SET downloads = COALESCE(downloads, 0) + 1 WHERE id = ?", [button_id]);
  } catch (e) {}

  const currentCount = (item.downloads || 0) + 1;
  const btn = await dbFirst(env, "SELECT protect_content FROM buttons WHERE id = ?", [button_id]);
  const isProtected = btn && btn.protect_content === 1;

  const extra = {};
  let captionText = content_text || "";
  captionText += `\n\n👁 <b>${currentCount} دریافت</b>`;
  extra.caption = captionText.trim();
  extra.parse_mode = "HTML";
  if (isProtected) {
    extra.protect_content = true;
  }

  // Attempt Primary Send via file_id
  let sendResult = null;
  try {
    switch (content_kind) {
      case "text":
        sendResult = await sendMsg(chatId, `${content_text || "📝"}\n\n👁 <b>${currentCount} بازدید</b>`, env, { protect_content: isProtected });
        break;
      case "photo":
        sendResult = await tg("sendPhoto", { chat_id: chatId, photo: content_file_id, ...extra }, env);
        break;
      case "video":
        sendResult = await tg("sendVideo", { chat_id: chatId, video: content_file_id, ...extra }, env);
        break;
      case "document":
        sendResult = await tg("sendDocument", { chat_id: chatId, document: content_file_id, ...extra }, env);
        break;
      case "audio":
        sendResult = await tg("sendAudio", { chat_id: chatId, audio: content_file_id, ...extra }, env);
        break;
      case "voice":
        sendResult = await tg("sendVoice", { chat_id: chatId, voice: content_file_id }, env);
        break;
      case "sticker":
        sendResult = await tg("sendSticker", { chat_id: chatId, sticker: content_file_id }, env);
        break;
      case "animation":
        sendResult = await tg("sendAnimation", { chat_id: chatId, animation: content_file_id, ...extra }, env);
        break;
      default:
        if (content_text) sendResult = await sendMsg(chatId, `${content_text}\n\n👁 <b>${currentCount} بازدید</b>`, env, { protect_content: isProtected });
        break;
    }
  } catch (e) {
    sendResult = { ok: false, error: e };
  }

  // AUTOMATIC ARCHIVE FALLBACK: If sending via file_id fails (e.g. Bot Token changed or file_id expired)
  if (!sendResult || !sendResult.ok) {
    if (archive_chat_id && archive_message_id) {
      try {
        const copyRes = await tg("copyMessage", {
          chat_id: chatId,
          from_chat_id: archive_chat_id,
          message_id: archive_message_id,
          caption: extra.caption || "",
          parse_mode: "HTML",
          protect_content: isProtected
        }, env);

        if (copyRes && copyRes.ok) {
          return copyRes;
        }
      } catch (copyErr) {
        console.error("Archive fallback copyMessage error:", copyErr);
      }
    }
  }

  return sendResult;
}
