// Crash detection: follows systemd through the agent, so a crash is noticed as it
// happens with no browser open and nothing polled. With a protocol 2 agent each change
// arrives as an event (service.events). See StatusWatcher.follow.
export default defineNitroPlugin((nitro) => {
  const status = useStatus()
  status.follow({ events: agentStatusEvents })
  nitro.hooks.hook('close', () => status.unfollow())
})
