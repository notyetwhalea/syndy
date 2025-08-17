// Безопасные геттеры
function $(id){ return document.getElementById(id); }

// DOM
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
const statusEl    = $('status');

const setStatus = (m)=>{ console.log('[STATUS]', m); if(statusEl) statusEl.textContent = m; };

// Проверка наличия p2pt из CDN
(function waitP2PT(){
  if (typeof window.P2PT === 'function') return;
  setStatus('Жду загрузку P2PT… (CDN)');
  setTimeout(waitP2PT, 300);
})();

// Состояние
let roomCode='', nickname='';
let secretKey=null;
let haveMic=false, audioOn=false;
let localStream=null, monitorStream=null;
let p2pt=null;
const peers=new Map();

// VAD
let vadRunning=false, vadCtx=null, vadAnalyser=null, vadSrc=null, vadRAF=null;

// UI
function addChat(line){
  if (!chatBox) return;
  const p=document.createElement('p');
  p.textContent=line; chatBox.appendChild(p); chatBox.scrollTop=chatBox.scrollHeight;
}
function redrawUsers(){
  if(!usersList) return;
  usersList.innerHTML='';
  for (const {nick} of peers.values()){
    const li=document.createElement('li'); li.textContent=nick||'(peer)'; usersList.appendChild(li);
  }
}

// AES-GCM
async function deriveKey(code){
  const enc=new TextEncoder();
  const material=await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2', salt:enc.encode('dedsec'), iterations:100_000, hash:'SHA-256'},
    material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']
  );
}
async function encryptMessage(plain){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM', iv}, secretKey, new TextEncoder().encode(plain));
  return { iv:Array.from(iv), data:Array.from(new Uint8Array(data)) };
}
async function decryptMessage(iv, data){
  const buf=await crypto.subtle.decrypt({name:'AES-GCM', iv:new Uint8Array(iv)}, secretKey, new Uint8Array(data));
  return new TextDecoder().decode(buf);
}

// Mic
async function tryGetMic(){
  if (!navigator.mediaDevices?.getUserMedia){
    setStatus('Нет getUserMedia — только приём. Открой по HTTPS.');
    haveMic=false; return;
  }
  try{
    localStream=await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    haveMic=true;
    const sendTrack=localStream.getAudioTracks()[0];
    sendTrack.enabled=false;
    const mon=sendTrack.clone(); mon.enabled=true;
    monitorStream=new MediaStream([mon]);
    setStatus('Микрофон доступен. Используйте PTT или VAD.');
  }catch(e){
    console.warn('mic fail', e);
    haveMic=false; setStatus('Без микрофона (receive-only). Разреши доступ.');
  }
}
function setMicState(on){
  if (!haveMic || !localStream) return;
  localStream.getAudioTracks().forEach(t=>t.enabled=!!on);
  audioOn=!!on;
}

// PTT
if (pttBtn){
  pttBtn.addEventListener('mousedown', ()=>setMicState(true));
  pttBtn.addEventListener('mouseup',   ()=>setMicState(false));
}
document.addEventListener('keydown', e=>{ if(e.code==='Space'){ e.preventDefault(); setMicState(true);} });
document.addEventListener('keyup',   e=>{ if(e.code==='Space'){ e.preventDefault(); setMicState(false);} });

// VAD
function startVAD(){
  if (!haveMic || !monitorStream){ if(vadCheckbox) vadCheckbox.checked=false; return; }
  if (vadRunning) return;
  vadCtx=new (window.AudioContext||window.webkitAudioContext)();
  vadSrc=vadCtx.createMediaStreamSource(monitorStream);
  vadAnalyser=vadCtx.createAnalyser(); vadAnalyser.fftSize=1024; vadSrc.connect(vadAnalyser);
  const buf=new Float32Array(vadAnalyser.fftSize);
  let noise=0.006, armed=false, speaking=false; let aboveT=0, belowT=0;
  const attackMs=90, releaseMs=380; const onThr=()=>noise*2.4, offThr=()=>noise*1.6;
  const loop=()=>{
    vadAnalyser.getFloatTimeDomainData(buf);
    let rms=0; for(let i=0;i<buf.length;i++) rms+=buf[i]*buf[i];
    rms=Math.sqrt(rms/buf.length);
    if(!armed){ noise=Math.max(0.004, rms*1.4); armed=true; }
    const now=performance.now();
    if(!speaking){
      if(rms>onThr()){ if(!aboveT) aboveT=now; if(now-aboveT>attackMs){ speaking=true; setMicState(true);} }
      else aboveT=0;
    }else{
      if(rms<offThr()){ if(!belowT) belowT=now; if(now-belowT>releaseMs){ speaking=false; if(!audioOn) setMicState(false);} }
      else belowT=0;
    }
    vadRAF=requestAnimationFrame(loop);
  };
  vadRunning=true; vadRAF=requestAnimationFrame(loop);
}
function stopVAD(){
  if(!vadRunning) return; vadRunning=false;
  if (vadRAF) cancelAnimationFrame(vadRAF); vadRAF=null;
  try{ vadCtx && vadCtx.close(); }catch{} vadCtx=vadAnalyser=vadSrc=null;
  if(!audioOn) setMicState(false);
}
if (vadCheckbox){
  vadCheckbox.addEventListener('change', ()=> vadCheckbox.checked ? startVAD() : stopVAD());
}

// P2P
const TRACKERS=[
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.fastcast.nz'
];
function topicFromRoom(code){
  const text='dedsec:'+ (code||'').toLowerCase().trim();
  return new TextEncoder().encode(text);
}
function startP2P(){
  if (typeof window.P2PT!=='function'){ setStatus('P2PT не загрузился (CDN). Проверьте сеть/CDN-блокировки.'); return; }
  if (p2pt){ try{ p2pt.destroy?.(); }catch{} p2pt=null; }
  p2pt=new window.P2PT(TRACKERS, topicFromRoom(roomCode));
  p2pt.setRTCConfiguration({ iceServers:[ {urls:'stun:stun.l.google.com:19302'} ] });

  p2pt.on('peerconnect', (peer)=>{
    console.log('[p2p] connect', peer.id);
    peers.set(peer.id,{peer,nick:'(unknown)',audioEl:null}); redrawUsers();

    if (haveMic && localStream){
      localStream.getAudioTracks().forEach(t=>peer.addTrack(t, localStream));
    }
    peer.on('track', (track, stream)=>{
      const audio=document.createElement('audio'); audio.autoplay=true; audio.playsInline=true; audio.srcObject=stream;
      audio.play().catch(()=>{ const unlock=()=>{ audio.play().catch(()=>{}); document.removeEventListener('click', unlock); document.removeEventListener('keydown', unlock);}; document.addEventListener('click', unlock); document.addEventListener('keydown', unlock); });
      const e=peers.get(peer.id); if(e) e.audioEl=audio; document.body.appendChild(audio);
    });
    peer.on('data', async (buf)=>{
      try{
        const msg=JSON.parse(new TextDecoder().decode(buf));
        if(msg.type==='hello'){ const e=peers.get(peer.id); if(e){ e.nick=msg.nick||'(peer)'; redrawUsers(); } }
        else if(msg.type==='chat'){ const text=await decryptMessage(msg.iv, msg.data); addChat(`${(peers.get(peer.id)?.nick)||'peer'}: ${text}`); }
      }catch{}
    });
    peer.on('close', ()=>{
      const e=peers.get(peer.id); if(e?.audioEl) try{ e.audioEl.remove(); }catch{}; peers.delete(peer.id); redrawUsers();
    });
    peer.on('error', err=>console.warn('[p2p] error', err));
    try{ peer.send(JSON.stringify({type:'hello', nick:nickname})); }catch{}
  });

  p2pt.on('peerclose', (peer)=>{
    const e=peers.get(peer.id); if(e?.audioEl) try{ e.audioEl.remove(); }catch{}; peers.delete(peer.id); redrawUsers();
  });

  p2pt.start();
  setStatus('P2P discovery запущен.');
}

// Chat
async function sendChatToAll(text){
  const payload=await encryptMessage(text);
  const data=new TextEncoder().encode(JSON.stringify({type:'chat', ...payload}));
  for (const {peer} of peers.values()){ try{ peer.send(data); }catch(e){ console.warn('send fail', e); } }
}

// Join/Leave
if (joinBtn) joinBtn.addEventListener('click', async ()=>{
  roomCode=(roomInput?.value||'').trim();
  nickname=(nickInput?.value||'').trim() || 'user';
  if(!roomCode){ setStatus('Введите Room Code'); return; }
  secretKey=await deriveKey(roomCode);
  setStatus('Проверяю микрофон…'); await tryGetMic();
  startP2P();
  voicePanel?.classList.remove('hidden');
  addChat(`You joined room ${roomCode} as ${nickname}`);
});
if (leaveBtn) leaveBtn.addEventListener('click', ()=>{
  stopVAD(); setMicState(false);
  for (const {peer,audioEl} of peers.values()){ try{ peer.destroy(); }catch{}; if(audioEl) try{ audioEl.remove(); }catch{} }
  peers.clear(); redrawUsers(); if(p2pt){ try{ p2pt.destroy?.(); }catch{} p2pt=null; }
  setStatus('Отключено.'); voicePanel?.classList.add('hidden');
});
if (sendBtn) sendBtn.addEventListener('click', async ()=>{
  const text=(msgInput?.value||'').trim(); if(!text) return;
  try{ await sendChatToAll(text); addChat(`Me: ${text}`); msgInput.value=''; }
  catch(e){ console.error(e); setStatus('Не удалось отправить сообщение.'); }
});

// Подсказка по HTTPS
if (location.protocol!=='https:' && location.hostname!=='localhost' && location.hostname!=='127.0.0.1'){
  console.warn('getUserMedia доступен только в HTTPS или на localhost');
}
