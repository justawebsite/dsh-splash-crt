/**
 * 预览用的极简静态服务器。
 * ---------------------------------------------------------------------------
 * 为什么需要它：`file://` 下把本地图片画进 canvas 会**污染画布**，Three.js 读不回
 * 像素 → 平台层（鲸鱼剪影/粒子/终端）根本传不上 GPU，预览就只剩体素字与反色底。
 * 起一个同源 HTTP 服务后，图片与页面同源，一切都正常 —— 这跟真机（宿主用
 * http://127.0.0.1:<port> 提供 /dsh-splash/*）完全一致。
 *
 * 用法：
 *   node tools/preview-server.mjs [port]
 * 然后浏览器打开 http://127.0.0.1:<port>/tools/preview.html
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2]) || 8791

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/') rel = '/tools/preview.html'
    else if (rel === '/preview') rel = '/tools/preview.html'
    const full = path.join(ROOT, rel)
    // 目录穿越防护：必须是 ROOT 之内
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found: ' + rel)
      return
    }
    const bytes = fs.readFileSync(full)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      // no-store alone is not enough: an automated/headless browser with a disk cache
      // will happily keep serving a stale bundle, which makes every change look like
      // it did nothing. Send the full "never cache" set.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'Content-Length': String(bytes.length),
    })
    res.end(bytes)
    console.log(`200 ${rel} (${bytes.length} B)`)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('server error: ' + (err && err.message))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dsh-splash-crt] preview server → http://127.0.0.1:${PORT}/tools/preview.html`)
  console.log('                  root =', ROOT)
})
