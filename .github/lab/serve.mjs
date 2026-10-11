import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2]; const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/upload') {            // stand-in for Foundry's persistent upload
    const name = path.basename(u.searchParams.get('name') || 'file.bin'); const dir = path.join(root, 'media/uploads'); fs.mkdirSync(dir, { recursive: true });
    const out = fs.createWriteStream(path.join(dir, name)); req.pipe(out); out.on('finish', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ path: `media/uploads/${name}` })); }); return;
  }
  const p = path.join(root, decodeURIComponent(u.pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(p).size; const h = { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) { const s = +m[1], e = m[2] ? +m[2] : size - 1; res.writeHead(206, { ...h, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 }); fs.createReadStream(p, { start: s, end: e }).pipe(res); }
  else { res.writeHead(200, { ...h, 'Content-Length': size }); fs.createReadStream(p).pipe(res); }
}).listen(Number(process.argv[3] || 8766));
