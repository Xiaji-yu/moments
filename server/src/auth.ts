import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { httpErr } from './util.js';

export interface AuthUser {
  id: number;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, {
    expiresIn: '7d',
  });
}

export function requireAuth(req: FastifyRequest): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw httpErr(401, '未登录');
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as unknown as {
      sub: number;
      username: string;
    };
    req.user = { id: Number(payload.sub), username: payload.username };
  } catch {
    throw httpErr(401, '登录已过期，请重新登录');
  }
}

export const authPreHandler = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  requireAuth(req);
};
