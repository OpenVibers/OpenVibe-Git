#!/bin/bash
# The forge CI runner on a shared node (2026-11-19: ov-node-01, 8 cores, 15 GB). Run as root; safe to run again.
#
#   sudo deploy/ci/node-setup.sh <git ref>          (then put the token and the configuration in place, below)
#
# - a system user `ovci` with its own systemd user manager (linger), which owns the runs' cgroup scopes;
# - the work directories in memory: a tmpfs at /var/lib/ovci/work (8 GB at most, used only as runs fill it);
# - the kept installs and the package managers' download caches on disk under /var/lib/ovci/cache (the page cache
#   keeps the busy ones in memory and gives it back when the node needs it);
# - pnpm for the repositories that use it (bubblewrap runs the host's /usr, not an image);
# - the runner itself: a root-owned checkout of OpenVibe.Git at /var/lib/ovci/runner (the runner can read it, not
#   change it), started by the user unit openvibe-git-ci.service.
# The runner token (/var/lib/ovci/.config/openvibe/git-ci.token, 0600) and git-ci.json are copied in by hand; neither
# is in this repository.
set -euo pipefail
REF=${1:-main}
REPO=${OV_GIT_REPO:-https://github.com/OpenVibers/OpenVibe-Git.git}
HOME_DIR=/var/lib/ovci
PNPM_VERSION=${PNPM_VERSION:-10.6.5}
# The official Node build, as GitHub's runners (setup-node) and openvibe-shared's test workflow use (its default
# node-version). Ubuntu's packaged Node is built without TypeScript stripping (node:module stripTypeScriptTypes), which
# OpenVibe.Tools' tests use, so the runner and every sandbox run this one instead (2026-11-19).
NODE_VERSION=${NODE_VERSION:-22.22.1}

id ovci >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin --comment 'OpenVibe forge CI runner' ovci
OVCI_UID=$(id -u ovci)
install -d -o ovci -g ovci -m 0700 "$HOME_DIR" "$HOME_DIR/cache" "$HOME_DIR/cache/deps" "$HOME_DIR/cache/shared" \
    "$HOME_DIR/.config" "$HOME_DIR/.config/openvibe" "$HOME_DIR/.config/systemd" "$HOME_DIR/.config/systemd/user"
install -d -o ovci -g ovci -m 0700 "$HOME_DIR/work"

# The work directories in memory.
cat > /etc/systemd/system/var-lib-ovci-work.mount <<EOF
[Unit]
Description=OpenVibe forge CI work directories, in memory
Before=user@${OVCI_UID}.service

[Mount]
What=tmpfs
Where=$HOME_DIR/work
Type=tmpfs
Options=size=8G,mode=0700,uid=${OVCI_UID},gid=$(id -g ovci),nosuid,nodev

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now var-lib-ovci-work.mount

# The official Node, checked against nodejs.org's published SHA-256, at /opt/openvibe-node/v<version>; `current` points
# at it. Root-owned and read-only to the runner.
NODE_DIR=/opt/openvibe-node/v$NODE_VERSION
if [ ! -x "$NODE_DIR/bin/node" ]; then
    TMP=$(mktemp -d)
    TARBALL="node-v$NODE_VERSION-linux-x64.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$TMP/$TARBALL"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c --quiet -)
    install -d -m 0755 /opt/openvibe-node
    rm -rf "$NODE_DIR.tmp" && mkdir -p "$NODE_DIR.tmp"
    tar -xJf "$TMP/$TARBALL" -C "$NODE_DIR.tmp" --strip-components=1
    mv "$NODE_DIR.tmp" "$NODE_DIR"
    rm -rf "$TMP"
fi
ln -sfn "$NODE_DIR" /opt/openvibe-node/current
chown -R root:root /opt/openvibe-node
export PATH="/opt/openvibe-node/current/bin:$PATH"

# gitleaks for the run's secret scan (runner/security.js): the version and checksum openvibe-shared's security.yml pins.
GITLEAKS_VERSION=${GITLEAKS_VERSION:-8.30.1}
GITLEAKS_SHA256=${GITLEAKS_SHA256:-551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb}
if ! /usr/local/bin/gitleaks version 2>/dev/null | grep -q "$GITLEAKS_VERSION"; then
    TMP=$(mktemp -d)
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -o "$TMP/g.tar.gz"
    echo "$GITLEAKS_SHA256  $TMP/g.tar.gz" | sha256sum -c --quiet -
    tar -xzf "$TMP/g.tar.gz" -C "$TMP" gitleaks
    install -o root -g root -m 0755 "$TMP/gitleaks" /usr/local/bin/gitleaks
    rm -rf "$TMP"
fi

# pnpm into /usr (bubblewrap binds the host's /usr read-only).
if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version 2>/dev/null)" != "$PNPM_VERSION" ]; then
    npm install -g --no-audit --no-fund "pnpm@$PNPM_VERSION" >/dev/null
fi

# The runner's code, owned by root.
if [ -d "$HOME_DIR/runner/.git" ]; then
    git -C "$HOME_DIR/runner" fetch --quiet origin "$REF"
    git -C "$HOME_DIR/runner" checkout --quiet --force FETCH_HEAD
else
    rm -rf "$HOME_DIR/runner"
    git clone --quiet "$REPO" "$HOME_DIR/runner"
    git -C "$HOME_DIR/runner" fetch --quiet origin "$REF"
    git -C "$HOME_DIR/runner" checkout --quiet --force FETCH_HEAD
fi
chown -R root:root "$HOME_DIR/runner"
chmod -R go-w "$HOME_DIR/runner"
install -o ovci -g ovci -m 0644 "$HOME_DIR/runner/deploy/systemd-user/openvibe-git-ci-node.service" "$HOME_DIR/.config/systemd/user/openvibe-git-ci.service"

loginctl enable-linger ovci
# Wait for the user manager, then (re)start the runner if its token and configuration are in place.
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "/run/user/$OVCI_UID/bus" ] && break; sleep 1; done
as_ovci() { runuser -u ovci -- env XDG_RUNTIME_DIR="/run/user/$OVCI_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$OVCI_UID/bus" "$@"; }
as_ovci systemctl --user daemon-reload
if [ -s "$HOME_DIR/.config/openvibe/git-ci.token" ] && [ -s "$HOME_DIR/.config/openvibe/git-ci.json" ]; then
    as_ovci systemctl --user enable openvibe-git-ci.service >/dev/null 2>&1
    as_ovci systemctl --user restart openvibe-git-ci.service
    echo "runner at $(git -C "$HOME_DIR/runner" rev-parse --short HEAD) (re)started"
else
    echo "put git-ci.token (0600) and git-ci.json in $HOME_DIR/.config/openvibe, then run this again"
fi
