import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { migrate } from './migrate.js';

fs.mkdirSync(path.join(config.dataDir, 'users'), { recursive: true });

export const db = new Database(path.join(config.dataDir, 'moments.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 表结构全部由 migrate.ts 的版本化迁移维护（加列/加表都走那里，不要在这里写 DDL）
export const schemaVersion = migrate(db);
