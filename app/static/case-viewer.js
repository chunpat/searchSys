import * as T from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { RoomEnvironment } from './vendor/three/RoomEnvironment.js';

// World coordinates are millimetres. Details remain template geometry, not production CAD.
export function createCaseViewer(host) {
  host.replaceChildren();
  const renderer=new T.WebGLRenderer({antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.outputColorSpace=T.SRGBColorSpace;
  renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  const canvas=renderer.domElement;canvas.setAttribute('aria-label','拖拽旋转模型，滚轮缩放');host.appendChild(canvas);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(34,1,.3,3000);
  const controls=new OrbitControls(camera,canvas);controls.enableDamping=false;controls.minDistance=55;controls.maxDistance=1000;controls.enablePan=false;
  const pmrem=new T.PMREMGenerator(renderer),room=new RoomEnvironment(),environment=pmrem.fromScene(room,.04);
  scene.environment=environment.texture;scene.environmentIntensity=.65;pmrem.dispose();room.dispose();
  scene.add(new T.HemisphereLight(0xffffff,0x6b8295,1.7));
  const key=new T.DirectionalLight(0xfff4e5,2.1);key.position.set(-130,230,160);key.castShadow=true;key.shadow.mapSize.set(1024,1024);
  Object.assign(key.shadow.camera,{left:-190,right:190,top:190,bottom:-190,near:1,far:700});key.shadow.normalBias=.2;scene.add(key);
  const fill=new T.DirectionalLight(0xdceeff,1);fill.position.set(140,90,-120);scene.add(fill);
  const ground=new T.Mesh(new T.PlaneGeometry(1500,1500),new T.ShadowMaterial({opacity:.17}));ground.rotation.x=-Math.PI/2;ground.position.y=-.3;ground.receiveShadow=true;scene.add(ground);
  const grid=new T.GridHelper(300,30,0xaab9c4,0xaab9c4);grid.position.y=-.2;grid.material.transparent=true;grid.material.opacity=.15;scene.add(grid);
  let group=null,labels=new T.Group(),measurements=new T.Group(),regions={},sphere=new T.Sphere(),model='',dimensionKey='',ticket=0,dead=false;
  let dimensionTags=[];
  const textures=new Map();scene.add(labels,measurements);
  const vector=(v)=>new T.Vector3(...v);
  function mat(color,opts={}){return new T.MeshPhysicalMaterial({color,roughness:.45,metalness:.02,clearcoat:.15,...opts});}
  function mesh(g,m,x=0,y=0,z=0){const o=new T.Mesh(g,m);o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;group.add(o);return o;}
  function lathe(points,m){return mesh(new T.LatheGeometry(points.map(p=>new T.Vector2(...p)),96),m);}
  function round(w,d,r,cx=0,cy=0){const p=new T.Shape(),x=-w/2+cx,y=-d/2+cy;p.moveTo(x+r,y);p.lineTo(x+w-r,y);p.quadraticCurveTo(x+w,y,x+w,y+r);p.lineTo(x+w,y+d-r);p.quadraticCurveTo(x+w,y+d,x+w-r,y+d);p.lineTo(x+r,y+d);p.quadraticCurveTo(x,y+d,x,y+d-r);p.lineTo(x,y+r);p.quadraticCurveTo(x,y,x+r,y);return p;}
  function extrude(shape,height,m,y,bevel){const g=new T.ExtrudeGeometry(shape,{depth:height,steps:1,bevelEnabled:true,bevelSize:bevel,bevelThickness:bevel,bevelSegments:4,curveSegments:20});g.rotateX(-Math.PI/2);return mesh(g,m,0,y,0);}
  function tube(points,r,m){return mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(vector)),60,r,12,false),m);}
  function plane(id,o,u,v,w,h){u=vector(u);v=vector(v);regions[id]={type:'plane',o:vector(o),u,v,n:new T.Vector3().crossVectors(u,v).normalize(),w,h};}
  function curve(r,y0,y1,limits=null){regions.body={type:'curve',radius:r,y0,y1,limits};}
  function cap(id,y,r,up=true){plane(id,[0,y,0],[1,0,0],up?[0,0,-1]:[0,0,1],(r-3)*1.4,(r-3)*1.4);}
  function sides(w,d,h,y=0,margin=5){plane('front',[0,y+h/2,d/2+.14],[1,0,0],[0,1,0],w-2*margin,h-2*margin);plane('right',[w/2+.14,y+h/2,0],[0,0,-1],[0,1,0],d-2*margin,h-2*margin);plane('back',[0,y+h/2,-d/2-.14],[-1,0,0],[0,1,0],w-2*margin,h-2*margin);plane('left',[-w/2-.14,y+h/2,0],[0,0,1],[0,1,0],d-2*margin,h-2*margin);}
  function disposeGroup(g){if(!g)return;const mats=new Set();g.traverse(o=>{o.geometry?.dispose();if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>mats.add(m));});mats.forEach(m=>{if(m.userData.numberTexture)m.map.dispose();m.dispose();});scene.remove(g);}
  function makeModel(id,d){
    const sameModel=model===id,previousCenter=sphere.center.clone();
    disposeGroup(group);group=new T.Group();regions={};scene.add(group);model=id;
    if(id==='mug'){
      const m=mat(0xe6dccc,{roughness:.25,clearcoat:.35});lathe([[0,0],[29,0],[31.5,1],[32,3],[32,86],[31.5,88],[29.5,88],[29,86],[29,6],[27,4],[0,4]],m);
      tube([[31,69,0],[49,73,0],[58,62,0],[59,47,0],[51,29,0],[31,25,0]],4.1,m);curve(()=>32,9,79,[-225,45]);cap('bottom',-.14,27,false);
    }else if(id==='taper'){
      const m=mat(0xc77f68),h=d.height,b=d.bottomDiameter/2,t=d.topDiameter/2,wall=Math.min(b,t)*.075;
      lathe([[0,0],[b,0],[t,h],[t-wall,h],[b-wall,h*.06],[0,h*.04]],m);
      curve(y=>b+(t-b)*y/h,h*.09,h*.89);plane('bottom',[0,-.001*h,0],[1,0,0],[0,0,1],b,b);
    }else if(id==='thermos'){
      const m=mat(0x426b77,{metalness:.2});lathe([[0,0],[25,0],[28,3],[29,7],[29,122],[27,127],[24,129],[24,138],[0,138]],m);mesh(new T.CylinderGeometry(29,29,22,80),mat(0x203a43),0,143,0);mesh(new T.CylinderGeometry(29.2,29.2,2,80),mat(0xc3cbd0,{metalness:.7}),0,133,0);curve(()=>29,10,117);cap('top',154.15,27);cap('bottom',-.14,25,false);
    }else if(id==='bottle'){
      lathe([[0,0],[26,0],[29,2],[30,6],[30,95],[29,101],[25,111],[17,120],[14,123],[14,137],[0,137]],mat(0x719589,{roughness:.32}));mesh(new T.CylinderGeometry(16,16,14,64),mat(0x203a43),0,141,0);curve(()=>30,10,94);cap('top',148.15,14);cap('bottom',-.14,25,false);
    }else if(id==='tin'){
      lathe([[0,0],[36,0],[38,2],[38,4],[37,5],[37,71],[38,72],[38,77],[36,78],[0,78]],mat(0xb3bdc8,{metalness:.55}));curve(()=>37,8,68);cap('top',78.15,34);cap('bottom',-.14,34,false);
    }else if(id==='box'){
      extrude(round(98.4,70.4,2.2),76.4,mat(0x697f9e),.8,.8);sides(100,72,76.4,.8,4);plane('top',[0,78.14,0],[1,0,0],[0,0,-1],90,62);plane('bottom',[0,-.14,0],[1,0,0],[0,0,1],90,62);
    }else if(id==='organizer'){
      const m=mat(0x3f8692);extrude(round(118.4,78.4,9.2),2,m,.8,.8);const shape=round(118.4,78.4,9.2);shape.holes.push(round(68,68,7,-20,0),round(32,31,6,35.5,-18.5),round(32,31,6,35.5,18.5));extrude(shape,35.4,m,3.8,.8);sides(120,80,36,3,11);plane('bottom',[0,-.14,0],[1,0,0],[0,0,1],96,56);
    }else if(id==='bag'){
      const m=mat(0xc39a63,{roughness:.88});extrude(round(83,35,1),1.6,m,.3,.3);const shape=round(83,35,1);shape.holes.push(round(79.5,31.5,.8));extrude(shape,103.5,m,2.2,.3);for(const z of [-12,12])tube([[-22,103,z],[-22,122,z],[-12,132,z],[12,132,z],[22,122,z],[22,103,z]],1.7,mat(0x203a43));sides(83.6,35.6,100,3,5);plane('bottom',[0,-.14,0],[1,0,0],[0,0,1],73,25);
    }else if(id==='dice'){
      const g=new T.IcosahedronGeometry(48,0);g.translate(0,48,0);mesh(g,mat(0x87543f,{roughness:.3,flatShading:true}));
      const pos=g.getAttribute('position');
      for(let i=0;i<20;i++){
        const a=new T.Vector3().fromBufferAttribute(pos,i*3),b=new T.Vector3().fromBufferAttribute(pos,i*3+1),c=new T.Vector3().fromBufferAttribute(pos,i*3+2);
        const center=a.clone().add(b).add(c).divideScalar(3),u=b.clone().sub(a).normalize(),n=b.clone().sub(a).cross(c.clone().sub(a)).normalize(),v=new T.Vector3().crossVectors(n,u).normalize();
        const h=Math.abs(a.clone().sub(center).dot(v)),size=h*Math.SQRT2-1;
        regions[`face_${i+1}`]={type:'plane',o:center.clone().addScaledVector(n,.16),u,v,n,w:size,h:size};
        const cv=document.createElement('canvas');cv.width=96;cv.height=96;const cx=cv.getContext('2d');cx.fillStyle='#ffe2a1';cx.font='500 65px sans-serif';cx.textAlign='center';cx.textBaseline='middle';cx.fillText(String(i+1),48,48);const tex=new T.CanvasTexture(cv);tex.colorSpace=T.SRGBColorSpace;
        const nm=new T.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false});nm.userData.numberTexture=true;const number=mesh(new T.PlaneGeometry(6,6),nm);number.position.copy(center).lerp(c,.6).addScaledVector(n,.2);number.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(u,v,n));
      }
    }
    const base={mug:[64,88],thermos:[58,154],bottle:[60,148],tin:[76,78],box:[100,78,72],organizer:[120,40,80],bag:[83.6,106,35.6],dice:[96,96]};
    let scale=new T.Vector3(1,1,1);
    if(id==='dice')scale.setScalar(d.diameter/96);
    else if(base[id]){const [w,h,depth]=base[id];scale.set((d.width||d.diameter)/w,d.height/h,depth?d.depth/depth:d.diameter/w);}
    group.scale.copy(scale);
    for(const r of Object.values(regions)){
      if(r.type==='plane'){
        r.o.multiply(scale);r.u.multiply(scale);r.v.multiply(scale);r.w*=r.u.length();r.h*=r.v.length();r.u.normalize();r.v.normalize();r.n.crossVectors(r.u,r.v).normalize();
      }else{const radius=r.radius;r.radius=y=>radius(y/scale.y)*scale.x;r.y0*=scale.y;r.y1*=scale.y;}
    }
    group.updateMatrixWorld(true);sphere=new T.Box3().setFromObject(group).getBoundingSphere(new T.Sphere());
    const span=Math.max(sphere.radius*2,1),lightScale=span/160;
    key.position.set(-130*lightScale,230*lightScale,160*lightScale);
    Object.assign(key.shadow.camera,{left:-span,right:span,top:span,bottom:-span,near:.01,far:span*6});key.shadow.camera.updateProjectionMatrix();
    ground.scale.setScalar(Math.max(1,span/150));grid.scale.setScalar(Math.max(1,10**Math.floor(Math.log10(span/100))));
    camera.near=Math.max(.001,span/10000);camera.far=Math.max(3000,span*100);camera.updateProjectionMatrix();
    controls.minDistance=Math.max(.5,sphere.radius*.3);controls.maxDistance=Math.max(1000,span*20);
    makeMeasurements(id,d);
    if(sameModel){const delta=sphere.center.clone().sub(previousCenter);controls.target.copy(sphere.center);camera.position.add(delta);controls.update();render();}
    else reset();
  }
  function makeMeasurements(id,d){
    disposeGroup(measurements);measurements=new T.Group();scene.add(measurements);dimensionTags.forEach(t=>t.el.remove());dimensionTags=[];
    const width=d.width||Math.max(d.diameter||0,d.topDiameter||0,d.bottomDiameter||0),height=d.height||d.diameter,depth=d.depth||width;
    const gap=Math.max(width,height,depth)*.14,tick=gap*.14;
    const material=new T.LineBasicMaterial({color:0x378780,transparent:true,opacity:.8,depthTest:false});
    function dimension(a,b,axis,text){
      const start=vector(a),end=vector(b),v=vector(axis).multiplyScalar(tick);
      const points=[start,end,start.clone().sub(v),start.clone().add(v),end.clone().sub(v),end.clone().add(v)];
      const line=new T.LineSegments(new T.BufferGeometry().setFromPoints(points),material);line.renderOrder=5;measurements.add(line);
      const el=document.createElement('span');el.className='case-dimension-label';el.textContent=text;host.appendChild(el);
      dimensionTags.push({el,position:start.clone().add(end).multiplyScalar(.5)});
    }
    if(id==='taper'){
      dimension([-d.topDiameter/2,height+gap,0],[d.topDiameter/2,height+gap,0],[0,1,0],`口径 ${d.topDiameter} mm`);
      dimension([-d.bottomDiameter/2,0,depth/2+gap],[d.bottomDiameter/2,0,depth/2+gap],[0,0,1],`底径 ${d.bottomDiameter} mm`);
    }else dimension([-width/2,0,depth/2+gap],[width/2,0,depth/2+gap],[0,0,1],`${d.width?'宽':id==='dice'?'外接球 Ø':'Ø'} ${width} mm`);
    if(id!=='dice')dimension([-width/2-gap,0,depth/2],[-width/2-gap,height,depth/2],[1,0,0],`${id==='bag'?'袋身高':'高'} ${height} mm`);
    if(d.depth)dimension([width/2+gap,0,-depth/2],[width/2+gap,0,depth/2],[1,0,0],`深 ${depth} mm`);
  }
  function render(){if(!dead&&host.clientWidth&&host.clientHeight){renderer.render(scene,camera);dimensionTags.forEach(({el,position})=>{const point=position.clone().project(camera);el.hidden=point.z>1||point.z< -1||Math.abs(point.x)>1||Math.abs(point.y)>1;el.style.left=`${(point.x+1)*host.clientWidth/2}px`;el.style.top=`${(1-point.y)*host.clientHeight/2}px`;});}}
  function reset(){if(!group)return;const distance=sphere.radius/Math.sin(T.MathUtils.degToRad(17))/Math.min(1,camera.aspect)*1.4;controls.target.copy(sphere.center);const direction=regions.body?new T.Vector3(.2,.6,1.8):new T.Vector3(1,.65,1.5);camera.position.copy(sphere.center).add(direction.normalize().multiplyScalar(distance));controls.update();render();}
  controls.addEventListener('change',render);
  function fit(){const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h,false);reset();}
  const resize=new ResizeObserver(fit);resize.observe(host);
  async function texture(id){
    if(!textures.has(id))textures.set(id,new T.TextureLoader().loadAsync(`/api/case-assets/${id}?thumbnail=1`).then(t=>{if(dead){t.dispose();throw new Error('预览已关闭');}t.colorSpace=T.SRGBColorSpace;t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());return t;}).catch(e=>{textures.delete(id);throw e;}));
    return textures.get(id);
  }
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  function label(p,r,map,index,warnings){
    const angle=T.MathUtils.degToRad(p.rotation),cos=Math.cos(angle),sin=Math.sin(angle),c=Math.abs(cos),s=Math.abs(sin);
    let width=p.widthMm,height=p.heightMm,geometry,position,quaternion;
    const maxW=r.type==='plane'?r.w:Math.min(r.radius(r.y0),r.radius(r.y1))*(r.limits?(r.limits[1]-r.limits[0])*Math.PI/180:Math.PI*1.95);
    const maxH=r.type==='plane'?r.h:r.y1-r.y0;
    const scale=Math.min(1,maxW*.995/(width*c+height*s),maxH*.995/(width*s+height*c));width*=scale;height*=scale;
    if(scale<.999)warnings.push(`${p.name}：图案 ${p.widthMm} × ${p.heightMm} mm 超出当前模型的示意可用区域，预览缩小为 ${width.toFixed(1)} × ${height.toFixed(1)} mm；保存的图案尺寸不变。请调整模型或图案尺寸，并核对工厂禁印范围。`);
    const halfX=(width*c+height*s)/2,halfY=(width*s+height*c)/2;
    if(r.type==='plane'){
      const x=clamp(p.x,-r.w/2+halfX,r.w/2-halfX),y=clamp(p.y,-r.h/2+halfY,r.h/2-halfY);
      if(Math.abs(x-p.x)>.05||Math.abs(y-p.y)>.05)warnings.push(`${p.name}：偏移超出当前模型，预览位置已限制在区域内，保存值不变。`);
      geometry=new T.PlaneGeometry(width,height);position=r.o.clone().addScaledVector(r.u,x).addScaledVector(r.v,y).addScaledVector(r.n,index*.015);
      quaternion=new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(r.u,r.v,r.n));quaternion.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),angle));
    }else{
      const y=clamp((r.y0+r.y1)/2+p.y,r.y0+halfY,r.y1-halfY),minR=Math.min(r.radius(r.y0),r.radius(r.y1));
      const halfAngle=halfX/minR*180/Math.PI,u=r.limits?clamp(p.x,r.limits[0]+halfAngle,r.limits[1]-halfAngle):p.x;
      if(Math.abs(y-((r.y0+r.y1)/2+p.y))>.05||Math.abs(u-p.x)>.05)warnings.push(`${p.name}：偏移超出当前模型，预览位置已限制在区域内，保存值不变。`);
      const vertices=[],uv=[],indices=[],cols=64,rows=16;
      for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){const dx=(i/cols-.5)*width,dy=(j/rows-.5)*height,yy=y+dx*sin+dy*cos,theta=u*Math.PI/180+(dx*cos-dy*sin)/r.radius(yy),radius=r.radius(yy)+.16+index*.015;vertices.push(radius*Math.sin(theta),yy,radius*Math.cos(theta));uv.push(i/cols,j/rows);}
      for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const k=j*(cols+1)+i;indices.push(k,k+1,k+cols+1,k+1,k+cols+2,k+cols+1);}
      geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));geometry.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();position=new T.Vector3();quaternion=new T.Quaternion();
    }
    const material=new T.MeshStandardMaterial({map:map||null,color:map?0xffffff:0x258fcb,opacity:map?1:.22,depthWrite:!!map,roughness:.8,transparent:true,alphaTest:.06,polygonOffset:true,polygonOffsetFactor:-1});
    const o=new T.Mesh(geometry,material);o.position.copy(position);o.quaternion.copy(quaternion);o.renderOrder=1;labels.add(o);
    if(!map){
      const pos=geometry.getAttribute('position'),points=[];
      const indices=r.type==='plane'?[0,1,3,2]:[...Array.from({length:65},(_,i)=>i),...Array.from({length:16},(_,i)=>(i+1)*65+64),...Array.from({length:64},(_,i)=>16*65+63-i),...Array.from({length:15},(_,i)=>(15-i)*65)];
      indices.forEach(i=>points.push(new T.Vector3().fromBufferAttribute(pos,i)));
      const outline=new T.LineLoop(new T.BufferGeometry().setFromPoints(points),new T.LineBasicMaterial({color:0x147db8}));outline.position.copy(position);outline.quaternion.copy(quaternion);outline.renderOrder=2;labels.add(outline);
    }
  }
  async function update(id,placements,images,dimensions){
    const request=++ticket,key=JSON.stringify(dimensions);
    if(model!==id||dimensionKey!==key){disposeGroup(labels);labels=new T.Group();scene.add(labels);makeModel(id,dimensions);dimensionKey=key;}
    const valid=new Set(images.filter(i=>i.role==='artwork').map(i=>i.asset_id));
    const ready=await Promise.all(placements.filter(p=>(!p.artworkId||valid.has(p.artworkId))&&regions[p.surface]&&p.widthMm>0&&p.heightMm>0).map(async p=>({p,map:p.artworkId?await texture(p.artworkId):null})));
    if(dead||request!==ticket)return;
    const warnings=[];
    disposeGroup(labels);labels=new T.Group();scene.add(labels);ready.forEach(({p,map},i)=>label(p,regions[p.surface],map,i,warnings));render();return warnings;
  }
  function dispose(){dead=true;ticket++;resize.disconnect();controls.dispose();disposeGroup(group);disposeGroup(labels);disposeGroup(measurements);textures.forEach(p=>p.then(t=>t.dispose()).catch(()=>{}));environment.dispose();ground.geometry.dispose();ground.material.dispose();grid.geometry.dispose();grid.material.dispose();renderer.dispose();host.replaceChildren();}
  fit();return {update,reset,dispose};
}
