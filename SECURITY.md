# Security policy

Thank you for helping keep Flytower and the people who run it safe.

## Reporting a problem

Please don't open a public issue, discussion or pull request for a security problem. Report it privately instead, in either of these ways:

- **GitHub:** [report a vulnerability](https://github.com/teamflytower/flytower/security/advisories/new) from the repository's Security tab.
- **Email:** [security@flytower.dev](mailto:security@flytower.dev).

It helps to include:

- the Flytower version (shown under **System**, **Updates**),
- what someone could do, and what they would need first (for example, a signed-in Viewer, a player on a server, or nothing at all),
- the steps to reproduce it, or a proof of concept.

## What happens next

- You'll hear back within a few days to say the report has arrived.
- We'll work out a fix with you, and keep you posted on progress.
- The fix ships in a release, with a GitHub security advisory once people have had time to update. You'll be credited in the advisory unless you'd rather not be.

Flytower is looked after by a small team in their spare time, so please give us a reasonable chance to fix a problem before you talk about it publicly. Ninety days is the usual upper limit.

## Supported versions

Security fixes go into the latest stable release. Flytower updates itself from **System**, **Updates**, so the fix is the next update. Betas get fixes in the next beta.

## In scope

The panel, the root helper (`flytower-agent`), the installer and updater, release signing, and the Flytower website. Problems in Minecraft itself, in mods or plugins, or in a hosting provider belong with those projects.
