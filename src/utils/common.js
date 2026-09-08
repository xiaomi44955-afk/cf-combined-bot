// Common utilities for cf-combined-bot

/**
 * normalizeDigits(str) - Replace Persian/Arabic numerals with Latin equivalents.
 * Handles both Persian (۰۱۲۳۴۵۶۷۸۹) and Arabic (٠١٢٣٤٥٦٧٨٩) digit sets.
 */
function normalizeDigits(str) {
  if (typeof str !== 'string') return String(str);
  const persian = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  const arabic = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  return str.replace(/[۰-۹٠-٩]/g, (d) => {
    const pIdx = persian.indexOf(d);
    if (pIdx !== -1) return String(pIdx);
    const aIdx = arabic.indexOf(d);
    if (aIdx !== -1) return String(aIdx);
    return d;
  });
}

/**
 * parsePositiveInt(str) - Parse a string to a positive integer (NaN if invalid).
 * Normalizes Persian/Arabic digits first, then parses. Returns null for zero/negative.
 */
function parsePositiveInt(str) {
  const normalized = normalizeDigits(String(str).trim());
  const n = parseInt(normalized, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * isAdmin(env, userId) - Check if a user ID is an admin.
 * Checks MAIN_ADMIN_ID first, then comma-separated ADMIN_IDS list.
 */
function isAdmin(env, userId) {
  const id = String(userId);
  // Check main admin
  if (env.MAIN_ADMIN_ID && String(env.MAIN_ADMIN_ID) === id) return true;
  // Check admin list
  if (env.ADMIN_IDS) {
    const admins = env.ADMIN_IDS.split(',').map((s) => s.trim());
    if (admins.includes(id)) return true;
  }
  return false;
}

/**
 * detectContentType(message) - Inspect a Telegram message and return { kind, text, fileId }.
 * kind: 'text' | 'photo' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' |
 *        'animation' | 'animation' | 'reply' | 'forward' | 'unknown'
 * text: text content or caption, if present
 * fileId: the file_id of the media, if present
 */
function detectContentType(message) {
  if (!message) return { kind: 'unknown', text: '', fileId: null };

  // Text-only message
  if (message.text) {
    return { kind: 'text', text: message.text, fileId: null };
  }

  // Caption helper — check caption or caption_entities
  const caption = message.caption || '';

  if (message.photo) {
    // Telegram sends multiple sizes; take the largest (last in array)
    const largest = message.photo[message.photo.length - 1];
    return { kind: 'photo', text: caption, fileId: largest.file_id };
  }

  if (message.video) {
    return { kind: 'video', text: caption, fileId: message.video.file_id };
  }

  if (message.audio) {
    return { kind: 'audio', text: caption, fileId: message.audio.file_id };
  }

  if (message.voice) {
    return { kind: 'voice', text: caption, fileId: message.voice.file_id };
  }

  if (message.document) {
    return { kind: 'document', text: caption, fileId: message.document.file_id };
  }

  if (message.sticker) {
    return { kind: 'sticker', text: message.sticker.emoji || '', fileId: message.sticker.file_id };
  }

  if (message.animation) {
    return { kind: 'animation', text: caption, fileId: message.animation.file_id };
  }

  if (message.video_note) {
    return { kind: 'video_note', text: '', fileId: message.video_note.file_id };
  }

  if (message.location) {
    return { kind: 'location', text: `${message.location.latitude},${message.location.longitude}`, fileId: null };
  }

  if (message.contact) {
    return { kind: 'contact', text: message.contact.phone_number || '', fileId: null };
  }

  if (message.reply_to_message) {
    // Recurse into the replied message to detect its content
    const inner = detectContentType(message.reply_to_message);
    return { kind: 'reply', text: inner.text, fileId: inner.fileId, replyTo: inner.kind };
  }

  if (message.forward_from || message.forward_from_chat) {
    const fwd = detectContentType(message);
    if (fwd.kind !== 'forward') {
      return { kind: 'forward', text: fwd.text, fileId: fwd.fileId, forwardOf: fwd.kind };
    }
  }

  return { kind: 'unknown', text: '', fileId: null };
}

/**
 * formatSize(bytes) - Format byte count into human-readable string.
 * Uses 1024 base (binary units).
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const idx = Math.min(i, units.length - 1);
  const value = bytes / Math.pow(1024, idx);
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

/**
 * parseChatRef(raw) - Parse a chat reference which can be:
 * - numeric chat ID (e.g., "123456" or "-100123456")
 * - username (e.g., "@mychannel" or "mychannel")
 * - chat URL (e.g., "https://t.me/mychannel")
 *
 * Returns { chatId, type } where type is 'id' | 'username' | 'url'
 */
function parseChatRef(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // URL: extract the username part
  const urlMatch = trimmed.match(/(?:https?:\/\/)?t\.me\/(?:joinchat\/)?(\+?\w+)/);
  if (urlMatch) {
    return { chatId: urlMatch[1], type: 'url' };
  }

  // Username with or without @
  if (/^@?\w{5,}$/.test(trimmed)) {
    const username = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    return { chatId: username, type: 'username' };
  }

  // Pure numeric ID (may be negative for groups, or -100 for supergroups)
  const numMatch = trimmed.match(/^-?\d+$/);
  if (numMatch) {
    return { chatId: Number(trimmed), type: 'id' };
  }

  return null;
}

export {
  normalizeDigits,
  parsePositiveInt,
  isAdmin,
  detectContentType,
  formatSize,
  parseChatRef,
};
