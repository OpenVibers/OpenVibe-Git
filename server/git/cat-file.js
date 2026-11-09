'use strict';

/**
 * One `git cat-file --batch` process per hot repository, the way the plan reads objects: a request is a
 * line on stdin, the answer is a header (`<sha> <type> <size>`) and exactly `size` bytes. The process is
 * reused for 60 s after its last request, then it exits; at most `max` repositories have one.
 *
 *   const pool = createCatFilePool();
 *   const obj = await pool.read(repoDir, 'main:README.md');   // { type, size, data } | null
 */
const { spawn } = require('node:child_process');
const { childEnv } = require('./run');

class CatFile {
    constructor(cwd) {
        this.cwd = cwd;
        this.queue = [];
        this.pending = null;
        this.buf = Buffer.alloc(0);
        this.ready = false;
        this.dead = false;
        this.child = spawn('git', ['cat-file', '--batch'], { cwd, env: childEnv(), shell: false, windowsHide: true });
        this.child.on('data', () => {}); // stdout is consumed below through the stream event
        this.child.stdout.on('data', (chunk) => this.onData(chunk));
        this.child.stderr.on('data', () => { /* a missing object is reported on stdout as `missing` */ });
        this.child.on('error', (err) => this.fail(err));
        this.child.on('close', () => this.fail(new Error('git cat-file exited')));
    }

    fail(err) {
        if (this.dead) return;
        this.dead = true;
        for (const req of this.queue.splice(0)) req.reject(err);
        if (this.pending) { const p = this.pending; this.pending = null; p.reject(err); }
    }

    onData(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        for (;;) {
            if (!this.pending) {
                // Wait for a request; unsolicited output is a protocol error.
                return;
            }
            if (this.pending.size == null) {
                const nl = this.buf.indexOf(0x0a);
                if (nl < 0) return;
                const line = this.buf.subarray(0, nl).toString('utf8');
                this.buf = this.buf.subarray(nl + 1);
                const parts = line.split(' ');
                if (parts[0] === 'missing' || parts[1] === 'missing') {
                    const p = this.pending; this.pending = null; p.resolve(null);
                    this.next();
                    continue;
                }
                if (parts.length < 3) { this.fail(new Error(`git cat-file: ${line.slice(0, 80)}`)); return; }
                this.pending.size = Number(parts[2]);
                this.pending.type = parts[1];
                this.pending.sha = parts[0];
            }
            if (this.pending && this.pending.size != null) {
                if (this.buf.length < this.pending.size + 1) return;   // + one newline
                const data = this.buf.subarray(0, this.pending.size);
                this.buf = this.buf.subarray(this.pending.size + 1);
                const p = this.pending; this.pending = null;
                p.resolve({ sha: p.sha, type: p.type, size: p.size, data: Buffer.from(data) });
                this.next();
            }
        }
    }

    next() {
        if (this.dead || this.pending) return;
        const req = this.queue.shift();
        if (!req) return;
        this.pending = { resolve: req.resolve, reject: req.reject, size: null, type: null, sha: null };
        this.child.stdin.write(`${req.spec}\n`);
    }

    read(spec) {
        return new Promise((resolve, reject) => {
            if (this.dead) return reject(new Error('git cat-file is not running'));
            this.queue.push({ spec, resolve, reject });
            this.next();
        });
    }

    close() {
        this.dead = true;
        try { this.child.stdin.end(); } catch { /* gone */ }
        try { this.child.kill('SIGTERM'); } catch { /* gone */ }
    }
}

function createCatFilePool({ max = 8, idleMs = 60_000 } = {}) {
    const open = new Map();   // cwd → { cat, timer }
    return {
        async read(cwd, spec) {
            let entry = open.get(cwd);
            if (!entry) {
                if (open.size >= max) {
                    const [oldCwd, old] = open.entries().next().value;
                    clearTimeout(old.timer);
                    old.cat.close();
                    open.delete(oldCwd);
                }
                entry = { cat: new CatFile(cwd), timer: null };
                open.set(cwd, entry);
            }
            clearTimeout(entry.timer);
            try { return await entry.cat.read(spec); }
            finally {
                entry.timer = setTimeout(() => { entry.cat.close(); open.delete(cwd); }, idleMs);
                entry.timer.unref();
            }
        },
        close() { for (const [, e] of open) { clearTimeout(e.timer); e.cat.close(); } open.clear(); },
        size() { return open.size; },
    };
}

module.exports = { createCatFilePool, CatFile };
