/**
 * User handler — menu navigation, content viewing, support.
 * Combined bot: messenger + uploader sections.
 */
import { menuKeyboard, forcedJoinKeyboard, mainUserKeyboard } from '../services/keyboard.js';
import { sendButtonContents } from '../services/content.js';

const NAV_KEY = 'nav_stack';
const MENU_MSG_KEY = 'menu_msg_id';

// ═══════════════════════════════════════════════════════
// NAVIGATION STACK
// ═══════════════════════════════════════════════════════

function getStack(userData) { return userData[NAV_KEY] || [0]; }
function pushStack(userData, id) { const s = userData[NAV_KEY] || [0]; s.push(id); userData[NAV_KEY] = s; }
function popStack(userData) { const s = userData[NAV_KEY] || [0]; if (s.length > 1) s.pop(); userData[NAV_KEY] = s; return s[s.length - 1]; }
function resetStack(userData) { userData[NAV_KEY] = [0]; }

// ═══════════════════════════════════════════════════════
// MENU RENDERING
// ═══════════════════════════════════════════════════════

async function renderMenu(tg, db, chatId, userData, { parentId, title, showSupport = true, page = 0 }) {
  const buttons = await db.listChildren(parentId, false);
  const kb = menuKeyboard(buttons, parentId, showSupport, page);
  const menuMsgId = userData[MENU_MSG_KEY];
  if (menuMsgId) {
    try { await tg.editMessageText(chatId, menuMsgId, title, { reply_markup: kb }); return; } catch {}
  }
  const msg = await tg.sendMessage(chatId, title, { reply_markup: kb });
  if (msg?.message_id) userData[MENU_MSG_KEY] = msg.message_id;
}

// ═══════════════════════════════════════════════════════
// /start — Main entry
// ═══════════════════════════════════════════════════════

export async function start(tg, db, update, env) {
  const user = update.effective_user;
  if (!user) return;

  await db.upsertUserBasic(user.id, user.username, user.first_name, user.last_name);

  if (await db.isBlocked(user.id)) {
    await tg.sendMessage(update.message.chat.id, '🚫 شما از سمت مدیریت بن شده‌اید.');
    return;
  }

  // Forced channel join check
  const forced = await db.listForcedChannels();
  if (forced.length > 0) {
    const kb = forcedJoinKeyboard(forced);
    await tg.sendMessage(update.message.chat.id, '🔒 برای استفاده از ربات باید در کانال(های) زیر عضو شوید:', { reply_markup: kb });
    return;
  }

  // Show main user menu with two sections
  // mainUserKeyboard imported at top
  await tg.sendMessage(update.message.chat.id,
    `🌟 <b>خوش آمدید!</b> 🌟\n\nیکی از بخش‌های زیر را انتخاب کنید:`,
    { reply_markup: mainUserKeyboard() }
  );
}

// ═══════════════════════════════════════════════════════
// Content section: open button
// ═══════════════════════════════════════════════════════

export async function menuOpen(tg, db, update) {
  const user = update.effective_user;
  const query = update.callback_query;
  if (!user || !query) return;

  if (await db.isBlocked(user.id)) {
    await tg.answerCallbackQuery(query.id, '🚫 شما بن شده‌اید.', { show_alert: true });
    return;
  }

  const buttonId = parseInt(query.data.split(':')[2]);
  const btn = await db.getButton(buttonId);
  if (!btn || !btn.isActive) {
    await tg.answerCallbackQuery(query.id, '❌ این دکمه در دسترس نیست.', { show_alert: true });
    return;
  }

  await tg.answerCallbackQuery(query.id);

  const { data: userData } = await db.getUserState(user.id);
  pushStack(userData, buttonId);
  await db.setUserState(user.id, 'menu_nav', userData);

  const hasContent = await db.buttonHasAnyContent(buttonId);
  if (hasContent) {
    const contents = await db.listButtonContents(buttonId);
    await sendButtonContents(tg, query.message.chat.id, btn, contents, btn.protectContent);
  }

  const children = await db.listChildren(buttonId, false);
  if (children.length > 0) {
    await renderMenu(tg, db, query.message.chat.id, userData, {
      parentId: buttonId,
      title: `📁 <b>${btn.name}</b>\n\nیک گزینه را انتخاب کنید:`,
      showSupport: true,
    });
  } else if (!hasContent) {
    await tg.sendMessage(query.message.chat.id, '📝 این بخش هنوز محتوایی ندارد.');
  }
}

export async function menuPage(tg, db, update) {
  const query = update.callback_query;
  if (!query) return;
  await tg.answerCallbackQuery(query.id);
  const parts = query.data.split(':');
  const parentId = parseInt(parts[2]);
  const page = parseInt(parts[3]);
  const parentBtn = await db.getButton(parentId);
  const title = parentBtn ? `📁 <b>${parentBtn.name}</b>\n\nیک گزینه را انتخاب کنید:` : '📁 <b>منو</b>';
  const userData = {};
  resetStack(userData);
  await renderMenu(tg, db, query.message.chat.id, userData, { parentId, title, showSupport: true, page });
}

export async function menuBack(tg, db, update) {
  const query = update.callback_query;
  if (!query) return;
  await tg.answerCallbackQuery(query.id);
  const user = update.effective_user;
  const { data: userData } = await db.getUserState(user.id);
  const parentId = popStack(userData);
  await db.setUserState(user.id, 'menu_nav', userData);

  if (parentId === 0) {
    // mainUserKeyboard imported at top
    await tg.sendMessage(query.message.chat.id, '🌟 <b>منوی اصلی</b>', { reply_markup: mainUserKeyboard() });
    return;
  }
  const parentBtn = await db.getButton(parentId);
  const title = parentBtn ? `📁 <b>${parentBtn.name}</b>\n\nیک گزینه را انتخاب کنید:` : '📁 <b>منو</b>';
  await renderMenu(tg, db, query.message.chat.id, userData, { parentId, title, showSupport: true });
}

export async function menuHome(tg, db, update) {
  const query = update.callback_query;
  if (!query) return;
  await tg.answerCallbackQuery(query.id);
  try { await tg.deleteMessage(query.message.chat.id, query.message.message_id); } catch {}
  // mainUserKeyboard imported at top
  await tg.sendMessage(query.message.chat.id, '🌟 <b>منوی اصلی</b>', { reply_markup: mainUserKeyboard() });
}

export async function joinCheck(tg, db, update, env) {
  const query = update.callback_query;
  if (!query) return;
  await tg.answerCallbackQuery(query.id);
  const user = update.effective_user;
  if (!user) return;
  await tg.editMessageText(query.message.chat.id, query.message.message_id, '✅ عضویت شما تایید شد.');
  await start(tg, db, update, env);
}
