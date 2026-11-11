#!/bin/sh
# Install the OpenVibe.Git forge CI runner on the workstation as a systemd *user* unit (the portal's pattern:
# no root, the owner's user manager keeps it alive). Run from a checkout of OpenVibe.Git:
#
#   deploy/ci/install.sh            # install, pull the image, do not start
#   deploy/ci/install.sh --start    # ... and enable --now
#
# It never writes a secret into the repository: the token stays in ~/.config/openvibe/git-ci.token (0600) and the
# service holds only its scrypt hash (deploy/ci/runner-token). A new token prints the hash to put in that file.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
CHECKOUT=${GIT_CI_CHECKOUT:-$HOME/openvibe/git-ci}
CONFIG_DIR=$HOME/.config/openvibe
CONFIG=$CONFIG_DIR/git-ci.json
TOKEN=$CONFIG_DIR/git-ci.token
UNIT_DIR=$HOME/.config/systemd/user
STORAGE_ROOT=$HOME/.local/share/openvibe-git-ci/containers/storage
RUN_ROOT=/run/user/$(id -u)/ovci
PODMAN="podman --root $STORAGE_ROOT --runroot $RUN_ROOT"
START=0
for arg in "$@"; do
    case "$arg" in
        --start) START=1 ;;
        *) echo "usage: $0 [--start]" >&2; exit 2 ;;
    esac
done

say() { printf '[git-ci-install] %s\n' "$*"; }

# 1. A sandbox engine. Rootless podman is preferred; bubblewrap is the fallback (runner/sandbox.js).
if podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null | grep -q true; then
    say "sandbox engine: rootless podman $(podman --version | awk '{print $3}')"
    mkdir -p "$STORAGE_ROOT/libpod" "$STORAGE_ROOT/volumes" "$RUN_ROOT" "$CONFIG_DIR"
    # The workstation's shared podman store lives on a disk with no inodes left. The runner gets its own store
    # under ~/.local/share (the home filesystem) and its own containers.conf so libpod's database agrees.
    if [ ! -f "$CONFIG_DIR/containers.conf" ]; then
        cat > "$CONFIG_DIR/containers.conf" <<EOF
[engine]
static_dir = "$STORAGE_ROOT/libpod"
volume_path = "$STORAGE_ROOT/volumes"
EOF
    fi
    if [ ! -f "$CONFIG_DIR/containers-storage.conf" ]; then
        cat > "$CONFIG_DIR/containers-storage.conf" <<EOF
[storage]
driver = "overlay"
graphroot = "$STORAGE_ROOT"
runroot = "$RUN_ROOT"

[storage.options]
mount_program = "/usr/bin/fuse-overlayfs"
EOF
    fi
    export CONTAINERS_CONF=$CONFIG_DIR/containers.conf
    export CONTAINERS_STORAGE_CONF=$CONFIG_DIR/containers-storage.conf
    if ! $PODMAN image exists docker.io/library/node:22-bookworm; then
        say "pulling node:22-bookworm into $STORAGE_ROOT (the run image)"
        $PODMAN pull docker.io/library/node:22-bookworm
    fi
    # Games builds with pnpm; corepack would have to download it at run time, and Node's fetch has no proxy.
    if ! $PODMAN image exists localhost/openvibe-ci-node22:1; then
        say "building localhost/openvibe-ci-node22:1 (node 22 + pnpm 10.6.5)"
        printf 'FROM docker.io/library/node:22-bookworm\nRUN npm install -g pnpm@10.6.5\n' \
            | $PODMAN build --pull=never -t localhost/openvibe-ci-node22:1 -
    fi
    # Chat's sound tests convert audio, as GitHub's ffmpeg apt step does.
    if ! $PODMAN image exists localhost/openvibe-ci-node22-ffmpeg:1; then
        say "building localhost/openvibe-ci-node22-ffmpeg:1 (the pnpm image + ffmpeg)"
        printf 'FROM localhost/openvibe-ci-node22:1\nRUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*\n' \
            | $PODMAN build --pull=never -t localhost/openvibe-ci-node22-ffmpeg:1 -
    fi
    # Live's mediasoup postinstall downloads a prebuilt worker from GitHub; Node's fetch has no proxy, so the
    # worker is baked into the image instead. kernel6 is the asset whose libstdc++ matches bookworm.
    if ! $PODMAN image exists localhost/openvibe-ci-node22-mediasoup:1; then
        say "building localhost/openvibe-ci-node22-mediasoup:1 (node 22 + the mediasoup worker)"
        cat <<'DOCKER' | $PODMAN build --pull=never -t localhost/openvibe-ci-node22-mediasoup:1 -
FROM docker.io/library/node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && mkdir -p /opt/mediasoup \
 && curl -fsSL https://github.com/versatica/mediasoup/releases/download/3.25.0/mediasoup-worker-3.25.0-linux-x64-kernel6.tgz -o /tmp/w.tgz \
 && tar -xzf /tmp/w.tgz -C /opt/mediasoup \
 && chmod 0755 /opt/mediasoup/mediasoup-worker \
 && rm -f /tmp/w.tgz && rm -rf /var/lib/apt/lists/*
ENV MEDIASOUP_WORKER_BIN=/opt/mediasoup/mediasoup-worker
DOCKER
    fi
elif command -v bwrap >/dev/null 2>&1; then
    say "sandbox engine: bubblewrap $(bwrap --version | awk '{print $2}') (podman is not rootless here)"
else
    echo "no sandbox engine: install rootless podman or bubblewrap" >&2
    exit 1
fi

# 2. A checkout the unit runs from. It is a clone of the forge, so an update is a fast-forward.
if [ -d "$CHECKOUT/.git" ]; then
    say "updating $CHECKOUT"
    git -C "$CHECKOUT" fetch --quiet origin main
    git -C "$CHECKOUT" merge --ff-only --quiet origin/main
else
    say "cloning https://git.openvibe.codes/openvibers/openvibe.git into $CHECKOUT"
    git clone --quiet --depth 1 https://git.openvibe.codes/openvibers/openvibe.git "$CHECKOUT"
fi

# 3. The config file (no secret) and the token (0600, never in the repository).
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG" ]; then
    install -m 0644 "$CHECKOUT/deploy/ci/git-ci.example.json" "$CONFIG"
    say "wrote $CONFIG from the example (repos and commands are edited there)"
else
    say "keeping $CONFIG"
fi
if [ ! -s "$TOKEN" ]; then
    say "making a runner token in $TOKEN"
    hash=$(/usr/bin/node "$CHECKOUT/runner/token.js" --out "$TOKEN" | tail -1)
    say "write this line to deploy/ci/runner-token, commit it, deploy, then restart:"
    printf '%s\n' "$hash"
fi
chmod 0600 "$TOKEN" 2>/dev/null || true

# 4. The user unit. It names the default checkout; an explicit GIT_CI_CHECKOUT is written into it.
mkdir -p "$UNIT_DIR"
if [ "$CHECKOUT" != "$HOME/openvibe/git-ci" ]; then
    sed "s#%h/openvibe/git-ci#$CHECKOUT#g" "$CHECKOUT/deploy/systemd-user/openvibe-git-ci.service" > "$UNIT_DIR/openvibe-git-ci.service"
else
    install -m 0644 "$CHECKOUT/deploy/systemd-user/openvibe-git-ci.service" "$UNIT_DIR/openvibe-git-ci.service"
fi
systemctl --user daemon-reload
say "installed $UNIT_DIR/openvibe-git-ci.service"

if [ "$START" = 1 ]; then
    systemctl --user enable --now openvibe-git-ci.service
    say "started; follow it with: journalctl --user -u openvibe-git-ci -f"
else
    say "not started (pass --start, or: systemctl --user enable --now openvibe-git-ci)"
fi
