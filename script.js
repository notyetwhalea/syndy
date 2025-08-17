// ==== Утилиты DOM/статус ====
function $(id){ return document.getElementById(id); }
const statusEl = $('status');
const setStatus = (m) => { console.log('[STATUS]', m); if (statusEl) statusEl.textContent = m; };

// ==== DOM ====
const roomInput   = $('room');
const nickInput   = $('nick');
const joinBtn     = $('joinBtn');
const leaveBtn    = $('leaveBtn');
const chatBox     = $('chat');
const msgInput    = $('msg');
const sendBtn     = $('sendBtn');
const usersList   = $('users');
const pttBtn      = $('pttBtn');
const vadCheckbox = $('vad');
const voicePanel  = $('voicePanel');

// ==== Глобальное состояние ====
let roomCode = '';
let nickname = '';
let secretKey = null;

let haveMic = false;
let audioOn = false;
let localStream = null;    // основной поток для отправки
let monitorStream = null;  // клон трека для VAD
let p2pt = null;           // экземпляр P2PT

// peers: id -> { peer, nick, audioEl }
const peers = new Map();

// ==== VAD ====
let vadRunning = false, vadCtx = null, vadAnalyser = null, vadSrc = null, vadRAF = null;

// ==== UI helpers ====
function addChat(line){
  if (!chatBox) return;
  const p = document.createElement('p');
  p.textContent = line;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}
function redrawUsers(){
  if (!usersList) return;
  usersList.innerHTML = '';
  for (const { nick } of peers.values()){
    const li = document.createElement('li');
    li.textContent = nick || '(peer)';
    usersList.appendChild(li);
  }
}

// ==== AES-GCM (ключ из Room Code) ====
async function deriveKey(code) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt: enc.encode('dedsec'), iterations: 100_000, hash:'SHA-256' },
    material,
    { name:'AES-GCM', length:256 },
    false,
    ['encrypt','decrypt']
  );
}
async function encryptMessage(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, secretKey, new TextEncoder().encode(plain));
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(data)) };
}
async function decryptMessage(iv, data) {
  const buf = await crypto.subtle.decrypt({ name:'AES-GCM', iv: new Uint8Array(iv) }, secretKey, new Uint8Array(data));
  return new TextDecoder().decode(buf);
}

// ==== Микрофон / аудио ====
async function tryGetMic(){
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Нет getUserMedia — только приём. Откройте по HTTPS.');
    haveMic = false; return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    haveMic = true;

    // стартуем молча — включают PTT/VAD
    const sendTrack = localStream.getAudioTracks()[0];
    sendTrack.enabled = false;

    // клон для VAD
    const mon = sendTrack.clone();
    mon.enabled = true;
    monitorStream = new MediaStream([mon]);

    setStatus('Микрофон доступен. Используйте PTT или VAD.');
  } catch (e) {
    console.warn('mic fail', e);
    haveMic = false;
    setStatus('Без микрофона (receive-only). Разрешите доступ.');
  }
}
function setMicState(on){
  if (!haveMic || !localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = !!on);
  audioOn = !!on;
}

// PTT (кнопка + пробел)
if (pttBtn){
  pttBtn.addEventListener('mousedown', ()=>setMicState(true));
  pttBtn.addEventListener('mouseup',   ()=>setMicState(false));
}
document.addEventListener('keydown', (e)=>{ if (e.code==='Space'){ e.preventDefault(); setMicState(true);} });
document.addEventListener('keyup',   (e)=>{ if (e.code==='Space'){ e.preventDefault(); setMicState(false);} });

// ==== VAD ====
function startVAD(){
  if (!haveMic || !monitorStream) { if (vadCheckbox) vadCheckbox.checked = false; return; }
  if (vadRunning) return;

  vadCtx = new (window.AudioContext||window.webkitAudioContext)();
  vadSrc = vadCtx.createMediaStreamSource(monitorStream);
  vadAnalyser = vadCtx.createAnalyser();
  vadAnalyser.fftSize = 1024;
  vadSrc.connect(vadAnalyser);

  const buf = new Float32Array(vadAnalyser.fftSize);
  let noise=0.006, armed=false, speaking=false;
  let aboveT=0, belowT=0;
  const attackMs=90, releaseMs=380;
  const onThr = ()=> noise*2.4, offThr = ()=> noise*1.6;

  const loop = ()=>{
    vadAnalyser.getFloatTimeDomainData(buf);
    let rms=0; for (let i=0;i<buf.length;i++) rms += buf[i]*buf[i];
    rms = Math.sqrt(rms/buf.length);

    if (!armed){ noise = Math.max(0.004, rms*1.4); armed = true; }

    const now = performance.now();
    if (!speaking){
      if (rms > onThr()) { if (!aboveT) aboveT=now; if (now - aboveT > attackMs) { speaking = true; setMicState(true);} }
      else aboveT = 0;
    } else {
      if (rms < offThr()) { if (!belowT) belowT=now; if (now - belowT > releaseMs) { speaking = false; if (!audioOn) setMicState(false);} }
      else belowT = 0;
    }
    vadRAF = requestAnimationFrame(loop);
  };

  vadRunning = true;
  vadRAF = requestAnimationFrame(loop);
}
function stopVAD(){
  if (!vadRunning) return;
  vadRunning = false;
  if (vadRAF) cancelAnimationFrame(vadRAF);
  vadRAF = null;
  try{ vadCtx && vadCtx.close(); }catch{}
  vadCtx = vadAnalyser = vadSrc = null;
  if (!audioOn) setMicState(false);
}
if (vadCheckbox){
  vadCheckbox.addEventListener('change', ()=> vadCheckbox.checked ? startVAD() : stopVAD());
}

// ==== P2P discovery/signaling (через публичные трекеры) ====
const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.fastcast.nz',
];
function topicFromRoom(code){
  const text = 'dedsec:' + (code||'').toLowerCase().trim();
  return new TextEncoder().encode(text);
}

function startP2P(){
  if (typeof window.P2PT !== 'function') {
    setStatus('P2PT не загружен. Проверьте, что p2pt.min.js лежит рядом с index.html и доступен по HTTPS.');
    return;
  }
  if (p2pt) { try{ p2pt.destroy?.(); }catch{} p2pt = null; }

  p2pt = new window.P2PT(TRACKERS, topicFromRoom(roomCode));

  // STUN (можно добавить свой TURN позже)
  p2pt.setRTCConfiguration({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  p2pt.on('peerconnect', (peer) => {
    console.log('[p2p] connect', peer.id);
    const fallbackNick = 'peer-' + peer.id.slice(0,6);
    peers.set(peer.id, { peer, nick: fallbackNick, audioEl: null });
    addChat(`[system] connected: ${fallbackNick}`);
    redrawUsers();

    // публикуем наш аудиотрек
    if (haveMic && localStream) {
      localStream.getAudioTracks().forEach(t => peer.addTrack(t, localStream));
    }

    // входящие аудиопотоки
    peer.on('track', (track, stream) => {
      const audio = document.createElement('audio');
      audio.autoplay = true; audio.playsInline = true; audio.srcObject = stream;
      audio.play().catch(()=>{ // разблокировка автоплея
        const unlock = () => { audio.play().catch(()=>{}); document.removeEventListener('click', unlock); document.removeEventListener('keydown', unlock); };
        document.addEventListener('click', unlock);
        document.addEventListener('keydown', unlock);
      });
      const e = peers.get(peer.id); if (e) e.audioEl = audio;
      document.body.appendChild(audio);
    });

    // DataChannel (ник/чат)
    peer.on('data', async (buf) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(buf));
        if (msg.type === 'hello') {
          const e = peers.get(peer.id); if (e) { e.nick = msg.nick || e.nick; redrawUsers(); }
        } else if (msg.type === 'chat') {
          const text = await decryptMessage(msg.iv, msg.data);
          addChat(`${(peers.get(peer.id)?.nick)||'peer'}: ${text}`);
        }
      } catch {}
    });

    peer.on('close', () => {
      const e = peers.get(peer.id);
      if (e?.audioEl) try { e.audioEl.remove(); } catch {}
      peers.delete(peer.id); redrawUsers();
    });

    peer.on('error', (err) => console.warn('[p2p] error', err));

    // представляемся ником
    try { peer.send(JSON.stringify({ type: 'hello', nick: nickname })); } catch {}
  });

  p2pt.on('peerclose', (peer) => {
    const e = peers.get(peer.id);
    if (e?.audioEl) try { e.audioEl.remove(); } catch {}
    peers.delete(peer.id); redrawUsers();
  });

  p2pt.on('trackerconnect', (t) => console.log('[tracker] connect', t.announcer));
  p2pt.on('trackerwarning', (e) => console.warn('[tracker] warn', e));
  p2pt.on('trackererror',   (e) => console.warn('[tracker] error', e));

  p2pt.start();
  setStatus('P2P discovery запущен.');
}

// ==== Рассылка чата всем ====
async function sendChatToAll(text){
  const payload = await encryptMessage(text);
  const data = new TextEncoder().encode(JSON.stringify({ type:'chat', ...payload }));
  for (const { peer } of peers.values()) {
    try { peer.send(data); } catch (e) { console.warn('send fail', e); }
  }
}

// ==== Join / Leave ====
if (joinBtn) joinBtn.addEventListener('click', async () => {
  try {
    roomCode = (roomInput?.value || '').trim();
    nickname = (nickInput?.value || '').trim() || 'user';
    if (!roomCode) { setStatus('Введите Room Code'); return; }

    // 1) ключ чата
    secretKey = await deriveKey(roomCode);

    // 2) микрофон
    setStatus('Проверяю микрофон…');
    await tryGetMic();

    // 3) старт discovery
    startP2P();

    voicePanel?.classList.remove('hidden');
    addChat(`You joined room ${roomCode} as ${nickname}`);
    // статус установится в startP2P
  } catch (e) {
    console.error(e);
    setStatus('Не удалось запустить P2P: ' + (e?.message || e));
  }
});

if (leaveBtn) leaveBtn.addEventListener('click', () => {
  stopVAD(); setMicState(false);
  for (const { peer, audioEl } of peers.values()){
    try { peer.destroy(); } catch {}
    if (audioEl) try { audioEl.remove(); } catch {}
  }
  peers.clear(); redrawUsers();
  if (p2pt) { try{ p2pt.destroy?.(); }catch{} p2pt = null; }
  setStatus('Отключено.');
  voicePanel?.classList.add('hidden');
});

if (sendBtn) sendBtn.addEventListener('click', async () => {
  const text = (msgInput?.value || '').trim();
  if (!text) return;
  try {
    await sendChatToAll(text);
    addChat(`Me: ${text}`);
    msgInput.value = '';
  } catch (e) {
    console.error(e);
    setStatus('Не удалось отправить сообщение.');
  }
});

// ==== Подсказка по HTTPS ====
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  console.warn('getUserMedia доступен только в HTTPS или на localhost');
}
