/**
 * dsh-splash-crt - browser half (self-bootstrapping script, mounts itself to the DOM)
 * ---------------------------------------------------------------------------
 * One screen, on purpose. The CRT plate stays up until the user presses a key or
 * clicks, and while it waits it plays a looping inversion wipe: a diagonal boundary
 * travels from the lower-left corner to the upper-right one, flipping everything
 * behind it to white; once the plate is fully inverted the same boundary travels
 * again and flips it back to black. See `wipeAt()` for the schedule and the
 * fragment shader for the mask.
 *
 * NOTE: all comments are ASCII on purpose - this file must survive editors and
 *       tooling that are not UTF-8 clean.
 */

const ROUTE = '/dsh-splash'
const MARK = '__DSH_SPLASH_CRT__'
const win = window

/**
 * Preview mode: the real environment is a same-origin HTTP page served by the
 * host; a preview page has no host routes to read, so it falls back to local
 * files (and to built-in defaults when even that is unavailable).
 * Detection: explicit `?preview=1`, a file:// document, or the preview config
 * global the preview pages hand over - the global is the reliable signal, since
 * a plain `/preview` URL without the query parameter used to run in "real" mode
 * (pointer capture on, drawing buffer released) and made the pixel probe lie.
 */
const PREVIEW = (() => {
  try {
    if (win.location?.protocol === 'file:') return true
    if (win.__DSH_SPLASH_PREVIEW__) return true
    return new URLSearchParams(win.location?.search || '').get('preview') === '1'
  } catch (e) {
    return false
  }
})()

function assetUrl(name) {
  if (!PREVIEW) return `${ROUTE}/${name}`
  try { return new URL(`../${name}`, win.location.href).href } catch (e) { return name }
}

function previewParams() {
  try { return new URLSearchParams(win.location?.search || '') } catch (e) { return new URLSearchParams('') }
}

if (win[MARK] && win[MARK].state === 'done') {
  // already released once (hot reload / repeated injection): do not cover the page again
} else {
  start().catch((err) => {
    try { console.warn('[dsh-splash-crt] failed:', err) } catch (e) {}
    unlock()
  })
}

function unlock() {
  try {
    const html = document.documentElement
    if (html) {
      html.style.visibility = ''
      html.removeAttribute('data-dsh-splash-locked')
    }
  } catch (e) {}
  try { if (win[MARK]) win[MARK].state = 'done' } catch (e) {}
}

async function start() {
  const settings = await loadSettings()
  if (settings.enabled === false) {
    win[MARK] = { state: 'disabled' }
    unlock()
    return
  }
  run(settings)
}

async function loadSettings() {
  const fallback = {
    enabled: true,
    skipMode: 'any',
    fadeOutMs: 600,
    bootMs: 1400,
    wipeStartMs: 5000,
    wipeMs: 14000,
    wipeHoldMs: 5000,
    scanlineIntensity: 1,
  }
  const glob = PREVIEW ? win.__DSH_SPLASH_PREVIEW__ : null
  try {
    const res = glob ? null : await fetch(
      PREVIEW ? assetUrl('preview-settings.json') : `${ROUTE}/settings.json`,
      { cache: 'no-store' },
    )
    if (res && !res.ok) return fallback
    const parsed = glob || await res.json()
    return { ...fallback, ...parsed }
  } catch (err) {
    return { ...fallback, ...(glob || {}) }
  }
}

function run(cfg) {
  const state = {
    phase: 'screen1',
    t: 0,
    phaseT: 0,
    // ms since the tube lit: drives the warm-up and the inversion wipe. Deliberately
    // NOT reset by a phase change, or the exit fade would restart the warm-up and
    // blank the plate mid-fade.
    plateMs: 0,
    width: 0, height: 0, dpr: 1,
    skipArmed: false,
  }
  win[MARK] = { state: 'playing', api: { skip: () => requestExit('api') } }

  let skipMode = cfg.skipMode || 'any'
  // Every numeric knob goes through `num`: a host that has not been restarted yet
  // serves an older settings.json, and `Number(undefined) ?? fallback` is NaN, not
  // the fallback - which would silently stop the sweep from ever starting.
  const fadeOutSec = Math.max(0.1, num(cfg.fadeOutMs, 600) / 1000)
  const scanMul = clamp(num(cfg.scanlineIntensity, 1), 0, 2)
  // `screen1Ms` is the retired name for the CRT warm-up; accept it so a page reload
  // against a host that has not been restarted yet still gets a sane boot ramp.
  let bootMs = Math.max(400, num(cfg.bootMs, num(cfg.screen1Ms, 1400)))
  let wipeStartMs = Math.max(0, num(cfg.wipeStartMs, 5000))
  let wipeMs = Math.max(800, num(cfg.wipeMs, 14000))
  // How long each fully swept plate (white, and back to black) stays put before the
  // boundary enters again. Applied to BOTH polarities.
  let wipeHoldMs = Math.max(0, num(cfg.wipeHoldMs, 5000))

  // ------------------------------------------------------------------ DOM shell
  // A preview page may mount the overlay into a container (?mount=#id) so it does
  // not cover the preview's own controls and diagnostics.
  let mountHost = document.body || document.documentElement
  let mountBox = false
  if (PREVIEW) {
    const sel = previewParams().get('mount')
    if (sel) {
      try {
        const found = document.querySelector(sel)
        if (found) { mountHost = found; mountBox = true }
      } catch (e) { /* invalid selector: keep the default */ }
    }
  }
  const rootEl = document.createElement('div')
  rootEl.setAttribute('data-dsh-splash-root', '1')
  Object.assign(rootEl.style, {
    position: mountBox ? 'absolute' : 'fixed',
    ...(mountBox ? { left: '0', top: '0', width: '100%', height: '100%' } : { inset: '0' }),
    zIndex: '2147483000',
    background: '#000', cursor: 'none', overflow: 'hidden',
    // A preview page needs its own sliders to stay clickable, so the splash must not
    // swallow pointer events there. Real mounts keep them and own the whole page.
    pointerEvents: PREVIEW ? 'none' : 'auto',
    touchAction: 'none',
    opacity: '1', transition: `opacity ${fadeOutSec}s ease-out`,
    contain: 'strict',
  })
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block',
  })
  rootEl.appendChild(canvas)

  // ------------------------------------------------------------------ pipeline
  // Platform layer (2D, the drawing everyone sees) -> texture -> one fragment
  // shader (warp / dispersion / scanlines / band / noise / vignette / wipe).
  const plat = document.createElement('canvas')
  const pctx = plat.getContext('2d', { alpha: true })
  const crt = createCrtPass(canvas, PREVIEW)
  if (!crt) throw new Error('WebGL unavailable')
  document.documentElement.style.visibility = ''
  mountHost.appendChild(rootEl)

  function resize() {
    const w = rootEl.clientWidth || win.innerWidth
    const h = rootEl.clientHeight || win.innerHeight
    state.width = w
    state.height = h
    state.dpr = Math.min(1.5, win.devicePixelRatio || 1)
    // Internal render resolution is capped around 1600px wide on purpose: the CRT
    // grain wants chunky pixels, and it keeps the frame budget comfortable.
    const scale = Math.min(1, 1600 / Math.max(1, w))
    const cw = Math.max(640, Math.round(w * scale))
    const ch = Math.max(360, Math.round(h * scale))
    plat.width = cw
    plat.height = ch
    crt.resize(cw, ch)
  }
  const onResize = () => resize()
  win.addEventListener('resize', onResize)

  // --------------------------------------------------------------------- input
  const onKey = (e) => {
    if (PREVIEW) return                 // the preview page drives the timeline
    if (!state.skipArmed) return
    if (e.key === 'F5' || e.key === 'F12' || (e.ctrlKey && e.shiftKey)) return
    e.preventDefault(); e.stopPropagation()
    if (skipMode === 'click') return
    requestExit('key')
  }
  const onPointer = (e) => {
    if (PREVIEW) return                 // the preview page drives the timeline
    e.preventDefault(); e.stopPropagation()
    if (!state.skipArmed) return
    if (skipMode === 'key') return
    requestExit('pointer')
  }
  const stopAll = (e) => {
    if (PREVIEW) return
    e.preventDefault(); e.stopPropagation()
  }
  win.addEventListener('keydown', onKey, true)
  win.addEventListener('pointerdown', onPointer, true)
  win.addEventListener('mousedown', onPointer, true)
  win.addEventListener('touchstart', onPointer, { capture: true, passive: false })
  win.addEventListener('wheel', stopAll, { capture: true, passive: false })
  win.addEventListener('contextmenu', stopAll, true)

  function requestExit(reason) {
    if (state.phase === 'exiting' || state.phase === 'done') return
    state.phase = 'exiting'
    state.phaseT = 0
    rootEl.style.opacity = '0'
    try { rootEl.style.cursor = 'default' } catch (e) {}
    void reason
  }

  function teardown() {
    if (state.phase === 'done') return
    state.phase = 'done'
    win.removeEventListener('resize', onResize)
    win.removeEventListener('keydown', onKey, true)
    win.removeEventListener('pointerdown', onPointer, true)
    win.removeEventListener('mousedown', onPointer, true)
    win.removeEventListener('touchstart', onPointer, true)
    win.removeEventListener('wheel', stopAll, true)
    win.removeEventListener('contextmenu', stopAll, true)
    try { crt.dispose() } catch (e) {}
    try { rootEl.remove() } catch (e) {}
    unlock()
    try { console.log('[dsh-splash-crt] finished') } catch (e) {}
  }

  // -------------------------------------------------------------------- startup
  resize()
  let raf = 0
  let frozen = false
  let last = win.performance ? win.performance.now() : Date.now()
  const frame = () => {
    if (frozen) return
    raf = win.requestAnimationFrame(frame)
    const now = win.performance ? win.performance.now() : Date.now()
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    state.t += dt
    state.phaseT += dt
    state.plateMs += dt * 1000
    update(dt)
    render()
    if (state.phase === 'done') win.cancelAnimationFrame(raf)
  }
  raf = win.requestAnimationFrame(frame)

  // ------------------------------------------------- preview / capture debug API
  let holdTimer = 0

  /**
   * Pixel self-check: read the main canvas, report coverage and key samples, and
   * export both the composite and the platform layer as data URLs. Headless screen
   * capture is unreliable for WebGL, so this is the authoritative check.
   */
  function pixelProbe() {
    const out = { size: `${canvas.width}x${canvas.height}` }
    try {
      out.platform = plat.toDataURL('image/png')
      const pp = document.createElement('canvas')
      pp.width = 240; pp.height = 135
      const pg = pp.getContext('2d')
      pg.drawImage(plat, 0, 0, 240, 135)
      const pd = pg.getImageData(0, 0, 240, 135).data
      let lit = 0
      for (let i = 0; i < pd.length; i += 4) {
        if (pd[i + 3] > 20 && (pd[i] + pd[i + 1] + pd[i + 2]) / 3 > 40) lit += 1
      }
      out.platformLitShare = +((lit / (240 * 135)) * 100).toFixed(1)
    } catch (err) {
      out.platformError = err && err.message
    }
    try {
      const p = document.createElement('canvas')
      p.width = 240; p.height = 135
      const g = p.getContext('2d')
      g.drawImage(canvas, 0, 0, 240, 135)
      const d = g.getImageData(0, 0, 240, 135).data
      let white = 0, black = 0, mid = 0
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3
        if (l > 200) white += 1
        else if (l < 40) black += 1
        else mid += 1
      }
      const total = d.length / 4
      out.pixels = {
        white: +((white / total) * 100).toFixed(1),
        black: +((black / total) * 100).toFixed(1),
        mid: +((mid / total) * 100).toFixed(1),
      }
      out.phase = { phase: state.phase, phaseT: +state.phaseT.toFixed(2) }
      out.canvas = `${canvas.width}x${canvas.height}`
      out.dataUrl = canvas.toDataURL('image/png')
    } catch (err) {
      out.error = err && err.message
    }
    return out
  }

  win[MARK].debug = {
    pixelProbe,
    /** Current phase, clock and wipe state - the preview page reads this. */
    info() {
      const w = wipeAt(state.plateMs)
      return {
        phase: state.phase,
        t: state.t,
        phaseT: state.phaseT,
        plateMs: state.plateMs,
        wipe: { pass: w.pass, u: +w.u.toFixed(3), flip: w.flip, active: w.active, holding: w.holding },
        bootMs, wipeStartMs, wipeMs, wipeHoldMs,
      }
    },
    /** Stop the timeline at once (frame holds, never tears itself down). */
    pauseRaf() {
      if (frozen) return this.info()
      frozen = true
      win.cancelAnimationFrame(raf)
      render()
      return this.info()
    },
    /** Jump to a phase/time and render one frame, holding the timeline. */
    freezeAt(phase, seconds) {
      frozen = true
      win.cancelAnimationFrame(raf)
      const wanted = ['screen1', 'exiting'].includes(phase) ? phase : 'screen1'
      if (state.phase !== wanted) {
        state.phase = wanted
        state.skipArmed = true
      }
      state.phaseT = Math.max(0, Number(seconds) || 0)
      state.plateMs = state.phaseT * 1000
      render()
      // The compiled pipeline needs one more render (shader/texture upload) before
      // the canvas holds a real image; a frozen client has no animation loop to do it.
      render()
      return this.info()
    },
    resume() {
      if (!frozen) return
      frozen = false
      last = win.performance ? win.performance.now() : Date.now()
      raf = win.requestAnimationFrame(frame)
    },
    set(patch) {
      if (!patch || typeof patch !== 'object') return
      if (typeof patch.skipMode === 'string') skipMode = patch.skipMode
      if (typeof patch.bootMs === 'number') bootMs = Math.max(400, patch.bootMs)
      if (typeof patch.wipeStartMs === 'number') wipeStartMs = Math.max(0, patch.wipeStartMs)
      if (typeof patch.wipeMs === 'number') wipeMs = Math.max(800, patch.wipeMs)
      if (typeof patch.wipeHoldMs === 'number') wipeHoldMs = Math.max(0, patch.wipeHoldMs)
      render()
    },
    skip: () => requestExit('debug'),
  }

  // ?freeze=screen1:8 renders that instant and stops
  const freezeParam = previewParams().get('freeze')
  if (freezeParam) {
    const [phaseRaw, secRaw] = String(freezeParam).split(':')
    const phase = ['screen1', 'exiting'].includes(phaseRaw) ? phaseRaw : 'screen1'
    win[MARK].debug.freezeAt(phase, Number(secRaw) || 0)
  }
  // ?hold=screen1:8 holds that instant after a delay (frames for headless capture)
  const holdParam = previewParams().get('hold')
  if (holdParam) {
    const [phaseRaw, secRaw] = String(holdParam).split(':')
    const phase = ['screen1', 'exiting'].includes(phaseRaw) ? phaseRaw : 'screen1'
    const at = Number(secRaw) || 0
    holdTimer = win.setTimeout(() => {
      win[MARK].debug.freezeAt(phase, at)
    }, Number(previewParams().get('holdMs')) || 2000)
  }
  void holdTimer
  // ?pause=1 stops the timeline as soon as the first frame is drawn
  if (previewParams().get('pause') === '1') win[MARK].debug.pauseRaf()

  // --------------------------------------------------------------------- update
  function update() {
    if (state.phase === 'screen1') {
      // Any key may dismiss the plate, but not within the first blink or an
      // accidental keypress during the warm-up would skip the whole thing.
      state.skipArmed = state.phaseT * 1000 >= Math.min(700, bootMs * 0.5)
    } else if (state.phase === 'exiting') {
      if (state.phaseT >= fadeOutSec) teardown()
    }
  }

  // ---------------------------------------------------------------------- draw
  function render() {
    // A live exit happens long after the warm-up; a scrubbed one may not, so clamp
    // the warm-up to "done" while exiting.
    const ms = state.phase === 'exiting' ? Math.max(state.plateMs, bootMs) : state.plateMs
    const boot = bootLevel(ms, bootMs)
    const wipe = wipeAt(ms)
    const levels = state.phase === 'exiting'
      ? clamp(1 - state.phaseT / fadeOutSec, 0, 1)
      : 1

    drawScreen1(pctx, plat.width, plat.height, state, {
      ms, boot, bootMs,
    })
    crt.render({
      texture: plat,
      aspect: plat.width / Math.max(1, plat.height),
      res: [plat.width, plat.height],
      time: state.t,
      warp: 0.06 * boot.level,
      scan: 0.26 * scanMul,
      vignette: 0.55,
      levels,
      wipe: wipe.threshold(plat.width / Math.max(1, plat.height)),
      wipeFlip: wipe.flip,
      wipeOn: wipe.edge,
    })
  }

  /**
   * The inversion schedule. Before `wipeStartMs` nothing happens. After that:
   *
   *   [ white sweep wipeMs ] [ hold wipeHoldMs ] [ black sweep wipeMs ] [ hold wipeHoldMs ] -> repeat
   *
   * The boundary always travels lower-left -> upper-right; even passes paint the
   * swept area white (invert), odd passes paint it back to black (restore). Every
   * pass is followed by a hold: the boundary parks past the far corner, its glow
   * fades out, and the plate simply sits at that polarity for `wipeHoldMs` - white
   * after the inverting pass, black after the restoring one.
   */
  function wipeAt(ms) {
    const local = ms - wipeStartMs
    if (local < 0) {
      return { active: false, holding: false, pass: 0, u: 0, flip: 0, edge: 0, threshold: () => -Infinity }
    }
    const span = wipeMs + wipeHoldMs
    const period = span * 2
    const cycle = Math.floor(local / period)
    const r = local - cycle * period
    let pass, flip, u, holding = false
    if (r < wipeMs) {
      pass = cycle * 2
      flip = 0
      u = r / wipeMs
    } else if (r < span) {
      pass = cycle * 2
      flip = 0
      u = 1
      holding = true
    } else if (r < span + wipeMs) {
      pass = cycle * 2 + 1
      flip = 1
      u = (r - span) / wipeMs
    } else {
      pass = cycle * 2 + 1
      flip = 1
      u = 1
      holding = true
    }
    return {
      active: true,
      holding,
      pass,
      u,
      flip,
      // Fade the boundary glow out at both extremes: otherwise the 2% overshoot
      // parks a static cyan smear in a corner (most visible during the hold).
      edge: smoothstep(0, 0.045, Math.min(u, 1 - u)),
      // iso space: x is aspect-corrected, so the boundary runs at 45 degrees on
      // screen and x + y spans [-aspect - 1, aspect + 1]. A 2% overshoot on both
      // ends guarantees "nothing swept" / "everything swept".
      threshold(aspect) {
        const rad = aspect + 1
        return -rad * 1.02 + u * rad * 2.04
      },
    }
  }
}

/* =========================================================================
 * CRT composite pass (raw WebGL)
 * ====================================================================== */

/**
 * The whole browser half used to pull in Three.js (~480 KiB) to draw ONE
 * full-screen quad, because the second screen needed a real scene graph. That
 * screen is gone, so this is the same fragment shader on plain WebGL: same
 * pipeline, ~30x smaller bundle.
 */
function createCrtPass(canvas, preserveDrawingBuffer) {
  const attrs = {
    alpha: false,
    antialias: true,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: !!preserveDrawingBuffer,
    powerPreference: 'high-performance',
  }
  const gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs)
  if (!gl) return null

  const VS = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `
  const FS = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform float uWarp;      // barrel distortion amount
    uniform float uAspect;
    uniform vec2  uRes;
    uniform float uVignette;
    uniform float uScan;
    uniform float uTime;
    uniform float uLevels;    // exit fade
    uniform float uWipe;      // inversion boundary position in iso space
    uniform float uWipeFlip;  // 0 = this pass paints white, 1 = paints black
    uniform float uWipeOn;    // 0 until the first pass starts (hides the boundary)

    vec2 warp(vec2 uv, float k) {
      if (k <= 0.0001) return uv;
      vec2 c = uv * 2.0 - 1.0;
      c.x *= uAspect;
      float r2 = dot(c, c);
      c *= 1.0 + k * r2;
      c.x /= uAspect;
      return c * 0.5 + 0.5;
    }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 uv = warp(vUv, uWarp);
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      float ca = 0.0022 * (0.35 + uWarp * 6.0);
      vec2 dir = normalize(vec2(uv.x - 0.5, uv.y - 0.5) + 1e-5);
      vec3 col;
      col.r = texture2D(uTex, uv + dir * ca).r;
      col.g = texture2D(uTex, uv).g;
      col.b = texture2D(uTex, uv - dir * ca).b;
      float band = smoothstep(0.0, 0.12, abs(fract(uv.y * 0.5 + uTime * 0.06) - 0.5));
      float lines = 0.5 + 0.5 * sin(uv.y * uRes.y * 3.14159);
      col *= 1.0 - uScan * lines;
      col += (1.0 - band) * 0.04;
      col += (hash(uv * uRes + uTime) - 0.5) * 0.035;
      vec2 vc = vUv * 2.0 - 1.0;
      float r2 = dot(vc * vec2(uAspect, 1.0), vc * vec2(uAspect, 1.0));
      col *= 1.0 - uVignette * pow(clamp(r2 * 0.32, 0.0, 1.0), 1.6);
      col *= uLevels;
      // Outside the warped source used to be an early return of pure black; keep the
      // black but do not return, so the inversion sweep still reaches the corners
      // (otherwise the plate could never become fully white).
      col *= inside;

      // Inversion wipe: everything behind the travelling boundary flips polarity.
      vec2 iso = vUv * 2.0 - 1.0;
      iso.x *= uAspect;
      float behind = step(iso.x + iso.y, uWipe);
      float m = mix(behind, 1.0 - behind, uWipeFlip);
      col = mix(col, 1.0 - col, m);

      // The boundary itself: a soft cyan edge, so the wipe reads as a line on both
      // the black and the white side of the plate. Hidden until the first pass.
      float edge = exp(-pow((iso.x + iso.y - uWipe) / 0.035, 2.0)) * uWipeOn;
      col = mix(col, vec3(0.62, 0.86, 1.0), edge * 0.40);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `

  function compile(type, src) {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh)
      gl.deleteShader(sh)
      throw new Error(`shader compile failed: ${log}`)
    }
    return sh
  }

  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`)
  }
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // NEAREST everywhere: the CRT grain wants chunky pixels, and no mipmaps keeps it
  // crisp when the internal resolution is capped below the CSS size.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

  const u = {}
  for (const name of ['uTex', 'uWarp', 'uAspect', 'uRes', 'uVignette', 'uScan', 'uTime', 'uLevels', 'uWipe', 'uWipeFlip', 'uWipeOn']) {
    u[name] = gl.getUniformLocation(prog, name)
  }

  gl.clearColor(0, 0, 0, 1)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.BLEND)

  let disposed = false

  return {
    resize(cw, ch) {
      canvas.width = cw
      canvas.height = ch
      gl.viewport(0, 0, cw, ch)
    },
    render(p) {
      if (disposed) return
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.texture)
      gl.useProgram(prog)
      gl.uniform1i(u.uTex, 0)
      gl.uniform1f(u.uWarp, p.warp)
      gl.uniform1f(u.uAspect, p.aspect)
      gl.uniform2f(u.uRes, p.res[0], p.res[1])
      gl.uniform1f(u.uVignette, p.vignette)
      gl.uniform1f(u.uScan, p.scan)
      gl.uniform1f(u.uTime, p.time)
      gl.uniform1f(u.uLevels, p.levels)
      gl.uniform1f(u.uWipe, p.wipe)
      gl.uniform1f(u.uWipeFlip, p.wipeFlip)
      gl.uniform1f(u.uWipeOn, p.wipeOn)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose() {
      if (disposed) return
      disposed = true
      try { gl.deleteTexture(tex) } catch (e) {}
      try { gl.deleteBuffer(buf) } catch (e) {}
      try { gl.deleteProgram(prog) } catch (e) {}
      try {
        const lose = gl.getExtension('WEBGL_lose_context')
        if (lose) lose.loseContext()
      } catch (e) {}
    },
  }
}

/* =========================================================================
 * Screen 1: CRT lettering
 * ====================================================================== */

/**
 * Tube warm-up: a fast rise with flicker, then a permanent steady glow with a
 * faint breathing flicker. There is no self-fade any more - the plate stays lit
 * until the user dismisses it (only the exit fade dims it).
 */
function bootLevel(ms, total) {
  const t = clamp(ms / Math.max(1, total), 0, 1)
  if (t >= 1) return { level: 1 + Math.sin(ms * 0.011) * 0.012, flicker: 0.05 }
  return {
    level: clamp(Math.pow(t, 0.35) + (Math.random() - 0.5) * 0.12 * (1 - t), 0, 1.4),
    flicker: 1 - t,
  }
}

/** Letter-spaced text: canvas letterSpacing is not portable, so space it by hand. */
function drawSpaced(ctx, text, cx, y, spacing) {
  let width = 0
  for (const ch of text) width += ctx.measureText(ch).width + spacing
  width -= spacing
  let x = cx - width / 2
  ctx.textAlign = 'left'
  for (const ch of text) {
    ctx.fillText(ch, x, y)
    x += ctx.measureText(ch).width + spacing
  }
}

function drawScreen1(ctx, W, H, state, opts) {
  const ms = opts.ms
  const { level, flicker } = opts.boot
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  if (level <= 0.001) return

  const cx = W / 2
  const cy = H / 2
  const size = Math.min(W * 0.155, H * 0.22)
  ctx.save()
  ctx.translate(cx, cy)
  ctx.globalAlpha = clamp(level, 0, 1)

  const wobble = Math.sin(ms * 0.0032) * size * 0.012
  ctx.translate(wobble, Math.sin(ms * 0.0021) * size * 0.006)

  // small top command line, imitating a TUI start row
  ctx.font = `${Math.round(size * 0.17)}px "Cascadia Mono","JetBrains Mono",Consolas,monospace`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(150,190,255,0.62)'
  ctx.shadowColor = 'rgba(90,150,255,0.9)'
  ctx.shadowBlur = size * 0.10
  ctx.globalAlpha = clamp(level * 0.75, 0, 1)
  ctx.fillText('> dsh web --crt-splash --profile desktop', -size * 2.52, -size * 0.86)
  ctx.globalAlpha = clamp(level, 0, 1)
  ctx.shadowBlur = 0

  const flick = flicker > 0 ? 1 - Math.random() * flicker * 0.22 : 1
  const word = (text, y, fill, glow, px) => {
    ctx.font = `900 ${px}px "Impact","Haettenschweiler","Arial Black",system-ui,sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // phosphor bleed: stacked rings from outside in
    for (const [spread, alpha] of [[0.30, 0.10], [0.18, 0.16], [0.09, 0.26], [0.04, 0.42]]) {
      ctx.shadowColor = glow
      ctx.shadowBlur = px * spread
      ctx.globalAlpha = clamp(level * alpha * flick, 0, 1)
      ctx.fillStyle = fill
      ctx.fillText(text, 0, y)
    }
    ctx.shadowBlur = 0
    // bright core
    ctx.globalAlpha = clamp(level * flick, 0, 1)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, 0, y)
    // scanline voids punched through the glyph faces
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 0.22
    const step = Math.max(2, Math.round(px * 0.055))
    for (let yy = -px * 0.8; yy < px * 0.8; yy += step) {
      ctx.fillRect(-W * 0.5, y + yy, W, Math.max(1, Math.round(step * 0.34)))
    }
    ctx.restore()
  }
  word('DEEPSEEK', -size * 0.30, '#ffffff', 'rgba(255,255,255,0.95)', size * 0.86)
  word('HARNESS', size * 0.36, '#2f6bff', 'rgba(70,145,255,0.98)', size * 0.86)
  ctx.restore()

  // ---------------------------------------------------------------- bottom prompt
  // Drawn straight on the plate (not as DOM), so it picks up the scanlines, the
  // barrel warp and the inversion wipe along with everything else.
  const appear = smoothstep(opts.bootMs * 0.55, opts.bootMs * 0.98, ms)
  if (appear > 0.001) {
    const blink = 0.55 + 0.45 * Math.sin(ms * 0.0062)
    const px = Math.max(12, Math.round(size * 0.185))
    const y = H - Math.max(30, H * 0.085)
    ctx.save()
    ctx.font = `600 ${px}px "Cascadia Mono","JetBrains Mono",Consolas,monospace`
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = clamp(appear * (0.34 + 0.66 * blink) * clamp(level, 0, 1), 0, 1)
    ctx.fillStyle = '#e8f1ff'
    ctx.shadowColor = 'rgba(90,150,255,0.95)'
    ctx.shadowBlur = px * 0.85
    drawSpaced(ctx, 'PRESS ANY KEY TO CONTINUE', W / 2, y, px * 0.30)
    ctx.shadowBlur = 0
    // a thin rule under it, the way a TUI frames a prompt
    const ruleW = Math.min(W * 0.5, px * 19)
    ctx.globalAlpha = clamp(appear * (0.18 + 0.30 * blink) * clamp(level, 0, 1), 0, 1)
    ctx.fillStyle = '#5f86c8'
    ctx.fillRect(W / 2 - ruleW / 2, y + px * 0.95, ruleW, Math.max(1, Math.round(px * 0.06)))
    ctx.restore()
  }
}

/* =========================================================================
 * Helpers
 * ====================================================================== */
function clamp(v, a, b) { return v < a ? a : v > b ? b : v }
/** Finite number or `fallback` - never NaN (see the config parsing in run()). */
function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a || 1), 0, 1)
  return t * t * (3 - 2 * t)
}
