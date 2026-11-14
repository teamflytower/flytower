---
section: Getting started
order: 1.5
---

# Choosing a VPS

Flytower runs on a virtual private server (VPS) that you rent from a hosting company. This page covers what to look for. You only need to read it once, before you [install](install.md).

## What Flytower needs

- **Ubuntu 24.04 or newer, or Debian 12 or newer.** Pick it as the image when you create the server. Both amd64 (Intel and AMD) and arm64 (such as Ampere) work.
- **A full virtual machine.** Most cloud servers are (KVM is the usual kind). Cheap "container" plans built on OpenVZ or LXC often can't run systemd services or set memory limits the way Flytower needs, so avoid them.
- **A public IPv4 address.** Players connect to it, and your panel's domain points at it. Some providers charge a little extra for one; it's worth it.
- **A domain name** you can add DNS records to, for the panel's own address (for example `panel.example.com`).

## How much memory

Memory is what decides how many servers you can run. Each server gets a fixed amount, and the panel itself needs a little on top.

| What you're running                    | Memory for that server |
| -------------------------------------- | ---------------------- |
| Vanilla or Paper, a handful of friends | 2 to 4 GB              |
| Vanilla or Paper, 10 to 20 players     | 4 to 6 GB              |
| Fabric with a few performance mods     | 3 to 5 GB              |
| A big modpack                          | 6 to 10 GB             |

Add those up for every server you want running at once, then add about 1 GB for the panel and the operating system:

- **4 GB VPS:** one small server.
- **8 GB VPS:** two or three small servers, or one bigger one. A good place to start.
- **16 GB VPS:** several servers, or a modpack alongside a vanilla world.

Most providers let you move to a bigger plan later without losing anything, so it's fine to start small. The **Servers** page shows how much memory you've given out and how much is free.

## CPU

Minecraft does most of its work on one thread, so a fast core matters more than many cores. Two cores is enough for one server; add one or two for each extra busy server.

"Shared" vCPU plans are fine for most groups. If a server lags even when the box is otherwise quiet (its card on the servers list shows [tick time](first-server.md)), a "dedicated" vCPU plan from the same provider is the usual fix.

## Disk

Worlds grow as players explore, and backups take room too. 40 GB is enough for one small server; 80 GB or more gives you space for several servers and a week of backups. The **Disk** page warns you before it fills up.

Backups on the same machine won't help if the machine is lost, so it's worth [copying them off-site](backups.md) to S3-compatible storage. That costs a few pence a month for most worlds.

## Location

Choose a data centre close to your players. Every 1,000 km adds roughly 10 milliseconds to each round trip. For a UK group, anywhere in western Europe is fine.

## Providers

Flytower is built and tested on **Hetzner Cloud** (its CPX range), and the [install guide](install.md) has a no-SSH setup for it. Any provider that meets the list at the top of this page should work, including OVHcloud, Netcup, DigitalOcean, Vultr and Linode. If you try one and something doesn't work, please [open an issue](https://github.com/teamflytower/flytower/issues) so this page can say so.

Plan names and prices change often, so compare the memory, CPU and disk on each provider's own price page rather than going by a plan's name.
