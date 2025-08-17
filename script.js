// ===== UI статус =====
const statusEl = document.getElementById('status');
const setStatus = (m) => { console.log('[STATUS]', m); statusEl.textContent = m; };

// ===== DOM =====
const roomInput   = document.getElementById('room');
const nickInput   = document.getElementById('nick');
const joinBtn     = document.getElementById('joinBtn');
const leaveBtn    = document.getElementById('leaveBtn');
const chatBox     = document.getElementById('chat');
const msgInput    = document.getElementById('msg');
const sendBtn     = document.getElementById('sendBtn');
const usersList   = document.getElementById('users');
const pttBtn      = document.getElementById('pttBtn');
const vadCheckbox = document.getElementById('vad');
const voicePanel  = document.getElementById('voicePanel');

// ===== Состояние =====
let roomCode = '';
let nickname = '';
let secretKey = null;

let haveMic = false;
let audioOn = false;
let localStream = null;   // для отправки
let monitorStream = null; // клон трека для VAD
let p2pt = null;

// peers: id -> { peer, nick, audioEl }
const peers = new Map();

// ===== VAD =====
let vadRunning = false, vadCtx=null, vadAnalyser=null, vadSrc=null, vadRAF=null;

// ===== UI helpers =====
function addChat(line){
  const p = document.createElement('p');
  p.textContent = line;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}
function redrawUsers(){
  usersList.innerHTML = '';
  [...peers.values()].forEach(({ nick }) => {
    const li = document.createElement('li');
    li.textContent = nick || '(peer)';
    usersList.appendChild(li);
  });
}

// ===== AES-GCM (ключ из Room Code) =====
async function deriveKey(code) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt: enc.encode('dedsec'), iterations: 100_000, hash:'SHA-256' },
    material, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
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

// ===== Микрофон =====
async function tryGetMic(){
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Нет getUserMedia — только приём.');
    haveMic = false; return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    haveMic = true;

    // старт — молча; включаем только PTT/VAD
    const sendTrack = localStream.getAudioTracks()[0];
    sendTrack.enabled = false;

    // клон для VAD
    const mon = sendTrack.clone(); mon.enabled = true;
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

// PTT (кнопка и Space)
pttBtn.addEventListener('mousedown', ()=>setMicState(true));
pttBtn.addEventListener('mouseup',   ()=>setMicState(false));
document.addEventListener('keydown', e=>{ if (e.code==='Space'){ e.preventDefault(); setMicState(true);} });
document.addEventListener('keyup',   e=>{ if (e.code==='Space'){ e.preventDefault(); setMicState(false);} });

// VAD
function startVAD(){
  if (!haveMic || !monitorStream){ vadCheckbox.checked=false; return; }
  if (vadRunning) return;
  vadCtx = new (window.AudioContext||window.webkitAudioContext)();
  vadSrc = vadCtx.createMediaStreamSource(monitorStream);
  vadAnalyser = vadCtx.createAnalyser();
  vadAnalyser.fftSize = 1024; vadSrc.connect(vadAnalyser);

  const buf = new Float32Array(vadAnalyser.fftSize);
  let noise=0.006, armed=false, speaking=false;
  let aboveT=0, belowT=0;
  const attackMs=90, releaseMs=380;
  const onThr = ()=> noise*2.4, offThr = ()=> noise*1.6;

  const loop = ()=>{
    vadAnalyser.getFloatTimeDomainData(buf);
    let rms=0; for (let i=0;i<buf.length;i++) rms+=buf[i]*buf[i];
    rms=Math.sqrt(rms/buf.length);
    if (!armed){ noise=Math.max(0.004, rms*1.4); armed=true; }
    const now=performance.now();
    if (!speaking){
      if (rms>onThr()){ if(!aboveT) aboveT=now; if(now-aboveT>attackMs){ speaking=true; setMicState(true);} }
      else aboveT=0;
    } else {
      if (rms<offThr()){ if(!belowT) belowT=now; if(now-belowT>releaseMs){ speaking=false; if(!audioOn) setMicState(false);} }
      else belowT=0;
    }
    vadRAF=requestAnimationFrame(loop);
  };

  vadRunning=true;
  vadRAF=requestAnimationFrame(loop);
}
function stopVAD(){
  if (!vadRunning) return;
  vadRunning=false;
  if (vadRAF) cancelAnimationFrame(vadRAF); vadRAF=null;
  try{ vadCtx && vadCtx.close(); }catch{}
  vadCtx=vadAnalyser=vadSrc=null;
  if (!audioOn) setMicState(false);
}
vadCheckbox.addEventListener('change', ()=> vadCheckbox.checked ? startVAD() : stopVAD());

// ===== P2P discovery (P2PT) =====
const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.fastcast.nz'
];
function topicFromRoom(code){
  const text = 'dedsec:' + code.toLowerCase().trim();
  return new TextEncoder().encode(text);
}

function startP2P(){
  if (p2pt) { try{ p2pt.destroy?.(); }catch{} p2pt=null; }
  const topic = topicFromRoom(roomCode);
  p2pt = new P2PT(TRACKERS, topic);

  // Добавим STUN (и сюда же позже можно вставить TURN)
  p2pt.setRTCConfiguration({
    iceServers: [{ urls:'stun:stun.l.google.com:19302' }]
  });

  p2pt.on('peerconnect', (peer) => {
    console.log('[p2p] connect', peer.id);
    peers.set(peer.id, { peer, nick:'(unknown)', audioEl:null });
    redrawUsers();

    // публикуем наш аудиотрек
    if (haveMic && localStream) {
      localStream.getAudioTracks().forEach(t => peer.addTrack(t, localStream));
    }

    // входящий звук
    peer.on('track', (track, stream) => {
      const audio = document.createElement('audio');
      audio.autoplay = true; audio.playsInline = true; audio.srcObject = stream;
      audio.play().catch(()=>{ // разблокировка автоплея по клику
        const unlock = () => { audio.play().catch(()=>{}); document.removeEventListener('click', unlock); document.removeEventListener('keydown', unlock); };
        document.addEventListener('click', unlock);
        document.addEventListener('keydown', unlock);
      });
      const e = peers.get(peer.id); if (e) e.audioEl = audio;
      document.body.appendChild(audio);
    });

    // DataChannel: ник и чат
    peer.on('data', async (buf) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(buf));
        if (msg.type === 'hello') {
          const e = peers.get(peer.id); if (e) { e.nick = msg.nick || '(peer)'; redrawUsers(); }
        } else if (msg.type === 'chat') {
          const text = await decryptMessage(msg.iv, msg.data);
          addChat(`${(peers.get(peer.id)?.nick)||'peer'}: ${text}`);
        }
      } catch {}
    });

    peer.on('close', () => {
      const e = peers.get(peer.id);
      if (e?.audioEl) try{ e.audioEl.remove(); }catch{}
      peers.delete(peer.id); redrawUsers();
    });
    peer.on('error', err => console.warn('[p2p] error', err));

    // представляемся
    try { peer.send(JSON.stringify({ type:'hello', nick:nickname })); } catch {}
  });

  p2pt.on('peerclose', (peer) => {
    const e = peers.get(peer.id);
    if (e?.audioEl) try{ e.audioEl.remove(); }catch{}
    peers.delete(peer.id); redrawUsers();
  });

  p2pt.start();
  setStatus('P2P discovery запущен.');
}

// ===== Чат =====
async function sendChatToAll(text){
  const payload = await encryptMessage(text);
  const data = new TextEncoder().encode(JSON.stringify({ type:'chat', ...payload }));
  for (const { peer } of peers.values()){
    try { peer.send(data); } catch (e) { console.warn('send fail', e); }
  }
}

// ===== Join / Leave =====
joinBtn.addEventListener('click', async ()=>{
  roomCode = (roomInput.value||'').trim();
  nickname = (nickInput.value||'').trim() || 'user';
  if (!roomCode){ setStatus('Введите Room Code'); return; }

  secretKey = await deriveKey(roomCode);
  setStatus('Проверяю микрофон…');
  await tryGetMic();

  startP2P();
  voicePanel.classList.remove('hidden');
  addChat(`You joined room ${roomCode} as ${nickname}`);
});

leaveBtn.addEventListener('click', ()=>{
  stopVAD(); setMicState(false);
  for (const { peer, audioEl } of peers.values()) {
    try { peer.destroy(); } catch {}
    if (audioEl) try{ audioEl.remove(); }catch{}
  }
  peers.clear(); redrawUsers();
  if (p2pt) { try{ p2pt.destroy?.(); }catch{} p2pt=null; }
  setStatus('Отключено.');
  voicePanel.classList.add('hidden');
});

sendBtn.addEventListener('click', async ()=>{
  const text = (msgInput.value||'').trim();
  if (!text) return;
  try { await sendChatToAll(text); addChat(`Me: ${text}`); msgInput.value=''; }
  catch(e){ console.error(e); setStatus('Не удалось отправить сообщение.'); }
});

// HTTPS подсказка
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  console.warn('getUserMedia доступен только в HTTPS или на localhost');
}
