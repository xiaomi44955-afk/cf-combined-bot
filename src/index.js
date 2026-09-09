// ═══════ CF Combined Bot: Full Admin Panel ═══════ Single file ═══════

export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const payload = await request.json();
        if (payload.message) await handleMessage(payload.message, env);
        if (payload.callback_query) await handleCallback(payload.callback_query, env);
      } catch (err) { console.error("Error:", err); }
    }
    return new Response("OK", { status: 200 });
  },
};

// ═══════ TELEGRAM API ═══════

async function tg(method, body, env) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function sendMsg(chatId, text, env, extra = {}) {
  const body = { chat_id: chatId, text, ...extra };
  if (!body.parse_mode) body.parse_mode = "HTML";
  if (body.reply_markup && typeof body.reply_markup !== "string")
    body.reply_markup = JSON.stringify(body.reply_markup);
  return tg("sendMessage", body, env);
}

async function editMsg(chatId, msgId, text, env, extra = {}) {
  const body = { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", ...extra };
  if (body.reply_markup && typeof body.reply_markup !== "string")
    body.reply_markup = JSON.stringify(body.reply_markup);
  try {
    return await tg("editMessageText", body, env);
  } catch (e) {
    if (String(e).includes("not modified")) return { ok: false };
    throw e;
  }
}

async function safeEditMsg(chatId, msgId, text, env, extra = {}) {
  try {
    return await editMsg(chatId, msgId, text, env, extra);
  } catch (e) {
    return { ok: false };
  }
}

async function answerCb(cbId, env, text = "", showAlert = false) {
  return tg("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: showAlert });
}

async function deleteMsg(chatId, msgId, env) {
  return tg("deleteMessage", { chat_id: chatId, message_id: msgId }, env);
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
    `CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, blocked INTEGER DEFAULT 0, chat_mode TEXT DEFAULT 'normal')`,
    `CREATE TABLE IF NOT EXISTS admins (user_id INTEGER PRIMARY KEY, role TEXT DEFAULT 'admin')`,
    `CREATE TABLE IF NOT EXISTS buttons (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER DEFAULT 0, name TEXT NOT NULL, is_active INTEGER DEFAULT 1, protect_content INTEGER DEFAULT 0, order_index INTEGER DEFAULT 0, upload_completed INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS button_contents (id INTEGER PRIMARY KEY AUTOINCREMENT, button_id INTEGER NOT NULL, order_index INTEGER DEFAULT 0, content_kind TEXT DEFAULT 'text', content_text TEXT DEFAULT '', content_file_id TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS user_states (user_id INTEGER PRIMARY KEY, state TEXT DEFAULT '', data TEXT DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS forced_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL UNIQUE)`,
  ];
  for (const s of t) {
    try { await dbRun(env, s); } catch (e) { /* ignore */ }
  }
  // Add upload_completed column if missing
  try { await dbRun(env, "ALTER TABLE buttons ADD COLUMN upload_completed INTEGER DEFAULT 0"); } catch (e) { /* already exists */ }
}

// ═══════ ADMIN CHECK ═══════

function isAdmin(userId, env) {
  const main = String(env.MAIN_ADMIN_ID || "");
  if (main && String(userId) === main) return true;
  if (env.ADMIN_IDS) {
    const ids = env.ADMIN_IDS.split(",").map(s => s.trim());
    if (ids.includes(String(userId))) return true;
  }
  return false;
}

function isOwner(userId, env) {
  const main = String(env.MAIN_ADMIN_ID || "");
  return main && String(userId) === main;
}

// ═══════ USER STATE ═══════

async function getState(userId, env) {
  return await dbFirst(env, "SELECT state, data FROM user_states WHERE user_id = ?", [userId]);
}
async function setState(userId, state, data, env) {
  await dbRun(env, "INSERT INTO user_states (user_id, state, data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data", [userId, state, JSON.stringify(data || {})]);
}
async function clearState(userId, env) {
  await dbRun(env, "DELETE FROM user_states WHERE user_id = ?", [userId]);
}

// ═══════ KEYBOARDS ═══════

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "📚 محتوای آموزشی" }, { text: "📨 ارسال پیام" }],
    ],
    resize_keyboard: true,
  };
}

function msgTypeKeyboard() {
  return {
    keyboard: [
      [{ text: "💌 پیام ناشناس" }, { text: "🫶🏻 پیام عادی" }],
      [{ text: "🔙 بازگشت" }],
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

function adminPanelKeyboard(env) {
  const rows = [
    [{ text: "➕ افزودن دکمه اصلی", callback_data: "admin:btn:add:0" },
     { text: "📋 مدیریت دکمه‌ها", callback_data: "admin:btn:manage:0" }],
    [{ text: "🧠 آرشیو هوشمند", callback_data: "admin:smartarchive:menu" },
     { text: "📣 پیام همگانی", callback_data: "admin:broadcast:start" }],
    [{ text: "🚫 بن/آزادسازی کاربر", callback_data: "admin:ban:menu" },
     { text: "📌 عضویت اجباری", callback_data: "admin:forcejoin:menu" }],
    [{ text: "🗄️ کانال آرشیو محتوا", callback_data: "admin:archive:menu" },
     { text: "🗃️ بکاپ و بازیابی", callback_data: "admin:backup:menu" }],
    [{ text: "📊 آمار کلی", callback_data: "admin:stats" }],
    [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }],
  ];
  return { inline_keyboard: rows };
}

function adminManageButtonsKeyboard(buttons, parentId, parentParentId) {
  const rows = [];
  for (const b of buttons) {
    if (Number(b.id) === 0) continue;
    const status = b.is_active ? "✅" : "⛔️";
    rows.push([{ text: `${status} ${b.name}`, callback_data: `admin:btn:edit:${b.id}` }]);
  }
  // Chunk into 2 columns
  const flat = rows.flat();
  const chunked = [];
  for (let i = 0; i < flat.length; i += 2) {
    chunked.push(flat.slice(i, i + 2));
  }
  const finalRows = chunked.length > 0 ? chunked : [];
  finalRows.push([{ text: "➕ افزودن زیرمجموعه", callback_data: `admin:btn:add:${parentId}` }]);
  if (Number(parentId) === 0) {
    finalRows.push([{ text: "🔙 بازگشت", callback_data: "admin:panel" }]);
  } else {
    finalRows.push([{ text: "🔙 بازگشت", callback_data: `admin:btn:manage:${Number(parentParentId || 0)}` }]);
  }
  finalRows.push([{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]);
  return { inline_keyboard: finalRows };
}

function adminEditButtonKeyboard(buttonId, parentId, isActive, isProtected, isUploadCompleted) {
  const toggleText = isActive ? "🔴 غیرفعال کن" : "🟢 فعال کن";
  const protectText = isProtected ? "🔒 خصوصی روشن" : "🔓 خصوصی خاموش";
  const uploadDoneText = isUploadCompleted ? "🟢 اتمام آپلود" : "🔴 اتمام آپلود";
  const core = [
    [{ text: "✏️ تغییر نام", callback_data: `admin:btn:rename:${buttonId}` }],
    [{ text: "📤 آپلود محتوا", callback_data: `admin:btn:append:${buttonId}` }],
    [{ text: uploadDoneText, callback_data: `admin:btn:uploaddone:${buttonId}` }],
    [{ text: protectText, callback_data: `admin:btn:protect:${buttonId}` }],
    [{ text: "🧩 ایجاد جلسه", callback_data: `admin:btn:sessions:${buttonId}` }],
    [{ text: "📁 مدیریت زیردکمه‌ها", callback_data: `admin:btn:manage:${buttonId}` }],
    [{ text: toggleText, callback_data: `admin:btn:toggle:${buttonId}` }],
    [{ text: "🗑️ حذف دکمه", callback_data: `admin:btn:delete:${buttonId}` }],
  ];
  // Chunk core into 2 columns
  const flat = core.flat();
  const chunked = [];
  for (let i = 0; i < flat.length; i += 2) {
    chunked.push(flat.slice(i, i + 2));
  }
  chunked.push([{ text: "🔙 بازگشت", callback_data: `admin:btn:manage:${parentId}` }]);
  chunked.push([{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]);
  return { inline_keyboard: chunked };
}

function adminUploadReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "✅ اتمام آپلود" }, { text: "📋 نمایش لیست" }],
      [{ text: "❌ لغو کل آپلود" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function adminUploadConfirmReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "✅ تایید نهایی" }],
      [{ text: "↩️ بازگشت به آپلود" }, { text: "❌ انصراف و حذف لیست" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function uploadFinishKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ بله، ذخیره کن", callback_data: "admin:upload:finish" },
       { text: "➡️ خیر، ادامه میدم", callback_data: "admin:upload:continue" }],
      [{ text: "❌ لغو کل آپلود", callback_data: "admin:upload:cancel" }],
    ],
  };
}

function broadcastConfirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ ارسال کن", callback_data: "admin:broadcast:confirm" }],
      [{ text: "❌ لغو", callback_data: "admin:broadcast:cancel" }],
    ],
  };
}

function backToPanelKeyboard() {
  return { inline_keyboard: [[{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]] };
}

// ═══════ WELCOME TEXT ═══════

function welcomeText() {
  return `🧡 › درود ×͜× رفیق من :)

اینجا میتونی درخواست و پیشنهاداتو برای ما بفرستی و ما در کمترین زمان ممکن میخونیمیش و حتماً پاسخ میدیم .

> 💌 › پیــام ناشنــاس : رفیق من پیامتو که میفرستی ناشناس ارسال میشه و هیچ اطلاعاتی از اکانت شما برای ما معلوم نیست .

> 🫶🏻 › پیـــام عـــادی : رفیق من پیامتو ک میفرستی اسم اکانتت مشخصه و برای ما پیداست که از سمت کی پیام دریافت کردیم .

> 📚 › محتــوای آموزشی : در این قسمت میتونی محتوای های مختلفی همچون " پادکست های مشاوره ای ، برنامه های راهبردی و تحصلی ، جزوات و پکیج های درسی و مصاحبه ای و ... " رو ببینی و دریافت کنی .`;
}

// ═══════ HELPER FUNCTIONS ═══════

function shortKind(kind) {
  const labels = { text: "متن", photo: "عکس", video: "ویدیو", document: "فایل", audio: "صوت", voice: "ویس", sticker: "استیکر", animation: "گیف" };
  return labels[kind] || kind || "نامشخص";
}

function buildUploadListText(pending) {
  if (!pending || pending.length === 0) return "📭 هنوز هیچ محتوایی در لیست موقت ندارید.";
  const lines = pending.slice(0, 30).map((item, i) => {
    const kind = shortKind(item.kind);
    const cap = (item.text || "").replace(/\n/g, " ").trim();
    const preview = cap ? cap.substring(0, 50) + (cap.length > 50 ? "…" : "") : null;
    return `${i + 1}. ${kind}${preview ? " | " + preview : ""}`;
  });
  const extra = pending.length - 30;
  if (extra > 0) lines.push(`… و ${extra} مورد دیگر`);
  return `📋 لیست موقت آپلودها (${pending.length} مورد):\n\n` + lines.join("\n");
}

async function savePendingContents(env, buttonId, pending) {
  let success = 0, fail = 0;
  for (const item of pending) {
    try {
      const order = (await dbFirst(env, "SELECT COALESCE(MAX(order_index),0)+1 as n FROM button_contents WHERE button_id=?", [buttonId]));
      await dbRun(env, "INSERT INTO button_contents (button_id, order_index, content_kind, content_text, content_file_id) VALUES (?, ?, ?, ?, ?)",
        [buttonId, order ? order.n : 0, item.kind || "text", item.text || "", item.file_id || ""]);
      success++;
    } catch (e) { fail++; }
  }
  if (success > 0) {
    try { await dbRun(env, "UPDATE buttons SET upload_completed = 0 WHERE id = ?", [buttonId]); } catch (e) { /* ok */ }
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
  if (maxIdx >= 0) return maxIdx + 1;
  return children.length;
}

function sessionNameForIndex(idx) {
  const emojis = ["🔸", "🔹", "🔺"];
  const emoji = emojis[(Math.floor(idx / 3)) % emojis.length];
  const label = String(idx).padStart(2, "0");
  return `${emoji} جلسه : ${label} ${emoji}`;
}

// ═══════ MESSAGE HANDLER ═══════

async function handleMessage(message, env) {
  await ensureTables(env);

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text || "";

  // Register user
  await dbRun(env, "INSERT INTO users (user_id, username, first_name, last_name) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name",
    [userId, message.from.username || "", message.from.first_name || "", message.from.last_name || ""]);

  // Check blocked
  const user = await dbFirst(env, "SELECT blocked FROM users WHERE user_id = ?", [userId]);
  if (user && user.blocked) return;

  // Bootstrap admin
  if (env.MAIN_ADMIN_ID) {
    await dbRun(env, "INSERT INTO admins (user_id, role) VALUES (?, 'owner') ON CONFLICT(user_id) DO UPDATE SET role=excluded.role", [parseInt(env.MAIN_ADMIN_ID)]);
  }

  // ─── /start ───
  if (text === "/start") {
    await clearState(userId, env);
    await sendMsg(chatId, welcomeText(), env, { reply_markup: mainKeyboard() });
    return;
  }

  // ─── /admin ───
  if (text === "/admin") {
    if (!isAdmin(userId, env)) { await sendMsg(chatId, "❌ دسترسی ندارید.", env); return; }
    await clearState(userId, env);
    const role = isOwner(userId, env) ? "owner" : "admin";
    await sendMsg(chatId, `👨‍💼 <b>پنل مدیریت</b>\n👤 نقش شما: <b>${role}</b>\n\nیکی از گزینه‌ها را انتخاب کنید:`, env, { reply_markup: adminPanelKeyboard(env) });
    return;
  }

  // ─── /cancel ───
  if (text === "/cancel" || text === "لغو") {
    await clearState(userId, env);
    await sendMsg(chatId, "❌ لغو شد.", env, { reply_markup: mainKeyboard() });
    return;
  }

  // ─── STATE-BASED ROUTING ───
  const st = await getState(userId, env);

  // ─── ADMIN: add_button state ───
  if (st && st.state === "add_button") {
    if (!isAdmin(userId, env)) return;
    if (!text) { await sendMsg(chatId, "❌ فقط متن (نام دکمه) ارسال کنید.", env); return; }
    const name = text.trim();
    const rawParentId = st.data.parent_id;
    const parentId = (rawParentId && Number(rawParentId) > 0) ? Number(rawParentId) : 0;

    if (parentId > 0) {
      const parent = await dbFirst(env, "SELECT id FROM buttons WHERE id = ?", [parentId]);
      if (!parent) {
        await clearState(userId, env);
        await sendMsg(chatId, "⚠️ مسیر/دکمه والد نامعتبر شد.", env, { reply_markup: backToPanelKeyboard() });
        return;
      }
    }

    const order = (await dbFirst(env, "SELECT COALESCE(MAX(order_index),0)+1 as n FROM buttons WHERE parent_id=?", [parentId]));
    await dbRun(env, "INSERT INTO buttons (parent_id, name, order_index) VALUES (?, ?, ?)", [parentId, name, order ? order.n : 0]);
    await clearState(userId, env);
    await sendMsg(chatId, `✅ دکمه «${name}» اضافه شد.`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── ADMIN: rename_button state ───
  if (st && st.state === "rename_button") {
    if (!isAdmin(userId, env)) return;
    if (!text) { await sendMsg(chatId, "❌ فقط متن ارسال کنید.", env); return; }
    const buttonId = st.data.button_id;
    await dbRun(env, "UPDATE buttons SET name = ? WHERE id = ?", [text.trim(), buttonId]);
    await clearState(userId, env);
    await sendMsg(chatId, "✅ نام دکمه تغییر کرد.", env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── ADMIN: delete_confirm state ───
  if (st && st.state === "delete_confirm") {
    if (!isAdmin(userId, env)) return;
    if (!text || text.trim() !== "حذف") {
      await sendMsg(chatId, "❌ برای حذف باید دقیقاً عبارت <code>حذف</code> را ارسال کنید.", env);
      return;
    }
    const buttonId = st.data.button_id;
    await deleteButtonTree(env, buttonId);
    await clearState(userId, env);
    await sendMsg(chatId, "✅ دکمه و زیرمجموعه‌ها حذف شدند.", env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── ADMIN: upload_content state ───
  if (st && st.state === "upload_content") {
    if (!isAdmin(userId, env)) return;
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    const trimmed = text.trim();

    // Reply keyboard commands
    if (trimmed === "✅ اتمام آپلود") {
      if (pending.length === 0) {
        await sendMsg(chatId, "❌ هنوز هیچ محتوایی آپلود نشده است.", env, { reply_markup: adminUploadReplyKeyboard() });
        return;
      }
      await setState(userId, "upload_confirm", { button_id: buttonId, pending_files: pending }, env);
      await sendMsg(chatId, `⚠️ آماده ثبت نهایی ${pending.length} مورد هستید؟\nبا تایید نهایی ذخیره می‌شود؛ با انصراف همه موارد موقت حذف می‌شود.`, env, { reply_markup: adminUploadConfirmReplyKeyboard() });
      return;
    }
    if (trimmed === "📋 نمایش لیست") {
      await sendMsg(chatId, buildUploadListText(pending), env, { reply_markup: adminUploadReplyKeyboard() });
      return;
    }
    if (trimmed === "❌ لغو کل آپلود") {
      await clearState(userId, env);
      await sendMsg(chatId, `❌ آپلود لغو شد و ${pending.length} مورد ذخیره‌نشده حذف شد.`, env, { reply_markup: removeKeyboard() });
      return;
    }

    // Receive media/content
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
    await sendMsg(chatId, `✅ دریافت شد. تعداد موارد موقت: ${pending.length}`, env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  // ─── ADMIN: upload_confirm state ───
  if (st && st.state === "upload_confirm") {
    if (!isAdmin(userId, env)) return;
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    const trimmed = text.trim();

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
    if (trimmed === "✅ تایید نهایی") {
      if (pending.length === 0) {
        await clearState(userId, env);
        await sendMsg(chatId, "❌ لیست موقت خالی است.", env, { reply_markup: removeKeyboard() });
        return;
      }
      const result = await savePendingContents(env, buttonId, pending);
      await clearState(userId, env);
      await sendMsg(chatId, `✅ ذخیره نهایی انجام شد.\nموفق: ${result.success}\nناموفق: ${result.fail}`, env, { reply_markup: removeKeyboard() });
      return;
    }
    await sendMsg(chatId, "⚠️ از دکمه‌های پایین برای تایید یا لغو استفاده کنید.", env, { reply_markup: adminUploadConfirmReplyKeyboard() });
    return;
  }

  // ─── ADMIN: broadcast_wait state ───
  if (st && st.state === "broadcast_wait") {
    if (!isAdmin(userId, env)) return;
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
    await sendMsg(chatId, `✅ آماده ارسال به <b>${userCount ? userCount.c : 0}</b> کاربر.\nآیا تایید می‌کنید؟`, env, { reply_markup: broadcastConfirmKeyboard() });
    return;
  }

  // ─── ADMIN: broadcast_confirm state ───
  if (st && st.state === "broadcast_confirm") {
    // Text input during broadcast_confirm is ignored - use inline buttons
    await sendMsg(chatId, "⚠️ از دکمه‌های زیر برای تایید یا لغو استفاده کنید.", env, { reply_markup: broadcastConfirmKeyboard() });
    return;
  }

  // ─── ADMIN: admin_reply state ───
  if (st && st.state === "admin_reply") {
    if (!isAdmin(userId, env)) return;
    const target = st.data.target;
    const mode = st.data.mode;
    await clearState(userId, env);
    const prefix = mode === "anon" ? "🎭" : "📨";
    await sendMsg(target, `${prefix} <b>پاسخ از طرف پشتیبانی:</b>\n\n${text}`, env);
    await sendMsg(chatId, "✅ پاسخ ارسال شد.", env);
    return;
  }

  // ─── ADMIN: ban_menu state ───
  if (st && st.state === "ban_menu") {
    if (!isAdmin(userId, env)) return;
    if (!text) { await sendMsg(chatId, "❌ آیدی عددی را به صورت متن ارسال کنید.", env); return; }
    let target;
    try { target = parseInt(text.trim()); } catch (e) { await sendMsg(chatId, "❌ آیدی نامعتبر.", env); return; }
    if (!target) { await sendMsg(chatId, "❌ آیدی نامعتبر.", env); return; }
    const row = await dbFirst(env, "SELECT blocked FROM users WHERE user_id = ?", [target]);
    const nowBlocked = !(row && row.blocked);
    if (!row) {
      await dbRun(env, "INSERT INTO users (user_id, blocked) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET blocked=excluded.blocked", [target, nowBlocked ? 1 : 0]);
    } else {
      await dbRun(env, "UPDATE users SET blocked = ? WHERE user_id = ?", [nowBlocked ? 1 : 0, target]);
    }
    await sendMsg(chatId, `✅ انجام شد: ${nowBlocked ? "بن شد." : "آزاد شد."}`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── ADMIN: forcejoin_menu state ───
  if (st && st.state === "forcejoin_menu") {
    if (!isAdmin(userId, env)) return;
    if (!text) return;
    const t = text.trim();
    if (t.toLowerCase().startsWith("حذف ")) {
      const ch = t.split(" ", 1)[1].trim();
      try { await dbRun(env, "DELETE FROM forced_channels WHERE channel = ?", [ch]); } catch (e) { /* ok */ }
      await sendMsg(chatId, "✅ حذف شد.", env, { reply_markup: backToPanelKeyboard() });
    } else {
      try { await dbRun(env, "INSERT INTO forced_channels (channel) VALUES (?)", [t]); } catch (e) { /* duplicate */ }
      await sendMsg(chatId, "✅ اضافه شد.", env, { reply_markup: backToPanelKeyboard() });
    }
    return;
  }

  // ─── ADMIN: archive_menu state ───
  if (st && st.state === "archive_menu") {
    if (!isAdmin(userId, env)) return;
    if (!text) return;
    const raw = text.trim();
    if (["off", "none", "null", "disable", "remove", "del", "حذف", "خاموش"].includes(raw.toLowerCase())) {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('archive_channel_id', '') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      await sendMsg(chatId, "✅ آرشیو غیرفعال شد.", env, { reply_markup: backToPanelKeyboard() });
    } else {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('archive_channel_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [raw]);
      await sendMsg(chatId, `✅ مقصد آرشیو ثبت شد: <code>${raw}</code>`, env, { reply_markup: backToPanelKeyboard() });
    }
    return;
  }

  // ─── ADMIN: backup_set_chat state ───
  if (st && st.state === "backup_set_chat") {
    if (!isAdmin(userId, env)) return;
    if (!text) { await sendMsg(chatId, "❌ لطفاً مقصد بکاپ را به‌صورت متن ارسال کنید.", env); return; }
    const raw = text.trim();
    if (["off", "none", "null", "disable", "remove", "del", "حذف", "خاموش"].includes(raw.toLowerCase())) {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('backup_chat_ref', '') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      await clearState(userId, env);
      await sendMsg(chatId, "✅ مقصد بکاپ غیرفعال شد.", env, { reply_markup: backToPanelKeyboard() });
    } else {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('backup_chat_ref', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [raw]);
      await clearState(userId, env);
      await sendMsg(chatId, `✅ مقصد بکاپ ثبت شد: <code>${raw}</code>`, env, { reply_markup: backToPanelKeyboard() });
    }
    return;
  }

  // ─── ADMIN: session_batch_count state ───
  if (st && st.state === "session_batch_count") {
    if (!isAdmin(userId, env)) return;
    const raw = text.trim();
    if (raw === "لغو") {
      await clearState(userId, env);
      await sendMsg(chatId, "❌ عملیات ایجاد جلسه لغو شد.", env);
      return;
    }
    let count;
    try { count = parseInt(raw); } catch (e) { count = null; }
    if (!count || count < 1 || count > 500) {
      await sendMsg(chatId, "❌ تعداد نامعتبر است. عددی بین ۱ تا ۵۰۰ ارسال کنید.\nبرای لغو: <code>لغو</code>", env);
      return;
    }
    const buttonId = st.data.button_id;
    const startIdx = await getNextSessionIndex(env, buttonId);
    const endIdx = startIdx + count - 1;
    await setState(userId, "session_batch_confirm", { button_id: buttonId, count, start_index: startIdx, end_index: endIdx }, env);
    const path = await getButtonPath(env, buttonId);
    await sendMsg(chatId, `⚠️ <b>تایید ایجاد جلسه</b>\n\nمسیر مقصد: <b>${path}</b>\nتعداد: <b>${count}</b> جلسه\nرنج شماره: <b>${String(startIdx).padStart(2, "0")}</b> تا <b>${String(endIdx).padStart(2, "0")}</b>\n\nبرای ادامه عبارت <code>تایید</code> را ارسال کنید.\nبرای انصراف عبارت <code>لغو</code> را ارسال کنید.`, env);
    return;
  }

  // ─── ADMIN: session_batch_confirm state ───
  if (st && st.state === "session_batch_confirm") {
    if (!isAdmin(userId, env)) return;
    const raw = text.trim();
    if (raw === "لغو") {
      await clearState(userId, env);
      await sendMsg(chatId, "❌ ایجاد جلسه لغو شد.", env);
      return;
    }
    if (raw !== "تایید") {
      await sendMsg(chatId, "⚠️ برای تایید عبارت <code>تایید</code> و برای لغو عبارت <code>لغو</code> را ارسال کنید.", env);
      return;
    }
    const buttonId = st.data.button_id;
    const count = st.data.count;
    const startIdx = await getNextSessionIndex(env, buttonId);
    let created = 0, failed = 0;
    for (let idx = startIdx; idx < startIdx + count; idx++) {
      try {
        const order = (await dbFirst(env, "SELECT COALESCE(MAX(order_index),0)+1 as n FROM buttons WHERE parent_id=?", [buttonId]));
        await dbRun(env, "INSERT INTO buttons (parent_id, name, order_index) VALUES (?, ?, ?)", [buttonId, sessionNameForIndex(idx), order ? order.n : 0]);
        created++;
      } catch (e) { failed++; }
    }
    await clearState(userId, env);
    const path = await getButtonPath(env, buttonId);
    const endIdx = startIdx + created - 1;
    await sendMsg(chatId, `✅ جلسه‌ها با موفقیت ایجاد شدند.\nمسیر: <b>${path}</b>\nتعداد موفق: <b>${created}</b>\nبازه: <b>${String(startIdx).padStart(2, "0")}</b> تا <b>${String(endIdx).padStart(2, "0")}</b>\nناموفق: <b>${failed}</b>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }


  // ─── ADMIN STATE: Add button name ───
  if (st && st.state === "admin_add_btn_name") {
    if (!isAdmin(userId, env)) return;
    const name = text.trim();
    if (!name || name.length > 100) { await sendMsg(chatId, "⚠️ نام باید ۱ تا ۱۰۰ کاراکتر باشد.", env); return; }
    const parentId = st.data.parent_id || 0;
    await dbRun(env, "INSERT INTO buttons (parent_id, name, order_index) VALUES (?, ?, (SELECT COALESCE(MAX(order_index),0)+1 FROM buttons WHERE parent_id=?))", [parentId || null, name, parentId]);
    await clearState(userId, env);
    await sendMsg(chatId, `✅ دکمه «${name}» ساخته شد.`, env);
    return;
  }

  // ─── ADMIN STATE: Rename button ───
  if (st && st.state === "admin_rename_btn") {
    if (!isAdmin(userId, env)) return;
    const name = text.trim();
    if (!name || name.length > 100) { await sendMsg(chatId, "⚠️ نام باید ۱ تا ۱۰۰ کاراکتر باشد.", env); return; }
    await dbRun(env, "UPDATE buttons SET name = ? WHERE id = ?", [name, st.data.button_id]);
    await clearState(userId, env);
    await sendMsg(chatId, `✅ نام تغییر کرد به «${name}».`, env);
    return;
  }

  // ─── ADMIN STATE: Delete confirm ───
  if (st && st.state === "admin_delete_confirm") {
    if (!isAdmin(userId, env)) return;
    if (text.trim() === "حذف") {
      const buttonId = st.data.button_id;
      await dbRun(env, "DELETE FROM button_contents WHERE button_id = ?", [buttonId]);
      await dbRun(env, "DELETE FROM buttons WHERE id = ?", [buttonId]);
      await clearState(userId, env);
      await sendMsg(chatId, "✅ دکمه و تمام زیرمجموعه‌ها حذف شدند.", env);
    } else {
      await clearState(userId, env);
      await sendMsg(chatId, "❎ حذف لغو شد.", env);
    }
    return;
  }

  // ─── ADMIN STATE: Upload content ───
  if (st && st.state === "admin_upload") {
    if (!isAdmin(userId, env)) return;
    const buttonId = st.data.button_id;
    let kind = "text", fileId = null;
    if (message.photo) { kind = "photo"; fileId = message.photo[message.photo.length - 1].file_id; }
    else if (message.video) { kind = "video"; fileId = message.video.file_id; }
    else if (message.document) { kind = "document"; fileId = message.document.file_id; }
    else if (message.audio) { kind = "audio"; fileId = message.audio.file_id; }
    else if (message.voice) { kind = "voice"; fileId = message.voice.file_id; }
    else if (message.sticker) { kind = "sticker"; fileId = message.sticker.file_id; }
    else if (message.animation) { kind = "animation"; fileId = message.animation.file_id; }
    else if (message.text) { kind = "text"; }

    // Check for upload commands
    if (message.text === "✅ اتمام آپلود") {
      // Trigger upload finish
      const pending = st.data.pending_files || [];
      if (pending.length === 0) { await sendMsg(chatId, "📭 هیچ فایلی ارسال نشده.", env); return; }
      await editMsg(chatId, 0, `📋 ${pending.length} فایل در لیست موقت.\nآیا ذخیره شود?`, env, { reply_markup: adminUploadFinishKeyboard() });
      return;
    }
    if (message.text === "📋 نمایش لیست آپلودها") {
      const pending = st.data.pending_files || [];
      let listText = "📋 لیست موقت آپلودها:\n\n";
      if (pending.length === 0) { listText += "📭 هنوز هیچ محتوایی ندارید."; }
      else { pending.forEach((item, i) => { listText += `${i + 1}. ${item.kind}\n`; }); }
      await sendMsg(chatId, listText, env);
      return;
    }
    if (message.text === "❌ لغو کل آپلود") {
      await clearState(userId, env);
      await sendMsg(chatId, "❌ آپلود لغو شد.", env, { reply_markup: removeKeyboard() });
      return;
    }

    // Save the content
    const pending = st.data.pending_files || [];
    pending.push({ kind, text: message.text || message.caption || "", file_id: fileId });
    st.data.pending_files = pending;
    await setState(userId, "admin_upload", st.data, env);
    const labels = { text: "متن", photo: "عکس", video: "ویدیو", document: "فایل", audio: "صوت", voice: "ویس", sticker: "استیکر", animation: "گیف" };
    await sendMsg(chatId, `✅ [${pending.length}] ${labels[kind] || kind} اضافه شد.`, env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  // ─── USER: "ارسال پیام" ───
  if (text === "📨 ارسال پیام") {
    await clearState(userId, env);
    await sendMsg(chatId, "یکی از حالت‌های زیر را انتخاب کنید:", env, { reply_markup: msgTypeKeyboard() });
    return;
  }

  // ─── USER: "پیام ناشناس" ───
  if (text === "💌 پیام ناشناس") {
    await setState(userId, "waiting_anon", {}, env);
    await sendMsg(chatId, "📝 پیام خود را بنویسید:\n\n🔒 اطلاعات شما کاملاً مخفی خواهد بود.", env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── USER: "پیام عادی" ───
  if (text === "🫶🏻 پیام عادی") {
    await setState(userId, "waiting_normal", {}, env);
    await sendMsg(chatId, "📝 پیام خود را بنویسید:\n\n⚠️ اطلاعات شما برای ادمین نمایش داده می‌شود.", env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── USER: "محتوای آموزشی" ───
  if (text === "📚 محتوای آموزشی") {
    await clearState(userId, env);
    await showContentRoot(chatId, env);
    return;
  }

  // ─── USER: "بازگشت" ───
  if (text === "🔙 بازگشت") {
    await clearState(userId, env);
    await sendMsg(chatId, welcomeText(), env, { reply_markup: mainKeyboard() });
    return;
  }

  // ─── USER: sending anonymous message ───
  if (st && st.state === "waiting_anon") {
    await clearState(userId, env);
    const adminId = parseInt(env.MAIN_ADMIN_ID);
    if (adminId) {
      await sendMsg(adminId, `🎭 <b>پیام ناشناس جدید</b>\n\n💬 پیام:\n${text}`, env, {
        reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "✅ پاسخ", callback_data: `reply:${userId}:anon` }], [{ text: "🚫 بلاک", callback_data: `block:${userId}` }]] }),
      });
    }
    await sendMsg(chatId, "✅ پیام شما ناشناس ارسال شد.\n⏳ منتظر پاسخ باشید.", env, { reply_markup: mainKeyboard() });
    return;
  }

  // ─── USER: sending normal message ───
  if (st && st.state === "waiting_normal") {
    await clearState(userId, env);
    const adminId = parseInt(env.MAIN_ADMIN_ID);
    if (adminId) {
      const name = message.from.first_name || "";
      const username = message.from.username ? "@" + message.from.username : "ندارد";
      await sendMsg(adminId, `📨 <b>پیام جدید (عادی)</b>\n\n👤 نام: ${name}\n📌 یوزرنیم: ${username}\n🆔 آیدی: ${userId}\n\n💬 پیام:\n${text}`, env, {
        reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "✅ پاسخ", callback_data: `reply:${userId}:normal` }], [{ text: "🚫 بلاک", callback_data: `block:${userId}` }]] }),
      });
    }
    await sendMsg(chatId, "✅ پیام شما ارسال شد.\n⏳ منتظر پاسخ باشید.", env, { reply_markup: mainKeyboard() });
    return;
  }
}

// ═══════ CALLBACK HANDLER ═══════

async function handleCallback(callback, env) {
  await ensureTables(env);
  const chatId = callback.message.chat.id;
  const msgId = callback.message.message_id;
  const data = callback.data;
  const userId = callback.from.id;

  await dbRun(env, "INSERT INTO users (user_id, username, first_name, last_name) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username", [userId, callback.from.username || "", callback.from.first_name || "", callback.from.last_name || ""]);

  // ─── menu:home ───
  if (data === "menu:home") {
    await clearState(userId, env);
    await safeEditMsg(chatId, msgId, "🏠 منوی اصلی", env, { reply_markup: { inline_keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]] } });
    await sendMsg(chatId, welcomeText(), env, { reply_markup: mainKeyboard() });
    await answerCb(callback.id, env);
    return;
  }

  // ─── back_main ───
  if (data === "back_main") {
    await clearState(userId, env);
    await safeEditMsg(chatId, msgId, "🏠", env);
    await sendMsg(chatId, welcomeText(), env, { reply_markup: mainKeyboard() });
    await answerCb(callback.id, env);
    return;
  }

  // ─── noop ───
  if (data === "noop") {
    await answerCb(callback.id, env);
    return;
  }

  // ─── Reply to user ───
  if (data.startsWith("reply:")) {
    const parts = data.split(":");
    const target = parseInt(parts[1]);
    const mode = parts[2];
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌", true); return; }
    await setState(userId, "admin_reply", { target, mode }, env);
    await answerCb(callback.id, env, "📝 پاسخ بنویسید.");
    await sendMsg(chatId, `📝 پاسخ به کاربر ${target} را بنویسید:`, env);
    return;
  }

  // ─── Block user ───
  if (data.startsWith("block:")) {
    const target = parseInt(data.split(":")[1]);
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌", true); return; }
    await dbRun(env, "UPDATE users SET blocked = 1 WHERE user_id = ?", [target]);
    await answerCb(callback.id, env, `🚫 کاربر ${target} بلاک شد.`);
    return;
  }


  // ─── ADMIN PANEL ───
  if (data === "admin:panel") {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await answerCb(callback.id, env);
    await editMsg(chatId, msgId, "👨‍💼 <b>پنل مدیریت</b>\n\nیکی از گزینه‌ها را انتخاب کنید:", env, { reply_markup: adminPanelKeyboard() });
    return;
  }

  // ─── ADMIN: Manage buttons ───
  if (data.startsWith("admin:btn:manage:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const parentId = parseInt(data.split(":")[2]) || 0;
    await answerCb(callback.id, env);
    const buttons = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = ? AND is_active = 1 ORDER BY order_index", [parentId]);
    const allButtons = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = ? ORDER BY order_index", [parentId]);
    await editMsg(chatId, msgId, "📋 <b>مدیریت دکمه‌ها</b>\n\nروی هر دکمه بزنید تا ویرایش کنید:", env, { reply_markup: adminManageButtonsKeyboard(allButtons, parentId) });
    return;
  }

  // ─── ADMIN: Add button ───
  if (data.startsWith("admin:btn:add:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const parentId = parseInt(data.split(":")[2]) || 0;
    await answerCb(callback.id, env);
    await setState(userId, "admin_add_btn_name", { parent_id: parentId }, env);
    await sendMsg(chatId, "➕ نام دکمه جدید را ارسال کنید:", env);
    return;
  }

  // ─── ADMIN: Edit button ───
  if (data.startsWith("admin:btn:edit:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const buttonId = parseInt(data.split(":")[2]);
    await answerCb(callback.id, env);
    const btn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!btn) { await sendMsg(chatId, "❌ دکمه یافت نشد.", env); return; }
    const contents = await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]);
    const contentLabel = contents[0] && contents[0].c > 0 ? `${contents[0].c} مورد` : "---";
    const uploadDoneLabel = btn.upload_completed ? "تایید شده" : "تایید نشده";
    await editMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${btn.name}</b>\nوضعیت: <b>${btn.is_active ? 'فعال' : 'غیرفعال'}</b>\nخصوصی: <b>${btn.protect_content ? 'روشن' : 'خاموش'}</b>\nآپلود: <b>${uploadDoneLabel}</b>\nمحتوا: <b>${contentLabel}</b>`, env, { reply_markup: adminEditButtonKeyboard(buttonId, btn.parent_id || 0, btn.is_active, btn.protect_content, btn.upload_completed) });
    return;
  }

  // ─── ADMIN: Rename button ───
  if (data.startsWith("admin:btn:rename:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const buttonId = parseInt(data.split(":")[2]);
    await answerCb(callback.id, env);
    await setState(userId, "admin_rename_btn", { button_id: buttonId }, env);
    await sendMsg(chatId, "✏️ نام جدید دکمه را ارسال کنید:", env);
    return;
  }

  // ─── ADMIN: Toggle button ───
  if (data.startsWith("admin:btn:toggle:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const buttonId = parseInt(data.split(":")[2]);
    await answerCb(callback.id, env);
    const btn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!btn) return;
    await dbRun(env, "UPDATE buttons SET is_active = ? WHERE id = ?", [btn.is_active ? 0 : 1, buttonId]);
    // Refresh edit view
    const newBtn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    const contents = await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]);
    const contentLabel = contents[0] && contents[0].c > 0 ? `${contents[0].c} مورد` : "---";
    await editMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${newBtn.name}</b>\nوضعیت: <b>${newBtn.is_active ? 'فعال' : 'غیرفعال'}</b>\nخصوصی: <b>${newBtn.protect_content ? 'روشن' : 'خاموش'}</b>\nمحتوا: <b>${contentLabel}</b>`, env, { reply_markup: adminEditButtonKeyboard(buttonId, newBtn.parent_id || 0, newBtn.is_active, newBtn.protect_content, newBtn.upload_completed) });
    return;
  }

  // ─── ADMIN: Toggle protect ───
  if (data.startsWith("admin:btn:protect:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const buttonId = parseInt(data.split(":")[2]);
    await answerCb(callback.id, env);
    const btn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!btn) return;
    await dbRun(env, "UPDATE buttons SET protect_content = ? WHERE id = ?", [btn.protect_content ? 0 : 1, buttonId]);
    const newBtn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    const contents = await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]);
    const contentLabel = contents[0] && contents[0].c > 0 ? `${contents[0].c} مورد` : "---";
    await editMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${newBtn.name}</b>\nوضعیت: <b>${newBtn.is_active ? 'فعال' : 'غیرفعال'}</b>\nخصوصی: <b>${newBtn.protect_content ? 'روشن' : 'خاموش'}</b>\nمحتوا: <b>${contentLabel}</b>`, env, { reply_markup: adminEditButtonKeyboard(buttonId, newBtn.parent_id || 0, newBtn.is_active, newBtn.protect_content, newBtn.upload_completed) });
    return;
  }

  // ─── ADMIN: Toggle upload done ───
  if (data.startsWith("admin:btn:uploaddone:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const buttonId = parseInt(data.split(":")[2]);
    await answerCb(callback.id, env);
    const btn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!btn) return;
    await dbRun(env, "UPDATE buttons SET upload_completed = ? WHERE id = ?", [btn.upload_completed ? 0 : 1, buttonId]);
    const newBtn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    const contents = await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]);
    const contentLabel = contents[0] && contents[0].c > 0 ? `${contents[0].c} مورد` : "---";
    await editMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${newBtn.name}</b>\nوضعیت: <b>${newBtn.is_active ? 'فعال' : 'غیرفعال'}</b>\nخصوصی: <b>${newBtn.protect_content ? 'روشن' : 'خاموش'}</b>\nآپلود: <b>${newBtn.upload_completed ? 'تایید شده' : 'تایید نشده'}</b>\nمحتوا: <b>${contentLabel}</b>`, env, { reply_markup: adminEditButtonKeyboard(buttonId, newBtn.parent_id || 0, newBtn.is_active, newBtn.protect_content, newBtn.upload_completed) });
    return;
  }

  // ─── ADMIN: Upload content ───
  if (data.startsWith("admin:btn:append:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const buttonId = parseInt(data.split(":")[2]);
    await answerCb(callback.id, env);
    await setState(userId, "admin_upload", { button_id: buttonId, pending_files: [] }, env);
    await sendMsg(chatId, "📤 آپلود گروهی فعال شد.\nمحتواها رو بفرستید.\nوقتی تموم شد دکمه \"✅ اتمام آپلود\" رو بزنید.", env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  // ─── ADMIN: Delete button ───
  if (data.startsWith("admin:btn:delete:")) {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    const buttonId = parseInt(data.split(":")[2]);
    await answerCb(callback.id, env);
    const btn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!btn) return;
    await setState(userId, "admin_delete_confirm", { button_id: buttonId }, env);
    await sendMsg(chatId, `⚠️ آیا از حذف '<b>${btn.name}</b>' و تمام زیرمجموعه‌ها مطمئنید?\nبرای تایید، عبارت زیر را ارسال کنید:\n\n<code>حذف</code>`, env);
    return;
  }

  // ─── ADMIN: Stats ───
  if (data === "admin:stats") {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await answerCb(callback.id, env);
    const users = await dbFirst(env, "SELECT COUNT(*) as c FROM users");
    const btns = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0");
    const contents = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents");
    await editMsg(chatId, msgId, `📊 <b>آمار کلی</b>\n\n👥 کاربران: ${users.c}\n🔘 دکمه‌ها: ${btns.c}\n📎 محتواها: ${contents.c}`, env, { reply_markup: adminSimpleBackToPanel() });
    return;
  }

  // ─── ADMIN: Broadcast ───
  if (data === "admin:broadcast:start") {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await answerCb(callback.id, env);
    await setState(userId, "broadcasting", {}, env);
    await sendMsg(chatId, "📝 پیام همگانی را بنویسید:", env);
    return;
  }

  // ─── ADMIN: Upload finish confirm ───
  if (data === "admin:upload:finish") {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (!st || st.state !== "admin_upload") return;
    const pending = st.data.pending_files || [];
    if (pending.length === 0) { await sendMsg(chatId, "📭 هیچ فایلی ارسال نشده.", env); return; }
    await editMsg(chatId, msgId, `📋 ${pending.length} فایل در لیست موقت.\nآیا ذخیره شود?`, env, { reply_markup: adminUploadFinishKeyboard() });
    return;
  }

  // ─── ADMIN: Upload confirm save ───
  if (data === "admin:upload:save") {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (!st || st.state !== "admin_upload") return;
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    let success = 0, fail = 0;
    for (const item of pending) {
      try {
        const order = (await dbFirst(env, "SELECT COALESCE(MAX(order_index),0)+1 as n FROM button_contents WHERE button_id=?", [buttonId]));
        await dbRun(env, "INSERT INTO button_contents (button_id, order_index, content_kind, content_text, content_file_id) VALUES (?, ?, ?, ?, ?)", [buttonId, order ? order.n : 0, item.kind, item.text || "", item.file_id || ""]);
        success++;
      } catch { fail++; }
    }
    await clearState(userId, env);
    await sendMsg(chatId, `✅ ${success} فایل ذخیره شد.${fail > 0 ? `\n❌ ${fail} فایل ناموفق.` : ""}`, env, { reply_markup: removeKeyboard() });
    return;
  }

  // ─── ADMIN: Upload continue ───
  if (data === "admin:upload:continue") {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await answerCb(callback.id, env);
    await sendMsg(chatId, "↩️ به آپلود بازگشتید.", env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  // ─── ADMIN: Upload cancel ───
  if (data === "admin:upload:cancel") {
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await answerCb(callback.id, env);
    await clearState(userId, env);
    await sendMsg(chatId, "❌ آپلود لغو شد.", env, { reply_markup: removeKeyboard() });
    return;
  }

  // ─── Content nav ───
  if (data.startsWith("content:")) {
    const parts = data.split(":");
    const action = parts[1];
    const id = parseInt(parts[2]) || 0;
    await answerCb(callback.id, env);

    if (action === "root") {
      await showContentRoot(chatId, env, msgId);
    } else if (action === "open") {
      const contents = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [id]);
      const btn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [id]);
      if (contents.length > 0) {
        for (const c of contents) {
          await sendContentItem(chatId, c, env);
        }
      } else if (btn) {
        const children = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = ? AND is_active = 1 ORDER BY order_index", [id]);
        if (children.length > 0) {
          await showContentFolder(chatId, id, env, msgId);
        } else {
          await sendMsg(chatId, "📝 این بخش هنوز محتوایی ندارد.", env);
        }
      }
    } else if (action === "folder") {
      await showContentFolder(chatId, id, env, msgId);
    } else if (action === "back") {
      const btn = await dbFirst(env, "SELECT parent_id FROM buttons WHERE id = ?", [id]);
      const pid = btn && btn.parent_id ? btn.parent_id : 0;
      if (pid === 0) await showContentRoot(chatId, env, msgId);
      else await showContentFolder(chatId, pid, env, msgId);
    }
    return;
  }

  // ═══════ ADMIN CALLBACKS ═══════

  if (!isAdmin(userId, env)) {
    await answerCb(callback.id, env, "❌ دسترسی ندارید.", true);
    return;
  }

  // ─── admin:panel ───
  if (data === "admin:panel") {
    await clearState(userId, env);
    const role = isOwner(userId, env) ? "owner" : "admin";
    await safeEditMsg(chatId, msgId, `👨‍💼 <b>پنل مدیریت</b>\n👤 نقش شما: <b>${role}</b>\n\nیکی از گزینه‌ها را انتخاب کنید:`, env, { reply_markup: adminPanelKeyboard(env) });
    await answerCb(callback.id, env);
    return;
  }

  // ─── admin:btn:add:parentId ───
  if (data.startsWith("admin:btn:add:")) {
    const parentId = parseInt(data.split(":")[3]) || 0;
    await answerCb(callback.id, env);
    await setState(userId, "add_button", { parent_id: parentId }, env);
    await sendMsg(chatId, "➕ نام دکمه جدید را ارسال کنید:", env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── admin:btn:manage:parentId ───
  if (data.startsWith("admin:btn:manage:")) {
    const parentId = parseInt(data.split(":")[3]) || 0;
    await answerCb(callback.id, env);
    const parentParentId = await getParentParentId(env, parentId);
    const buttons = await dbAll(env, "SELECT id, name, is_active FROM buttons WHERE parent_id = ? ORDER BY order_index", [parentId]);
    const path = await getButtonPath(env, parentId);
    const text = `📋 <b>مدیریت دکمه‌ها</b>\nمسیر: <b>${path}</b>\n\nروی هر دکمه بزنید تا ویرایش کنید:`;
    await safeEditMsg(chatId, msgId, text, env, { reply_markup: adminManageButtonsKeyboard(buttons, parentId, parentParentId) });
    return;
  }

  // ─── admin:btn:edit:buttonId ───
  if (data.startsWith("admin:btn:edit:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    if (!buttonId) { await answerCb(callback.id, env, "❌", true); return; }
    const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!b) {
      await safeEditMsg(chatId, msgId, "❌ دکمه یافت نشد.", env, { reply_markup: backToPanelKeyboard() });
      return;
    }
    const path = await getButtonPath(env, buttonId);
    const cnt = (await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]))[0];
    const contentCount = cnt ? cnt.c : 0;
    const contentLabel = contentCount > 0 ? `${contentCount} مورد` : "---";
    const uploadDoneLabel = b.upload_completed ? "تایید شده" : "تایید نشده";
    const statusLabel = b.is_active ? "فعال" : "غیرفعال";
    const protectLabel = b.protect_content ? "روشن" : "خاموش";
    const editText = `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${b.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${statusLabel}</b>\nخصوصی‌سازی محتوا: <b>${protectLabel}</b>\nاتمام آپلود: <b>${uploadDoneLabel}</b>\nمحتوا: <b>${contentLabel}</b>`;
    await safeEditMsg(chatId, msgId, editText, env, {
      reply_markup: adminEditButtonKeyboard(b.id, b.parent_id || 0, !!b.is_active, !!b.protect_content, !!b.upload_completed),
    });
    return;
  }

  // ─── admin:btn:rename:buttonId ───
  if (data.startsWith("admin:btn:rename:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    await setState(userId, "rename_button", { button_id: buttonId }, env);
    await sendMsg(chatId, "✏️ نام جدید دکمه را ارسال کنید:", env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── admin:btn:toggle:buttonId ───
  if (data.startsWith("admin:btn:toggle:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!b) { await answerCb(callback.id, env, "❌ دکمه پیدا نشد.", true); return; }
    const newActive = b.is_active ? 0 : 1;
    await dbRun(env, "UPDATE buttons SET is_active = ? WHERE id = ?", [newActive, buttonId]);
    // Re-show edit view
    const path = await getButtonPath(env, buttonId);
    const cnt = (await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]))[0];
    const contentCount = cnt ? cnt.c : 0;
    const contentLabel = contentCount > 0 ? `${contentCount} مورد` : "---";
    const uploadDoneLabel = b.upload_completed ? "تایید شده" : "تایید نشده";
    const statusLabel = newActive ? "فعال" : "غیرفعال";
    const protectLabel = b.protect_content ? "روشن" : "خاموش";
    await safeEditMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${b.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${statusLabel}</b>\nخصوصی‌سازی محتوا: <b>${protectLabel}</b>\nاتمام آپلود: <b>${uploadDoneLabel}</b>\nمحتوا: <b>${contentLabel}</b>`, env, {
      reply_markup: adminEditButtonKeyboard(b.id, b.parent_id || 0, !!newActive, !!b.protect_content, !!b.upload_completed),
    });
    return;
  }

  // ─── admin:btn:protect:buttonId ───
  if (data.startsWith("admin:btn:protect:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!b) { await answerCb(callback.id, env, "❌ دکمه پیدا نشد.", true); return; }
    const newProtect = b.protect_content ? 0 : 1;
    await dbRun(env, "UPDATE buttons SET protect_content = ? WHERE id = ?", [newProtect, buttonId]);
    const path = await getButtonPath(env, buttonId);
    const cnt = (await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]))[0];
    const contentCount = cnt ? cnt.c : 0;
    const contentLabel = contentCount > 0 ? `${contentCount} مورد` : "---";
    const uploadDoneLabel = b.upload_completed ? "تایید شده" : "تایید نشده";
    const statusLabel = b.is_active ? "فعال" : "غیرفعال";
    const protectLabel = newProtect ? "روشن" : "خاموش";
    await safeEditMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${b.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${statusLabel}</b>\nخصوصی‌سازی محتوا: <b>${protectLabel}</b>\nاتمام آپلود: <b>${uploadDoneLabel}</b>\nمحتوا: <b>${contentLabel}</b>`, env, {
      reply_markup: adminEditButtonKeyboard(b.id, b.parent_id || 0, !!b.is_active, !!newProtect, !!b.upload_completed),
    });
    return;
  }

  // ─── admin:btn:uploaddone:buttonId ───
  if (data.startsWith("admin:btn:uploaddone:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [buttonId]);
    if (!b) { await answerCb(callback.id, env, "❌ دکمه پیدا نشد.", true); return; }
    const newUpDone = b.upload_completed ? 0 : 1;
    await dbRun(env, "UPDATE buttons SET upload_completed = ? WHERE id = ?", [newUpDone, buttonId]);
    const path = await getButtonPath(env, buttonId);
    const cnt = (await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]))[0];
    const contentCount = cnt ? cnt.c : 0;
    const contentLabel = contentCount > 0 ? `${contentCount} مورد` : "---";
    const uploadDoneLabel = newUpDone ? "تایید شده" : "تایید نشده";
    const statusLabel = b.is_active ? "فعال" : "غیرفعال";
    const protectLabel = b.protect_content ? "روشن" : "خاموش";
    await safeEditMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${b.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${statusLabel}</b>\nخصوصی‌سازی محتوا: <b>${protectLabel}</b>\nاتمام آپلود: <b>${uploadDoneLabel}</b>\nمحتوا: <b>${contentLabel}</b>`, env, {
      reply_markup: adminEditButtonKeyboard(b.id, b.parent_id || 0, !!b.is_active, !!b.protect_content, !!newUpDone),
    });
    return;
  }

  // ─── admin:btn:append:buttonId ───
  if (data.startsWith("admin:btn:append:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    await setState(userId, "upload_content", { button_id: buttonId, pending_files: [] }, env);
    await sendMsg(chatId, `📤 <b>آپلود محتوا</b>\n\nمحتواها به صورت ترتیبی ذخیره می‌شوند.\n\nاز دکمه‌های پایین استفاده کنید:\n• ✅ اتمام آپلود\n• 📋 نمایش لیست\n• ❌ لغو کل آپلود`, env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  // ─── admin:btn:delete:buttonId ───
  if (data.startsWith("admin:btn:delete:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT name FROM buttons WHERE id = ?", [buttonId]);
    if (!b) { await answerCb(callback.id, env, "❌ دکمه پیدا نشد.", true); return; }
    await setState(userId, "delete_confirm", { button_id: buttonId }, env);
    await sendMsg(chatId, `⚠️ آیا از حذف '<b>${b.name}</b>' و تمام زیرمجموعه‌ها مطمئنید؟\n\nبرای تایید، عبارت زیر را ارسال کنید:\n<code>حذف</code>`, env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── admin:btn:sessions:buttonId ───
  if (data.startsWith("admin:btn:sessions:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT id FROM buttons WHERE id = ?", [buttonId]);
    if (!b) { await answerCb(callback.id, env, "❌ دکمه یافت نشد.", true); return; }
    const startIdx = await getNextSessionIndex(env, buttonId);
    const path = await getButtonPath(env, buttonId);
    await setState(userId, "session_batch_count", { button_id: buttonId, button_path: path, next_index: startIdx }, env);
    await sendMsg(chatId, `🧩 <b>ایجاد جلسه‌های خودکار</b>\n\nمسیر مقصد: <b>${path}</b>\nشماره جلسه بعدی: <b>${String(startIdx).padStart(2, "0")}</b>\n\nتعداد جلسه جدید را ارسال کنید (۱ تا ۵۰۰).\nمثال: <code>30</code>\nبرای لغو: <code>لغو</code>`, env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── admin:btn:archivepush:buttonId ───
  if (data.startsWith("admin:btn:archivepush:")) {
    const buttonId = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const archiveRef = await dbFirst(env, "SELECT value FROM settings WHERE key = 'archive_channel_id'");
    if (!archiveRef || !archiveRef.value) {
      await answerCb(callback.id, env, "❌ کانال آرشیو تنظیم نشده است.", true);
      return;
    }
    const contents = await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [buttonId]);
    const count = contents[0] ? contents[0].c : 0;
    if (count === 0) {
      await answerCb(callback.id, env, "❌ این دکمه محتوایی ندارد.", true);
      return;
    }
    const path = await getButtonPath(env, buttonId);
    await sendMsg(chatId, `📦 <b>انتقال به کانال آرشیو</b>\n\nمسیر: <b>${path}</b>\nتعداد محتوا: <b>${count}</b>\n\n⚠️ انتقال محتوا به کانال آرشیو نیاز به ارسال فایل‌ها دارد. این قابلیت در نسخه بعدی فعال خواهد شد.`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── admin:smartarchive:menu ───
  if (data === "admin:smartarchive:menu") {
    await answerCb(callback.id, env);
    const allButtons = await dbAll(env, "SELECT id, is_active, upload_completed FROM buttons WHERE id != 0");
    const completed = allButtons.filter(b => b.upload_completed);
    const incomplete = allButtons.filter(b => !b.upload_completed);
    const withContent = (await dbAll(env, "SELECT button_id FROM button_contents GROUP BY button_id")).length;
    await safeEditMsg(chatId, msgId, `🧠 <b>آرشیو هوشمند</b>\n\nکل دکمه‌ها: <b>${allButtons.length}</b>\nاتمام آپلود: <b>${completed.length}</b>\nاتمام‌نشده: <b>${incomplete.length}</b>\nدکمه‌های دارای محتوا: <b>${withContent}</b>\n\n⚠️ این بخش نیاز به تنظیم کانال آرشیو دارد.`, env, {
      reply_markup: { inline_keyboard: [
        [{ text: "🔄 بروزرسانی", callback_data: "admin:smartarchive:menu" }],
        [{ text: "🔙 بازگشت", callback_data: "admin:panel" }],
      ] },
    });
    return;
  }

  // ─── admin:broadcast:start ───
  if (data === "admin:broadcast:start") {
    await answerCb(callback.id, env);
    await setState(userId, "broadcast_wait", {}, env);
    await sendMsg(chatId, "📣 محتوای پیام همگانی را ارسال کنید (هر نوع پیام).", env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── admin:broadcast:confirm ───
  if (data === "admin:broadcast:confirm") {
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (!st || st.state !== "broadcast_confirm") {
      await sendMsg(chatId, "❌ داده‌ای یافت نشد.", env);
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
          await sendMsg(u.user_id, `📣 <b>پیام از مدیریت:</b>\n\n${payload.text || ""}`, env);
        } else if (payload.kind === "photo") {
          await tg("sendPhoto", { chat_id: u.user_id, photo: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
        } else if (payload.kind === "video") {
          await tg("sendVideo", { chat_id: u.user_id, video: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
        } else if (payload.kind === "document") {
          await tg("sendDocument", { chat_id: u.user_id, document: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
        } else if (payload.kind === "audio") {
          await tg("sendAudio", { chat_id: u.user_id, audio: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
        } else if (payload.kind === "voice") {
          await tg("sendVoice", { chat_id: u.user_id, voice: payload.file_id, caption: payload.text || "" }, env);
        } else if (payload.kind === "sticker") {
          await tg("sendSticker", { chat_id: u.user_id, sticker: payload.file_id }, env);
        } else if (payload.kind === "animation") {
          await tg("sendAnimation", { chat_id: u.user_id, animation: payload.file_id, caption: payload.text || "" }, env);
        }
        ok++;
      } catch (e) { fail++; }
    }
    await sendMsg(chatId, `✅ پایان ارسال.\n✅ موفق: ${ok}\n❌ ناموفق: ${fail}`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── admin:broadcast:cancel ───
  if (data === "admin:broadcast:cancel") {
    await answerCb(callback.id, env);
    await clearState(userId, env);
    await sendMsg(chatId, "❌ پیام همگانی لغو شد.", env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── admin:ban:menu ───
  if (data === "admin:ban:menu") {
    await answerCb(callback.id, env);
    await setState(userId, "ban_menu", {}, env);
    const blocked = await dbAll(env, "SELECT user_id FROM users WHERE blocked = 1 LIMIT 20");
    const blockedIds = blocked.map(b => b.user_id).join(", ") || "---";
    await safeEditMsg(chatId, msgId, `🚫 <b>بن/آزادسازی</b>\n\nآیدی عددی کاربر را ارسال کنید تا بن/آزاد شود.\n\nلیست کاربران بن شده:\n<code>${blockedIds}</code>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── admin:forcejoin:menu ───
  if (data === "admin:forcejoin:menu") {
    await answerCb(callback.id, env);
    await setState(userId, "forcejoin_menu", {}, env);
    const channels = await dbAll(env, "SELECT channel FROM forced_channels");
    const chList = channels.map(c => `• ${c.channel}`).join("\n") || "هیچ کانالی تنظیم نشده";
    await safeEditMsg(chatId, msgId, `📌 <b>عضویت اجباری</b>\n\nکانال‌های فعلی:\n${chList}\n\nبرای افزودن: لینک یا @username یا آیدی کانال را ارسال کنید.\nبرای حذف: عبارت <code>حذف</code> سپس یک فاصله و بعد کانال را ارسال کنید.\nمثال: <code>حذف @mychannel</code>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── admin:archive:menu ───
  if (data === "admin:archive:menu") {
    await answerCb(callback.id, env);
    const cur = await dbFirst(env, "SELECT value FROM settings WHERE key = 'archive_channel_id'");
    const curVal = (cur && cur.value) ? cur.value : "غیرفعال";
    await setState(userId, "archive_menu", {}, env);
    await safeEditMsg(chatId, msgId, `🗄️ <b>کانال آرشیو محتوا</b>\n\nوضعیت فعلی: <b>${curVal}</b>\n\nبرای تنظیم: یکی از این فرمت‌ها را ارسال کنید:\n• <code>-100xxxxxxxxxx</code>\n• <code>@channel_username</code>\n• <code>https://t.me/channel_username</code>\n\nبرای غیرفعال کردن: <code>off</code> یا <code>حذف</code>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── admin:backup:menu ───
  if (data === "admin:backup:menu") {
    await answerCb(callback.id, env);
    const backupRef = await dbFirst(env, "SELECT value FROM settings WHERE key = 'backup_chat_ref'");
    const backupVal = (backupRef && backupRef.value) ? backupRef.value : "غیرفعال";
    await safeEditMsg(chatId, msgId, `🗃️ <b>بکاپ و بازیابی</b>\n\nوضعیت فعلی: <b>${backupVal}</b>\n\n⚠️ بکاپ خودکار در محیط Cloudflare Worker پشتیبانی نمی‌شود.\nبرای تنظیم مقصد بکاپ، آیدی کانال را ارسال کنید.`, env, {
      reply_markup: { inline_keyboard: [
        [{ text: "⚙️ تنظیم مقصد بکاپ", callback_data: "admin:backup:setchat" }],
        [{ text: "🔙 بازگشت", callback_data: "admin:panel" }],
      ] },
    });
    return;
  }

  // ─── admin:backup:setchat ───
  if (data === "admin:backup:setchat") {
    await answerCb(callback.id, env);
    await setState(userId, "backup_set_chat", {}, env);
    await sendMsg(chatId, `📍 مقصد بکاپ را ارسال کنید.\nفرمت مجاز:\n• <code>-1001234567890</code>\n• <code>@channel_username</code>\n• <code>https://t.me/channel_username</code>\nبرای غیرفعال‌کردن: <code>off</code> یا <code>حذف</code>`, env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── admin:stats ───
  if (data === "admin:stats") {
    await answerCb(callback.id, env);
    const usersTotal = await dbFirst(env, "SELECT COUNT(*) as c FROM users");
    const usersActive = await dbFirst(env, "SELECT COUNT(*) as c FROM users WHERE blocked = 0");
    const usersBlocked = await dbFirst(env, "SELECT COUNT(*) as c FROM users WHERE blocked = 1");
    const btnsTotal = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0");
    const btnsActive = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0 AND is_active = 1");
    const btnsInactive = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0 AND is_active = 0");
    const contentsTotal = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents");
    const btnsWithContent = await dbFirst(env, "SELECT COUNT(DISTINCT button_id) as c FROM button_contents");

    const statsText = `📊 <b>آمار کلی سیستم</b>\n\n` +
      `👥 کل کاربران: <b>${usersTotal ? usersTotal.c : 0}</b>\n` +
      `✅ کاربران فعال: <b>${usersActive ? usersActive.c : 0}</b>\n` +
      `🚫 کاربران بن شده: <b>${usersBlocked ? usersBlocked.c : 0}</b>\n\n` +
      `🔘 کل دکمه‌ها: <b>${btnsTotal ? btnsTotal.c : 0}</b>\n` +
      `🟢 دکمه‌های فعال: <b>${btnsActive ? btnsActive.c : 0}</b>\n` +
      `🔴 دکمه‌های غیرفعال: <b>${btnsInactive ? btnsInactive.c : 0}</b>\n` +
      `📂 دکمه‌های دارای محتوا: <b>${btnsWithContent ? btnsWithContent.c : 0}</b>\n\n` +
      `📎 کل آیتم‌های محتوا: <b>${contentsTotal ? contentsTotal.c : 0}</b>`;

    await safeEditMsg(chatId, msgId, statsText, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── upload finish (inline confirm) ───
  if (data === "admin:upload:finish") {
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (!st || st.state !== "upload_confirm") {
      await sendMsg(chatId, "❌ حالت آپلود فعال نیست.", env);
      return;
    }
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    if (pending.length === 0) {
      await clearState(userId, env);
      await sendMsg(chatId, "❌ هیچ محتوایی برای ذخیره وجود ندارد.", env, { reply_markup: removeKeyboard() });
      return;
    }
    const result = await savePendingContents(env, buttonId, pending);
    await clearState(userId, env);
    await sendMsg(chatId, `✅ ذخیره نهایی انجام شد.\nموفق: ${result.success}\nناموفق: ${result.fail}`, env, { reply_markup: removeKeyboard() });
    return;
  }

  // ─── upload continue (inline) ───
  if (data === "admin:upload:continue") {
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (!st || st.state !== "upload_confirm") {
      await sendMsg(chatId, "❌ حالت آپلود فعال نیست.", env);
      return;
    }
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    await setState(userId, "upload_content", { button_id: buttonId, pending_files: pending }, env);
    await sendMsg(chatId, "↩️ به حالت آپلود برگشتید.\nادامه دهید و محتوای بعدی را ارسال کنید.", env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  // ─── upload cancel (inline) ───
  if (data === "admin:upload:cancel") {
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (st && (st.state === "upload_content" || st.state === "upload_confirm")) {
      const pending = st.data.pending_files || [];
      await clearState(userId, env);
      await sendMsg(chatId, `❌ آپلود لغو شد.\n${pending.length} مورد موقت حذف شد.`, env, { reply_markup: removeKeyboard() });
    } else {
      await sendMsg(chatId, "ℹ️ در حال حاضر آپلود فعالی ندارید.", env);
    }
    return;
  }
}

// ═══════ CONTENT DISPLAY ═══════

async function showContentRoot(chatId, env, editMsgId) {
  const buttons = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = 0 AND is_active = 1 ORDER BY order_index");
  const children = buttons.filter(b => Number(b.id) !== 0);
  if (children.length === 0) {
    if (editMsgId) {
      await safeEditMsg(chatId, editMsgId, "📂 هنوز محتوایی وجود ندارد.", env);
    } else {
      await sendMsg(chatId, "📂 هنوز محتوایی وجود ندارد.", env);
    }
    return;
  }
  const rows = [];
  for (const b of children) {
    rows.push([{ text: b.name, callback_data: `content:open:${b.id}` }]);
  }
  rows.push([{ text: "🏠 منوی اصلی", callback_data: "back_main" }]);
  const kb = { inline_keyboard: rows };

  if (editMsgId) {
    await safeEditMsg(chatId, editMsgId, "📚 <b>بخش محتوای آموزشی</b>\n\nیک گزینه را انتخاب کنید:", env, { reply_markup: kb });
  } else {
    await sendMsg(chatId, "📚 <b>بخش محتوای آموزشی</b>\n\nیک گزینه را انتخاب کنید:", env, { reply_markup: kb });
  }
}

async function showContentFolder(chatId, parentId, env, editMsgId) {
  const children = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = ? AND is_active = 1 ORDER BY order_index", [parentId]);
  const contents = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [parentId]);
  const btn = await dbFirst(env, "SELECT name FROM buttons WHERE id = ?", [parentId]);
  const title = btn ? `📁 <b>${btn.name}</b>` : "📁 منو";

  const rows = [];
  if (contents.length > 0) {
    rows.push([{ text: `📎 ${contents.length} محتوا`, callback_data: `content:open:${parentId}` }]);
  }
  for (const b of children) {
    rows.push([{ text: b.name, callback_data: `content:open:${b.id}` }]);
  }
  rows.push([
    { text: "🔙 بازگشت", callback_data: `content:back:${parentId}` },
    { text: "🏠 منوی اصلی", callback_data: "back_main" },
  ]);
  const kb = { inline_keyboard: rows };

  if (editMsgId) {
    await safeEditMsg(chatId, editMsgId, title + "\n\nیک گزینه را انتخاب کنید:", env, { reply_markup: kb });
  } else {
    await sendMsg(chatId, title + "\n\nیک گزینه را انتخاب کنید:", env, { reply_markup: kb });
  }
}

async function sendContentItem(chatId, item, env) {
  const { content_kind, content_text, content_file_id } = item;
  const extra = {};
  if (content_text) extra.caption = content_text;

  switch (content_kind) {
    case "text": await sendMsg(chatId, content_text || "📝", env); break;
    case "photo": await tg("sendPhoto", { chat_id: chatId, photo: content_file_id, ...extra }, env); break;
    case "video": await tg("sendVideo", { chat_id: chatId, video: content_file_id, ...extra }, env); break;
    case "document": await tg("sendDocument", { chat_id: chatId, document: content_file_id, ...extra }, env); break;
    case "audio": await tg("sendAudio", { chat_id: chatId, audio: content_file_id, ...extra }, env); break;
    case "voice": await tg("sendVoice", { chat_id: chatId, voice: content_file_id, ...extra }, env); break;
    case "sticker": await tg("sendSticker", { chat_id: chatId, sticker: content_file_id }, env); break;
    case "animation": await tg("sendAnimation", { chat_id: chatId, animation: content_file_id, ...extra }, env); break;
  }
}
