// ─── Server URL ───────────────────────────────────────────────
const SERVER_URL = 'https://planet-panic-production.up.railway.app';

// ─── State ────────────────────────────────────────────────────
let socket = null;
let myId = null;
let roomCode = null;
let isHost = false;
let gameState = 'home';
let players = {};
let platform = { radius: 200, x: 240, y: 320 };
let particles = [];
let stars = [];
let shockwaves = [];
let animId, lastTime = 0;
let screenShake = { x: 0, y: 0, timer: 0 };

// ─── Canvas ───────────────────────────────────────────────────
const canvas = document.getElementById('gc');
const ctx = canvas.getContext('2d');
const W = 480, H = 640;

function resizeCanvas() {
  const maxW = Math.min(window.innerWidth, W);
  const maxH = Math.min(window.innerHeight, H);
  let w = maxW, h = maxW * (H / W);
  if (h > maxH) { h = maxH; w = h * (W / H); }
  canvas.width = W; canvas.height = H;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ─── Stars ────────────────────────────────────────────────────
function mkStars() {
  stars = [];
  for (let i = 0; i < 120; i++) stars.push({
    x: Math.random() * W, y: Math.random() * H,
    r: Math.random() * 1.5 + 0.2,
    a: Math.random() * 0.6 + 0.1,
    twinkle: Math.random() * Math.PI * 2,
    speed: Math.random() * 0.02 + 0.005,
  });
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
      <span>${p.name}</span>${i === 0 ? '<span class="player-host">host</span>' : ''}`;
    list.appendChild(div);
  });
}

// ─── UI Actions ───────────────────────────────────────────────
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
  players = {}; showScreen('screen-home'); gameState = 'home';
}

// ─── Socket ───────────────────────────────────────────────────
function connectSocket() {
  if (socket && socket.connected) return;
  socket = io(SERVER_URL, { extraHeaders: { 'ngrok-skip-browser-warning': 'true' } });
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
  socket.on('player_joined', (data) => { players = data.players; if (gameState === 'lobby') updatePlayerList(); });
  socket.on('player_left',   (data) => { players = data.players; if (gameState === 'lobby') updatePlayerList(); });

  socket.on('countdown', (data) => {
    gameState = 'countdown'; hideAllScreens();
    document.getElementById('screen-countdown').classList.remove('hidden');
    const el = document.getElementById('countdown-num');
    el.textContent = data.count;
    el.style.animation = 'none'; el.offsetHeight;
    el.style.animation = 'pop 0.4s ease-out';
  });

  socket.on('round_start', (data) => {
    players = data.players;
    platform = data.platform;
    gameState = 'playing'; particles = []; shockwaves = [];
    hideAllScreens(); showHUD(true);
    document.getElementById('alive-val').textContent = Object.keys(players).length;
    document.getElementById('score-val').textContent = '';
    document.getElementById('timer-val').textContent = '';
    document.getElementById('tap-hint').classList.remove('hidden');
  });

  socket.on('state', (data) => {
    if (gameState !== 'playing') return;
    const prev = players;
    players = data.players;
    platform = data.platform;

    // Death particles + screen shake
    for (const id in prev) {
      if (prev[id]?.alive && players[id] && !players[id].alive) {
        spawnDeathParticles(prev[id].x, prev[id].y, prev[id].color);
        if (id === myId) triggerShake(8, 20);
      }
    }
    // Bump shockwaves
    if (data.bumps) {
      for (const b of data.bumps) {
        shockwaves.push({ x: b.x, y: b.y, r: 0, life: 1, color: b.color });
        if (b.id === myId) triggerShake(4, 10);
      }
    }

    const me = players[myId];
    if (me && !me.alive) {
      document.getElementById('dead-banner').style.display = 'block';
      document.getElementById('tap-hint').classList.add('hidden');
    }
    const alive = Object.values(players).filter(p => p.alive).length;
    document.getElementById('alive-val').textContent = alive;
  });

  socket.on('platform_shrink', (data) => {
    platform = data.platform;
    spawnShrinkParticles();
    triggerShake(3, 8);
  });

  socket.on('round_end', (data) => {
    gameState = 'results'; hideAllScreens();
    document.getElementById('screen-results').classList.remove('hidden');
    document.getElementById('winner-name').textContent = data.winner ? data.winner.name.toUpperCase() : 'DRAW';
    document.getElementById('winner-name').style.color = data.winner ? data.winner.color : '#718096';
    const scoresEl = document.getElementById('results-scores');
    scoresEl.innerHTML = '';
    data.scores.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'score-row';
      row.innerHTML = `<span class="score-rank">${i+1}.</span>
        <span style="background:${s.color};width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0;"></span>
        <span class="score-name">${s.name}</span>
        <span class="score-pts">${s.alive ? '👑' : s.score + ' pts'}</span>`;
      scoresEl.appendChild(row);
    });
  });

  socket.on('back_to_lobby', () => { gameState = 'lobby'; setupLobbyScreen(); });
  socket.on('error', (data) => { showToast(data.msg); });
  socket.on('disconnect', () => {
    showToast('Disconnected');
    hideAllScreens(); showScreen('screen-home'); gameState = 'home'; socket = null;
  });
}

// ─── Screen shake ─────────────────────────────────────────────
function triggerShake(intensity, duration) {
  screenShake.intensity = intensity;
  screenShake.timer = duration;
}

// ─── Particles ────────────────────────────────────────────────
function spawnDeathParticles(x, y, color) {
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const spd = 2 + Math.random() * 5;
    particles.push({ x, y, vx: Math.cos(a)*spd, vy: Math.sin(a)*spd, life: 1, color, r: Math.random()*4+2 });
  }
}
function spawnShrinkParticles() {
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2;
    const r = platform.radius;
    particles.push({
      x: platform.x + Math.cos(a) * r,
      y: platform.y + Math.sin(a) * r,
      vx: Math.cos(a) * (1 + Math.random() * 2),
      vy: Math.sin(a) * (1 + Math.random() * 2),
      life: 1, color: '#f97316', r: Math.random()*3+1
    });
  }
}
function spawnDashParticles(x, y, color, dir) {
  for (let i = 0; i < 6; i++) {
    particles.push({
      x, y,
      vx: -dir * (1 + Math.random() * 3) + (Math.random()-0.5)*2,
      vy: (Math.random()-0.5)*2,
      life: 0.7, color, r: Math.random()*3+1
    });
  }
}

// ─── Input ────────────────────────────────────────────────────
let lastDashTime = 0;
function dash(dir) {
  const now = Date.now();
  if (now - lastDashTime < 120) return; // debounce
  lastDashTime = now;
  if (gameState !== 'playing') return;
  const me = players[myId];
  if (!me || !me.alive) return;
  socket.emit('dash', { dir });
  spawnDashParticles(me.x, me.y, me.color, dir);
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  for (const t of e.changedTouches) {
    const tx = (t.clientX - rect.left) * scaleX;
    dash(tx < W / 2 ? -1 : 1);
  }
}, { passive: false });

canvas.addEventListener('click', e => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  const tx = (e.clientX - rect.left) * scaleX;
  dash(tx < W / 2 ? -1 : 1);
});

window.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft'  || e.key === 'a') dash(-1);
  if (e.key === 'ArrowRight' || e.key === 'd') dash(1);
});

// ─── Draw ─────────────────────────────────────────────────────
function draw(ts) {
  const dt = Math.min((ts - lastTime) / 16.67, 2);
  lastTime = ts;

  // Screen shake
  let sx = 0, sy = 0;
  if (screenShake.timer > 0) {
    sx = (Math.random() - 0.5) * screenShake.intensity;
    sy = (Math.random() - 0.5) * screenShake.intensity;
    screenShake.timer -= dt;
    screenShake.intensity *= 0.85;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(sx, sy);

  // Background
  ctx.fillStyle = '#07080f';
  ctx.fillRect(-10, -10, W + 20, H + 20);

  // Stars with twinkle
  for (const s of stars) {
    s.twinkle += s.speed * dt;
    const a = s.a * (0.7 + 0.3 * Math.sin(s.twinkle));
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
    ctx.fillStyle = `rgba(200,210,255,${a})`; ctx.fill();
  }

  if (gameState !== 'home') {
    // ── Platform ──
    const pr = platform.radius;
    const px = platform.x, py = platform.y;

    // Outer glow
    const grd = ctx.createRadialGradient(px, py, pr*0.6, px, py, pr*1.3);
    grd.addColorStop(0, 'rgba(99,102,241,0.0)');
    grd.addColorStop(1, 'rgba(99,102,241,0.08)');
    ctx.beginPath(); ctx.arc(px, py, pr*1.3, 0, Math.PI*2);
    ctx.fillStyle = grd; ctx.fill();

    // Platform base
    const platGrd = ctx.createRadialGradient(px, py-pr*0.2, 0, px, py, pr);
    platGrd.addColorStop(0, '#2a2a4a');
    platGrd.addColorStop(0.7, '#1a1a2e');
    platGrd.addColorStop(1, '#0f0f1e');
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI*2);
    ctx.fillStyle = platGrd; ctx.fill();

    // Platform edge — danger ring
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI*2);
    ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 3; ctx.stroke();

    // Inner edge glow
    ctx.beginPath(); ctx.arc(px, py, pr - 4, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(99,102,241,0.3)'; ctx.lineWidth = 6; ctx.stroke();

    // Grid lines on platform
    ctx.save();
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI*2); ctx.clip();
    ctx.strokeStyle = 'rgba(99,102,241,0.08)'; ctx.lineWidth = 1;
    for (let gx = px - pr; gx < px + pr; gx += 40) {
      ctx.beginPath(); ctx.moveTo(gx, py-pr); ctx.lineTo(gx, py+pr); ctx.stroke();
    }
    for (let gy = py - pr; gy < py + pr; gy += 40) {
      ctx.beginPath(); ctx.moveTo(px-pr, gy); ctx.lineTo(px+pr, gy); ctx.stroke();
    }
    ctx.restore();

    // ── Shockwaves ──
    for (const sw of shockwaves) {
      ctx.beginPath(); ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI*2);
      ctx.strokeStyle = sw.color + Math.round(sw.life * 180).toString(16).padStart(2,'0');
      ctx.lineWidth = 3 * sw.life; ctx.stroke();
      sw.r += 4 * dt; sw.life -= 0.06 * dt;
    }
    shockwaves = shockwaves.filter(sw => sw.life > 0);

    // ── Players ──
    for (const id in players) {
      const p = players[id];
      if (!p.alive) continue;

      // Shadow on platform
      ctx.beginPath(); ctx.arc(p.x, py + Math.min(p.y - py + 8, 12), 12, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();

      // Outer glow (stronger for self)
      ctx.beginPath(); ctx.arc(p.x, p.y, id===myId ? 20 : 16, 0, Math.PI*2);
      ctx.fillStyle = p.color + (id===myId ? '22' : '14'); ctx.fill();

      // Body
      ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI*2);
      const bodyGrd = ctx.createRadialGradient(p.x-4, p.y-4, 0, p.x, p.y, 13);
      bodyGrd.addColorStop(0, lighten(p.color));
      bodyGrd.addColorStop(1, p.color);
      ctx.fillStyle = bodyGrd; ctx.fill();

      // Helmet visor
      ctx.beginPath(); ctx.arc(p.x+2, p.y-2, 5, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,10,30,0.7)'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x+1, p.y-3, 2, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fill();

      // Self ring
      if (id === myId) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 17, 0, Math.PI*2);
        ctx.strokeStyle = p.color; ctx.lineWidth = 1.5; ctx.stroke();
      }

      // Name tag
      ctx.font = `bold 9px monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(p.name, p.x+1, p.y - 19);
      ctx.fillStyle = id === myId ? '#ffffff' : '#c0c0d0';
      ctx.fillText(p.name, p.x, p.y - 20);

      // Dash cooldown arc (for self)
      if (id === myId && p.dashCooldown > 0) {
        const pct = 1 - (p.dashCooldown / 12);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 19, -Math.PI/2, -Math.PI/2 + pct * Math.PI*2);
        ctx.strokeStyle = p.color + 'aa'; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    // ── Mobile control zones (subtle) ──
    if (gameState === 'playing' && players[myId]?.alive) {
      // Left zone
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, H-70, W/2-1, 70);
      ctx.fillRect(W/2+1, H-70, W/2, 70);

      ctx.font = '22px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.textAlign = 'center';
      ctx.fillText('◀', W*0.25, H-30);
      ctx.fillText('▶', W*0.75, H-30);
    }
  }

  // ── Particles ──
  for (const p of particles) {
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI*2);
    ctx.fillStyle = p.color + Math.round(p.life * 220).toString(16).padStart(2,'0');
    ctx.fill();
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += 0.12 * dt; p.vx *= 0.97;
    p.life -= 0.022 * dt;
  }
  particles = particles.filter(p => p.life > 0);

  ctx.restore();
  animId = requestAnimationFrame(draw);
}

// ─── Helpers ──────────────────────────────────────────────────
function lighten(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgb(${Math.min(255,r+60)},${Math.min(255,g+60)},${Math.min(255,b+60)})`;
}

function startRenderLoop() {
  if (animId) cancelAnimationFrame(animId);
  lastTime = performance.now();
  animId = requestAnimationFrame(draw);
}
startRenderLoop();
