---
section: Running servers
order: 15
since: '1.1.0'
---

# Crashes

Flytower notices when a server crashes, tells you why, and stops a server that keeps crashing from restarting forever. It also spots a server that is still running but has stopped responding.

## What happens when a server crashes

Flytower follows systemd (through its system helper, which listens to systemd's own signals), so it hears about a crash, or a server started or stopped with `systemctl`, as it happens, without checking over and over. As a safety net it also looks at every server every five minutes. If systemd can't be followed, it falls back to checking every ten seconds.

1. systemd restarts it after 15 seconds. On newer systems (systemd 254 or later, such as Ubuntu 24.04) the wait grows with each crash, up to a minute.
2. Flytower records the crash with its cause, a link to Minecraft's crash report if one was written, and the last 50 lines of the log (which would otherwise be lost when the server starts again).
3. The server's badge reads **Restarting after a crash**, and the **Console** tab shows a banner with the time, the cause and an **Open crash report** button, which opens the report in the **Files** tab. The banner stays until you close it, even after the server is back. The servers list shows a red dot next to a server with a crash nobody has looked at.
4. The crash is in **Activity**, credited to Flytower, and a [notification](notifications.md) is sent, followed by "Server is back up" once players can join again (when the log says it's ready).

The cause is one of:

- **Minecraft crashed**, with the crash report's description, such as "Exception ticking world".
- **Out of memory**: either the server went over its memory limit and the system stopped it, or Java ran out of heap. Give it more memory under **Settings**, **General**, or take out mods.
- **Java itself crashed** (an `hs_err_pid….log` file in the server folder).
- **It exited with code N**, or **It was killed by SIGKILL** (or another signal), when there's nothing more specific.

Every crash, crash loop and "not responding" from the last 30 days is listed under the Console's **Crashes** button (or **View logs**, **Crashes**), each with its crash report and the log from just before it.

## Crash loops

After three crashes in ten minutes, the server is left stopped and marked **Crash-looping**, and a "Server keeps crashing" notification is sent. Fix the cause (the crash report usually says which mod), then press **Start**. Starting it from Flytower clears the crash loop.

## Not responding

Once a minute, Flytower asks each running server for its player list and tick time over RCON (the same questions as the performance charts on the servers list). If a server that systemd says is running doesn't answer for five minutes in a row, it's marked **Not responding** and a notification is sent. A server that has only just started gets fifteen minutes, since a big world can take a while to load.

Nothing else happens unless you turn on **Restart it when it stops responding** under the server's **Settings**, **Maintenance** (or `recovery: { restartWhenUnresponsive: true }` in its [YAML](spec.md#recovery)). Then Flytower restarts it once. If it's still stuck afterwards, it stays marked but isn't restarted again until it has answered at least once.

## What isn't a crash

- Stopping or restarting from Flytower, including the stop and start around applying changes, restoring a backup or resetting the world, even if the server crashes on the way down.
- Typing `stop` in the console. The server stops normally and isn't restarted.

If Minecraft writes a crash report and then exits normally (so systemd sees a clean exit), Flytower still counts it as a crash and starts the server again itself, within the same three-in-ten-minutes limit.
