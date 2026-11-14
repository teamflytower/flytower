// Keeps the hostname router's routes in step with servers starting and stopping (#76). Runs
// after the crashes plugin (alphabetical), which follows systemd, so this only listens.
// sync() does nothing while routing is off, so turning it on later needs no restart.
export default defineNitroPlugin((nitro) => {
  const routing = useRouting()
  const stop = useStatus().watch(() => routing.sync())
  routing.sync()
  nitro.hooks.hook('close', () => {
    stop()
    routing.close()
  })
})
