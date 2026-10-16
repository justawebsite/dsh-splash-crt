/**
 * dsh-splash-crt —— 宿主半区（Node）
 * ---------------------------------------------------------------------------
 * 职责只有三件：
 *   1. 经 `webserver/index-inject` 注册一条**内联 script 行**，让页面侧自举加载
 *      浏览器半区（注入行的加载失败由我们自己吞掉，绝不让宿主因为本插件起不来）；
 *   2. 用 `webServer` 提供静态资源路由：客户端脚本 + 设置 JSON；
 *   3. 把可配置项（启用开关、退出方式、开机时长、反色扫掠的开始时刻与一程时长、
 *      扫描线强度）通过 `/dsh-splash/settings.json` 下发给浏览器半区。
 *
 * 浏览器半区不做成 `dsh.client` 客户端插件：那是给 React 槽位组件用的通道，
 * 而开屏需要的是一块盖在整页之上、能抢在首帧之前隐藏界面的自挂载浮层。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

/**
 * schemastery 由宿主（DSH 运行时）提供，但**必须自己找到它**。
 *
 * 本插件在 profile 里是一条 `link:` 依赖，真实路径可能落在 DSH 安装树之外
 * （Windows 盘符 / WSL 的 /mnt/d、或任意工作区目录），此时 Node 从插件目录
 * 逐级向上找 node_modules 根本看不到 `@deepseek-ai/*`。
 *
 * 旧实现在解析失败时把 `Config` 降级成普通默认值对象，而 cordis 的
 * `resolveConfig()` 只认 Standard Schema：
 *   if (!runtime.Config) return config
 *   runtime.Config['~standard'].validate(config)   // ← 普通对象在这里炸
 * 于是激活阶段直接抛
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 * 插件整条 entry 不激活（`1 entry did not activate`）。
 *
 * 现在按「离运行时最近」的顺序尝试多个解析基准，并且**每个候选都做 ~standard
 * 自检**；全都拿不到时宁可不导出 Config（cordis 会跳过校验，apply() 里已有
 * DEFAULTS 兜底），也绝不再导出一个会让宿主崩溃的假 Config。
 */
const SCHEMA_BASES = [
  // ① 宿主 dsh 入口所在的安装树 —— 与运行时同一份 schemastery，首选
  (() => {
    const entry = process.argv?.[1]
    return entry && path.isAbsolute(entry) ? pathToFileURL(entry).href : null
  })(),
  // ② 插件自身的解析链（插件目录里装了依赖，或被装进 DSH 安装树时）
  import.meta.url,
  // ③ profile 目录（profile 的 node_modules 里有依赖时）
  process.env.DSH_PROFILE_DIR
    ? pathToFileURL(path.join(process.env.DSH_PROFILE_DIR, 'package.json')).href
    : null,
]

function loadSchemastery() {
  for (const base of SCHEMA_BASES) {
    if (!base) continue
    try {
      const loaded = createRequire(base)('@deepseek-ai/schemastery')
      const lib = loaded?.default ?? loaded
      if (typeof lib?.object !== 'function') continue
      // 只接受 cordis resolveConfig 能消费的实例（Standard Schema 接口）
      if (typeof lib.object({})?.['~standard']?.validate !== 'function') continue
      return lib
    } catch (err) {
      // 换下一个候选
    }
  }
  return null
}

const z = loadSchemastery()

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_BUNDLE = path.join(PACKAGE_ROOT, 'lib', 'client.js')
const ROUTE = '/dsh-splash'

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
}

/**
 * 页面侧自举行（内联 script 行）：自己建 <script> 拉 /dsh-splash/client.js。
 *
 * 从 lib/bootstrap.js 读模板而不是把脚本内联成模板字符串：一是脚本本身可读可校验，
 * 二是**装载时就校验语法**——之前内联的一版有语法错误，注入行一推出去宿主就抛
 * 异常、页面还被 visibility:hidden 藏着，表现就是"插件没反应 + 控制台异常"。
 * 另外加载失败一律静默吞掉并把界面放回来，绝不让宿主因为这个插件起不来。
 */
const BOOTSTRAP_ROW_TEXT = (() => {
  const file = path.join(PACKAGE_ROOT, 'lib', 'bootstrap.js')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    console.warn('[dsh-splash-crt] bootstrap.js missing:', err && err.message)
    return null
  }
  const script = text.split('@@ROUTE@@').join(ROUTE)
  // 语法自检：宁可不注入，也不能把一段坏脚本推给页面
  try {
    // eslint-disable-next-line no-new-func
    new Function(script)
  } catch (err) {
    console.warn('[dsh-splash-crt] bootstrap.js failed syntax check:', err && err.message)
    return null
  }
  return script
})()

export const name = 'dsh-splash-crt'

/** 默认配置；schemastery 不可用时由 apply() 直接合并它（见文件开头说明）。 */
const DEFAULTS = {
  enabled: true,
  skipMode: 'any',
  fadeOutMs: 600,
  bootMs: 1400,
  wipeStartMs: 5000,
  wipeMs: 14000,
  wipeHoldMs: 5000,
  scanlineIntensity: 1,
}

/**
 * 只在拿到真正的 Standard Schema 时才导出 Config。
 * cordis 的 resolveConfig 只认 Standard Schema：导出普通对象会崩在
 * `['~standard'].validate` 上，整条 entry 起不来；而少一层校验、apply() 里
 * 仍有 DEFAULTS 兜底。两害相权，宁可不导出 Config。
 */
const ConfigSchema = z
  ? z.object({
      enabled: z.boolean().default(true).description('是否启用开屏动画'),
      skipMode: z.union([z.const('any'), z.const('click'), z.const('key')]).default('any')
        .description('退出方式：any 点击或按键、click 仅点击、key 仅按键'),
      fadeOutMs: z.number().default(600).description('收屏淡出时长（毫秒）'),
      bootMs: z.number().default(1400).description('显像管点亮（灯丝预热）时长（毫秒）'),
      wipeStartMs: z.number().default(5000)
        .description('页面加载完成后多久开始反色扫掠（毫秒）'),
      wipeMs: z.number().min(800).default(14000)
        .description('反色分界线扫过整屏一程的时长（毫秒）；白/黑交替，如此循环'),
      wipeHoldMs: z.number().min(0).default(5000)
        .description('每一程扫完之后停留多久，分界线才再次出现（毫秒）；全白与复原成黑各停一次'),
      scanlineIntensity: z.number().min(0).max(2).default(1).description('扫描线强度倍率'),
    })
  : null

export const Config =
  ConfigSchema && typeof ConfigSchema['~standard']?.validate === 'function'
    ? ConfigSchema
    : undefined

export function apply(root, config = {}) {
  const settings = { ...DEFAULTS, ...config }

  // ① 注入行注册：apply 一进来就做，不依赖任何服务（桌面端注入表可能只收集一次）。
  root.effect(() => root.on('webserver/index-inject', (table) => {
    try {
      if (!BOOTSTRAP_ROW_TEXT) return
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        // 去重标记用自举行里的固定常量（ROUTE 在脚本里是变量，字面量匹配不到）
        if (row.kind === 'script-src' && typeof row.src === 'string' && row.src.indexOf(ROUTE) === 0) return
        if (row.kind === 'script' && typeof row.text === 'string'
          && row.text.indexOf('__DSH_SPLASH_CRT__') >= 0) return
      }
      table.push({ kind: 'script', placement: 'body', text: BOOTSTRAP_ROW_TEXT })
    } catch (err) {
      try { root.logger?.warn?.('[dsh-splash-crt] index-inject row failed:', err?.message || err) } catch (e) {}
    }
  }))

  // ② 其余逻辑等 webServer 就绪（等价于对象级 inject，但不会推迟 ①）。
  root.inject(['webServer'], (ctx) => {
    const disposers = []

    const sendJson = (res, value) => {
      const body = Buffer.from(JSON.stringify(value), 'utf8')
      res.writeHead(200, {
        'Content-Type': MIME['.json'],
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length),
      })
      res.end(body)
    }

    // register() 对重复 (kind,path) 会直接抛；路由冲突是组合层的问题，
    // 但不能让它把整条 entry 拖垮——记一条日志继续挂其余路由。
    const register = (route) => {
      try {
        disposers.push(ctx.webServer.register(route))
      } catch (err) {
        try { ctx.logger?.warn?.(`[dsh-splash-crt] route ${route.path} not registered:`, err?.message || err) } catch (e) {}
      }
    }

    register({
      kind: 'exact',
      path: `${ROUTE}/client.js`,
      handler: (req, res) => {
        try {
          const bytes = fs.readFileSync(CLIENT_BUNDLE)
          const rev = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
          res.writeHead(200, {
            'Content-Type': MIME['.js'],
            'Cache-Control': 'no-store',
            'X-Splash-Rev': rev,
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`splash client bundle missing: run "npm run build" in ${PACKAGE_ROOT}`)
        }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/settings.json`,
      handler: (req, res) => {
        sendJson(res, { ...settings, version: '0.2.0' })
      },
    })

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch (err) {}
      }
    })

    try {
      console.log(`[dsh-splash-crt] ready (enabled=${settings.enabled !== false}) — routes under ${ROUTE}/`)
    } catch (err) {}
  })
}

export default { name, Config, apply }
