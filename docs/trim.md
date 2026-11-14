---
section: Running servers
order: 19
since: '1.5.0'
---

# Trim unused chunks

Minecraft saves every chunk a player has ever loaded, even ones they flew past once. On a world that's been played for a while, most of the space is often chunks nobody has really spent time in. Trimming removes them, so the world, its backups and its web map all get smaller. If anyone goes back, those chunks are generated again, fresh, from the seed.

It's on a server's **World** tab, under **Tools**, in :ui{anchor="world.trim"}.

::screenshot{name="trim" anchor="world.trim" labels="trim.open, world.trim-rules"}
The Trim unused chunks card in a server's World tab.
::

## What's kept

A chunk is removed only when every rule agrees it can go. :ui{anchor="world.trim-rules"} sets them:

- **Time spent**: chunks players have been in for at least 2 minutes, in total, are kept. Even at 0, a chunk anyone has spent any time in is kept.
- **Round spawn**: 16 chunks round world spawn.
- **Round each player**: 4 chunks round each player's last position and their bed or respawn point.
- **Buffer**: 2 chunks round every kept chunk, so builds never end at a hard edge.
- **End island**: in the End, 12 chunks round 0,0, where the main island and the dragon fight are.
- **Protected areas**: rectangles you name, in block coordinates (press F3 in game to see them), always kept whatever the other rules say. Use them for a town or a long railway nobody stands in for long.
- Chunks loaded with `/forceload` are always kept.

Half-generated chunks (the game started them but never finished) and chunks wholly outside the world border are removed wherever they are, unless you turn those switches off.

The same rules are in the server's YAML under `world.trim`, so they travel with the server. See [the spec reference](spec.md).

## Previewing and trimming

1. Press :ui{anchor="trim.open" do}. Flytower looks at every chunk and shows, for each dimension, how many chunks would go and how big the world is now and after. Nothing changes, and the server keeps running.
2. If the numbers look wrong, close the dialog, change the rules or add a protected area (on the card, or on the map: see below), save, and preview again.
3. Press **Trim**. After your passkey, Flytower checks there's room on the disk, takes a backup of the whole server (tick **Keep the backup forever** to keep it past retention), stops the server, trims, and starts it again. Players are disconnected until the server is back up.

The web map notices the changed region files and redraws by itself. If you've turned on **Unused chunks were trimmed** in [notifications](notifications.md), you're told how many chunks went and how much space came back.

## On the map

If the server's [web map](map.md) is on, **Show on the map** in the preview opens the map with the chunks that would go shaded red and protected areas outlined in yellow. It's only there for people who can change the server's world, even on a public map.

- **Draw protected area**, then drag out a rectangle (with the mouse, or one finger on a phone) and name it. It snaps to whole chunks and is saved straight into the rules.
- Select an area to rename or delete it.
- Changing areas makes the preview out of date, and the red fades. **Preview again** looks once more, without leaving the map.

## Things to know

- **Pre-generated worlds.** If most of the world's chunks have never had a player near them, as after a Chunky run, the preview warns you: trimming would undo that work, and players would wait for those chunks to generate again. Raise the radii or add a protected area round the pre-generated part first.
- **Safety.** Each region file is rewritten to a new file and swapped in whole, so a world is never left half written. Chunks that are kept are copied byte for byte, and any chunk that can't be read is kept. Entities and points of interest (villager beds and workstations) go with their chunks. The backup taken first has the world exactly as it was; restore it from **Backups** to undo a trim.
- **Modded dimensions.** The Overworld, Nether and End are trimmed by default. Add a modded dimension to `world.trim.dimensions` in the YAML to trim it too.
