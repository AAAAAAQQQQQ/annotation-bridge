// 极简静态服务，给测试用
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(here, 'page.html')));
}).listen(8899, '127.0.0.1', () => console.log('test page: http://127.0.0.1:8899'));
