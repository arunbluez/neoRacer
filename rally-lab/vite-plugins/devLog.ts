// Dev-only endpoints that let the phone stream its log into the repo while it
// is plugged into the laptop (`adb reverse tcp:5173 tcp:5173`).
//
//   GET  /__log            -> 200 {ok:true}; the app uses it to detect the dev server
//   POST /__log            -> body {sessionId, events:[...]}; appended to logs/<sessionId>.jsonl
//   POST /__artifact       -> body {sessionId, path, encoding:'utf8'|'base64', data}
//                             written to logs/<sessionId>/<path>

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/;

function readBody(req: IncomingMessage, limit = 50 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Resolves `rel` inside `dir`, refusing anything that escapes it. */
export function safeJoin(dir: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const target = path.resolve(dir, rel);
  const root = path.resolve(dir) + path.sep;
  return target.startsWith(root) ? target : null;
}

export function devLogPlugin(opts: { dir?: string } = {}): Plugin {
  let logDir = '';
  return {
    name: 'rally-lab-dev-log',
    apply: 'serve',
    configResolved(config) {
      logDir = path.resolve(config.root, opts.dir ?? 'logs');
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (url !== '/__log' && url !== '/__artifact') return next();
        try {
          if (req.method === 'GET' && url === '/__log') {
            return send(res, 200, { ok: true, dir: logDir });
          }
          if (req.method !== 'POST') return send(res, 405, { error: 'method' });
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const sessionId = String(body.sessionId ?? '');
          if (!SAFE_ID.test(sessionId)) return send(res, 400, { error: 'bad sessionId' });
          fs.mkdirSync(logDir, { recursive: true });

          if (url === '/__log') {
            const events = Array.isArray(body.events) ? body.events : [];
            if (events.length > 0) {
              const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
              fs.appendFileSync(path.join(logDir, `${sessionId}.jsonl`), lines);
            }
            return send(res, 200, { ok: true, n: events.length });
          }

          const rel = String(body.path ?? '');
          const target = safeJoin(path.join(logDir, sessionId), rel);
          if (!target) return send(res, 400, { error: 'bad path' });
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const data = String(body.data ?? '');
          fs.writeFileSync(target, body.encoding === 'base64' ? Buffer.from(data, 'base64') : data);
          return send(res, 200, { ok: true, path: path.relative(logDir, target) });
        } catch (err) {
          return send(res, 500, { error: String(err) });
        }
      });
    },
  };
}
