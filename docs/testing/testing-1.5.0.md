# Testing 1.5.0

1.5 is the native core: the Rust agent on its own, systemd over D-Bus, live event streams, the hostname router and chunk trimming. Try it on a **test box** first.

## Installing the beta

On a spare VPS, or a test box on 1.4.3:

```sh
curl -fsSL https://flytower.dev/install.sh | sudo bash -s -- --beta --domain panel.example.com
```

On a box that already runs Flytower, switch it to the Beta channel under **System, Updates** and update from there instead. **Go back to** returns to 1.4.3.

## 1. Updating from 1.4.3

- [ ] The update finishes and the panel comes back without a manual restart.
- [ ] `systemctl status flytower-agent` is active, and `/opt/flytower/current/bin/flytower-agent --version` prints 1.5.0-beta.1.
- [ ] A box that had `bun` in `/etc/flytower/agent` still updates and runs the Rust agent.
- [ ] A box that was on the Native channel shows a notice and is now on Stable or Beta.
- [ ] Servers that were running before the update are still running.

## 2. Systemd over D-Bus (not yet tried on a real box)

- [ ] Start, stop and restart a server from the panel: each takes effect within a second or two, and the status badge follows.
- [ ] Stop a server from the shell with `systemctl stop flytower-server@<name>`: the panel shows it stopped without a reload.
- [ ] Kill the Java process (`kill -9`): the crash banner appears and the server restarts as before.
- [ ] `journalctl -u flytower-agent -n 50` shows no D-Bus errors.

## 3. Live streams

- [ ] The console shows new lines as they arrive, including straight after a restart.
- [ ] Join and leave: the player list and join notifications update straight away.
- [ ] Restart the agent (`systemctl restart flytower-agent`) with a console open: it reconnects and carries on, with no duplicated lines.

## 4. One address for every server

Follow the [addresses guide](../addresses.md) and [Testing real player addresses](testing-real-addresses.md).

- [ ] Turn on **One address for every server** under **System, Addresses**. Two servers with their own hostnames are both reachable on port 25565.
- [ ] A stopped server's hostname answers in the server list with its stopped message, and an unknown hostname gets the router's message.
- [ ] Fabric server (not yet tried on a real one): after a restart, the log shows your real address when you join, and `/ban-ip` keeps you out.
- [ ] Turn it off: each server goes back to its own port.

## 5. Trim unused chunks

See [Trim unused chunks](../trim.md). Use a copy of a world that has been played for a while.

- [ ] **World, Tools, Trim unused chunks** shows a preview: how many chunks and how much space would go.
- [ ] **Show on map** shades the chunks that would go, and protected areas are drawn and never shaded.
- [ ] Trim, then join: builds, spawn and beds are intact, and walking into trimmed areas generates fresh terrain.
- [ ] The world's size on the disk page goes down, and the next backup is smaller.
