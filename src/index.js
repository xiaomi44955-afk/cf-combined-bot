/**
 * CF Combined Bot — Cloudflare Worker entry point.
 * Merges: Messenger (normal/anonymous) + Uploader (content management).
 *
 * Env vars: BOT_TOKEN, MAIN_ADMIN_ID, ADMIN_IDS
 * Bindings: BOT_DB (D1)
 */
import { Database } from './db.js';
import { bindToken } from './utils/telegram.js';
import { isAdmin as checkIsAdmin } from './utils/common.js';
import * as userH from './handlers/user.js';
import * as adminH from './handlers/admin.js';
import * as messengerH from './handlers/messenger.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET') return new Response('CF Combined Bot — OK', { status: 200 });
    if (request.method !== 'POST' || url.pathname !== '/webhook') return new Response('Not Found', { status: 404 });

    let update;
    try { update = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

    const tg = bindToken(env.BOT_TOKEN);
    const db = new Database(env.BOT_DB);
    db._adminId = env.MAIN_ADMIN_ID; // inject for messenger handler

    ctx.waitUntil(processUpdate(update, env, tg, db));
    return new Response('OK', { status: 200 });
  },
};

// ═══════════════════════════════════════════════════════
// UPDATE PROCESSING
// ═══════════════════════════════════════════════════════

async function processUpdate(update, env, tg, db) {
  try {
    if (update.callback_query) { await handleCallbackQuery(update, env, tg, db); return; }
    if (update.message) { await handleMessage(update, env, tg, db); return; }
  } catch (err) { console.error('Error:', err); }
}

// ═══════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════

async function handleMessage(update, env, tg, db) {
  const msg = update.message;
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Bootstrap admin
  if (env.MAIN_ADMIN_ID) await db.ensureAdmin(parseInt(env.MAIN_ADMIN_ID), 'owner');

  // Commands
  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (cmd === '/start') { await userH.start(tg, db, update, env); return; }
    if (cmd === '/admin') { if (await db.isAdmin(userId)) await adminH.adminPanel(tg, db, update, env); return; }
    if (cmd === '/cancel') {
      const { state } = await db.getUserState(userId);
      if (state) { await db.clearUserState(userId); await tg.sendMessage(chatId, '❎ لغو شد.'); }
      return;
    }
    if (cmd === '/messenger') {
      if (!await db.isBlocked(userId)) { await messengerH.startMessenger(tg, db, chatId, userId); }
      return;
    }
    return;
  }

  // ─── Admin FSM first ───
  if (await db.isAdmin(userId)) {
    // Check messenger reply
    const { state } = await db.getUserState(userId);
    if (state === 'replying_messenger') {
      await messengerH.handleAdminReply(tg, db, userId, chatId, text);
      return;
    }
    if (state === 'broadcasting') {
      await messengerH.handleBroadcast(tg, db, userId, chatId, text);
      return;
    }

    const handled = await adminH.handleAdminMessage(tg, db, update, env);
    if (handled) return;
  }

  // ─── User: blocked? ───
  if (await db.isBlocked(userId)) { await tg.sendMessage(chatId, '🚫 شما بن شده‌اید.'); return; }

  // ─── User: FSM states ───
  const { state, data } = await db.getUserState(userId);

  // Upload content state (admin only, but check anyway)
  if (state === 'upload_content' && await db.isAdmin(userId)) {
    await adminH.handleAdminMessage(tg, db, update, env);
    return;
  }

  // ─── Main user keyboard buttons ───
  if (text === '📨 بخش ارسال پیام') {
    await messengerH.startMessenger(tg, db, chatId, userId);
    return;
  }

  if (text === '📚 بخش محتوای آموزشی') {
    // Show content menu
    const userData = {};
    userData['nav_stack'] = [0];
    await db.setUserState(userId, 'menu_nav', userData);
    await userH.start(tg, db, { effective_user: { id: userId }, message: { chat: { id: chatId } } }, env);
    return;
  }

  if (text === '🆘 پشتیبانی') {
    await tg.sendMessage(chatId,
      '📝 پیام خود را برای پشتیبانی ارسال کنید:',
      { reply_markup: JSON.stringify({ keyboard: [[{ text: 'لغو' }]], resize_keyboard: true }) }
    );
    await db.setUserState(userId, 'sending_support', {});
    return;
  }

  if (text === '📨 پیام عادی') {
    // User chose normal message mode
    await db.setUserState(userId, 'waiting_normal_msg', {});
    await tg.sendMessage(chatId,
      '📝 پیام خود را بنویسید:\n\n⚠️ اطلاعات شما برای ادمین نمایش داده می‌شود.',
      { reply_markup: JSON.stringify({ keyboard: [[{ text: 'لغو' }]], resize_keyboard: true }) }
    );
    return;
  }

  if (text === '🎭 پیام ناشناس') {
    await db.setUserState(userId, 'waiting_anon_msg', {});
    await tg.sendMessage(chatId,
      '📝 پیام خود را بنویسید:\n\n🔒 اطلاعات شما کاملاً مخفی خواهد بود.',
      { reply_markup: JSON.stringify({ keyboard: [[{ text: 'لغو' }]], resize_keyboard: true }) }
    );
    return;
  }

  if (text === '🔙 بازگشت') {
    await db.clearUserState(userId);
    const { mainUserKeyboard } = await import('../services/keyboard.js');
    await tg.sendMessage(chatId, '🌟 <b>منوی اصلی</b>', { reply_markup: mainUserKeyboard() });
    return;
  }

  if (text === 'لغو') {
    await db.clearUserState(userId);
    await tg.sendMessage(chatId, '❌ لغو شد.', { reply_markup: JSON.stringify({ remove_keyboard: true }) });
    return;
  }

  // ─── User FSM: waiting for message ───
  if (state === 'waiting_normal_msg') {
    await messengerH.handleNormalMessage(tg, db, msg, userId, chatId, text);
    return;
  }

  if (state === 'waiting_anon_msg') {
    await messengerH.handleAnonymousMessage(tg, db, msg, userId, chatId, text);
    return;
  }

  if (state === 'sending_support') {
    await db.clearUserState(userId);
    await db.insertSupportMessage(userId, text);
    await tg.sendMessage(chatId, '✅ پیام شما ثبت شد. پشتیبانی به زودی پاسخ می‌دهد.', {
      reply_markup: JSON.stringify({ remove_keyboard: true }),
    });
    return;
  }

  // ─── Menu navigation state ───
  if (state === 'menu_nav') {
    // Check if admin is in button add/rename state
    if (await db.isAdmin(userId)) {
      const handled = await adminH.handleAdminMessage(tg, db, update, env);
      if (handled) return;
    }
    await tg.sendMessage(chatId, '📌 لطفاً از دکمه‌های زیر استفاده کنید.');
    return;
  }
}

// ═══════════════════════════════════════════════════════
// CALLBACK QUERY HANDLER
// ═══════════════════════════════════════════════════════

async function handleCallbackQuery(update, env, tg, db) {
  const query = update.callback_query;
  const data = query.data || '';
  const userId = query.from?.id;

  if (data === 'noop') return;

  // ─── USER MENU ───
  if (data === 'menu:home') { await userH.menuHome(tg, db, update); return; }
  if (data === 'menu:back') { await userH.menuBack(tg, db, update); return; }
  if (data.startsWith('menu:page:')) {
    const parts = data.split(':');
    if (parts.length === 4) { await userH.menuPage(tg, db, update); }
    return;
  }
  if (data.startsWith('menu:open:')) { await userH.menuOpen(tg, db, update); return; }
  if (data === 'join:check') { await userH.joinCheck(tg, db, update, env); return; }

  // ─── MESSENGER CALLBACKS ───
  if (data.startsWith('msg:reply:')) {
    const parts = data.split(':');
    const targetUserId = parseInt(parts[2]);
    const mode = parts[3]; // 'normal' or 'anon'
    if (await db.isAdmin(userId)) {
      await messengerH.startReplyToUser(tg, db, userId, targetUserId, mode);
      await tg.answerCallbackQuery(query.id, '📝 پاسخ خود را بنویسید.');
    }
    return;
  }

  if (data.startsWith('msg:block:')) {
    const targetUserId = parseInt(data.split(':')[2]);
    if (await db.isAdmin(userId)) {
      await db.setBlocked(targetUserId, true);
      await tg.answerCallbackQuery(query.id, `🚫 کاربر ${targetUserId} بلاک شد.`);
    }
    return;
  }

  // ─── SUPPORT ───
  if (data === 'support:start') {
    await tg.answerCallbackQuery(query.id, '📝 پیام خود را ارسال کنید.', { show_alert: false });
    return;
  }

  // ─── ADMIN CALLBACKS ───
  if (data.startsWith('admin:')) {
    if (!await db.isAdmin(userId)) { await tg.answerCallbackQuery(query.id, '❌ دسترسی ندارید.', { show_alert: true }); return; }
    await handleAdminCallback(update, env, tg, db);
    return;
  }
}

async function handleAdminCallback(update, env, tg, db) {
  const query = update.callback_query;
  const data = query.data;
  const parts = data.split(':');

  await tg.answerCallbackQuery(query.id);

  if (data === 'admin:panel') { await adminH.adminPanel(tg, db, update, env); return; }
  if (data === 'admin:stats') { await adminH.stats(tg, db, update); return; }

  // Button management
  if (data.startsWith('admin:btn:manage:')) { await adminH.manageButtons(tg, db, update, parseInt(parts[3])); return; }
  if (data.startsWith('admin:btn:add:')) { await adminH.addButtonStart(tg, db, update, parseInt(parts[3])); return; }
  if (data.startsWith('admin:btn:edit:')) { await adminH.editButton(tg, db, update, parseInt(parts[3])); return; }
  if (data.startsWith('admin:btn:rename:')) { await adminH.renameButtonStart(tg, db, update, parseInt(parts[3])); return; }
  if (data.startsWith('admin:btn:toggle:')) { await adminH.toggleButton(tg, db, update, parseInt(parts[3])); return; }
  if (data.startsWith('admin:btn:protect:')) { await adminH.toggleButtonProtect(tg, db, update, parseInt(parts[3])); return; }
  if (data.startsWith('admin:btn:uploaddone:')) { await adminH.toggleButtonUploadDone(tg, db, update, parseInt(parts[3])); return; }
  if (data.startsWith('admin:btn:append:')) { await adminH.contentAppendStart(tg, db, update, parseInt(parts[3])); return; }
  if (data.startsWith('admin:btn:delete:')) { await adminH.deleteButtonConfirm(tg, db, update, parseInt(parts[3])); return; }

  // Upload flow
  if (data === 'admin:upload:finish') { await adminH.uploadConfirmFinish(tg, db, update); return; }
  if (data === 'admin:upload:continue') { await tg.answerCallbackQuery(query.id); return; }
  if (data === 'admin:upload:cancel') { await adminH.uploadCancel(tg, db, update); return; }

  // Feature placeholders
  if (data === 'admin:broadcast:start') { await messengerH.startBroadcast(tg, db, query.from.id); return; }
  if (data === 'admin:ban:menu') { await tg.answerCallbackQuery(query.id, 'از کیبورد پشتیبانی استفاده کنید.', { show_alert: true }); return; }
  if (data === 'admin:forcejoin:menu') { await tg.answerCallbackQuery(query.id, 'موجود نیست.', { show_alert: true }); return; }
  if (data === 'admin:admins:menu') { await tg.answerCallbackQuery(query.id, 'موجود نیست.', { show_alert: true }); return; }
  if (data === 'admin:archive:menu') { await tg.answerCallbackQuery(query.id, 'موجود نیست.', { show_alert: true }); return; }
  if (data === 'admin:backup:menu') { await tg.answerCallbackQuery(query.id, 'موجود نیست.', { show_alert: true }); return; }
  if (data === 'admin:smartarchive:menu') { await tg.answerCallbackQuery(query.id, 'موجود نیست.', { show_alert: true }); return; }
}
