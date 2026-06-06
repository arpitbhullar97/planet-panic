const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use((req,res,next)=>{ res.setHeader('ngrok-skip-browser-warning','true'); next(); });

const server = http.createServer(app);
const io = new Server(server, { cors:{ origin:'*', methods:['GET','POST'] } });

const MAX_PLAYERS = 2;
const PLAYER_COLORS = ['#f97316','#6366f1'];
const ROPE_DECAY = 0.0008;
const TAP_FORCE  = 0.032;
const WIN_THRESHOLD = 0.04;
const TICK_RATE = 30;
const rooms = {};

function genCode(){ return Math.random().toString(36).substring(2,7).toUpperCase(); }

function mkPlayer(id,name,idx){
  return { id, name:name||'Player '+(idx+1), color:PLAYER_COLORS[idx], side:idx===0?'left':'right' };
}

function mkRoom(hostId,hostName){
  const code=genCode();
  return { code, hostId, players:{[hostId]:mkPlayer(hostId,hostName,0)},
    state:'waiting', ropePos:0.5, leftTaps:0, rightTaps:0, tickInterval:null };
}

function getLeftRight(room){
  const pList=Object.values(room.players);
  return { left:pList.find(p=>p.side==='left'), right:pList.find(p=>p.side==='right') };
}

function tickRoom(room){
  if(room.state!=='playing') return;
  if(room.ropePos<0.5) room.ropePos+=ROPE_DECAY;
  if(room.ropePos>0.5) room.ropePos-=ROPE_DECAY;
  io.to(room.code).emit('state',{ ropePos:room.ropePos, leftTaps:room.leftTaps, rightTaps:room.rightTaps });
  if(room.ropePos<=WIN_THRESHOLD){ const {left}=getLeftRight(room); endRound(room,left); }
  else if(room.ropePos>=1-WIN_THRESHOLD){ const {right}=getLeftRight(room); endRound(room,right); }
}

function startCountdown(room){
  room.state='countdown';
  let count=3;
  io.to(room.code).emit('countdown',{count});
  const iv=setInterval(()=>{
    count--;
    if(count>0) io.to(room.code).emit('countdown',{count});
    else { clearInterval(iv); startRound(room); }
  },1000);
}

function startRound(room){
  room.state='playing'; room.ropePos=0.5; room.leftTaps=0; room.rightTaps=0;
  const {left,right}=getLeftRight(room);
  io.to(room.code).emit('round_start',{ players:room.players, leftId:left?.id, rightId:right?.id });
  room.tickInterval=setInterval(()=>tickRoom(room),1000/TICK_RATE);
}

function endRound(room,winner){
  clearInterval(room.tickInterval);
  room.state='results';
  const loser=Object.values(room.players).find(p=>p.id!==winner?.id);
  io.to(room.code).emit('round_end',{
    winner:winner?{name:winner.name,color:winner.color,side:winner.side}:null,
    loserColor:loser?.color||'#888',
  });
  setTimeout(()=>{ room.state='waiting'; room.ropePos=0.5; io.to(room.code).emit('back_to_lobby',{}); },6000);
}

io.on('connection',socket=>{
  socket.on('create_room',({name})=>{
    const room=mkRoom(socket.id,name);
    rooms[room.code]=room; socket.join(room.code); socket.roomCode=room.code;
    socket.emit('room_created',{code:room.code,players:room.players,you:socket.id});
  });
  socket.on('join_room',({code,name})=>{
    const room=rooms[code.toUpperCase()];
    if(!room)                                         { socket.emit('error',{msg:'Room not found'}); return; }
    if(Object.keys(room.players).length>=MAX_PLAYERS) { socket.emit('error',{msg:'Room full — max 2 players'}); return; }
    if(room.state!=='waiting')                        { socket.emit('error',{msg:'Game already started'}); return; }
    const idx=Object.keys(room.players).length;
    room.players[socket.id]=mkPlayer(socket.id,name,idx);
    socket.join(code.toUpperCase()); socket.roomCode=code.toUpperCase();
    socket.emit('room_joined',{code:room.code,players:room.players,you:socket.id});
    io.to(room.code).emit('player_joined',{players:room.players});
  });
  socket.on('start_game',()=>{
    const room=rooms[socket.roomCode];
    if(!room||room.hostId!==socket.id) return;
    if(Object.keys(room.players).length<2){ socket.emit('error',{msg:'Need 2 players to start'}); return; }
    startCountdown(room);
  });
  socket.on('tap',()=>{
    const room=rooms[socket.roomCode];
    if(!room||room.state!=='playing') return;
    const p=room.players[socket.id]; if(!p) return;
    if(p.side==='left'){ room.ropePos=Math.max(0,room.ropePos-TAP_FORCE); room.leftTaps++; }
    else               { room.ropePos=Math.min(1,room.ropePos+TAP_FORCE); room.rightTaps++; }
    io.to(room.code).emit('tap_effect',{id:p.id,side:p.side,color:p.color});
  });
  socket.on('disconnect',()=>{
    const room=rooms[socket.roomCode]; if(!room) return;
    delete room.players[socket.id];
    io.to(room.code).emit('player_left',{players:room.players});
    if(Object.keys(room.players).length===0){ clearInterval(room.tickInterval); delete rooms[socket.roomCode]; }
  });
});

app.get('/',(req,res)=>res.send('Sumo Push server ✓'));
const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`Server on port ${PORT}`));
