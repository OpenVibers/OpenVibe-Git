'use strict';

/**
 * The sandbox around one phase. Podman (rootless) when the host has it, bubblewrap otherwise; both get the same
 * shape: no host home, no secrets, no host path but the per-run work directory, a new user/pid/network namespace,
 * 4 CPUs, 6 GB, a 30-minute (configurable) wall, and only the install phase gets the allowlisted proxy socket.
 *
 * Podman: `--network=none`, read-only root, workspace bind only, all capabilities dropped, no-new-privileges.
 * Bubblewrap: no network namespace, read-only /usr and certificates, the same workspace bind, a per-run
 * passwd/group/hosts, wrapped in a systemd user scope for the memory and CPU caps.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UID = 1000;
const GID = 1000;

// The loopback relay from the container's TCP proxy port to the Unix socket the runner exposes. It lives in
// /run (a tmpfs), never in the checked-out repository: a repository's linter must not see the runner's files.
const RELAY = `'use strict';
const net = require('node:net');
const [sock, port] = process.argv.slice(2);
const server = net.createServer((client) => {
  const upstream = net.connect(sock);
  client.pipe(upstream); upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});
server.listen(Number(port), '127.0.0.1');
`;

function have(command) {
    const out = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return !out.error && out.status === 0;
}

function podmanWorks() {
    const out = spawnSync('podman', ['info', '--format', '{{.Host.Security.Rootless}}'], { encoding: 'utf8', timeout: 20_000 });
    return !out.error && out.status === 0;
}

/** `auto` picks rootless podman, then bubblewrap; an unavailable engine is an error, never a silent host run. */
function detectEngine(preferred = 'auto') {
    if (preferred === 'podman' || preferred === 'auto') {
        if (podmanWorks()) return { kind: 'podman', why: 'rootless podman' };
        if (preferred === 'podman') throw new Error('podman is not working rootless on this host');
    }
    if (preferred === 'bwrap' || preferred === 'auto') {
        if (have('bwrap')) return { kind: 'bwrap', why: 'bubblewrap' };
        if (preferred === 'bwrap') throw new Error('bubblewrap (bwrap) is not installed');
    }
    throw new Error('no sandbox engine: rootless podman or bubblewrap is required');
}

const envList = (extra = {}) => ({
    HOME: '/workspace/.home',
    TMPDIR: '/tmp',
    PATH: '/opt/node/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: 'true',
    NO_COLOR: '1',
    TZ: 'UTC',
    npm_config_cache: '/workspace/.cache/npm',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
    PNPM_HOME: '/workspace/.home/.pnpm',
    npm_config_store_dir: '/workspace/node_modules/.pnpm-store',
    ...extra,
});

/** The install phase's script: relay the Unix-socket proxy on loopback, point npm/pnpm at it, run the command. */
function installScript(command, { proxy = true } = {}) {
    return `#!/bin/sh
set -eu
${proxy ? `cat > /run/relay.cjs <<'OV_RELAY'
${RELAY}OV_RELAY
node /run/relay.cjs /run/ci-proxy.sock 3128 &
relay=$!
trap 'kill "$relay" 2>/dev/null || true' EXIT
export http_proxy=http://127.0.0.1:3128 https_proxy=http://127.0.0.1:3128
export HTTP_PROXY="$http_proxy" HTTPS_PROXY="$https_proxy"
export npm_config_proxy="$http_proxy" npm_config_https_proxy="$https_proxy"
` : ''}mkdir -p /workspace/.pnpm/bin
export PATH=/workspace/.pnpm/bin:$PATH
cd /workspace
${command}
`;
}

/**
 * The podman command line for one phase. proxySock is null for the test phase (no network at all).
 */
function podmanArgs({ name, workspace, image, limits, proxySock = null, script }) {
    const args = [
        'run', '--rm', '--name', name, '--pull=never', '--network=none',
        '--cpus', String(limits.cpus), '--memory', `${limits.memory_mb}m`, '--memory-swap', `${limits.memory_mb}m`,
        '--pids-limit', '2048', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--read-only', '--tmpfs', '/tmp:rw,exec,size=2g', '--tmpfs', '/run:rw,exec,size=64m,mode=1777', '--shm-size', '512m',
        '--userns=keep-id', '--workdir', '/workspace',
        '-v', `${workspace}:/workspace:rw`,
        '--stop-timeout', '5',
    ];
    for (const [key, value] of Object.entries(envList())) args.push('-e', `${key}=${value}`);
    if (proxySock) args.push('-v', `${proxySock}:/run/ci-proxy.sock:rw`);
    args.push(image, '/bin/sh', '-c', script);
    return args;
}

const ETC_FILES = ['ssl/certs', 'ssl/openssl.cnf', 'ca-certificates', 'ca-certificates.conf', 'pki/tls/certs', 'pki/ca-trust/extracted',
    'fonts', 'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'localtime', 'timezone', 'alternatives', 'mime.types', 'magic',
    'vim', 'vimrc', 'nanorc', 'bash.bashrc', 'inputrc', 'terminfo', 'protocols', 'services'];
const ROOT_LINKS = ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32'];

function bwrapEtc(workspace) {
    const dir = path.join(workspace, '.ci', 'etc');
    fs.mkdirSync(dir, { recursive: true });
    const files = {
        passwd: `ci:x:${UID}:${GID}:ci:/workspace/.home:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`,
        group: `ci:x:${GID}:\nnogroup:x:65534:\n`,
        hosts: '127.0.0.1 localhost ci\n::1 localhost ip6-localhost ip6-loopback\n',
        hostname: 'ci\n',
        'resolv.conf': '# No DNS in the sandbox: the install proxy resolves the names it allows.\n',
        'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files\n',
    };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
}

/**
 * The bubblewrap command line for one phase (no systemd scope here; the caller wraps it). Node is bound from
 * the running runner's own installation, because a workstation's Node is rarely in /usr.
 */
function bwrapArgs({ workspace, limits, proxySock = null, script }) {
    const node = fs.realpathSync(process.execPath);
    const prefix = path.dirname(path.dirname(node));
    const nodeInside = path.join('/opt/node', path.relative(prefix, node));
    const nodeBin = path.dirname(nodeInside);
    const etc = bwrapEtc(workspace);
    const args = [
        '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
        '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
        '--uid', String(UID), '--gid', String(GID), '--hostname', 'ci',
    ];
    for (const [key, value] of Object.entries({ ...envList(), PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin` })) {
        args.push('--setenv', key, value);
    }
    args.push('--ro-bind', '/usr', '/usr');
    if (fs.existsSync('/usr/local')) args.push('--ro-bind', '/usr/local', '/usr/local');
    for (const name of ROOT_LINKS) {
        const p = `/${name}`;
        try {
            const st = fs.lstatSync(p);
            if (st.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(p), p);
            else args.push('--ro-bind', p, p);
        } catch { /* absent */ }
    }
    args.push('--ro-bind', prefix, '/opt/node');
    args.push('--dir', '/etc');
    for (const name of ETC_FILES) {
        const p = `/etc/${name}`;
        if (fs.existsSync(p)) args.push('--ro-bind', p, p);
    }
    for (const name of ['passwd', 'group', 'hosts', 'hostname', 'resolv.conf', 'nsswitch.conf']) {
        args.push('--ro-bind', path.join(etc, name), `/etc/${name}`);
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--perms', '1777', '--tmpfs', '/run');
    args.push('--bind', workspace, '/workspace');
    if (proxySock) args.push('--bind', proxySock, '/run/ci-proxy.sock');
    args.push('--remount-ro', '/', '--chdir', '/workspace', '--', '/bin/sh', '-c', script);
    return { args, nodeInside };
}

/** Maybe wrap a bwrap command in a transient user scope for memory, CPU and process caps. */
function bwrapScope({ name, limits, args }) {
    return {
        command: 'systemd-run',
        args: [
            '--user', '--scope', '--quiet', '--collect', '--unit', `ov-ci-${name}`,
            '-p', `MemoryMax=${limits.memory_mb}M`, '-p', 'MemorySwapMax=0',
            '-p', `CPUQuota=${Math.round(limits.cpus * 100)}%`, '-p', 'TasksMax=2048',
            '--', 'bwrap', ...args,
        ],
        killUnit: `ov-ci-${name}.scope`,
    };
}

/** Remove a podman container, whether it is still running or already gone. */
function podmanCleanup(name, rootArgs = []) {
    spawnSync('podman', [...rootArgs, 'rm', '-f', name], { encoding: 'utf8', timeout: 20_000 });
}

function scopeCleanup(unit) {
    if (!unit) return;
    spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit], { encoding: 'utf8', timeout: 10_000 });
}

module.exports = {
    detectEngine, podmanArgs, bwrapArgs, bwrapScope, installScript, podmanCleanup, scopeCleanup, envList, UID, GID, RELAY,
};
