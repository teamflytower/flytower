---
section: Running servers
order: 12
---

# Addresses and DNS

By default players connect to your VPS's IP address, with a port for every server after the first. A **hostname** per server lets them type `survival.example.com` instead, with no port.

## Setting one

A server's **Settings**, **General**, **Address**: enter the hostname, such as `survival.example.com`. You can also set it with `hostname:` in the [YAML](spec.md). Two servers can't share one.

## DNS records

Under the address, **DNS records** lists exactly what to create with your DNS provider:

- An **A record** (and **AAAA** if the machine has IPv6) pointing the hostname at the VPS.
- An **SRV record** (`_minecraft._tcp.<hostname>`), when the server isn't on port 25565. This tells Minecraft which port to use, so players don't need to type it.

On Cloudflare, set the records to **DNS only** (grey cloud). Minecraft traffic can't go through Cloudflare's proxy.

**Check again** looks the records up and marks each one **Right**, **Missing** or **Wrong** (with where it points now). DNS changes can take a few minutes to show.

## One address for every server

Normally each server has its own port, so players need an SRV record to skip typing it. With **One address for every server**, every server with a hostname shares one port (25565 by default), and Flytower's hostname router sends each player to the server whose address they typed. Servers without a hostname keep their own port as before.

Turn it on under **System**, **Addresses** (it needs the **Manage addresses** permission and a recent sign-in check):

1. Choose the port players connect to. 25565 means nobody types a port, and no SRV records are needed.
2. **Turn on**. If a server was already on that port, it moves to the next free one, and the page lists it.
3. Restart your servers. From their next start, servers with a hostname listen only inside the machine, and their own ports close in the firewall, so the router is the only way in.

DNS records then only need the **A** (and **AAAA**) record. If you made an SRV record for the old port, **DNS records** warns you to delete it: Minecraft would follow it to a port that's now closed.

When a server is stopped or starting, the router answers for it, in the server list and when someone tries to join. **What players see** sets those messages, and the one for an address with no server. `§` codes add colour and `{hostname}` becomes the address the player typed.

### Players' real addresses

Behind the router, a server sees every connection as coming from the machine itself. So that bans, logs and plugins see each player's real address:

- **Fabric** servers get Flytower's own small mod, `flytower-proxy`, which the panel puts in `mods/` while the server has a hostname. It ships with each Flytower release and is signed with it. It only listens to the router: connections from anywhere else are left alone.
- **Paper** servers do it by themselves. The panel turns on `proxies.proxy-protocol` in `config/paper-global.yml` (after the server's first start, when Paper writes that file).
- **Vanilla** servers can't. They see every player as `127.0.0.1`. Don't use `/ban-ip` with a player's name there, since it would ban the router and so everyone; use `/ban` instead.

Either way it starts at the server's next restart. The **Real addresses** column on the Addresses page says which servers have it now, and which will after a restart.

The router also enforces each server's IP bans (`banned-ips.json`) itself, before a banned address reaches the server.

### Turning it off

**Turn off** gives every server its own public port back, takes the mod out of Fabric servers, and turns Paper's setting off. Restart your servers for it to take effect.

## The panel's own address

The panel's domain is set when you install (`--domain`). Caddy gets and renews its certificate. To move the panel to another domain, re-run the installer with the new `--domain`. Your passkeys belong to the old domain, so sign in with a [recovery code](account.md) once on the new one, then add a passkey.
