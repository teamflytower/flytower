---
title: Questions and answers
description: What Flytower is, what you need to run it, what it costs, and what happens to your servers if you stop using it.
---

# Questions and answers

## What is Flytower?

A web panel for running Minecraft: Java Edition servers on a VPS you rent. You install it once with one command, sign in with a passkey, and from then on you create, configure, back up and look after your servers in the browser. You can run several servers on one machine.

## Is it free?

Yes. Flytower is free software under the [AGPL-3.0](https://github.com/teamflytower/flytower/blob/main/LICENSE), with no paid tier, no ads in the panel and no telemetry. It's paid for by [sponsors](/sponsor). You do pay your hosting company for the VPS.

## What do I need?

- A VPS or a machine at home, such as a Raspberry Pi 5, running Ubuntu 24.04+ or Debian 12+ with at least 4 GB of memory. [Choosing a VPS](/docs/choosing-a-vps) explains what to look for.
- A domain name for the panel's address, such as `panel.example.com`.

Then follow the [install guide](/docs/install). It takes about five minutes.

## Do I need to know Linux?

Not much. On Hetzner Cloud you can install Flytower by pasting a few lines into the server form, without ever using SSH. On other providers you run one command over SSH. After that, everything is in the browser: Java, server files, mods, backups and updates.

## What does it cost to run?

Only the VPS, and that depends on the provider and how much memory you need. As a rough guide, from providers' price pages in November 2026:

| Plan                          | Memory | Price a month   |
| ----------------------------- | ------ | --------------- |
| Hetzner Cloud CPX22 (Germany) | 4 GB   | €19.99 + VAT    |
| Hetzner Cloud CPX32 (Germany) | 8 GB   | €35.99 + VAT    |
| DigitalOcean Basic Droplet    | 8 GB   | $48             |
| Budget providers' 8 GB plans  | 8 GB   | about $7 to $15 |

Optional extras are a domain (about £10 a year) and off-site backup storage (usually pennies a month). Prices change often, so check before you buy.

## Is it cheaper than a Minecraft host?

Not always, and it's worth being honest about that. A hosted Minecraft plan with 8 GB of memory typically costs $16 to $30 a month, for one server. An 8 GB VPS costs anything from about $7 to $48 a month, depending on the provider.

Where a VPS comes out ahead:

- **Several servers.** One 8 GB VPS can run two or three small servers. Most hosts charge for each server separately.
- **Budget providers.** The cheaper VPS providers cost less than a hosted plan of the same size, even for one server.
- **Control.** You can run any version, any mods, and keep the world for as long as you like.

Where a host comes out ahead: someone else does the admin, and support is a ticket away. If you'd rather not think about the machine at all, a host is a perfectly good choice.

## Which kinds of server can it run?

Vanilla, Fabric and Paper, in any version Mojang, Fabric or PaperMC publish. Mods and plugins come from Modrinth and Hangar, datapacks from Vanilla Tweaks, or you can upload your own. Bedrock Edition, Forge and NeoForge aren't supported.

## Can I move an existing server to Flytower?

Yes. **Import server** takes a zip of a world, or a whole server folder, from your own computer or another host. Vanilla, Fabric, Paper, Spigot and Purpur servers are recognised, along with their `server.properties`, whitelist, ops and bans. See [Your first server](/docs/first-server).

## What happens to my servers if I stop using Flytower?

They keep running. Each server is an ordinary server folder under `/srv/flytower/servers`, started by systemd like any other service. Nothing about them depends on the panel, so you can run them by hand or move them anywhere else.

## Is it secure?

Flytower is built to be safe to leave on the internet:

- You sign in with a passkey, so there's no password to guess or leak.
- The panel runs as its own unprivileged user. A small helper does the few jobs that need root, from a fixed list.
- Each Minecraft server runs as its own user, in its own folder, with its own memory limit.
- Updates are signed, checked before they're installed, and undone if they fail.

If you find a security problem, please report it privately rather than in a public issue: email [security@flytower.dev](mailto:security@flytower.dev) or use [GitHub's private reporting](https://github.com/teamflytower/flytower/security/advisories/new). The [security policy](https://github.com/teamflytower/flytower/blob/main/SECURITY.md) has the details.

## Can friends help run the servers?

Yes. Invite them with a link and choose what they can do, on one server or all of them. See [People and roles](/docs/people).

## Can I run it at home?

Yes. A Raspberry Pi 5 with 8 GB runs Flytower well, with room for one or two small servers and nothing to pay each month. You'll need a public IPv4 address from your broadband provider and a few ports forwarded on your router. [Choosing a VPS](/docs/choosing-a-vps#at-home-on-a-raspberry-pi) walks through it.

## How do players join?

With the VPS's address and a port, or with a hostname you give each server, such as `survival.example.com`. Flytower tells you which DNS records to create. See [Addresses and DNS](/docs/addresses).

## Who makes Flytower?

Flytower was built to run the Minecraft server at the [Nottingham New Theatre](https://www.newtheatre.org.uk), and is now developed in the open on [GitHub](https://github.com/teamflytower/flytower). [Read where the name comes from](/why-flytower).
