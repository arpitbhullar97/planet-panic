// ─── Server URL ───────────────────────────────────────────────
const SERVER_URL = 'https://planet-panic-production.up.railway.app';

// ─── State ────────────────────────────────────────────────────
let socket = null;
let myId = null;
let roomCode = null;
let isHost = false;
let gameState = 'home';
let players = {};
let platform = { x: 240, y: 340, radius: 195 };
let particles = [];
let stars = [];
let shockwaves = [];
let animId, lastTime = 0;
let shakeX = 0, shakeY = 0, shakeTimer = 0;
let shrinkAnim = 0; // flashes platform edge on shrink

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
  for (let i = 0; i < 100; i++) stars.push({
    x: Math.random() * W, y: Math.random() * H,
    r: Math.random() * 1.4 + 0.2,
    a: Math.random() * 0.5 + 0.1,
    tw: Math.random() * Math.PI * 2,
    spd: Math.random() * 0.03 + 0.005,
  });
}
mkStars();

// ─── Screen helpers ───────────────────────────────────────────
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

// ─── UI actions ───────────────────────────────────────────────
function getName() { return document.getElementById('input-name').value.trim() || 'Player'; }
function goCreate() { connectSocket(); socket.emit('create_room', { name: getName() }); }
function goJoin()   { connectSocket(); showScreen('screen-join'); }
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
  socket.on('player_joined', (data) => { players = data.players; if (gameState==='lobby') updatePlayerList(); });
  socket.on('player_left',   (data) => { players = data.players; if (gameState==='lobby') updatePlayerList(); });

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
    gameState = 'playing';
    particles = []; shockwaves = []; shrinkAnim = 0;
    hideAllScreens(); showHUD(true);
    document.getElementById('tap-hint').classList.remove('hidden');
    updateAliveHUD();
  });

  socket.on('state', (data) => {
    if (gameState !== 'playing') return;
    const prev = players;
    players = data.players;
    platform = data.platform;

    // Death explosions
    for (const id in prev) {
      if (prev[id]?.alive && players[id] && !players[id].alive) {
        spawnExplosion(prev[id].x, prev[id].y, prev[id].color);
        if (id === myId) { triggerShake(10, 18); }
        else triggerShake(4, 8);
      }
    }
    // Bump shockwaves
    if (data.bumps) {
      for (const b of data.bumps) {
        shockwaves.push({ x: b.x, y: b.y, r: 4, life: 1, color: b.color });
        if (b.id === myId) triggerShake(5, 10);
      }
    }

    const me = players[myId];
    if (me && !me.alive) {
      document.getElementById('dead-banner').style.display = 'block';
      document.getElementById('tap-hint').classList.add('hidden');
    }
    updateAliveHUD();
  });

  socket.on('platform_shrink', (data) => {
    platform = data.platform;
    shrinkAnim = 1.0; // trigger flash
    triggerShake(5, 12);
    spawnShrinkRing();
  });

  socket.on('round_end', (data) => {
    gameState = 'results'; hideAllScreens();
    document.getElementById('screen-results').classList.remove('hidden');
    document.getElementById('winner-name').textContent =
      data.winner ? data.winner.name.toUpperCase() : 'DRAW';
    document.getElementById('winner-name').style.color =
      data.winner ? data.winner.color : '#718096';
    const el = document.getElementById('results-scores');
    el.innerHTML = '';
    data.scores.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'score-row';
      row.innerHTML = `<span class="score-rank">${i+1}.</span>
        <span style="background:${s.color};width:10px;height:10px;border-radius:50%;
          display:inline-block;flex-shrink:0;"></span>
        <span class="score-name">${s.name}</span>
        <span class="score-pts">${s.alive?'👑 winner':s.score+' pts'}</span>`;
      el.appendChild(row);
    });
  });

  socket.on('back_to_lobby', () => { gameState = 'lobby'; setupLobbyScreen(); });
  socket.on('error', (data) => { showToast(data.msg); });
  socket.on('disconnect', () => {
    showToast('Disconnected'); hideAllScreens();
    showScreen('screen-home'); gameState = 'home'; socket = null;
  });
}

function updateAliveHUD() {
  const alive = Object.values(players).filter(p => p.alive).length;
  document.getElementById('alive-val').textContent = alive;
  document.getElementById('score-val').textContent = '';
  document.getElementById('timer-val').textContent = '';
}

// ─── Input ────────────────────────────────────────────────────
let lastDash = 0;
function dash(dir) {
  const now = Date.now();
  if (now - lastDash < 80) return;
  lastDash = now;
  if (gameState !== 'playing') return;
  const me = players[myId];
  if (!me || !me.alive) return;
  socket.emit('dash', { dir });
  // Local dash particles
  spawnDashTrail(me.x, me.y, me.color, dir);
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  for (const t of e.changedTouches) {
    const tx = (t.clientX - rect.left) * (W / rect.width);
    dash(tx < W / 2 ? -1 : 1);
  }
}, { passive: false });

canvas.addEventListener('click', e => {
  const rect = canvas.getBoundingClientRect();
  const tx = (e.clientX - rect.left) * (W / rect.width);
  dash(tx < W / 2 ? -1 : 1);
});

window.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft'  || e.key === 'a') dash(-1);
  if (e.key === 'ArrowRight' || e.key === 'd') dash(1);
});

// ─── Effects ──────────────────────────────────────────────────
function triggerShake(intensity, frames) {
  shakeX = intensity; shakeTimer = frames;
}
function spawnExplosion(x, y, color) {
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + Math.random() * 0.3;
    const spd = 2 + Math.random() * 6;
    particles.push({ x, y, vx: Math.cos(a)*spd, vy: Math.sin(a)*spd,
      life: 1, color, r: 2+Math.random()*4 });
  }
  // White flash particle
  particles.push({ x, y, vx:0, vy:0, life:0.5, color:'#ffffff', r:18 });
}
function spawnDashTrail(x, y, color, dir) {
  for (let i = 0; i < 7; i++) {
    particles.push({
      x: x + (Math.random()-0.5)*8,
      y: y + (Math.random()-0.5)*8,
      vx: -dir * (1+Math.random()*3),
      vy: (Math.random()-0.5)*1.5,
      life: 0.6, color, r: 1+Math.random()*3
    });
  }
}
function spawnShrinkRing() {
  const pr = platform.radius + 22; // spawn at old radius
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    particles.push({
      x: platform.x + Math.cos(a) * pr,
      y: platform.y + Math.sin(a) * pr,
      vx: Math.cos(a) * (1.5 + Math.random()*2),
      vy: Math.sin(a) * (1.5 + Math.random()*2),
      life: 1, color: '#f97316', r: 2+Math.random()*3
    });
  }
}

// ─── Render ───────────────────────────────────────────────────
function draw(ts) {
  const dt = Math.min((ts - lastTime) / 16.67, 2.5);
  lastTime = ts;

  // Screen shake
  let sx = 0, sy = 0;
  if (shakeTimer > 0) {
    sx = (Math.random()-0.5) * shakeX;
    sy = (Math.random()-0.5) * shakeX;
    shakeTimer -= dt; shakeX *= 0.88;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(sx, sy);

  // ── Background ──
  ctx.fillStyle = '#07080f';
  ctx.fillRect(-20, -20, W+40, H+40);

  // ── Stars ──
  for (const s of stars) {
    s.tw += s.spd * dt;
    const a = s.a * (0.6 + 0.4 * Math.sin(s.tw));
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
    ctx.fillStyle = `rgba(200,210,255,${a})`; ctx.fill();
  }

  // ── Platform (always draw when not on home screen) ──
  if (gameState !== 'home') {
    const pr = platform.radius;
    const px = platform.x, py = platform.y;

    // Deep space void below platform
    ctx.beginPath(); ctx.arc(px, py, pr + 40, 0, Math.PI*2);
    const voidGrd = ctx.createRadialGradient(px, py, pr*0.5, px, py, pr+40);
    voidGrd.addColorStop(0, 'rgba(0,0,0,0)');
    voidGrd.addColorStop(1, 'rgba(0,0,20,0.6)');
    ctx.fillStyle = voidGrd; ctx.fill();

    // Platform fill
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI*2);
    const platGrd = ctx.createRadialGradient(px, py-pr*0.3, pr*0.1, px, py, pr);
    platGrd.addColorStop(0,   '#2d2d52');
    platGrd.addColorStop(0.6, '#1e1e38');
    platGrd.addColorStop(1,   '#12121f');
    ctx.fillStyle = platGrd; ctx.fill();

    // Grid lines
    ctx.save();
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI*2); ctx.clip();
    ctx.strokeStyle = 'rgba(120,120,200,0.07)'; ctx.lineWidth = 1;
    for (let gx = (px-pr); gx < px+pr; gx += 36) {
      ctx.beginPath(); ctx.moveTo(gx, py-pr); ctx.lineTo(gx, py+pr); ctx.stroke();
    }
    for (let gy = (py-pr); gy < py+pr; gy += 36) {
      ctx.beginPath(); ctx.moveTo(px-pr, gy); ctx.lineTo(px+pr, gy); ctx.stroke();
    }
    // Center cross
    ctx.strokeStyle = 'rgba(120,120,200,0.12)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px-pr, py); ctx.lineTo(px+pr, py); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px, py-pr); ctx.lineTo(px, py+pr); ctx.stroke();
    ctx.restore();

    // Danger zone outer ring (flashes on shrink)
    const edgeFlash = shrinkAnim > 0 ? shrinkAnim : 0;
    if (edgeFlash > 0) {
      ctx.beginPath(); ctx.arc(px, py, pr+8, 0, Math.PI*2);
      ctx.strokeStyle = `rgba(249,115,22,${edgeFlash * 0.8})`;
      ctx.lineWidth = 10; ctx.stroke();
      shrinkAnim -= 0.04 * dt;
    }

    // Platform edge
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI*2);
    ctx.strokeStyle = edgeFlash > 0.3 ? '#f97316' : '#6366f1';
    ctx.lineWidth = 3.5; ctx.stroke();

    // Inner soft glow ring
    ctx.beginPath(); ctx.arc(px, py, pr - 5, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(99,102,241,0.25)'; ctx.lineWidth = 8; ctx.stroke();

    // ── Shockwaves ──
    for (const sw of shockwaves) {
      ctx.beginPath(); ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI*2);
      const alpha = Math.round(sw.life * 160).toString(16).padStart(2,'0');
      ctx.strokeStyle = sw.color + alpha;
      ctx.lineWidth = 3 * sw.life; ctx.stroke();
      sw.r += 5 * dt; sw.life -= 0.05 * dt;
    }
    shockwaves = shockwaves.filter(s => s.life > 0);

    // ── Players ──
    for (const id in players) {
      const p = players[id];
      if (!p.alive) continue;
      const isSelf = id === myId;

      // Shadow
      ctx.save();
      ctx.beginPath(); ctx.arc(p.x, p.y + 4, 10, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
      ctx.restore();

      // Outer glow
      ctx.beginPath(); ctx.arc(p.x, p.y, isSelf ? 22 : 18, 0, Math.PI*2);
      ctx.fillStyle = p.color + (isSelf ? '28' : '18'); ctx.fill();

      // Body gradient
      ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI*2);
      const bg = ctx.createRadialGradient(p.x-4, p.y-5, 1, p.x, p.y, 14);
      bg.addColorStop(0, lighten(p.color, 70));
      bg.addColorStop(1, p.color);
      ctx.fillStyle = bg; ctx.fill();

      // Outline
      ctx.strokeStyle = isSelf ? '#ffffff' : 'rgba(255,255,255,0.3)';
      ctx.lineWidth = isSelf ? 2 : 1; ctx.stroke();

      // Visor
      ctx.beginPath(); ctx.arc(p.x+2, p.y-3, 5, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,10,40,0.75)'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x+1, p.y-5, 2, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill();

      // Self indicator ring
      if (isSelf) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, Math.PI*2);
        ctx.strokeStyle = p.color + 'cc'; ctx.lineWidth = 1.5; ctx.stroke();
      }

      // Name
      ctx.font = `bold 9px monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(p.name, p.x+1, p.y-21);
      ctx.fillStyle = isSelf ? '#ffffff' : '#c0c8d8';
      ctx.fillText(p.name, p.x, p.y-22);

      // Dash cooldown arc
      if (isSelf && p.dashCooldown > 0) {
        const pct = 1 - (p.dashCooldown / 18);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 20, -Math.PI/2, -Math.PI/2 + pct*Math.PI*2);
        ctx.strokeStyle = p.color + 'bb'; ctx.lineWidth = 2.5; ctx.stroke();
      }
    }

    // ── Control zones (mobile) ──
    if (gameState === 'playing' && players[myId]?.alive) {
      // Left tap zone
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath(); ctx.roundRect(8, H-68, W/2-16, 56, 10); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(8, H-68, W/2-16, 56, 10); ctx.stroke();

      // Right tap zone
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath(); ctx.roundRect(W/2+8, H-68, W/2-16, 56, 10); ctx.fill();
      ctx.beginPath(); ctx.roundRect(W/2+8, H-68, W/2-16, 56, 10); ctx.stroke();

      ctx.font = '20px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.textAlign = 'center';
      ctx.fillText('◀ dash', W*0.25, H-34);
      ctx.fillText('dash ▶', W*0.75, H-34);
    }
  }

  // ── Particles (always) ──
  for (const p of particles) {
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, p.r * p.life), 0, Math.PI*2);
    const alpha = Math.round(p.life * 220).toString(16).padStart(2,'0');
    ctx.fillStyle = p.color + alpha; ctx.fill();
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += 0.06 * dt; p.vx *= 0.96;
    p.life -= 0.022 * dt;
  }
  particles = particles.filter(p => p.life > 0);

  ctx.restore();
  animId = requestAnimationFrame(draw);
}

// ─── Helpers ──────────────────────────────────────────────────
function lighten(hex, amt) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgb(${Math.min(255,r+amt)},${Math.min(255,g+amt)},${Math.min(255,b+amt)})`;
}

function startRenderLoop() {
  if (animId) cancelAnimationFrame(animId);
  lastTime = performance.now();
  animId = requestAnimationFrame(draw);
}
startRenderLoop();
