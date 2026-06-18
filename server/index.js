const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use((req,res,next)=>{ res.setHeader('ngrok-skip-browser-warning','true'); next(); });

const server = http.createServer(app);
const io = new Server(server, { cors:{ origin:'*', methods:['GET','POST'] } });

const W=800,H=800,TICK=1000/30;
const PLAYER_SPEED=5,PLAYER_RADIUS=18;
const BULLET_SPEED=12,BULLET_RADIUS=6,BULLET_LIFETIME=55;
const MAX_HP=100,MAX_PLAYERS=6,RESPAWN_DELAY=3000;

const HEROES={
  blaze: {name:'Blaze',role:'damage', color:'#ef4444',speed:5.5,hp:80, damage:12,fireRate:8, abilityCooldownMax:80, abilityName:'Burst Fire'},
  vault: {name:'Vault',role:'tank',   color:'#3b82f6',speed:3.5,hp:160,damage:18,fireRate:18,abilityCooldownMax:100,abilityName:'Charge'},
  pulse: {name:'Pulse',role:'support',color:'#34d399',speed:5.0,hp:90, damage:8, fireRate:10,abilityCooldownMax:110,abilityName:'Heal Burst'},
  shade: {name:'Shade',role:'assassin',color:'#a78bfa',speed:6.5,hp:70,damage:22,fireRate:14,abilityCooldownMax:90, abilityName:'Blink'},
  vex:   {name:'Vex',  role:'sniper', color:'#fbbf24',speed:4.0,hp:75, damage:35,fireRate:28,abilityCooldownMax:120,abilityName:'Pierce'},
  kova:  {name:'Kova', role:'trapper',color:'#f97316',speed:4.5,hp:85, damage:15,fireRate:12,abilityCooldownMax:45, abilityName:'Mine'},
};

const WALLS=[
  {x:160,y:160,w:80,h:80},{x:560,y:160,w:80,h:80},
  {x:160,y:560,w:80,h:80},{x:560,y:560,w:80,h:80},
  {x:350,y:280,w:100,h:40},{x:350,y:480,w:100,h:40},
  {x:100,y:350,w:40,h:100},{x:660,y:350,w:40,h:100},
];

const SPAWNS={
  red: [{x:80,y:80},{x:80,y:400},{x:80,y:720}],
  blue:[{x:720,y:80},{x:720,y:400},{x:720,y:720}],
};

const rooms={};
function genCode(){ return Math.random().toString(36).substring(2,7).toUpperCase(); }

function wallCollide(x,y,r){
  for(const w of WALLS){
    const cx=Math.max(w.x,Math.min(x,w.x+w.w));
    const cy=Math.max(w.y,Math.min(y,w.y+w.h));
    if((x-cx)**2+(y-cy)**2<r*r) return true;
  }
  return false;
}
function bulletHitWall(x,y){
  for(const w of WALLS){ if(x>=w.x&&x<=w.x+w.w&&y>=w.y&&y<=w.y+w.h) return true; }
  return false;
}

function mkPlayer(id,name,team,slot,heroKey){
  const h=HEROES[heroKey]||HEROES.blaze;
  const s=SPAWNS[team][slot%3];
  return {id,name:name||'Player',team,heroKey,hero:h,
    x:s.x,y:s.y,vx:0,vy:0,hp:h.hp,maxHp:h.hp,alive:true,
    fireCooldown:0,abilityCooldown:0,score:0};
}

function mkRoom(hostId){
  return {code:genCode(),hostId,players:{},bullets:[],mines:[],
    state:'waiting',tickInterval:null,scores:{red:0,blue:0},roundNum:0};
}

function serializePlayers(room){
  const out={};
  for(const p of Object.values(room.players)){
    out[p.id]={id:p.id,name:p.name,team:p.team,heroKey:p.heroKey,
      x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,alive:p.alive,
      color:p.hero.color,score:p.score,
      abilityCooldown:p.abilityCooldown,
      abilityCooldownMax:p.hero.abilityCooldownMax,
      fireCooldown:p.fireCooldown};
  }
  return out;
}

function tick(room){
  if(room.state!=='playing') return;
  const pList=Object.values(room.players);
  const effects=[];

  for(const p of pList){
    if(!p.alive) continue;
    if(p.fireCooldown>0) p.fireCooldown--;
    if(p.abilityCooldown>0) p.abilityCooldown--;
    const nx=Math.max(PLAYER_RADIUS,Math.min(W-PLAYER_RADIUS,p.x+p.vx*p.hero.speed));
    const ny=Math.max(PLAYER_RADIUS,Math.min(H-PLAYER_RADIUS,p.y+p.vy*p.hero.speed));
    if(!wallCollide(nx,p.y,PLAYER_RADIUS)) p.x=nx;
    if(!wallCollide(p.x,ny,PLAYER_RADIUS)) p.y=ny;
  }

  const aliveBullets=[];
  for(const b of room.bullets){
    b.x+=b.vx; b.y+=b.vy; b.life--;
    if(b.life<=0||b.x<0||b.x>W||b.y<0||b.y>H||bulletHitWall(b.x,b.y)) continue;
    let hit=false;
    for(const p of pList){
      if(!p.alive||p.id===b.ownerId||p.team===b.ownerTeam) continue;
      if((p.x-b.x)**2+(p.y-b.y)**2<(PLAYER_RADIUS+BULLET_RADIUS)**2){
        p.hp-=b.damage; effects.push({type:'hit',x:b.x,y:b.y,color:b.color});
        if(p.hp<=0){
          p.alive=false; p.hp=0;
          const k=room.players[b.ownerId]; if(k) k.score++;
          effects.push({type:'death',x:p.x,y:p.y,color:p.hero.color});
          setTimeout(()=>{
            if(room.state!=='playing') return;
            const slot=pList.filter(pp=>pp.team===p.team).indexOf(p);
            const s=SPAWNS[p.team][slot%3];
            p.x=s.x;p.y=s.y;p.hp=p.maxHp;p.alive=true;
            io.to(room.code).emit('respawn',{id:p.id});
          },RESPAWN_DELAY);
        }
        if(!b.pierce){hit=true;break;}
      }
    }
    if(!hit||b.pierce) aliveBullets.push(b);
  }
  room.bullets=aliveBullets;

  for(const m of room.mines){
    if(m.triggered) continue;
    for(const p of pList){
      if(!p.alive||p.team===m.ownerTeam) continue;
      if((p.x-m.x)**2+(p.y-m.y)**2<(PLAYER_RADIUS+12)**2){
        m.triggered=true; p.hp-=40;
        effects.push({type:'explosion',x:m.x,y:m.y,color:'#f97316'});
        if(p.hp<=0){ p.alive=false; p.hp=0; effects.push({type:'death',x:p.x,y:p.y,color:p.hero.color});
          setTimeout(()=>{if(room.state!=='playing')return;const s=SPAWNS[p.team][0];p.x=s.x;p.y=s.y;p.hp=p.maxHp;p.alive=true;io.to(room.code).emit('respawn',{id:p.id});},RESPAWN_DELAY);
        }
      }
    }
  }
  room.mines=room.mines.filter(m=>!m.triggered);

  const redScore=pList.filter(p=>p.team==='red').reduce((s,p)=>s+p.score,0);
  const blueScore=pList.filter(p=>p.team==='blue').reduce((s,p)=>s+p.score,0);

  io.to(room.code).emit('state',{
    players:serializePlayers(room),
    bullets:room.bullets.map(b=>({x:b.x,y:b.y,color:b.color,id:b.id})),
    mines:room.mines.map(m=>({x:m.x,y:m.y,color:m.color,id:m.id})),
    effects, scores:{red:redScore,blue:blueScore},
  });

  if(redScore>=5||blueScore>=5) endRound(room,redScore>=5?'red':'blue');
}

function startRound(room){
  room.state='playing'; room.bullets=[]; room.mines=[]; room.roundNum++;
  const pList=Object.values(room.players);
  const red=pList.filter(p=>p.team==='red');
  const blue=pList.filter(p=>p.team==='blue');
  red.forEach((p,i)=>{ const s=SPAWNS.red[i%3];p.x=s.x;p.y=s.y;p.hp=p.maxHp;p.alive=true;p.score=0;p.fireCooldown=0;p.abilityCooldown=0; });
  blue.forEach((p,i)=>{ const s=SPAWNS.blue[i%3];p.x=s.x;p.y=s.y;p.hp=p.maxHp;p.alive=true;p.score=0;p.fireCooldown=0;p.abilityCooldown=0; });
  io.to(room.code).emit('round_start',{players:serializePlayers(room),walls:WALLS,mapSize:{w:W,h:H}});
  room.tickInterval=setInterval(()=>tick(room),TICK);
}

function endRound(room,winTeam){
  clearInterval(room.tickInterval); room.state='results';
  room.scores[winTeam]++;
  io.to(room.code).emit('round_end',{winTeam,scores:room.scores});
  setTimeout(()=>{
    if(room.scores.red>=2||room.scores.blue>=2){
      io.to(room.code).emit('match_end',{winTeam,scores:room.scores});
      setTimeout(()=>{ room.state='waiting';room.scores={red:0,blue:0};io.to(room.code).emit('back_to_lobby',{}); },5000);
    } else { startRound(room); }
  },3000);
}

io.on('connection',socket=>{
  socket.on('create_room',({name,heroKey})=>{
    const room=mkRoom(socket.id); rooms[room.code]=room;
    socket.join(room.code); socket.roomCode=room.code;
    room.players[socket.id]=mkPlayer(socket.id,name,'red',0,heroKey||'blaze');
    socket.emit('room_created',{code:room.code,players:serializePlayers(room),you:socket.id,team:'red'});
  });

  socket.on('join_room',({code,name,heroKey})=>{
    const room=rooms[code.toUpperCase()];
    if(!room){ socket.emit('error',{msg:'Room not found'}); return; }
    if(Object.keys(room.players).length>=MAX_PLAYERS){ socket.emit('error',{msg:'Room full'}); return; }
    if(room.state!=='waiting'){ socket.emit('error',{msg:'Match in progress'}); return; }
    const all=Object.values(room.players);
    const red=all.filter(p=>p.team==='red').length;
    const blue=all.filter(p=>p.team==='blue').length;
    const team=red<=blue?'red':'blue';
    const slot=team==='red'?red:blue;
    room.players[socket.id]=mkPlayer(socket.id,name,team,slot,heroKey||'blaze');
    socket.join(code.toUpperCase()); socket.roomCode=code.toUpperCase();
    socket.emit('room_joined',{code:room.code,players:serializePlayers(room),you:socket.id,team});
    io.to(room.code).emit('player_joined',{players:serializePlayers(room)});
  });

  socket.on('start_game',()=>{
    const room=rooms[socket.roomCode];
    if(!room||room.hostId!==socket.id) return;
    if(Object.keys(room.players).length<2){ socket.emit('error',{msg:'Need 2+ players'}); return; }
    startRound(room);
  });

  socket.on('move',({vx,vy})=>{
    const room=rooms[socket.roomCode]; if(!room||room.state!=='playing') return;
    const p=room.players[socket.id]; if(!p||!p.alive) return;
    p.vx=Math.max(-1,Math.min(1,vx)); p.vy=Math.max(-1,Math.min(1,vy));
  });

  socket.on('fire',({targetX,targetY})=>{
    const room=rooms[socket.roomCode]; if(!room||room.state!=='playing') return;
    const p=room.players[socket.id]; if(!p||!p.alive||p.fireCooldown>0) return;
    const dx=targetX-p.x,dy=targetY-p.y,len=Math.sqrt(dx*dx+dy*dy)||1;
    room.bullets.push({id:Math.random().toString(36).slice(2),
      x:p.x,y:p.y,vx:(dx/len)*BULLET_SPEED,vy:(dy/len)*BULLET_SPEED,
      ownerId:p.id,ownerTeam:p.team,damage:p.hero.damage,color:p.hero.color,life:BULLET_LIFETIME});
    p.fireCooldown=p.hero.fireRate;
  });

  socket.on('ability',({targetX,targetY})=>{
    const room=rooms[socket.roomCode]; if(!room||room.state!=='playing') return;
    const p=room.players[socket.id]; if(!p||!p.alive||p.abilityCooldown>0) return;
    const pList=Object.values(room.players);
    switch(p.heroKey){
      case 'shade':{ const dx=targetX-p.x,dy=targetY-p.y,len=Math.sqrt(dx*dx+dy*dy)||1,dist=Math.min(160,len);
        const nx=p.x+(dx/len)*dist,ny=p.y+(dy/len)*dist;
        if(!wallCollide(nx,ny,PLAYER_RADIUS)&&nx>0&&nx<W&&ny>0&&ny<H){p.x=nx;p.y=ny;} p.abilityCooldown=90; break; }
      case 'vex':{ const dx=targetX-p.x,dy=targetY-p.y,len=Math.sqrt(dx*dx+dy*dy)||1;
        room.bullets.push({id:Math.random().toString(36).slice(2),x:p.x,y:p.y,
          vx:(dx/len)*BULLET_SPEED*1.6,vy:(dy/len)*BULLET_SPEED*1.6,
          ownerId:p.id,ownerTeam:p.team,damage:55,color:'#fbbf24',life:BULLET_LIFETIME*2,pierce:true});
        p.abilityCooldown=120; break; }
      case 'kova':{ room.mines.push({id:Math.random().toString(36).slice(2),
        x:p.x+(Math.random()-.5)*40,y:p.y+(Math.random()-.5)*40,
        ownerTeam:p.team,color:'#f97316',triggered:false}); p.abilityCooldown=45; break; }
      case 'vault':{ const dx=targetX-p.x,dy=targetY-p.y,len=Math.sqrt(dx*dx+dy*dy)||1;
        p.vx=(dx/len)*3;p.vy=(dy/len)*3; p.abilityCooldown=100; break; }
      case 'blaze':{ const dx=targetX-p.x,dy=targetY-p.y,len=Math.sqrt(dx*dx+dy*dy)||1;
        const base=Math.atan2(dy,dx);
        for(let i=-2;i<=2;i++) room.bullets.push({id:Math.random().toString(36).slice(2),
          x:p.x,y:p.y,vx:Math.cos(base+i*.15)*BULLET_SPEED*1.2,vy:Math.sin(base+i*.15)*BULLET_SPEED*1.2,
          ownerId:p.id,ownerTeam:p.team,damage:10,color:'#ef4444',life:BULLET_LIFETIME});
        p.abilityCooldown=80; break; }
      case 'pulse':{ for(const o of pList){
          if(o.team!==p.team||!o.alive) continue;
          if((o.x-p.x)**2+(o.y-p.y)**2<200*200) o.hp=Math.min(o.maxHp,o.hp+30);
        } io.to(room.code).emit('effects',[{type:'heal',x:p.x,y:p.y,color:'#34d399'}]);
        p.abilityCooldown=110; break; }
    }
  });

  socket.on('disconnect',()=>{
    const room=rooms[socket.roomCode]; if(!room) return;
    delete room.players[socket.id];
    if(Object.keys(room.players).length===0){ clearInterval(room.tickInterval); delete rooms[socket.roomCode]; }
    else io.to(room.code).emit('player_left',{players:serializePlayers(room)});
  });
});

app.get('/',(req,res)=>res.send('Brawlshift server ✓'));
const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`Brawlshift on port ${PORT}`));
