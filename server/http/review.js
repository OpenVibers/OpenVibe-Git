'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { callerOf, viewerFrom } = require('./identity');
const { send } = require('../render/layout');
const views = require('../views/review');
const plumbing = require('../git/review');
function createReviewRoutes(ctx, api = false) {
    const r = express.Router(), review = ctx.reviews;
    r.use(express.urlencoded({ extended:false, limit:'64kb' }));
    const prefix = api ? '/repos/:owner/:name' : '/:owner/:name';
    const h = (fn) => (req,res,next) => Promise.resolve(fn(req,res)).catch((e) => { if (api && e.files) return res.status(e.status).json({ error:e.message, files:e.files }); next(e); });
    const expensive = rateLimit({ windowMs:60000, limit:5, standardHeaders:true, legacyHeaders:false });
    async function context(req) {
        const actor = await callerOf(req,ctx), viewer = viewerFrom(actor);
        const row = await ctx.repos.getRow(req.params.owner,req.params.name);
        if (!row || !ctx.repos.canView(row,viewer)) throw plumbing.fail(404,'Repository not found');
        if (actor && !actor.scopes.has('git.repo.read')) throw plumbing.fail(403,'Read scope required');
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const origin = req.get('origin');
            if (actor && actor.via === 'session' && origin !== new URL(ctx.config.baseUrl).origin) throw plumbing.fail(403,'Same-origin request required');
        }
        return { row,actor,viewer };
    }
    const page = (req,res,body,viewer) => { res.set('Cache-Control','no-store'); return send(res,200,{ body,viewer,config:ctx.config,path:req.originalUrl,index:false,title:'Repository review' }); };
    r.use((req,res,next) => { res.set('Cache-Control','no-store'); next(); });
    r.get(`${prefix}/compare/*`,h(async (req,res) => { const {row,viewer}=await context(req); const [base,head]=plumbing.parseCompare(req.params[0]); const out=await plumbing.compare(row,base,head); return api ? res.json(out) : page(req,res,views.compare(row,out),viewer); }));
    r.get(`${prefix}/search`,h(async (req,res) => { const {row,viewer}=await context(req); const q=String(req.query.q || ''); const out=q ? await plumbing.search(row,q) : null; return api ? res.json(out || {results:[],truncated:false}) : page(req,res,views.search(row,out,q),viewer); }));
    r.get(api ? `${prefix}/blame` : `${prefix}/blame/:ref/*`,h(async (req,res) => { const {row,viewer}=await context(req); const out=await plumbing.blame(row,api ? req.query.ref || row.default_branch : req.params.ref,api ? req.query.path : req.params[0]); return api ? res.json(out) : page(req,res,views.blame(row,out),viewer); }));
    r.post(`${prefix}/review-model`,h(async (req,res) => { const {row,actor}=await context(req); review.write(row,actor); const model=req.body.model; if (typeof model !== 'string' || !/^[a-zA-Z0-9][\w./:-]{0,199}$/.test(model)) throw plumbing.fail(422,'Invalid model'); await ctx.store.execute('UPDATE git_repos SET review_model = ? WHERE id = ?',[model,row.id]); return api ? res.json({model}) : res.redirect(303,`/${row.owner_username}/${row.name}/changes`); }));
    for (const [segment,kind] of [['changes','change'],['issues','issue']]) {
        r.get(`${prefix}/${segment}`,h(async (req,res) => { const {row,viewer}=await context(req); const items=await review.list(row,kind,viewer); return api ? res.json({[segment]:items}) : page(req,res,views.list(row,kind,items),viewer); }));
        if (!api) r.get(`${prefix}/${segment}/new`,h(async (req,res) => { const {row,viewer}=await context(req); return page(req,res,views.form(row,kind),viewer); }));
        r.post(`${prefix}/${segment}`,h(async (req,res) => { const {row,actor,viewer}=await context(req); const item=await review.create(row,kind,req.body,actor,viewer); return api ? res.status(201).json(item) : res.redirect(303,`/${row.owner_username}/${row.name}/${segment}/${item.number}`); }));
        r.get(`${prefix}/${segment}/:number`,h(async (req,res) => { const {row,actor,viewer}=await context(req); const item=await review.get(row,kind,req.params.number,viewer); const out=kind === 'change' ? await review.detail(row,item,viewer) : item; const canWrite=!!actor && ctx.repos.isOwner(row,viewer); return api ? res.json(out) : page(req,res,kind === 'change' ? views.change(row,out,canWrite,!!actor) : views.issue(row,item,canWrite,!!actor),viewer); }));
        r.post(`${prefix}/${segment}/:number/:op`,(req,res,next) => ['merge','summary'].includes(req.params.op) ? expensive(req,res,next) : next(),h(async (req,res) => {
            const {row,actor,viewer}=await context(req);
            const out=await plumbing.locked(row,async () => { const item=await review.get(row,kind,req.params.number,viewer); return review.action(row,kind,item,req.params.op,req.body,actor,viewer); });
            return api ? res.json(out) : res.redirect(303,`/${row.owner_username}/${row.name}/${segment}/${req.params.number}`);
        }));
    }
    return r;
}
module.exports = { createReviewRoutes };
