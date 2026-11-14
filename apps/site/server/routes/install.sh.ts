// flytower.dev/install.sh: a short address for the installer. It only redirects to the latest
// release's install.sh on GitHub, so the script and its signature never live on the site, and
// the long GitHub address keeps working for anyone who prefers it.
const LATEST = 'https://github.com/teamflytower/flytower/releases/latest/download/install.sh'

export default defineEventHandler((event) => {
  // Short-lived, so a new release is picked up straight away.
  setResponseHeader(event, 'cache-control', 'public, max-age=300')
  return sendRedirect(event, LATEST, 302)
})
