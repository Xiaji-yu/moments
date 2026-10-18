import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  /** 可执行多条语句；包在事务里应用 */
  up: string;
}

/**
 * 版本化迁移。db.ts 启动时调用 migrate(db)。
 *
 * 注意 v1 用 CREATE TABLE IF NOT EXISTS：这样 0.x 时期「无迁移记录的老数据目录」
 * 首次启动也能安全补齐（DDL 幂等），随后写入 version 1 记录，之后即可走 ALTER 演进。
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'mock',
  model      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  filename   TEXT NOT NULL,
  hash       TEXT NOT NULL,
  phash      TEXT NOT NULL,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  taken_at   TEXT NOT NULL,
  has_exif   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'ready',
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_session ON photos(session_id);

CREATE TABLE IF NOT EXISTS analyses (
  photo_id   TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL,
  tags       TEXT NOT NULL,
  issues     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  raw        TEXT,
  model      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crop_suggestions (
  photo_id   TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  ratio      TEXT NOT NULL,
  box_x      REAL NOT NULL,
  box_y      REAL NOT NULL,
  box_w      REAL NOT NULL,
  box_h      REAL NOT NULL,
  reasoning  TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crops (
  photo_id   TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  ratio      TEXT NOT NULL,
  box_x      REAL NOT NULL,
  box_y      REAL NOT NULL,
  box_w      REAL NOT NULL,
  box_h      REAL NOT NULL,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS captions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  items      TEXT NOT NULL,
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  photo_id      TEXT,
  kind          TEXT NOT NULL,
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON model_usage(session_id);
`,
  },
  {
    version: 2,
    name: 'crop_jobs',
    up: `
CREATE TABLE IF NOT EXISTS crop_jobs (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  cancelled   INTEGER NOT NULL DEFAULT 0,
  running     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  },
  {
    version: 3,
    name: 'session_title',
    up: `ALTER TABLE sessions ADD COLUMN title TEXT;`,
  },
  {
    version: 4,
    name: 'analysis_feedback',
    up: `ALTER TABLE analyses ADD COLUMN feedback INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // 建议的算法版本 + 一致性警告：旧版本（含 mock 时代）的建议在下次生成时自动重算，
    // 前端也能据此提示「这条建议来自旧版本/旧模型」。
    version: 5,
    name: 'crop_suggestion_version',
    up: `
ALTER TABLE crop_suggestions ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crop_suggestions ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
`,
  },
];

/** 应用所有未执行的迁移，返回当前 schema 版本 */
export function migrate(db: Database.Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  let current = 0;
  for (const m of migrations) {
    if (applied.has(m.version)) {
      current = m.version;
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    apply();
    current = m.version;
  }
  return current;
}
