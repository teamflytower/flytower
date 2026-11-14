# Testing the Rust agent

The agent is the small helper that runs as root and does the jobs the panel can't: starting and stopping servers, creating their users and folders, the firewall, Java and updates. From 1.5.0 it is the Rust agent and nothing else: the Bun agent, the fallback to it and the `/etc/flytower/agent` switch are gone. The way back from a bad release is the previous release, which the updater rolls back to by itself.

## Which one is running

On the VPS, as root:

```sh
journalctl -u flytower-agent -n 5
```

It says `flytower-agent <version> (rust) listening`. `readlink -f /proc/$(systemctl show -p MainPID --value flytower-agent)/exe` ends in `bin/flytower-agent`.

## Checks

- [ ] After installing or updating, the journal shows the Rust agent listening, and `/opt/flytower/current` has no `agent` folder.
- [ ] A box from 1.4 that had `bun` in `/etc/flytower/agent` runs the Rust agent after updating. The file is ignored.
- [ ] **System**: the agent shows as connected, with the same version as the panel.
- [ ] **Start**, **Stop** and **Restart** a server. The status changes straight away, with no refresh.
- [ ] Stop the server from SSH (`systemctl stop flytower-mc@<name>`). The panel notices within a few seconds.
- [ ] The agent talks to systemd over D-Bus, not by running `systemctl`: while you start and stop a server from the panel, `ps -ef | grep '[s]ystemctl'` shows nothing from the agent.
- [ ] Kill a running server (`systemctl kill -s KILL flytower-mc@<name>`). The crash shows within a few seconds, with the signal as its cause.
- [ ] `systemctl restart flytower-agent` while a server is running. The panel reconnects, the status is still right, and the server keeps running.
- [ ] Create a new server on a Java version you haven't used yet. Java downloads and the server starts.
- [ ] Change a server's memory and port in **Settings**, then restart it. Both take effect.
- [ ] **System**, **SSH**: open SSH for 5 minutes, check you can connect, then let it close by itself. Restart the agent while it's open and check it still closes on time.
- [ ] Delete a test server. Its folder is archived under `/var/lib/flytower-archive`.
- [ ] **System**, **Updates**: update to a newer build, then use **Go back to** a 1.4 release and forward again. Each works, and `journalctl -u 'flytower-update-*'` shows the updater's result as one JSON line.

From 1.5.0 the Rust agent also speaks protocol 2 (subscriptions, see `protocol/README.md`), and answers `agent.hello`. To ask, as root:

```sh
printf '{"id":"1","verb":"agent.hello","params":{}}\n' | nc -U -q1 /run/flytower/agent.sock
```

- [ ] The answer has `"kind":"rust"` and `"protocols":[1,2]`.
- [ ] `service.status` gives the same start time as systemd, in the box's time zone:

```sh
printf '{"id":"1","verb":"service.status","params":{"server":"<name>"}}\n' | nc -U -q1 /run/flytower/agent.sock
systemctl show -p ActiveEnterTimestamp --value flytower-mc@<name>
```

If anything goes wrong, send `journalctl -u flytower-agent -n 100`.
