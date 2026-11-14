# Testing the hostname router

`flytower-router` lets every server on a machine share port 25565: it reads the hostname the player typed from Minecraft's first packet and passes the connection to that server. Until the panel can turn it on (#76), it ships in each build but nothing starts it, so you set it up by hand on a **test box**. Run everything below as root.

## Set it up

You need a server running in the panel (say `survival` on port 25566) and two hostnames that point at the box. A wildcard record such as `*.mc.example.com` covers both. A hosts-file entry on your own computer works too.

The router listens on 25565 by default. If a server already uses 25565 on this box, use another port for the test with a drop-in:

```sh
cp /opt/flytower/current/systemd/flytower-router.service /etc/systemd/system/
mkdir -p /etc/systemd/system/flytower-router.service.d
cat > /etc/systemd/system/flytower-router.service.d/test.conf <<'CONF'
[Service]
ExecStart=
ExecStart=/opt/flytower/current/bin/flytower-router serve --allow-user flytower --listen :25570 --verbose
CONF
systemctl daemon-reload
systemctl start flytower-router
ufw allow 25570/tcp
journalctl -u flytower-router -n 5
```

The journal says `routing players` with the version and `routes=0`.

## Give it routes

Write a table (change the hostnames and port to yours):

```sh
cat > /tmp/routes.json <<'JSON'
{
  "routes": [
    { "name": "survival", "hostnames": ["survival.mc.example.com"], "port": 25566,
      "state": "running", "proxyProtocol": false, "bans": [] },
    { "name": "creative", "hostnames": ["creative.mc.example.com"], "port": 25567,
      "state": "stopped", "proxyProtocol": false, "bans": [] }
  ],
  "messages": {
    "unknownMotd": "§7No server at this address",
    "unknownDisconnect": "There's no server at {hostname}.",
    "stoppedMotd": "§cThis server is stopped",
    "stoppedDisconnect": "This server is stopped.",
    "startingMotd": "§eStarting up, try again in a moment",
    "startingDisconnect": "The server is starting.\nTry again in a moment.",
    "bannedDisconnect": "You can't join this server."
  }
}
JSON
/opt/flytower/current/bin/flytower-router ctl -control /run/flytower-router/router.sock routes.set - < /tmp/routes.json
```

It prints `"routes": 2`. A table with a mistake in it is refused with `invalid_params` and says what's wrong, and the old table stays.

## What to try

In Minecraft, add each address with the test port (for example `survival.mc.example.com:25570`):

1. **`survival…`** shows the server's real MOTD and player count, and you can join and play.
2. **`creative…`** (stopped) shows "This server is stopped" in the list, and joining shows the disconnect message.
3. **Any other name** under the wildcard shows "No server at this address", and joining names the address you typed.
4. **Stop `survival` in the panel** while its route still says `running`. The list shows "Starting up", rather than "Can't connect to server".
5. **Bans:** add your own address to `survival`'s `bans`, send the table again, and joining shows "You can't join this server". The server list still works.
6. **Keeping routes:** `systemctl restart flytower-router`, then check `routes.status` still lists both routes. Edit `/var/lib/private/flytower-router/routes.json` and `systemctl reload flytower-router` to load it without the control socket.
7. **Counts:** `flytower-router ctl -control /run/flytower-router/router.sock routes.status` shows connections per route, unknown addresses and refused connections.

The PROXY protocol (`"proxyProtocol": true`) only works once the server expects it: Paper with `proxies.proxy-protocol: true` in `config/paper-global.yml`. Without that, the server sees garbage and drops the connection. #76 switches it on for you.

## Tidy up

```sh
systemctl disable --now flytower-router
rm -r /etc/systemd/system/flytower-router.service /etc/systemd/system/flytower-router.service.d
systemctl daemon-reload
ufw delete allow 25570/tcp
```
