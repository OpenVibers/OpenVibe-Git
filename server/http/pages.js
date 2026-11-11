'use strict';

/**
 * The pages on git.openvibe.codes. They work without JavaScript: a star, a watch, a fork, a release and a
 * repository are plain POSTs that redirect back to the page.
 *
 *   /                          home: the hero, the numbers, trending, activity, the official rail
 *   /explore                   search and filters
 *   /new                       make a repository (empty, app, static, or a GitHub import)
 *   /@name                     a person's public repositories
 *   /:owner/:name              the repository: header, Get it, GitHub card, tree, README
 *   /:owner/:name/tree         a directory (ref and path in the query)
 *   /:owner/:name/blob         a file, highlighted on the server, with line links
 *   /:owner/:name/raw          its bytes
 *   /:owner/:name/archive/<ref>.tar.gz  a gzip tarball of a ref, stable for a tag
 *   /:owner/:name/commits      history (optionally of one path)
 *   /:owner/:name/commit/:sha  one commit and its diff
 *   /:owner/:name/branches · tags · releases · contributors · insights
 *   /:owner/:name.git/…        git over HTTPS (server/git/http-backend.js; mounted before these routes)
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { send } = require('../render/layout');
const views = require('../views');
const ciViews = require('../views/ci');
const machineViews = require('../views/machine');
const { viewerOf } = require('./identity');
const { esc } = require('../render/html');
const { renderMarkdown } = require('../render/markdown');
const { validRef, validPath } = require('../git/refs');
const { serveArchive } = require('../archive');

function createPageRoutes(ctx) {
    const { config, repos, git, github, mirrors, insights, store, relay, archive, ci, log } = ctx;
    const r = express.Router();
    r.use(express.urlencoded({ extended: false, limit: '256kb' }));
    const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
    const viewer = (req) => viewerOf(req);
    const signedIn = (req) => Boolean(req.user);
    const page = (req, res, body, o = {}) => send(res, o.status || 200, { viewer: viewer(req), config, path: req.originalUrl, body, ...o });
    const loginTo = (path) => `/auth/login?next=${encodeURIComponent(path)}`;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).host === new URL(config.baseUrl).host; } catch { return false; }
    };
    const guard = (req, res) => {
        if (!signedIn(req)) { res.redirect(303, loginTo(req.originalUrl)); return false; }
        if (!sameOrigin(req)) { page(req, res, views.message({ title: 'Not from this site', text: 'Changes to a repository must be made on git.openvibe.codes itself.', link: { href: '/', label: 'OpenVibe Git' } }), { status: 403 }); return false; }
        return true;
    };
    async function rowFor(req, res) {
        const row = await repos.getRow(String(req.params.owner || '').toLowerCase(), String(req.params.name || '').toLowerCase());
        if (!row || !repos.canView(row, viewer(req))) { page(req, res, views.notFound(), { status: 404, title: 'Not found' }); return null; }
        return row;
    }
    const meta = (req, row, { title, description, index = true } = {}) => ({
        title: title || `${row.owner_username}/${row.name}`,
        description: description || row.description || `${row.owner_username}/${row.name} on OpenVibe Git.`,
        index,
        jsonLd: [{
            '@context': 'https://schema.org', '@type': 'SoftwareSourceCode',
            name: `${row.owner_username}/${row.name}`, description: row.description || undefined,
            codeRepository: `${config.baseUrl.replace(/\/+$/, '')}/${row.owner_username}/${row.name}`,
            programmingLanguage: row.language || undefined,
        }],
    });

    async function repoContext(req, row) {
        const me = viewer(req);
        const [starred, watching, parent, machines] = await Promise.all([
            repos.isStarred(row, me && me.subject),
            repos.isWatching(row, me && me.subject),
            row.fork_of ? repos.byId(row.fork_of) : Promise.resolve(null),
            me && me.subject ? relay.listMachines({ subject: me.subject }) : Promise.resolve(null),
        ]);
        const start = { starred, watching, forkOf: parent ? `${parent.owner_username}/${parent.name}` : null, isOwner: repos.isOwner(row, me) };
        const card = row.github_full_name ? await github.card(row.github_full_name, { branch: row.default_branch }) : null;
        return { ...start, card, languages: row.languages, machines };
    }

    async function readReadme(row, ref) {
        try {
            const tree = await git.readTree(row.owner_username, row.name, ref, '', { withLastCommit: false });
            const entry = tree && tree.entries.find((e) => e.type === 'blob' && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name));
            if (!entry) return null;
            let blob = await git.readBlob(row.owner_username, row.name, ref, entry.name, { maxBytes: config.data.maxFileBytes });
            if (!blob || blob.binary) return null;
            const html = /\.(md|markdown)$/i.test(entry.name)
                ? renderMarkdown(blob.text || '')
                : `<pre>${esc(blob.text || '')}</pre>`;
            return { path: entry.name, html };
        } catch { return null; }
    }

    // ── Home ────────────────────────────────────────────────
    r.get('/', h(async (req, res) => {
        const [stats, trending, activity, official, languages] = await Promise.all([
            repos.stats(), repos.trending(6), repos.activity(10), repos.official(), repos.languagesFacet(),
        ]);
        return page(req, res, views.home({ viewer: viewer(req), stats, trending, activity, official, baseUrl: config.baseUrl }), {
            title: null, index: true,
            description: 'Git for OpenVibe: host code with your OpenVibe account, browse it, mirror GitHub, and clone it to your computer with Link. Made with git’s own http-backend.',
            jsonLd: [{
                '@context': 'https://schema.org', '@type': 'WebSite',
                name: 'OpenVibe Git', url: config.baseUrl.replace(/\/+$/, ''),
                potentialAction: { '@type': 'SearchAction', target: `${config.baseUrl.replace(/\/+$/, '')}/explore?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
            }],
        });
    }));

    // ── Explore ─────────────────────────────────────────────
    r.get('/explore', h(async (req, res) => {
        const filters = {
            official: req.query.official === '1', mirror: req.query.mirror === '1',
            mine: req.query.mine === '1', starred: req.query.starred === '1',
            sort: String(req.query.sort || 'trending'), language: String(req.query.language || ''),
        };
        const out = await repos.list({
            viewer: viewer(req), q: String(req.query.q || ''), language: filters.language,
            official: filters.official, mirror: filters.mirror, mine: filters.mine, starred: filters.starred,
            sort: filters.sort, limit: 24, cursor: req.query.cursor,
        });
        return page(req, res, views.explore({
            viewer: viewer(req), repositories: out.repositories, query: String(req.query.q || ''),
            filters, next: out.next_cursor, languages: await repos.languagesFacet(),
        }), { title: 'Explore', index: true, description: 'Every public repository on OpenVibe Git: official OpenVibe projects, GitHub mirrors, and what people are making.' });
    }));

    // ── New ─────────────────────────────────────────────────
    r.get('/new', h(async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, loginTo('/new'));
        return page(req, res, views.newPage({ viewer: viewer(req) }), { title: 'New repository' });
    }));

    r.post('/new', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const values = { name: req.body.name, description: req.body.description, visibility: req.body.visibility, starter: req.body.starter, mirror_url: req.body.mirror_url };
        try {
            const starter = values.starter === 'mirror' ? 'empty' : (values.starter || 'empty');
            const repo = await repos.create({
                actor: viewer(req), name: values.name, description: values.description,
                visibility: values.visibility === 'private' ? 'private' : 'public', starter,
                mirrorUrl: values.starter === 'mirror' ? values.mirror_url : null,
            }, { address: req.ip });
            return res.redirect(303, `/${repo.full_name}`);
        } catch (err) {
            return page(req, res, views.newPage({ viewer: viewer(req), values, error: err.message }), { status: err.status || 422, title: 'New repository' });
        }
    }));

    // ── Profile ─────────────────────────────────────────────
    r.get('/@:username', h(async (req, res) => {
        const profile = await repos.profile(String(req.params.username).toLowerCase(), { viewer: viewer(req) });
        if (!profile) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        return page(req, res, views.profilePage({ profile }), { title: `@${profile.username}`, description: `@${profile.username}'s public repositories on OpenVibe Git.` });
    }));

    // ── Your computers, published through Link (G3) ──────────
    const machineFor = async (req, res) => {
        const me = viewer(req);
        if (!me) { res.redirect(303, loginTo('/machines')); return null; }
        const machine = await relay.getMachine({ id: String(req.params.machine || ''), subject: me.subject });
        if (!machine) { page(req, res, views.notFound(), { status: 404, title: 'Not found' }); return null; }
        return machine;
    };
    const repoAt = (machine, name) => (machine.repos || []).find((r) => r.name === String(name || ''));
    const machineResult = (req, res, machine, repo, out, render) => {
        if (out.state === 'offline') return page(req, res, machineViews.machineRepoPage({ machine: out.machine || machine, repo, ref: '', offline: true }), { status: 200, title: `${repo.name} · ${machine.name}` });
        if (out.state === 'missing') return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        if (out.state === 'timeout') return page(req, res, machineViews.machineRepoPage({ machine: out.machine || machine, repo, ref: '', error: 'The computer did not answer in time. It is online; try again.' }), { status: 504, title: `${repo.name} · ${machine.name}` });
        return page(req, res, render(out.result), { title: `${repo.name} · ${machine.name}`, index: false });
    };

    r.get('/machines', h(async (req, res) => {
        const me = viewer(req);
        if (!me) return res.redirect(303, loginTo('/machines'));
        return page(req, res, machineViews.machinesPage({ viewer: me, machines: await relay.listMachines({ subject: me.subject }) }), { title: 'Your computers', index: false });
    }));

    r.post('/machines', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        try {
            const out = await relay.createMachine({ viewer: viewer(req), name: req.body.name });
            return page(req, res, machineViews.machineConnectPage({ machine: out.machine, link: out.link }), { title: `Connect ${out.machine.name}`, index: false });
        } catch (err) {
            return page(req, res, machineViews.machinesPage({ viewer: viewer(req), machines: await relay.listMachines({ subject: viewer(req).subject }), error: err.message }), { status: 422, title: 'Your computers', index: false });
        }
    }));

    r.get('/machines/:machine', h(async (req, res) => {
        const machine = await machineFor(req, res);
        if (!machine) return undefined;
        return page(req, res, machineViews.machinePage({ machine, repos: machine.repos || [] }), { title: machine.name, index: false });
    }));

    r.get('/machines/:machine/:repo/tree', h(async (req, res) => {
        const machine = await machineFor(req, res);
        if (!machine) return undefined;
        const repo = repoAt(machine, req.params.repo);
        if (!repo) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        const ref = String(req.query.ref || repo.branch || 'main');
        const pathAt = String(req.query.path || '');
        if (!validRef(ref) || !validPath(pathAt)) return page(req, res, views.message({ title: 'Not a ref or path', text: 'That ref or path is not something this server reads.', link: { href: `/machines/${machine.id}/${repo.name}`, label: 'Back to the repository' } }), { status: 422 });
        const out = await relay.browse({ machineId: machine.id, kind: 'tree', repo: repo.name, ref, path: pathAt });
        return machineResult(req, res, machine, repo, out, (result) => machineViews.machineRepoPage({ machine, repo, ref, path: pathAt, entries: result.entries || [] }));
    }));

    r.get('/machines/:machine/:repo/blob', h(async (req, res) => {
        const machine = await machineFor(req, res);
        if (!machine) return undefined;
        const repo = repoAt(machine, req.params.repo);
        if (!repo) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        const ref = String(req.query.ref || repo.branch || 'main');
        const pathAt = String(req.query.path || '');
        if (!validRef(ref) || !validPath(pathAt) || !pathAt) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        const out = await relay.browse({ machineId: machine.id, kind: 'file', repo: repo.name, ref, path: pathAt });
        return machineResult(req, res, machine, repo, out, (result) => machineViews.machineFilePage({ machine, repo, ref, path: pathAt, blob: result }));
    }));

    r.get('/machines/:machine/:repo/commits', h(async (req, res) => {
        const machine = await machineFor(req, res);
        if (!machine) return undefined;
        const repo = repoAt(machine, req.params.repo);
        if (!repo) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        const ref = String(req.query.ref || repo.branch || 'main');
        const pathAt = String(req.query.path || '');
        if (!validRef(ref) || !validPath(pathAt)) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        const out = await relay.browse({ machineId: machine.id, kind: 'log', repo: repo.name, ref, path: pathAt });
        return machineResult(req, res, machine, repo, out, (result) => machineViews.machineCommitsPage({ machine, repo, ref, path: pathAt, commits: result.commits || [] }));
    }));

    r.get('/machines/:machine/:repo', h(async (req, res) => {
        const machine = await machineFor(req, res);
        if (!machine) return undefined;
        const repo = repoAt(machine, req.params.repo);
        if (!repo) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        const ref = repo.branch || 'main';
        const out = await relay.browse({ machineId: machine.id, kind: 'tree', repo: repo.name, ref, path: '' });
        return machineResult(req, res, machine, repo, out, (result) => machineViews.machineRepoPage({ machine, repo, ref, path: '', entries: result.entries || [] }));
    }));

    // ── A repository ────────────────────────────────────────
    r.get('/:owner/:name', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        await insights.recordView(row, { address: req.ip || '', userAgent: String(req.get('user-agent') || ''), subject: signedIn(req) ? viewer(req).subject : null });
        const ref = row.default_branch || 'main';
        const [tree, context] = await Promise.all([git.readTree(row.owner_username, row.name, ref, '').catch(() => null), repoContext(req, row)]);
        const readme = tree ? await readReadme(row, ref) : null;
        const cloneRequest = req.query.clone && signedIn(req)
            ? await relay.getForPage({ id: String(req.query.clone), subject: viewer(req).subject })
            : null;
        return page(req, res, views.repoPage({ row, viewer: viewer(req), tree: tree || { path: '', entries: [] }, readme, cloneRequest, ...context }), meta(req, row));
    }));

    r.post('/:owner/:name/clone', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await rowFor(req, res);
        if (!row) return undefined;
        try {
            const out = await relay.createClone({ viewer: viewer(req), row });
            return page(req, res, machineViews.clonePage({ row, request: out.request, link: out.link }), { title: `Clone ${row.owner_username}/${row.name} to your computer`, index: false });
        } catch (err) {
            return page(req, res, views.message({ title: 'The clone request was not made', text: err.message, link: { href: `/${row.owner_username}/${row.name}`, label: 'Back to the repository' } }), { status: err.status || 422 });
        }
    }));

    // Clone to one of the person's own Link computers, from a plain button in the Get it panel. The request rides the
    // watch that computer already holds; this goes back to the repository with its progress line open.
    r.post('/:owner/:name/clone-to-machine', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await rowFor(req, res);
        if (!row) return undefined;
        try {
            const request = await relay.createCloneToMachine({ viewer: viewer(req), row, machineId: req.body.machine });
            return res.redirect(303, `/${row.owner_username}/${row.name}?clone=${encodeURIComponent(request.id)}#get`);
        } catch (err) {
            return page(req, res, views.message({ title: 'The clone request was not made', text: err.message, link: { href: `/${row.owner_username}/${row.name}`, label: 'Back to the repository' } }), { status: err.status || 422 });
        }
    }));

    r.get('/:owner/:name/clone-to-machine/:id', h(async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, loginTo(req.originalUrl));
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const request = await relay.getForPage({ id: String(req.params.id), subject: viewer(req).subject });
        if (!request || request.repo !== `${row.owner_username}/${row.name}`) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        return page(req, res, machineViews.cloneToMachinePage({ row, request }), { title: `Clone ${row.owner_username}/${row.name} to your computer`, index: false });
    }));

    r.get('/:owner/:name/tree', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const ref = String(req.query.ref || row.default_branch || 'main');
        const pathAt = String(req.query.path || '');
        if (!validRef(ref) || !validPath(pathAt)) return page(req, res, views.message({ title: 'Not a ref or path', text: 'That ref or path is not something this server reads.', link: { href: `/${row.owner_username}/${row.name}`, label: 'Back to the repository' } }), { status: 422 });
        await insights.recordView(row, { address: req.ip || '', userAgent: String(req.get('user-agent') || ''), subject: signedIn(req) ? viewer(req).subject : null });
        const tree = await git.readTree(row.owner_username, row.name, ref, pathAt);
        if (!tree) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        const context = await repoContext(req, row);
        return page(req, res, views.treePage({ row, viewer: viewer(req), tree, ...context }), meta(req, row, { title: `${pathAt || row.name} at ${ref}` }));
    }));

    r.get('/:owner/:name/blob', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const ref = String(req.query.ref || row.default_branch || 'main');
        const pathAt = String(req.query.path || '');
        if (!validRef(ref) || !validPath(pathAt) || !pathAt) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        await insights.recordView(row, { address: req.ip || '', userAgent: String(req.get('user-agent') || ''), subject: signedIn(req) ? viewer(req).subject : null });
        let blob = await git.readBlob(row.owner_username, row.name, ref, pathAt, { maxBytes: config.data.maxFileBytes });
        if (!blob) {
            const whole = await git.blobBytes(row.owner_username, row.name, ref, pathAt, { maxBytes: config.data.maxFileBytes });
            if (!whole) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
            blob = { size: whole.size, binary: true, truncated: whole.truncated, text: null };
        }
        const crumbs = pathAt.split('/').map((seg, i, all) => ({ name: seg, path: all.slice(0, i + 1).join('/') }));
        return page(req, res, views.filePage({ row, ref, path: pathAt, blob, crumbs, plain: req.query.plain === '1' }), meta(req, row, { title: `${pathAt} at ${ref}` }));
    }));

    r.get('/:owner/:name/raw', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const ref = String(req.query.ref || row.default_branch || 'main');
        const pathAt = String(req.query.path || '');
        if (!validRef(ref) || !validPath(pathAt) || !pathAt) return res.status(404).type('text/plain').send('Not found.');
        const blob = await git.blobBytes(row.owner_username, row.name, ref, pathAt, { maxBytes: config.data.maxFileBytes });
        if (!blob) return res.status(404).type('text/plain').send('Not found.');
        const ext = pathAt.split('.').pop().toLowerCase();
        const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' }[ext] || 'text/plain; charset=utf-8';
        res.set('Content-Type', type).set('Content-Length', String(blob.data.length)).set('Cache-Control', 'public, max-age=300');
        return res.end(blob.data);
    }));

    r.get('/:owner/:name/archive/*', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        await serveArchive(archive, req, res, row, req.params[0], {
            log, fail: (status, message) => res.status(status).type('text/plain').send(`${message}\n`),
        });
    }));

    r.get('/:owner/:name/commits', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const ref = String(req.query.ref || row.default_branch || 'main');
        const pathAt = String(req.query.path || '');
        if (!validRef(ref) || !validPath(pathAt)) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
        const commits = await git.history(row.owner_username, row.name, ref, { path: pathAt, limit, skip: req.query.cursor });
        if (!commits) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        return page(req, res, views.commitsPage({ row, ref, path: pathAt, commits, next: commits.length === limit ? String((Number(req.query.cursor) || 0) + limit) : null }), meta(req, row, { title: `Commits on ${ref}` }));
    }));

    r.get('/:owner/:name/commit/:sha', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const commit = await git.commitDetail(row.owner_username, row.name, req.params.sha, { diff: true });
        if (!commit) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        return page(req, res, views.commitPage({ row, commit }), meta(req, row, { title: commit.message.split('\n')[0] }));
    }));

    r.get('/:owner/:name/branches', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        return page(req, res, views.branchesPage({ row, branches: await git.branches(row.owner_username, row.name) }), meta(req, row, { title: 'Branches' }));
    }));

    r.get('/:owner/:name/tags', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        return page(req, res, views.tagsPage({ row, tags: await git.tags(row.owner_username, row.name) }), meta(req, row, { title: 'Tags' }));
    }));

    r.get('/:owner/:name/releases', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        return page(req, res, views.releasesPage({ row, releases: await repos.releases(row), viewer: viewer(req) }), meta(req, row, { title: 'Releases' }));
    }));

    r.get('/:owner/:name/contributors', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        return page(req, res, views.contributorsPage({ row, contributors: await repos.contributors(row) }), meta(req, row, { title: 'Contributors' }));
    }));

    r.get('/:owner/:name/insights', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const data = await repos.insightsFor(row, { days: req.query.days });
        return page(req, res, views.insightsPage({ row, data }), meta(req, row, { title: 'Insights', description: `Views, clones, stars and commits for ${row.owner_username}/${row.name}.` }));
    }));

    r.get('/:owner/:name/ci', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const conf = await ci.configFor(row);
        return page(req, res, ciViews.list({
            row, enabled: Boolean(conf && conf.enabled), context: config.ci.context,
            runs: await ci.runsFor(row, { limit: req.query.limit }),
        }), meta(req, row, { title: 'CI', index: false }));
    }));

    r.get('/:owner/:name/ci/:id', h(async (req, res) => {
        const row = await rowFor(req, res);
        if (!row) return undefined;
        const run = await ci.runFor(row, req.params.id);
        if (!run) return page(req, res, views.notFound(), { status: 404, title: 'Not found' });
        return page(req, res, ciViews.run({ row, run }), meta(req, row, { title: `CI · ${run.branch}`, index: false }));
    }));

    // ── Writes ──────────────────────────────────────────────
    r.post('/:owner/:name/star', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await rowFor(req, res);
        if (!row) return undefined;
        await repos.star(row, viewer(req).subject, !(await repos.isStarred(row, viewer(req).subject)));
        return res.redirect(303, `/${row.owner_username}/${row.name}`);
    }));

    r.post('/:owner/:name/watch', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await rowFor(req, res);
        if (!row) return undefined;
        await repos.watch(row, viewer(req).subject);
        return res.redirect(303, `/${row.owner_username}/${row.name}`);
    }));

    r.post('/:owner/:name/fork', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await rowFor(req, res);
        if (!row) return undefined;
        try {
            const forked = await repos.fork({ source: row, actor: viewer(req) }, { address: req.ip });
            return res.redirect(303, `/${forked.full_name}`);
        } catch (err) {
            return page(req, res, views.message({ title: 'The fork was not made', text: err.message, link: { href: `/${row.owner_username}/${row.name}`, label: 'Back to the repository' } }), { status: err.status || 422 });
        }
    }));

    r.post('/:owner/:name/sync', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await rowFor(req, res);
        if (!row) return undefined;
        if (!repos.isOwner(row, viewer(req))) return res.status(403).type('text/plain').send('Only the owner can sync a mirror.');
        if (row.mirror_url) mirrors.syncRow(row).catch(() => {});
        return res.redirect(303, `/${row.owner_username}/${row.name}`);
    }));

    r.post('/:owner/:name/push-mirror', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await rowFor(req, res);
        if (!row) return undefined;
        try {
            await repos.setPushMirror(row, { push_url: req.body.push_url, push_token: req.body.push_token }, viewer(req), { address: req.ip });
        } catch (err) {
            return page(req, res, views.message({ title: 'The push mirror was not saved', text: err.message, link: { href: `/${row.owner_username}/${row.name}`, label: 'Back to the repository' } }), { status: err.status || 422 });
        }
        return res.redirect(303, `/${row.owner_username}/${row.name}`);
    }));

    r.post('/:owner/:name/releases', h(async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await rowFor(req, res);
        if (!row) return undefined;
        if (!repos.isOwner(row, viewer(req))) return res.status(403).type('text/plain').send('Only the owner can publish a release.');
        try {
            await repos.publishRelease(row, { tag: req.body.tag, name: req.body.name, body: req.body.body, actor: viewer(req) });
        } catch (err) {
            return page(req, res, views.message({ title: 'The release was not published', text: err.message, link: { href: `/${row.owner_username}/${row.name}/releases`, label: 'Releases' } }), { status: err.status || 422 });
        }
        return res.redirect(303, `/${row.owner_username}/${row.name}/releases`);
    }));

    // ── Crawl artifacts and the API document ────────────────
    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /auth/\nDisallow: /api/\n\nSitemap: ${config.baseUrl.replace(/\/+$/, '')}/sitemap.xml\n`);
    });
    r.get('/llms.txt', h(async (_req, res) => {
        const official = await repos.official();
        const lines = [
            '# OpenVibe Git', '', '> Git for OpenVibe: host code with your OpenVibe account, browse it, mirror GitHub, and clone it to your computer with Link.', '',
            'Every page is server-rendered. A public repository is readable at /<owner>/<name>; its files at /<owner>/<name>/tree and /<owner>/<name>/blob (ref and path are query parameters); a ref as a tarball at /<owner>/<name>/archive/<ref>.tar.gz. The API is /api/v1/repos.', '',
            '## Official repositories', '',
            ...official.map((o) => `- [${o.full_name}](${config.baseUrl.replace(/\/+$/, '')}/${o.full_name}): ${o.description || 'The OpenVibe projects.'}`), '',
        ];
        res.type('text/plain').send(lines.join('\n'));
    }));
    r.get('/sitemap.xml', h(async (_req, res) => {
        const out = await repos.list({ sort: 'new', limit: 50 });
        const base = config.baseUrl.replace(/\/+$/, '');
        const urls = ['/', '/explore', '/new', ...out.repositories.map((x) => `/${x.full_name}`)];
        res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${esc(base + u)}</loc></url>`).join('')}</urlset>`);
    }));
    r.get('/openapi.json', (_req, res) => {
        res.set('Access-Control-Allow-Origin', '*').json({
            openapi: '3.1.0', info: { title: 'OpenVibe.Git API', version: '1.0.0', description: 'Repositories, browsing, contents writes, stars, mirrors and insights on git.openvibe.codes.' },
            servers: [{ url: config.baseUrl.replace(/\/+$/, '') }],
            paths: {
                '/api/v1/repos': { get: { summary: 'List and search repositories', responses: { 200: { description: 'Repositories' } } }, post: { summary: 'Create a repository', responses: { 201: { description: 'The repository' } } } },
                '/api/v1/repos/{owner}/{name}': { get: { summary: 'One repository', parameters: [{ name: 'owner', in: 'path', required: true, schema: { type: 'string' } }, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The repository' }, 404: { description: 'Not found or private' } } } },
                '/api/v1/repos/{owner}/{name}/tree': { get: { summary: 'A directory at a ref', responses: { 200: { description: 'Tree' } } } },
                '/api/v1/repos/{owner}/{name}/blob': { get: { summary: 'A file at a ref', responses: { 200: { description: 'Blob' } } } },
                '/api/v1/repos/{owner}/{name}/commits': { get: { summary: 'History' }, post: { summary: 'Write a branch and files without a clone', responses: { 201: { description: 'The new commit' } } } },
                '/api/v1/repos/{owner}/{name}/archive/{ref}.tar.gz': { get: { summary: 'A gzip tarball of a ref (a tag answers the same bytes)', responses: { 200: { description: 'The tarball' } } } },
                '/api/v1/repos/{owner}/{name}/commits/{sha}/statuses': { get: { summary: 'The latest status per context for a commit', responses: { 200: { description: 'Statuses' } } }, post: { summary: 'Report a status (git.checks.write)', responses: { 201: { description: 'The status' } } } },
                '/api/v1/repos/{owner}/{name}/insights': { get: { summary: 'Views, clones, stars and commits per week', responses: { 200: { description: 'Insights' } } } },
                '/api/v1/tokens': { post: { summary: 'Make a short-lived Git token', responses: { 201: { description: 'The token, shown once' } } } },
            },
        });
    });

    r.use((req, res) => page(req, res, views.notFound(), { status: 404, title: 'Not found' }));
    return r;
}

module.exports = { createPageRoutes };
