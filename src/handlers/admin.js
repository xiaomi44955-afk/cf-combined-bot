/**
 * Admin handler — combined admin panel for messenger + uploader.
 */
import { adminPanelKeyboard, adminManageButtonsKeyboard, adminEditButtonKeyboard, adminSimpleBackToPanel, adminUploadReplyKeyboard, adminRemoveReplyKeyboard, adminUploadFinishKeyboard, UPLOAD_CMD_FINISH, UPLOAD_CMD_LIST, UPLOAD_CMD_CANCEL, UPLOAD_CONFIRM_CMD_OK, UPLOAD_CONFIRM_CMD_BACK, UPLOAD_CONFIRM_CMD_ABORT } from '../services/keyboard.js';
import { detectContentType, shortKind, buildUploadListText } from '../services/content.js';

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
function isRoot(id) { return id === 0; }
function pendingFiles(data) { return Array.isArray(data.pending_files) ? data.pending_files : []; }

// ═══════════════════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════════════════
export async function adminPanel(tg, db, update, env) {
  const user = update.effective_user;
  const msg = update.effective_message;
  if (!user || !msg) return;
  if (!await db.isAdmin(user.id)) {
    await tg.sendMessage(msg.chat.id, '❌ دسترسی ندارید.');
    return;
  }
  const role = await db.getAdminRole(user.id) || 'admin';
  await tg.sendMessage(msg.chat.id,
    `👨‍💼 <b>پنل مدیریت</b>\n👤 نقش: <b>${role}</b>\n\nیکی از گزینه‌ها را انتخاب کنید:`,
    { reply_markup: adminPanelKeyboard() }
  );
}

// ═══════════════════════════════════════════════════════
// BUTTON MANAGEMENT
// ═══════════════════════════════════════════════════════
export async function manageButtons(tg, db, update, parentId) {
  const query = update.callback_query;
  if (!query) return;
  await tg.answerCallbackQuery(query.id);
  const user = update.effective_user;
  if (!user || !await db.isAdmin(user.id)) return;

  let parentParentId = 0;
  if (parentId !== 0) {
    const b = await db.getButton(parentId);
    parentParentId = b ? (b.parentId || 0) : 0;
  }
  const buttons = await db.listChildrenAdmin(parentId);
  const path = await db.getButtonPath(parentId);
  const title = `📋 <b>مدیریت دکمه‌ها</b>\n${parentId ? `مسیر: <b>${path}</b>\n` : ''}\nروی هر دکمه بزنید تا ویرایش کنید:`;
  await tg.editMessageText(query.message.chat.id, query.message.message_id, title, {
    reply_markup: adminManageButtonsKeyboard(buttons, parentId, parentParentId),
  });
}

export async function addButtonStart(tg, db, update, parentId) {
  const query = update.callback_query;
  if (!query) return;
  await tg.answerCallbackQuery(query.id);
  const user = update.effective_user;
  if (!user || !await db.isAdmin(user.id)) return;
  await db.setUserState(user.id, 'add_button', { parent_id: parentId });
  await tg.sendMessage(query.message.chat.id, '➕ نام دکمه جدید را ارسال کنید:');
}

export async function editButton(tg, db, update, buttonId) {
  const query = update.callback_query;
  if (!query) return;
  await tg.answerCallbackQuery(query.id);
  if (isRoot(buttonId)) {
    await tg.answerCallbackQuery(query.id, '❌ دکمه ROOT سیستمی است.', { show_alert: true });
    return;
  }
  const user = update.effective_user;
  if (!user || !await db.isAdmin(user.id)) return;
  const b = await db.getButton(buttonId);
  if (!b) { await tg.editMessageText(query.message.chat.id, query.message.message_id, '❌ دکمه یافت نشد.', { reply_markup: adminSimpleBackToPanel() }); return; }
  const contents = await db.listButtonContents(buttonId);
  const cnt = contents.length;
  const contentLabel = cnt > 0 ? `${cnt} مورد` : '---';
  const uploadDoneLabel = b.uploadCompleted ? 'تایید شده' : 'تایید نشده';
  const path = await db.getButtonPath(buttonId);
  await tg.editMessageText(query.message.chat.id, query.message.message_id,
    `✏️ <b>ویرایش دکمه</b>\n\nنام: <b>${b.name}</b>\nمسیر: <b>${path}</b>\nوضعیت: <b>${b.isActive ? 'فعال' : 'غیرفعال'}</b>\nخصوصی: <b>${b.protectContent ? 'روشن' : 'خاموش'}</b>\nآپلود: <b>${uploadDoneLabel}</b>\nمحتوا: <b>${contentLabel}</b>`,
    { reply_markup: adminEditButtonKeyboard(b.id, b.parentId, b.isActive, b.protectContent, b.uploadCompleted) }
  );
}

export async function renameButtonStart(tg, db, update, buttonId) {
  const query = update.callback_query;
  if (!query) return;
  await tg.answerCallbackQuery(query.id);
  if (isRoot(buttonId)) return;
  const user = update.effective_user;
  await db.setUserState(user.id, 'rename_button', { button_id: buttonId });
  await tg.sendMessage(query.message.chat.id, '✏️ نام جدید دکمه را ارسال کنید:');
}

export async function toggleButton(tg, db, update, buttonId) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  if (isRoot(buttonId)) return;
  const b = await db.getButton(buttonId); if (!b) return;
  await db.setButtonActive(buttonId, !b.isActive);
  await editButton(tg, db, update, buttonId);
}

export async function toggleButtonProtect(tg, db, update, buttonId) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  if (isRoot(buttonId)) return;
  const b = await db.getButton(buttonId); if (!b) return;
  await db.setButtonProtectContent(buttonId, !b.protectContent);
  await editButton(tg, db, update, buttonId);
}

export async function toggleButtonUploadDone(tg, db, update, buttonId) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  if (isRoot(buttonId)) return;
  const b = await db.getButton(buttonId); if (!b) return;
  await db.setButtonUploadCompleted(buttonId, !b.uploadCompleted);
  await editButton(tg, db, update, buttonId);
}

export async function deleteButtonConfirm(tg, db, update, buttonId) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  if (isRoot(buttonId)) return;
  const b = await db.getButton(buttonId); if (!b) return;
  const user = update.effective_user;
  await db.setUserState(user.id, 'delete_confirm', { button_id: buttonId });
  await tg.sendMessage(query.message.chat.id,
    `⚠️ آیا از حذف '<b>${b.name}</b>' و تمام زیرمجموعه‌ها مطمئنید?\nبرای تایید: <code>حذف</code>`
  );
}

// ═══════════════════════════════════════════════════════
// CONTENT UPLOAD
// ═══════════════════════════════════════════════════════
export async function contentAppendStart(tg, db, update, buttonId) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  if (isRoot(buttonId)) return;
  const user = update.effective_user;
  await db.setUserState(user.id, 'upload_content', { button_id: buttonId, pending_files: [] });
  await tg.sendMessage(query.message.chat.id,
    `📤 آپلود گروهی فعال شد.\nاز دکمه‌های پایین استفاده کنید:\n• ${UPLOAD_CMD_FINISH}\n• ${UPLOAD_CMD_LIST}\n• ${UPLOAD_CMD_CANCEL}`,
    { reply_markup: adminUploadReplyKeyboard() }
  );
}

export async function uploadFinish(tg, db, update) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  const user = update.effective_user;
  const { state, data } = await db.getUserState(user.id);
  if (state !== 'upload_content') return;
  const pending = pendingFiles(data);
  if (pending.length === 0) { await tg.sendMessage(query.message.chat.id, '📭 هیچ فایلی ارسال نشده.'); return; }
  await tg.sendMessage(query.message.chat.id, `📋 ${pending.length} فایل در لیست موقت.\nآیا ذخیره شود?`, { reply_markup: adminUploadFinishKeyboard() });
}

export async function uploadConfirmFinish(tg, db, update) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  const user = update.effective_user;
  const { state, data } = await db.getUserState(user.id);
  if (state !== 'upload_content') return;
  const pending = pendingFiles(data);
  let success = 0, fail = 0;
  for (const item of pending) {
    try { await db.appendButtonContentDirect(data.button_id, item.kind || '', item.text || null, item.file_id || null); success++; } catch { fail++; }
  }
  if (success > 0) await db.setButtonUploadCompleted(data.button_id, false);
  await db.clearUserState(user.id);
  await tg.sendMessage(query.message.chat.id, `✅ ${success} فایل ذخیره شد.${fail > 0 ? `\n❌ ${fail} ناموفق.` : ''}`, { reply_markup: adminRemoveReplyKeyboard() });
}

export async function uploadCancel(tg, db, update) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  const user = update.effective_user;
  await db.clearUserState(user.id);
  await tg.sendMessage(query.message.chat.id, '❎ آپلود لغو شد.', { reply_markup: adminRemoveReplyKeyboard() });
}

// ═══════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════
export async function stats(tg, db, update) {
  const query = update.callback_query;
  if (!query) return; await tg.answerCallbackQuery(query.id);
  const users = await db.countUsers();
  const blocked = await db.countBlockedUsers();
  const buttons = await db.countButtonsWithoutRoot();
  const contents = await db.countTotalButtonContents();
  await tg.sendMessage(query.message.chat.id,
    `📊 <b>آمار کلی</b>\n\n👥 کل کاربران: ${users}\n🚫 بن شده: ${blocked}\n🔘 دکمه‌ها: ${buttons}\n📎 محتواها: ${contents}`
  );
}

// ═══════════════════════════════════════════════════════
// TEXT/FILE FSM HANDLER
// ═══════════════════════════════════════════════════════
export async function handleAdminMessage(tg, db, update, env) {
  const user = update.effective_user;
  const msg = update.effective_message;
  if (!user || !msg) return false;
  if (!await db.isAdmin(user.id)) return false;
  const { state, data } = await db.getUserState(user.id);

  if (state === 'add_button') {
    const name = msg.text?.trim();
    if (!name || name.length > 100) { await tg.sendMessage(msg.chat.id, '⚠️ نام ۱ تا ۱۰۰ کاراکتر.'); return true; }
    const parentId = data.parent_id;
    await db.addButton(parentId === 0 ? null : parentId, name);
    await db.clearUserState(user.id);
    await tg.sendMessage(msg.chat.id, `✅ دکمه «${name}» ساخته شد.`);
    return true;
  }

  if (state === 'rename_button') {
    const name = msg.text?.trim();
    if (!name || name.length > 100) { await tg.sendMessage(msg.chat.id, '⚠️ نام ۱ تا ۱۰۰ کاراکتر.'); return true; }
    await db.setButtonName(data.button_id, name);
    await db.clearUserState(user.id);
    await tg.sendMessage(msg.chat.id, `✅ نام تغییر کرد به «${name}».`);
    return true;
  }

  if (state === 'delete_confirm') {
    if (msg.text?.trim() === 'حذف') {
      await db.deleteButtonTree(data.button_id);
      await db.clearUserState(user.id);
      await tg.sendMessage(msg.chat.id, '✅ حذف شد.');
    } else {
      await db.clearUserState(user.id);
      await tg.sendMessage(msg.chat.id, '❎ حذف لغو شد.');
    }
    return true;
  }

  if (state === 'upload_content') {
    const { kind, text, fileId } = detectContentType(msg);
    if (kind) {
      const pending = pendingFiles(data);
      pending.push({ kind, text, file_id: fileId });
      data.pending_files = pending;
      await db.setUserState(user.id, 'upload_content', data);
      await tg.sendMessage(msg.chat.id, `✅ [${pending.length}] ${shortKind(kind)} اضافه شد.`, { reply_markup: adminUploadReplyKeyboard() });
      return true;
    }
    if (msg.text) {
      if (msg.text === UPLOAD_CMD_FINISH) { await uploadFinish(tg, db, { callback_query: { id: '', message: msg }, effective_user: user }); return true; }
      if (msg.text === UPLOAD_CMD_LIST) { const pending = pendingFiles(data); await tg.sendMessage(msg.chat.id, buildUploadListText(pending)); return true; }
      if (msg.text === UPLOAD_CMD_CANCEL) { await db.clearUserState(user.id); await tg.sendMessage(msg.chat.id, '❎ لغو شد.', { reply_markup: adminRemoveReplyKeyboard() }); return true; }
      if (msg.text === UPLOAD_CONFIRM_CMD_OK) { await uploadConfirmFinish(tg, db, { callback_query: { id: '', message: msg }, effective_user: user }); return true; }
      if (msg.text === UPLOAD_CONFIRM_CMD_BACK) { await tg.sendMessage(msg.chat.id, '↩️ بازگشت.', { reply_markup: adminUploadReplyKeyboard() }); return true; }
      if (msg.text === UPLOAD_CONFIRM_CMD_ABORT) { await db.clearUserState(user.id); await tg.sendMessage(msg.chat.id, '❌ لغو.', { reply_markup: adminRemoveReplyKeyboard() }); return true; }
    }
  }

  return false;
}
