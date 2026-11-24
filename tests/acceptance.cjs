const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const {chromium} = require('playwright');
const {serve} = require('./serve.cjs');
const fixtures = require('./acceptance-fixtures.json'), contract = require('./runtime-contract.json');
const arg = key => process.argv.includes(key) ? process.argv[process.argv.indexOf(key)+1] : '';
const output = path.resolve(arg('--output') || 'test-results'); fs.mkdirSync(output,{recursive:true});
const channels = (arg('--browsers') || 'chromium').split(',');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const normalize = s => s.replace(/\s+/g,'');
const report = {version:contract.version, startedAt:new Date().toISOString(), checks:[], browsers:[]};
let hosted;
async function step(list,name,fn){
  const start=Date.now(); try {const detail=await fn();list.push({name,passed:true,ms:Date.now()-start,detail});return detail;}
  catch(e){list.push({name,passed:false,ms:Date.now()-start,error:e.stack});throw e;}
}
function asset(base,relative){return new URL(relative.split('/').map(encodeURIComponent).join('/'),base).href;}
async function verifyResources(base){
  const failures=[],checked=[],retries=[];let next=0;
  // Fetch every published dependency, not only the first screen. The marker and
  // README are not browser dependencies and are not served by every Pages edge.
  const files=contract.files.filter(f=>!f.path.startsWith('.')&&!f.path.endsWith('README.md'));
  await Promise.all(Array.from({length:12},async()=>{
    while(next<files.length){const file=files[next++];try{
      let response;
      for(let attempt=0;attempt<3;attempt++){
        response=await fetch(asset(base,file.path)+'?audit='+contract.version,{signal:AbortSignal.timeout(60000)});
        if(![429,502,503,504].includes(response.status)||attempt===2)break;
        retries.push({path:file.path,status:response.status,attempt:attempt+1});
        await response.arrayBuffer();
        await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
      }
      assert.equal(response.status,200,file.path+' HTTP status');
      const bytes=Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length,file.bytes,file.path+' byte count');assert.equal(hash(bytes),file.sha256,file.path+' SHA-256');
      checked.push(file.path);
    }catch(e){failures.push({path:file.path,error:e.message});}}
  }));
  assert.deepEqual(failures,[],JSON.stringify(failures));
  return {files:checked.length,contentShards:contract.shards.length,mediaMappings:contract.images.length,retries};
}
async function browserChecks(base,channel){
  const result={channel,checks:[],console:[],pageErrors:[],failedRequests:[],httpErrors:[],requests:[],csp:[]};
  const browser=await chromium.launch({headless:true,...channel==='chromium'?{}:{channel}});
  result.browserVersion=browser.version();
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000},timezoneId:'Asia/Singapore'});
  await context.exposeBinding('__acceptanceCSPReport',(_,value)=>result.csp.push(value));
  // The real HTTPS connection took 33 seconds to load the cold 4 MiB catalog.
  // Explicit filter assertions remain at 20 seconds; network navigation gets 60.
  context.setDefaultTimeout(60000);context.setDefaultNavigationTimeout(60000);
  const page=await context.newPage();
  page.on('console',m=>result.console.push({type:m.type(),text:m.text(),location:m.location()}));
  page.on('pageerror',e=>result.pageErrors.push({message:e.message,stack:e.stack}));
  page.on('request',r=>result.requests.push({url:r.url(),method:r.method(),resourceType:r.resourceType()}));
  page.on('requestfailed',r=>result.failedRequests.push({url:r.url(),error:r.failure()?.errorText}));
  page.on('response',r=>{if(r.status()>=400)result.httpErrors.push({url:r.url(),status:r.status()});});
  await context.addInitScript(()=>{
    window.addEventListener('securitypolicyviolation',e=>
      window.__acceptanceCSPReport({directive:e.effectiveDirective,blocked:e.blockedURI}));
  });
  const bank=asset(base,'精品题库/打开题库.html');
  const check=(name,fn)=>step(result.checks,name,fn);
  async function ready(){await page.getByRole('heading',{name:'初中语文精品题库',exact:true}).waitFor();}
  async function searchCase(test){
    await page.evaluate(hash=>{location.hash=hash;},test.hash);
    await page.waitForFunction(expected=>{
      const count=document.querySelector('.result-count')?.textContent.replace(/\s+/g,'')||'';
      const ids=[...document.querySelectorAll('main article [id^="row-selection-trigger-"]')]
        .map(e=>e.id.slice('row-selection-trigger-'.length));
      return count.includes('共'+expected.groups+'组，'+expected.questions+'小问')&&JSON.stringify(ids)===JSON.stringify(expected.firstIds);
    },test,{timeout:20000});
  }
  try{
    await check('home entry, initialization, exact data contract',async()=>{
      await page.goto(base,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.body.dataset.ready==='true');
      await page.getByRole('link',{name:'精品题库',exact:true}).click();await ready();
      const state=await page.evaluate(()=>({keys:Object.keys(RC4_BANK),groups:RC4_BANK.catalog.groups.length,
        questions:RC4_BANK.catalog.questions.length,dataVersion:RC4_BANK.catalog.dataVersion,
        content:Object.keys(RC4_BANK.content).length,media:Object.keys(RC4_BANK.media).length,
        loader:typeof RC4BankLoader.content,wordFormat:typeof RC4_BANK.wordFormat,
        initializationVisible:document.getElementById('app').textContent.includes('正在打开教师选题工作台')}));
      assert.deepEqual(state.keys,['catalog','report','content','media','wordFormat']);
      assert.equal(state.groups,694);assert.equal(state.questions,3086);assert.equal(state.dataVersion,contract.dataVersion);
      assert.equal(state.content,0);assert.equal(state.media,115);assert.equal(state.loader,'function');
      assert.equal(state.wordFormat,'string');assert.equal(state.initializationVisible,false);
      assert.equal(result.requests.filter(r=>/online-data\/media\//.test(r.url)).length,0);
      return state;
    });
    await check('teacher workbench link returns to overall homepage with active module filter',async()=>{
      await page.getByRole('button',{name:'诗歌鉴赏',exact:true}).click();
      const brand=page.getByRole('link',{name:'教师工作台',exact:true});
      assert.equal(await brand.getAttribute('href'),'../打开教研工作台.html');
      await brand.click();await page.getByRole('heading',{name:'初中语文考情查询',exact:true}).waitFor();
      assert.equal(new URL(page.url()).pathname,new URL(asset(base,'打开教研工作台.html')).pathname);
      await page.screenshot({path:path.join(output,channel+'-workbench-home.png')});
    });
    await check('direct entry and all baseline filter/alias/subtask results',async()=>{
      await page.goto(bank);await ready();
      for(let i=0;i<fixtures.cases.length;i++){
        const test=fixtures.cases[i];try{await searchCase(test);}catch(e){e.message='Filter '+test.name+': '+e.message;throw e;}
        if(i&&i%50===0)console.log(channel+': '+i+'/'+fixtures.cases.length+' baseline filter cases');
      }
      return {cases:fixtures.cases.length,baselineAppSha256:fixtures.baselineAppSha256};
    });
    await check('filter controls and refresh/direct parameter links',async()=>{
      const test=fixtures.cases.find(x=>x.name==='pool:八上');await searchCase(test);
      await page.getByRole('button',{name:'筛选题目',exact:true}).click();
      const selects=await page.locator('select').evaluateAll(es=>es.map(e=>({name:e.name,options:[...e.options].map(o=>o.value)})));
      for(const name of ['pool','module','theme','main','sub','difficulty','classType'])assert(selects.some(e=>e.name===name),name);
      await page.getByRole('button',{name:'筛选题目',exact:true}).click();
      const deepLink=page.url();await page.reload();await searchCase(test);
      assert.equal(page.url(),deepLink);
      const extra=await context.newPage();await extra.goto(deepLink);
      await extra.locator('.result-count').waitFor();assert((await extra.locator('.result-count').textContent()).replace(/\s+/g,'').includes('共'+test.groups+'组'));
      await extra.close();
    });
    await check('complete materials, questions, answers, compound parent tasks and source previews',async()=>{
      const samples=[];
      for(const [id,title] of fixtures.previews){
        const params=new URLSearchParams({query:id,group:id});
        await page.evaluate(h=>{location.hash=h;},'#/search?'+params);
        const dialog=page.getByRole('dialog',{name:title,exact:true});await dialog.waitFor();
        const panel=page.getByRole('tabpanel',{name:'原题',exact:true});
        const materialCheck=await page.evaluate(groupId=>{
          const g=RC4_BANK.catalog.groups.find(x=>x.id===groupId),actual=document.querySelector('[role="tabpanel"]')?.textContent.replace(/\s+/g,'')||'';
          const t=document.createElement('template');t.innerHTML=g.studentLayout.material||'';
          const paragraphs=[...t.content.querySelectorAll('p')].map(p=>p.textContent.replace(/\s+/g,'')).filter(s=>s.length>3);
          return {paragraphs:paragraphs.length,missing:paragraphs.filter(s=>!actual.includes(s))};
        },id);
        assert.deepEqual(materialCheck.missing,[],title+' complete material');
        assert((await panel.textContent()).trim().length>40,title+' questions');
        if(id==='七上-JY-020'){
          const text=normalize(await panel.textContent());
          for(const task of fixtures.parentTasks)assert(text.includes(normalize(task.prompt)),task.id+' original parent question');
        }
        await page.getByRole('tab',{name:'答案',exact:true}).click();
        const answers=normalize(await page.getByRole('tabpanel',{name:'答案',exact:true}).textContent());
        assert(answers.length>20,title+' answer panel');
        await page.getByRole('tab',{name:'来源',exact:true}).click();
        const sourcePanel=page.getByRole('tabpanel',{name:'来源',exact:true});assert((await sourcePanel.textContent()).trim().length>20);
        await page.getByRole('tab',{name:'原题',exact:true}).click();
        if(id==='八上秋季-JY-017'){
          const images=panel.locator('img');assert((await images.count())>=2);
          await page.waitForFunction(()=>[...document.querySelectorAll('[role="tabpanel"] img')].every(i=>i.complete&&i.naturalWidth>0));
          await panel.getByRole('link',{name:'放大原题配图',exact:true}).first().click();
          await page.getByRole('dialog',{name:'题图放大预览',exact:true}).waitFor();
          await page.getByRole('button',{name:'关闭题图预览',exact:true}).click();
          await page.screenshot({path:path.join(output,channel+'-image-question.png')});
        }
        samples.push({id,title,materialParagraphs:materialCheck.paragraphs,answerCharacters:answers.length});
        await page.getByRole('button',{name:'关闭原题预览',exact:true}).click();
        await dialog.waitFor({state:'hidden'});
      }
      return samples;
    });
    await check('all referenced images decode in the actual browser',async()=>{
      const images=contract.images.filter(i=>i.referenced);
      const failures=await page.evaluate(async list=>{
        let next=0;const bad=[];await Promise.all(Array.from({length:8},async()=>{
          while(next<list.length){const item=list[next++];await new Promise(resolve=>{
            const image=new Image(),timer=setTimeout(()=>{bad.push(item.path+' timeout');resolve();},30000);
            image.onload=()=>{clearTimeout(timer);if(!image.naturalWidth)bad.push(item.path);resolve();};
            image.onerror=()=>{clearTimeout(timer);bad.push(item.path);resolve();};image.src=new URL(item.path,document.currentScript?.src||location.href.replace(/精品题库.*/,''));
          });}
        }));return bad;
      },images.map(i=>({...i,path:asset(base,i.path)})));
      assert.deepEqual(failures,[]);return {decoded:images.length};
    });
    await check('basket, offline-only Word action, records, backup and restore',async()=>{
      await page.goto(bank+'#/search?query='+encodeURIComponent('使至塞上'));
      await page.locator('main article').first().getByRole('heading').getByRole('button').click();
      await page.getByRole('checkbox',{name:'(2) · 情感态度理解',exact:true}).check();
      await page.getByRole('button',{name:'关闭原题预览',exact:true}).click();
      await page.getByRole('button',{name:'选题篮 · 1小问',exact:true}).click();
      assert(await page.getByRole('button',{name:'Word 导出（离线版）',exact:true}).isDisabled());
      await page.getByRole('button',{name:'记录使用',exact:true}).click();
      const form=page.getByRole('dialog',{name:'记录使用',exact:true});
      await form.getByRole('textbox',{name:'课次',exact:true}).fill('在线自动验收');
      await form.getByRole('textbox',{name:'班级',exact:true}).fill('独立测试上下文');
      await form.getByRole('checkbox',{name:'本次已实际发放 / 使用',exact:true}).check();
      await form.getByRole('button',{name:'保存记录',exact:true}).click();await form.waitFor({state:'hidden'});
      await page.getByRole('button',{name:'关闭选题篮',exact:true}).click();
      await page.getByRole('button',{name:'更多操作',exact:true}).click();
      const downloadPromise=page.waitForEvent('download');
      await page.getByRole('button',{name:'备份教学记录',exact:true}).click();
      const download=await downloadPromise, backupPath=path.join(output,channel+'-synthetic-records.json');await download.saveAs(backupPath);
      const backup=JSON.parse(fs.readFileSync(backupPath,'utf8'));assert.equal(backup.bankId,contract.bankId);assert.equal(backup.records.length,1);
      assert.equal(backup.records[0].lesson,'在线自动验收');
      // This is a fresh, isolated automated-test browser profile. No user's
      // browser storage or real teaching records are read or changed.
      await page.evaluate(id=>{for(const key of Object.keys(localStorage)){
        try{const value=JSON.parse(localStorage.getItem(key));if(Array.isArray(value)&&value.some(r=>r?.id===id))localStorage.removeItem(key);}catch{}
      }},backup.records[0].id);
      await page.reload();await page.locator('.result-count').waitFor();
      await page.getByRole('button',{name:'更多操作',exact:true}).click();
      const chooserPromise=page.waitForEvent('filechooser');await page.getByRole('button',{name:'恢复教学记录',exact:true}).click();
      await (await chooserPromise).setFiles(backupPath);
      await page.getByRole('status').filter({hasText:'已恢复 1 条记录'}).waitFor();
      const restored=await page.evaluate(id=>Object.keys(localStorage).flatMap(key=>{
        try{const value=JSON.parse(localStorage.getItem(key));return Array.isArray(value)?value.filter(r=>r?.id===id):[];}catch{return [];}
      }),backup.records[0].id);
      assert.equal(restored.length,1);assert.equal(restored[0].lesson,'在线自动验收');
      assert.equal(result.requests.filter(r=>/\/api\/records(?:$|\?)/.test(r.url)).length,0);
      return {saved:1,backedUp:1,restored:1,virtualRecordInterfaceStayedInBrowser:true};
    });
    await check('exam module regression',async()=>{
      await page.goto(base);await page.waitForFunction(()=>document.body.dataset.ready==='true');
      await page.getByRole('searchbox',{name:'搜索学校、试卷、篇目或考点',exact:true}).fill('第十七中学');
      await page.getByRole('button',{name:'搜索',exact:true}).click();
      const results=page.getByRole('region',{name:'搜索结果',exact:true});
      await results.getByRole('link',{name:'2026-2027 学年河北省石家庄市第十七中学八年级（上）期中语文试卷',exact:true}).click();
      await page.getByRole('button',{name:'关闭详情',exact:true}).waitFor();
      await page.getByRole('row',{name:'12 人物理解与塑造、人物形象 阅读',exact:true}).getByRole('button',{name:'阅读',exact:true}).click();
      const details=page.getByRole('dialog',{name:'原题与来源详情',exact:true});
      assert((await details.textContent()).includes('与战士同甘共苦'));
      assert((await details.textContent()).includes('地球上的红飘带'));
      const formalPapers=await page.evaluate(()=>KQ_V02_FACTS.papers.filter(p=>p.main_sample).length);
      assert.equal(formalPapers,146);return {formalPapers};
    });
    await check('no blocking JavaScript, CSP, missing core resource or offline Word request',async()=>{
      assert.deepEqual(result.pageErrors,[]);assert.deepEqual(result.csp,[]);assert.deepEqual(result.httpErrors,[]);
      const blocked=result.failedRequests.filter(r=>r.error!=='net::ERR_ABORTED');assert.deepEqual(blocked,[]);
      result.nonBlockingConsole=result.console.filter(x=>x.type==='error'&&
        x.location?.url===new URL('/favicon.ico',base).href&&/404/.test(x.text));
      const errors=result.console.filter(x=>x.type==='error'&&!result.nonBlockingConsole.includes(x));
      assert.deepEqual(errors,[]);
      assert.equal(result.requests.filter(r=>/Word(?:%E5%8E%9F|原版格式)|\/api\/records|\/bank\/catalog\.json/.test(r.url)).length,0);
    });
    result.passed=true;
  }catch(e){result.passed=false;result.error=e.stack;await page.screenshot({path:path.join(output,channel+'-failure.png'),fullPage:true}).catch(()=>{});
    fs.writeFileSync(path.join(output,channel+'-failure-UI.txt'),await page.locator('body').ariaSnapshot().catch(()=>''));
  }finally{await browser.close();fs.writeFileSync(path.join(output,channel+'.json'),JSON.stringify(result,null,2));}
  console.log(JSON.stringify({channel,passed:result.passed,checks:result.checks.map(x=>({name:x.name,passed:x.passed})),error:result.error}));
  return result;
}
(async()=>{
  let base=arg('--base');if(!base){hosted=await serve(path.resolve(arg('--site')||'_site'));base=hosted.base;}
  if(!base.endsWith('/'))base+='/';report.base=base;
  try{
    if(!process.argv.includes('--skip-resource-audit'))await step(report.checks,'all runtime bytes, all content shards and all image mappings',()=>verifyResources(base));
    report.browsers=await Promise.all(channels.map(c=>browserChecks(base,c)));
    assert(report.browsers.every(b=>b.passed),'One or more real browser acceptance checks failed');report.passed=true;
  }catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
  finally{hosted?.server.close();report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(report,null,2));}
})();
