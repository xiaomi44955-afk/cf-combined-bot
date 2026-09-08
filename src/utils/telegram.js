// Telegram Bot API helper — fetch-based, token-bound via bindToken()
// All methods POST JSON to api.telegram.org. Parse mode defaults to HTML.
// Errors are logged but never thrown — callers always get a response object.

const BASE = 'https://api.telegram.org';

function bindToken(token) {
  const url = (method) => `${BASE}/bot${token}/${method}`;

  // Generic JSON POST helper
  async function api(method, body) {
    try {
      const res = await fetch(url(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (err) {
      console.error(`[TG] ${method} error:`, err);
      return { ok: false, error_code: 0, description: err.message };
    }
  }

  // Generic multipart/form-data POST helper (for file uploads)
  async function apiMultipart(method, form) {
    try {
      const res = await fetch(url(method), {
        method: 'POST',
        body: form,
      });
      return await res.json();
    } catch (err) {
      console.error(`[TG] ${method} error:`, err);
      return { ok: false, error_code: 0, description: err.message };
    }
  }

  // Check if a value looks like a file_id (starts with 'Ag' for photos, 'BA' for documents, etc.)
  // or a URL or a Buffer/Uint8Array
  function isFileId(val) {
    return typeof val === 'string' && !val.startsWith('http') && !val.startsWith('/');
  }

  // Build FormData for file-sending methods. Attaches file as 'document' field
  // if it's a Buffer/Uint8Array, or sends the file_id/URL string directly.
  function buildFileForm(method, chatId, fileField, fileValue, opts = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));

    if (fileValue instanceof Uint8Array || fileValue instanceof ArrayBuffer || typeof fileValue === 'string') {
      if (fileValue instanceof Uint8Array || fileValue instanceof ArrayBuffer) {
        form.append(fileField, new Blob([fileValue]), opts.fileName || 'file');
      } else if (typeof fileValue === 'string' && !isFileId(fileValue)) {
        // It's a URL — pass as string, TG will fetch it
        form.append(fileField, fileValue);
      } else {
        // file_id string
        form.append(fileField, fileValue);
      }
    } else {
      form.append(fileField, String(fileValue));
    }

    // Merge remaining opts into the form
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'fileName') continue; // internal use only
      if (v !== undefined && v !== null) {
        form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }
    return form;
  }

  return {
    /**
     * sendMessage(chatId, text, opts={})
     * Send a text message. parse_mode defaults to HTML.
     */
    async sendMessage(chatId, text, opts = {}) {
      return api('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: opts.parse_mode ?? 'HTML',
        ...opts,
      });
    },

    /**
     * editMessageText(chatId, messageId, text, opts={})
     * Edit a previously sent message.
     */
    async editMessageText(chatId, messageId, text, opts = {}) {
      return api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: opts.parse_mode ?? 'HTML',
        ...opts,
      });
    },

    /**
     * answerCallbackQuery(callbackQueryId, text='', showAlert=false)
     * Answer an inline keyboard callback.
     */
    async answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
      return api('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert,
      });
    },

    /**
     * sendDocument(chatId, document, opts={})
     * Send a file (file_id, URL, or Uint8Array/Buffer).
     */
    async sendDocument(chatId, document, opts = {}) {
      const form = buildFileForm('sendDocument', chatId, 'document', document, opts);
      return apiMultipart('sendDocument', form);
    },

    /**
     * sendPhoto(chatId, photo, opts={})
     */
    async sendPhoto(chatId, photo, opts = {}) {
      const form = buildFileForm('sendPhoto', chatId, 'photo', photo, opts);
      return apiMultipart('sendPhoto', form);
    },

    /**
     * sendVideo(chatId, video, opts={})
     */
    async sendVideo(chatId, video, opts = {}) {
      const form = buildFileForm('sendVideo', chatId, 'video', video, opts);
      return apiMultipart('sendVideo', form);
    },

    /**
     * sendAudio(chatId, audio, opts={})
     */
    async sendAudio(chatId, audio, opts = {}) {
      const form = buildFileForm('sendAudio', chatId, 'audio', audio, opts);
      return apiMultipart('sendAudio', form);
    },

    /**
     * sendVoice(chatId, voice, opts={})
     */
    async sendVoice(chatId, voice, opts = {}) {
      const form = buildFileForm('sendVoice', chatId, 'voice', voice, opts);
      return apiMultipart('sendVoice', form);
    },

    /**
     * sendSticker(chatId, sticker, opts={})
     */
    async sendSticker(chatId, sticker, opts = {}) {
      // Stickers are always file_id or URL, never uploaded as raw bytes typically
      if (typeof sticker === 'string') {
        return api('sendSticker', {
          chat_id: chatId,
          sticker,
          ...opts,
        });
      }
      const form = buildFileForm('sendSticker', chatId, 'sticker', sticker, opts);
      return apiMultipart('sendSticker', form);
    },

    /**
     * sendAnimation(chatId, animation, opts={})
     */
    async sendAnimation(chatId, animation, opts = {}) {
      const form = buildFileForm('sendAnimation', chatId, 'animation', animation, opts);
      return apiMultipart('sendAnimation', form);
    },

    /**
     * copyMessage(chatId, fromChatId, messageId, opts={})
     * Copy a message without the sender header.
     */
    async copyMessage(chatId, fromChatId, messageId, opts = {}) {
      return api('copyMessage', {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId,
        ...opts,
      });
    },

    /**
     * forwardMessage(chatId, fromChatId, messageId)
     * Forward a message with the sender header.
     */
    async forwardMessage(chatId, fromChatId, messageId) {
      return api('forwardMessage', {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId,
      });
    },

    /**
     * deleteMessage(chatId, messageId)
     */
    async deleteMessage(chatId, messageId) {
      return api('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      });
    },
  };
}

export { bindToken };
export default bindToken;
