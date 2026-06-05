const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

// ─── Constants ────────────────────────────────────────────────
const W = 480, H = 640;
const FLOOR_Y = H - 60;
const PLAYER_SPEED = 7;
const MAX_PLAYERS = 4;
const PLAYER_COLORS = ['#f6e05e','#f97316','#ec4899','#34d399'];

// ─── Rooms ────────────────────────────────────────────────────
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2,7).toUpperCase();
}

function spawnAsteroid(difficulty) {
  const radius = 14 + Math.random() * 22;
  const offsets = Array.from({length:8}, () => Math.random());
  return {
    id: Math.random().toString(36).slice(2),
    x: radius + Math.random() * (W - radius*2),
    y: -radius,
    radius,
    speed: (2.5 + difficulty * 0.4) * (0.8 + Math.random() * 0.6),
    rot: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.05,
    offsets,
  };
}

function createPlayer(id, name, colorIndex) {
  const slot = colorIndex % MAX_PLAYERS;
  const spacing = W / (MAX_PLAYERS + 1);
  return {
    id, name: name || 'Player '+(colorIndex+1),
    color: PLAYER_COLORS[slot],
    x: spacing * (slot + 1),
    y: FLOOR_Y - 20,
    alive: true,
    score: 0,
  };
}

function createRoom(hostId, hostName) {
  const code = generateRoomCode();
  return {
    code, hostId,
    players: { [hostId]: createPlayer(hostId, hostName, 0) },
    asteroids: [],
    state: 'waiting',
    difficulty: 0,
    spawnTimer: 0,
    tickInterval: null,
    timerInterval: null,
    roundTimer: 0,
  };
}

// ─── Game tick ────────────────────────────────────────────────
function tickRoom(room) {
  if (room.state !== 'playing') return;
  const players = Object.values(room.players);
  const alive = players.filter(p => p.alive);

  // Spawn asteroids
  room.spawnTimer--;
  if (room.spawnTimer <= 0) {
    room.asteroids.push(spawnAsteroid(room.difficulty));
    // Spawn interval shrinks as difficulty grows
    room.spawnTimer = Math.max(8, 28 - Math.floor(room.difficulty * 2));
  }

  // Move asteroids
  for (const a of room.asteroids) {
    a.y += a.speed;
    a.rot += a.rotSpeed;
  }

  // Collision — asteroid vs player
  for (const a of room.asteroids) {
    for (const p of players) {
      if (!p.alive) continue;
      const dx = p.x - a.x, dy = p.y - a.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < a.radius + 10) {
        p.alive = false;
      }
    }
  }

  // Score — +1 per second survived
  for (const p of alive) p.score++;

  // Remove asteroids off screen
  room.asteroids = room.asteroids.filter(a => a.y < H + 60);

  // Ramp difficulty over time
  room.difficulty += 0.005;

  // End if everyone dead or 1 left in multiplayer
  const stillAlive = players.filter(p => p.alive);
  if (stillAlive.length === 0 || (players.length > 1 && stillAlive.length <= 1)) {
    endRound(room);
  }
}

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
  room.asteroids = [];
  room.difficulty = 0;
  room.spawnTimer = 30;
  room.roundTimer = 0;

  // Reset players
  const pList = Object.values(room.players);
  const spacing = W / (pList.length + 1);
  pList.forEach((p, i) => {
    p.x = spacing * (i + 1);
    p.y = FLOOR_Y - 20;
    p.alive = true;
    p.score = 0;
  });

  io.to(room.code).emit('round_start', {
    players: room.players,
    asteroids: room.asteroids,
  });

  room.tickInterval = setInterval(() => {
    tickRoom(room);
    room.roundTimer++;
    io.to(room.code).emit('state', {
      players: room.players,
      asteroids: room.asteroids,
      timer: Math.floor(room.roundTimer / 30), // seconds survived
    });
  }, 1000 / 30);
}

function endRound(room) {
  clearInterval(room.tickInterval);
  clearInterval(room.timerInterval);
  room.state = 'results';

  const players = Object.values(room.players);
  const sorted = [...players].sort((a,b) => b.score - a.score);
  const winner = sorted[0];

  io.to(room.code).emit('round_end', {
    winner: winner ? { name: winner.name, color: winner.color } : null,
    scores: sorted.map(p => ({ name: p.name, color: p.color, score: p.score, alive: p.alive })),
  });

  setTimeout(() => {
    room.state = 'waiting';
    room.asteroids = [];
    io.to(room.code).emit('back_to_lobby', {});
  }, 5000);
}

// ─── Socket events ────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ name }) => {
    const room = createRoom(socket.id, name);
    rooms[room.code] = room;
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.emit('room_created', { code: room.code, players: room.players, you: socket.id });
    console.log('Room created:', room.code);
  });

  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', { msg: 'Room not found' }); return; }
    if (Object.keys(room.players).length >= MAX_PLAYERS) { socket.emit('error', { msg: 'Room full' }); return; }
    if (room.state !== 'waiting') { socket.emit('error', { msg: 'Game in progress' }); return; }
    const idx = Object.keys(room.players).length;
    room.players[socket.id] = createPlayer(socket.id, name, idx);
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

  // Player moves left or right
  socket.on('move', ({ dir }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing') return;
    const p = room.players[socket.id];
    if (!p || !p.alive) return;
    if (dir === 'left')  p.x = Math.max(16, p.x - PLAYER_SPEED);
    if (dir === 'right') p.x = Math.min(W-16, p.x + PLAYER_SPEED);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    delete room.players[socket.id];
    io.to(room.code).emit('player_left', { players: room.players });
    if (Object.keys(room.players).length === 0) {
      clearInterval(room.tickInterval);
      delete rooms[socket.roomCode];
      console.log('Room deleted:', socket.roomCode);
    }
  });
});

app.get('/', (req, res) => res.send('Planet Panic server ✓'));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
