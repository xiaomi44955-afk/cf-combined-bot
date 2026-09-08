/**
 * Database layer — Cloudflare D1 wrapper for Combined Bot.
 * Handles both messenger and uploader features.
 */
export class Database {
  constructor(db) {
    this.db = db;
  }

  // ─── Helpers ───────────────────────────────────────────────
  async _run(sql, ...params) {
    return this.db.prepare(sql).bind(...params).run();
  }
  async _first(sql, ...params) {
    return this.db.prepare(sql).bind(...params).first() ?? null;
  }
  async _all(sql, ...params) {
    const { results } = await this.db.prepare(sql).bind(...params).all();
    return results ?? [];
  }
  async _batch(stmts) {
    return this.db.batch(stmts);
  }

  // ─── Users ─────────────────────────────────────────────────
  async upsertUserBasic(userId, username, firstName, lastName) {
    await this._run(
      `INSERT INTO users (user_id, username, first_name, last_name, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username, first_name = excluded.first_name,
         last_name = excluded.last_name, updated_at = datetime('now')`,
      userId, username ?? null, firstName ?? null, lastName ?? null
    );
  }

  async getUser(userId) {
    return this._first(`SELECT * FROM users WHERE user_id = ?`, userId);
  }

  async isBlocked(userId) {
    const row = await this._first(`SELECT blocked FROM users WHERE user_id = ?`, userId);
    return row ? row.blocked === 1 : false;
  }

  async setBlocked(userId, blocked) {
    await this._run(
      `INSERT INTO users (user_id, blocked, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET blocked = excluded.blocked, updated_at = datetime('now')`,
      userId, blocked ? 1 : 0
    );
  }

  async setChatMode(userId, mode) {
    await this._run(
      `INSERT INTO users (user_id, chat_mode, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET chat_mode = excluded.chat_mode, updated_at = datetime('now')`,
      userId, mode
    );
  }

  async getChatMode(userId) {
    const row = await this._first(`SELECT chat_mode FROM users WHERE user_id = ?`, userId);
    return row ? row.chat_mode : 'normal';
  }

  async getAllActiveUserIds() {
    const rows = await this._all(`SELECT user_id FROM users WHERE blocked = 0`);
    return rows.map(r => r.user_id);
  }

  async countUsers() {
    const row = await this._first(`SELECT COUNT(*) AS cnt FROM users`);
    return row ? row.cnt : 0;
  }

  async countBlockedUsers() {
    const row = await this._first(`SELECT COUNT(*) AS cnt FROM users WHERE blocked = 1`);
    return row ? row.cnt : 0;
  }

  // ─── Admins ────────────────────────────────────────────────
  async ensureAdmin(userId, role = 'admin') {
    await this._run(
      `INSERT INTO admins (user_id, role) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET role = excluded.role`,
      userId, role
    );
  }

  async isAdmin(userId) {
    const row = await this._first(`SELECT 1 FROM admins WHERE user_id = ?`, userId);
    return row !== null;
  }

  async getAdminRole(userId) {
    const row = await this._first(`SELECT role FROM admins WHERE user_id = ?`, userId);
    return row ? row.role : null;
  }

  async listAdmins() {
    return this._all(`SELECT user_id, role FROM admins ORDER BY user_id`);
  }

  async removeAdmin(userId) {
    await this._run(`DELETE FROM admins WHERE user_id = ?`, userId);
  }

  // ─── Forced Channels ──────────────────────────────────────
  async addForcedChannel(channelRef) {
    await this._run(`INSERT OR IGNORE INTO forced_channels (channel_ref) VALUES (?)`, channelRef);
  }

  async removeForcedChannel(channelRef) {
    await this._run(`DELETE FROM forced_channels WHERE channel_ref = ?`, channelRef);
  }

  async listForcedChannels() {
    const rows = await this._all(`SELECT channel_ref FROM forced_channels`);
    return rows.map(r => r.channel_ref);
  }

  // ─── Settings ──────────────────────────────────────────────
  async setSetting(key, value) {
    await this._run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value
    );
  }

  async getSetting(key) {
    const row = await this._first(`SELECT value FROM settings WHERE key = ?`, key);
    return row ? row.value : null;
  }

  // ─── Buttons (Uploader) ────────────────────────────────────
  async ensureRootButton() {
    await this._run(`INSERT OR IGNORE INTO buttons (id, parent_id, name, is_active, order_index) VALUES (0, 0, 'ROOT', 1, 0)`);
  }

  async addButton(parentId, name) {
    const order = await this.getNextOrderIndex(parentId);
    await this._run(`INSERT INTO buttons (parent_id, name, order_index) VALUES (?, ?, ?)`, parentId, name, order);
    const row = await this._first(`SELECT id FROM buttons WHERE parent_id = ? AND name = ? ORDER BY id DESC LIMIT 1`, parentId, name);
    return row ? row.id : null;
  }

  _mapButton(row) {
    if (!row) return null;
    return {
      id: row.id, parentId: row.parent_id, name: row.name,
      isActive: row.is_active === 1, protectContent: row.protect_content === 1,
      uploadCompleted: row.upload_completed === 1, orderIndex: row.order_index,
    };
  }

  async getButton(buttonId) {
    const row = await this._first(`SELECT * FROM buttons WHERE id = ?`, buttonId);
    return this._mapButton(row);
  }

  async listChildren(parentId, includeInactive = false) {
    const where = includeInactive ? `WHERE parent_id = ?` : `WHERE parent_id = ? AND is_active = 1`;
    const rows = await this._all(`SELECT * FROM buttons ${where} ORDER BY order_index, id`, parentId);
    return rows.map(r => this._mapButton(r));
  }

  async listChildrenAdmin(parentId) {
    return this.listChildren(parentId, true);
  }

  async setButtonName(buttonId, name) {
    await this._run(`UPDATE buttons SET name = ? WHERE id = ?`, name, buttonId);
  }

  async setButtonActive(buttonId, active) {
    await this._run(`UPDATE buttons SET is_active = ? WHERE id = ?`, active ? 1 : 0, buttonId);
  }

  async setButtonProtectContent(buttonId, enabled) {
    await this._run(`UPDATE buttons SET protect_content = ? WHERE id = ?`, enabled ? 1 : 0, buttonId);
  }

  async setButtonUploadCompleted(buttonId, completed) {
    await this._run(`UPDATE buttons SET upload_completed = ? WHERE id = ?`, completed ? 1 : 0, buttonId);
  }

  async deleteButtonTree(buttonId) {
    const ids = [];
    const stack = [buttonId];
    while (stack.length > 0) {
      const id = stack.pop();
      ids.push(id);
      const children = await this._all(`SELECT id FROM buttons WHERE parent_id = ?`, id);
      for (const c of children) stack.push(c.id);
    }
    if (ids.length === 0) return;
    const ph = ids.map(() => '?').join(',');
    await this._batch([
      this.db.prepare(`DELETE FROM button_contents WHERE button_id IN (${ph})`, ...ids),
      this.db.prepare(`DELETE FROM buttons WHERE id IN (${ph})`, ...ids),
    ]);
  }

  async getButtonPath(buttonId) {
    const parts = [];
    let cur = buttonId;
    while (cur != null && cur !== 0) {
      const row = await this._first(`SELECT id, name, parent_id FROM buttons WHERE id = ?`, cur);
      if (!row) break;
      parts.unshift(row.name);
      cur = row.parent_id;
    }
    return parts.join(' > ');
  }

  async getNextOrderIndex(parentId) {
    const row = await this._first(`SELECT COALESCE(MAX(order_index), 0) + 1 AS nxt FROM buttons WHERE parent_id = ?`, parentId);
    return row ? row.nxt : 1;
  }

  // ─── Button Contents ──────────────────────────────────────
  async listButtonContents(buttonId) {
    const rows = await this._all(
      `SELECT id, button_id, order_index, created_at, content_kind, content_text, content_file_id, archive_chat_id, archive_message_id
       FROM button_contents WHERE button_id = ? ORDER BY order_index, id`, buttonId
    );
    return rows.map(r => ({
      id: r.id, buttonId: r.button_id, orderIndex: r.order_index, createdAt: r.created_at,
      contentKind: r.content_kind, contentText: r.content_text ?? null,
      contentFileId: r.content_file_id ?? null, archiveChatId: r.archive_chat_id ?? null,
      archiveMessageId: r.archive_message_id ?? null,
    }));
  }

  async buttonHasAnyContent(buttonId) {
    const fromTable = await this._first(`SELECT 1 FROM button_contents WHERE button_id = ? LIMIT 1`, buttonId);
    if (fromTable) return true;
    const row = await this._first(`SELECT content_kind FROM buttons WHERE id = ?`, buttonId);
    return row !== null && row.content_kind != null;
  }

  async clearButtonContents(buttonId) {
    await this._run(`DELETE FROM button_contents WHERE button_id = ?`, buttonId);
  }

  async appendButtonContentDirect(buttonId, kind, text, fileId) {
    const row = await this._first(`SELECT COALESCE(MAX(order_index), 0) + 1 AS nxt FROM button_contents WHERE button_id = ?`, buttonId);
    const order = row ? row.nxt : 0;
    await this._run(
      `INSERT INTO button_contents (button_id, order_index, content_kind, content_text, content_file_id) VALUES (?, ?, ?, ?, ?)`,
      buttonId, order, kind, text ?? null, fileId ?? null
    );
  }

  async countButtonsWithoutRoot() {
    const row = await this._first(`SELECT COUNT(*) AS cnt FROM buttons WHERE id != 0`);
    return row ? row.cnt : 0;
  }

  async countTotalButtonContents() {
    const row = await this._first(`SELECT COUNT(*) AS cnt FROM button_contents`);
    return row ? row.cnt : 0;
  }

  // ─── Support Messages ─────────────────────────────────────
  async insertSupportMessage(userId, text) {
    await this._run(
      `INSERT INTO support_messages (user_id, message_text, status, created_at) VALUES (?, ?, 'pending', datetime('now'))`,
      userId, text
    );
  }

  async handleSupportMessage(id) {
    await this._run(`UPDATE support_messages SET status = 'handled' WHERE id = ?`, id);
  }

  async getPendingSupportMessages() {
    return this._all(`SELECT * FROM support_messages WHERE status = 'pending' ORDER BY created_at`);
  }

  // ─── State Management ─────────────────────────────────────
  async setUserState(userId, state, data = {}) {
    await this._run(
      `INSERT INTO user_states (user_id, state, data, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at`,
      userId, state, JSON.stringify(data)
    );
  }

  async getUserState(userId) {
    const row = await this._first(`SELECT state, data FROM user_states WHERE user_id = ?`, userId);
    if (!row) return { state: null, data: {} };
    return { state: row.state, data: row.data ? JSON.parse(row.data) : {} };
  }

  async clearUserState(userId) {
    await this._run(`DELETE FROM user_states WHERE user_id = ?`, userId);
  }

  // ─── Meta ─────────────────────────────────────────────────
  async getMeta(key) {
    const row = await this._first(`SELECT value FROM meta WHERE key = ?`, key);
    return row ? row.value : null;
  }

  async setMeta(key, value) {
    await this._run(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, value
    );
  }
}
