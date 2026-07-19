import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function decodeKey(value) {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('ROUTER_OUTBOX_ENCRYPTION_KEY must be 32 bytes encoded as base64 or hex');
  }
  return key;
}

function encryptJson(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptJson(key, row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAuthTag(row.tag);
  return JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'));
}

export function createEncryptedOutbox(config, projectId, options = {}) {
  const now = options.now || Date.now;
  const key = decodeKey(config.encryptionKey);
  const projectDir = path.join(config.rootDir, projectId);
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(projectDir, 0o700);
  const dbPath = path.join(projectDir, 'outbox.sqlite');
  const db = new Database(dbPath);
  fs.chmodSync(dbPath, 0o600);
  db.pragma('journal_mode = WAL');
  db.exec(`
    create table if not exists callback_outbox (
      id text primary key,
      ciphertext blob not null,
      iv blob not null,
      tag blob not null,
      attempts integer not null default 0,
      next_attempt_at integer not null,
      created_at integer not null,
      expires_at integer not null,
      last_error_class text
    );
    create index if not exists callback_outbox_due_idx
      on callback_outbox (next_attempt_at, expires_at);
  `);

  const insert = db.prepare(`
    insert into callback_outbox
      (id, ciphertext, iv, tag, attempts, next_attempt_at, created_at, expires_at)
    values
      (@id, @ciphertext, @iv, @tag, 0, @createdAt, @createdAt, @expiresAt)
    on conflict(id) do nothing
  `);
  const selectDue = db.prepare(`
    select * from callback_outbox
    where next_attempt_at <= ? and expires_at > ?
    order by created_at asc
    limit ?
  `);
  const remove = db.prepare('delete from callback_outbox where id = ?');
  const expire = db.prepare('delete from callback_outbox where expires_at <= ?');
  const fail = db.prepare(`
    update callback_outbox
    set attempts = attempts + 1,
        next_attempt_at = @nextAttemptAt,
        last_error_class = @errorClass
    where id = @id
  `);

  return {
    enqueue(event) {
      const createdAt = now();
      const encrypted = encryptJson(key, event);
      return insert.run({
        id: event.requestId,
        ...encrypted,
        createdAt,
        expiresAt: createdAt + config.retentionMs
      }).changes > 0;
    },
    due(limit = 10) {
      const current = now();
      return selectDue.all(current, current, limit).map((row) => ({
        id: row.id,
        event: decryptJson(key, row),
        attempts: row.attempts
      }));
    },
    delivered(id) {
      remove.run(id);
    },
    failed(id, attempts, error) {
      const delay = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(attempts, 6)));
      fail.run({
        id,
        nextAttemptAt: now() + delay,
        errorClass: error?.name || 'Error'
      });
    },
    purgeExpired() {
      return expire.run(now()).changes;
    },
    close() {
      db.close();
    }
  };
}
