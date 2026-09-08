/**
 * Messenger handler — normal + anonymous messaging between users and admin.
 */

// ═══════════════════════════════════════════════════════
// USER: Start messenger section
// ═══════════════════════════════════════════════════════

export async function startMessenger(tg, db, chatId, userId) {
  const { messengerKeyboard } = await import('../services/keyboard.js');
  await tg.sendMessage(chatId,
    `📨 <b>بخش ارسال پیام</b>\n\nیکی از حالت‌های زیر را انتخاب کنید:\n\n` +
    `📨 <b>پیام عادی</b> — اطلاعات شما برای ادمین نمایش داده می‌شود\n` +
    `🎭 <b>پیام ناشناس</b> — پیام شما کاملاً ناشناس ارسال می‌شود`,
    { reply_markup: messengerKeyboard() }
  );
}

// ═══════════════════════════════════════════════════════
// USER: Handle normal message
// ═══════════════════════════════════════════════════════

export async function handleNormalMessage(tg, db, msg, userId, chatId, text) {
  const firstName = msg.from?.first_name || '';
  const username = msg.from?.username || '';

  await db.setChatMode(userId, 'normal');
  await db.clearUserState(userId);

  // Send to admin
  const adminId = parseInt(db._adminId || '0');
  if (adminId) {
    await tg.sendMessage(adminId,
      `📨 <b>پیام جدید (عادی)</b>\n\n👤 نام: ${firstName}\n📌 یوزرنیم: ${username ? '@' + username : 'ندارد'}\n🆔 آیدی: ${userId}\n\n💬 پیام:\n${text}`
    , {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '✅ پاسخ', callback_data: `msg:reply:${userId}:normal` }],
          [{ text: '🚫 بلاک', callback_data: `msg:block:${userId}` }],
        ],
      }),
    });
  }

  await tg.sendMessage(chatId,
    `✅ پیام شما با موفقیت به مدیریت ارسال شد.\n⏳ لطفاً منتظر پاسخ باشید.`,
    { reply_markup: JSON.stringify({ remove_keyboard: true }) }
  );
}

// ═══════════════════════════════════════════════════════
// USER: Handle anonymous message
// ═══════════════════════════════════════════════════════

export async function handleAnonymousMessage(tg, db, msg, userId, chatId, text) {
  await db.setChatMode(userId, 'anonymous');
  await db.clearUserState(userId);

  const adminId = parseInt(db._adminId || '0');
  if (adminId) {
    await tg.sendMessage(adminId,
      `🎭 <b>پیام ناشناس جدید</b>\n\n⚠️ اطلاعات فرستنده مخفی است\n\n💬 پیام:\n${text}`
    , {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '✅ پاسخ', callback_data: `msg:reply:${userId}:anon` }],
        ],
      }),
    });
  }

  await tg.sendMessage(chatId,
    `✅ پیام شما <b>ناشناس</b> به مدیریت ارسال شد.\n⏳ لطفاً منتظر پاسخ باشید.`,
    { reply_markup: JSON.stringify({ remove_keyboard: true }) }
  );
}

// ═══════════════════════════════════════════════════════
// ADMIN: Reply to user
// ═══════════════════════════════════════════════════════

export async function startReplyToUser(tg, db, adminId, targetUserId, mode) {
  const stateData = { target_user: targetUserId, mode: mode };
  await db.setUserState(adminId, 'replying_messenger', stateData);
  await tg.sendMessage(adminId,
    `📝 لطفاً پاسخ خود را بنویسید:\n\n🎯 پاسخ به کاربر: ${targetUserId}\n📋 حالت: ${mode === 'anon' ? 'ناشناس' : 'عادی'}`,
    { reply_markup: JSON.stringify({ keyboard: [[{ text: 'لغو' }]], resize_keyboard: true }) }
  );
}

export async function handleAdminReply(tg, db, adminId, chatId, text) {
  const { state, data } = await db.getUserState(adminId);
  if (state !== 'replying_messenger') return false;

  const targetUserId = data.target_user;
  const mode = data.mode;
  await db.clearUserState(adminId);

  const prefix = mode === 'anon' ? '🎭' : '📨';
  await tg.sendMessage(targetUserId,
    `${prefix} <b>پاسخ از طرف پشتیبانی:</b>\n\n${text}`
  );

  await tg.sendMessage(chatId, '✅ پاسخ شما ارسال شد.', {
    reply_markup: JSON.stringify({ remove_keyboard: true }),
  });
  return true;
}

// ═══════════════════════════════════════════════════════
// ADMIN: Broadcast
// ═══════════════════════════════════════════════════════

export async function startBroadcast(tg, db, adminId) {
  await db.setUserState(adminId, 'broadcasting', {});
  await tg.sendMessage(adminId,
    `📝 پیام خود را برای ارسال همگانی وارد کنید:`,
    { reply_markup: JSON.stringify({ keyboard: [[{ text: 'لغو' }]], resize_keyboard: true }) }
  );
}

export async function handleBroadcast(tg, db, adminId, chatId, text) {
  await db.clearUserState(adminId);
  const userIds = await db.getAllActiveUserIds();
  let success = 0, failed = 0;

  for (const uid of userIds) {
    if (uid === adminId) continue;
    try {
      await tg.sendMessage(uid, `📣 <b>پیام از طرف مدیریت:</b>\n\n${text}`);
      success++;
    } catch { failed++; }
  }

  await tg.sendMessage(chatId,
    `📣 <b>نتیجه ارسال همگانی:</b>\n\n✅ موفق: ${success}\n❌ ناموفق: ${failed}`,
    { reply_markup: JSON.stringify({ remove_keyboard: true }) }
  );
}
