import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export function sessionDir(userId: number, sessionId: string): string {
  return path.join(config.dataDir, 'users', String(userId), sessionId);
}

export function photoDir(userId: number, sessionId: string, photoId: string): string {
  return path.join(sessionDir(userId, sessionId), photoId);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
