/* Uses the existing session and CSRF wrapper from app.js. No separate login or data copy. */
(() => {
  const $ = (s) => document.querySelector(s), esc = escapeHtml;
  const dialog = $('#caseDialog'), edit = $('#caseEditForm'), filters = $('#caseFilters');
  const surfaceLabels = { body:'杯 / 瓶身曲面',front:'正面',back:'背面',left:'左侧',right:'右侧',top:'顶面 / 盖面',bottom:'底面' };
  for (let i=1;i<=20;i++) surfaceLabels[`face_${i}`] = `第 ${i} 面（示意面序）`;
  const modelSurfaces = { none:[],mug:['body','bottom'],taper:['body','bottom'],thermos:['body','top','bottom'],bottle:['body','top','bottom'],tin:['body','top','bottom'],box:['front','back','left','right','top','bottom'],organizer:['front','back','left','right','bottom'],bag:['front','back','left','right','bottom'],dice:Array.from({length:20},(_,i)=>`face_${i+1}`) };
  let options=null, optionsPromise=null, admin=false, current=null, selectedImage='', dirty=false;
  let page=1,total=0, listTicket=0, openTicket=0, quoteFilter='', viewer=null, viewerPromise=null, previewTicket=0;
  let cropImage=null, cropSource=null, cropStart=null, cropScale=1, busy=false;
  let disabledBefore=new Map();
  const message=(text='',error=false,id='#caseDialogMessage')=>{const el=$(id);el.textContent=text;el.className=`admin-message ${error?'error':''}`;};
  const changed=()=>{dirty=true;$('#caseDirty').textContent='有未保存的修改';};
  const assetUrl=(id)=>`/api/case-assets/${id}`;
  const imageSelected=()=>current?.images.find(i=>i.image_id===selectedImage);
  function setBusy(value) {
    busy=value;
    if(value){disabledBefore=new Map();dialog.querySelectorAll('button,input,select,textarea').forEach(el=>{disabledBefore.set(el,el.disabled);el.disabled=true;});}
    else {disabledBefore.forEach((disabled,el)=>{if(el.isConnected)el.disabled=disabled;});disabledBefore.clear();}
    $('#caseCropSave').disabled=value;
  }
  async function request(url,init) { const response=await apiFetch(url,init);const data=await response.json();if(!response.ok)throw new Error(data.error||'请求失败');return data; }
  async function loadOptions(force=false) {
    if(force){options=null;optionsPromise=null;}
    if(!optionsPromise)optionsPromise=request('/api/cases/options').then(data=>{options=data;return data;}).catch(e=>{optionsPromise=null;throw e;});
    await optionsPromise;
    const modelOptions=Object.entries(options.models).map(([k,v])=>`<option value="${esc(k)}">${esc(v)}</option>`).join('');
    if(!filters.elements.model.dataset.loaded){filters.elements.model.innerHTML='<option value="">全部类型</option>'+modelOptions;filters.elements.model.dataset.loaded='1';edit.elements.model.innerHTML=modelOptions;}
  }
  async function loadCases() {
    if(!sessionUser)return;
    const ticket=++listTicket;
    try {
      await loadOptions();const params=new URLSearchParams(new FormData(filters));params.set('page',page);
      if(quoteFilter)params.set('quoteKey',quoteFilter);
      const data=await request('/api/cases?'+params);
      if(ticket!==listTicket)return;total=data.total;
      $('#caseMeta').textContent=`${total} 个匹配案例${quoteFilter?' · 已按所选报价关联筛选':''}${admin?` ｜待整理 ${data.counts.draft} · 已启用 ${data.counts.enabled} · 已停用 ${data.counts.disabled}`:''}`;
      $('#casePage').textContent=`第 ${page} / ${Math.max(1,Math.ceil(total/24))} 页`;
      $('#casePrevious').disabled=page<=1;$('#caseNext').disabled=page*24>=total;
      $('#caseGrid').innerHTML=data.items.length?data.items.map(item=>{
        const image=item.images.find(i=>i.role==='reference')||item.images[0];
        const suppliers=[...new Set(item.links.map(l=>(l.quote||l.snapshot).supplier_name))].filter(Boolean).join(' / ');
        return `<article class="case-card ${item.status==='disabled'?'case-disabled':''}">${image?`<img class="case-card-image" loading="lazy" src="${esc(image.thumbnail)}" alt="${esc(item.title)}" />`:'<div class="case-card-image case-empty-image">暂无图片</div>'}<div class="case-card-content"><h3>${esc(item.title)}</h3><span class="status ${item.status==='enabled'?'direct':'review'}">${esc(options.statuses[item.status])}</span> <span class="muted">${esc(options.models[item.model_type])}</span><p>${esc(suppliers||'尚未关联报价')}</p><p class="muted">${item.skus.length} 个关联 SKU · ${item.images.filter(i=>i.role==='artwork').length} 张图案 · ${item.placements.length} 个区域</p>${item.linkStatus==='missing'?'<p class="admin-message error">关联记录已变化，需复核</p>':''}<button class="secondary-light-button case-open" type="button" data-open-case="${esc(item.case_id)}">${admin?'查看 / 管理':'查看案例'}</button></div></article>`;
      }).join(''):'<div class="case-empty">没有匹配的案例。'+(admin?'可导入供应商案例 Excel，或新增案例并关联报价。':'请调整搜索条件，或联系管理员启用案例。')+'</div>';
    }catch(e){if(ticket===listTicket)message(e.message,true,'#caseMessage');}
  }
  function populateQuotePick(){
    const query=$('#caseQuoteSearch').value.toLowerCase().trim();
    const choices=options.quotes.filter(q=>!current.links.some(l=>l.key===q.key)&&(!query||[q.sku,q.supplier,q.process,q.material,q.size,q.source].join(' ').toLowerCase().includes(query)));
    $('#caseQuotePick').innerHTML=choices.slice(0,100).map(q=>`<option value="${esc(q.key)}">${esc([q.supplier,q.sku,q.process,q.size||'无定制尺寸',q.quoteId].join(' · '))}</option>`).join('')||'<option value="">没有匹配记录</option>';
  }
  function renderLinks(){
    $('#caseLinkStatus').textContent=current.links.some(l=>l.missing)?'关联需复核':`${current.links.length} 条报价`;
    $('#caseLinks').innerHTML=current.links.map((link,index)=>{const q=link.quote||link.snapshot;
      const rule=q.dimensionRule;
      const rows=[['SKU',q.sku],['工艺',q.process_raw],['材质',q.material],['产品尺寸',q.product_size_raw],['定制尺寸',q.custom_size_raw],['参考价格',q.price_raw],['文件要求',q.file_requirement],['注意事项',q.note],['来源',q.source]];
      if(rule)rows.push(['尺寸复核',`${rule.review_status} · ${rule.parse_note||''}`]);
      for(const r of q.supplierRules||[])rows.push(['供应商规则',`${r.status}：${r.text}`]);
      return `<div class="case-link-card"><div class="case-link-actions"><strong>${esc(q.supplier_name||q.supplier||'供应商')} · ${esc(q.quote_id||q.quoteId||'报价')}</strong>${admin?`<button type="button" class="text-button" data-unlink="${index}">解除关联</button>`:''}</div>${link.missing?'<p class="admin-message error">当前数据中已找不到此记录。下方为原关联快照，请重新关联。</p>':''}<dl>${rows.map(([a,b])=>`<dt>${a}</dt><dd>${esc(b||'—')}</dd>`).join('')}</dl></div>`;
    }).join('')||'<p class="muted">尚未关联报价。添加后会自动显示供应商、SKU、工艺与尺寸原文。</p>';
    populateQuotePick();
  }
  function renderImages(){
    if(!imageSelected())selectedImage=current.images[0]?.image_id||'';
    const selected=imageSelected();
    $('#caseOriginal').innerHTML=selected?`<a href="${esc(selected.url)}" target="_blank" rel="noopener"><img src="${esc(selected.url)}" alt="${esc(selected.label||current.title)}" /></a>`:'<span class="muted">保存案例后可上传参考图和图案素材</span>';
    $('#caseImages').innerHTML=current.images.map(im=>`<button class="case-thumb" type="button" data-image="${esc(im.image_id)}" aria-pressed="${im.image_id===selectedImage}"><img src="${esc(im.thumbnail)}" alt="${esc(im.label)}" />${im.role==='artwork'?'图案素材':'参考图'}</button>`).join('');
    $('#caseCropOpen').disabled=!selected;$('#caseImageRemove').disabled=!selected;$('#caseUpload').disabled=!current.case_id;
  }
  function renderPlacements(){
    const fields=[['widthMm','图案宽 mm',.1,2000],['heightMm','图案高 mm',.1,2000],['x',current.model_type==='dice'?'水平偏移 mm':'水平 mm / 曲面角度 °',-180,180],['y','垂直偏移 mm',-100,100],['rotation','图案旋转 °',-180,180]];
    const surfaces=modelSurfaces[edit.elements.model.value]||[];
    $('#casePlacements').innerHTML=current.placements.map((p,i)=>`<div class="case-placement" data-placement="${i}"><div class="case-placement-head"><strong>区域 ${i+1}</strong>${admin?`<button class="text-button" type="button" data-remove-placement="${i}">移除区域</button>`:''}</div><div class="case-placement-fields"><label><span>区域名称</span><input data-p-field="name" value="${esc(p.name)}" maxlength="80" ${admin?'':'disabled'} /></label><label><span>所在表面</span><select data-p-field="surface" ${admin?'':'disabled'}>${[...new Set([...surfaces,p.surface])].map(s=>`<option value="${esc(s)}" ${p.surface===s?'selected':''}>${esc(surfaceLabels[s]||s)}${surfaces.includes(s)?'':'（当前模型不支持）'}</option>`).join('')}</select></label><label><span>该区域工艺</span><input data-p-field="process" value="${esc(p.process)}" maxlength="100" placeholder="热转印 / 水晶标 / 雕刻…" ${admin?'':'disabled'} /></label><label><span>绑定图案</span><select data-p-field="artworkId" ${admin?'':'disabled'}><option value="">暂不指定图案</option>${current.images.filter(im=>im.role==='artwork').map(im=>`<option value="${esc(im.asset_id)}" ${p.artworkId===im.asset_id?'selected':''}>${esc(im.label)} · ${im.width}×${im.height}</option>`).join('')}</select></label>${fields.map(([key,label,min,max])=>`<label><span>${label}</span><input type="number" step="0.1" min="${min}" max="${max}" data-p-field="${key}" value="${esc(p[key])}" ${admin?'':'disabled'} /></label>`).join('')}</div></div>`).join('')||'<p class="muted">暂无定制区域。选择模型后可添加多个面，并分别指定图案。</p>';
  }
  function dimensionFields(){return options.modelDimensions[current.model_type]||[];}
  function effectiveDimensions(){return Object.fromEntries(dimensionFields().map(f=>[f.key,Object.hasOwn(current.model_dimensions||{},f.key)?current.model_dimensions[f.key]:f.default]));}
  function dimensionSummary(){
    const fields=dimensionFields(), d=effectiveDimensions();
    const valid=fields.every(f=>Number.isFinite(d[f.key])&&d[f.key]>=f.min&&d[f.key]<=f.max);
    $('#caseDimensionState').textContent=Object.keys(current.model_dimensions||{}).length?(admin?'已填写模型尺寸 · 修改后请保存案例':'案例记录的模型尺寸（只读）'):'当前为示例尺寸，尚未填写实物尺寸';
    $('#caseDimensionSummary').textContent=!fields.length?'':valid?`${options.models[current.model_type]} · ${fields.map(f=>`${f.label} ${d[f.key]} mm`).join(' · ')}`:'请填写 1–2000 mm 的有效尺寸；预览暂时保留上次有效模型。';
    return valid;
  }
  function renderDimensions(){
    const fields=dimensionFields(), d=effectiveDimensions();
    $('#caseModelSize').hidden=!fields.length;
    $('#caseDimensions').innerHTML=fields.map(f=>`<label><span>${esc(f.label)} mm</span><input type="number" form="caseEditForm" data-dimension="${esc(f.key)}" value="${d[f.key]}" min="${f.min}" max="${f.max}" step="0.1" required ${admin?'':'disabled'} /></label>`).join('');
    const help={mug:'直径不含杯柄，杯柄随杯身等比调整。',taper:'杯口和杯底外径分别控制锥度。',bag:'高度不含提手，提手随袋身调整。',dice:'外接球直径指包住骰子各顶点的球直径，不是面宽或对面距离。'};
    $('#caseDimensionHelp').textContent=(help[current.model_type]||'')+'单位为毫米，1 cm = 10 mm。输入后实时更新；不自动采用报价中的定制尺寸作为产品尺寸。';
    dimensionSummary();
  }
  async function updatePreview(){
    const ticket=++previewTicket;
    if(!current||!dialog.open)return;
    $('#casePreviewNote').textContent='鼠标拖拽旋转，滚轮缩放；改尺寸时保持观察距离，可点“适应视图”看全模型。尺寸线标注模型，不是图案。结构仍为示意，裁剪素材不是生产原稿。'+(current.model_type==='dice'?'骰子面序为示意编号，必须与工厂模板核对。':'');
    $('#casePreviewWarnings').hidden=true;
    if(!dimensionSummary())return;
    try{
      if(current.model_type==='none') {viewer?.dispose();viewer=null;$('#caseViewer').innerHTML='<div class="case-viewer-empty">该案例暂未选择 3D 模型，可先查看原图和关联数据。</div>';return;}
      if(!viewerPromise)viewerPromise=import('/case-viewer.js?v=20260831-dimensions').catch(e=>{viewerPromise=null;throw e;});
      const module=await viewerPromise;if(ticket!==previewTicket||!dialog.open)return;
      if(!viewer)viewer=module.createCaseViewer($('#caseViewer'));
      const warnings=await viewer.update(current.model_type,current.placements,current.images,effectiveDimensions());
      if(ticket!==previewTicket||!dialog.open)return;
      $('#casePreviewWarnings').textContent=(warnings||[]).join('\n');$('#casePreviewWarnings').hidden=!warnings?.length;
    }catch(e){if(ticket!==previewTicket)return;viewer?.dispose();viewer=null;$('#caseViewer').textContent='3D 暂不可用，图片和关联数据仍可查看。';message('3D 预览未能加载：'+e.message,true);}
  }
  function renderDetail(){
    $('#caseDialogTitle').textContent=current.title||'新增案例';$('#caseIdentity').textContent=current.case_id?`${current.case_id} · 版本 ${current.version}`:'新案例';
    for(const [key,value] of Object.entries({title:current.title,status:current.status,model:current.model_type,skuTags:current.sku_tags.join(', '),note:current.note}))edit.elements[key].value=value;
    document.querySelectorAll('[data-case-admin]').forEach(el=>el.hidden=!admin);
    edit.querySelectorAll('[data-case-edit]').forEach(el=>el.disabled=!admin);
    $('#caseSource').textContent=`来源：${current.source||'手工创建'}${current.updated_by?' ｜最近修改：'+current.updated_by+' · '+current.updated_at:''}`;
    renderLinks();renderImages();renderPlacements();renderDimensions();updatePreview();
    dirty=false;$('#caseDirty').textContent='修改后请保存';
  }
  async function openCase(id){
    const ticket=++openTicket;
    try{await loadOptions(true);const data=id?await request('/api/cases/'+encodeURIComponent(id)):{case_id:'',version:0,title:'',status:'draft',model_type:'none',sku_tags:[],links:[],placements:[],images:[],note:'',source:''};
      if(ticket!==openTicket)return;current=data;selectedImage='';message();if(!dialog.open)dialog.showModal();renderDetail();
    }catch(e){message(e.message,true,'#caseMessage');}
  }
  function closeDialog(){if(busy)return;if(dirty&&!window.confirm('还有未保存的修改，关闭后将丢弃。确定关闭？'))return;previewTicket++;openTicket++;viewer?.dispose();viewer=null;dialog.close();current=null;}
  function payload(){return {caseId:current.case_id||undefined,version:current.version,title:edit.elements.title.value,status:edit.elements.status.value,model:edit.elements.model.value,modelDimensions:current.model_dimensions||{},skuTags:edit.elements.skuTags.value.split(/[,，、;；\s]+/).filter(Boolean),quoteKeys:current.links.map(l=>l.key),placements:current.placements,note:edit.elements.note.value};}
  async function saveCurrent(){
    if(!edit.reportValidity())throw new Error('请检查案例名称和区域参数');
    current=await postJson('/api/admin/cases/save',payload());renderDetail();message('案例、图案与数据关联已保存');loadCases();
  }
  async function beforeImageChange(){if(dirty)await saveCurrent();if(!current.case_id)throw new Error('请先填写案例名称并保存，再添加图片');}
  async function runAction(work){if(busy)return;setBusy(true);message();try{await work();}catch(e){message(e.message,true);}finally{setBusy(false);if(current)renderImages();}}
  function initializeCases(){admin=sessionUser?.role==='admin';document.querySelectorAll('[data-case-admin]').forEach(el=>el.hidden=!admin);if(!$('#casesTab').hidden)loadCases();}
  window.addEventListener('cases:session',initializeCases);window.addEventListener('cases:activate',loadCases);
  if(sessionUser)initializeCases();
  filters.addEventListener('submit',e=>{e.preventDefault();page=1;loadCases();});
  $('#caseClear').addEventListener('click',()=>{filters.reset();quoteFilter='';page=1;message('',false,'#caseMessage');loadCases();});
  $('#casePrevious').addEventListener('click',()=>{page--;loadCases();});$('#caseNext').addEventListener('click',()=>{page++;loadCases();});
  $('#caseGrid').addEventListener('click',e=>{const b=e.target.closest('[data-open-case]');if(b)openCase(b.dataset.openCase);});
  document.addEventListener('click',e=>{const b=e.target.closest('[data-case-quote]');if(!b)return;quoteFilter=b.dataset.caseQuote;filters.reset();page=1;activateTab('cases');});
  $('#caseNew').addEventListener('click',()=>openCase());$('#caseClose').addEventListener('click',closeDialog);dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
  edit.addEventListener('submit',e=>{e.preventDefault();runAction(saveCurrent);});
  edit.addEventListener('input',e=>{if(!admin)return;changed();const field=e.target.dataset.pField;
    if(field){const p=current.placements[Number(e.target.closest('[data-placement]').dataset.placement)];p[field]=['widthMm','heightMm','x','y','rotation'].includes(field)?Number(e.target.value):e.target.value;updatePreview();}
  });
  edit.elements.model.addEventListener('change',()=>{current.model_type=edit.elements.model.value;current.model_dimensions={};renderPlacements();renderDimensions();changed();updatePreview();});
  $('#caseDimensions').addEventListener('input',e=>{if(!admin||busy||!e.target.dataset.dimension)return;current.model_dimensions={...effectiveDimensions(),[e.target.dataset.dimension]:e.target.value===''?null:Number(e.target.value)};changed();updatePreview();});
  $('#caseDimensionReset').addEventListener('click',()=>{if(!admin||busy)return;current.model_dimensions={};renderDimensions();changed();updatePreview();});
  $('#caseQuoteSearch').addEventListener('input',populateQuotePick);
  $('#caseLinkAdd').addEventListener('click',()=>{const q=options.quotes.find(q=>q.key===$('#caseQuotePick').value);if(!q)return;
    // Full data is fetched when the association is saved; show available fields immediately.
    current.links.push({key:q.key,missing:false,snapshot:{supplier_name:q.supplier,sku:q.sku,process_raw:q.process,material:q.material,custom_size_raw:q.size,source:q.source,quote_id:q.quoteId}});renderLinks();changed();});
  $('#caseLinks').addEventListener('click',e=>{const b=e.target.closest('[data-unlink]');if(!b)return;current.links.splice(Number(b.dataset.unlink),1);renderLinks();changed();});
  $('#casePlacementAdd').addEventListener('click',()=>{const surfaces=modelSurfaces[current.model_type];if(!surfaces.length)return message('请先选择一个 3D 模型，再添加区域',true);if(current.placements.length>=24)return message('最多设置 24 个区域',true);
    current.placements.push({name:`定制区域 ${current.placements.length+1}`,surface:surfaces[0],process:(current.links[0]?.quote||current.links[0]?.snapshot)?.process_raw||'',artworkId:current.images.find(i=>i.role==='artwork')?.asset_id||'',widthMm:45,heightMm:30,x:0,y:0,rotation:0});renderPlacements();changed();updatePreview();});
  $('#casePlacements').addEventListener('click',e=>{const b=e.target.closest('[data-remove-placement]');if(!b)return;current.placements.splice(Number(b.dataset.removePlacement),1);renderPlacements();changed();updatePreview();});
  $('#caseImages').addEventListener('click',e=>{const b=e.target.closest('[data-image]');if(b){selectedImage=b.dataset.image;renderImages();}});
  $('#caseUpload').addEventListener('change',e=>{const file=e.target.files[0];if(!file)return;runAction(async()=>{await beforeImageChange();if(file.size>12*1024*1024)throw new Error('图片不能超过 12 MB');const p=new URLSearchParams({caseId:current.case_id,version:current.version,role:$('#caseImageRole').value,label:file.name.slice(0,160)});current=await request('/api/admin/cases/upload?'+p,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});selectedImage=current.images.at(-1)?.image_id||'';renderDetail();message('图片已上传并关联当前案例');loadCases();});e.target.value='';});
  $('#caseImageRemove').addEventListener('click',()=>runAction(async()=>{const im=imageSelected();if(!im)return;if(!window.confirm('移除此案例中的图片关联？原工作簿不会改变。'))return;await beforeImageChange();current=await postJson('/api/admin/cases/remove-image',{caseId:current.case_id,version:current.version,imageId:im.image_id});renderDetail();message('图片关联已移除');loadCases();}));
  $('#caseViewReset').addEventListener('click',()=>viewer?.reset());
  $('#caseImportOpen').addEventListener('click',()=>$('#caseImportZone').hidden=!$('#caseImportZone').hidden);
  $('#caseImportRun').addEventListener('click',async()=>{const file=$('#caseImportFile').files[0];if(!file)return message('请选择供应商原始工作簿',true,'#caseMessage');if(file.size>150*1024*1024||!file.name.toLowerCase().endsWith('.xlsx'))return message('请选择 150 MB 以内的 .xlsx 文件',true,'#caseMessage');const button=$('#caseImportRun');button.disabled=true;message('正在导入图片与关联数据，请稍候…',false,'#caseMessage');try{const result=await request('/api/admin/cases/import?'+new URLSearchParams({filename:file.name}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});message(`导入完成：新增 ${result.created} 个案例，关联报价 ${result.linked} 个，待关联 ${result.unlinked} 个，跳过已存在 ${result.skipped} 个。${result.warnings.length?' 有 '+result.warnings.length+' 项需复核：'+result.warnings.slice(0,3).join('；'):''}`,false,'#caseMessage');page=1;await loadCases();}catch(e){message(e.message,true,'#caseMessage');}finally{button.disabled=false;}});
  const cropCanvas=$('#caseCropCanvas'), ctx=cropCanvas.getContext('2d');
  const cropInputs=['#cropLeft','#cropTop','#cropWidth','#cropHeight'].map($);
  function cropRect(){return cropInputs.map(el=>Number(el.value));}
  function drawCrop(){if(!cropImage)return;ctx.clearRect(0,0,cropCanvas.width,cropCanvas.height);ctx.drawImage(cropImage,0,0,cropCanvas.width,cropCanvas.height);const [x,y,w,h]=cropRect();ctx.fillStyle='rgba(15,23,42,.3)';ctx.fillRect(0,0,cropCanvas.width,cropCanvas.height);if(w>0&&h>0){ctx.save();ctx.beginPath();ctx.rect(x*cropScale,y*cropScale,w*cropScale,h*cropScale);ctx.clip();ctx.drawImage(cropImage,0,0,cropCanvas.width,cropCanvas.height);ctx.restore();ctx.strokeStyle='#00a99c';ctx.lineWidth=2;ctx.strokeRect(x*cropScale,y*cropScale,w*cropScale,h*cropScale);}}
  $('#caseCropOpen').addEventListener('click',()=>runAction(async()=>{await beforeImageChange();cropSource=imageSelected();if(!cropSource)return;cropImage=new Image();cropImage.src=cropSource.url;await cropImage.decode();cropScale=Math.min(1,740/cropImage.naturalWidth,520/cropImage.naturalHeight);cropCanvas.width=Math.round(cropImage.naturalWidth*cropScale);cropCanvas.height=Math.round(cropImage.naturalHeight*cropScale);[0,0,cropImage.naturalWidth,cropImage.naturalHeight].forEach((v,i)=>cropInputs[i].value=v);message('',false,'#caseCropMessage');$('#caseCropDialog').showModal();drawCrop();}));
  const cropPoint=e=>{const rect=cropCanvas.getBoundingClientRect();return {x:Math.max(0,Math.min(cropImage.naturalWidth,Math.round((e.clientX-rect.left)/rect.width*cropImage.naturalWidth))),y:Math.max(0,Math.min(cropImage.naturalHeight,Math.round((e.clientY-rect.top)/rect.height*cropImage.naturalHeight)))};};
  cropCanvas.addEventListener('pointerdown',e=>{if(!cropImage||e.button!==0)return;cropStart=cropPoint(e);cropCanvas.setPointerCapture(e.pointerId);});
  cropCanvas.addEventListener('pointermove',e=>{if(!cropStart)return;const p=cropPoint(e);[Math.min(p.x,cropStart.x),Math.min(p.y,cropStart.y),Math.abs(p.x-cropStart.x),Math.abs(p.y-cropStart.y)].forEach((v,i)=>cropInputs[i].value=v);drawCrop();});
  for(const event of ['pointerup','pointercancel','lostpointercapture'])cropCanvas.addEventListener(event,()=>cropStart=null);
  cropInputs.forEach(el=>el.addEventListener('input',drawCrop));$('#caseCropClose').addEventListener('click',()=>{if(!busy)$('#caseCropDialog').close();});$('#caseCropDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  $('#caseCropSave').addEventListener('click',async()=>{if(busy)return;setBusy(true);try{const [left,top,width,height]=cropRect();current=await postJson('/api/admin/cases/crop',{caseId:current.case_id,version:current.version,imageId:cropSource.image_id,left,top,width,height,label:'裁剪图案 · '+cropSource.label});selectedImage=current.images.at(-1)?.image_id||'';$('#caseCropDialog').close();renderDetail();message('图案已裁出，原图保留。可在定制区域中选择该素材。');loadCases();}catch(e){message(e.message,true,'#caseCropMessage');}finally{setBusy(false);}});
  window.addEventListener('beforeunload',e=>{if(dirty&&dialog.open){e.preventDefault();e.returnValue='';}});
})();
