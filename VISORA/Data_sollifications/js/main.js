/* ============================================================
   EARTH JUKEBOX · main.js
   Une todo: carga de imágenes, análisis de píxeles bajo cada mano,
   armonía, notas, carrusel y bucle de render.

   Las manos son el instrumento:
   · cada mano levantada es un cursor que toca sus propias notas
     (izquierda una octava abajo, derecha la melodía)
   · el color bajo la mano que más se mueve decide el acorde
   · la velocidad decide densidad, ritmo y la textura de órgano/reloj
   · un aplauso pasa a la siguiente imagen
   ============================================================ */

const $ = id => document.getElementById(id);
const BW = 1800, BH = 1200;    // resolución de la textura (la lógica usa 900×600)

/* ---------- preparar cada imagen ---------- */
TILES.forEach((T,i)=>{
  T.index = i;
  T.pool = [];
  const r = T.rootPc;
  for(let oct=4; oct<=5; oct++) T.scale.forEach(s=>{ let m = 12*(oct+1) + r + s; if(r>6) m -= 12; T.pool.push(m); });
  T.pool.push(T.pool[0]+24);
  T.poolLo = Math.min(...T.pool); T.poolHi = Math.max(...T.pool);
  T.chords.forEach(c=>{ c.m = c.t.map(n=>Tone.Frequency(n).toMidi()); c.pcs = new Set(c.m.map(m=>m%12)); });
  T.hover = false; T.speed = 0; T.lead = null;
  T.chordIdx = 0; T.candIdx = 0; T.candN = 0; T.lastChord = 0;
  T.noteCount = 0; T.theme = THEMES[i%THEMES.length]; T.thIdx = 0;
  T.hist = []; T.chordName = T.chords[0].n;
  T.readable = false; T.ready = false; T.loading = false; T.capText = T.mood;
});

/* ============================================================
   ALMACÉN LOCAL (IndexedDB) para imágenes que sueltes tú
   ============================================================ */
function idb(){ return new Promise((res,rej)=>{
  try{
    const r = indexedDB.open('earth-jukebox',1);
    r.onupgradeneeded = ()=> r.result.createObjectStore('img');
    r.onsuccess = ()=> res(r.result);
    r.onerror = ()=> rej(r.error);
  }catch(e){ rej(e); }
});}
async function idbGet(k){
  try{ const db = await idb();
    return await new Promise(res=>{ const q = db.transaction('img').objectStore('img').get(k); q.onsuccess=()=>res(q.result||null); q.onerror=()=>res(null); });
  }catch(e){ return null; }
}
async function idbPut(k,blob){
  try{ const db = await idb(); db.transaction('img','readwrite').objectStore('img').put(blob,k); }catch(e){}
}

/* ============================================================
   CARGA DE IMÁGENES
   T.base = textura en alta (para los efectos) · T.ana = 900×600 (para leer píxeles)
   ============================================================ */
function newBase(T){
  T.base = document.createElement('canvas'); T.base.width = BW; T.base.height = BH;
  T.bctx = T.base.getContext('2d');
  T.ana = document.createElement('canvas'); T.ana.width = W; T.ana.height = H;
  T.actx = T.ana.getContext('2d', { willReadFrequently:true });
}
function drawCover(T,img){
  newBase(T);
  const s = Math.max(BW/img.width, BH/img.height), w = img.width*s, h = img.height*s;
  T.bctx.drawImage(img, (BW-w)/2, (BH-h)/2, w, h);
  T.actx.drawImage(T.base, 0, 0, W, H);
  T.pal = extractPalette(T);
}
function finishTile(T, readable, text){
  T.ready = true; T.readable = readable; T.failed = false; T.capText = text || T.mood;
  if(T.active){ $('cap-m').textContent = T.capText; showImage(T); }
}
function showImage(T){
  if(!EFX.setImage(T)){ placeholder(T); return; }   // WebGL no acepta imágenes sin CORS
  EFX.setPalette(T.pal);
}

/* ---------- Paleta de la imagen ----------
   Histograma de tonos ponderado por saturación y brillo (los colores vivos pesan más).
   acc  = tono dominante, muy luminoso (acentos, mano derecha, bordes)
   acc2 = segundo tono más presente, separado ≥ 60° (si no hay, uno vecino)
   tint = el tono dominante apagado, para teñir el monocromo de fondo */
function extractPalette(T){
  const d = T.actx.getImageData(0, 0, W, H).data;
  const N = 36, wB = new Float32Array(N), cB = new Float32Array(N), sB = new Float32Array(N);
  let tot = 0, n = 0;
  for(let y=0; y<H; y+=5) for(let x=0; x<W; x+=5){
    const p = (y*W + x)*4, c = rgbToHsv(d[p], d[p+1], d[p+2]);
    n++;
    if(c.v < .16 || c.s < .14) continue;          // negro del espacio y grises no cuentan
    const w = c.s*c.s*c.v, k = Math.min(N-1, Math.floor(c.h*N));
    wB[k] += w; cB[k] += Math.cos(c.h*6.2832)*w; sB[k] += Math.sin(c.h*6.2832)*w; tot += w;
  }
  if(tot / n < .004){   // imagen casi en blanco y negro: acentos fríos y suaves
    return { acc:hsvToRgb01(.56,.28,1), acc2:hsvToRgb01(.08,.32,1), tint:hsvToRgb01(.58,.2,.85) };
  }
  const sm = i => wB[(i+N-1)%N] + 2*wB[i] + wB[(i+1)%N];
  const hueAt = i => {   // media circular del tono alrededor del pico
    let cx = 0, sy = 0;
    for(const j of [i-1, i, i+1]){ const k = (j+N)%N; cx += cB[k]; sy += sB[k]; }
    return ((Math.atan2(sy, cx)/6.2832) + 1) % 1;
  };
  let k1 = 0; for(let i=1;i<N;i++) if(sm(i) > sm(k1)) k1 = i;
  let k2 = -1;
  for(let i=0;i<N;i++){
    const dist = Math.min(Math.abs(i-k1), N - Math.abs(i-k1));
    if(dist >= 6 && sm(i) > sm(k1)*.22 && (k2 < 0 || sm(i) > sm(k2))) k2 = i;
  }
  const h1 = hueAt(k1), h2 = k2 >= 0 ? hueAt(k2) : (h1 + .14) % 1;
  return { acc:hsvToRgb01(h1, .72, 1), acc2:hsvToRgb01(h2, k2 >= 0 ? .55 : .4, 1), tint:hsvToRgb01(h1, .35, .9) };
}
function loadFromBlob(T,blob){
  return new Promise(res=>{
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = ()=>{ drawCover(T,img); URL.revokeObjectURL(url); finishTile(T,true); res(true); };
    img.onerror = ()=>{ URL.revokeObjectURL(url); res(false); };
    img.src = url;
  });
}
async function setLocalImage(T,file){
  if(await loadFromBlob(T,file)) idbPut(T.key,file);
}
async function loadTile(T){
  // 1) imagen guardada por ti
  const saved = await idbGet(T.key);
  if(saved && await loadFromBlob(T,saved)) return;
  // 2) URLs remotas con CORS (permiten leer los píxeles)
  let list;
  try{ const u = localStorage.getItem('ej-url-'+T.key); list = u ? [u, ...T.srcs] : T.srcs.slice(); }catch(e){ list = T.srcs.slice(); }
  let i = 0;
  const next = ()=>{
    if(i >= list.length){ placeholder(T); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = ()=>{
      drawCover(T,img);
      try{ T.actx.getImageData(0,0,1,1); }catch(e){ next(); return; }
      finishTile(T,true);
    };
    img.onerror = next;
    img.src = list[i++];
  };
  next();
}
function placeholder(T){
  newBase(T);
  const g = T.bctx.createLinearGradient(0,0,BW,BH);
  g.addColorStop(0,T.fallback[0]); g.addColorStop(1,T.fallback[1]);
  T.bctx.fillStyle = g; T.bctx.fillRect(0,0,BW,BH);
  const rnd = mulberry32(T.index+11);
  for(let k=0;k<160;k++){
    T.bctx.fillStyle = `rgba(255,255,255,${rnd()*.09})`;
    T.bctx.beginPath(); T.bctx.arc(rnd()*BW,rnd()*BH,20+rnd()*180,0,7); T.bctx.fill();
  }
  T.bctx.fillStyle = 'rgba(255,255,255,.75)';
  T.bctx.font = '500 40px "JetBrains Mono", monospace'; T.bctx.textAlign = 'center';
  T.bctx.fillText('Corre kinect/auralis_visuals.py para ver esta imagen', BW/2, BH/2 - 24);
  T.bctx.font = '400 30px "JetBrains Mono", monospace';
  T.bctx.fillText('(o suéltala aquí / usa "Cargar imagen")', BW/2, BH/2 + 30);
  T.actx.drawImage(T.base, 0, 0, W, H);
  T.pal = extractPalette(T);
  T.ready = true; T.readable = true; T.failed = true;
  T.capText = 'sin imagen · corre auralis_visuals.py';
  if(T.active){ $('cap-m').textContent = T.capText; EFX.setImage(T); EFX.setPalette(T.pal); }
}

/* ============================================================
   ANÁLISIS DE PÍXELES (bajo cada mano)
   ============================================================ */
function samplePixels(T, h){
  const f = h.f;
  const px = clamp(fin(h.px,W/2), 0, W-1), py = clamp(fin(h.py,H/2), 0, H-1);
  const R = 18, S = 2*R+1;
  const x = clamp(Math.round(px)-R, 0, W-S), y = clamp(Math.round(py)-R, 0, H-S);
  const ci = Math.round(px)-x, cj = Math.round(py)-y;
  const d = T.actx.getImageData(x,y,S,S).data;
  let r=0,g=0,b=0,n=0, sr=0,sg=0,sb=0,sn=0, ls=0,ls2=0,ln=0;
  for(let j=0;j<S;j++){
    for(let i=0;i<S;i++){
      const p = (j*S+i)*4;
      r+=d[p]; g+=d[p+1]; b+=d[p+2]; n++;
      const di = Math.abs(i-ci), dj = Math.abs(j-cj);
      if(di<=7 && dj<=7){
        const l = .299*d[p]+.587*d[p+1]+.114*d[p+2];
        ls+=l; ls2+=l*l; ln++;
        if(di<=2 && dj<=2){ sr+=d[p]; sg+=d[p+1]; sb+=d[p+2]; sn++; }
      }
    }
  }
  const lumBig = (.299*r+.587*g+.114*b)/n/255;
  const lum = sn ? (.299*sr+.587*sg+.114*sb)/sn/255 : lumBig;
  const hsv = rgbToHsv(r/n,g/n,b/n);
  const lm = ls/ln;
  const contrast = clamp(Math.sqrt(Math.max(0,ls2/ln-lm*lm))/40, 0, 1);
  const warm = clamp((r/n - b/n)/255 + .5, 0, 1);
  f.lum = clamp(fin(lerp(f.lum, fin(lum,f.lum), .4),.5),0,1);
  f.lumBig = clamp(fin(lerp(f.lumBig, fin(lumBig,f.lumBig), .25),.5),0,1);
  f.hx = fin(lerp(f.hx, Math.cos(fin(hsv.h)*6.2832), .25),1); f.hy = fin(lerp(f.hy, Math.sin(fin(hsv.h)*6.2832), .25),0);
  f.hue = fin(((Math.atan2(f.hy,f.hx)/6.2832)+1)%1,0);
  f.sat = clamp(fin(lerp(f.sat, fin(hsv.s,f.sat), .25)),0,1);
  f.contrast = clamp(fin(lerp(f.contrast, contrast, .3),.2),0,1);
  f.warm = clamp(fin(lerp(f.warm, warm, .25),.5),0,1);
  f.y = clamp(fin(lerp(f.y, py/H, .4),.5),0,1);
}

/* La armonía sigue al color bajo la mano que más se mueve */
function updateHarmony(T, f, now){
  const n = T.chords.length;
  const p = f.sat < .14 ? f.lumBig : ((f.hue*.75 + f.lumBig*.25) % 1);
  const cand = Math.min(n-1, Math.floor(p*n));
  if(cand === T.chordIdx){ T.candN = 0; return; }
  if(cand === T.candIdx) T.candN++; else { T.candIdx = cand; T.candN = 1; }
  if(T.candN >= 5 && now - T.lastChord > 1100 + clamp(T.speed/1400,0,1)*900){
    T.chordIdx = cand; T.lastChord = now; T.candN = 0;
    T.chordName = T.chords[cand].n;
    if(audio && T.voice && T.hover) safe(()=>T.voice.chord(T.chords[cand], Tone.immediate()+.05, Tone.Time('1m').toSeconds()));
  }
}

/* ============================================================
   MOVIMIENTO → NOTAS (una por mano)
   ============================================================ */
const STEP_PX = 28;
const MIN_GAP = { earth:140, aurora:170, nile:120, storm:190 };   // por mano
const GLOBAL_GAP = 90;     // entre cualquier par de notas (con dos manos ya no se dobla la densidad)
let lastGlobalNote = 0;

function pickNote(T, h){
  const f = h.f, th = T.theme, chord = T.chords[T.chordIdx];
  let d = th[T.thIdx % th.length]; T.thIdx++;
  if(T.noteCount % 4 === 0){               // tiempos fuertes: aterrizan en una nota del acorde
    for(const x of [0,1,-1,2,-2]){ if(chord.pcs.has(degMidi(T,d+x)%12)){ d += x; break; } }
  }
  if(h.key === 'L'){ d -= 7; if(f.lum > .78) d += 7; }             // izquierda: una octava abajo
  else d += f.lum > .78 ? 7 : f.lum < .22 ? -7 : 0;                 // claras = agudo, oscuras = grave
  T.noteCount++;
  return degMidi(T,d);
}
function triggerNote(T, h, now){
  const m = pickNote(T, h);
  const sn = clamp(h.speed/1400,0,1);
  noteLog.push(now); lastNoteAt = now;
  const vel = clamp((.42 + sn*.18) * (1 - sn*.3) * densityGain(now) * (1 - audio.tex*.25), .05, .8);
  safe(()=>T.voice.note(m, vel, Tone.immediate()+.03));   // sin esperar el lookahead del reloj
  h.pulse = 1; h.noteName = midiToNote(m);
  T.hist.push(m); if(T.hist.length>16) T.hist.shift();
  EFX.ripple(h.px, h.py, .6 + sn*.8);
}
function playHand(T, h, now, dt){
  if(!audio || !T.voice || audio.rebuilding) return;
  if(h.held){ h.acc = 0; return; }                // el tracker perdió la mano: no tocar
  // tope de acumulación: aunque un frame tarde mucho, como máximo sale una nota
  h.acc = Math.min(h.acc + h.dist, dt > 100 ? STEP_PX : STEP_PX*2);
  if(h.acc >= STEP_PX && now - h.lastNote > MIN_GAP[T.voiceType] && now - lastGlobalNote > GLOBAL_GAP){
    h.acc = 0; h.lastNote = now; lastGlobalNote = now;
    triggerNote(T, h, now);
  }
}

/* Tempo del reloj musical. NO usar bpm.rampTo: en Tone 14 la rampa corrompe la línea de
   tiempo del Transport ("reading 'time'") y el reloj se detiene → se pierden acordes, ritmo
   y textura (el "se queda mudo"). Se fija el valor directo y solo si cambia. */
function setTempo(bpm){
  try{ if(Math.abs(Tone.getContext().transport.bpm.value - bpm) > .5) Tone.getContext().transport.bpm.value = bpm; }catch(e){ console.warn('tempo:', e); }
}

/* ---------- entrar / salir (cuando la primera mano empieza a tocar y la última se baja) ---------- */
function enterTile(T){
  if(T.hover) return;
  T.hover = true;
  pokeContext();
  ensureVoice(T);
  if(!audio || !T.voice) return;
  state.tile = T; state.hovering = true; state.step = 0;
  setTempo(T.bpm);
  T.voice.wake();
  T.voice.out.gain.rampTo(1, .2);
  audio.choirG.gain.rampTo(T.choirLvl*.5, .2); audio.orchSend.gain.rampTo(T.rev*.7, .2); audio.choirSend.gain.rampTo(T.rev*.6, .2);
}
function leaveTile(T){
  if(!T.hover) return;
  T.hover = false;
  if(state.tile === T) state.hovering = false;
  if(audio && T.voice){
    T.voice.out.gain.rampTo(0, 1.4);
    setTimeout(()=>{ if(!T.hover && T.voice) T.voice.hush(); if(audio && !state.hovering) safe(()=>audio.tx.hush()); }, 1600);
  }
}

/* ============================================================
   BUCLE PRINCIPAL
   ============================================================ */
const GRACE = 450;     // ms de gracia: el Kinect a veces pierde la mano un instante
let lastFrame = 0, lastAnyOn = 0, lastUI = 0, introHold = 0;

function frame(now){
  requestAnimationFrame(frame);
  const dt = lastFrame ? Math.min(now - lastFrame, 120) : 16; lastFrame = now;
  HANDS.tick(now);
  const T = TILES[carousel.index];
  const hands = [...HANDS.list.values()];
  const k = 1 - Math.pow(1 - .38, dt/16.7);   // suavizado del Kinect (30 Hz → 60 fps)
  let lead = null, maxSpd = 0, nOn = 0;

  for(const h of hands){
    h.alpha += ((h.vis ? 1 : 0) - h.alpha) * .15;
    h.pulse *= Math.pow(.9, dt/16.7);
    if(!h.vis){ h.speed *= .9; h.vx *= .9; h.vy *= .9; h.acc = 0; h.wasVis = false; h.dist = 0; continue; }
    if(!h.wasVis){ h.px = h.tx; h.py = h.ty; h.lastPx = h.px; h.lastPy = h.py; h.wasVis = true; h.acc = 0; h.speed = 0; }
    const kk = h.src === 'mouse' ? 1 : k;
    h.px += (h.tx - h.px)*kk; h.py += (h.ty - h.py)*kk;
    const dx = h.px - h.lastPx, dy = h.py - h.lastPy;
    h.dist = Math.hypot(dx, dy);
    h.lastPx = h.px; h.lastPy = h.py;
    const sdt = Math.max(dt, 8);
    h.vx = lerp(h.vx, clamp(dx/sdt*1000, -5000, 5000), .3);
    h.vy = lerp(h.vy, clamp(dy/sdt*1000, -5000, 5000), .3);
    h.speed = fin(lerp(h.speed, Math.min(fin(h.dist/sdt*1000), 5000), .2));
    if(h.on){ nOn++; if(h.speed >= maxSpd){ maxSpd = h.speed; lead = h; } }
  }

  // intro: levantar una mano 1.2 s también entra (para la instalación sin teclado)
  if(!state.started){
    introHold = nOn && HANDS.info.mode === 'kinect' ? introHold + dt : Math.max(0, introHold - dt*2);
    $('intro-meter').firstElementChild.style.width = Math.min(100, introHold/12) + '%';
    if(introHold > 1200) startExperience();
  }

  if(nOn) lastAnyOn = now;
  const active = state.started && (nOn > 0 || now - lastAnyOn < GRACE);
  if(T.ready){
    if(active && !T.hover) enterTile(T);
    else if(!active && T.hover) leaveTile(T);
    if(T.hover){
      T.speed = lead ? lerp(T.speed, maxSpd, .3) : T.speed*.9;
      for(const h of hands) if(h.vis && h.on){ samplePixels(T, h); playHand(T, h, now, dt); }
      if(lead){
        T.lead = lead;
        updateHarmony(T, lead.f, now);
        if(audio && T.voice && now - (T.lastUpd||0) > 60){
          T.lastUpd = now;
          safe(()=>T.voice.update(lead.f, clamp(lead.speed/1400,0,1), lead.px/W, lead.py/H));
        }
      }
    } else T.speed *= .9;
  }

  // textura Interstellar: sube con velocidad sostenida (~0.7 s) y se apaga despacio (~2 s)
  if(audio && !audio.rebuilding){
    const target = T.hover ? clamp((clamp(T.speed/1400,0,1) - .15)/.45, 0, 1) : 0;
    audio.tex = clamp(fin(audio.tex + (target - audio.tex) * (target > audio.tex ? .025 : .008)), 0, 1);
    if(now - (audio.lastTx||0) > 80){ audio.lastTx = now; safe(()=>audio.tx.update(audio.tex)); }
  }

  if(now - lastUI > 100){ lastUI = now; updateBar(T, nOn); }

  EFX.render(now, {
    T: T.ready ? T : null, hands, active: T.hover,
    tex: audio ? audio.tex : 0, started: state.started, kinect: HANDS.info
  });
}

function updateBar(T, nOn){
  const L = T.lead;
  $('t-note').textContent = L ? L.noteName : '—';
  $('t-chord').textContent = T.chordName;
  $('t-lum').textContent = L ? Math.round(L.f.lum*100)+'%' : '—';
  $('t-vel').textContent = Math.round(T.speed);
  $('t-bpm').textContent = T.bpm;
  $('t-tex').textContent = audio && audio.tex >= .02 ? Math.round(audio.tex*100)+'%' : '—';
  $('t-hands').textContent = nOn || '—';
  if(audio) $('t-voices').textContent = (T.voice ? T.voice.voices() : 0) + audio.tx.voices + SV.ends.length;
  const k = HANDS.info;
  $('kinect-state').textContent = k.mode === 'kinect'
    ? (k.status === 'on' ? `Kinect${k.z ? ' · '+k.z+' m' : ''}` : `Kinect: ${k.status}`)
    : 'mouse';
}

/* ============================================================
   CARRUSEL
   ============================================================ */
const carousel = { index:0 };
function goTo(i){
  const n = TILES.length; i = (i%n+n)%n;
  const cur = TILES[carousel.index];
  if(cur.hover) leaveTile(cur);
  cur.active = false;
  /* destruir el instrumento de la imagen que dejas: la CPU no se acumula */
  if(cur !== TILES[i]) setTimeout(()=>{ if(!cur.active && !cur.hover && cur.voice){ cur.voice.dispose(); cur.voice = null; } }, 9000);   // espera a que suenen las notas ya programadas
  carousel.index = i;
  const T = TILES[i];
  T.active = true;
  $('cap-n').textContent = String(i+1).padStart(2,'0');
  $('cap-t').textContent = T.title;
  $('cap-m').textContent = T.ready ? T.capText : 'cargando…';
  $('count').innerHTML = '<b>'+String(i+1).padStart(2,'0')+'</b> / '+String(n).padStart(2,'0');
  $('frame').setAttribute('aria-label', T.title + ': mueve las manos para tocar la imagen');
  if(!T.loading){ T.loading = true; loadTile(T); }
  else if(T.ready) showImage(T);
  const nx = TILES[(i+1)%n];
  if(!nx.loading){ nx.loading = true; loadTile(nx); }
  if(audio) ensureVoice(T);
}

/* ============================================================
   INICIO, CONTROLES Y ENTRADAS
   ============================================================ */
EFX.init($('gl'), $('hud'));
HANDS.attachMouse($('frame'));
HANDS.onPress = ()=>{
  const T = TILES[carousel.index];
  pokeContext();
  if(!state.started) return;
  enterTile(T); ensureVoice(T);
  if(audio && T.voice) safe(()=>T.voice.chord(T.chords[T.chordIdx], Tone.immediate()+.03, Tone.Time('1m').toSeconds()));
};
/* Al conectarse auralis_visuals.py se recargan las imágenes que no se pudieron abrir
   (las de recursos/space llegan por ese mismo programa) */
HANDS.onConnect = ()=>{
  TILES.forEach(T=>{ if(T.failed){ T.failed = false; T.loading = false; } });
  const T = TILES[carousel.index];
  if(!T.loading){ T.loading = true; T.ready = false; $('cap-m').textContent = 'cargando…'; loadTile(T); }
};
let lastClap = 0;
HANDS.onClap = ()=>{
  const now = performance.now();
  if(!state.started || now - lastClap < 1500) return;
  lastClap = now; goTo(carousel.index + 1);
};

$('prev').addEventListener('click', ()=> goTo(carousel.index-1));
$('next').addEventListener('click', ()=> goTo(carousel.index+1));
document.addEventListener('keydown', e=>{
  if(e.key === 'ArrowLeft') goTo(carousel.index-1);
  if(e.key === 'ArrowRight') goTo(carousel.index+1);
  if(!state.started && (e.key === 'Enter' || e.key === ' ')) startExperience();
  if(e.key === 'i' || e.key === 'I') document.body.classList.toggle('info');   // datos técnicos
});

// cargar imagen propia (botón, URL o soltar sobre el lienzo)
$('btn-file').addEventListener('click', ()=> $('file').click());
$('file').addEventListener('change', ()=>{ const f = $('file').files[0]; if(f) setLocalImage(TILES[carousel.index], f); });
$('btn-url').addEventListener('click', ()=>{
  const T = TILES[carousel.index];
  const u = prompt('URL de una imagen de la Tierra (https://…):');
  if(!u) return;
  try{ localStorage.setItem('ej-url-'+T.key, u.trim()); }catch(e){}
  idbPut(T.key, null);
  T.ready = false; T.loading = true; $('cap-m').textContent = 'cargando…'; loadTile(T);
});
const frameEl = $('frame');
frameEl.addEventListener('dragover', e=>{ e.preventDefault(); frameEl.classList.add('drag'); });
frameEl.addEventListener('dragleave', ()=> frameEl.classList.remove('drag'));
frameEl.addEventListener('drop', e=>{
  e.preventDefault(); frameEl.classList.remove('drag');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if(f && f.type.startsWith('image/')) setLocalImage(TILES[carousel.index], f);
});

/* Arranque. Sin clic el navegador puede bloquear el audio: Tone.start() se espera
   como mucho 800 ms y, si sigue bloqueado, se avisa y se reanuda con el primer clic/tecla.
   (Para la instalación: abrir Chrome con --autoplay-policy=no-user-gesture-required) */
let starting = false;
async function startExperience(){
  if(state.started || starting) return;
  starting = true;
  $('btn-start').textContent = 'Cargando…';
  try{ await Promise.race([Tone.start(), new Promise(r=>setTimeout(r, 800))]); }catch(e){}
  try{ await buildAudio(); }catch(e){ console.warn('audio:', e); }
  state.started = true;
  $('intro').classList.add('out');
  checkAudioLock();
}
function checkAudioLock(){
  $('audio-lock').hidden = !state.started || Tone.getContext().state === 'running';
}
$('btn-start').addEventListener('click', startExperience);
for(const ev of ['pointerdown','keydown']) document.addEventListener(ev, ()=>{
  if(!state.started) return;
  pokeContext(); setTimeout(checkAudioLock, 250);
});
setInterval(checkAudioLock, 1000);
if(HANDS.info.mode === 'kinect') $('intro-hint').hidden = false;

$('btn-mute').addEventListener('click', e=>{
  state.muted = !state.muted;
  Tone.getContext().destination.mute = state.muted;
  e.currentTarget.textContent = state.muted ? 'Sonido off' : 'Sonido on';
});
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden){ const T = TILES[carousel.index]; if(T.hover) leaveTile(T); }
  else pokeContext();
});

goTo(0);
requestAnimationFrame(frame);
