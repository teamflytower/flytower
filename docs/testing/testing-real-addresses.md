# Testing real player addresses behind the router

For #76's last part: Fabric servers get the `flytower-proxy` mod, Paper servers get `proxies.proxy-protocol`, and the router sends a PROXY header only to servers that were started with either in place. It also enforces each server's `banned-ips.json`.

You need a test VPS with the pull request's build and the Rust agent, and **One address for every server** turned on under System, Addresses (see the [addresses guide](../addresses.md)). Make three servers with hostnames: one Fabric, one Paper and one vanilla, all on Minecraft 26.3.

## Fabric

1. Start the Fabric server. `mods/flytower-proxy.jar` appears in its folder (Files tab). It doesn't show in the Content tab's hand-added list.
2. On the Addresses page, its **Real addresses** column says **After a restart**. Join: the server log shows you as `127.0.0.1`.
3. Restart it. The column says **Yes**. Join again: the log shows your own public address.
4. In the console, `/ban-ip <your address>`. Within a second, joining shows the router's "You can't join this server", and the server list still works. `/pardon-ip` lets you back in.
5. On the VPS, `nc 127.0.0.1 <server port>` then Ctrl-C, and check the server log has no errors: connections from the machine without a header still work (the panel's own checks rely on this).

## Paper

1. Start the Paper server once so it writes `config/paper-global.yml`. Within a moment `proxies.proxy-protocol` is `true`.
2. Until you restart it, **Real addresses** says **After a restart** and joining still works (the router doesn't send a header yet). After a restart it says **Yes** and Paper logs your real address.

## Vanilla

**Real addresses** says **No**, and players show as `127.0.0.1`. `/ban-ip <an address>` still keeps that address out, at the router.

## Turning off

**Turn off**, then check the mod has gone from the Fabric server's `mods/` and Paper's setting is back to `false`. After restarts, all three are reachable on their own ports.
