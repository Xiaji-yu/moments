import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { authPreHandler } from '../auth.js';
import { getProvider, listProviders } from '../services/providers/registry.js';
import { httpErr } from '../util.js';

export const providerRoutes: FastifyPluginAsync = async (app) => {
  // AC-F0-1：列表不含任何 Key
  app.get('/', async () => ({
    providers: listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models,
      defaultModel: p.defaultModel,
    })),
  }));

  // AC-F0-2：连通性测试
  app.post('/:id/test', { preHandler: authPreHandler }, async (req: FastifyRequest, reply: FastifyReply) => {
    const cfg = listProviders().find((p) => p.id === (req.params as { id: string }).id);
    if (!cfg) throw httpErr(404, '供应商不存在');
    const provider = getProvider(cfg.id);
    const image = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const t0 = Date.now();
    try {
      await provider.analyzePhoto({
        imageBase64: image.toString('base64'),
        mime: 'image/jpeg',
        model: cfg.defaultModel,
      });
      return { ok: true, latencyMs: Date.now() - t0, model: cfg.defaultModel };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: String((err as Error).message ?? err) });
    }
  });
};
