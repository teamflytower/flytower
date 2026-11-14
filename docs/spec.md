---
section: Running servers
order: 17
panelRoute:
  - '/servers/:name/settings/yaml'
  - '/servers/from-yaml'
---

# Server YAML reference

Every server can be written as one YAML document, its **spec**. **Settings**, **YAML** shows a server's spec and lets you edit it. **New server**, **From YAML** makes a server from one. Changes go through a [plan](first-server.md#plans) like any other.

The first line points editors at the schema (`/schema/server-v1.json` on your panel). In VS Code with the YAML extension, that gives you autocomplete and checking.

## Example

```yaml
# yaml-language-server: $schema=https://panel.example.com/schema/server-v1.json
name: survival
displayName: Weekend Survival
loader:
  type: fabric
  minecraft: '26.3'
memory: 6G
port: 25566
hostname: survival.example.com
properties:
  motd: Welcome back
  difficulty: normal
  max-players: 30
  view-distance: 12
content:
  - modrinth: lithium
  - modrinth: chunky
  - vanillatweaks: Survival/multiplayer sleep
  - url: https://example.com/my-datapack.zip
    sha256: 0f343b0931126a20f133d67c2b018a3b5f0c6d0e7c5c1f2a2b1e5c8d9f7a6b5c
    kind: datapack
backups:
  schedule: '0 4 * * *'
  timezone: Europe/London
  keep: { last: 6, daily: 7, weekly: 4 }
  offsite: B2
timezone: Europe/London
schedules:
  - restart: '0 5 * * *'
  - command: save-all
    cron: '*/30 * * * *'
  - announce: 'The server restarts at 5am'
    cron: '0 22 * * *'
```

## Fields

### `name` (required)

The short name, used for the server's folder, user and unit. Lowercase letters, digits and hyphens, 2 to 31 characters, starting with a letter. It can't change once the server exists.

### `displayName`

What players and you see. Defaults to the name.

### `loader` (required)

| Field       | Meaning                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `type`      | `vanilla`, `fabric` or `paper`.                                                                             |
| `minecraft` | The Minecraft version, **in quotes** (unquoted, YAML reads `1.20` as the number 1.2).                       |
| `version`   | The Fabric loader version or Paper build number. Leave it out for the newest stable one when the plan runs. |

Changing the version or loader goes through a plan that takes a backup first. Going back to an older Minecraft version is refused, because worlds can't be downgraded. Restore a backup instead.

### `memory`

Memory for Java, like `4G` or `3584M`, between 1G and 64G. It must fit the machine's [memory budget](first-server.md#memory-budget).

### `port`

The game port, 1024 to 65535. Leave it out to use the next free one. Clashes with other servers are refused.

### `hostname`

The address players use, such as `survival.example.com`. `null` clears it; left out, it stays as it is. See [Addresses and DNS](addresses.md).

### `properties`

Values for `server.properties`: strings, numbers or booleans. Anything left out keeps its current value. Values equal to Minecraft's defaults are left out when Flytower writes a spec. Some keys can't be set here:

- `server-port`, `enable-rcon` and `rcon.port` are managed by Flytower. Set the port with `port`.
- Secrets are hidden: `rcon.password`, `management-server-secret`, and any other key ending in `secret` or `password` (such as `-secret` or `.password`). They're never written into a spec or shown in the Settings form, and editing other properties or applying a spec keeps whatever secret is on disk. A cloned server gets fresh secrets of its own. To change one by hand, edit `server.properties` in the **Files** tab.

`motd` is the message of the day, shown under the server in the multiplayer list. It can have two lines and Minecraft's `§` formatting codes: colours `§0` to `§f`, `§l` bold, `§o` italic, `§n` underline, `§m` strikethrough, `§k` obfuscated and `§r` to reset. In YAML, use double quotes so `\n` starts the second line:

```yaml
properties:
  motd: "§6§lNew Theatre §r§7Survival\n§bOpen to members"
```

The editor in **Settings**, **General**, **Game settings** writes the same string, so you rarely need to type codes by hand. Hex colours aren't supported, because vanilla only reads the 16 colours from `server.properties`.

### `content`

The full list of what the server runs. Anything installed through Flytower that isn't listed is removed. Dependencies don't need listing. Each item is one of:

| Item           | Fields                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modrinth       | `modrinth`: project slug or id. `version`: a version number or id (newest compatible if left out). `kind`: `mod`, `plugin` or `datapack`, rarely needed. |
| Hangar         | `hangar`: `slug` or `owner/slug` (Paper only). `version`: a version name (newest compatible if left out).                                                |
| Vanilla Tweaks | `vanillatweaks`: `"Category/pack name"`, as on their site. `tweak`: `crafting` for a crafting tweak; datapack otherwise.                                 |
| A link         | `url`: an `https` link. `sha256`: the file's hash; it's refused if it doesn't match. `kind`: `mod`, `plugin` or `datapack`. `filename`: optional.        |

See [Mods, plugins and datapacks](content.md).

### `backups`

Left out entirely, a server's backup settings stay as they are. When present:

| Field      | Meaning                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule` | A cron expression (minute hour day month weekday), such as `'0 4 * * *'` for 4am daily, or `null` for no schedule.                        |
| `timezone` | The time zone the schedule runs in, such as `Europe/London`. Defaults to UTC.                                                             |
| `keep`     | `last` (default 6), `daily` (7) and `weekly` (4): how many scheduled backups to keep. See [Backups](backups.md#how-many-are-kept).        |
| `offsite`  | The name of [off-site storage](backups.md#off-site-copies) from **System**, **Off-site storage**, or `null` for none. Left out, it stays. |

### `recovery`

What Flytower does when the server gets stuck. Left out, the current setting stays.

| Field                     | Meaning                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restartWhenUnresponsive` | `true` to restart the server once when its console hasn't answered for five minutes. Defaults to `false`. See [Crashes](crashes.md#not-responding). |

### `public`

The server's [public status page](status-page.md). Left out, the current settings stay.

| Field              | Meaning                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `true` to turn the page on at `/s/<name>`. Defaults to `false`.                                                       |
| `description`      | A few lines about the server, up to 500 characters, shown as plain text with line breaks.                             |
| `show.players`     | `count` (the default) shows how many are online, `names` shows their heads and names, `none` shows nothing.           |
| `show.version`     | `false` to hide the Minecraft version and loader. Defaults to `true`.                                                 |
| `show.leaderboard` | `true` to show the player stats leaderboards. Needs `show.players: names` and stats on. Defaults to `false`.          |
| `pack.enabled`     | `false` to stop offering the players' [modpack](status-page.md#modpack-for-players). Defaults to `true`; Fabric only. |
| `pack.extras`      | Client-only extras for the modpack: a list of `modrinth: <slug>`, each with an optional exact `version`.              |

```yaml
public:
  enabled: true
  description: |
    Survival for New Theatre members.
    Season 3 started in September.
  show:
    players: names
  pack:
    extras:
      - modrinth: iris
      - modrinth: complementary-reimagined
```

### `map`

The server's [web map](map.md). Left out, the current settings stay.

| Field     | Meaning                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` | `true` to draw a web map of the world. Defaults to `false`.                                                                                  |
| `public`  | `true` to let anyone open the map without signing in. Needs the public page on. Defaults to `false`: only people who can see the server can. |
| `players` | `false` to hide where players are. Defaults to `true`.                                                                                       |

```yaml
map:
  enabled: true
  public: true
```

### `world`

World settings. Left out, the current settings stay. For now it holds one thing, `trim`: what **Trim unused chunks** keeps. Trimming itself is started from the World tab, never by applying a spec, and applying changed rules never restarts the server. You can also change them in the World tab, under :ui{anchor="world.trim-rules"}.

A chunk is removed only when every rule agrees it can go. Distances are in chunks (16 blocks), measured as squares.

| Field              | Meaning                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inhabitedMinutes` | Keep chunks players have spent at least this many minutes in, in total. 0 to 60, defaults to `2`. Even at 0, a chunk anyone has spent time in is kept. |
| `spawnRadius`      | Chunks kept round world spawn. 0 to 256, defaults to `16`.                                                                                             |
| `playerRadius`     | Chunks kept round each player's last position and respawn point. 0 to 64, defaults to `4`.                                                             |
| `buffer`           | Chunks kept round every kept chunk, so builds never end at a seam. 0 to 16, defaults to `2`.                                                           |
| `endRadius`        | In the End, chunks kept round 0,0 (the main island). 0 to 256, defaults to `12`.                                                                       |
| `unfinished`       | `false` to keep half-generated chunks. Defaults to `true`: they are removed wherever they are.                                                         |
| `border`           | `false` to keep chunks wholly outside the world border. Defaults to `true`: they are removed.                                                          |
| `dimensions`       | The dimensions to trim; others are left alone. Defaults to `[overworld, the_nether, the_end]`. Modded ones are written like `mod:sky`.                 |
| `protect`          | Areas that are always kept, whatever the rules say. Up to 100.                                                                                         |

Each protected area has a `name` (unique, up to 60 characters), two opposite corners `from` and `to` as `[x, z]` in block coordinates (press F3 in game to see them), and a `dimension` (defaults to `overworld`). Every chunk the area touches is kept.

```yaml
world:
  trim:
    inhabitedMinutes: 2
    spawnRadius: 16
    playerRadius: 4
    buffer: 2
    dimensions: [overworld, the_nether, the_end]
    protect:
      - name: Town
        from: [-400, -300]
        to: [350, 420]
      - name: Nether hub
        dimension: the_nether
        from: [-40, -40]
        to: [40, 40]
```

Changing the rules needs the **Manage the world** permission. The plan shows them under **Trim rules**.

### `timezone`

The time zone the server's [scheduled tasks](schedules.md) run in, such as `Europe/London`. Left out, it stays (UTC to begin with). Backups have their own, under `backups`.

### `schedules`

Restarts, console commands and announcements the server runs by itself. See [Scheduled tasks](schedules.md). When present, the whole list is replaced (tasks that haven't changed keep their last run). Left out, the current tasks stay; write `schedules: []` to remove them all. Each item is one of:

| Item                                                 | Meaning                                                                                                                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restart: '0 5 * * *'`                               | Restart at these times. `warn` lists when to warn players beforehand, like `[15m, 5m, 1m, 10s]` (the default), up to `2h`; `[]` for none. `skipWarningsWhenEmpty` (default `true`) restarts straight away when nobody is online. |
| `command: save-all`<br>`cron: '*/30 * * * *'`        | Run a console command, without the slash. It can't be `stop`; use a restart instead.                                                                                                                                             |
| `announce: 'Restart at 5am'`<br>`cron: '0 22 * * *'` | Show a line in everyone's chat, in gold or the brand colour. At most 256 characters.                                                                                                                                             |

Applying changed schedules never restarts the server. The plan lists tasks added and removed under **Schedules**.

## Errors

Mistakes are marked on their line with a message saying what's wrong, and you can't apply until they're fixed. Problems the plan finds (a port in use, a mod with no build for your version, not enough memory) are listed in the plan, and stop it from applying.
