// Flytower web map viewer. Shows the tiles flytower-map drew, and where players are.
// Plain JavaScript with no libraries: tiles are images placed by position, and the page
// only ever talks to its own map folder.
'use strict'
;(() => {
  const root = document.getElementById('map')
  if (!root) return
  const title = root.dataset.title || 'Map'

  const MIN_ZOOM = -6 // 1 pixel = 64 blocks
  const MAX_ZOOM = 3 // 8 pixels per block
  const LABELS = {
    'minecraft:overworld': 'Overworld',
    'minecraft:the_nether': 'Nether',
    'minecraft:the_end': 'End',
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }

  const tilesLayer = el('div', 'tiles')
  const markers = el('div', 'markers')
  const top = el('div', 'bar top')
  const zoomBar = el('div', 'bar zoom')
  const coords = el('div', 'bar coords')
  const people = el('div', 'bar people')
  root.append(tilesLayer, markers, top, zoomBar, coords, people)

  const heading = el('span', 'title', title)
  const picker = el('select')
  picker.setAttribute('aria-label', 'Dimension')
  top.append(heading, picker)
  const zoomIn = el('button', null, '+')
  const zoomOut = el('button', null, '−')
  zoomIn.setAttribute('aria-label', 'Zoom in')
  zoomOut.setAttribute('aria-label', 'Zoom out')
  zoomBar.append(zoomIn, zoomOut)
  coords.hidden = true

  // The view: which dimension, the block at the centre, and the zoom (a power of two).
  // While zooming, zoom is fractional: it eases towards goal over ZOOM_MS.
  const view = { dim: 0, x: 0, z: 0, zoom: 0 }
  let goal = 0
  const ZOOM_MS = 160
  const FADE_MS = 120
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  let manifest = null
  let manifestText = ''
  let rev = Date.now()
  let players = []
  const tiles = new Map()
  // How often players are asked for, and how long a marker takes to glide to its new place.
  const PLAYERS_MS = 1000
  // Further than this in one step is a teleport or portal: jump there, don't glide.
  const GLIDE_MAX = 64
  const markerEls = new Map()
  let gliding = 0

  const scale = () => 2 ** view.zoom
  const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
  const dims = () => (manifest ? manifest.dimensions : [])
  const current = () => dims()[view.dim]

  function message(text) {
    let m = root.querySelector('.message')
    if (!text) return m && m.remove()
    if (!m) root.append((m = el('div', 'message')))
    m.textContent = text
  }

  // --- Address bar: #overworld/x/z/zoom, so a view can be shared. ---

  function readHash() {
    const [dim, x, z, zoom] = decodeURIComponent(location.hash.slice(1)).split('/')
    const i = dims().findIndex((d) => d.id === dim || d.id === `minecraft:${dim}`)
    if (i >= 0) view.dim = i
    if (Number.isFinite(Number(x)) && x !== '' && x !== undefined) view.x = Number(x)
    if (Number.isFinite(Number(z)) && z !== '' && z !== undefined) view.z = Number(z)
    if (zoom !== undefined && Number.isFinite(Number(zoom))) {
      view.zoom = goal = clampZoom(Math.round(Number(zoom)))
    }
  }

  let hashTimer = 0
  function writeHash() {
    clearTimeout(hashTimer)
    hashTimer = setTimeout(() => {
      const d = current()
      if (!d) return
      const id = d.id.startsWith('minecraft:') ? d.id.slice(10) : d.id
      history.replaceState(
        null,
        '',
        `#${id}/${Math.round(view.x)}/${Math.round(view.z)}/${Math.round(goal)}`,
      )
    }, 250)
  }

  // --- Tiles ---

  // Each tile remembers where it belongs. Tiles from the level shown before (a zoom across a
  // level, or a redraw of the world) stay underneath, scaled to fit, until the new level's
  // tiles in view have all arrived, so the map never flashes blank.
  let want = new Set()
  let preloadTimer = 0
  const preloaded = new Map()

  // The blocks on screen: left, top, width and height.
  function onScreen() {
    const s = scale()
    const w = root.clientWidth / s
    const h = root.clientHeight / s
    return [view.x - w / 2, view.z - h / 2, w, h]
  }

  // Which tiles cover an area at a zoom: the sharpest level that isn't bigger than needed.
  function cover(zoom, [left, topZ, w, h] = onScreen()) {
    const d = current()
    const level = Math.min(manifest.levels, Math.max(0, -Math.ceil(zoom - 1e-6)))
    const blocks = manifest.tileSize * 2 ** level
    const [bx0, bz0, bx1, bz1] = d.bounds
    // Region bounds at this level; >> floors negatives as we need.
    return {
      level,
      tx0: Math.max(bx0 >> level, Math.floor(left / blocks)),
      tx1: Math.min(bx1 >> level, Math.floor((left + w) / blocks)),
      tz0: Math.max(bz0 >> level, Math.floor(topZ / blocks)),
      tz1: Math.min(bz1 >> level, Math.floor((topZ + h) / blocks)),
    }
  }

  const tileUrl = (d, level, tx, tz) => `${d.tiles}/${level}/${tx}_${tz}.png?r=${rev}`

  function draw() {
    const d = current()
    if (!d || !manifest) return
    const w = root.clientWidth
    const h = root.clientHeight
    const s = scale()
    const left = view.x - w / 2 / s
    const topZ = view.z - h / 2 / s
    // Zooming out, go straight to the goal's level: it covers the new edges sooner.
    const c = cover(Math.min(view.zoom, goal))
    want = new Set()
    for (let tz = c.tz0; tz <= c.tz1; tz++) {
      for (let tx = c.tx0; tx <= c.tx1; tx++) {
        const url = tileUrl(d, c.level, tx, tz)
        want.add(url)
        if (tiles.has(url)) continue
        const img = new Image()
        img.alt = ''
        img.decoding = 'async'
        const t = { img, level: c.level, tx, tz, ready: false }
        img.onload = () => {
          // Fade in over the old level, and only count it as there once it fully is.
          img.classList.add('ready')
          setTimeout(
            () => {
              t.ready = true
              tidy()
            },
            still.matches ? 0 : FADE_MS,
          )
        }
        img.onerror = () => {
          t.ready = true
          img.style.visibility = 'hidden'
          tidy()
        }
        img.src = url
        tiles.set(url, t)
        tilesLayer.append(img)
      }
    }
    const waiting = [...want].some((url) => !tiles.get(url).ready)
    for (const [url, t] of tiles) {
      const blocks = manifest.tileSize * 2 ** t.level
      // Edges are rounded on their own, so neighbouring tiles always meet with no gap.
      const x0 = Math.round((t.tx * blocks - left) * s)
      const x1 = Math.round(((t.tx + 1) * blocks - left) * s)
      const y0 = Math.round((t.tz * blocks - topZ) * s)
      const y1 = Math.round(((t.tz + 1) * blocks - topZ) * s)
      if (!want.has(url)) {
        // Old tiles only fill gaps: drop them once they're not needed, off screen, or tiny.
        const off = x1 <= 0 || y1 <= 0 || x0 >= w || y0 >= h
        if (!waiting || off || x1 - x0 < 16 || !t.ready) {
          t.img.remove()
          tiles.delete(url)
          continue
        }
      }
      const style = t.img.style
      style.left = `${x0}px`
      style.top = `${y0}px`
      style.width = `${x1 - x0}px`
      style.height = `${y1 - y0}px`
      t.img.classList.toggle('old', !want.has(url))
    }
    tilesLayer.classList.toggle('pixelated', s > 1)
    drawPlayers()
    for (const fn of onDraw) fn()
    writeHash()
    if (!waiting) preload()
  }

  // A new tile arrived: once the whole view has, the old level underneath can go.
  function tidy() {
    if ([...want].every((url) => tiles.get(url)?.ready)) draw()
  }

  // Once the view has settled, fetch the tiles one zoom step in and out, so the next zoom
  // has them ready (the server lets the browser keep them for a minute). Zooming in stays
  // inside the screen; zooming out can reach up to a screen further on every side.
  function preload() {
    clearTimeout(preloadTimer)
    preloadTimer = setTimeout(() => {
      const d = current()
      if (!d || zooming || pointers.size) return
      const now = cover(goal).level
      const [left, topZ, w, h] = onScreen()
      // Out first: zooming in already has the old level to show, scaled up, while it waits.
      const steps = [
        [goal - 1, [left - w, topZ - h, w * 3, h * 3]],
        [goal + 1, [left, topZ, w, h]],
      ]
      for (const [z, area] of steps) {
        const c = cover(clampZoom(z), area)
        if (c.level === now) continue
        for (let tz = c.tz0; tz <= c.tz1; tz++) {
          for (let tx = c.tx0; tx <= c.tx1; tx++) {
            const url = tileUrl(d, c.level, tx, tz)
            if (tiles.has(url) || preloaded.has(url)) continue
            if (preloaded.size >= 200) preloaded.delete(preloaded.keys().next().value)
            const img = new Image()
            img.src = url
            preloaded.set(url, img)
          }
        }
      }
    }, 300)
  }

  function clearTiles() {
    for (const t of tiles.values()) t.img.remove()
    tiles.clear()
  }

  // --- Players ---

  // Where a player is drawn right now: part of the way from where they were to where they are.
  function at(p, now) {
    const t = Math.min(1, (now - p.since) / PLAYERS_MS)
    return { x: p.fromX + (p.x - p.fromX) * t, z: p.fromZ + (p.z - p.fromZ) * t }
  }

  function drawPlayers() {
    const d = current()
    const s = scale()
    const w = root.clientWidth
    const h = root.clientHeight
    const now = performance.now()
    const shown = new Set()
    for (const p of players) {
      if (!d || p.dimension !== d.id) continue
      shown.add(p.name)
      let m = markerEls.get(p.name)
      if (!m) {
        m = el('div', 'player')
        m.append(head(p), el('span', 'name', p.name))
        markerEls.set(p.name, m)
        markers.append(m)
      }
      const pos = at(p, now)
      m.style.left = `${(pos.x - view.x) * s + w / 2}px`
      m.style.top = `${(pos.z - view.z) * s + h / 2}px`
    }
    for (const [name, m] of markerEls) {
      if (!shown.has(name)) {
        m.remove()
        markerEls.delete(name)
      }
    }
  }

  // Redraws the markers each frame until everyone has arrived.
  function glide() {
    if (gliding) return
    const step = () => {
      drawPlayers()
      const now = performance.now()
      gliding = players.some((p) => now - p.since < PLAYERS_MS) ? requestAnimationFrame(step) : 0
    }
    gliding = requestAnimationFrame(step)
  }

  function head(p) {
    const e = el('span', 'head')
    if (p.uuid) {
      const url = `heads/${encodeURIComponent(p.uuid)}.png`
      e.style.backgroundImage = `url("${url}"), url("${url}")`
    }
    return e
  }

  function listPlayers() {
    people.replaceChildren()
    for (const p of players) {
      const b = el('button')
      b.append(head(p), el('span', null, p.name))
      b.title = `${LABELS[p.dimension] || p.dimension} ${Math.round(p.x)}, ${Math.round(p.z)}`
      b.onclick = () => {
        const i = dims().findIndex((d) => d.id === p.dimension)
        if (i >= 0 && i !== view.dim) {
          view.dim = i
          picker.value = String(i)
          clearTiles()
        }
        view.x = p.x
        view.z = p.z
        stopZoom()
        view.zoom = goal = Math.max(Math.round(goal), 0)
        draw()
      }
      people.append(b)
    }
  }

  async function refreshPlayers() {
    if (document.hidden) return
    try {
      const res = await fetch('players.json', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const now = performance.now()
      const before = new Map(players.map((p) => [p.name, p]))
      players = ((await res.json()).players || []).map((p) => {
        const last = before.get(p.name)
        const from = last && last.dimension === p.dimension ? at(last, now) : null
        const near = from && Math.hypot(p.x - from.x, p.z - from.z) <= GLIDE_MAX
        return { ...p, fromX: near ? from.x : p.x, fromZ: near ? from.z : p.z, since: now }
      })
    } catch {
      players = []
    }
    listPlayers()
    drawPlayers()
    glide()
  }

  // --- Moving around ---

  // Zooms towards a level, keeping the block under the pointer (px, py) where it is. The
  // zoom eases there over ZOOM_MS; a zoom that arrives on the way just moves the goal.
  let zooming = 0
  let anchor = null
  let from = 0
  let since = 0

  function zoomTo(target, px, py) {
    target = clampZoom(target)
    const w = root.clientWidth
    const h = root.clientHeight
    const s = scale()
    anchor = { px, py, bx: view.x + (px - w / 2) / s, bz: view.z + (py - h / 2) / s }
    goal = target
    from = view.zoom
    since = performance.now()
    if (still.matches) {
      stopZoom()
      show(target)
      return draw()
    }
    if (!zooming) zooming = requestAnimationFrame(frame)
  }

  function zoomAt(delta, px, py) {
    zoomTo(Math.round(goal) + delta, px, py)
  }

  // Puts the view at a zoom with the anchor block under the anchor point.
  function show(zoom) {
    view.zoom = zoom
    const s = scale()
    view.x = anchor.bx - (anchor.px - root.clientWidth / 2) / s
    view.z = anchor.bz - (anchor.py - root.clientHeight / 2) / s
  }

  function frame(now) {
    const t = Math.min(1, Math.max(0, (now - since) / ZOOM_MS))
    show(from + (goal - from) * (1 - (1 - t) ** 3))
    zooming = t < 1 ? requestAnimationFrame(frame) : 0
    draw()
  }

  function stopZoom() {
    cancelAnimationFrame(zooming)
    zooming = 0
    clearTimeout(snapTimer)
  }

  // Trackpads and pinches can stop between levels; settle on the nearest one so pixels stay
  // square and sharp.
  let snapTimer = 0
  function snapSoon(px, py) {
    clearTimeout(snapTimer)
    snapTimer = setTimeout(() => {
      if (goal !== Math.round(goal)) zoomTo(Math.round(goal), px, py)
    }, 200)
  }

  const pointers = new Map()
  // A two-finger pinch: the zoom and the block under the fingers when it began.
  let pinch = null
  const middle = () => {
    const [a, b] = [...pointers.values()]
    const rect = root.getBoundingClientRect()
    return {
      x: (a.x + b.x) / 2 - rect.left,
      y: (a.y + b.y) / 2 - rect.top,
      d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    }
  }
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.bar')) return
    root.setPointerCapture(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    root.classList.add('dragging')
    if (pointers.size === 2) {
      stopZoom()
      goal = view.zoom
      const m = middle()
      const s = scale()
      pinch = {
        zoom: view.zoom,
        d: m.d,
        bx: view.x + (m.x - root.clientWidth / 2) / s,
        bz: view.z + (m.y - root.clientHeight / 2) / s,
      }
    }
  })
  root.addEventListener('pointermove', (e) => {
    const s = scale()
    const rect = root.getBoundingClientRect()
    const bx = view.x + (e.clientX - rect.left - root.clientWidth / 2) / s
    const bz = view.z + (e.clientY - rect.top - root.clientHeight / 2) / s
    coords.hidden = false
    coords.textContent = `x ${Math.floor(bx)}  z ${Math.floor(bz)}`
    const was = pointers.get(e.pointerId)
    if (!was) return
    const dx = e.clientX - was.x
    const dy = e.clientY - was.y
    was.x = e.clientX
    was.y = e.clientY
    if (pointers.size === 2 && pinch) {
      // Zoom with the fingers' spread, and keep the block they started on between them.
      const m = middle()
      anchor = { px: m.x, py: m.y, bx: pinch.bx, bz: pinch.bz }
      goal = clampZoom(pinch.zoom + Math.log2(m.d / pinch.d))
      show(goal)
      draw()
      return
    }
    if (zooming && anchor) {
      // Dragging mid-zoom: carry the zoom's anchor along with the pointer.
      anchor.px += dx
      anchor.py += dy
    }
    view.x -= dx / s
    view.z -= dy / s
    draw()
  })
  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return
    if (pinch && pointers.size < 2) {
      pinch = null
      snapSoon(
        anchor ? anchor.px : root.clientWidth / 2,
        anchor ? anchor.py : root.clientHeight / 2,
      )
    }
    if (pointers.size === 0) {
      root.classList.remove('dragging')
      draw()
    }
  }
  root.addEventListener('pointerup', release)
  root.addEventListener('pointercancel', release)
  root.addEventListener('pointerleave', () => (coords.hidden = true))

  root.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      // A mouse notch is one zoom level; trackpads send many small steps, and a trackpad
      // pinch arrives as a wheel with Ctrl held.
      const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100
      let step = -e.deltaY / unit
      if (e.ctrlKey && e.deltaMode === 0) step *= 4
      step = Math.max(-1, Math.min(1, step))
      const rect = root.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      zoomTo(goal + step, px, py)
      snapSoon(px, py)
    },
    { passive: false },
  )
  root.addEventListener('dblclick', (e) => {
    if (e.target.closest('.bar')) return
    const rect = root.getBoundingClientRect()
    zoomAt(e.shiftKey ? -1 : 1, e.clientX - rect.left, e.clientY - rect.top)
  })
  zoomIn.onclick = () => zoomAt(1, root.clientWidth / 2, root.clientHeight / 2)
  zoomOut.onclick = () => zoomAt(-1, root.clientWidth / 2, root.clientHeight / 2)
  picker.onchange = () => {
    view.dim = Number(picker.value)
    clearTiles()
    draw()
  }
  window.addEventListener('resize', draw)
  window.addEventListener('hashchange', () => {
    const before = view.dim
    stopZoom()
    readHash()
    if (view.dim !== before) {
      picker.value = String(view.dim)
      clearTiles()
    }
    draw()
  })

  // --- Keeping up with the world ---

  async function loadManifest() {
    const res = await fetch('maps.json', { cache: 'no-cache' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(String(res.status))
    return res.text()
  }

  async function refreshManifest() {
    if (document.hidden) return
    try {
      const text = await loadManifest()
      if (!text || text === manifestText) return
      manifestText = text
      manifest = JSON.parse(text)
      rev = Date.now()
      // Old tiles stay until the new ones arrive, so a redraw never blanks the map.
      draw()
    } catch {
      // Try again next time.
    }
  }

  async function start() {
    document.title = `${title} · Map`
    let text
    try {
      text = await loadManifest()
    } catch {
      return message("The map couldn't be loaded. Try again in a moment.")
    }
    if (!text)
      return message("The map hasn't been drawn yet. Check back once the world has been explored.")
    manifestText = text
    manifest = JSON.parse(text)
    if (!dims().length)
      return message("The map hasn't been drawn yet. Check back once the world has been explored.")
    for (const [i, d] of dims().entries()) {
      const o = el('option', null, LABELS[d.id] || d.id)
      o.value = String(i)
      picker.append(o)
    }
    // Start at 0, 0 (near spawn) if it's on the map, otherwise in the middle of what is.
    const d = dims()[0]
    const size = manifest.tileSize
    const inside = d.bounds[0] <= 0 && d.bounds[2] >= 0 && d.bounds[1] <= 0 && d.bounds[3] >= 0
    if (!inside) {
      view.x = ((d.bounds[0] + d.bounds[2] + 1) / 2) * size
      view.z = ((d.bounds[1] + d.bounds[3] + 1) / 2) * size
    }
    readHash()
    picker.value = String(view.dim)
    if (dims().length < 2) picker.hidden = true
    draw()
    void refreshPlayers()
    setInterval(refreshPlayers, PLAYERS_MS)
    setInterval(refreshManifest, 60_000)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        void refreshPlayers()
        void refreshManifest()
      }
    })
  }

  // --- For overlays (trim.js): where things are, and a call after every draw. ---

  const onDraw = []
  window.flytowerMap = {
    root,
    /** Layers go under the markers and bars. */
    insertLayer: (layer) => root.insertBefore(layer, markers),
    el,
    dimension: () => (current() ? current().id : null),
    /** The screen position of a block, relative to the map. */
    toScreen: (bx, bz) => {
      const s = scale()
      return [(bx - view.x) * s + root.clientWidth / 2, (bz - view.z) * s + root.clientHeight / 2]
    },
    /** The block at a point relative to the map. */
    toBlocks: (px, py) => {
      const s = scale()
      return [view.x + (px - root.clientWidth / 2) / s, view.z + (py - root.clientHeight / 2) / s]
    },
    scale,
    onDraw: (fn) => onDraw.push(fn),
    redraw: () => draw(),
  }

  void start()
})()
