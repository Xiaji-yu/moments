import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, migrations } from '../../src/migrate.js';

function freshDb(): Database.Database {
  return new Database(':memory:');
}

const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );

const columnNames = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);

describe('migrate（版本化迁移）', () => {
  it('首次应用全部迁移并记录版本', () => {
    const db = freshDb();
    const version = migrate(db);
    expect(version).toBe(migrations[migrations.length - 1].version);
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
      version: number;
    }>;
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    db.close();
  });

  it('幂等：重复执行不报错、不重复记录', () => {
    const db = freshDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(c).toBe(migrations.length);
    db.close();
  });

  it('建齐全部业务表（含 crop_jobs）', () => {
    const db = freshDb();
    migrate(db);
    const tables = tableNames(db);
    for (const t of [
      'users',
      'sessions',
      'photos',
      'analyses',
      'crop_suggestions',
      'crops',
      'captions',
      'model_usage',
      'crop_jobs',
      'schema_migrations',
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('后续迁移加上了 sessions.title 与 analyses.feedback', () => {
    const db = freshDb();
    migrate(db);
    expect(columnNames(db, 'sessions')).toContain('title');
    expect(columnNames(db, 'analyses')).toContain('feedback');
    db.close();
  });

  it('老库（0.x 无迁移记录）首次启动可安全补齐且不丢数据', () => {
    // 模拟 0.x 老数据目录：只有 v1 的表、没有任何 schema_migrations 记录、且已有数据
    const db = freshDb();
    db.exec(
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         username TEXT UNIQUE NOT NULL,
         password_hash TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       );`,
    );
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('old_user', 'hash');

    expect(() => migrate(db)).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c).toBe(1);
    // 老库被补齐到最新版本
    expect(columnNames(db, 'sessions')).toContain('title');
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(c).toBe(migrations.length);
    db.close();
  });
});
