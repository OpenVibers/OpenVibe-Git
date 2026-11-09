'use strict';
const assert = require('assert');
const { boot } = require('./helpers/boot');
const plumbing = require('../server/git/review');
(async () => {
    let now = Date.now(), summaries=0; const delivered=[];
    const t=await boot({now:()=>now,reviewServices:{thread:async(k,id)=>`thread-${id}`,comment:async(...a)=>delivered.push(a),notify:async(...a)=>delivered.push(a),summary:async(o)=>{summaries++;return {text:'Summary: improved. Risk: small.',model:o.model};}}});
    try {
        const sam=t.asUser('sam'), pat=t.asUser('pat');
        await t.ctx.repos.create({actor:sam,name:'review',starter:'static',visibility:'public'});
        const row=await t.ctx.repos.getRow('sam','review');
        const commit=async(branch,content,base='main')=>t.ctx.git.commitFiles('sam','review',{branch,base,message:'Review fixture',files:[{path:'demo.txt',content}],author:{name:'Sam',email:'sam@example.com'}});
        const head=await commit('agent/demo','one\ntwo\n');
        const root='/api/v1/repos/sam/review';
        const post=(p,json,as=sam)=>t.get(root+p,{as,json});
        const created=await post('/changes',{title:'A useful change',base_ref:'main',head_ref:'agent/demo'});
        assert.equal(created.status,201,created.text); const c=created.json();
        let d=await t.get(root+`/changes/${c.number}`); assert.equal(d.status,200,d.text);
        assert.equal(d.json().diff.added,2); assert.equal(d.json().checks_label,'No checks');
        const anchor={head_sha:head.sha,path:'demo.txt',line:1,side:'new',message:'Keep the first line.'};
        assert.equal((await post(`/changes/${c.number}/comments`,anchor)).status,200);
        assert.equal((await post(`/changes/${c.number}/comments`,{...anchor,line:99})).status,422);
        assert.equal((await post(`/changes/${c.number}/approve`,{head_sha:head.sha},pat)).status,200);
        assert.equal((await post(`/changes/${c.number}/merge`,{head_sha:head.sha},pat)).status,403);
        assert.equal((await post('/review-model',{model:'local/review'})).status,200);
        const actor={...sam,actor_type:'user',scopes:new Set(['git.repo.read','git.repo.write'])};
        const fresh=await t.ctx.repos.getRow('sam','review');
        await t.ctx.reviews.action(fresh,'change',c,'summary',{head_sha:head.sha},actor,sam);
        await t.ctx.reviews.action(fresh,'change',c,'summary',{head_sha:head.sha},actor,sam);
        assert.equal(summaries,1,'summary cached by commit/model');
        await t.ctx.reviews.drain(); assert.ok(delivered.length>=3,'thread/comments/notification delivered');
        assert.equal((await t.get('/sam/review/compare/main...agent/demo')).status,200);
        const page=await t.get(`/sam/review/changes/${c.number}`,{as:sam}); assert.match(page.text,/Keep the first line/); assert.match(page.text,/No checks/);
        assert.equal((await post(`/changes/${c.number}/merge`,{head_sha:head.sha,method:'squash'})).status,200);
        assert.equal((await t.get(root+`/changes/${c.number}`)).json().change.state,'merged');
        assert.equal((await t.get(root+'/blame?ref=main&path=demo.txt')).json().lines.length,2);
        assert.equal((await t.get(root+'/search?q=two')).json().results.length,1);
        const issue=await post('/issues',{title:'A useful issue',body:'Please document this.'}); assert.equal(issue.status,201,issue.text);
        assert.equal((await post(`/issues/${issue.json().number}/labels`,{labels:['docs']})).status,200);
        assert.equal((await post(`/issues/${issue.json().number}/close`,{})).status,200);
        now+=8*86400000; await t.ctx.reviews.cleanup(); assert.equal(await t.ctx.git.resolveCommit('sam','review','agent/demo'),null);
        assert.equal((await t.get(root+`/changes/${c.number}`)).status,200,'closed diff survives branch cleanup');
        // All three git merge strategies and conflicts, with real commits/worktrees.
        for (const method of ['merge','rebase']) {
            const next=await commit(`feature-${method}`,`${method}\n`);
            const change={number:100,title:method,base_ref:'main',head_ref:`feature-${method}`};
            const sha=await plumbing.locked(row,()=>plumbing.merge(row,row,change,method,next.sha,sam));
            assert.equal(await plumbing.resolve(row,'main'),sha);
        }
        const old=await plumbing.resolve(row,'main');
        const conflict=await commit('conflict','conflict\n',old); await commit('main','target\n');
        await assert.rejects(plumbing.locked(row,()=>plumbing.merge(row,row,{number:101,title:'Conflict',base_ref:'main',head_ref:'conflict'},'merge',conflict.sha,sam)),e=>e.status===409 && e.files.includes('demo.txt'));
        await assert.rejects(plumbing.locked(row,()=>plumbing.locked(row,async()=>{})),e=>e.status===409);
        await t.ctx.repos.create({actor:sam,name:'private',starter:'static',visibility:'private'});
        for(const suffix of ['/changes','/issues','/compare/main...main','/blame?ref=main&path=README.md','/search?q=a']) assert.equal((await t.get('/api/v1/repos/sam/private'+suffix)).status,404,suffix);
        const csrf=await post('/issues',{title:'CSRF',body:'bad'},sam); assert.equal(csrf.status,201);
        assert.equal((await t.get(root+'/issues',{as:sam,json:{title:'bad'},headers:{origin:'https://evil.example'}})).status,403);
        for (const v of ['--help...main','main...../x','main...x...y','a\0...b','a...b~1']) assert.throws(()=>plumbing.parseCompare(v));
        let seed=7;
        for(let i=0;i<2000;i++){seed=(seed*1664525+1013904223)>>>0;const value=String.fromCharCode(seed%128)+'..'+i;assert.throws(()=>plumbing.parseCompare(value+'...main'));}
        const fork=await t.ctx.repos.fork({source:row,actor:pat,name:'review-fork'});
        const forkRow=await t.ctx.repos.getRow('pat','review-fork');
        const forkHead=await t.ctx.git.commitFiles('pat','review-fork',{branch:'feature',base:'main',message:'Fork change',files:[{path:'fork.txt',content:'Fork contribution'}],author:{name:'Pat',email:'pat@example.com'}});
        const fc=await post('/changes',{title:'From a fork',base_ref:'main',head_ref:'feature',source_repo:'pat/review-fork'},pat);
        assert.equal(fc.status,201,fc.text);
        assert.equal((await t.get(root+`/changes/${fc.json().number}`)).json().diff.files[0].path,'fork.txt');
        await t.store.execute("UPDATE git_repos SET visibility = 'private' WHERE id = ?",[forkRow.id]);
        assert.equal((await t.get(root+`/changes/${fc.json().number}`)).status,404,'private fork checked on every read');
        assert.ok(!(await t.get(root+'/changes')).json().changes.some(x=>x.id===fc.json().id),'private fork omitted from list');
        await t.store.execute("UPDATE git_repos SET visibility = 'public' WHERE id = ?",[forkRow.id]);
        await assert.rejects(plumbing.locked(row,()=>plumbing.merge(row,forkRow,fc.json(),'merge','0'.repeat(40),sam)),e=>e.status===409);
        const forkMerge=await plumbing.locked(row,()=>plumbing.merge(row,forkRow,fc.json(),'merge',forkHead.sha,sam));
        assert.equal(await plumbing.resolve(row,'main'),forkMerge);
        let limited=false;
        for(let i=0;i<6;i++){const response=await post(`/changes/${fc.json().number}/summary`,{head_sha:forkHead.sha});if(response.status===429)limited=true;}
        assert.ok(limited,'summary/merge rate limit enforced');
        console.log('review: compare, comments, approvals, merge/squash/rebase, conflict, private access, issues, cleanup, search, blame, summary cache and parser fuzz passed');
    } finally {await t.close();}
})().catch(e=>{console.error(e);process.exit(1);});
