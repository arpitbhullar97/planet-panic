// ─── Config ───────────────────────────────────────────────────
const SERVER_URL = 'https://planet-panic-production.up.railway.app';
const MAP_W = 800, MAP_H = 800;

// ─── Hero data (client copy for UI) ──────────────────────────
const HEROES = {
  blaze: {name:'Blaze', icon:'🔥', color:'#ef4444', abilityName:'Burst Fire', desc:'Fires 5 bullets in a spread'},
  vault: {name:'Vault', icon:'🛡️', color:'#3b82f6', abilityName:'Charge',     desc:'Charges forward knocking enemies'},
  pulse: {name:'Pulse', icon:'💚', color:'#34d399', abilityName:'Heal Burst', desc:'Heals all nearby teammates'},
  shade: {name:'Shade', icon:'👻', color:'#a78bfa', abilityName:'Blink',      desc:'Teleports to target location'},
  vex:   {name:'Vex',   icon:'🎯', color:'#fbbf24', abilityName:'Pierce',     desc:'Fires a bullet through walls'},
  kova:  {name:'Kova',  icon:'💣', color:'#f97316', abilityName:'Mine',       desc:'Places a hidden mine'},
};

// ─── State ────────────────────────────────────────────────────
let socket=null, myId=null, myTeam=null, myHeroKey='blaze', roomCode=null, isHost=false;
let gameState='home';
let players={}, bullets=[], mines=[], walls=[];
let particles=[], effects=[];
let stars=[];
let animId, lastTime=0;
let camX=0, camY=0;

// Joystick state
let moveJoy={active:false,startX:0,startY:0,curX:0,curY:0,id:-1};
let aimJoy={active:false,startX:0,startY:0,curX:0,curY:0,id:-1,isAbility:false};
let lastFireTime=0;
const FIRE_INTERVAL=120; // ms between auto-fire

// Canvas
const canvas=document.getElementById('gc');
const ctx=canvas.getContext('2d');
let CW,CH;

function resizeCanvas(){
  CW=canvas.width=window.innerWidth;
  CH=canvas.height=window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize',resizeCanvas);

// ─── Stars ────────────────────────────────────────────────────
function mkStars(){
  stars=[];
  for(let i=0;i<60;i++) stars.push({
    x:Math.random()*MAP_W, y:Math.random()*MAP_H,
    r:Math.random()*1.2+0.2, a:Math.random()*0.3+0.05
  });
}
mkStars();

// ─── Screen helpers ───────────────────────────────────────────
function hideAllScreens(){
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('round-banner').style.display='none';
  document.getElementById('respawn-banner').style.display='none';
}
function showScreen(id){
  hideAllScreens();
  if(id) document.getElementById(id).classList.remove('hidden');
}
function showHUD(v){ document.getElementById('hud').classList.toggle('hidden',!v); }
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2500);
}
function showBanner(msg,color,duration){
  const b=document.getElementById('round-banner');
  b.innerHTML=msg; b.style.color=color; b.style.display='block';
  setTimeout(()=>b.style.display='none',duration||2000);
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
    const div=document.createElement('div');
    div.className='player-item';
    const teamColor=p.team==='red'?'#ef4444':'#3b82f6';
    div.innerHTML=`<div class="player-dot" style="background:${h.color}"></div>
      <span>${h.icon} ${p.name}</span>
      <span class="team-badge" style="background:${teamColor}22;color:${teamColor};">${p.team}</span>
      ${i===0?'<span class="player-host">host</span>':''}`;
    list.appendChild(div);
  });
}

// ─── Hero picker ──────────────────────────────────────────────
function selectHero(el){
  document.querySelectorAll('.hero-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  myHeroKey=el.dataset.hero;
}

// ─── UI actions ───────────────────────────────────────────────
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
  socket=null; myId=null; myTeam=null; players={}; bullets=[]; mines=[];
  showScreen('screen-home'); gameState='home';
}

// ─── Socket ───────────────────────────────────────────────────
function connectSocket(){
  if(socket&&socket.connected) return;
  socket=io(SERVER_URL,{extraHeaders:{'ngrok-skip-browser-warning':'true'}});
  bindSocketEvents();
}

function bindSocketEvents(){
  socket.on('connect',()=>{ myId=socket.id; });

  socket.on('room_created',(data)=>{
    roomCode=data.code; myId=data.you; myTeam=data.team; isHost=true;
    players=data.players; gameState='lobby';
    setupLobbyScreen(); startRenderLoop();
  });
  socket.on('room_joined',(data)=>{
    roomCode=data.code; myId=data.you; myTeam=data.team; isHost=false;
    players=data.players; gameState='lobby';
    setupLobbyScreen(); startRenderLoop();
  });
  socket.on('player_joined',(data)=>{ players=data.players; if(gameState==='lobby') updatePlayerList(); });
  socket.on('player_left',  (data)=>{ players=data.players; if(gameState==='lobby') updatePlayerList(); });

  socket.on('countdown',(data)=>{
    gameState='countdown'; hideAllScreens();
    document.getElementById('screen-countdown').classList.remove('hidden');
    const el=document.getElementById('countdown-num');
    el.textContent=data.count;
    el.style.animation='none'; el.offsetHeight;
    el.style.animation='pop 0.4s ease-out';
  });

  socket.on('round_start',(data)=>{
    players=data.players; walls=data.walls||[];
    bullets=[]; mines=[]; particles=[];
    gameState='playing';
    hideAllScreens(); showHUD(true);
    updateHUD();
  });

  socket.on('state',(data)=>{
    if(gameState!=='playing') return;
    players=data.players; bullets=data.bullets||[]; mines=data.mines||[];
    // Spawn client-side particles for effects
    for(const e of (data.effects||[])){
      if(e.type==='hit') spawnHitSpark(e.x,e.y,e.color);
      else if(e.type==='death') spawnExplosion(e.x,e.y,e.color);
      else if(e.type==='explosion') spawnExplosion(e.x,e.y,e.color);
      else if(e.type==='heal') spawnHeal(e.x,e.y);
    }
    // Update HUD
    document.getElementById('red-score').textContent=data.scores?.red||0;
    document.getElementById('blue-score').textContent=data.scores?.blue||0;
    updateHUD();
  });

  socket.on('respawn',(data)=>{
    if(data.id===myId){
      document.getElementById('respawn-banner').style.display='none';
    }
  });

  socket.on('effects',(efx)=>{
    for(const e of efx){
      if(e.type==='heal') spawnHeal(e.x,e.y);
    }
  });

  socket.on('round_end',(data)=>{
    gameState='roundEnd';
    const color=data.winTeam==='red'?'#ef4444':'#3b82f6';
    showBanner(`${data.winTeam.toUpperCase()} TEAM WINS THE ROUND!<br>
      <span style="font-size:12px;color:#718096;">Red ${data.scores.red} — ${data.scores.blue} Blue</span>`,
      color, 3000);
  });

  socket.on('match_end',(data)=>{
    gameState='matchEnd'; hideAllScreens();
    const color=data.winTeam==='red'?'#ef4444':'#3b82f6';
    document.getElementById('screen-match-end').classList.remove('hidden');
    document.getElementById('match-win-title').textContent=`${data.winTeam.toUpperCase()} WINS THE MATCH!`;
    document.getElementById('match-win-title').style.color=color;
    const list=document.getElementById('match-results-list');
    list.innerHTML='';
    Object.values(players).sort((a,b)=>b.score-a.score).forEach(p=>{
      const h=HEROES[p.heroKey]||HEROES.blaze;
      const row=document.createElement('div');
      row.className='score-row';
      row.innerHTML=`<span style="font-size:14px;">${h.icon}</span>
        <span style="color:${h.color};">${p.name}</span>
        <span style="color:#4a5568;font-size:10px;">${p.team}</span>
        <span style="margin-left:auto;color:#a5b4fc;">${p.score} kills</span>`;
      list.appendChild(row);
    });
  });

  socket.on('back_to_lobby',()=>{ gameState='lobby'; setupLobbyScreen(); });
  socket.on('error',(data)=>{ showToast(data.msg); });
  socket.on('disconnect',()=>{
    showToast('Disconnected'); hideAllScreens();
    showScreen('screen-home'); gameState='home'; socket=null;
  });
}

// ─── HUD update ───────────────────────────────────────────────
function updateHUD(){
  const me=players[myId]; if(!me) return;
  const h=HEROES[me.heroKey]||HEROES.blaze;
  const hpPct=Math.max(0,(me.hp/me.maxHp)*100);
  document.getElementById('hp-fill').style.width=hpPct+'%';
  document.getElementById('hp-fill').style.background=hpPct>50?'#34d399':hpPct>25?'#fbbf24':'#ef4444';
  document.getElementById('hero-name-hud').textContent=h.name.toUpperCase();
  document.getElementById('kills-hud').textContent=me.score+' kills';
  document.getElementById('ability-name-hud').textContent=h.abilityName;
  const cd=me.abilityCooldown||0;
  const cdMax=me.abilityCooldownMax||1;
  document.getElementById('ability-cd-hud').textContent=cd>0?Math.ceil(cd/30)+'s':'READY';
  document.getElementById('ability-cd-hud').style.color=cd>0?'#ef4444':'#34d399';
  if(!me.alive){
    document.getElementById('respawn-banner').style.display='block';
  }
}

// ─── Camera ───────────────────────────────────────────────────
function updateCamera(){
  const me=players[myId];
  if(me){
    const targetX=me.x-CW/2;
    const targetY=me.y-CH/2;
    camX+=(targetX-camX)*0.12;
    camY+=(targetY-camY)*0.12;
  }
  camX=Math.max(0,Math.min(MAP_W-CW,camX));
  camY=Math.max(0,Math.min(MAP_H-CH,camY));
}

// ─── Touch input ──────────────────────────────────────────────
canvas.addEventListener('touchstart',e=>{
  e.preventDefault();
  for(const t of e.changedTouches){
    const tx=t.clientX, ty=t.clientY;
    if(tx<CW/2){
      // Left side = move joystick
      moveJoy={active:true,startX:tx,startY:ty,curX:tx,curY:ty,id:t.identifier};
    } else {
      // Right side = aim/fire joystick
      aimJoy={active:true,startX:tx,startY:ty,curX:tx,curY:ty,id:t.identifier,isAbility:false};
    }
  }
},{passive:false});

canvas.addEventListener('touchmove',e=>{
  e.preventDefault();
  for(const t of e.changedTouches){
    if(t.identifier===moveJoy.id){
      moveJoy.curX=t.clientX; moveJoy.curY=t.clientY;
      // Send movement to server
      const dx=moveJoy.curX-moveJoy.startX;
      const dy=moveJoy.curY-moveJoy.startY;
      const len=Math.sqrt(dx*dx+dy*dy)||1;
      const deadzone=10;
      if(len>deadzone){
        socket?.emit('move',{vx:dx/Math.max(len,60),vy:dy/Math.max(len,60)});
      } else {
        socket?.emit('move',{vx:0,vy:0});
      }
    }
    if(t.identifier===aimJoy.id){
      aimJoy.curX=t.clientX; aimJoy.curY=t.clientY;
      // Auto fire while dragging right joystick
      const now=Date.now();
      if(gameState==='playing'&&now-lastFireTime>FIRE_INTERVAL){
        fireAtJoyTarget(false);
        lastFireTime=now;
      }
    }
  }
},{passive:false});

canvas.addEventListener('touchend',e=>{
  e.preventDefault();
  for(const t of e.changedTouches){
    if(t.identifier===moveJoy.id){
      moveJoy.active=false;
      socket?.emit('move',{vx:0,vy:0});
    }
    if(t.identifier===aimJoy.id){
      // Quick tap on right = ability
      const dx=aimJoy.curX-aimJoy.startX, dy=aimJoy.curY-aimJoy.startY;
      const moved=Math.sqrt(dx*dx+dy*dy);
      if(moved<15){
        // Tap = ability toward nearest enemy
        fireAbility();
      }
      aimJoy.active=false;
    }
  }
},{passive:false});

// Keyboard fallback
const keys={};
window.addEventListener('keydown',e=>{ keys[e.key]=true; sendKeyMove(); });
window.addEventListener('keyup',e=>{ keys[e.key]=false; sendKeyMove(); });
function sendKeyMove(){
  if(gameState!=='playing') return;
  let vx=0,vy=0;
  if(keys['ArrowLeft']||keys['a']) vx-=1;
  if(keys['ArrowRight']||keys['d']) vx+=1;
  if(keys['ArrowUp']||keys['w']) vy-=1;
  if(keys['ArrowDown']||keys['s']) vy+=1;
  const len=Math.sqrt(vx*vx+vy*vy)||1;
  if(vx||vy) socket?.emit('move',{vx:vx/len,vy:vy/len});
  else socket?.emit('move',{vx:0,vy:0});
}
window.addEventListener('keydown',e=>{
  if(e.key===' ') { e.preventDefault(); fireAbility(); }
  if(e.key==='f'||e.key==='F') fireAtMouse();
});
let mouseX=CW/2, mouseY=CH/2;
canvas.addEventListener('mousemove',e=>{ mouseX=e.clientX; mouseY=e.clientY; });
canvas.addEventListener('mousedown',e=>{
  if(e.button===0) fireAtMouse();
  if(e.button===2){ e.preventDefault(); fireAbility(); }
});
canvas.addEventListener('contextmenu',e=>e.preventDefault());

function fireAtMouse(){
  if(gameState!=='playing') return;
  const me=players[myId]; if(!me||!me.alive) return;
  const wx=mouseX+camX, wy=mouseY+camY;
  socket?.emit('fire',{targetX:wx,targetY:wy});
}

function fireAtJoyTarget(isAbility){
  const me=players[myId]; if(!me||!me.alive) return;
  const dx=aimJoy.curX-aimJoy.startX, dy=aimJoy.curY-aimJoy.startY;
  const len=Math.sqrt(dx*dx+dy*dy)||1;
  // Project aim direction from player world position
  const wx=me.x+dx/len*200, wy=me.y+dy/len*200;
  if(isAbility) socket?.emit('ability',{targetX:wx,targetY:wy});
  else socket?.emit('fire',{targetX:wx,targetY:wy});
}

function fireAbility(){
  if(gameState!=='playing') return;
  const me=players[myId]; if(!me||!me.alive) return;
  // Aim toward nearest enemy
  let nearest=null, nd=Infinity;
  for(const p of Object.values(players)){
    if(p.team===myTeam||!p.alive) continue;
    const d=(p.x-me.x)**2+(p.y-me.y)**2;
    if(d<nd){nd=d;nearest=p;}
  }
  const tx=nearest?nearest.x:me.x+100;
  const ty=nearest?nearest.y:me.y;
  socket?.emit('ability',{targetX:tx,targetY:ty});
}

// ─── Particles ────────────────────────────────────────────────
function spawnHitSpark(x,y,color){
  for(let i=0;i<6;i++){
    const a=Math.random()*Math.PI*2, s=2+Math.random()*4;
    particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:0.6,color,r:2+Math.random()*2});
  }
}
function spawnExplosion(x,y,color){
  for(let i=0;i<20;i++){
    const a=(i/20)*Math.PI*2+Math.random()*.3, s=2+Math.random()*6;
    particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:1,color,r:3+Math.random()*4});
  }
  particles.push({x,y,vx:0,vy:0,life:0.3,color:'#ffffff',r:20});
}
function spawnHeal(x,y){
  for(let i=0;i<12;i++){
    const a=Math.random()*Math.PI*2, s=1+Math.random()*3;
    particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s-2,life:0.8,color:'#34d399',r:2+Math.random()*3});
  }
}

// ─── Draw ─────────────────────────────────────────────────────
function draw(ts){
  const dt=Math.min((ts-lastTime)/16.67,2.5);
  lastTime=ts;

  if(gameState==='playing'||gameState==='roundEnd'||gameState==='matchEnd'){
    updateCamera();
  }

  ctx.clearRect(0,0,CW,CH);

  // ── Background ──
  ctx.fillStyle='#0a0a14';
  ctx.fillRect(0,0,CW,CH);

  if(gameState!=='home'&&gameState!=='lobby'&&gameState!=='countdown'){
    ctx.save();
    ctx.translate(-camX,-camY);

    // Map floor
    ctx.fillStyle='#12121f';
    ctx.fillRect(0,0,MAP_W,MAP_H);

    // Grid
    ctx.strokeStyle='rgba(99,102,241,0.06)';
    ctx.lineWidth=1;
    for(let x=0;x<MAP_W;x+=50){
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,MAP_H); ctx.stroke();
    }
    for(let y=0;y<MAP_H;y+=50){
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(MAP_W,y); ctx.stroke();
    }

    // Spawn zones
    ctx.fillStyle='rgba(239,68,68,0.05)';
    ctx.fillRect(0,0,120,MAP_H);
    ctx.fillStyle='rgba(59,130,246,0.05)';
    ctx.fillRect(MAP_W-120,0,120,MAP_H);

    // Border
    ctx.strokeStyle='#6366f133';
    ctx.lineWidth=4;
    ctx.strokeRect(2,2,MAP_W-4,MAP_H-4);

    // ── Walls ──
    for(const w of walls){
      // Shadow
      ctx.fillStyle='rgba(0,0,0,0.5)';
      ctx.fillRect(w.x+4,w.y+4,w.w,w.h);
      // Body
      const wg=ctx.createLinearGradient(w.x,w.y,w.x+w.w,w.y+w.h);
      wg.addColorStop(0,'#2a2a4a');
      wg.addColorStop(1,'#1a1a2e');
      ctx.fillStyle=wg;
      ctx.fillRect(w.x,w.y,w.w,w.h);
      // Top highlight
      ctx.fillStyle='rgba(99,102,241,0.15)';
      ctx.fillRect(w.x,w.y,w.w,4);
      // Border
      ctx.strokeStyle='#6366f144';
      ctx.lineWidth=1;
      ctx.strokeRect(w.x,w.y,w.w,w.h);
    }

    // ── Mines ──
    for(const m of mines){
      ctx.save();
      ctx.translate(m.x,m.y);
      // Blink animation
      const blink=Math.sin(Date.now()/200)>0;
      ctx.beginPath(); ctx.arc(0,0,8,0,Math.PI*2);
      ctx.fillStyle=blink?m.color+'cc':'#1a1a1a';
      ctx.fill();
      ctx.strokeStyle=m.color;
      ctx.lineWidth=2; ctx.stroke();
      ctx.restore();
    }

    // ── Bullets ──
    for(const b of bullets){
      ctx.save();
      ctx.translate(b.x,b.y);
      // Glow
      ctx.beginPath(); ctx.arc(0,0,8,0,Math.PI*2);
      ctx.fillStyle=b.color+'33'; ctx.fill();
      // Core
      ctx.beginPath(); ctx.arc(0,0,4,0,Math.PI*2);
      ctx.fillStyle=b.color; ctx.fill();
      ctx.restore();
    }

    // ── Players ──
    for(const id in players){
      const p=players[id];
      drawPlayer(p, id===myId);
    }

    // ── Particles ──
    for(const p of particles){
      ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(0.5,p.r*p.life),0,Math.PI*2);
      ctx.fillStyle=p.color+Math.round(p.life*220).toString(16).padStart(2,'0');
      ctx.fill();
      p.x+=p.vx*dt; p.y+=p.vy*dt;
      p.vy+=0.08*dt; p.vx*=0.95; p.life-=0.025*dt;
    }
    particles=particles.filter(p=>p.life>0);

    ctx.restore(); // end world transform

    // ── Joysticks (screen space) ──
    if(gameState==='playing'){
      drawJoystick(moveJoy,'rgba(255,255,255,0.08)','rgba(255,255,255,0.25)');
      if(aimJoy.active) drawJoystick(aimJoy,'rgba(99,102,241,0.15)','rgba(99,102,241,0.5)');
      // Controls hint
      if(!moveJoy.active&&!aimJoy.active){
        ctx.font='10px monospace';
        ctx.fillStyle='rgba(255,255,255,0.08)';
        ctx.textAlign='center';
        ctx.fillText('LEFT: move',CW*0.25,CH-12);
        ctx.fillText('RIGHT: aim+fire · tap=ability',CW*0.72,CH-12);
      }
    }
  }

  animId=requestAnimationFrame(draw);
}

function drawPlayer(p, isSelf){
  if(!p.alive) return;
  const h=HEROES[p.heroKey]||HEROES.blaze;
  const isRed=p.team==='red';
  const teamColor=isRed?'#ef4444':'#3b82f6';

  ctx.save();
  ctx.translate(p.x,p.y);

  // Shadow
  ctx.beginPath(); ctx.ellipse(0,6,14,5,0,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fill();

  // Team glow
  if(isSelf){
    ctx.beginPath(); ctx.arc(0,0,26,0,Math.PI*2);
    ctx.fillStyle=teamColor+'22'; ctx.fill();
  }

  // Body
  ctx.beginPath(); ctx.arc(0,0,16,0,Math.PI*2);
  const bg=ctx.createRadialGradient(-5,-6,1,0,0,16);
  bg.addColorStop(0,lighten(h.color,50));
  bg.addColorStop(1,h.color);
  ctx.fillStyle=bg; ctx.fill();

  // Team ring
  ctx.beginPath(); ctx.arc(0,0,16,0,Math.PI*2);
  ctx.strokeStyle=teamColor;
  ctx.lineWidth=isSelf?2.5:1.5; ctx.stroke();

  // Hero icon (text)
  ctx.font='12px monospace';
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  ctx.fillText(h.icon,0,0);

  // HP bar
  const hpPct=Math.max(0,p.hp/p.maxHp);
  const bw=34;
  ctx.fillStyle='#0a0a14';
  ctx.fillRect(-bw/2,-24,bw,5);
  ctx.fillStyle=hpPct>0.5?'#34d399':hpPct>0.25?'#fbbf24':'#ef4444';
  ctx.fillRect(-bw/2,-24,bw*hpPct,5);
  ctx.strokeStyle='rgba(255,255,255,0.1)';
  ctx.lineWidth=0.5;
  ctx.strokeRect(-bw/2,-24,bw,5);

  // Name
  ctx.font=`${isSelf?'bold ':''}9px monospace`;
  ctx.fillStyle=isSelf?'#ffffff':'#a0a0b8';
  ctx.textBaseline='alphabetic';
  ctx.fillText(p.name,0,-27);

  // Ability ready indicator
  if(p.abilityCooldown===0){
    ctx.beginPath(); ctx.arc(0,0,19,0,Math.PI*2);
    ctx.strokeStyle=h.color+'88'; ctx.lineWidth=1.5;
    ctx.setLineDash([3,4]); ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.restore();
}

function drawJoystick(joy,bgColor,knobColor){
  if(!joy.active) return;
  const r=45, kr=18;
  ctx.beginPath(); ctx.arc(joy.startX,joy.startY,r,0,Math.PI*2);
  ctx.fillStyle=bgColor; ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=1; ctx.stroke();

  const dx=joy.curX-joy.startX, dy=joy.curY-joy.startY;
  const len=Math.sqrt(dx*dx+dy*dy);
  const kx=joy.startX+(len>r?dx/len*r:dx);
  const ky=joy.startY+(len>r?dy/len*r:dy);
  ctx.beginPath(); ctx.arc(kx,ky,kr,0,Math.PI*2);
  ctx.fillStyle=knobColor; ctx.fill();
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
