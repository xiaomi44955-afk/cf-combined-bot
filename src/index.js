// ═══════ CF Combined Bot: Messenger + Uploader ═══════ Single file ═══════

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
  // parse_mode defaults to HTML unless explicitly set
  if (!body.parse_mode) body.parse_mode = "HTML";
  if (body.reply_markup && typeof body.reply_markup !== "string")
    body.reply_markup = JSON.stringify(body.reply_markup);
  return tg("sendMessage", body, env);
}

async function editMsg(chatId, msgId, text, env, extra = {}) {
  const body = { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", ...extra };
  if (body.reply_markup && typeof body.reply_markup !== "string")
    body.reply_markup = JSON.stringify(body.reply_markup);
  return tg("editMessageText", body, env);
}

async function answerCb(cbId, env, text = "") {
  return tg("answerCallbackQuery", { callback_query_id: cbId, text });
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
    `CREATE TABLE IF NOT EXISTS buttons (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER DEFAULT NULL, name TEXT NOT NULL, is_active INTEGER DEFAULT 1, protect_content INTEGER DEFAULT 0, order_index INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS button_contents (id INTEGER PRIMARY KEY AUTOINCREMENT, button_id INTEGER NOT NULL, order_index INTEGER DEFAULT 0, content_kind TEXT DEFAULT 'text', content_text TEXT DEFAULT '', content_file_id TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS user_states (user_id INTEGER PRIMARY KEY, state TEXT DEFAULT '', data TEXT DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`,
  ];
  for (const s of t) await dbRun(env, s);
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
  // Reply keyboard — bottom of screen, two buttons side by side
  return {
    keyboard: [
      [{ text: "📚 محتوای آموزشی" }, { text: "📨 ارسال پیام" }],
    ],
    resize_keyboard: true,
  };
}

function msgTypeKeyboard() {
  // After clicking "ارسال پیام" — show two options side by side
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

// ═══════ WELCOME TEXT ═══════

function welcomeText() {
  // MarkdownV2 format — blockquotes with > prefix
  // Escape special chars for MarkdownV2
  function esc(s) { return s.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1"); }
  return `🧡 › درود ×͜× رفیق من :)

${esc("اینجا میتونی درخواست و پیشنهاداتو برای ما بفرستی و ما در کمترین زمان ممکن میخونیمیش و حتماً پاسخ میدیم .")}
> 💌 › پیــام ناشنــاس : ${esc("رفیق من پیامتو که میفرستی ناشناس ارسال میشه و هیچ اطلاعاتی از اکانت شما برای ما معلوم نیست .")}
> 🫶🏻 › پیـــام عـــادی : ${esc("رفیق من پیامتو ک میفرستی اسم اکانتت مشخصه و برای ما پیداست که از سمت کی پیام دریافت کردیم .")}
> 📚 › محتــوای آموزشی : ${esc("در این قسمت میتونی محتوای های مختلفی همچون \" پادکست های مشاوره ای ، برنامه های راهبردی و تحصلی ، جزوات و پکیج های درسی و مصاحبه ای و ... \" رو ببینی و دریافت کنی .")}`;
}

// ═══════ MESSAGE HANDLER ═══════

async function handleMessage(message, env) {
  await ensureTables(env);

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text || "";

  // Register user
  await dbRun(env, "INSERT INTO users (user_id, username, first_name, last_name) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name", [userId, message.from.username || "", message.from.first_name || "", message.from.last_name || ""]);

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
    await sendMsg(chatId, welcomeText(), env, { parse_mode: "MarkdownV2", reply_markup: mainKeyboard() });
    return;
  }

  // ─── /admin ───
  if (text === "/admin") {
    if (!isAdmin(userId, env)) { await sendMsg(chatId, "❌ دسترسی ندارید.", env); return; }
    await clearState(userId, env);
    const buttons = await dbAll(env, "SELECT id, name, is_active FROM buttons WHERE parent_id = 0 ORDER BY order_index");
    let btnText = "🔧 <b>پنل مدیریت</b>\n\n";
    btnText += "📋 دکمه‌ها:\n";
    for (const b of buttons) {
      if (b.id === 0) continue;
      btnText += `  ${b.is_active ? "✅" : "⛔️"} ${b.name} (ID: ${b.id})\n`;
    }
    btnText += "\nدستورات:\n";
    btnText += "  /addbtn [نام] — افزودن دکمه\n";
    btnText += "  /delbtn [ID] — حذف دکمه\n";
    btnText += "  /upload [ID] — آپلود محتوا\n";
    btnText += "  /done — پایان آپلود\n";
    btnText += "  /stats — آمار\n";
    await sendMsg(chatId, btnText, env);
    return;
  }

  // ─── /addbtn [name] ───
  if (text.startsWith("/addbtn")) {
    if (!isAdmin(userId, env)) return;
    const name = text.replace("/addbtn", "").trim();
    if (!name) { await sendMsg(chatId, "Usage: /addbtn نام دکمه", env); return; }
    await dbRun(env, "INSERT INTO buttons (parent_id, name, order_index) VALUES (0, ?, (SELECT COALESCE(MAX(order_index),0)+1 FROM buttons WHERE parent_id=0))", [name]);
    await sendMsg(chatId, `✅ دکمه «${name}» ساخته شد.`, env);
    return;
  }

  // ─── /delbtn [id] ───
  if (text.startsWith("/delbtn")) {
    if (!isAdmin(userId, env)) return;
    const id = parseInt(text.replace("/delbtn", "").trim());
    if (!id) { await sendMsg(chatId, "Usage: /delbtn 123", env); return; }
    await dbRun(env, "DELETE FROM button_contents WHERE button_id = ?", [id]);
    await dbRun(env, "DELETE FROM buttons WHERE id = ?", [id]);
    await sendMsg(chatId, `✅ دکمه ${id} حذف شد.`, env);
    return;
  }

  // ─── /upload [buttonId] ───
  if (text.startsWith("/upload")) {
    if (!isAdmin(userId, env)) return;
    const id = parseInt(text.replace("/upload", "").trim());
    if (!id) { await sendMsg(chatId, "Usage: /upload 123", env); return; }
    const btn = await dbFirst(env, "SELECT id, name FROM buttons WHERE id = ?", [id]);
    if (!btn) { await sendMsg(chatId, "❌ دکمه یافت نشد.", env); return; }
    await setState(userId, "admin_upload", { button_id: id }, env);
    await sendMsg(chatId, `📤 آپلود محتوا برای «${btn.name}» فعال شد.\nمحتواها رو بفرستید.\nوقتی تموم شد /done بزنید.`, env, { reply_markup: cancelKeyboard() });
    return;
  }

  // ─── /done (finish upload) ───
  if (text === "/done") {
    const st = await getState(userId, env);
    if (st && st.state === "admin_upload") {
      await clearState(userId, env);
      await sendMsg(chatId, "✅ آپلود تمام شد.", env, { reply_markup: removeKeyboard() });
    }
    return;
  }

  // ─── /cancel ───
  if (text === "/cancel" || text === "لغو") {
    await clearState(userId, env);
    await sendMsg(chatId, "❌ لغو شد.", env, { reply_markup: mainKeyboard() });
    return;
  }

  // ─── /stats ───
  if (text === "/stats") {
    if (!isAdmin(userId, env)) return;
    const users = await dbFirst(env, "SELECT COUNT(*) as c FROM users");
    const btns = await dbFirst(env, "SELECT COUNT(*) as c FROM buttons WHERE id != 0");
    const contents = await dbFirst(env, "SELECT COUNT(*) as c FROM button_contents");
    await sendMsg(chatId, `📊 <b>آمار</b>\n\n👥 کاربران: ${users.c}\n🔘 دکمه‌ها: ${btns.c}\n📎 محتواها: ${contents.c}`, env);
    return;
  }

  // ─── STATE-BASED ROUTING ───
  const st = await getState(userId, env);

  // Admin uploading content
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

    const order = (await dbFirst(env, "SELECT COALESCE(MAX(order_index),0)+1 as n FROM button_contents WHERE button_id=?", [buttonId]));
    await dbRun(env, "INSERT INTO button_contents (button_id, order_index, content_kind, content_text, content_file_id) VALUES (?, ?, ?, ?, ?)", [buttonId, order ? order.n : 0, kind, message.text || message.caption || "", fileId || ""]);
    await sendMsg(chatId, `✅ [${order ? order.n : 0}] ${kind} ذخیره شد.`, env, { reply_markup: cancelKeyboard() });
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
    await sendMsg(chatId, welcomeText(), env, { parse_mode: "MarkdownV2", reply_markup: mainKeyboard() });
    return;
  }

  // ─── USER: sending anonymous message ───
  if (st && st.state === "waiting_anon") {
    await clearState(userId, env);
    const adminId = parseInt(env.MAIN_ADMIN_ID);
    if (adminId) {
      await sendMsg(adminId, `🎭 <b>پیام ناشناس جدید</b>\n\n💬 پیام:\n${text}`, env, {
        reply_markup: { inline_keyboard: [[{ text: "✅ پاسخ", callback_data: `reply:${userId}:anon` }], [{ text: "🚫 بلاک", callback_data: `block:${userId}` }]] },
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
        reply_markup: { inline_keyboard: [[{ text: "✅ پاسخ", callback_data: `reply:${userId}:normal` }], [{ text: "🚫 بلاک", callback_data: `block:${userId}` }]] },
      });
    }
    await sendMsg(chatId, "✅ پیام شما ارسال شد.\n⏳ منتظر پاسخ باشید.", env, { reply_markup: mainKeyboard() });
    return;
  }

  // ─── ADMIN: replying to user ───
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

  // ─── ADMIN: broadcasting ───
  if (st && st.state === "broadcasting") {
    if (!isAdmin(userId, env)) return;
    await clearState(userId, env);
    const users = await dbAll(env, "SELECT user_id FROM users WHERE blocked = 0");
    let ok = 0, fail = 0;
    for (const u of users) {
      if (u.user_id === userId) continue;
      try { await sendMsg(u.user_id, `📣 <b>پیام از مدیریت:</b>\n\n${text}`, env); ok++; } catch { fail++; }
    }
    await sendMsg(chatId, `✅ ارسال شد: ${ok}\n❌ ناموفق: ${fail}`, env);
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

  // ─── Reply to user ───
  if (data.startsWith("reply:")) {
    const parts = data.split(":");
    const target = parseInt(parts[1]);
    const mode = parts[2];
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await setState(userId, "admin_reply", { target, mode }, env);
    await answerCb(callback.id, env, "📝 پاسخ بنویسید.");
    await sendMsg(chatId, `📝 پاسخ به کاربر ${target} را بنویسید:`, env);
    return;
  }

  // ─── Block user ───
  if (data.startsWith("block:")) {
    const target = parseInt(data.split(":")[1]);
    if (!isAdmin(userId, env)) { await answerCb(callback.id, env, "❌"); return; }
    await dbRun(env, "UPDATE users SET blocked = 1 WHERE user_id = ?", [target]);
    await answerCb(callback.id, env, `🚫 کاربر ${target} بلاک شد.`);
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
      // Show content of button
      const contents = await dbAll(env, "SELECT * FROM button_contents WHERE button_id = ? ORDER BY order_index", [id]);
      const btn = await dbFirst(env, "SELECT * FROM buttons WHERE id = ?", [id]);
      if (contents.length > 0) {
        for (const c of contents) {
          await sendContentItem(chatId, c, env);
        }
      } else if (btn) {
        // Check children
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

  // ─── Broadcast ───
  if (data === "admin:broadcast") {
    if (!isAdmin(userId, env)) return;
    await answerCb(callback.id, env);
    await setState(userId, "broadcasting", {}, env);
    await sendMsg(chatId, "📝 پیام همگانی را بنویسید:", env);
    return;
  }
}

// ═══════ CONTENT DISPLAY ═══════

async function showContentRoot(chatId, env, editMsgId) {
  const buttons = await dbAll(env, "SELECT * FROM buttons WHERE parent_id = 0 AND is_active = 1 ORDER BY order_index");
  const children = buttons.filter(b => b.id !== 0);
  if (children.length === 0) {
    await sendMsg(chatId, "📂 هنوز محتوایی وجود ندارد.", env);
    return;
  }
  const rows = [];
  for (const b of children) {
    rows.push([{ text: b.name, callback_data: `content:open:${b.id}` }]);
  }
  rows.push([{ text: "🏠 منوی اصلی", callback_data: "back_main" }]);
  const kb = { inline_keyboard: rows };

  if (editMsgId) {
    await editMsg(chatId, editMsgId, "📚 <b>بخش محتوای آموزشی</b>\n\nیک گزینه را انتخاب کنید:", env, { reply_markup: kb });
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
  // Show content items first
  if (contents.length > 0) {
    rows.push([{ text: `📎 ${contents.length} محتوا`, callback_data: `content:open:${parentId}` }]);
  }
  // Then show children
  for (const b of children) {
    rows.push([{ text: b.name, callback_data: `content:open:${b.id}` }]);
  }
  rows.push([{ text: "🔙 بازگشت", callback_data: `content:back:${parentId}` }, { text: "🏠 منوی اصلی", callback_data: "back_main" }]);
  const kb = { inline_keyboard: rows };

  if (editMsgId) {
    await editMsg(chatId, editMsgId, title + "\n\nیک گزینه را انتخاب کنید:", env, { reply_markup: kb });
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
