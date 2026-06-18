// ─── Config ───────────────────────────────────────────────────
const SERVER_URL = 'https://planet-panic-production.up.railway.app';
const MAP_W=800, MAP_H=800;

const HEROES={
  blaze:{name:'Blaze',icon:'🔥',color:'#ef4444',abilityName:'Burst Fire'},
  vault:{name:'Vault',icon:'🛡️',color:'#3b82f6',abilityName:'Charge'},
  pulse:{name:'Pulse',icon:'💚',color:'#34d399',abilityName:'Heal Burst'},
  shade:{name:'Shade',icon:'👻',color:'#a78bfa',abilityName:'Blink'},
  vex:  {name:'Vex',  icon:'🎯',color:'#fbbf24',abilityName:'Pierce'},
  kova: {name:'Kova', icon:'💣',color:'#f97316',abilityName:'Mine'},
};

// ─── State ────────────────────────────────────────────────────
let socket=null,myId=null,myTeam=null,myHeroKey='blaze',roomCode=null,isHost=false;
let gameState='home';
let players={},bullets=[],mines=[],walls=[];
let zone=null, winScore=100, scores={red:0,blue:0};
let particles=[];
let animId,lastTime=0;
let camX=0,camY=0;
let zoneMoveFlash=0; // flashes when zone moves
let zoneWarningTimer=0;

// Joystick
let moveJoy={active:false,startX:0,startY:0,curX:0,curY:0,id:-1};
let aimJoy ={active:false,startX:0,startY:0,curX:0,curY:0,id:-1};
let lastFireTime=0;
const FIRE_INTERVAL=120;

const canvas=document.getElementById('gc');
const ctx=canvas.getContext('2d');
let CW,CH;

function resizeCanvas(){CW=canvas.width=window.innerWidth;CH=canvas.height=window.innerHeight;}
resizeCanvas();
window.addEventListener('resize',resizeCanvas);

// ─── Screen helpers ───────────────────────────────────────────
function hideAllScreens(){
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('round-banner').style.display='none';
  document.getElementById('respawn-banner').style.display='none';
}
function showScreen(id){ hideAllScreens(); if(id) document.getElementById(id).classList.remove('hidden'); }
function showHUD(v){ document.getElementById('hud').classList.toggle('hidden',!v); }
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2500);
}
function showBanner(html,color,ms){
  const b=document.getElementById('round-banner');
  b.innerHTML=html; b.style.color=color; b.style.display='block';
  setTimeout(()=>b.style.display='none',ms||2500);
}
function setupLobbyScreen(){
  showScreen('screen-lobby');
  document.getElementById('lobby-code').textContent=roomCode;
  document.getElementById('btn-start').style.display=isHost?'block':'none';
  document.getElementById('waiting-msg').style.display=isHost?'none':'block';
  updatePlayerList();
}
function updatePlayerList(){
  const list=document.getElementById('player-list');
  list.innerHTML='';
  Object.values(players).forEach((p,i)=>{
    const h=HEROES[p.heroKey]||HEROES.blaze;
    const tc=p.team==='red'?'#ef4444':'#3b82f6';
    const div=document.createElement('div');
    div.className='player-item';
    div.innerHTML=`<div class="player-dot" style="background:${h.color}"></div>
      <span>${h.icon} ${p.name}</span>
      <span class="team-badge" style="background:${tc}22;color:${tc};">${p.team}</span>
      ${i===0?'<span class="player-host">host</span>':''}`;
    list.appendChild(div);
  });
}
function selectHero(el){
  document.querySelectorAll('.hero-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected'); myHeroKey=el.dataset.hero;
}
function getName(){ return document.getElementById('input-name').value.trim()||'Player'; }
function goCreate(){ connectSocket(); socket.emit('create_room',{name:getName(),heroKey:myHeroKey}); }
function goJoin(){ connectSocket(); showScreen('screen-join'); }
function joinRoom(){
  const code=document.getElementById('input-code').value.trim().toUpperCase();
  if(code.length<5){showToast('Enter full room code');return;}
  socket.emit('join_room',{code,name:getName(),heroKey:myHeroKey});
}
function startGame(){ socket.emit('start_game'); }
function leaveRoom(){
  if(socket) socket.disconnect();
  socket=null;myId=null;myTeam=null;players={};bullets=[];mines=[];zone=null;
  showScreen('screen-home');gameState='home';
}

// ─── Socket ───────────────────────────────────────────────────
function connectSocket(){
  if(socket&&socket.connected) return;
  socket=io(SERVER_URL,{extraHeaders:{'ngrok-skip-browser-warning':'true'}});
  bindSocketEvents();
}

function bindSocketEvents(){
  socket.on('connect',()=>{ myId=socket.id; });

  socket.on('room_created',(d)=>{
    roomCode=d.code;myId=d.you;myTeam=d.team;isHost=true;
    players=d.players;gameState='lobby';
    setupLobbyScreen();startRenderLoop();
  });
  socket.on('room_joined',(d)=>{
    roomCode=d.code;myId=d.you;myTeam=d.team;isHost=false;
    players=d.players;gameState='lobby';
    setupLobbyScreen();startRenderLoop();
  });
  socket.on('player_joined',(d)=>{ players=d.players; if(gameState==='lobby') updatePlayerList(); });
  socket.on('player_left',  (d)=>{ players=d.players; if(gameState==='lobby') updatePlayerList(); });

  socket.on('countdown',(d)=>{
    gameState='countdown';hideAllScreens();
    document.getElementById('screen-countdown').classList.remove('hidden');
    const el=document.getElementById('countdown-num');
    el.textContent=d.count;el.style.animation='none';el.offsetHeight;
    el.style.animation='pop 0.4s ease-out';
  });

  socket.on('round_start',(d)=>{
    players=d.players;walls=d.walls||[];
    zone=d.zone;winScore=d.winScore||100;
    scores={red:0,blue:0};
    bullets=[];mines=[];particles=[];zoneMoveFlash=0;
    gameState='playing';
    hideAllScreens();showHUD(true);
    updateScoreBar();
  });

  socket.on('state',(d)=>{
    if(gameState!=='playing') return;
    players=d.players;bullets=d.bullets||[];mines=d.mines||[];
    if(d.zone) zone=d.zone;
    if(d.scores) scores=d.scores;
    for(const e of(d.effects||[])){
      if(e.type==='hit') spawnHitSpark(e.x,e.y,e.color);
      else if(e.type==='death'||e.type==='explosion') spawnExplosion(e.x,e.y,e.color);
      else if(e.type==='heal') spawnHeal(e.x,e.y);
    }
    updateScoreBar();
    updateHUD();
  });

  socket.on('zone_move',(d)=>{
    zone=d.zone;
    zoneMoveFlash=1.5;
    showBanner('⚡ ZONE MOVED!','#f6c94e',1800);
  });

  socket.on('respawn',(d)=>{
    if(d.id===myId) document.getElementById('respawn-banner').style.display='none';
  });
  socket.on('effects',(efx)=>{
    for(const e of efx){ if(e.type==='heal') spawnHeal(e.x,e.y); }
  });

  socket.on('round_end',(d)=>{
    gameState='roundEnd';
    const color=d.winTeam==='red'?'#ef4444':'#3b82f6';
    hideAllScreens();
    document.getElementById('screen-results').classList.remove('hidden');
    document.getElementById('win-title').textContent=`${d.winTeam.toUpperCase()} TEAM WINS!`;
    document.getElementById('win-title').style.color=color;
    document.getElementById('win-sub').textContent=
      `Red ${Math.floor(d.scores.red)} — ${Math.floor(d.scores.blue)} Blue`;
    const list=document.getElementById('results-list');
    list.innerHTML='';
    Object.values(players).sort((a,b)=>b.score-a.score).forEach(p=>{
      const h=HEROES[p.heroKey]||HEROES.blaze;
      const row=document.createElement('div');
      row.className='score-row';
      row.innerHTML=`<span>${h.icon}</span>
        <span style="color:${h.color}">${p.name}</span>
        <span style="color:${p.team==='red'?'#ef4444':'#3b82f6'};font-size:10px;">${p.team}</span>
        <span style="margin-left:auto;color:#a5b4fc;">${p.score} kills</span>`;
      list.appendChild(row);
    });
  });

  socket.on('back_to_lobby',()=>{ gameState='lobby'; zone=null; setupLobbyScreen(); });
  socket.on('error',(d)=>{ showToast(d.msg); });
  socket.on('disconnect',()=>{
    showToast('Disconnected');hideAllScreens();showScreen('screen-home');gameState='home';socket=null;
  });
}

// ─── HUD ──────────────────────────────────────────────────────
function updateScoreBar(){
  const rPct=Math.min(100,(scores.red/winScore)*100);
  const bPct=Math.min(100,(scores.blue/winScore)*100);
  document.getElementById('red-score').textContent=Math.floor(scores.red);
  document.getElementById('blue-score').textContent=Math.floor(scores.blue);
  // Update progress bars in score bar
  const rBar=document.getElementById('red-progress');
  const bBar=document.getElementById('blue-progress');
  if(rBar) rBar.style.width=rPct+'%';
  if(bBar) bBar.style.width=bPct+'%';
}

function updateHUD(){
  const me=players[myId]; if(!me) return;
  const h=HEROES[me.heroKey]||HEROES.blaze;
  const hpPct=Math.max(0,(me.hp/me.maxHp)*100);
  const hpFill=document.getElementById('hp-fill');
  if(hpFill){
    hpFill.style.width=hpPct+'%';
    hpFill.style.background=hpPct>50?'#34d399':hpPct>25?'#fbbf24':'#ef4444';
  }
  const cdEl=document.getElementById('ability-cd-hud');
  if(cdEl){
    const cd=me.abilityCooldown||0;
    cdEl.textContent=cd>0?Math.ceil(cd/30)+'s':'READY';
    cdEl.style.color=cd>0?'#ef4444':'#34d399';
  }
  const killsEl=document.getElementById('kills-hud');
  if(killsEl) killsEl.textContent=me.score+' kills';
  if(!me.alive) document.getElementById('respawn-banner').style.display='block';
}

// ─── Camera ───────────────────────────────────────────────────
function updateCamera(){
  const me=players[myId];
  if(me){ camX+=(me.x-CW/2-camX)*0.12; camY+=(me.y-CH/2-camY)*0.12; }
  camX=Math.max(0,Math.min(MAP_W-CW,camX));
  camY=Math.max(0,Math.min(MAP_H-CH,camY));
}

// ─── Input ────────────────────────────────────────────────────
canvas.addEventListener('touchstart',e=>{
  e.preventDefault();
  for(const t of e.changedTouches){
    const tx=t.clientX,ty=t.clientY;
    if(tx<CW/2) moveJoy={active:true,startX:tx,startY:ty,curX:tx,curY:ty,id:t.identifier};
    else aimJoy={active:true,startX:tx,startY:ty,curX:tx,curY:ty,id:t.identifier};
  }
},{passive:false});

canvas.addEventListener('touchmove',e=>{
  e.preventDefault();
  for(const t of e.changedTouches){
    if(t.identifier===moveJoy.id){
      moveJoy.curX=t.clientX;moveJoy.curY=t.clientY;
      const dx=moveJoy.curX-moveJoy.startX,dy=moveJoy.curY-moveJoy.startY;
      const len=Math.sqrt(dx*dx+dy*dy)||1;
      if(len>10) socket?.emit('move',{vx:dx/Math.max(len,60),vy:dy/Math.max(len,60)});
      else socket?.emit('move',{vx:0,vy:0});
    }
    if(t.identifier===aimJoy.id){
      aimJoy.curX=t.clientX;aimJoy.curY=t.clientY;
      const now=Date.now();
      if(gameState==='playing'&&now-lastFireTime>FIRE_INTERVAL){
        const me=players[myId]; if(me&&me.alive){
          const dx=aimJoy.curX-aimJoy.startX,dy=aimJoy.curY-aimJoy.startY;
          const len=Math.sqrt(dx*dx+dy*dy)||1;
          socket?.emit('fire',{targetX:me.x+dx/len*200,targetY:me.y+dy/len*200});
          lastFireTime=now;
        }
      }
    }
  }
},{passive:false});

canvas.addEventListener('touchend',e=>{
  e.preventDefault();
  for(const t of e.changedTouches){
    if(t.identifier===moveJoy.id){ moveJoy.active=false; socket?.emit('move',{vx:0,vy:0}); }
    if(t.identifier===aimJoy.id){
      const dx=aimJoy.curX-aimJoy.startX,dy=aimJoy.curY-aimJoy.startY;
      if(Math.sqrt(dx*dx+dy*dy)<15) fireAbility();
      aimJoy.active=false;
    }
  }
},{passive:false});

const keys={};
window.addEventListener('keydown',e=>{ keys[e.key]=true; sendKeyMove();
  if(e.key===' '){e.preventDefault();fireAbility();}
});
window.addEventListener('keyup',e=>{ keys[e.key]=false; sendKeyMove(); });
function sendKeyMove(){
  if(gameState!=='playing') return;
  let vx=0,vy=0;
  if(keys['ArrowLeft']||keys['a']) vx-=1;
  if(keys['ArrowRight']||keys['d']) vx+=1;
  if(keys['ArrowUp']||keys['w']) vy-=1;
  if(keys['ArrowDown']||keys['s']) vy+=1;
  const len=Math.sqrt(vx*vx+vy*vy)||1;
  socket?.emit('move',{vx:vx?(vx/len):0,vy:vy?(vy/len):0});
}

let mouseX=0,mouseY=0;
canvas.addEventListener('mousemove',e=>{ mouseX=e.clientX;mouseY=e.clientY; });
canvas.addEventListener('mousedown',e=>{
  if(e.button===0){
    if(gameState==='playing'){
      socket?.emit('fire',{targetX:mouseX+camX,targetY:mouseY+camY});
    }
  }
  if(e.button===2){e.preventDefault();fireAbility();}
});
canvas.addEventListener('contextmenu',e=>e.preventDefault());

function fireAbility(){
  if(gameState!=='playing') return;
  const me=players[myId]; if(!me||!me.alive) return;
  let nearest=null,nd=Infinity;
  for(const p of Object.values(players)){
    if(p.team===myTeam||!p.alive) continue;
    const d=(p.x-me.x)**2+(p.y-me.y)**2;
    if(d<nd){nd=d;nearest=p;}
  }
  // Also aim toward zone if no enemy nearby
  const tx=nearest&&nd<300**2?nearest.x:(zone?.x||me.x+100);
  const ty=nearest&&nd<300**2?nearest.y:(zone?.y||me.y);
  socket?.emit('ability',{targetX:tx,targetY:ty});
}

// ─── Particles ────────────────────────────────────────────────
function spawnHitSpark(x,y,color){
  for(let i=0;i<6;i++){
    const a=Math.random()*Math.PI*2,s=2+Math.random()*4;
    particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:0.6,color,r:2+Math.random()*2});
  }
}
function spawnExplosion(x,y,color){
  for(let i=0;i<20;i++){
    const a=(i/20)*Math.PI*2,s=2+Math.random()*6;
    particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:1,color,r:3+Math.random()*4});
  }
  particles.push({x,y,vx:0,vy:0,life:0.3,color:'#ffffff',r:22});
}
function spawnHeal(x,y){
  for(let i=0;i<10;i++){
    const a=Math.random()*Math.PI*2,s=1+Math.random()*3;
    particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s-2,life:0.8,color:'#34d399',r:2+Math.random()*3});
  }
}
function spawnZoneCapture(x,y,color){
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2;
    particles.push({x:x+Math.cos(a)*70,y:y+Math.sin(a)*70,
      vx:Math.cos(a)*1.5,vy:Math.sin(a)*1.5,life:0.8,color,r:3+Math.random()*3});
  }
}

// ─── Draw ─────────────────────────────────────────────────────
function draw(ts){
  const dt=Math.min((ts-lastTime)/16.67,2.5);
  lastTime=ts;
  if(gameState==='playing'||gameState==='roundEnd') updateCamera();
  if(zoneMoveFlash>0) zoneMoveFlash=Math.max(0,zoneMoveFlash-0.04*dt);

  ctx.clearRect(0,0,CW,CH);
  ctx.fillStyle='#0a0a14'; ctx.fillRect(0,0,CW,CH);

  if(gameState!=='home'&&gameState!=='lobby'&&gameState!=='countdown'){
    ctx.save();
    ctx.translate(-camX,-camY);

    // ── Floor ──
    ctx.fillStyle='#12121f'; ctx.fillRect(0,0,MAP_W,MAP_H);
    ctx.strokeStyle='rgba(99,102,241,0.05)'; ctx.lineWidth=1;
    for(let x=0;x<MAP_W;x+=50){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,MAP_H);ctx.stroke();}
    for(let y=0;y<MAP_H;y+=50){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(MAP_W,y);ctx.stroke();}

    // Spawn zones
    ctx.fillStyle='rgba(239,68,68,0.04)'; ctx.fillRect(0,0,120,MAP_H);
    ctx.fillStyle='rgba(59,130,246,0.04)'; ctx.fillRect(MAP_W-120,0,120,MAP_H);
    ctx.strokeStyle='#6366f122'; ctx.lineWidth=3;
    ctx.strokeRect(2,2,MAP_W-4,MAP_H-4);

    // ── Zone ──
    if(zone){
      const zr=zone.radius;
      const zx=zone.x, zy=zone.y;
      const cap=zone.capturingTeam;
      const contested=zone.contestedBy==='both';
      const zColor=contested?'#f6c94e':cap==='red'?'#ef4444':cap==='blue'?'#3b82f6':'#6366f1';
      const flash=zoneMoveFlash>0?Math.sin(Date.now()/80)*0.5+0.5:0;

      // Outer pulse ring
      const pulse=(Math.sin(Date.now()/600)*0.3+0.7);
      ctx.beginPath(); ctx.arc(zx,zy,zr+12*pulse,0,Math.PI*2);
      ctx.strokeStyle=zColor+(Math.round(0.2*255).toString(16).padStart(2,'0'));
      ctx.lineWidth=6; ctx.stroke();

      // Zone fill
      ctx.beginPath(); ctx.arc(zx,zy,zr,0,Math.PI*2);
      const zg=ctx.createRadialGradient(zx,zy,0,zx,zy,zr);
      zg.addColorStop(0,zColor+'44');
      zg.addColorStop(1,zColor+'11');
      ctx.fillStyle=zg; ctx.fill();

      // Zone border
      ctx.beginPath(); ctx.arc(zx,zy,zr,0,Math.PI*2);
      ctx.strokeStyle=zColor+(zoneMoveFlash>0?'ff':'99');
      ctx.lineWidth=3+(flash*3); ctx.stroke();

      // Zone icon
      ctx.font='bold 18px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle=contested?'#f6c94e':cap?zColor:'rgba(255,255,255,0.3)';
      ctx.fillText(contested?'⚔️':cap==='red'?'🔴':cap==='blue'?'🔵':'⚡',zx,zy);

      // Capture particles
      if(cap&&Math.random()<0.2) spawnZoneCapture(zx,zy,zColor);

      // Contested flash
      if(contested){
        ctx.beginPath(); ctx.arc(zx,zy,zr,0,Math.PI*2);
        ctx.strokeStyle=`rgba(246,201,78,${0.3+Math.sin(Date.now()/150)*0.3})`;
        ctx.lineWidth=4; ctx.stroke();
      }
    }

    // ── Walls ──
    for(const w of walls){
      ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fillRect(w.x+4,w.y+4,w.w,w.h);
      const wg=ctx.createLinearGradient(w.x,w.y,w.x+w.w,w.y+w.h);
      wg.addColorStop(0,'#2a2a4a'); wg.addColorStop(1,'#1a1a2e');
      ctx.fillStyle=wg; ctx.fillRect(w.x,w.y,w.w,w.h);
      ctx.fillStyle='rgba(99,102,241,0.15)'; ctx.fillRect(w.x,w.y,w.w,4);
      ctx.strokeStyle='#6366f144'; ctx.lineWidth=1; ctx.strokeRect(w.x,w.y,w.w,w.h);
    }

    // ── Mines ──
    for(const m of mines){
      const blink=Math.sin(Date.now()/200)>0;
      ctx.beginPath(); ctx.arc(m.x,m.y,8,0,Math.PI*2);
      ctx.fillStyle=blink?m.color+'cc':'#1a1a1a'; ctx.fill();
      ctx.strokeStyle=m.color; ctx.lineWidth=2; ctx.stroke();
    }

    // ── Bullets ──
    for(const b of bullets){
      ctx.beginPath(); ctx.arc(b.x,b.y,8,0,Math.PI*2);
      ctx.fillStyle=b.color+'33'; ctx.fill();
      ctx.beginPath(); ctx.arc(b.x,b.y,4,0,Math.PI*2);
      ctx.fillStyle=b.color; ctx.fill();
    }

    // ── Players ──
    for(const id in players) drawPlayer(players[id],id===myId);

    // ── Particles ──
    for(const p of particles){
      ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(0.5,p.r*p.life),0,Math.PI*2);
      ctx.fillStyle=p.color+Math.round(p.life*210).toString(16).padStart(2,'0');
      ctx.fill();
      p.x+=p.vx*dt; p.y+=p.vy*dt; p.vy+=0.08*dt; p.vx*=0.95; p.life-=0.025*dt;
    }
    particles=particles.filter(p=>p.life>0);

    ctx.restore();

    // ── Joysticks ──
    if(gameState==='playing'){
      drawJoy(moveJoy,'rgba(255,255,255,0.07)','rgba(255,255,255,0.22)');
      if(aimJoy.active) drawJoy(aimJoy,'rgba(99,102,241,0.12)','rgba(99,102,241,0.45)');
      if(!moveJoy.active&&!aimJoy.active){
        ctx.font='10px monospace'; ctx.fillStyle='rgba(255,255,255,0.07)';
        ctx.textAlign='center';
        ctx.fillText('◀ MOVE',CW*0.22,CH-12);
        ctx.fillText('AIM + FIRE ▶  |  tap = ability',CW*0.68,CH-12);
      }
    }

    // ── Zone arrow (off-screen indicator) ──
    if(gameState==='playing'&&zone){
      const zsx=zone.x-camX, zsy=zone.y-camY;
      const onScreen=zsx>50&&zsx<CW-50&&zsy>80&&zsy<CH-80;
      if(!onScreen){
        // Draw arrow pointing toward zone
        const dx=zsx-CW/2, dy=zsy-CH/2;
        const angle=Math.atan2(dy,dx);
        const arrowX=CW/2+Math.cos(angle)*(Math.min(CW,CH)*0.38);
        const arrowY=CH/2+Math.sin(angle)*(Math.min(CW,CH)*0.38);
        ctx.save();
        ctx.translate(arrowX,arrowY);
        ctx.rotate(angle);
        ctx.fillStyle='rgba(99,102,241,0.7)';
        ctx.beginPath();
        ctx.moveTo(12,0); ctx.lineTo(-8,-7); ctx.lineTo(-8,7); ctx.closePath();
        ctx.fill();
        ctx.font='bold 9px monospace'; ctx.fillStyle='rgba(255,255,255,0.6)';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText('ZONE',0,16);
        ctx.restore();
      }
    }
  }

  animId=requestAnimationFrame(draw);
}

function drawPlayer(p,isSelf){
  if(!p.alive) return;
  const h=HEROES[p.heroKey]||HEROES.blaze;
  const tc=p.team==='red'?'#ef4444':'#3b82f6';

  ctx.save(); ctx.translate(p.x,p.y);

  // Shadow
  ctx.beginPath(); ctx.ellipse(0,6,14,5,0,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fill();

  // Glow
  if(isSelf){
    ctx.beginPath(); ctx.arc(0,0,26,0,Math.PI*2);
    ctx.fillStyle=tc+'22'; ctx.fill();
  }

  // Body
  ctx.beginPath(); ctx.arc(0,0,16,0,Math.PI*2);
  const bg=ctx.createRadialGradient(-5,-6,1,0,0,16);
  bg.addColorStop(0,lighten(h.color,50)); bg.addColorStop(1,h.color);
  ctx.fillStyle=bg; ctx.fill();
  ctx.strokeStyle=tc; ctx.lineWidth=isSelf?2.5:1.5; ctx.stroke();

  // Icon
  ctx.font='12px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(h.icon,0,0);

  // HP bar
  const bw=34,hpPct=Math.max(0,p.hp/p.maxHp);
  ctx.fillStyle='#0a0a14'; ctx.fillRect(-bw/2,-24,bw,5);
  ctx.fillStyle=hpPct>0.5?'#34d399':hpPct>0.25?'#fbbf24':'#ef4444';
  ctx.fillRect(-bw/2,-24,bw*hpPct,5);
  ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=0.5;
  ctx.strokeRect(-bw/2,-24,bw,5);

  // Name
  ctx.font=`${isSelf?'bold ':''}9px monospace`;
  ctx.fillStyle=isSelf?'#fff':'#a0a0b8'; ctx.textBaseline='alphabetic';
  ctx.fillText(p.name,0,-27);

  // Ability ready dashes
  if((p.abilityCooldown||0)===0){
    ctx.beginPath(); ctx.arc(0,0,20,0,Math.PI*2);
    ctx.strokeStyle=h.color+'77'; ctx.lineWidth=1.5;
    ctx.setLineDash([3,4]); ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.restore();
}

function drawJoy(joy,bg,knob){
  if(!joy.active) return;
  const r=46,kr=18;
  ctx.beginPath(); ctx.arc(joy.startX,joy.startY,r,0,Math.PI*2);
  ctx.fillStyle=bg; ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=1; ctx.stroke();
  const dx=joy.curX-joy.startX,dy=joy.curY-joy.startY,len=Math.sqrt(dx*dx+dy*dy);
  const kx=joy.startX+(len>r?dx/len*r:dx);
  const ky=joy.startY+(len>r?dy/len*r:dy);
  ctx.beginPath(); ctx.arc(kx,ky,kr,0,Math.PI*2);
  ctx.fillStyle=knob; ctx.fill();
}

function lighten(hex,amt){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgb(${Math.min(255,r+amt)},${Math.min(255,g+amt)},${Math.min(255,b+amt)})`;
}

function startRenderLoop(){
  if(animId) cancelAnimationFrame(animId);
  lastTime=performance.now();
  animId=requestAnimationFrame(draw);
}
startRenderLoop();
