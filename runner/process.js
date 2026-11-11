'use strict';

/**
 * One phase of a run as a child process with a wall-clock limit. On the limit it calls onKill (the container or
 * the scope is removed), kills the child's process group and resolves `timedOut: true`; the run then reports it.
 * It never buffers the whole output: onData gets every chunk and only a short tail is kept for the error line.
 */
const { spawn } = require('node:child_process');

function runProcess({ command, args = [], env = {}, cwd = null, timeoutMs = 1800_000, onData = () => {}, onKill = null, log = console }) {
    const started = Date.now();
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
                windowsHide: true,
            });
        } catch (err) {
            resolve({ code: null, signal: null, timedOut: false, durationMs: 0, error: String(err.message) });
            return;
        }
        let settled = false;
        let timedOut = false;
        let tail = '';
        let fallback = null;
        const keep = (chunk) => {
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            tail = (tail + text).slice(-8192);
            try { onData(chunk); } catch (err) { log.warn('[git-ci-runner] log sink:', err.message); }
        };
        const kill = () => {
            if (onKill) { try { Promise.resolve(onKill()).catch(() => {}); } catch { /* best effort */ } }
            try {
                if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
        };
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (fallback) clearTimeout(fallback);
            resolve({ ...value, durationMs: Date.now() - started, timedOut, tail });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            log.warn(`[git-ci-runner] ${command} reached its ${Math.round(timeoutMs / 1000)}s limit; killing it`);
            kill();
            // A container client that does not die would hold the queue: resolve anyway.
            fallback = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 10_000);
        }, Math.max(100, Number(timeoutMs) || 1800_000));
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', (err) => finish({ code: null, signal: null, error: String(err.message) }));
        child.on('close', (code, signal) => finish({ code, signal }));
    });
}

module.exports = { runProcess };
