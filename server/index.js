const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use((req, res, next) => { res.setHeader('ngrok-skip-browser-warning', 'true'); next(); });

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
});

// ─── Constants ────────────────────────────────────────────────
const W = 480, H = 640;
const PLATFORM_X = W / 2, PLATFORM_Y = H / 2 + 20;
const PLATFORM_START_R = 195;
const PLATFORM_MIN_R = 80;
const SHRINK_AMOUNT = 22;
const SHRINK_INTERVAL = 12000; // ms
const PLAYER_RADIUS = 13;
const DASH_FORCE = 28;
const DASH_COOLDOWN_TICKS = 18; // ~0.6s at 30fps
const FRICTION = 0.82;
const MAX_PLAYERS = 6;
const PLAYER_COLORS = ['#f6e05e','#f97316','#ec4899','#34d399','#60a5fa','#a78bfa'];
const rooms = {};

// ─── Helpers ──────────────────────────────────────────────────
function genCode() { return Math.random().toString(36).substring(2,7).toUpperCase(); }

function mkPlatform() {
  return { x: PLATFORM_X, y: PLATFORM_Y, radius: PLATFORM_START_R };
}

function mkPlayer(id, name, idx) {
  const angle = (idx / MAX_PLAYERS) * Math.PI * 2;
  const r = PLATFORM_START_R * 0.5;
  return {
    id, name: name || 'Player '+(idx+1),
    color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
    x: PLATFORM_X + Math.cos(angle) * r,
    y: PLATFORM_Y + Math.sin(angle) * r,
    vx: 0, vy: 0,
    alive: true,
    score: 0,
    dashCooldown: 0,
    rank: 0,
  };
}

function mkRoom(hostId, hostName) {
  const code = genCode();
  return {
    code, hostId,
    players: { [hostId]: mkPlayer(hostId, hostName, 0) },
    platform: mkPlatform(),
    state: 'waiting',
    tickInterval: null,
    shrinkInterval: null,
    deathRank: 0,
    totalPlayers: 1,
  };
}

// ─── Physics ──────────────────────────────────────────────────
function tickRoom(room) {
  if (room.state !== 'playing') return;
  const pList = Object.values(room.players);
  const alive = pList.filter(p => p.alive);
  const bumps = [];

  for (const p of pList) {
    if (!p.alive) continue;

    p.x += p.vx;
    p.y += p.vy;
    p.vx *= FRICTION;
    p.vy *= FRICTION;
    if (p.dashCooldown > 0) p.dashCooldown--;

    // Player vs Player collision
    for (const other of pList) {
      if (other.id === p.id || !other.alive) continue;
      const dx = other.x - p.x, dy = other.y - p.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const minDist = PLAYER_RADIUS * 2;
      if (dist < minDist && dist > 0) {
        const nx = dx/dist, ny = dy/dist;
        const overlap = minDist - dist;
        p.x -= nx * overlap * 0.5;
        p.y -= ny * overlap * 0.5;
        other.x += nx * overlap * 0.5;
        other.y += ny * overlap * 0.5;
        const relVx = p.vx - other.vx, relVy = p.vy - other.vy;
        const dot = relVx*nx + relVy*ny;
        if (dot > 0) {
          const impulse = dot * 1.1;
          p.vx -= impulse * nx; p.vy -= impulse * ny;
          other.vx += impulse * nx; other.vy += impulse * ny;
          bumps.push({ x: (p.x+other.x)/2, y: (p.y+other.y)/2, color: p.color, id: p.id });
        }
      }
    }

    // Fall off platform
    const pr = room.platform;
    const dx = p.x - pr.x, dy = p.y - pr.y;
    if (Math.sqrt(dx*dx + dy*dy) > pr.radius - PLAYER_RADIUS * 0.5) {
      p.alive = false;
      room.deathRank++;
      p.rank = room.deathRank;
      p.score = Math.max(0, alive.length - room.deathRank) * 10;
    }
  }

  const stillAlive = pList.filter(p => p.alive);
  if (stillAlive.length <= 1) {
    if (stillAlive.length === 1) {
      stillAlive[0].score = room.totalPlayers * 10 + 50;
      stillAlive[0].rank = 0;
    }
    endRound(room);
    return;
  }

  io.to(room.code).emit('state', {
    players: room.players,
    platform: room.platform,
    bumps: bumps.length ? bumps : undefined,
  });
}

// ─── Round lifecycle ──────────────────────────────────────────
function startCountdown(room) {
  room.state = 'countdown';
  let count = 3;
  io.to(room.code).emit('countdown', { count });
  const iv = setInterval(() => {
    count--;
    if (count > 0) io.to(room.code).emit('countdown', { count });
    else { clearInterval(iv); startRound(room); }
  }, 1000);
}

function startRound(room) {
  room.state = 'playing';
  room.platform = mkPlatform();
  room.deathRank = 0;
  const pList = Object.values(room.players);
  room.totalPlayers = pList.length;
  const spacing = (Math.PI * 2) / pList.length;
  pList.forEach((p, i) => {
    const angle = spacing * i - Math.PI / 2;
    const r = PLATFORM_START_R * 0.45;
    p.x = PLATFORM_X + Math.cos(angle) * r;
    p.y = PLATFORM_Y + Math.sin(angle) * r;
    p.vx = 0; p.vy = 0; p.alive = true;
    p.score = 0; p.dashCooldown = 0; p.rank = 0;
  });

  io.to(room.code).emit('round_start', { players: room.players, platform: room.platform });

  room.tickInterval = setInterval(() => tickRoom(room), 1000 / 30);
  room.shrinkInterval = setInterval(() => {
    if (room.state !== 'playing') return;
    room.platform.radius = Math.max(PLATFORM_MIN_R, room.platform.radius - SHRINK_AMOUNT);
    io.to(room.code).emit('platform_shrink', { platform: room.platform });
    if (room.platform.radius <= PLATFORM_MIN_R) clearInterval(room.shrinkInterval);
  }, SHRINK_INTERVAL);
}

function endRound(room) {
  clearInterval(room.tickInterval);
  clearInterval(room.shrinkInterval);
  room.state = 'results';
  const sorted = Object.values(room.players).sort((a,b) => b.score - a.score);
  const winner = sorted[0]?.score > 0 ? sorted[0] : null;
  io.to(room.code).emit('round_end', {
    winner: winner ? { name: winner.name, color: winner.color } : null,
    scores: sorted.map(p => ({ name: p.name, color: p.color, score: p.score, alive: p.alive })),
  });
  setTimeout(() => {
    room.state = 'waiting';
    io.to(room.code).emit('back_to_lobby', {});
  }, 5000);
}

// ─── Socket events ────────────────────────────────────────────
io.on('connection', socket => {
  console.log('+ connected:', socket.id);

  socket.on('create_room', ({ name }) => {
    const room = mkRoom(socket.id, name);
    rooms[room.code] = room;
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.emit('room_created', { code: room.code, players: room.players, you: socket.id });
  });

  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code.toUpperCase()];
    if (!room)                                         { socket.emit('error', { msg: 'Room not found' }); return; }
    if (Object.keys(room.players).length >= MAX_PLAYERS) { socket.emit('error', { msg: 'Room is full (max 6)' }); return; }
    if (room.state !== 'waiting')                      { socket.emit('error', { msg: 'Game already started' }); return; }
    const idx = Object.keys(room.players).length;
    room.players[socket.id] = mkPlayer(socket.id, name, idx);
    socket.join(code.toUpperCase());
    socket.roomCode = code.toUpperCase();
    socket.emit('room_joined', { code: room.code, players: room.players, you: socket.id });
    io.to(room.code).emit('player_joined', { players: room.players });
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    startCountdown(room);
  });

  socket.on('dash', ({ dir }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing') return;
    const p = room.players[socket.id];
    if (!p || !p.alive || p.dashCooldown > 0) return;
    p.vx += dir * DASH_FORCE;
    p.dashCooldown = DASH_COOLDOWN_TICKS;
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    delete room.players[socket.id];
    io.to(room.code).emit('player_left', { players: room.players });
    if (Object.keys(room.players).length === 0) {
      clearInterval(room.tickInterval);
      clearInterval(room.shrinkInterval);
      delete rooms[socket.roomCode];
    }
  });
});

app.get('/', (req, res) => res.send('Planet Panic server ✓'));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
