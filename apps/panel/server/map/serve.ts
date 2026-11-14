/**
 * Serving a server's web map: the viewer page, the tiles flytower-map drew, and who may have
 * them. Everything is read from the map's own folder, never the server's.
 */
import { resolve, sep } from 'node:path'
import type { MapSettings } from '../../shared/map-settings'
import type { PublicPage } from '../../shared/public-page'

const TYPES: Record<string, string> = {
  json: 'application/json',
  png: 'image/png',
}

export interface MapFile {
  /** Absolute, and always inside the map's folder. */
  file: string
  type: string
  cache: string
}

/**
 * The drawn file a request path means (already URL-decoded): `maps.json` or a tile. Null for
 * anything else, outside the folder, or hidden, so the state files are never served.
 */
export function mapFile(root: string, rel: string): MapFile | null {
  if (rel.includes('\0') || rel.includes('\\')) return null
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return null
  if (rel !== 'maps.json' && !(parts[0] === 'tiles' && rel.endsWith('.png'))) return null
  const type = TYPES[rel.slice(rel.lastIndexOf('.') + 1)]
  if (!type) return null
  const base = resolve(root)
  const file = resolve(base, rel)
  if (!file.startsWith(base + sep)) return null
  return { file, type, cache: cacheFor(rel) }
}

/** The manifest is always asked for again; tiles change as the world does, so a minute. */
export function cacheFor(path: string): string {
  if (path.endsWith('.json')) return 'no-cache'
  return 'public, max-age=60'
}

export type MapAccess = 'allow' | 'sign-in' | 'not-found'

/**
 * Who may open a server's map. A map that's off is never served. A public map needs the
 * public page on too, so turning the page off hides everything at once. Everyone else needs
 * to be able to see the server.
 */
export function mapAccess(input: {
  map: MapSettings
  publicPage: boolean
  /** Null when nobody is signed in. */
  canView: boolean | null
}): MapAccess {
  if (!input.map.enabled) return 'not-found'
  if (input.map.public && input.publicPage) return 'allow'
  if (input.canView === null) return 'sign-in'
  return input.canView ? 'allow' : 'not-found'
}

/**
 * Whether the map shows where players are. A map opened without signing in (`publicPage` is
 * the page it's shared through) never shows more than that page: only when it shows names.
 */
export function mapShowsPlayers(map: MapSettings, publicPage: PublicPage | null): boolean {
  if (!map.players) return false
  return !publicPage || publicPage.show.players === 'names'
}

/** Only what the viewer needs: its own script and style, and images from the panel. */
export const MAP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

/**
 * The viewer page. Its script and style are the panel's own static files; the version in
 * their address makes each release's copy fresh.
 */
export function viewerPage(input: { title: string; version: string }): string {
  const v = encodeURIComponent(input.version)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(input.title)} · Map</title>
<link rel="icon" href="/branding/favicon">
<link rel="stylesheet" href="/_map/viewer.css?v=${v}">
<script src="/_map/viewer.js?v=${v}" defer></script>
<script src="/_map/trim.js?v=${v}" defer></script>
</head>
<body>
<div id="map" data-title="${escape(input.title)}"></div>
<noscript>The map needs JavaScript.</noscript>
</body>
</html>
`
}
