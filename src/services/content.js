/**
 * Content detection and sending service
 * Handles message type detection, content labeling, and media delivery
 */

// ─── Content Type Detection ────────────────────────────────────────

export function detectContentType(message) {
  if (message.photo) {
    const best = message.photo[message.photo.length - 1];
    return { kind: 'photo', text: message.caption || '', fileId: best.file_id };
  }
  if (message.video) {
    return { kind: 'video', text: message.caption || '', fileId: message.video.file_id };
  }
  if (message.video_note) {
    return { kind: 'video_note', text: '', fileId: message.video_note.file_id };
  }
  if (message.voice) {
    return { kind: 'voice', text: message.caption || '', fileId: message.voice.file_id };
  }
  if (message.audio) {
    return { kind: 'audio', text: message.caption || '', fileId: message.audio.file_id };
  }
  if (message.document) {
    return { kind: 'document', text: message.caption || '', fileId: message.document.file_id };
  }
  if (message.animation) {
    return { kind: 'animation', text: message.caption || '', fileId: message.animation.file_id };
  }
  if (message.sticker) {
    return { kind: 'sticker', text: message.sticker.emoji || '', fileId: message.sticker.file_id };
  }
  return { kind: 'text', text: message.text || '', fileId: null };
}

// ─── Persian Labels ────────────────────────────────────────────────

export function shortKind(kind) {
  const labels = {
    text: '📝 متن',
    photo: '🖼 عکس',
    video: '🎬 ویدیو',
    video_note: '⏺ ویدیو دایره‌ای',
    voice: '🎤 صدا',
    audio: '🎵 فایل صوتی',
    document: '📄 فایل',
    animation: '🎞 گیف',
    sticker: '😄 استیکر',
  };
  return labels[kind] || kind;
}

// ─── Upload List Builder ───────────────────────────────────────────

export function buildUploadListText(pending) {
  if (!pending || pending.length === 0) {
    return '📭 لیست آپلود خالی است.\n\nمحتوا ارسال کنید تا به لیست اضافه شود.';
  }

  let text = `📋 *لیست آپلود ({length}/{length})*\n`.replace(/\{length\}/g, String(pending.length));
  text += '─────────────\n\n';

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const num = String(i + 1).padStart(2, '0');
    text += `${num}. ${shortKind(item.kind)}`;
    if (item.text) {
      const preview = item.text.length > 40 ? item.text.substring(0, 40) + '…' : item.text;
      text += ` — ${preview}`;
    }
    text += '\n';
  }

  text += '\n─────────────\n';
  text += '📎 فایل جدید بفرستید یا روی \\[پایان آپلود\\] بزنید.';

  return text;
}

// ─── Content Senders ───────────────────────────────────────────────

export async function sendOneContent(tg, chatId, item, protectContent = false) {
  const opts = protectContent ? { protect_content: true } : {};

  switch (item.kind) {
    case 'text':
      return tg.sendMessage(chatId, item.text, opts);

    case 'photo':
      return tg.sendPhoto(chatId, item.fileId, {
        caption: item.text || undefined,
        parse_mode: undefined,
        ...opts,
      });

    case 'video':
      return tg.sendVideo(chatId, item.fileId, {
        caption: item.text || undefined,
        ...opts,
      });

    case 'video_note':
      return tg.sendVideoNote(chatId, item.fileId, opts);

    case 'voice':
      return tg.sendVoice(chatId, item.fileId, {
        caption: item.text || undefined,
        ...opts,
      });

    case 'audio':
      return tg.sendAudio(chatId, item.fileId, {
        caption: item.text || undefined,
        ...opts,
      });

    case 'document':
      return tg.sendDocument(chatId, item.fileId, {
        caption: item.text || undefined,
        ...opts,
      });

    case 'animation':
      return tg.sendAnimation(chatId, item.fileId, {
        caption: item.text || undefined,
        ...opts,
      });

    case 'sticker':
      return tg.sendSticker(chatId, item.fileId, opts);

    default:
      return tg.sendMessage(chatId, item.text || '⚠️ محتوای ناشناخته', opts);
  }
}

export async function sendButtonContents(tg, chatId, button, contents, protectContent = false) {
  // If button itself has inline content (legacy single-content), send that first
  if (button.content_kind && button.content_file_id) {
    await sendOneContent(tg, chatId, {
      kind: button.content_kind,
      text: button.content_text || '',
      fileId: button.content_file_id,
    }, protectContent);
  }

  // Send all entries from button_contents table, ordered
  if (contents && contents.length > 0) {
    for (const c of contents) {
      await sendOneContent(tg, chatId, {
        kind: c.content_kind,
        text: c.content_text || '',
        fileId: c.content_file_id,
      }, protectContent);
    }
  }
}
