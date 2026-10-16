import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.join(config.dataDir, 'users'), { recursive: true });

export const db = new Database(path.join(config.dataDir, 'moments.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
`);
