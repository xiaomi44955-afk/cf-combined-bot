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
  try { return await tg("editMessageText", body, env); }
  catch (e) { if (String(e).includes("not modified")) return { ok: false }; throw e; }
}

async function safeEditMsg(chatId, msgId, text, env, extra = {}) {
  try { return await editMsg(chatId, msgId, text, env, extra); } catch (e) { return { ok: false }; }
}

async function answerCb(cbId, env, text = "", showAlert = false) {
  return tg("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: showAlert });
}

// ═══════ D1 HELPERS ═══════

async function dbRun(env, sql, params = []) { return env.BOT_DB.prepare(sql).bind(...params).run(); }
async function dbFirst(env, sql, params = []) { return (await env.BOT_DB.prepare(sql).bind(...params).first()) || null; }
async function dbAll(env, sql, params = []) { const { results } = await env.BOT_DB.prepare(sql).bind(...params).all(); return results || []; }

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
  for (const s of t) { try { await dbRun(env, s); } catch (e) { /* ignore */ } }
  try { await dbRun(env, "ALTER TABLE buttons ADD COLUMN upload_completed INTEGER DEFAULT 0"); } catch (e) { /* already exists */ }
}

// ═══════ ADMIN CHECK ═══════

function isAdmin(userId, env) {
  const main = String(env.MAIN_ADMIN_ID || "");
  if (main && String(userId) === main) return true;
  if (env.ADMIN_IDS) { const ids = env.ADMIN_IDS.split(",").map(s => s.trim()); if (ids.includes(String(userId))) return true; }
  return false;
}

function isOwner(userId, env) { const main = String(env.MAIN_ADMIN_ID || ""); return main && String(userId) === main; }

// ═══════ USER STATE ═══════

async function getState(userId, env) { return await dbFirst(env, "SELECT state, data FROM user_states WHERE user_id = ?", [userId]); }
async function setState(userId, state, data, env) {
  await dbRun(env, "INSERT INTO user_states (user_id, state, data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data", [userId, state, JSON.stringify(data || {})]);
}
async function clearState(userId, env) { await dbRun(env, "DELETE FROM user_states WHERE user_id = ?", [userId]); }

// ═══════ KEYBOARDS ═══════

function mainKeyboard() {
  return { keyboard: [[{ text: "📚 محتوای آموزشی" }, { text: "📨 ارسال پیام" }]], resize_keyboard: true };
}

function msgTypeKeyboard() {
  return { keyboard: [[{ text: "💌 پیام ناشناس" }, { text: "🫶🏻 پیام عادی" }], [{ text: "🔙 بازگشت" }]], resize_keyboard: true };
}

function cancelKeyboard() { return { keyboard: [[{ text: "لغو" }]], resize_keyboard: true }; }
function removeKeyboard() { return { remove_keyboard: true }; }

function adminPanelKeyboard() {
  return { inline_keyboard: [
    [{ text: "➕ افزودن دکمه اصلی", callback_data: "admin:btn:add:0" }, { text: "📋 مدیریت دکمه‌ها", callback_data: "admin:btn:manage:0" }],
    [{ text: "🧠 آرشیو هوشمند", callback_data: "admin:smartarchive:menu" }, { text: "📣 پیام همگانی", callback_data: "admin:broadcast:start" }],
    [{ text: "🚫 بن/آزادسازی کاربر", callback_data: "admin:ban:menu" }, { text: "📌 عضویت اجباری", callback_data: "admin:forcejoin:menu" }],
    [{ text: "🗄️ کانال آرشیو محتوا", callback_data: "admin:archive:menu" }, { text: "🗃️ بکاپ و بازیابی", callback_data: "admin:backup:menu" }],
    [{ text: "📊 آمار کلی", callback_data: "admin:stats" }],
    [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }],
  ] };
}

function adminManageButtonsKeyboard(buttons, parentId, parentParentId) {
  const flat = [];
  for (const b of buttons) {
    if (Number(b.id) === 0) continue;
    flat.push({ text: `${b.is_active ? "✅" : "⛔️"} ${b.name}`, callback_data: `admin:btn:edit:${b.id}` });
  }
  const chunked = [];
  for (let i = 0; i < flat.length; i += 2) chunked.push(flat.slice(i, i + 2));
  chunked.push([{ text: "➕ افزودن زیرمجموعه", callback_data: `admin:btn:add:${parentId}` }]);
  chunked.push([{ text: "🔙 بازگشت", callback_data: Number(parentId) === 0 ? "admin:panel" : `admin:btn:manage:${Number(parentParentId || 0)}` }]);
  chunked.push([{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]);
  return { inline_keyboard: chunked };
}

function adminEditButtonKeyboard(buttonId, parentId, isActive, isProtected, isUploadCompleted) {
  const toggleText = isActive ? "🔴 غیرفعال کن" : "🟢 فعال کن";
  const protectText = isProtected ? "🔒 خصوصی روشن" : "🔓 خصوصی خاموش";
  const uploadDoneText = isUploadCompleted ? "🟢 اتمام آپلود" : "🔴 اتمام آپلود";
  const core = [
    [{ text: "✏️ تغییر نام", callback_data: `admin:btn:rename:${buttonId}` }],
    [{ text: "📤 آپلود محتوا", callback_data: `admin:btn:append:${buttonId}` }],
    [{ text: uploadDoneText, callback_data: `admin:btn:uploaddone:${buttonId}` }],
    [{ text: "📦 انتقال به چنل آرشیو", callback_data: `admin:btn:archivepush:${buttonId}` }],
    [{ text: protectText, callback_data: `admin:btn:protect:${buttonId}` }],
    [{ text: "🧩 ایجاد جلسه", callback_data: `admin:btn:sessions:${buttonId}` }],
    [{ text: "📁 مدیریت زیردکمه‌ها", callback_data: `admin:btn:manage:${buttonId}` }],
    [{ text: toggleText, callback_data: `admin:btn:toggle:${buttonId}` }],
    [{ text: "🗑️ حذف دکمه", callback_data: `admin:btn:delete:${buttonId}` }],
  ];
  const flat = core.flat();
  const chunked = [];
  for (let i = 0; i < flat.length; i += 2) chunked.push(flat.slice(i, i + 2));
  chunked.push([{ text: "🔙 بازگشت", callback_data: `admin:btn:manage:${parentId}` }]);
  chunked.push([{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]);
  return { inline_keyboard: chunked };
}

function adminUploadReplyKeyboard() {
  return { keyboard: [[{ text: "✅ اتمام آپلود" }, { text: "📋 نمایش لیست" }], [{ text: "❌ لغو کل آپلود" }]], resize_keyboard: true, one_time_keyboard: false };
}

function broadcastConfirmKeyboard() {
  return { inline_keyboard: [[{ text: "✅ ارسال کن", callback_data: "admin:broadcast:confirm" }], [{ text: "❌ لغو", callback_data: "admin:broadcast:cancel" }]] };
}

function backToPanelKeyboard() { return { inline_keyboard: [[{ text: "🔙 بازگشت به پنل", callback_data: "admin:panel" }]] }; }

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
    const k = shortKind(item.kind);
    const cap = (item.text || "").replace(/\n/g, " ").trim();
    return `${i + 1}. ${k}${cap ? " | " + cap.substring(0, 50) + (cap.length > 50 ? "…" : "") : ""}`;
  });
  if (pending.length > 30) lines.push(`… و ${pending.length - 30} مورد دیگر`);
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
  if (success > 0) { try { await dbRun(env, "UPDATE buttons SET upload_completed = 0 WHERE id = ?", [buttonId]); } catch (e) { /* ok */ } }
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
  for (const child of children) await deleteButtonTree(env, child.id);
  await dbRun(env, "DELETE FROM button_contents WHERE button_id = ?", [buttonId]);
  await dbRun(env, "DELETE FROM buttons WHERE id = ?", [buttonId]);
}

async function getNextSessionIndex(env, parentId) {
  const children = await dbAll(env, "SELECT name FROM buttons WHERE parent_id = ?", [parentId]);
  let maxIdx = -1;
  const re = /جلسه\s*:\s*([0-9]+)/;
  for (const ch of children) { const m = (ch.name || "").match(re); if (m) { const v = parseInt(m[1], 10); if (v > maxIdx) maxIdx = v; } }
  return maxIdx >= 0 ? maxIdx + 1 : children.length;
}

function sessionNameForIndex(idx) {
  const emojis = ["🔸", "🔹", "🔺"];
  return `${emojis[(Math.floor(idx / 3)) % emojis.length]} جلسه : ${String(idx).padStart(2, "0")} ${emojis[(Math.floor(idx / 3)) % emojis.length]}`;
}

// ═══════ MESSAGE HANDLER ═══════

async function handleMessage(message, env) {
  await ensureTables(env);
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text || "";

  await dbRun(env, "INSERT INTO users (user_id, username, first_name, last_name) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name",
    [userId, message.from.username || "", message.from.first_name || "", message.from.last_name || ""]);

  const user = await dbFirst(env, "SELECT blocked FROM users WHERE user_id = ?", [userId]);
  if (user && user.blocked) return;

  if (env.MAIN_ADMIN_ID) {
    await dbRun(env, "INSERT INTO admins (user_id, role) VALUES (?, 'owner') ON CONFLICT(user_id) DO UPDATE SET role=excluded.role", [parseInt(env.MAIN_ADMIN_ID)]);
  }

  // /start
  if (text === "/start") { await clearState(userId, env); await sendMsg(chatId, welcomeText(), env, { reply_markup: mainKeyboard() }); return; }

  // /admin
  if (text === "/admin") {
    if (!isAdmin(userId, env)) { await sendMsg(chatId, "❌ دسترسی ندارید.", env); return; }
    await clearState(userId, env);
    await sendMsg(chatId, `👨‍💼 <b>پنل مدیریت</b>\n👤 نقش شما: <b>${isOwner(userId, env) ? "owner" : "admin"}</b>\n\nیکی از گزینه‌ها را انتخاب کنید:`, env, { reply_markup: adminPanelKeyboard() });
    return;
  }

  // /cancel
  if (text === "/cancel" || text === "لغو") { await clearState(userId, env); await sendMsg(chatId, "❌ لغو شد.", env, { reply_markup: mainKeyboard() }); return; }

  const st = await getState(userId, env);

  // ─── STATE: add_button ───
  if (st && st.state === "add_button") {
    if (!isAdmin(userId, env)) return;
    if (!text) { await sendMsg(chatId, "❌ فقط متن (نام دکمه) ارسال کنید.", env); return; }
    const name = text.trim();
    const pid = (st.data.parent_id && Number(st.data.parent_id) > 0) ? Number(st.data.parent_id) : 0;
    if (pid > 0) { const p = await dbFirst(env, "SELECT id FROM buttons WHERE id = ?", [pid]); if (!p) { await clearState(userId, env); await sendMsg(chatId, "⚠️ مسیر والد نامعتبر.", env, { reply_markup: backToPanelKeyboard() }); return; } }
    const order = (await dbFirst(env, "SELECT COALESCE(MAX(order_index),0)+1 as n FROM buttons WHERE parent_id=?", [pid]));
    await dbRun(env, "INSERT INTO buttons (parent_id, name, order_index) VALUES (?, ?, ?)", [pid, name, order ? order.n : 0]);
    await clearState(userId, env);
    await sendMsg(chatId, `✅ دکمه «${name}» اضافه شد.`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── STATE: rename_button ───
  if (st && st.state === "rename_button") {
    if (!isAdmin(userId, env)) return;
    if (!text) { await sendMsg(chatId, "❌ فقط متن ارسال کنید.", env); return; }
    await dbRun(env, "UPDATE buttons SET name = ? WHERE id = ?", [text.trim(), st.data.button_id]);
    await clearState(userId, env);
    await sendMsg(chatId, "✅ نام دکمه تغییر کرد.", env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── STATE: delete_confirm ───
  if (st && st.state === "delete_confirm") {
    if (!isAdmin(userId, env)) return;
    if (!text || text.trim() !== "حذف") { await sendMsg(chatId, "❌ برای حذف عبارت <code>حذف</code> را ارسال کنید.", env); return; }
    await deleteButtonTree(env, st.data.button_id);
    await clearState(userId, env);
    await sendMsg(chatId, "✅ دکمه و زیرمجموعه‌ها حذف شدند.", env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── STATE: upload_content ───
  if (st && st.state === "upload_content") {
    if (!isAdmin(userId, env)) return;
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    const trimmed = text.trim();

    if (trimmed === "✅ اتمام آپلود") {
      if (pending.length === 0) { await sendMsg(chatId, "❌ هنوز هیچ محتوایی آپلود نشده است.", env, { reply_markup: adminUploadReplyKeyboard() }); return; }
      await setState(userId, "upload_confirm", { button_id: buttonId, pending_files: pending }, env);
      await sendMsg(chatId, `⚠️ آماده ثبت نهایی ${pending.length} مورد هستید؟\nبا تایید نهایی ذخیره می‌شود؛ با انصراف همه موارد موقت حذف می‌شود.`, env, { reply_markup: { keyboard: [[{ text: "✅ تایید نهایی" }], [{ text: "↩️ بازگشت به آپلود" }, { text: "❌ انصراف و حذف لیست" }]], resize_keyboard: true } });
      return;
    }
    if (trimmed === "📋 نمایش لیست") { await sendMsg(chatId, buildUploadListText(pending), env, { reply_markup: adminUploadReplyKeyboard() }); return; }
    if (trimmed === "❌ لغو کل آپلود") { await clearState(userId, env); await sendMsg(chatId, `❌ آپلود لغو شد و ${pending.length} مورد ذخیره‌نشده حذف شد.`, env, { reply_markup: removeKeyboard() }); return; }

    let kind = "text", fileId = null, contentText = "";
    if (message.photo) { kind = "photo"; fileId = message.photo[message.photo.length - 1].file_id; contentText = message.caption || ""; }
    else if (message.video) { kind = "video"; fileId = message.video.file_id; contentText = message.caption || ""; }
    else if (message.document) { kind = "document"; fileId = message.document.file_id; contentText = message.caption || ""; }
    else if (message.audio) { kind = "audio"; fileId = message.audio.file_id; contentText = message.caption || ""; }
    else if (message.voice) { kind = "voice"; fileId = message.voice.file_id; contentText = message.caption || ""; }
    else if (message.sticker) { kind = "sticker"; fileId = message.sticker.file_id; }
    else if (message.animation) { kind = "animation"; fileId = message.animation.file_id; contentText = message.caption || ""; }
    else if (message.text) { kind = "text"; contentText = text; }
    else { await sendMsg(chatId, "❌ این نوع پیام پشتیبانی نمی‌شود.", env, { reply_markup: adminUploadReplyKeyboard() }); return; }

    pending.push({ kind, text: contentText, file_id: fileId });
    await setState(userId, "upload_content", { button_id: buttonId, pending_files: pending }, env);
    await sendMsg(chatId, `✅ دریافت شد. تعداد موارد موقت: ${pending.length}`, env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  // ─── STATE: upload_confirm ───
  if (st && st.state === "upload_confirm") {
    if (!isAdmin(userId, env)) return;
    const buttonId = st.data.button_id;
    const pending = st.data.pending_files || [];
    const trimmed = text.trim();
    if (trimmed === "✅ تایید نهایی") {
      if (pending.length === 0) { await clearState(userId, env); await sendMsg(chatId, "❌ لیست خالی است.", env, { reply_markup: removeKeyboard() }); return; }
      const r = await savePendingContents(env, buttonId, pending);
      await clearState(userId, env);
      await sendMsg(chatId, `✅ ذخیره نهایی انجام شد.\nموفق: ${r.success}\nناموفق: ${r.fail}`, env, { reply_markup: removeKeyboard() });
      return;
    }
    if (trimmed === "↩️ بازگشت به آپلود") { await setState(userId, "upload_content", { button_id: buttonId, pending_files: pending }, env); await sendMsg(chatId, "↩️ به حالت آپلود برگشتید.", env, { reply_markup: adminUploadReplyKeyboard() }); return; }
    if (trimmed === "❌ انصراف و حذف لیست") { await clearState(userId, env); await sendMsg(chatId, `❌ عملیات لغو شد و ${pending.length} مورد موقت حذف شد.`, env, { reply_markup: removeKeyboard() }); return; }
    await sendMsg(chatId, "⚠️ از دکمه‌های پایین برای تایید یا لغو استفاده کنید.", env, { reply_markup: { keyboard: [[{ text: "✅ تایید نهایی" }], [{ text: "↩️ بازگشت به آپلود" }, { text: "❌ انصراف و حذف لیست" }]], resize_keyboard: true } });
    return;
  }

  // ─── STATE: broadcast_wait ───
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

  // ─── STATE: broadcast_confirm ───
  if (st && st.state === "broadcast_confirm") {
    if (!isAdmin(userId, env)) return;
    await sendMsg(chatId, "⚠️ از دکمه‌های زیر استفاده کنید.", env, { reply_markup: broadcastConfirmKeyboard() });
    return;
  }

  // ─── STATE: admin_reply ───
  if (st && st.state === "admin_reply") {
    if (!isAdmin(userId, env)) return;
    const target = st.data.target, mode = st.data.mode;
    await clearState(userId, env);
    await sendMsg(target, `${mode === "anon" ? "🎭" : "📨"} <b>پاسخ از طرف پشتیبانی:</b>\n\n${text}`, env);
    await sendMsg(chatId, "✅ پاسخ ارسال شد.", env);
    return;
  }

  // ─── STATE: ban_menu ───
  if (st && st.state === "ban_menu") {
    if (!isAdmin(userId, env)) return;
    if (!text) { await sendMsg(chatId, "❌ آیدی عددی را ارسال کنید.", env); return; }
    let target; try { target = parseInt(text.trim()); } catch (e) { await sendMsg(chatId, "❌ آیدی نامعتبر.", env); return; }
    if (!target) { await sendMsg(chatId, "❌ آیدی نامعتبر.", env); return; }
    const row = await dbFirst(env, "SELECT blocked FROM users WHERE user_id = ?", [target]);
    const nowBlocked = !(row && row.blocked);
    if (!row) await dbRun(env, "INSERT INTO users (user_id, blocked) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET blocked=excluded.blocked", [target, nowBlocked ? 1 : 0]);
    else await dbRun(env, "UPDATE users SET blocked = ? WHERE user_id = ?", [nowBlocked ? 1 : 0, target]);
    await sendMsg(chatId, `✅ انجام شد: ${nowBlocked ? "بن شد." : "آزاد شد."}`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── STATE: forcejoin_menu ───
  if (st && st.state === "forcejoin_menu") {
    if (!isAdmin(userId, env) || !text) return;
    const t = text.trim();
    if (t.toLowerCase().startsWith("حذف ")) { const ch = t.split(" ", 1)[1].trim(); try { await dbRun(env, "DELETE FROM forced_channels WHERE channel = ?", [ch]); } catch (e) { /* ok */ } await sendMsg(chatId, "✅ حذف شد.", env, { reply_markup: backToPanelKeyboard() }); }
    else { try { await dbRun(env, "INSERT INTO forced_channels (channel) VALUES (?)", [t]); } catch (e) { /* dup */ } await sendMsg(chatId, "✅ اضافه شد.", env, { reply_markup: backToPanelKeyboard() }); }
    return;
  }

  // ─── STATE: archive_menu ───
  if (st && st.state === "archive_menu") {
    if (!isAdmin(userId, env) || !text) return;
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

  // ─── STATE: backup_set_chat ───
  if (st && st.state === "backup_set_chat") {
    if (!isAdmin(userId, env) || !text) return;
    const raw = text.trim();
    if (["off", "none", "null", "disable", "remove", "del", "حذف", "خاموش"].includes(raw.toLowerCase())) {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('backup_chat_ref', '') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      await clearState(userId, env); await sendMsg(chatId, "✅ مقصد بکاپ غیرفعال شد.", env, { reply_markup: backToPanelKeyboard() });
    } else {
      await dbRun(env, "INSERT INTO settings (key, value) VALUES ('backup_chat_ref', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [raw]);
      await clearState(userId, env); await sendMsg(chatId, `✅ مقصد بکاپ ثبت شد: <code>${raw}</code>`, env, { reply_markup: backToPanelKeyboard() });
    }
    return;
  }

  // ─── STATE: session_batch_count ───
  if (st && st.state === "session_batch_count") {
    if (!isAdmin(userId, env)) return;
    const raw = text.trim();
    if (raw === "لغو") { await clearState(userId, env); await sendMsg(chatId, "❌ لغو شد.", env); return; }
    let count; try { count = parseInt(raw); } catch (e) { count = null; }
    if (!count || count < 1 || count > 500) { await sendMsg(chatId, "❌ تعداد نامعتبر. عدد ۱ تا ۵۰۰ ارسال کنید.\nلغو: <code>لغو</code>", env); return; }
    const startIdx = await getNextSessionIndex(env, st.data.button_id);
    const endIdx = startIdx + count - 1;
    await setState(userId, "session_batch_confirm", { button_id: st.data.button_id, count, start_index: startIdx, end_index: endIdx }, env);
    const path = await getButtonPath(env, st.data.button_id);
    await sendMsg(chatId, `⚠️ <b>تایید ایجاد جلسه</b>\n\nمسیر: <b>${path}</b>\nتعداد: <b>${count}</b>\nبازه: <b>${String(startIdx).padStart(2, "0")}</b> تا <b>${String(endIdx).padStart(2, "0")}</b>\n\n<code>تایید</code> یا <code>لغو</code>`, env);
    return;
  }

  // ─── STATE: session_batch_confirm ───
  if (st && st.state === "session_batch_confirm") {
    if (!isAdmin(userId, env)) return;
    const raw = text.trim();
    if (raw === "لغو") { await clearState(userId, env); await sendMsg(chatId, "❌ لغو شد.", env); return; }
    if (raw !== "تایید") { await sendMsg(chatId, "<code>تایید</code> یا <code>لغو</code>", env); return; }
    const buttonId = st.data.button_id, count = st.data.count;
    const startIdx = await getNextSessionIndex(env, buttonId);
    let created = 0, failed = 0;
    for (let idx = startIdx; idx < startIdx + count; idx++) {
      try { const o = (await dbFirst(env, "SELECT COALESCE(MAX(order_index),0)+1 as n FROM buttons WHERE parent_id=?", [buttonId])); await dbRun(env, "INSERT INTO buttons (parent_id, name, order_index) VALUES (?, ?, ?)", [buttonId, sessionNameForIndex(idx), o ? o.n : 0]); created++; } catch (e) { failed++; }
    }
    await clearState(userId, env);
    await sendMsg(chatId, `✅ ایجاد شد: <b>${created}</b>\nبازه: <b>${String(startIdx).padStart(2, "0")}</b>-<b>${String(startIdx + created - 1).padStart(2, "0")}</b>\nناموفق: <b>${failed}</b>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  // ─── USER: "ارسال پیام" ───
  if (text === "📨 ارسال پیام") { await clearState(userId, env); await sendMsg(chatId, "یکی از حالت‌ها را انتخاب کنید:", env, { reply_markup: msgTypeKeyboard() }); return; }

  // ─── USER: "پیام ناشناس" ───
  if (text === "💌 پیام ناشناس") { await setState(userId, "waiting_anon", {}, env); await sendMsg(chatId, "📝 پیام خود را بنویسید:\n\n🔒 اطلاعات شما کاملاً مخفی خواهد بود.", env, { reply_markup: cancelKeyboard() }); return; }

  // ─── USER: "پیام عادی" ───
  if (text === "🫶🏻 پیام عادی") { await setState(userId, "waiting_normal", {}, env); await sendMsg(chatId, "📝 پیام خود را بنویسید:\n\n⚠️ اطلاعات شما برای ادمین نمایش داده می‌شود.", env, { reply_markup: cancelKeyboard() }); return; }

  // ─── USER: "محتوای آموزشی" ───
  if (text === "📚 محتوای آموزشی") { await clearState(userId, env); await showContentRoot(chatId, env); return; }

  // ─── USER: "بازگشت" ───
  if (text === "🔙 بازگشت") { await clearState(userId, env); await sendMsg(chatId, welcomeText(), env, { reply_markup: mainKeyboard() }); return; }

  // ─── USER: anonymous message ───
  if (st && st.state === "waiting_anon") {
    await clearState(userId, env);
    const adminId = parseInt(env.MAIN_ADMIN_ID);
    if (adminId) await sendMsg(adminId, `🎭 <b>پیام ناشناس جدید</b>\n\n💬 پیام:\n${text}`, env, { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "✅ پاسخ", callback_data: `reply:${userId}:anon` }], [{ text: "🚫 بلاک", callback_data: `block:${userId}` }]] }) });
    await sendMsg(chatId, "✅ پیام شما ناشناس ارسال شد.\n⏳ منتظر پاسخ باشید.", env, { reply_markup: mainKeyboard() });
    return;
  }

  // ─── USER: normal message ───
  if (st && st.state === "waiting_normal") {
    await clearState(userId, env);
    const adminId = parseInt(env.MAIN_ADMIN_ID);
    if (adminId) {
      const name = message.from.first_name || "";
      const username = message.from.username ? "@" + message.from.username : "ندارد";
      await sendMsg(adminId, `📨 <b>پیام جدید (عادی)</b>\n\n👤 نام: ${name}\n📌 یوزرنیم: ${username}\n🆔 آیدی: ${userId}\n\n💬 پیام:\n${text}`, env, { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "✅ پاسخ", callback_data: `reply:${userId}:normal` }], [{ text: "🚫 بلاک", callback_data: `block:${userId}` }]] }) });
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

  // menu:home
  if (data === "menu:home") { await clearState(userId, env); await safeEditMsg(chatId, msgId, "🏠", env); await sendMsg(chatId, welcomeText(), env, { reply_markup: mainKeyboard() }); await answerCb(callback.id, env); return; }

  // back_main
  if (data === "back_main") { await clearState(userId, env); await safeEditMsg(chatId, msgId, "🏠", env); await sendMsg(chatId, welcomeText(), env, { reply_markup: mainKeyboard() }); await answerCb(callback.id, env); return; }

  // noop
  if (data === "noop") { await answerCb(callback.id, env); return; }

  // Reply to user
  if (data.startsWith("reply:")) {
    const parts = data.split(":"); const target = parseInt(parts[1]); const mode = parts[2];
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌", true); return; }
    await setState(userId, "admin_reply", { target, mode }, env);
    await answerCb(callback.id, env, "📝 پاسخ بنویسید.");
    await sendMsg(chatId, `📝 پاسخ به کاربر ${target} را بنویسید:`, env);
    return;
  }

  // Block user
  if (data.startsWith("block:")) {
    const target = parseInt(data.split(":")[1]);
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌", true); return; }
    await dbRun(env, "UPDATE users SET blocked = 1 WHERE user_id = ?", [target]);
    await answerCb(callback.id, env, `🚫 کاربر ${target} بلاک شد.`);
    return;
  }

  // Content nav
  if (data.startsWith("content:")) {
    const parts = data.split(":"); const action = parts[1]; const id = parseInt(parts[2]) || 0;
    await answerCb(callback.id, env);
    if (action === "root") { await showContentRoot(chatId, env, msgId); }
    else if (action === "open") {
      const contents = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [id]);
      const btn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [id]);
      if (contents.length > 0) { for (const c of contents) await sendContentItem(chatId, c, env); }
      else if (btn) {
        const ch = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = ? AND is_active = 1 ORDER BY order_index", [id]);
        if (ch.length > 0) await showContentFolder(chatId, id, env, msgId);
        else await sendMsg(chatId, "📝 این بخش هنوز محتوایی ندارد.", env);
      }
    } else if (action === "folder") { await showContentFolder(chatId, id, env, msgId); }
    else if (action === "back") { const btn = await dbFirst(env, "SELECT parent_id FROM buttons WHERE id = ?", [id]); const pid = btn && btn.parent_id ? btn.parent_id : 0; if (pid === 0) await showContentRoot(chatId, env, msgId); else await showContentFolder(chatId, pid, env, msgId); }
    return;
  }

  // ═══════ ADMIN CALLBACKS ═══════
  if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌ دسترسی ندارید.", true); return; }

  if (data === "admin:panel") {
    await clearState(userId, env);
    await safeEditMsg(chatId, msgId, `👨‍💼 <b>پنل مدیریت</b>\n👤 نقش شما: <b>${isOwner(userId, env) ? "owner" : "admin"}</b>\n\nیکی از گزینه‌ها را انتخاب کنید:`, env, { reply_markup: adminPanelKeyboard() });
    await answerCb(callback.id, env); return;
  }

  if (data.startsWith("admin:btn:add:")) {
    const pid = parseInt(data.split(":")[3]) || 0;
    await answerCb(callback.id, env);
    await setState(userId, "add_button", { parent_id: pid }, env);
    await sendMsg(chatId, "➕ نام دکمه جدید را ارسال کنید:", env, { reply_markup: cancelKeyboard() });
    return;
  }

  if (data.startsWith("admin:btn:manage:")) {
    const pid = parseInt(data.split(":")[3]) || 0;
    await answerCb(callback.id, env);
    const ppid = await getParentParentId(env, pid);
    const buttons = await dbAll(env, "SELECT id, name, is_active FROM buttons WHERE parent_id = ? ORDER BY order_index", [pid]);
    const path = await getButtonPath(env, pid);
    await safeEditMsg(chatId, msgId, `📋 <b>مدیریت دکمه‌ها</b>\nمسیر: <b>${path}</b>\n\nروی هر دکمه بزنید تا ویرایش کنید:`, env, { reply_markup: adminManageButtonsKeyboard(buttons, pid, ppid) });
    return;
  }

  if (data.startsWith("admin:btn:edit:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
    if (!b) { await safeEditMsg(chatId, msgId, "❌ دکمه یافت نشد.", env, { reply_markup: backToPanelKeyboard() }); return; }
    const path = await getButtonPath(env, bid);
    const cnt = (await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]))[0];
    const cCount = cnt ? cnt.c : 0;
    await safeEditMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${b.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${b.is_active ? "فعال" : "غیرفعال"}</b>\nخصوصی: <b>${b.protect_content ? "روشن" : "خاموش"}</b>\nاتمام آپلود: <b>${b.upload_completed ? "تایید شده" : "تایید نشده"}</b>\nمحتوا: <b>${cCount > 0 ? cCount + " مورد" : "---"}</b>`, env, { reply_markup: adminEditButtonKeyboard(b.id, b.parent_id || 0, !!b.is_active, !!b.protect_content, !!b.upload_completed) });
    return;
  }

  if (data.startsWith("admin:btn:rename:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    await setState(userId, "rename_button", { button_id: bid }, env);
    await sendMsg(chatId, "✏️ نام جدید دکمه را ارسال کنید:", env, { reply_markup: cancelKeyboard() });
    return;
  }

  if (data.startsWith("admin:btn:toggle:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
    if (!b) { await answerCb(callback.id, env, "❌", true); return; }
    await dbRun(env, "UPDATE buttons SET is_active = ? WHERE id = ?", [b.is_active ? 0 : 1, bid]);
    const nb = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
    const path = await getButtonPath(env, bid);
    const cnt = (await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]))[0];
    await safeEditMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${nb.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${nb.is_active ? "فعال" : "غیرفعال"}</b>\nخصوصی: <b>${nb.protect_content ? "روشن" : "خاموش"}</b>\nاتمام آپلود: <b>${nb.upload_completed ? "تایید شده" : "تایید نشده"}</b>\nمحتوا: <b>${cnt && cnt.c > 0 ? cnt.c + " مورد" : "---"}</b>`, env, { reply_markup: adminEditButtonKeyboard(nb.id, nb.parent_id || 0, !!nb.is_active, !!nb.protect_content, !!nb.upload_completed) });
    return;
  }

  if (data.startsWith("admin:btn:protect:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
    if (!b) { await answerCb(callback.id, env, "❌", true); return; }
    await dbRun(env, "UPDATE buttons SET protect_content = ? WHERE id = ?", [b.protect_content ? 0 : 1, bid]);
    const nb = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
    const path = await getButtonPath(env, bid);
    const cnt = (await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]))[0];
    await safeEditMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${nb.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${nb.is_active ? "فعال" : "غیرفعال"}</b>\nخصوصی: <b>${nb.protect_content ? "روشن" : "خاموش"}</b>\nاتمام آپلود: <b>${nb.upload_completed ? "تایید شده" : "تایید نشده"}</b>\nمحتوا: <b>${cnt && cnt.c > 0 ? cnt.c + " مورد" : "---"}</b>`, env, { reply_markup: adminEditButtonKeyboard(nb.id, nb.parent_id || 0, !!nb.is_active, !!nb.protect_content, !!nb.upload_completed) });
    return;
  }

  if (data.startsWith("admin:btn:uploaddone:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
    if (!b) { await answerCb(callback.id, env, "❌", true); return; }
    await dbRun(env, "UPDATE buttons SET upload_completed = ? WHERE id = ?", [b.upload_completed ? 0 : 1, bid]);
    const nb = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [bid]);
    const path = await getButtonPath(env, bid);
    const cnt = (await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]))[0];
    await safeEditMsg(chatId, msgId, `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${nb.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${nb.is_active ? "فعال" : "غیرفعال"}</b>\nخصوصی: <b>${nb.protect_content ? "روشن" : "خاموش"}</b>\nاتمام آپلود: <b>${nb.upload_completed ? "تایید شده" : "تایید نشده"}</b>\nمحتوا: <b>${cnt && cnt.c > 0 ? cnt.c + " مورد" : "---"}</b>`, env, { reply_markup: adminEditButtonKeyboard(nb.id, nb.parent_id || 0, !!nb.is_active, !!nb.protect_content, !!nb.upload_completed) });
    return;
  }

  if (data.startsWith("admin:btn:append:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    await setState(userId, "upload_content", { button_id: bid, pending_files: [] }, env);
    await sendMsg(chatId, `📤 <b>آپلود محتوا</b>\n\nمحتواها ذخیره می‌شوند.\n\n• ✅ اتمام آپلود\n• 📋 نمایش لیست\n• ❌ لغو کل آپلود`, env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  if (data.startsWith("admin:btn:delete:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT name FROM buttons WHERE id = ?", [bid]);
    if (!b) { await answerCb(callback.id, env, "❌", true); return; }
    await setState(userId, "delete_confirm", { button_id: bid }, env);
    await sendMsg(chatId, `⚠️ آیا از حذف '<b>${b.name}</b>' و تمام زیرمجموعه‌ها مطمئنید؟\n\nبرای تایید: <code>حذف</code>`, env, { reply_markup: cancelKeyboard() });
    return;
  }

  if (data.startsWith("admin:btn:sessions:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const b = await dbFirst(env, "SELECT id FROM buttons WHERE id = ?", [bid]);
    if (!b) { await answerCb(callback.id, env, "❌", true); return; }
    const startIdx = await getNextSessionIndex(env, bid);
    const path = await getButtonPath(env, bid);
    await setState(userId, "session_batch_count", { button_id: bid, button_path: path, next_index: startIdx }, env);
    await sendMsg(chatId, `🧩 <b>ایجاد جلسه</b>\n\nمسیر: <b>${path}</b>\nشماره بعدی: <b>${String(startIdx).padStart(2, "0")}</b>\n\nتعداد را ارسال کنید (۱-۵۰۰):\nلغو: <code>لغو</code>`, env, { reply_markup: cancelKeyboard() });
    return;
  }

  if (data.startsWith("admin:btn:archivepush:")) {
    const bid = parseInt(data.split(":")[3]);
    await answerCb(callback.id, env);
    const ar = await dbFirst(env, "SELECT value FROM settings WHERE key = 'archive_channel_id'");
    if (!ar || !ar.value) { await answerCb(callback.id, env, "❌ کانال آرشیو تنظیم نشده.", true); return; }
    const cnt = await dbAll(env, "SELECT COUNT(*) as c FROM button_contents WHERE button_id = ?", [bid]);
    if (!cnt[0] || cnt[0].c === 0) { await answerCb(callback.id, env, "❌ محتوایی ندارد.", true); return; }
    const path = await getButtonPath(env, bid);
    await sendMsg(chatId, `📦 <b>انتقال به آرشیو</b>\n\nمسیر: <b>${path}</b>\nمحتوا: <b>${cnt[0].c}</b>\n\n⚠️ قابلیت انتقال در نسخه بعدی فعال می‌شود.`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  if (data === "admin:smartarchive:menu") {
    await answerCb(callback.id, env);
    const all = await dbAll(env, "SELECT id, upload_completed FROM buttons WHERE id != 0");
    const completed = all.filter(b => b.upload_completed);
    const withContent = (await dbAll(env, "SELECT button_id FROM button_contents GROUP BY button_id")).length;
    await safeEditMsg(chatId, msgId, `🧠 <b>آرشیو هوشمند</b>\n\nکل دکمه‌ها: <b>${all.length}</b>\nاتمام آپلود: <b>${completed.length}</b>\nاتمام‌نشده: <b>${all.length - completed.length}</b>\nدارای محتوا: <b>${withContent}</b>`, env, { reply_markup: { inline_keyboard: [[{ text: "🔄 بروزرسانی", callback_data: "admin:smartarchive:menu" }], [{ text: "🔙 بازگشت", callback_data: "admin:panel" }]] } });
    return;
  }

  if (data === "admin:broadcast:start") {
    await answerCb(callback.id, env);
    await setState(userId, "broadcast_wait", {}, env);
    await sendMsg(chatId, "📣 محتوای پیام همگانی را ارسال کنید:", env, { reply_markup: cancelKeyboard() });
    return;
  }

  if (data === "admin:broadcast:confirm") {
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (!st || st.state !== "broadcast_confirm") { await sendMsg(chatId, "❌ داده‌ای یافت نشد.", env); return; }
    const payload = st.data;
    await clearState(userId, env);
    const users = await dbAll(env, "SELECT user_id FROM users WHERE blocked = 0");
    let ok = 0, fail = 0;
    for (const u of users) {
      if (u.user_id === userId) continue;
      try {
        if (payload.kind === "text") await sendMsg(u.user_id, `📣 <b>پیام از مدیریت:</b>\n\n${payload.text || ""}`, env);
        else if (payload.kind === "photo") await tg("sendPhoto", { chat_id: u.user_id, photo: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
        else if (payload.kind === "video") await tg("sendVideo", { chat_id: u.user_id, video: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
        else if (payload.kind === "document") await tg("sendDocument", { chat_id: u.user_id, document: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
        else if (payload.kind === "audio") await tg("sendAudio", { chat_id: u.user_id, audio: payload.file_id, caption: payload.text || "", parse_mode: "HTML" }, env);
        else if (payload.kind === "voice") await tg("sendVoice", { chat_id: u.user_id, voice: payload.file_id }, env);
        else if (payload.kind === "sticker") await tg("sendSticker", { chat_id: u.user_id, sticker: payload.file_id }, env);
        else if (payload.kind === "animation") await tg("sendAnimation", { chat_id: u.user_id, animation: payload.file_id, caption: payload.text || "" }, env);
        ok++;
      } catch (e) { fail++; }
    }
    await sendMsg(chatId, `✅ پایان ارسال.\nموفق: ${ok}\nناموفق: ${fail}`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  if (data === "admin:broadcast:cancel") {
    await answerCb(callback.id, env);
    await clearState(userId, env);
    await sendMsg(chatId, "❌ لغو شد.", env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  if (data === "admin:ban:menu") {
    await answerCb(callback.id, env);
    await setState(userId, "ban_menu", {}, env);
    const blocked = await dbAll(env, "SELECT user_id FROM users WHERE blocked = 1 LIMIT 20");
    await safeEditMsg(chatId, msgId, `🚫 <b>بن/آزادسازی</b>\n\nآیدی عددی کاربر را ارسال کنید.\n\nبن شده‌ها:\n<code>${blocked.map(b => b.user_id).join(", ") || "---"}</code>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  if (data === "admin:forcejoin:menu") {
    await answerCb(callback.id, env);
    await setState(userId, "forcejoin_menu", {}, env);
    const ch = await dbAll(env, "SELECT channel FROM forced_channels");
    await safeEditMsg(chatId, msgId, `📌 <b>عضویت اجباری</b>\n\n${ch.map(c => `• ${c.channel}`).join("\n") || "هیچ کانالی"}\n\nافزودن: لینک/یوزرنیم\nحذف: <code>حذف @channel</code>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  if (data === "admin:archive:menu") {
    await answerCb(callback.id, env);
    const cur = await dbFirst(env, "SELECT value FROM settings WHERE key = 'archive_channel_id'");
    await setState(userId, "archive_menu", {}, env);
    await safeEditMsg(chatId, msgId, `🗄️ <b>کانال آرشیو</b>\n\nوضعیت: <b>${(cur && cur.value) || "غیرفعال"}</b>\n\nفرمت: <code>-100xxx</code> / <code>@channel</code> / <code>t.me/channel</code>\nغیرفعال: <code>off</code>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  if (data === "admin:backup:menu") {
    await answerCb(callback.id, env);
    const br = await dbFirst(env, "SELECT value FROM settings WHERE key = 'backup_chat_ref'");
    await safeEditMsg(chatId, msgId, `🗃️ <b>بکاپ</b>\n\nوضعیت: <b>${(br && br.value) || "غیرفعال"}</b>`, env, { reply_markup: { inline_keyboard: [[{ text: "⚙️ تنظیم مقصد", callback_data: "admin:backup:setchat" }], [{ text: "🔙 بازگشت", callback_data: "admin:panel" }]] } });
    return;
  }

  if (data === "admin:backup:setchat") {
    await answerCb(callback.id, env);
    await setState(userId, "backup_set_chat", {}, env);
    await sendMsg(chatId, "📍 مقصد بکاپ را ارسال کنید:\n<code>-100xxx</code> / <code>@channel</code> / <code>off</code>", env, { reply_markup: cancelKeyboard() });
    return;
  }

  if (data === "admin:stats") {
    await answerCb(callback.id, env);
    const ut = await dbFirst(env, "SELECT COUNT(*) as c FROM users");
    const ua = await dbFirst(env, "SELECT COUNT(*) as c FROM users WHERE blocked = 0");
    const ub = await dbFirst(env, "SELECT COUNT(*) as c FROM users WHERE blocked = 1");
    const bt = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0");
    const ba = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0 AND is_active = 1");
    const bi = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0 AND is_active = 0");
    const ct = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents");
    const bc = await dbFirst(env, "SELECT COUNT(DISTINCT button_id) as c FROM button_contents");
    await safeEditMsg(chatId, msgId, `📊 <b>آمار کلی</b>\n\n👥 کل: <b>${ut?.c||0}</b> | ✅ فعال: <b>${ua?.c||0}</b> | 🚫 بن: <b>${ub?.c||0}</b>\n\n🔘 کل: <b>${bt?.c||0}</b> | 🟢 فعال: <b>${ba?.c||0}</b> | 🔴 غیرفعال: <b>${bi?.c||0}</b>\n📂 دارای محتوا: <b>${bc?.c||0}</b>\n📎 کل آیتم‌ها: <b>${ct?.c||0}</b>`, env, { reply_markup: backToPanelKeyboard() });
    return;
  }

  if (data === "admin:upload:finish") {
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (!st || st.state !== "upload_confirm") { await sendMsg(chatId, "❌ حالت آپلود فعال نیست.", env); return; }
    const pending = st.data.pending_files || [];
    if (pending.length === 0) { await clearState(userId, env); await sendMsg(chatId, "❌ خالی است.", env, { reply_markup: removeKeyboard() }); return; }
    const r = await savePendingContents(env, st.data.button_id, pending);
    await clearState(userId, env);
    await sendMsg(chatId, `✅ ذخیره شد.\nموفق: ${r.success}\nناموفق: ${r.fail}`, env, { reply_markup: removeKeyboard() });
    return;
  }

  if (data === "admin:upload:continue") {
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (!st || st.state !== "upload_confirm") { await sendMsg(chatId, "❌ حالت آپلود فعال نیست.", env); return; }
    await setState(userId, "upload_content", { button_id: st.data.button_id, pending_files: st.data.pending_files || [] }, env);
    await sendMsg(chatId, "↩️ ادامه دهید.", env, { reply_markup: adminUploadReplyKeyboard() });
    return;
  }

  if (data === "admin:upload:cancel") {
    await answerCb(callback.id, env);
    const st = await getState(userId, env);
    if (st && (st.state === "upload_content" || st.state === "upload_confirm")) {
      const pending = st.data.pending_files || [];
      await clearState(userId, env);
      await sendMsg(chatId, `❌ لغو شد.\n${pending.length} مورد حذف شد.`, env, { reply_markup: removeKeyboard() });
    } else await sendMsg(chatId, "ℹ️ آپلود فعالی نیست.", env);
    return;
  }
}

// ═══════ CONTENT DISPLAY ═══════

async function showContentRoot(chatId, env, editMsgId) {
  const buttons = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = 0 AND is_active = 1 ORDER BY order_index");
  const children = buttons.filter(b => Number(b.id) !== 0);
  if (children.length === 0) { if (editMsgId) await safeEditMsg(chatId, editMsgId, "📂 هنوز محتوایی وجود ندارد.", env); else await sendMsg(chatId, "📂 هنوز محتوایی وجود ندارد.", env); return; }
  const rows = children.map(b => [{ text: b.name, callback_data: `content:open:${b.id}` }]);
  rows.push([{ text: "🏠 منوی اصلی", callback_data: "back_main" }]);
  const kb = { inline_keyboard: rows };
  const txt = "📚 <b>بخش محتوای آموزشی</b>\n\nیک گزینه را انتخاب کنید:";
  if (editMsgId) await safeEditMsg(chatId, editMsgId, txt, env, { reply_markup: kb });
  else await sendMsg(chatId, txt, env, { reply_markup: kb });
}

async function showContentFolder(chatId, parentId, env, editMsgId) {
  const children = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = ? AND is_active = 1 ORDER BY order_index", [parentId]);
  const contents = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [parentId]);
  const btn = await dbFirst(env, "SELECT name FROM buttons WHERE id = ?", [parentId]);
  const title = btn ? `📁 <b>${btn.name}</b>` : "📁 منو";
  const rows = [];
  if (contents.length > 0) rows.push([{ text: `📎 ${contents.length} محتوا`, callback_data: `content:open:${parentId}` }]);
  for (const b of children) rows.push([{ text: b.name, callback_data: `content:open:${b.id}` }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: `content:back:${parentId}` }, { text: "🏠 منوی اصلی", callback_data: "back_main" }]);
  const kb = { inline_keyboard: rows };
  if (editMsgId) await safeEditMsg(chatId, editMsgId, title + "\n\nیک گزینه را انتخاب کنید:", env, { reply_markup: kb });
  else await sendMsg(chatId, title + "\n\nیک گزینه را انتخاب کنید:", env, { reply_markup: kb });
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
