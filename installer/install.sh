#!/usr/bin/env bash
# Flytower installer. Safe to run again: it keeps secrets and data, and on a machine that
# already has Flytower it keeps the installed version unless an option picks another one.
#
#   curl -fsSL https://github.com/teamflytower/flytower/releases/download/v<version>/install.sh \
#     | sudo bash -s -- --domain panel.example.com
#
set -euo pipefail

REPO="teamflytower/flytower"
PREFIX="/opt/flytower"
# Releases are signed with this key (installer/release-key.pem; a test keeps them equal).
RELEASE_KEY="$(cat <<'KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvYI8I2s8fiJ85JYPWsQCU56IZCNqHv+jJB3CqjERe+U=
-----END PUBLIC KEY-----
KEY
)"
# Pull request test builds are signed with a separate key (installer/pr-key.pem), which only
# --pr trusts. The updater never trusts it, so a test build can't pass for a release.
PR_KEY="$(cat <<'PRKEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARens+6YMMUYUcBgRJxsKV2YNzFxu2a5ZCg5R3GeT7rA=
-----END PUBLIC KEY-----
PRKEY
)"
STATE_DIR="/var/lib/flytower"
CONFIG_DIR="/etc/flytower"
SERVERS_DIR="/srv/flytower/servers"
SYSTEMD_DIR="/etc/systemd/system"
PANEL_PORT=3000

domain=""
version="latest"
version_given=0
pr=""
beta=0
tarball=""
setup_token=""
with_caddy=1
with_firewall=1

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# Compares two versions like packages/protocol/src/versions.ts: prints -1, 0 or 1. A
# pre-release sorts before its release; pre-release parts compare as semver does.
vercmp() {
  local a="${1#v}" b="${2#v}" ap="" bp="" i x y
  [[ "$a" == *-* ]] && ap="${a#*-}"
  [[ "$b" == *-* ]] && bp="${b#*-}"
  local -a an bn apn bpn
  IFS=. read -r -a an <<<"${a%%-*}"
  IFS=. read -r -a bn <<<"${b%%-*}"
  for i in 0 1 2; do
    x="${an[i]:-0}" y="${bn[i]:-0}"
    [[ "$x" =~ ^[0-9]+$ ]] || x=0
    [[ "$y" =~ ^[0-9]+$ ]] || y=0
    if ((10#$x < 10#$y)); then echo -1; return; fi
    if ((10#$x > 10#$y)); then echo 1; return; fi
  done
  if [[ "$ap" == "$bp" ]]; then echo 0; return; fi
  if [[ -z "$ap" ]]; then echo 1; return; fi
  if [[ -z "$bp" ]]; then echo -1; return; fi
  IFS=. read -r -a apn <<<"$ap"
  IFS=. read -r -a bpn <<<"$bp"
  for ((i = 0; i < ${#apn[@]} || i < ${#bpn[@]}; i++)); do
    if ((i >= ${#apn[@]})); then echo -1; return; fi
    if ((i >= ${#bpn[@]})); then echo 1; return; fi
    x="${apn[i]}" y="${bpn[i]}"
    [[ "$x" == "$y" ]] && continue
    if [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then
      if ((10#$x < 10#$y)); then echo -1; else echo 1; fi
    elif [[ "$x" =~ ^[0-9]+$ ]]; then
      echo -1
    elif [[ "$y" =~ ^[0-9]+$ ]]; then
      echo 1
    elif [[ "$x" < "$y" ]]; then
      echo -1
    else
      echo 1
    fi
    return
  done
  echo 0
}

# The ports sshd listens on, one per line; 22 if that can't be found out.
ssh_ports() {
  local sshd ports=""
  sshd="$(command -v sshd || echo /usr/sbin/sshd)"
  if [[ -x "$sshd" ]]; then
    ports="$("$sshd" -T 2>/dev/null | awk '$1 == "port" && $2 ~ /^[0-9]+$/ { print $2 }' | sort -un)"
  fi
  printf '%s\n' "${ports:-22}"
}

# Copies the panel's database aside before an older release runs against it. The panel is
# stopped first so the copy is consistent; the steps below start it again.
save_database() {
  local from="$1" to="$2" dest f copied=0
  dest="/var/lib/flytower-agent/db-backups/installer-$from-to-$to-$(date +%Y%m%d-%H%M%S)"
  systemctl stop flytower-panel.service 2>/dev/null || true
  install -d -m 0700 -o root -g root /var/lib/flytower-agent /var/lib/flytower-agent/db-backups
  install -d -m 0700 -o root -g root "$dest"
  for f in flytower.db flytower.db-wal flytower.db-shm; do
    # Only plain files: never follow a link in the panel's folder.
    if [[ -f "$STATE_DIR/$f" && ! -L "$STATE_DIR/$f" ]]; then
      cp --no-dereference --preserve=mode,ownership,timestamps "$STATE_DIR/$f" "$dest/$f"
      copied=1
    fi
  done
  if [[ $copied -eq 1 ]]; then
    echo "Saved a copy of the panel's database in $dest"
  else
    rmdir "$dest"
  fi
}

usage() {
  cat <<'EOF'
Usage: install.sh --domain <host> [options]

  --domain <host>       The panel's address, e.g. panel.example.com. Its DNS must point here.
  --version <x.y.z>     Install this release instead of the latest stable one.
                        --version latest installs the latest stable one.
  --beta                Install the newest release, betas included.
  --tarball <file>      Install from a release tarball already on this machine.
  --pr <number>         Install the test build of that pull request (for testing, not for
                        real servers). It's signed with the test-build key, not the
                        release key.
  --setup-token <text>  Use this setup token instead of generating one.
  --no-caddy            Don't install or configure Caddy (bring your own HTTPS proxy).
  --no-firewall         Don't touch ufw.

On a machine that already has Flytower, running this again keeps the installed version: it
rewrites the settings and services and gives you a new setup token. Pass --version, --beta,
--pr or --tarball to change version (--version latest for the newest stable).
Going back to an older version saves a copy of the panel's database first.
EOF
}

main() {

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; version="${version#v}"; version_given=1; shift 2 ;;
    --tarball) tarball="${2:-}"; shift 2 ;;
    --pr) pr="${2:-}"; shift 2 ;;
    --beta) beta=1; shift ;;
    # Native builds ended in 1.5.0, when every release got the Rust agent.
    --native) die "--native has gone: every release has the Rust agent now. Use --beta or --version instead." ;;
    --setup-token) setup_token="${2:-}"; shift 2 ;;
    --no-caddy) with_caddy=0; shift ;;
    --no-firewall) with_firewall=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ -n "$domain" ]] || { usage >&2; die "--domain is required (passkeys need HTTPS on a real name)"; }
[[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || die "--domain should be a host name like panel.example.com"
[[ -z "$pr" || "$pr" =~ ^[0-9]+$ ]] || die "--pr should be a pull request number, like 70"
[[ -n "$version" ]] || die "--version needs a version, like 1.4.1"

# ---------------------------------------------------------------- checks

[[ $EUID -eq 0 ]] || die "run this as root (sudo bash ...)"
[[ -d /run/systemd/system ]] || die "this machine isn't running systemd"

# shellcheck source=/dev/null
. /etc/os-release
case "${ID:-}" in
  ubuntu) dpkg --compare-versions "${VERSION_ID:-0}" ge 24.04 || die "Ubuntu 24.04 or newer is needed" ;;
  debian) dpkg --compare-versions "${VERSION_ID:-0}" ge 12 || die "Debian 12 or newer is needed" ;;
  *) die "only Ubuntu 24.04+ and Debian 12+ are supported for now (found ${PRETTY_NAME:-unknown})" ;;
esac

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported CPU architecture $(uname -m)" ;;
esac

for tool in curl tar sha256sum useradd systemctl; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done

# ---------------------------------------------------------------- release

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# What's installed now, if anything. With no option choosing a version, keep it: a plain
# re-run (say, for a new setup token) mustn't move a beta or test box to stable.
installed=""
if [[ -f "$PREFIX/current/VERSION" ]]; then installed="$(cat "$PREFIX/current/VERSION")"; fi
keep=0
if [[ -n "$installed" && -z "$tarball" && -z "$pr" && $version_given -eq 0 &&
  $beta -eq 0 ]]; then
  keep=1
  say "Flytower $installed is already installed; keeping that version"
  echo "To change version, run this again with --version <x.y.z> (or latest), --beta or --pr."
fi

# The version the signed file name promises; the tarball's own VERSION must agree.
expected=""
if [[ $keep -eq 1 ]]; then
  root="$(readlink -f "$PREFIX/current")"
elif [[ -z "$tarball" ]]; then
  if [[ -n "$pr" ]]; then
    # Pull request builds live under a pr-<number> tag, which the updater never offers.
    base="https://github.com/$REPO/releases/download/pr-$pr"
    curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" ||
      die "there's no test build for pull request $pr"
    name="$(grep -o "flytower-[^ ]*-linux-$arch\.tar\.gz" "$work/SHA256SUMS" | head -n1)"
    [[ -n "$name" ]] || die "pull request $pr's build has nothing for $arch"
    say "Downloading the test build of pull request $pr ($arch)"
  else
    if [[ "$version" == latest ]]; then
      if [[ "$beta" == 1 ]]; then
        # The newest v-tagged release, betas included; test builds (pr-*) are skipped.
        version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" |
          sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n1)"
      else
        # GitHub's latest release is the newest that isn't a pre-release (so no betas).
        version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
          sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n1)"
      fi
      [[ -n "$version" ]] || die "couldn't find the latest release"
    fi
    base="https://github.com/$REPO/releases/download/v$version"
    name="flytower-$version-linux-$arch.tar.gz"
    say "Downloading Flytower $version ($arch)"
    curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS"
  fi
  curl -fsSL -o "$work/$name" "$base/$name"
  command -v openssl >/dev/null || die "openssl is missing (needed to check the release's signature)"
  curl -fsSL -o "$work/SHA256SUMS.sig" "$base/SHA256SUMS.sig" ||
    die "this release isn't signed; refusing to install it"
  if [[ -n "$pr" ]]; then
    printf '%s\n' "$PR_KEY" >"$work/release-key.pem"
  else
    printf '%s\n' "$RELEASE_KEY" >"$work/release-key.pem"
  fi
  base64 -d "$work/SHA256SUMS.sig" >"$work/SHA256SUMS.sig.bin" 2>/dev/null ||
    die "this release's signature is unreadable; refusing to install it"
  openssl pkeyutl -verify -pubin -inkey "$work/release-key.pem" -rawin \
    -in "$work/SHA256SUMS" -sigfile "$work/SHA256SUMS.sig.bin" >/dev/null 2>&1 ||
    die "this release's signature doesn't match Flytower's key; refusing to install it"
  (cd "$work" && grep " $name\$" SHA256SUMS | sha256sum -c --quiet -) ||
    die "the download didn't match its checksum; try again"
  if [[ -n "$pr" ]]; then
    echo "Signature checked: this is a genuine Flytower test build."
  else
    echo "Release signature checked: this is a genuine Flytower release."
  fi
  tarball="$work/$name"
  expected="${name#flytower-}"
  expected="${expected%-linux-"$arch".tar.gz}"
else
  echo "Installing from $tarball as given: its signature is not checked."
fi

if [[ $keep -eq 0 ]]; then
  [[ -f "$tarball" ]] || die "no such file: $tarball"
  mkdir -p "$work/unpack"
  tar -xzf "$tarball" -C "$work/unpack"
  root="$(find "$work/unpack" -mindepth 1 -maxdepth 1 -type d | head -n1)"
fi
[[ -f "$root/VERSION" && -x "$root/bin/bun" ]] || die "${tarball:-$root} isn't a Flytower release"
version="$(cat "$root/VERSION")"
[[ -z "$expected" || "$version" == "$expected" ]] ||
  die "the download says it's $version but was published as $expected; refusing to install it"

if [[ $keep -eq 0 ]]; then
  if [[ -n "$installed" && "$(vercmp "$version" "$installed")" -lt 0 ]]; then
    say "Going back from Flytower $installed to $version"
    save_database "$installed" "$version"
  fi
  say "Installing Flytower $version"
  release="$PREFIX/releases/$version"
  rm -rf "$release.new"
  mkdir -p "$PREFIX/releases"
  cp -a "$root" "$release.new"
  rm -rf "$release"
  mv "$release.new" "$release"
  ln -sfn "$release" "$PREFIX/current.new"
  mv -T "$PREFIX/current.new" "$PREFIX/current"
fi
bun="$PREFIX/current/bin/bun"

# ---------------------------------------------------------------- users and folders

if ! getent group flytower >/dev/null; then groupadd --system flytower; fi
if ! id -u flytower >/dev/null 2>&1; then
  useradd --system --gid flytower --home-dir "$STATE_DIR" --no-create-home \
    --shell /usr/sbin/nologin flytower
fi

install -d -m 0750 -o flytower -g flytower "$STATE_DIR"
# The system helper's own folders, which the panel's user must not be able to change: its
# state (root only) and the archive of deleted servers (readable by the panel).
install -d -m 0700 -o root -g root /var/lib/flytower-agent
install -d -m 0750 -o root -g flytower /var/lib/flytower-archive
install -d -m 0755 "$CONFIG_DIR" "$CONFIG_DIR/servers" "$(dirname "$SERVERS_DIR")" "$SERVERS_DIR"
install -d -m 0755 "$PREFIX/runtimes"

# ---------------------------------------------------------------- panel config

env_file="$CONFIG_DIR/panel.env"
secret=""
if [[ -f "$env_file" ]]; then
  secret="$(sed -n 's/^NUXT_APP_SECRET=//p' "$env_file")"
fi
if [[ -z "$secret" ]]; then
  secret="$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | head -c 64)"
fi

umask 077
cat >"$env_file.new" <<EOF
# Written by the Flytower installer. Re-running it rewrites this file but keeps the secret.
NUXT_APP_SECRET=$secret
NUXT_RP_ID=$domain
NUXT_VERSION=$version
NUXT_SERVERS_DIR=$SERVERS_DIR
HOST=127.0.0.1
PORT=$PANEL_PORT
NITRO_HOST=127.0.0.1
NITRO_PORT=$PANEL_PORT
EOF
chown root:flytower "$env_file.new"
chmod 0640 "$env_file.new"
mv "$env_file.new" "$env_file"
umask 022

# ---------------------------------------------------------------- systemd

# Newer releases start the agent by a stable path (bin/flytower-agent), so a later release
# can swap what's behind it. Older releases only have Bun and agent.js.
if [[ -x "$PREFIX/current/bin/flytower-agent" ]]; then
  agent_exec="ExecStart=$PREFIX/current/bin/flytower-agent"
else
  agent_exec="ExecStart=$bun $PREFIX/current/agent/agent.js"
fi

cat >"$SYSTEMD_DIR/flytower-agent.service" <<EOF
# Managed by Flytower. Changes are overwritten.
[Unit]
Description=Flytower system helper
After=network-online.target
Wants=network-online.target

[Service]
$agent_exec
Environment=FLYTOWER_VERSION=$version
Environment=FLYTOWER_PANEL_GROUP=flytower
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat >"$SYSTEMD_DIR/flytower-panel.service" <<EOF
# Managed by Flytower. Changes are overwritten.
[Unit]
Description=Flytower panel
After=network-online.target flytower-agent.service
Wants=network-online.target flytower-agent.service

[Service]
User=flytower
Group=flytower
UMask=0007
EnvironmentFile=$env_file
WorkingDirectory=$STATE_DIR
ExecStart=$PREFIX/current/bin/bun $PREFIX/current/panel/server/index.mjs
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=$STATE_DIR $SERVERS_DIR

[Install]
WantedBy=multi-user.target
EOF

cat >"$SYSTEMD_DIR/flytower-mc.slice" <<'EOF'
# Managed by Flytower. Every Minecraft server runs in this slice.
[Unit]
Description=Flytower Minecraft servers

[Slice]
MemoryAccounting=yes
CPUAccounting=yes
EOF

systemctl daemon-reload
systemctl enable --quiet flytower-agent.service flytower-panel.service
# Re-runs restart the services more often than systemd's start limit allows (five in ten
# seconds), so clear the count first rather than have a quick second run fail.
systemctl reset-failed flytower-agent.service flytower-panel.service 2>/dev/null || true
systemctl restart flytower-agent.service
systemctl restart flytower-panel.service

# ---------------------------------------------------------------- caddy

if [[ $with_caddy -eq 1 ]]; then
  if ! command -v caddy >/dev/null; then
    say "Installing Caddy"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
      gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  caddyfile=/etc/caddy/Caddyfile
  if [[ -f "$caddyfile" ]] && ! grep -q '^# Managed by Flytower' "$caddyfile" &&
    grep -vE '^\s*(#|$)' "$caddyfile" | grep -vqE '^\s*(:80 \{|root \* /usr/share/caddy|file_server|\})\s*$'; then
    die "$caddyfile has your own changes. Add this block to it, re-run with --no-caddy, and reload Caddy:
    $domain {
      reverse_proxy 127.0.0.1:$PANEL_PORT
    }"
  fi
  # The panel's own domain, then any server hostname whose public status page is on: Caddy
  # asks the panel before getting a certificate for a name it hasn't seen (on-demand TLS).
  cat >"$caddyfile" <<EOF
# Managed by Flytower. Re-running the installer rewrites this file.
{
	on_demand_tls {
		ask http://127.0.0.1:$PANEL_PORT/api/public/tls-ask
	}
}

$domain {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PANEL_PORT
}

https:// {
	tls {
		on_demand
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PANEL_PORT
}
EOF
  systemctl reload-or-restart caddy
fi

# ---------------------------------------------------------------- firewall

if [[ $with_firewall -eq 1 ]]; then
  if ! command -v ufw >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ufw >/dev/null
  fi
  # Keep SSH open on the port it really uses, so turning ufw on can't lock you out.
  ports="$(ssh_ports)"
  while read -r port; do
    if [[ "$port" == 22 ]]; then
      ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp comment 'ssh' >/dev/null
    else
      ufw allow "$port/tcp" comment 'ssh' >/dev/null
    fi
  done <<<"$ports"
  echo "Firewall: SSH allowed on port $(paste -sd, - <<<"$ports" | sed 's/,/, /g')." \
    "If SSH also listens on another port, run: ufw allow <port>/tcp"
  ufw allow 80/tcp comment 'flytower https redirect' >/dev/null
  ufw allow 443/tcp comment 'flytower panel' >/dev/null
  ufw --force enable >/dev/null
fi

# ---------------------------------------------------------------- setup token

if [[ -z "$setup_token" ]]; then
  # 20 characters from an alphabet without look-alikes.
  setup_token="$(tr -dc 'ABCDEFGHJKMNPQRSTVWXYZ23456789' </dev/urandom | head -c 20)"
fi
# The panel may still be starting from an earlier restart, and it imports and deletes this file
# as soon as it sees it. So write it under another name, set its owner and mode, then move it
# into place in one step.
token_tmp="$(mktemp "$STATE_DIR/.setup-token.XXXXXX")"
FLYTOWER_TOKEN="$setup_token" "$bun" -e \
  "await Bun.write('$token_tmp', await Bun.password.hash(process.env.FLYTOWER_TOKEN, 'argon2id'))"
chown flytower:flytower "$token_tmp"
chmod 0600 "$token_tmp"
mv -f "$token_tmp" "$STATE_DIR/setup-token.hash"
# The panel picks the token up at boot.
systemctl reset-failed flytower-panel.service 2>/dev/null || true
systemctl restart flytower-panel.service

# ---------------------------------------------------------------- done

say "Waiting for the panel"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PANEL_PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PANEL_PORT/api/health" >/dev/null ||
  die "the panel didn't start; see: journalctl -u flytower-panel -n 50"

# A token you chose yourself may hold characters a link can't.
token_url="$(FLYTOWER_TOKEN="$setup_token" "$bun" -e 'process.stdout.write(encodeURIComponent(process.env.FLYTOWER_TOKEN))')"

cat <<EOF

  Flytower $version is installed.

  Set up      https://$domain/setup#token=$token_url
  Setup token $setup_token

  Open the link to start, or open https://$domain and type the token if the link won't open
  where you are. Either works once, within 24 hours. If you've already finished setup,
  ignore them.
  Lost it? Run this installer again for a new one; it keeps this version.

EOF
}

# Everything runs from here, so a download cut off part-way through runs nothing.
main "$@"
