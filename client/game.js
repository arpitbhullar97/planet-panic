// ─── Config ───────────────────────────────────────────────────
const SERVER_URL = 'https://planet-panic-production.up.railway.app';

// ─── State ────────────────────────────────────────────────────
let socket=null, myId=null, roomCode=null, isHost=false;
let gameState='home';
let players={};
let ropePos=0.5;       // 0=left wins, 1=right wins, 0.5=center
let leftId=null, rightId=null;
let particles=[], stars=[], animId, lastTime=0;
let shakeX=0, shakeTimer=0;
let roundWinner=null;
let ropePulse=0;
let groundY=0;
let leftTaps=0, rightTaps=0; // visual feedback only

const W=480, H=640;
const canvas=document.getElementById('gc');
const ctx=canvas.getContext('2d');

function resizeCanvas(){
  const maxW=Math.min(window.innerWidth,W);
  const maxH=Math.min(window.innerHeight,H);
  let w=maxW, h=maxW*(H/W);
  if(h>maxH){h=maxH;w=h*(W/H);}
  canvas.width=W; canvas.height=H;
  canvas.style.width=w+'px'; canvas.style.height=h+'px';
}
resizeCanvas();
window.addEventListener('resize',resizeCanvas);

// ─── Stars ────────────────────────────────────────────────────
function mkStars(){
  stars=[];
  for(let i=0;i<80;i++) stars.push({
    x:Math.random()*W, y:Math.random()*H*0.5,
    r:Math.random()*1.3+0.2, a:Math.random()*0.5+0.1,
    tw:Math.random()*Math.PI*2, spd:Math.random()*0.02+0.005
  });
}
mkStars();

// ─── Screen helpers ───────────────────────────────────────────
function hideAllScreens(){
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('tap-hint').classList.add('hidden');
}
function showScreen(id){
  hideAllScreens();
  if(id) document.getElementById(id).classList.remove('hidden');
}
function showHUD(show){ document.getElementById('hud').classList.toggle('hidden',!show); }
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2500);
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
    const div=document.createElement('div');
    div.className='player-item';
    div.innerHTML=`<div class="player-dot" style="background:${p.color}"></div>
      <span>${p.name}</span>${i===0?'<span class="player-host">host</span>':''}`;
    list.appendChild(div);
  });
}

// ─── UI actions ───────────────────────────────────────────────
function getName(){ return document.getElementById('input-name').value.trim()||'Player'; }
function goCreate(){ connectSocket(); socket.emit('create_room',{name:getName()}); }
function goJoin(){ connectSocket(); showScreen('screen-join'); }
function joinRoom(){
  const code=document.getElementById('input-code').value.trim().toUpperCase();
  if(code.length<5){showToast('Enter full room code');return;}
  socket.emit('join_room',{code,name:getName()});
}
function startGame(){ socket.emit('start_game'); }
function leaveRoom(){
  if(socket) socket.disconnect();
  socket=null; myId=null; roomCode=null; isHost=false; players={};
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
    roomCode=data.code; myId=data.you; isHost=true;
    players=data.players; gameState='lobby';
    setupLobbyScreen(); startRenderLoop();
  });
  socket.on('room_joined',(data)=>{
    roomCode=data.code; myId=data.you; isHost=false;
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
    players=data.players;
    leftId=data.leftId; rightId=data.rightId;
    ropePos=0.5; leftTaps=0; rightTaps=0;
    roundWinner=null; particles=[];
    gameState='playing';
    hideAllScreens(); showHUD(true);
    document.getElementById('tap-hint').classList.remove('hidden');
    // Update player name labels
    const lp=players[leftId], rp=players[rightId];
    document.getElementById('left-name').textContent=lp?lp.name:'';
    document.getElementById('right-name').textContent=rp?rp.name:'';
    document.getElementById('left-taps').textContent='';
    document.getElementById('right-taps').textContent='';
  });

  socket.on('state',(data)=>{
    if(gameState!=='playing') return;
    const prev=ropePos;
    ropePos=data.ropePos;
    // Pulse rope on movement
    if(Math.abs(ropePos-prev)>0.003) ropePulse=1;
    // Shake when near edge
    if(ropePos<0.1||ropePos>0.9) triggerShake(3,6);
    document.getElementById('left-taps').textContent=data.leftTaps||'';
    document.getElementById('right-taps').textContent=data.rightTaps||'';
  });

  socket.on('tap_effect',(data)=>{
    // Visual tap burst
    const isLeft=data.side==='left';
    const x=isLeft?120:360, y=groundY-80;
    spawnTapBurst(x,y,data.color);
    if(data.side==='left') leftTaps++;
    else rightTaps++;
    if(data.id===myId) triggerShake(2,4);
  });

  socket.on('round_end',(data)=>{
    gameState='results'; roundWinner=data.winner;
    // Big explosion at loser side
    const loserX=data.winner.side==='left'?360:120;
    spawnExplosion(loserX,groundY-80,data.loserColor);
    triggerShake(14,30);
    setTimeout(()=>{
      hideAllScreens();
      document.getElementById('screen-results').classList.remove('hidden');
      document.getElementById('winner-name').textContent=data.winner.name.toUpperCase();
      document.getElementById('winner-name').style.color=data.winner.color;
      const el=document.getElementById('results-scores');
      el.innerHTML=`<div class="score-row">
        <span class="player-dot" style="background:${data.winner.color};display:inline-block;border-radius:50%;flex-shrink:0;"></span>
        <span class="score-name">${data.winner.name}</span>
        <span class="score-pts">👑 winner</span>
      </div>`;
    },1200);
  });

  socket.on('back_to_lobby',()=>{ gameState='lobby'; setupLobbyScreen(); });
  socket.on('error',(data)=>{ showToast(data.msg); });
  socket.on('disconnect',()=>{
    showToast('Disconnected'); hideAllScreens();
    showScreen('screen-home'); gameState='home'; socket=null;
  });
}

// ─── Input — tap to push ──────────────────────────────────────
function doTap(){
  if(gameState!=='playing') return;
  socket.emit('tap');
}

// Tap anywhere on YOUR half of the screen
canvas.addEventListener('touchstart',e=>{
  e.preventDefault();
  doTap();
},{passive:false});

canvas.addEventListener('click',()=>{ doTap(); });
window.addEventListener('keydown',e=>{
  if(e.key===' '||e.key==='ArrowLeft'||e.key==='ArrowRight'||
     e.key==='a'||e.key==='d') doTap();
});

// ─── Effects ──────────────────────────────────────────────────
function triggerShake(intensity,frames){
  shakeX=intensity; shakeTimer=frames;
}
function spawnTapBurst(x,y,color){
  for(let i=0;i<8;i++){
    const a=Math.random()*Math.PI*2, spd=1+Math.random()*4;
    particles.push({x,y,vx:Math.cos(a)*spd,vy:Math.sin(a)*spd-2,
      life:0.7,color,r:2+Math.random()*3});
  }
}
function spawnExplosion(x,y,color){
  for(let i=0;i<30;i++){
    const a=(i/30)*Math.PI*2, spd=2+Math.random()*8;
    particles.push({x,y,vx:Math.cos(a)*spd,vy:Math.sin(a)*spd,
      life:1,color,r:3+Math.random()*5});
  }
  particles.push({x,y,vx:0,vy:0,life:0.4,color:'#ffffff',r:30});
}

// ─── Draw ─────────────────────────────────────────────────────
function drawSumo(x,y,color,facing,squish,isMe){
  // squish = 0 normal, 1 = squished (during push)
  const sx=1+squish*0.3, sy=1-squish*0.15;
  ctx.save();
  ctx.translate(x,y);
  ctx.scale(sx,sy);

  // Shadow
  ctx.beginPath();
  ctx.ellipse(0,2,26,8,0,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,0.35)'; ctx.fill();

  // Body — big round sumo
  const bodyGrd=ctx.createRadialGradient(-8,-10,2,0,0,34);
  bodyGrd.addColorStop(0,lighten(color,60));
  bodyGrd.addColorStop(1,color);
  ctx.beginPath(); ctx.arc(0,0,32,0,Math.PI*2);
  ctx.fillStyle=bodyGrd; ctx.fill();

  // Belt (mawashi)
  ctx.beginPath();
  ctx.ellipse(0,8,22,10,0,0,Math.PI*2);
  ctx.fillStyle=darken(color,60); ctx.fill();
  // Belt knot
  ctx.beginPath(); ctx.arc(facing>0?10:-10,8,6,0,Math.PI*2);
  ctx.fillStyle=darken(color,80); ctx.fill();

  // Face
  const fx=facing*8;
  // Eyes
  ctx.beginPath(); ctx.arc(fx-6,-8,5,0,Math.PI*2);
  ctx.fillStyle='#fff'; ctx.fill();
  ctx.beginPath(); ctx.arc(fx+6,-8,5,0,Math.PI*2);
  ctx.fillStyle='#fff'; ctx.fill();
  ctx.beginPath(); ctx.arc(fx-6+facing*2,-8,2.5,0,Math.PI*2);
  ctx.fillStyle='#1a1a2e'; ctx.fill();
  ctx.beginPath(); ctx.arc(fx+6+facing*2,-8,2.5,0,Math.PI*2);
  ctx.fillStyle='#1a1a2e'; ctx.fill();

  // Determined eyebrows
  ctx.strokeStyle='#1a1a2e'; ctx.lineWidth=2.5; ctx.lineCap='round';
  ctx.beginPath();
  ctx.moveTo(fx-10,-14); ctx.lineTo(fx-3,-12); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(fx+3,-12); ctx.lineTo(fx+10,-14); ctx.stroke();

  // Mouth
  ctx.beginPath();
  ctx.arc(fx,0,6,0.2,Math.PI-0.2);
  ctx.strokeStyle='#1a1a2e'; ctx.lineWidth=2; ctx.stroke();

  // Arms stretched forward
  ctx.strokeStyle=color; ctx.lineWidth=12; ctx.lineCap='round';
  ctx.beginPath();
  ctx.moveTo(facing*20,-5);
  ctx.lineTo(facing*38,4);
  ctx.stroke();
  // Fist
  ctx.beginPath(); ctx.arc(facing*40,4,7,0,Math.PI*2);
  ctx.fillStyle=lighten(color,40); ctx.fill();

  // Topknot
  ctx.beginPath();
  ctx.ellipse(0,-34,5,8,0,0,Math.PI*2);
  ctx.fillStyle='#1a1a2e'; ctx.fill();
  ctx.beginPath(); ctx.arc(0,-36,3,0,Math.PI*2);
  ctx.fillStyle='#333'; ctx.fill();

  // Self ring
  if(isMe){
    ctx.beginPath(); ctx.arc(0,0,36,0,Math.PI*2);
    ctx.strokeStyle=color+'88'; ctx.lineWidth=2; ctx.stroke();
  }

  ctx.restore();
}

function draw(ts){
  const dt=Math.min((ts-lastTime)/16.67,2.5);
  lastTime=ts;

  let sx=0,sy=0;
  if(shakeTimer>0){
    sx=(Math.random()-0.5)*shakeX;
    sy=(Math.random()-0.5)*shakeX*0.5;
    shakeTimer-=dt; shakeX*=0.85;
  }

  ctx.clearRect(0,0,W,H);
  ctx.save();
  ctx.translate(sx,sy);

  // ── Sky background ──
  const skyGrd=ctx.createLinearGradient(0,0,0,H*0.65);
  skyGrd.addColorStop(0,'#0d0d1a');
  skyGrd.addColorStop(1,'#1a1030');
  ctx.fillStyle=skyGrd; ctx.fillRect(-10,-10,W+20,H*0.65+10);

  // Stars
  for(const s of stars){
    s.tw+=s.spd*dt;
    const a=s.a*(0.6+0.4*Math.sin(s.tw));
    ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2);
    ctx.fillStyle=`rgba(220,220,255,${a})`; ctx.fill();
  }

  // ── Ground / arena ──
  groundY=H*0.62;
  // Dirt ground
  const groundGrd=ctx.createLinearGradient(0,groundY,0,H);
  groundGrd.addColorStop(0,'#2d1f0e');
  groundGrd.addColorStop(0.3,'#1a1208');
  groundGrd.addColorStop(1,'#0a0804');
  ctx.fillStyle=groundGrd; ctx.fillRect(-10,groundY,W+20,H-groundY+10);

  // Arena circle (dohyo)
  const arenaX=W/2, arenaY=groundY+10, arenaRX=200, arenaRY=55;
  // Sand
  ctx.beginPath(); ctx.ellipse(arenaX,arenaY,arenaRX,arenaRY,0,0,Math.PI*2);
  const sandGrd=ctx.createRadialGradient(arenaX,arenaY,20,arenaX,arenaY,arenaRX);
  sandGrd.addColorStop(0,'#c8a86a');
  sandGrd.addColorStop(0.7,'#b8944a');
  sandGrd.addColorStop(1,'#a07830');
  ctx.fillStyle=sandGrd; ctx.fill();
  // Straw border
  ctx.beginPath(); ctx.ellipse(arenaX,arenaY,arenaRX,arenaRY,0,0,Math.PI*2);
  ctx.strokeStyle='#7a5a20'; ctx.lineWidth=8; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(arenaX,arenaY,arenaRX-4,arenaRY-2,0,0,Math.PI*2);
  ctx.strokeStyle='#c8a040'; ctx.lineWidth=3; ctx.stroke();
  // Center line
  ctx.beginPath(); ctx.moveTo(arenaX,arenaY-arenaRY+8); ctx.lineTo(arenaX,arenaY+arenaRY-8);
  ctx.strokeStyle='#7a5a2044'; ctx.lineWidth=2; ctx.stroke();

  // ── Rope / tug bar ──
  if(gameState==='playing'||gameState==='results'){
    ropePulse=Math.max(0,ropePulse-0.05*dt);
    const barY=groundY-160;
    const barL=60, barR=W-60;
    const barLen=barR-barL;

    // Bar track
    ctx.beginPath(); ctx.moveTo(barL,barY); ctx.lineTo(barR,barY);
    ctx.strokeStyle='#2a1a0a'; ctx.lineWidth=12; ctx.lineCap='round'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(barL,barY); ctx.lineTo(barR,barY);
    ctx.strokeStyle='#5a3a10'; ctx.lineWidth=8; ctx.lineCap='round'; ctx.stroke();

    // Left fill (left player color)
    const lp=players[leftId];
    const rp=players[rightId];
    const fillX=barL+ropePos*barLen;
    if(lp){
      ctx.beginPath(); ctx.moveTo(barL,barY); ctx.lineTo(fillX,barY);
      ctx.strokeStyle=lp.color; ctx.lineWidth=8; ctx.lineCap='round'; ctx.stroke();
    }
    if(rp){
      ctx.beginPath(); ctx.moveTo(fillX,barY); ctx.lineTo(barR,barY);
      ctx.strokeStyle=rp.color; ctx.lineWidth=8; ctx.lineCap='round'; ctx.stroke();
    }

    // Danger zones
    ctx.beginPath(); ctx.moveTo(barL,barY); ctx.lineTo(barL+barLen*0.15,barY);
    ctx.strokeStyle='rgba(239,68,68,0.4)'; ctx.lineWidth=8; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(barR-barLen*0.15,barY); ctx.lineTo(barR,barY);
    ctx.strokeStyle='rgba(239,68,68,0.4)'; ctx.lineWidth=8; ctx.stroke();

    // Knot (rope marker)
    const kx=barL+ropePos*barLen;
    const glow=0.5+ropePulse*0.5;
    ctx.beginPath(); ctx.arc(kx,barY,14,0,Math.PI*2);
    ctx.fillStyle=`rgba(255,255,255,${glow*0.15})`; ctx.fill();
    ctx.beginPath(); ctx.arc(kx,barY,10,0,Math.PI*2);
    ctx.fillStyle='#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(kx,barY,10,0,Math.PI*2);
    ctx.strokeStyle='#888'; ctx.lineWidth=2; ctx.stroke();
    // Knot detail
    ctx.beginPath(); ctx.arc(kx-2,barY-2,3,0,Math.PI*2);
    ctx.fillStyle='#ccc'; ctx.fill();

    // Edge markers
    ctx.fillStyle='rgba(239,68,68,0.8)';
    ctx.font='bold 11px monospace'; ctx.textAlign='center';
    ctx.fillText('OUT',barL,barY-18);
    ctx.fillText('OUT',barR,barY-18);

    // Arrow hints showing who's winning
    if(ropePos<0.45&&lp){
      ctx.fillStyle=lp.color+'cc';
      ctx.font='16px monospace'; ctx.textAlign='center';
      ctx.fillText('◀◀',kx-20,barY-28);
    } else if(ropePos>0.55&&rp){
      ctx.fillStyle=rp.color+'cc';
      ctx.font='16px monospace'; ctx.textAlign='center';
      ctx.fillText('▶▶',kx+20,barY-28);
    }
  }

  // ── Sumo wrestlers ──
  if(gameState==='playing'||gameState==='results'){
    const lp=players[leftId], rp=players[rightId];
    // Player positions driven by ropePos
    // ropePos 0.5 = center, <0.5 = left winning, >0.5 = right winning
    const baseGap=100;
    const push=(ropePos-0.5)*2; // -1 to 1
    const leftX=W/2-baseGap+push*60;
    const rightX=W/2+baseGap+push*60;
    const sy2=groundY-42;
    const squish=Math.abs(push)*0.5;

    if(lp) drawSumo(leftX,sy2,lp.color,1,squish,leftId===myId);
    if(rp) drawSumo(rightX,sy2,rp.color,-1,squish,rightId===myId);

    // Tap zone indicators
    const isLeft=myId===leftId;
    ctx.fillStyle='rgba(255,255,255,0.03)';
    ctx.fillRect(0,H-80,W,80);
    ctx.font='bold 13px monospace'; ctx.textAlign='center';
    ctx.fillStyle='rgba(255,255,255,0.15)';
    ctx.fillText('TAP ANYWHERE TO PUSH',W/2,H-48);
    ctx.font='11px monospace';
    ctx.fillStyle='rgba(255,255,255,0.08)';
    ctx.fillText(isLeft?'YOU ARE LEFT':'YOU ARE RIGHT',W/2,H-26);
  }

  // ── Particles ──
  for(const p of particles){
    ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(0.5,p.r*p.life),0,Math.PI*2);
    const alpha=Math.round(p.life*220).toString(16).padStart(2,'0');
    ctx.fillStyle=p.color+alpha; ctx.fill();
    p.x+=p.vx*dt; p.y+=p.vy*dt;
    p.vy+=0.15*dt; p.vx*=0.95;
    p.life-=0.025*dt;
  }
  particles=particles.filter(p=>p.life>0);

  ctx.restore();
  animId=requestAnimationFrame(draw);
}

function lighten(hex,amt){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgb(${Math.min(255,r+amt)},${Math.min(255,g+amt)},${Math.min(255,b+amt)})`;
}
function darken(hex,amt){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgb(${Math.max(0,r-amt)},${Math.max(0,g-amt)},${Math.max(0,b-amt)})`;
}
function startRenderLoop(){
  if(animId) cancelAnimationFrame(animId);
  lastTime=performance.now();
  animId=requestAnimationFrame(draw);
}
startRenderLoop();
