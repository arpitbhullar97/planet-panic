// ─── Config ───────────────────────────────────────────────────
const SERVER_URL = 'https://repair-oxidant-critter.ngrok-free.app';
// ─── State ────────────────────────────────────────────────────
let socket = null;
let myId = null;
let roomCode = null;
let isHost = false;
let gameState = 'home';
let players = {};
let asteroids = [];
let particles = [];
let stars = [];
let animId, lastTime = 0;
let timerVal = 0;
let holdingLeft = false, holdingRight = false;
let moveInterval = null;

// ─── Canvas ───────────────────────────────────────────────────
const canvas = document.getElementById('gc');
const ctx = canvas.getContext('2d');
const W = 480, H = 640;

function resizeCanvas() {
  const maxW = Math.min(window.innerWidth, W);
  const maxH = Math.min(window.innerHeight, H);
  const aspect = W / H;
  let w = maxW, h = maxW / aspect;
  if (h > maxH) { h = maxH; w = h * aspect; }
  canvas.width = W; canvas.height = H;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ─── Stars ────────────────────────────────────────────────────
function mkStars() {
  stars = [];
  for (let i = 0; i < 80; i++)
    stars.push({ x: Math.random()*W, y: Math.random()*H, r: Math.random()*1.2+0.3, a: Math.random()*0.5+0.1 });
}
mkStars();

// ─── Screen management ────────────────────────────────────────
function hideAllScreens() {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('dead-banner').style.display = 'none';
  document.getElementById('tap-hint').classList.add('hidden');
}
function showScreen(id) {
  hideAllScreens();
  if (id) document.getElementById(id).classList.remove('hidden');
}
function showHUD(show) {
  document.getElementById('hud').classList.toggle('hidden', !show);
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── Lobby ────────────────────────────────────────────────────
function setupLobbyScreen() {
  showScreen('screen-lobby');
  document.getElementById('lobby-code').textContent = roomCode;
  document.getElementById('btn-start').style.display = isHost ? 'block' : 'none';
  document.getElementById('waiting-msg').style.display = isHost ? 'none' : 'block';
  updatePlayerList();
}

function updatePlayerList() {
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  Object.values(players).forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player-item';
    div.innerHTML = `<div class="player-dot" style="background:${p.color}"></div>
      <span>${p.name}</span>${i===0?'<span class="player-host">host</span>':''}`;
    list.appendChild(div);
  });
}

// ─── Screen actions ───────────────────────────────────────────
function getName() { return document.getElementById('input-name').value.trim() || 'Player'; }
function goCreate() { connectSocket(); socket.emit('create_room', { name: getName() }); }
function goJoin() { connectSocket(); showScreen('screen-join'); }
function joinRoom() {
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (code.length < 5) { showToast('Enter full room code'); return; }
  socket.emit('join_room', { code, name: getName() });
}
function startGame() { socket.emit('start_game'); }
function leaveRoom() {
  if (socket) socket.disconnect();
  socket = null; myId = null; roomCode = null; isHost = false;
  players = {}; asteroids = [];
  showScreen('screen-home'); gameState = 'home';
}

// ─── Socket ───────────────────────────────────────────────────
function connectSocket() {
  if (socket && socket.connected) return;
  socket = io(SERVER_URL);
  bindSocketEvents();
}

function bindSocketEvents() {
  socket.on('connect', () => { myId = socket.id; });

  socket.on('room_created', (data) => {
    roomCode = data.code; myId = data.you; isHost = true;
    players = data.players; gameState = 'lobby';
    setupLobbyScreen(); startRenderLoop();
  });

  socket.on('room_joined', (data) => {
    roomCode = data.code; myId = data.you; isHost = false;
    players = data.players; gameState = 'lobby';
    setupLobbyScreen(); startRenderLoop();
  });

  socket.on('player_joined', (data) => { players = data.players; if (gameState==='lobby') updatePlayerList(); });
  socket.on('player_left',   (data) => { players = data.players; if (gameState==='lobby') updatePlayerList(); });

  socket.on('countdown', (data) => {
    gameState = 'countdown';
    hideAllScreens();
    document.getElementById('screen-countdown').classList.remove('hidden');
    const el = document.getElementById('countdown-num');
    el.textContent = data.count;
    el.style.animation = 'none'; el.offsetHeight;
    el.style.animation = 'pop 0.4s ease-out';
  });

  socket.on('round_start', (data) => {
    players = data.players;
    asteroids = data.asteroids || [];
    gameState = 'playing';
    particles = [];
    hideAllScreens();
    showHUD(true);
    document.getElementById('score-val').textContent = '0';
    document.getElementById('timer-val').textContent = '';
    document.getElementById('alive-val').textContent = Object.keys(players).length;
    document.getElementById('tap-hint').classList.remove('hidden');
  });

  socket.on('state', (data) => {
    if (gameState !== 'playing') return;
    const prev = players;
    players = data.players;
    asteroids = data.asteroids || [];
    timerVal = data.timer;

    for (const id in players) {
      if (prev[id]?.alive && !players[id].alive)
        spawnParticles(players[id].x, players[id].y, players[id].color, 18);
    }

    const me = players[myId];
    if (me) {
      document.getElementById('score-val').textContent = me.score || 0;
      if (!me.alive) {
        document.getElementById('dead-banner').style.display = 'block';
        document.getElementById('tap-hint').classList.add('hidden');
      }
    }
    const alive = Object.values(players).filter(p => p.alive).length;
    document.getElementById('alive-val').textContent = alive;
    document.getElementById('timer-val').textContent = timerVal > 0 ? timerVal : '';
  });

  socket.on('round_end', (data) => {
    gameState = 'results';
    hideAllScreens();
    document.getElementById('screen-results').classList.remove('hidden');
    document.getElementById('winner-name').textContent = data.winner ? data.winner.name.toUpperCase() : 'NO ONE';
    document.getElementById('winner-name').style.color = data.winner ? data.winner.color : '#718096';
    const scoresEl = document.getElementById('results-scores');
    scoresEl.innerHTML = '';
    data.scores.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'score-row';
      row.innerHTML = `<span class="score-rank">${i+1}.</span>
        <span class="player-dot" style="background:${s.color};width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0;"></span>
        <span class="score-name">${s.name}</span>
        <span class="score-pts">${s.score} pts</span>`;
      scoresEl.appendChild(row);
    });
  });

  socket.on('back_to_lobby', (data) => {
    gameState = 'lobby'; asteroids = [];
    setupLobbyScreen();
  });

  socket.on('error', (data) => { showToast(data.msg); });

  socket.on('disconnect', () => {
    showToast('Disconnected');
    hideAllScreens(); showScreen('screen-home');
    gameState = 'home'; socket = null;
  });
}

// ─── Input — left/right buttons ───────────────────────────────
function startMove(dir) {
  if (moveInterval) clearInterval(moveInterval);
  moveInterval = setInterval(() => {
    if (gameState === 'playing') socket?.emit('move', { dir });
  }, 50);
}
function stopMove() {
  clearInterval(moveInterval);
  moveInterval = null;
}

// Keyboard
window.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft'  || e.key === 'a') startMove('left');
  if (e.key === 'ArrowRight' || e.key === 'd') startMove('right');
});
window.addEventListener('keyup', e => {
  if (['ArrowLeft','a','ArrowRight','d'].includes(e.key)) stopMove();
});

// ─── Particles ────────────────────────────────────────────────
function spawnParticles(x, y, color, count=12) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, spd = 1.5 + Math.random() * 4;
    particles.push({ x, y, vx: Math.cos(a)*spd, vy: Math.sin(a)*spd, life: 1, color });
  }
}

// ─── Render ───────────────────────────────────────────────────
function draw(ts) {
  const dt = Math.min((ts - lastTime) / 16.67, 2);
  lastTime = ts;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#07080f';
  ctx.fillRect(0, 0, W, H);

  // Stars
  for (const s of stars) {
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
    ctx.fillStyle = `rgba(200,200,255,${s.a})`; ctx.fill();
  }

  if (gameState !== 'home') {
    // Ground line
    ctx.strokeStyle = '#1a2a3a';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H-60); ctx.lineTo(W, H-60); ctx.stroke();

    // Asteroids
    for (const a of asteroids) {
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.rot || 0);
      const r = a.radius;
      // Rocky irregular shape
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const wobble = r * (0.75 + (a.offsets?.[i] || 0) * 0.3);
        const px = Math.cos(ang) * wobble, py = Math.sin(ang) * wobble;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#3a3a4a'; ctx.fill();
      ctx.strokeStyle = '#5a5a7a'; ctx.lineWidth = 1; ctx.stroke();
      // Crater
      ctx.beginPath(); ctx.arc(r*0.2, -r*0.2, r*0.22, 0, Math.PI*2);
      ctx.fillStyle = '#2a2a3a'; ctx.fill();
      ctx.restore();
    }

    // Players
    for (const id in players) {
      const p = players[id];
      if (!p.alive) continue;

      ctx.save();
      ctx.translate(p.x, p.y);

      // Engine glow
      if (id === myId) {
        ctx.beginPath(); ctx.arc(0, 8, 8, 0, Math.PI*2);
        ctx.fillStyle = p.color + '33'; ctx.fill();
      }

      // Ship body — triangle
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(-10, 10);
      ctx.lineTo(0, 6);
      ctx.lineTo(10, 10);
      ctx.closePath();
      ctx.fillStyle = p.color; ctx.fill();

      // Cockpit
      ctx.beginPath(); ctx.arc(0, -4, 4, 0, Math.PI*2);
      ctx.fillStyle = '#0a0a1a'; ctx.fill();
      ctx.strokeStyle = p.color + 'aa'; ctx.lineWidth = 1; ctx.stroke();

      // Self ring
      if (id === myId) {
        ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI*2);
        ctx.strokeStyle = p.color + '44'; ctx.lineWidth = 2; ctx.stroke();
      }

      ctx.restore();

      // Name
      ctx.fillStyle = '#a0aec0'; ctx.font = '9px monospace';
      ctx.textAlign = 'center'; ctx.fillText(p.name, p.x, p.y - 20);
    }

    // Controls hint at bottom
    if (gameState === 'playing') {
      const me = players[myId];
      if (me?.alive) {
        // Left button
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath(); ctx.roundRect(16, H-52, 80, 40, 8); ctx.fill();
        ctx.fillStyle = '#a0aec0'; ctx.font = '18px monospace';
        ctx.textAlign = 'center'; ctx.fillText('◀', 56, H-24);

        // Right button
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath(); ctx.roundRect(W-96, H-52, 80, 40, 8); ctx.fill();
        ctx.fillStyle = '#a0aec0';
        ctx.fillText('▶', W-56, H-24);
      }
    }
  }

  // Particles
  for (const p of particles) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 3*p.life, 0, Math.PI*2);
    ctx.fillStyle = p.color + Math.round(p.life*200).toString(16).padStart(2,'0');
    ctx.fill();
    p.x += p.vx*dt; p.y += p.vy*dt; p.vy += 0.1*dt; p.life -= 0.025*dt;
  }
  particles = particles.filter(p => p.life > 0);

  animId = requestAnimationFrame(draw);
}

function startRenderLoop() {
  if (animId) cancelAnimationFrame(animId);
  lastTime = performance.now();
  animId = requestAnimationFrame(draw);
}
startRenderLoop();

// Touch controls on canvas
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  for (const touch of e.changedTouches) {
    const tx = (touch.clientX - rect.left) * scaleX;
    if (tx < W / 2) startMove('left');
    else startMove('right');
  }
}, { passive: false });

canvas.addEventListener('touchend', e => { e.preventDefault(); stopMove(); }, { passive: false });
