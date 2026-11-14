#!/usr/bin/env bash
# Prints which agent the "vps" container is running, rust or bun, once systemd has started
# it. From 1.5.0 bin/flytower-agent is the Rust agent itself; 1.4 releases put it behind a
# wrapper as bin/flytower-agent-rust, beside a Bun fallback.
set -euo pipefail
exe=''
for _ in $(seq 1 30); do
  exe="$(docker exec vps sh -c 'pid=$(systemctl show -p MainPID --value flytower-agent)
    [ "$pid" != 0 ] && readlink "/proc/$pid/exe"' 2>/dev/null || true)"
  case "$exe" in
    */flytower-agent | */flytower-agent-rust) echo rust; exit 0 ;;
    */bun) echo bun; exit 0 ;;
  esac
  sleep 1
done
echo "the agent isn't running: ${exe:-nothing}" >&2
docker exec vps journalctl -u flytower-agent --no-pager -n 30 >&2 || true
exit 1
