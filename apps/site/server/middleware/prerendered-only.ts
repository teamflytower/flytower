// Every page is prerendered and served as a static asset before the Worker runs. Anything that
// reaches the Worker and isn't an API route is therefore a page that doesn't exist, so answer
// with the prerendered 404 page instead of rendering (and querying the docs database) at runtime.
// Server routes added later (a mailing list, opt-in telemetry) go under /api and are unaffected,
// and so is the /install.sh redirect.
export default defineEventHandler(async (event) => {
  if (import.meta.prerender || import.meta.dev) return
  if (event.path.startsWith('/api/') || event.path === '/install.sh') return
  const assets = (event.context.cloudflare?.env as { ASSETS?: { fetch: typeof fetch } } | undefined)
    ?.ASSETS
  if (!assets) return
  const page = await assets.fetch(new URL('/404.html', getRequestURL(event)))
  setResponseStatus(event, 404)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return page.text()
})
