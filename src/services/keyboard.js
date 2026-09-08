/**
 * Keyboard builders — all Telegram InlineKeyboardMarkup factories
 * User keyboards, admin keyboards, menu navigation, upload controls
 */

// ─── Constants ─────────────────────────────────────────────────────

export const HOME = '__home__';
export const BACK = '__back__';

// Upload reply keyboard commands
export const UPLOAD_CMD_FINISH   = '__upload_finish__';
export const UPLOAD_CMD_LIST     = '__upload_list__';
export const UPLOAD_CMD_CANCEL   = '__upload_cancel__';

// Upload confirmation commands
export const UPLOAD_CONFIRM_CMD_OK     = '__upload_confirm_ok__';
export const UPLOAD_CONFIRM_CMD_BACK   = '__upload_confirm_back__';
export const UPLOAD_CONFIRM_CMD_ABORT  = '__upload_confirm_abort__';

const PAGE_SIZE = 21;

// ─── Helpers ───────────────────────────────────────────────────────

function cb(data) {
  return { callback_data: data };
}

// ─── USER KEYBOARDS ────────────────────────────────────────────────

export function mainUserKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📨 بخش ارسال پیام', callback_data: 'menu:messenger' }],
      [{ text: '📚 بخش محتوای آموزشی', callback_data: 'menu:content' }],
      [{ text: '🆘 پشتیبانی', callback_data: 'menu:support' }],
    ],
  };
}

export function messengerKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📨 پیام عادی', callback_data: 'msg:normal' }],
      [{ text: '🎭 پیام ناشناس', callback_data: 'msg:anonymous' }],
      [{ text: '🔙 بازگشت', callback_data: `nav:${HOME}` }],
    ],
  };
}

/**
 * Content menu keyboard with pagination
 * Pattern: 2-1-2-1 (two buttons, one back, two buttons, one back/pager)
 * parentId: 0 = root content menu
 */
export function menuKeyboard(buttons, parentId = 0, showSupport = false, page = 0) {
  const keyboard = [];

  if (!buttons || buttons.length === 0) {
    // Empty folder — just show back
    keyboard.push([{ text: '🔙 بازگشت', callback_data: `nav:${parentId || HOME}` }]);
    return { inline_keyboard: keyboard };
  }

  const totalPages = Math.ceil(buttons.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const slice = buttons.slice(start, start + PAGE_SIZE);

  // Layout: 2-1-2-1 pattern — rows of 2, then a lone button, repeat
  let idx = 0;
  while (idx < slice.length) {
    const remaining = slice.length - idx;

    // Row of 2
    if (remaining >= 2) {
      keyboard.push([
        { text: slice[idx].name, callback_data: `nav:${slice[idx].id}` },
        { text: slice[idx + 1].name, callback_data: `nav:${slice[idx + 1].id}` },
      ]);
      idx += 2;
    } else {
      // Lone button centered
      keyboard.push([
        { text: slice[idx].name, callback_data: `nav:${slice[idx].id}` },
      ]);
      idx += 1;
    }

    // Lone row (1) — separator or next pair
    if (idx < slice.length) {
      keyboard.push([
        { text: slice[idx].name, callback_data: `nav:${slice[idx].id}` },
      ]);
      idx += 1;
    }
  }

  // Navigation row: back + optional pager
  const navRow = [];
  navRow.push({ text: '🔙 بازگشت', callback_data: `nav:${parentId || HOME}` });

  if (totalPages > 1) {
    if (page > 0) {
      navRow.push({ text: '◀️', callback_data: `pg:${parentId}:${page - 1}` });
    }
    if (page < totalPages - 1) {
      navRow.push({ text: '▶️', callback_data: `pg:${parentId}:${page + 1}` });
    }
  }
  keyboard.push(navRow);

  // Support link at bottom
  if (showSupport) {
    keyboard.push([{ text: '🆘 پشتیبانی', callback_data: 'menu:support' }]);
  }

  return { inline_keyboard: keyboard };
}

// ─── ADMIN KEYBOARDS ───────────────────────────────────────────────

export function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📋 مدیریت محتوا', callback_data: 'admin:content' }],
      [{ text: '📨 مدیریت پیام‌ها', callback_data: 'admin:messenger' }],
      [{ text: '📊 آمار کلی', callback_data: 'admin:stats' }],
      [{ text: '🚫 بن/آزادسازی', callback_data: 'admin:ban' }],
      [{ text: '📣 پیام همگانی', callback_data: 'admin:broadcast' }],
      [{ text: '📌 عضویت اجباری', callback_data: 'admin:forcejoin' }],
      [{ text: '👥 مدیریت ادمین‌ها', callback_data: 'admin:admins' }],
    ],
  };
}

/**
 * Admin content management keyboard — list buttons in a folder
 * parentId: the folder we're viewing (0 = root)
 * parentParentId: parent of parentId (for back navigation)
 */
export function adminManageButtonsKeyboard(buttons, parentId = 0, parentParentId = 0) {
  const keyboard = [];

  if (buttons && buttons.length > 0) {
    // Two buttons per row
    for (let i = 0; i < buttons.length; i += 2) {
      const row = [];
      const b = buttons[i];
      const statusIcon = b.is_active ? '🟢' : '🔴';
      row.push({ text: `${statusIcon} ${b.name}`, callback_data: `admin:btn:${b.id}` });

      if (i + 1 < buttons.length) {
        const b2 = buttons[i + 1];
        const statusIcon2 = b2.is_active ? '🟢' : '🔴';
        row.push({ text: `${statusIcon2} ${b2.name}`, callback_data: `admin:btn:${b2.id}` });
      }
      keyboard.push(row);
    }
  }

  // Action row: add new button
  keyboard.push([
    { text: '➕ اضافه کردن دکمه', callback_data: `admin:addbtn:${parentId}` },
  ]);

  // Navigation
  keyboard.push([
    { text: '🔙 بازگشت', callback_data: parentId === 0 ? 'admin:content' : `admin:folder:${parentParentId}` },
  ]);

  return { inline_keyboard: keyboard };
}

/**
 * Admin edit button keyboard — actions for a specific button
 */
export function adminEditButtonKeyboard(buttonId, parentId = 0, isActive = true, isProtected = false, isUploadCompleted = false) {
  const keyboard = [
    [
      { text: '✏️ نام', callback_data: `admin:editname:${buttonId}` },
      { text: isActive ? '🔴 غیرفعال' : '🟢 فعال', callback_data: `admin:toggle:${buttonId}` },
    ],
    [
      { text: isProtected ? '🔓 بدون حفاظت' : '🔒 محافظت محتوا', callback_data: `admin:toggleprotect:${buttonId}` },
      { text: '📊 محتوا', callback_data: `admin:contents:${buttonId}` },
    ],
    [
      { text: '⬆️ آپلود محتوا', callback_data: `admin:upload:${buttonId}` },
    ],
  ];

  if (isUploadCompleted) {
    keyboard.push([
      { text: '🗑 حذف محتوا', callback_data: `admin:clearcontents:${buttonId}` },
    ]);
  }

  keyboard.push([
    { text: '🗑 حذف دکمه', callback_data: `admin:delbtn:${buttonId}` },
  ]);

  keyboard.push([
    { text: '🔙 بازگشت', callback_data: parentId === 0 ? 'admin:content' : `admin:folder:${parentId}` },
  ]);

  return { inline_keyboard: keyboard };
}

// ─── ADMIN REPLY KEYBOARDS (ForceReply / remove) ──────────────────

/**
 * Reply keyboard shown during upload mode
 * Users see this as a persistent reply keyboard
 */
export function adminUploadReplyKeyboard() {
  return {
    keyboard: [
      [{ text: '✅ پایان آپلود' }, { text: '📋 لیست آپلود' }],
      [{ text: '❌ لغو آپلود' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/**
 * Remove the reply keyboard (back to inline-only mode)
 */
export function adminRemoveReplyKeyboard() {
  return {
    remove_keyboard: true,
  };
}

/**
 * Simple back-to-panel inline button
 */
export function adminSimpleBackToPanel() {
  return {
    inline_keyboard: [
      [{ text: '🔙 بازگشت به پنل', callback_data: 'admin:panel' }],
    ],
  };
}

/**
 * Upload finish confirmation — inline confirm/cancel for pending upload
 */
export function adminUploadFinishKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ تأیید و ارسال', callback_data: UPLOAD_CONFIRM_CMD_OK },
        { text: '🔙 بازگشت', callback_data: UPLOAD_CONFIRM_CMD_BACK },
      ],
      [
        { text: '❌ لغو کل آپلود', callback_data: UPLOAD_CONFIRM_CMD_ABORT },
      ],
    ],
  };
}

// ─── FORCED JOIN KEYBOARD ──────────────────────────────────────────

/**
 * Show forced-join channels with subscribe buttons
 * channels: array of channel_ref strings (e.g., '@channel' or 'https://t.me/...')
 */
export function forcedJoinKeyboard(channels) {
  const keyboard = [];

  for (const ch of channels) {
    const label = ch.startsWith('@') ? ch : ch.replace(/^https?:\/\/t\.me\//, '@');
    keyboard.push([{ text: `📣 ${label}`, url: ch.startsWith('http') ? ch : `https://t.me/${ch.replace('@', '')}` }]);
  }

  keyboard.push([{ text: '✅ بررسی عضویت', callback_data: 'forcedjoin:check' }]);

  return { inline_keyboard: keyboard };
}
