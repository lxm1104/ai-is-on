import { Router } from 'express';
import { resolveDocs, resolveUsers } from '../util/nameResolver.js';

export const resolveRouter = Router();

/**
 * POST /api/resolve
 * Body: { docUrls?: string[], userOpenIds?: string[] }
 * Resp: {
 *   docs: { [url]: { title, url, token, type } | null },
 *   users: { [openId]: string | null }
 * }
 *
 * Both groups are best-effort: failed individual lookups come back as null
 * so the UI can fall back to the raw token.
 */
resolveRouter.post('/resolve', async (req, res) => {
  const docUrls: string[] = Array.isArray(req.body?.docUrls)
    ? req.body.docUrls.filter((s: unknown) => typeof s === 'string').slice(0, 100)
    : [];
  const userOpenIds: string[] = Array.isArray(req.body?.userOpenIds)
    ? req.body.userOpenIds.filter((s: unknown) => typeof s === 'string').slice(0, 100)
    : [];

  try {
    const [docs, users] = await Promise.all([
      docUrls.length ? resolveDocs(docUrls) : Promise.resolve({}),
      userOpenIds.length ? resolveUsers(userOpenIds) : Promise.resolve({}),
    ]);
    res.json({ docs, users });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
