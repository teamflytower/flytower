---
section: Looking after the machine
order: 22
panelRoute:
  - '/system/updates'
---

# Updating Flytower

## From the panel

**System**, **Updates** shows the version you're on and offers any newer release, with its notes. **Update** asks for your passkey, then:

1. downloads the release and checks its signature against Flytower's release key;
2. copies the panel's database aside, into `/var/lib/flytower-agent/db-backups`, which only root can read. If the copy can't be made (a full disk, say), the update stops there and your database is left exactly as it was;
3. switches to the new version and restarts the panel and agent. Your Minecraft servers keep running throughout;
4. checks the new panel starts and answers. If it doesn't, Flytower puts the previous version and the database back by itself, and the card says what went wrong.

The panel is away for a minute or so. **Go back to** the previous version is offered afterwards in the same way. Both show up in **Activity**.

One update runs at a time: while one is downloading or switching, another update, a **Go back to** or a clean-up of old releases is refused until it's done. The system helper only installs releases newer than the one running. To go back, use **Go back to**, which offers the releases still on the machine.

## Stable or Beta

The **Update channel** on the same card chooses what you're offered:

- **Stable** (the default): finished releases only.
- **Beta**: betas too, such as `1.1.0-beta.1`, so you can try new features before they're released. They're signed and tested like any release, but may have rough edges. Take a backup of anything you care about first.

Changing the channel doesn't install anything, and shows up in **Activity**. A beta is marked **Beta** when it's offered.

Choosing Stable again while you're running a beta doesn't take you backwards: you're offered the next stable release that's newer than your beta (`1.1.0` comes after `1.1.0-beta.3`). To leave a beta sooner, **Go back to** the version you had before.

If you install a beta with the installer and never choose a channel, Flytower assumes Beta.

## Native builds (ended)

From 1.2 to 1.4 there was a **Native** channel, with test builds of Flytower's Rust system helper numbered after the release they went with (`1.4.3-native.1` went with 1.4.3). Since 1.5.0 every release has the Rust helper, so there are no more native builds, and the channel and the installer's `--native` are gone.

A box that was on the Native channel is offered the releases of the channel its version belongs to: Stable for `1.4.3-native.1`, Beta for `1.4.0-beta.2.native.1`. **System, Updates** says so until you choose a channel.

From 1.5.0, the system helper and the updater are Rust only. The Bun versions, which 1.4 kept as a fallback, are gone. If an update's helper won't start, the update fails its health check and rolls back to the version you had, as any failed update does. 1.4 let you choose Bun with `/etc/flytower/agent`; 1.5.0 ignores that file, and you can delete it.

## Releases are signed

Each release's `SHA256SUMS` is signed with Flytower's Ed25519 release key. The installer and the updater both check the signature before installing anything, using the public key built into them. A download that doesn't match is refused.

## Re-running the installer

Running the installer again keeps your data, settings and app secret. On a box that already has Flytower it also keeps the installed version, so a beta or test box stays as it is. Use it if the panel won't start at all, or for a new setup token:

```sh
curl -fsSL https://github.com/teamflytower/flytower/releases/latest/download/install.sh \
  | sudo bash -s -- --domain panel.example.com
```

To change version with it, add `--version <x.y.z>`, `--version latest` (the newest stable release), or `--beta`. Installs from before 0.5.0, which had no updater, upgrade this way with `--version latest`. If the version you pick is older than the one installed, the installer saves a copy of the panel's database in `/var/lib/flytower-agent/db-backups/` before switching, since older code may not understand newer data.

Every release is tested upgrading from each earlier one, including the database, before it's published.

## Minecraft and Java

Flytower updates itself, not your servers. Minecraft versions change only when you choose (Settings, **Version**), and mods and plugins only when you update them. See [Content](content.md#updates). Java is installed per server as each Minecraft version needs it.

## Update badges

Flytower looks for updates in the background, so you don't have to remember to press **Check now**. It never installs anything by itself; it only tells you.

| What                     | Where it shows                                                                  | Compared with                                                                               |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Flytower                 | A count on **System** in the sidebar and on **Updates**; a banner on **System** | The newest release on your [update channel](#stable-or-beta)                                |
| Mods, plugins, datapacks | A count on the server's card and on its **Content** tab                         | Newer builds for the server's Minecraft version, the same as the Content tab                |
| Minecraft                | A note on the **Content** tab                                                   | The newest release the loader supports, and whether everything installed has a build for it |
| Java                     | **System**, **Updates**, under **Java**                                         | Adoptium's newest Temurin build for the same Java version                                   |

**When.** Every six hours, at a minute and hour picked when the panel starts, so installs don't all ask Modrinth and GitHub at once. Opening the panel checks again if the last check is over an hour old, and **Check now** on **System**, **Updates** checks everything straight away. Badges update by themselves in open tabs as results arrive.

**A newer Minecraft is only mentioned.** Upgrading a world can't be undone without a backup, so Flytower never notifies about it or offers it as an update. The Content tab says when one is out, and either that everything installed is ready for it, or which items don't have a build yet (and, if there is one, the newest version that everything is ready for). Change version from Settings, **Version** when you're ready.

**When a check fails**, for example because Modrinth or GitHub is down, the last good result and its badge stay, and a quiet line says the check failed. Nothing is sent to notification channels, and the next good check clears the message.

**Notifications.** The same check feeds the **A new version of Flytower is out** and **Updates for installed mods, plugins or datapacks** notifications: one message per new version, not one per check. See [Notifications](notifications.md).

**Java** shows each Java version Flytower has installed, which servers use it, and whether Adoptium has a newer build. Installing the newer build from the panel isn't there yet; until then servers keep running on the build they have.

## Publishing a beta

For maintainers: run the **Release** workflow with a version like `1.1.0-beta.1`. Any version with a `-suffix` is published as a GitHub pre-release, which only Beta installs are offered. Number betas `beta.1`, `beta.2` and so on; `beta.10` correctly comes after `beta.9`.
