// Flytower web map: the trim preview overlay (#303). Only with ?trim in the address, and only
// for someone signed in who can change this server's world. Shades the chunks the last
// preview would remove, outlines protected areas, and lets you draw, rename and delete them.
// Plain JavaScript like the viewer, and it only talks to the panel's own API.
'use strict'
;(() => {
  const map = window.flytowerMap
  if (!map || !new URLSearchParams(location.search).has('trim')) return
  const server = (location.pathname.match(/^\/s\/([^/]+)\/map/) || [])[1]
  if (!server) return
  const api = `/api/servers/${server}/world`
  const { root, el } = map

  const REGION = 512 // blocks
  const CHUNK = 16

  let rules = null
  let preview = null
  /** Regions of the current preview, by dimension: [{ x, z, image }]. */
  let regions = new Map()
  let mode = 'look' // 'look' | 'draw'
  let drag = null // a rectangle being drawn, in blocks: { x0, z0, x1, z1 }
  /** Protected areas as drawn last, for clicking: [{ index, left, top, right, bottom }]. */
  let hits = []
  let busy = false

  const canvas = el('canvas', 'trim-layer')
  map.insertLayer(canvas)
  const bar = el('div', 'bar trim')
  bar.setAttribute('role', 'region')
  bar.setAttribute('aria-label', 'Trim preview')
  root.append(bar)
  const form = el('form', 'bar trim-form')
  form.hidden = true
  root.append(form)

  // Dimensions: the spec writes vanilla ones short ("the_end"), the map in full.
  const fullId = (d) => (d.includes(':') ? d : `minecraft:${d}`)
  const shortId = (d) => (d.startsWith('minecraft:') ? d.slice(10) : d)
  const count = (n) => n.toLocaleString()

  // --- Loading ---

  async function call(path, init) {
    const res = await fetch(path, {
      ...init,
      headers: init && init.body ? { 'content-type': 'application/json' } : undefined,
      cache: 'no-store',
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(body.statusMessage || body.message || `Error ${res.status}`)
      err.status = res.status
      throw err
    }
    return body
  }

  async function load() {
    try {
      const r = await call(`${api}/trim-overlay`)
      rules = r.rules
      preview = r.preview
      regions = decode(preview)
    } catch (err) {
      rules = null
      showBar(
        err.status === 401 || err.status === 403 || err.status === 404
          ? 'Sign in to the panel as someone who can change this world to see the trim preview.'
          : `Couldn't load the trim preview: ${err.message}`,
      )
      map.redraw()
      return
    }
    showBar()
    map.redraw()
  }

  /** Each region's mask as a 32×32 image, one pixel per chunk, drawn once and then scaled. */
  function decode(p) {
    const out = new Map()
    if (!p) return out
    for (const d of p.bitmap.dimensions) {
      const list = []
      for (const [x, z, mask] of d.regions) {
        const bytes = Uint8Array.from(atob(mask), (c) => c.charCodeAt(0))
        const image = document.createElement('canvas')
        image.width = image.height = 32
        const ctx = image.getContext('2d')
        const data = ctx.createImageData(32, 32)
        for (let i = 0; i < 1024; i++) {
          if (!(bytes[i >> 3] & (1 << (i & 7)))) continue
          data.data.set([220, 38, 38, 255], i * 4)
        }
        ctx.putImageData(data, 0, 0)
        list.push({ x, z, image })
      }
      out.set(d.id, list)
    }
    return out
  }

  // --- Drawing ---

  /** A protected area's edges in blocks: every chunk it touches. */
  function areaBlocks(a) {
    const cx0 = Math.floor(Math.min(a.from[0], a.to[0]) / CHUNK)
    const cx1 = Math.floor(Math.max(a.from[0], a.to[0]) / CHUNK)
    const cz0 = Math.floor(Math.min(a.from[1], a.to[1]) / CHUNK)
    const cz1 = Math.floor(Math.max(a.from[1], a.to[1]) / CHUNK)
    return [cx0 * CHUNK, cz0 * CHUNK, (cx1 + 1) * CHUNK, (cz1 + 1) * CHUNK]
  }

  function draw() {
    const w = root.clientWidth
    const h = root.clientHeight
    const ratio = devicePixelRatio || 1
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio)
      canvas.height = Math.round(h * ratio)
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, w, h)
    hits = []
    const dim = map.dimension()
    if (!dim || !rules) return

    // Chunks that would go, faded while the preview is out of date.
    ctx.imageSmoothingEnabled = false
    ctx.globalAlpha = preview && preview.stale ? 0.2 : 0.45
    for (const r of regions.get(dim) || []) {
      const [x0, y0] = map.toScreen(r.x * REGION, r.z * REGION)
      const [x1, y1] = map.toScreen((r.x + 1) * REGION, (r.z + 1) * REGION)
      if (x1 < 0 || y1 < 0 || x0 > w || y0 > h) continue
      ctx.drawImage(r.image, x0, y0, x1 - x0, y1 - y0)
    }
    ctx.globalAlpha = 1

    // Protected areas, with their names.
    ctx.font = '600 12px system-ui, sans-serif'
    rules.protect.forEach((a, index) => {
      if (fullId(a.dimension) !== dim) return
      const [bx0, bz0, bx1, bz1] = areaBlocks(a)
      const [x0, y0] = map.toScreen(bx0, bz0)
      const [x1, y1] = map.toScreen(bx1, bz1)
      if (x1 < 0 || y1 < 0 || x0 > w || y0 > h) return
      outline(ctx, x0, y0, x1, y1, '#facc15', a.name)
      hits.push({ index, left: x0, top: y0, right: x1, bottom: y1 })
    })

    if (drag) {
      const [bx0, bz0, bx1, bz1] = dragBlocks()
      const [x0, y0] = map.toScreen(bx0, bz0)
      const [x1, y1] = map.toScreen(bx1, bz1)
      ctx.setLineDash([6, 4])
      outline(ctx, x0, y0, x1, y1, '#facc15', 'New area')
      ctx.setLineDash([])
    }
  }

  function outline(ctx, x0, y0, x1, y1, colour, label) {
    ctx.fillStyle = 'rgba(250, 204, 21, 0.12)'
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    ctx.strokeStyle = colour
    ctx.lineWidth = 2
    ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2)
    if (x1 - x0 < 40) return
    const tw = ctx.measureText(label).width + 10
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(x0 + 2, y0 + 2, Math.min(tw, x1 - x0 - 4), 18)
    ctx.fillStyle = '#fef3c7'
    ctx.save()
    ctx.beginPath()
    ctx.rect(x0 + 2, y0 + 2, x1 - x0 - 4, 18)
    ctx.clip()
    ctx.fillText(label, x0 + 7, y0 + 15)
    ctx.restore()
  }

  map.onDraw(draw)

  // --- The bar ---

  function button(label, onclick, primary) {
    const b = el('button', primary ? 'primary' : null, label)
    b.type = 'button'
    b.onclick = onclick
    b.disabled = busy
    return b
  }

  function showBar(note) {
    bar.replaceChildren()
    if (note || !rules) {
      bar.append(el('span', 'muted', note || ''))
      return
    }
    const text = el('div', 'trim-text')
    if (mode === 'draw') {
      text.append(
        el('strong', null, 'Drag out the area to keep.'),
        el('span', 'muted', ' It snaps to whole chunks.'),
      )
      bar.append(
        text,
        button('Cancel', () => setMode('look')),
      )
      return
    }
    if (!preview) {
      text.append(el('span', null, 'No preview yet. Preview to see which chunks would go.'))
    } else {
      const key = el('span', 'swatch gone')
      text.append(
        key,
        el(
          'span',
          null,
          preview.removed
            ? `${count(preview.removed)} chunks would go.`
            : 'Nothing would go with these rules.',
        ),
      )
      if (preview.stale) text.append(el('span', 'warn', ' The rules changed since: preview again.'))
    }
    const kept = el('span', 'swatch kept')
    text.append(el('br'), kept, el('span', 'muted', 'Protected areas. Select one to change it.'))
    bar.append(text, el('div', 'trim-actions'))
    bar.lastChild.append(
      button('Draw protected area', () => setMode('draw')),
      button(busy ? 'Looking…' : 'Preview again', previewAgain, !preview || preview.stale),
    )
  }

  function setMode(m) {
    mode = m
    drag = null
    root.classList.toggle('drawing', m === 'draw')
    form.hidden = true
    showBar()
    map.redraw()
  }

  async function previewAgain() {
    busy = true
    showBar()
    try {
      await call(`${api}/trim-preview`, { method: 'POST' })
      await load()
    } catch (err) {
      showBar(`Couldn't preview: ${err.message}`)
      setTimeout(() => showBar(), 6000)
    } finally {
      busy = false
      if (rules) showBar()
    }
  }

  // --- Drawing an area: one finger or the mouse drags a rectangle; two fingers still zoom. ---

  const rect = () => root.getBoundingClientRect()
  const blockAt = (e) => {
    const r = rect()
    return map.toBlocks(e.clientX - r.left, e.clientY - r.top)
  }
  function dragBlocks() {
    const cx0 = Math.floor(Math.min(drag.x0, drag.x1) / CHUNK)
    const cx1 = Math.floor(Math.max(drag.x0, drag.x1) / CHUNK)
    const cz0 = Math.floor(Math.min(drag.z0, drag.z1) / CHUNK)
    const cz1 = Math.floor(Math.max(drag.z0, drag.z1) / CHUNK)
    return [cx0 * CHUNK, cz0 * CHUNK, (cx1 + 1) * CHUNK, (cz1 + 1) * CHUNK]
  }
  const onMap = (e) => root.contains(e.target) && !e.target.closest('.bar')
  let pointer = null
  let down = null

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!onMap(e)) return
      down = { x: e.clientX, y: e.clientY }
      if (mode !== 'draw' || !form.hidden) return
      if (pointer !== null) {
        // A second finger: give up the rectangle and let the map pinch.
        pointer = null
        drag = null
        map.redraw()
        return
      }
      e.stopPropagation()
      e.preventDefault()
      pointer = e.pointerId
      const [x, z] = blockAt(e)
      drag = { x0: x, z0: z, x1: x, z1: z }
      map.redraw()
    },
    true,
  )
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerId !== pointer || !drag) return
      e.stopPropagation()
      const [x, z] = blockAt(e)
      drag.x1 = x
      drag.z1 = z
      map.redraw()
    },
    true,
  )
  const finish = (e) => {
    if (e.pointerId !== pointer) return
    e.stopPropagation()
    pointer = null
    if (!drag) return
    const [x0, z0, x1, z1] = dragBlocks()
    openForm({
      name: '',
      dimension: shortId(map.dimension()),
      from: [x0, z0],
      to: [x1 - 1, z1 - 1],
    })
  }
  document.addEventListener('pointerup', finish, true)
  document.addEventListener(
    'pointercancel',
    (e) => {
      if (e.pointerId !== pointer) return
      pointer = null
      drag = null
      map.redraw()
    },
    true,
  )

  // Selecting an area (a click that didn't drag the map) opens it to rename or delete.
  root.addEventListener('click', (e) => {
    if (mode !== 'look' || !onMap(e) || !down) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
    const r = rect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    const hit = hits.findLast((h) => px >= h.left && px <= h.right && py >= h.top && py <= h.bottom)
    if (hit) openForm(rules.protect[hit.index], hit.index)
  })

  // --- The area form ---

  function openForm(area, index) {
    const editing = index !== undefined
    form.replaceChildren()
    const label = el('label', null, editing ? 'Protected area' : 'Name the new protected area')
    const input = el('input')
    input.maxLength = 60
    input.required = true
    input.value = area.name
    input.placeholder = 'Town'
    input.setAttribute('aria-label', 'Name')
    const [bx0, bz0, bx1, bz1] = areaBlocks(area)
    const size = el(
      'span',
      'muted',
      `${count(((bx1 - bx0) / CHUNK) * ((bz1 - bz0) / CHUNK))} chunks, from ${area.from[0]}, ${area.from[1]} to ${area.to[0]}, ${area.to[1]}`,
    )
    const error = el('span', 'warn')
    const actions = el('div', 'trim-actions')
    const save = el('button', 'primary', 'Save')
    save.type = 'submit'
    actions.append(
      button('Cancel', () => {
        form.hidden = true
        drag = null
        if (mode === 'draw') setMode('look')
        else map.redraw()
      }),
    )
    if (editing) {
      actions.append(
        button('Delete', () => change((list) => list.filter((_, i) => i !== index), error)),
      )
    }
    actions.append(save)
    form.append(label, input, size, error, actions)
    form.onsubmit = (e) => {
      e.preventDefault()
      const name = input.value.trim()
      if (!name) return
      const next = { ...area, name }
      void change(
        (list) => (editing ? list.map((a, i) => (i === index ? next : a)) : [...list, next]),
        error,
      )
    }
    form.hidden = false
    input.focus()
  }

  /** Saves the rules with a changed list of areas, the same way the panel's form does. */
  async function change(update, error) {
    const body = { ...rules, protect: update(rules.protect) }
    for (const b of form.querySelectorAll('button')) b.disabled = true
    try {
      await call(`${api}/trim-rules`, { method: 'PATCH', body: JSON.stringify(body) })
      form.hidden = true
      drag = null
      setMode('look')
      await load()
    } catch (err) {
      error.textContent = err.message
      for (const b of form.querySelectorAll('button')) b.disabled = false
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!form.hidden || mode === 'draw') {
      form.hidden = true
      setMode('look')
    }
  })

  void load()
})()
