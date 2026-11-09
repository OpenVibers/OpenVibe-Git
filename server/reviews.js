'use strict';
const plumbing = require('./git/review');
const { validRef, validPath, validRepo } = require('./git/refs');
const { runGit } = require('./git/run');
const { fail } = plumbing;
const text = (v, max, required = true) => { if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw fail(422, 'Invalid text'); return v.trim(); };
function createReviews(ctx, services) {
    const { store: s, repos, git } = ctx;
    let timer, running = false;
    const actorId = (a) => a && (a.on_behalf_of || a.subject);
    const writable = (r, a) => !!a && a.scopes.has('git.repo.write') && repos.isOwner(r, { subject: actorId(a) });
    function auth(a) { if (!actorId(a) || !a.scopes.has('git.repo.write')) throw fail(403, 'A write-scoped signed-in person is required'); }
    function write(r, a) { auth(a); if (!writable(r, a)) throw fail(403, 'Repository write access required'); }
    const table = (kind) => kind === 'change' ? 'git_changes' : 'git_issues';
    async function queue(kind, payload) { await s.execute('INSERT INTO git_review_outbox (id,kind,payload) VALUES (?,?,?::jsonb)', [s.newId('out'), kind, JSON.stringify(payload)]); }
    async function notify(r, item, action, a) {
        const watchers = await s.many('SELECT subject FROM git_watches WHERE repo_id = ?', [r.id]);
        const subjects = new Set([item.author, r.owner_subject, ...watchers.map((w) => w.subject)]);
        for (const subject of subjects) if (subject && subject !== actorId(a)) await queue('notification', { subject, repo_id: r.id, source_repo_id: item.source_repo_id, title: `${r.owner_username}/${r.name}: ${action} #${item.number}`, url: `${ctx.config.baseUrl}/${r.owner_username}/${r.name}/changes/${item.number}` });
    }
    async function sourceFor(r, c, viewer) {
        const source = await repos.byId(c.source_repo_id);
        if (!source || !repos.canView(source, viewer)) throw fail(404, 'Source repository unavailable');
        return source;
    }
    async function get(r, kind, number, viewer) {
        if (!/^[1-9][0-9]{0,14}$/.test(String(number))) throw fail(404, 'Not found');
        const item = await s.maybe(`SELECT * FROM ${table(kind)} WHERE repo_id = ? AND number = ?`, [r.id, number]);
        if (!item) throw fail(404, 'Not found');
        if (kind === 'change') await sourceFor(r, item, viewer);
        return item;
    }
    async function list(r, kind, viewer) {
        const rows = await s.many(`SELECT * FROM ${table(kind)} WHERE repo_id = ? ORDER BY number DESC LIMIT 100`, [r.id]);
        if (kind !== 'change') return rows;
        const result = [];
        for (const row of rows) { try { await sourceFor(r, row, viewer); result.push(row); } catch (e) { if (e.status !== 404) throw e; } }
        return result;
    }
    async function create(r, kind, body, a, viewer) {
        auth(a);
        const title = text(body.title, 200), description = text(body.body || '', 10000, false), id = s.newId(kind === 'change' ? 'chg' : 'iss');
        if (kind === 'change') {
            if (!validRef(body.base_ref) || !validRef(body.head_ref)) throw fail(422, 'Invalid branch');
            const name = body.source_repo || `${r.owner_username}/${r.name}`;
            if (!validRepo(name)) throw fail(422, 'Invalid source repository');
            const [owner, repoName] = name.split('/');
            const source = await repos.getRow(owner, repoName);
            if (!source || !repos.canView(source, viewer)) throw fail(404, 'Source repository unavailable');
            if (source.id !== r.id && source.fork_of !== r.id && r.fork_of !== source.id && (!source.fork_of || source.fork_of !== r.fork_of)) throw fail(422, 'Source must be a fork of this repository');
            if (source.id !== r.id && source.visibility === 'private' && r.visibility !== 'private') throw fail(422, 'A private fork cannot propose into a public repository');
            if (source.id === r.id && body.base_ref === body.head_ref) throw fail(422, 'Choose different branches');
            await plumbing.resolve(r, body.base_ref, true);
            const head = await plumbing.resolve(source, body.head_ref, true);
            await s.execute('INSERT INTO git_changes (id,repo_id,source_repo_id,base_ref,head_ref,title,body,author,head_sha) VALUES (?,?,?,?,?,?,?,?,?)', [id,r.id,source.id,body.base_ref,body.head_ref,title,description,actorId(a),head]);
        } else {
            await s.execute('INSERT INTO git_issues (id,repo_id,title,body,author) VALUES (?,?,?,?,?)', [id,r.id,title,description,actorId(a)]);
        }
        await queue('thread', { kind, id, message: `${title}\n\n${description}`, subject: actorId(a) });
        return await s.one(`SELECT * FROM ${table(kind)} WHERE id = ?`, [id]);
    }
    async function retain(r,c,diff) {
        await runGit(['update-ref',`refs/review/${c.id}/head`,diff.head],{cwd:git.repoDir(r.owner_username,r.name)});
        await runGit(['update-ref',`refs/review/${c.id}/base`,diff.from],{cwd:git.repoDir(r.owner_username,r.name)});
        await s.execute('UPDATE git_changes SET diff_base_sha = ? WHERE id = ?',[diff.from,c.id]);
    }
    async function detail(r, c, viewer) {
        const source = await sourceFor(r, c, viewer);
        // Closed changes retain their captured revision after an agent branch is deleted.
        const diff = c.state === 'open' ? await plumbing.compare(r,c.base_ref,c.head_ref,source,true) : await plumbing.compare(r,c.diff_base_sha,c.head_sha,r,false);
        const comments = await s.many('SELECT * FROM git_change_comments WHERE change_id = ? ORDER BY created_at', [c.id]);
        const approvals = await s.many('SELECT * FROM git_change_reviews WHERE change_id = ? AND head_sha = ?', [c.id,diff.head]);
        const summary = await s.maybe('SELECT result FROM git_change_summaries WHERE change_id = ? AND head_sha = ? AND model = ?', [c.id,diff.head,r.review_model || '']);
        return { change: c, diff, comments, approvals, checks: [], checks_label: 'No checks', summary: summary ? summary.result : null };
    }
    async function action(r, kind, item, op, body, a, viewer) {
        auth(a);
        if (op === 'close') {
            if (item.author !== actorId(a)) write(r,a);
            if (item.state !== 'open') throw fail(409, 'Already closed');
            const closedDiff = kind === 'change' ? await plumbing.compare(r,item.base_ref,item.head_ref,await sourceFor(r,item,viewer),true) : null;
            const head = closedDiff && closedDiff.head;
            if (closedDiff) await retain(r,item,closedDiff);
            await s.execute(`UPDATE ${table(kind)} SET state = 'closed', closed_at = ? ${kind === 'change' ? ', head_sha = ?' : ''} WHERE id = ? AND state = 'open'`, kind === 'change' ? [s.iso(),head,item.id] : [s.iso(),item.id]);
        } else if (kind === 'issue' && op === 'labels') {
            write(r,a);
            const labels = typeof body.labels === 'string' ? body.labels.split(',').map((l) => l.trim()).filter(Boolean) : body.labels;
            if (!Array.isArray(labels) || labels.length > 20 || labels.some((l) => typeof l !== 'string' || !/^[\w -]{1,40}$/.test(l))) throw fail(422, 'Invalid labels');
            await s.execute('UPDATE git_issues SET labels = ?::jsonb WHERE id = ?', [JSON.stringify([...new Set(labels)]),item.id]);
        } else if (kind === 'change') {
            if (item.state !== 'open') throw fail(409, 'Change is closed');
            const source = await sourceFor(r,item,viewer);
            const head = await plumbing.resolve(source,item.head_ref,true);
            if (body.head_sha !== head) throw fail(409, 'Head changed; reload before reviewing');
            if (op === 'comments') {
                if (!validPath(body.path) || !body.path || !['old','new'].includes(body.side) || !Number.isSafeInteger(Number(body.line)) || Number(body.line) < 1) throw fail(422, 'Invalid line anchor');
                const diff = await plumbing.compare(r,item.base_ref,item.head_ref,source,true);
                if (diff.head !== head) throw fail(409,'Head changed while reading diff');
                const file = diff.files.find((f) => f.path === body.path);
                if (!file || !file.lines.some((l) => l[`${body.side}_line`] === Number(body.line))) throw fail(422, 'Line is not in this diff');
                const message = text(body.message,4000), id = s.newId('comment');
                await s.execute('INSERT INTO git_change_comments (id,change_id,author,head_sha,path,line,side,message) VALUES (?,?,?,?,?,?,?,?)', [id,item.id,actorId(a),head,body.path,Number(body.line),body.side,message]);
                await queue('comment', { kind:'change', id:item.id, subject:actorId(a), message:`${body.path}:${body.line} (${body.side}, ${head})\n${message}` });
                await notify(r,item,'commented on',a);
            } else if (op === 'approve') {
                await s.execute('INSERT INTO git_change_reviews (change_id,author,head_sha) VALUES (?,?,?) ON CONFLICT DO NOTHING', [item.id,actorId(a),head]);
                await notify(r,item,'approved',a);
            } else if (op === 'merge') {
                write(r,a);
                const frozen = await plumbing.compare(r,item.base_ref,item.head_ref,source,true);
                if (frozen.head !== head) throw fail(409,'Head changed while reading diff');
                await retain(r,item,frozen);
                const sha = await plumbing.merge(r,source,item,body.method || 'merge',head,a,frozen.base);
                await s.execute("UPDATE git_changes SET state = 'merged', head_sha = ?, merge_sha = ?, closed_at = ? WHERE id = ?", [head,sha,s.iso(),item.id]);
                await repos.audit(a,'git.merge',r,{ change:item.id, sha, method:body.method || 'merge' });
                await notify(r,item,'merged',a);
            } else if (op === 'summary') {
                write(r,a);
                if (!r.review_model) throw fail(422, 'Choose the repository review model first');
                const cached = await s.maybe('SELECT result FROM git_change_summaries WHERE change_id = ? AND head_sha = ? AND model = ?', [item.id,head,r.review_model]);
                if (cached) return cached.result;
                const diff = await plumbing.compare(r,item.base_ref,item.head_ref,source,true);
                const prompt = JSON.stringify(diff);
                if (prompt.length > 190000) throw fail(413, 'Diff too large for a summary');
                const result = await services.summary({ model:r.review_model, text:prompt, key:`git-${require('node:crypto').createHash('sha256').update(`${item.id}:${head}:${r.review_model}`).digest('hex')}`, subject:actorId(a) });
                await s.execute('INSERT INTO git_change_summaries (change_id,head_sha,model,result) VALUES (?,?,?,?::jsonb) ON CONFLICT DO NOTHING', [item.id,head,r.review_model,JSON.stringify(result)]);
                return result;
            } else throw fail(404, 'Unknown action');
        } else throw fail(404,'Unknown action');
        return { ok:true };
    }
    async function drain() {
        const jobs = await s.many('SELECT * FROM git_review_outbox WHERE delivered_at IS NULL AND attempts < 12 ORDER BY created_at LIMIT 30');
        for (const job of jobs) {
            try {
                const p = job.payload;
                if (job.kind === 'notification') {
                    const repo = await repos.byId(p.repo_id);
                    const source = p.source_repo_id ? await repos.byId(p.source_repo_id) : repo;
                    if (repo && source && repos.canView(repo,{subject:p.subject}) && repos.canView(source,{subject:p.subject})) await services.notify(p.subject,p.title,p.url);
                } else {
                    const item = await s.one(`SELECT * FROM ${table(p.kind)} WHERE id = ?`, [p.id]);
                    let thread = item.thread_id;
                    if (!thread) { thread = await services.thread(p.kind,item.id); await s.execute(`UPDATE ${table(p.kind)} SET thread_id = ? WHERE id = ?`, [thread,item.id]); }
                    await services.comment(thread,p.message,p.subject);
                }
                await s.execute('UPDATE git_review_outbox SET delivered_at = ? WHERE id = ?', [s.iso(),job.id]);
            } catch { await s.execute('UPDATE git_review_outbox SET attempts = attempts + 1 WHERE id = ?', [job.id]); }
        }
    }
    async function cleanup() {
        const due = await s.many("SELECT * FROM git_changes WHERE state <> 'open' AND closed_at < ? AND branch_deleted_at IS NULL AND head_ref LIKE 'agent/%' LIMIT 100", [new Date(s.now()-7*86400000).toISOString()]);
        for (const c of due) {
            const r = await repos.byId(c.source_repo_id);
            if (!r || r.default_branch === c.head_ref) continue;
            await plumbing.locked(r,async () => {
                const open = await s.maybe("SELECT id FROM git_changes WHERE state = 'open' AND ((source_repo_id = ? AND head_ref = ?) OR (repo_id = ? AND base_ref = ?))", [r.id,c.head_ref,r.id,c.head_ref]);
                if (open) return;
                const sha = await git.resolveCommit(r.owner_username,r.name,`refs/heads/${c.head_ref}`);
                if (sha && sha !== c.head_sha) return;
                if (sha) await runGit(['update-ref','-d',`refs/heads/${c.head_ref}`,sha], { cwd:git.repoDir(r.owner_username,r.name) });
                await s.execute('UPDATE git_changes SET branch_deleted_at = ? WHERE id = ?', [s.iso(),c.id]);
            });
        }
    }
    return { get,list,create,detail,action,write,drain,cleanup,
        start() { timer = setInterval(async () => { if (running) return; running=true; try { await drain(); await cleanup(); } catch { ctx.log.warn('[git] review maintenance will retry'); } finally { running=false; } },60000); timer.unref(); },
        stop() { clearInterval(timer); },
    };
}
module.exports = { createReviews };
