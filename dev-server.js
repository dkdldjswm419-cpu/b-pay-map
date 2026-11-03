// 로컬 개발용 서버: Vercel 과 같은 구조(public/ 정적 파일 + api/*.js 함수)를 흉내 낸다.
// 실행: npm run dev  →  http://localhost:3000

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const api = url.pathname.match(/^\/api\/([\w-]+)$/);
    if (api) {
      const file = path.join(ROOT, 'api', `${api[1]}.js`);
      if (!fs.existsSync(file)) return res.writeHead(404).end('Not found');
      try {
        const mod = await import(pathToFileURL(file).href);
        const handler = mod[req.method];
        if (!handler) return res.writeHead(405).end('Method not allowed');
        const response = await handler(new Request(url, { method: req.method, headers: req.headers }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        return res.end(Buffer.from(await response.arrayBuffer()));
      } catch (e) {
        console.error(e);
        return res.writeHead(500).end(String(e));
      }
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return res.writeHead(404).end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => {
    console.log(`비플페이 지도 (개발용): http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) console.warn('⚠ GEMINI_API_KEY 없음: 검색어 해석/업종 분류를 간단한 규칙으로 대신합니다.');
    if (!process.env.SUPABASE_URL) console.warn('⚠ SUPABASE 설정 없음: 구획 캐시와 비플페이 표시 저장이 꺼집니다.');
  });
