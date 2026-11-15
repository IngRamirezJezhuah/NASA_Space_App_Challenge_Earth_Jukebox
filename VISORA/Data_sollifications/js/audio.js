/* ============================================================
   EARTH JUKEBOX · audio.js
   Motor musical (Tone.js). Mismo motor de la v7: cadena maestra con
   limitador real, presupuesto de voces, auto-nivel, vigilante de NaN/silencio
   y textura de órgano + reloj que crece con la velocidad de las manos.
   Entrada desde main.js:
     ensureVoice(T) · T.voice.note/chord/update · onStep (reloj) · audio.tex
   ============================================================ */

function status(){
  const O = audio && audio.orch, n = O ? Object.values(O.ok).filter(Boolean).length : 0;
  document.getElementById('choir-state').textContent = 'coro: '+(state.choirReady?'listo':'…')+' · orquesta '+n+'/5';
}

/* ============================================================
   MOTOR MUSICAL — un instrumento distinto por imagen
   ============================================================
   v7 · Por qué se saturaba / se callaba antes:
   1) cada imagen visitada dejaba su sintetizador vivo (ruido rosa, 6 cuerdas pluck…)
      → la CPU de audio se llenaba y el sonido crujía o se cortaba
   2) coro y orquesta (samplers) sin límite de voces → decenas apiladas al mover rápido
   3) un NaN (cursor fuera del lienzo) podía entrar a un filtro y dejarlo mudo para siempre
   4) dos ataques al mismo instante en un sinte monofónico lanzan una excepción
      que rompía el reloj musical
   5) Tone.Limiter tiene release de 10 ms (distorsiona graves) y el tanh iba ANTES del limitador
   ============================================================ */

let lastNoteAt = 0;

/* Nunca dejar que una excepción de audio rompa el bucle */
function safe(fn){
  try{ fn(); }
  catch(e){ if(!safe.w){ safe.w = 1; console.warn('audio:', e && e.message); setTimeout(()=>safe.w = 0, 2000); } }
}
/* Sintes monofónicos: el tiempo de ataque siempre avanza */
function at(syn,t){
  const now = Tone.now();
  let tt = Math.max(fin(t,now), now);
  if(syn._lt && tt <= syn._lt + .004) tt = syn._lt + .005;
  syn._lt = tt;
  return tt;
}

/* Presupuesto global de voces para los samplers (coro + orquesta) */
const SV = { ends:[], max:14 };
function svFree(now){ SV.ends = SV.ends.filter(e=>e.end>now); return SV.max - SV.ends.length; }
/* al soltar un sampler sus voces ya solo cuentan durante la cola (release) */
function sReleaseAll(sm, t, rel){
  if(!sm) return;
  safe(()=>sm.releaseAll(t));
  for(const e of SV.ends) if(e.sm === sm) e.end = Math.min(e.end, t + rel);
}
function sPlay(sm, notes, dur, t, vel, rel, essential){
  if(!sm) return false;
  const arr = Array.isArray(notes) ? notes : [notes];
  const now = Tone.immediate();
  const free = svFree(now);
  if(free < arr.length - (essential ? 10 : 0)) return false;   // opcionales se saltan; esenciales tienen un margen extra, nunca infinito
  const d = Tone.Time(dur).toSeconds();
  for(let i=0;i<arr.length;i++) SV.ends.push({ sm, end:Math.max(t,now)+d+rel });
  try{ sm.triggerAttackRelease(notes, d, Math.max(t,now), clamp(fin(vel,.3),.01,1)); }catch(e){ return false; }
  return true;
}

/* Densidad: con muchas notas por segundo cada una suena más suave → la suma no crece */
const noteLog = [];
function densityGain(now){
  while(noteLog.length && now - noteLog[0] > 1000) noteLog.shift();
  return 1/Math.sqrt(1 + Math.max(0, noteLog.length-2)/3);
}

/* Respuesta al impulso de la reverb: ruido estéreo con caída exponencial, 2.6 s.
   Se calcula UNA vez y se reutiliza (antes Tone.Reverb renderizaba 8 s offline en cada
   arranque y en cada reinicio → pico de CPU justo cuando el audio ya iba mal). */
let _ir = null;
function reverbIR(){
  if(_ir) return _ir;
  const sr = Tone.getContext().sampleRate, n = Math.floor(sr*2.6), fade = Math.floor(sr*.004);
  const L = new Float32Array(n), R = new Float32Array(n);
  for(let i=0;i<n;i++){
    const env = Math.pow(1 - i/n, 3.4) * (i < fade ? i/fade : 1);
    L[i] = (Math.random()*2-1)*env; R[i] = (Math.random()*2-1)*env;
  }
  _ir = Tone.ToneAudioBuffer.fromArray([L, R]);
  return _ir;
}

/* ---------- Cadena maestra (reconstruible) ----------
   voces → bus → auto-nivel → corte de graves (70 Hz) → menos "lodo" → limitador
   → compensación → protección final → salida

   POR QUÉ SATURABA: el DynamicsCompressor del navegador SUBE el volumen por su cuenta
   ("makeup gain" automático = 0.6 · |umbral| · (1 − 1/ratio) dB). Antes había dos en
   cadena: una señal a −20 dB salía a −7.5 dB (+12.5 dB) y el recorte tanh final la
   distorsionaba → la bocina "tronaba". Ahora hay UN limitador y su makeup se resta.
   Medido en Chrome: debajo del umbral la cadena queda en ganancia 1 (0 dB). */
const LIM_T = -9, LIM_R = 20;
const LIM_MAKEUP = .6 * (-LIM_T) * (1 - 1/LIM_R);        // dB que el navegador agrega solo
async function buildMaster(){
  const nodes = [], N = x => (nodes.push(x), x);
  // +4 dB: aun con el limitador al tope (≈0.35 → 0.56) se queda en la zona lineal de la protección
  const out = N(new Tone.Volume(4)).toDestination();
  // protección final: lineal hasta 0.7 (no colorea nada) y curva suave que nunca pasa de 0.95
  const safety = N(new Tone.WaveShaper(x=>{
    const a = Math.abs(x);
    return a <= .7 ? x : Math.sign(x) * (.7 + .25*Math.tanh((a - .7)/.25));
  }, 4096)).connect(out);
  safety.oversample = 'none';   // en la zona lineal no hace falta (y el sobremuestreo cuesta CPU)
  const unMakeup = N(new Tone.Gain(Tone.dbToGain(-LIM_MAKEUP))).connect(safety);
  const limiter = N(new Tone.Compressor({ threshold:LIM_T, ratio:LIM_R, attack:.003, release:.2, knee:0 })).connect(unMakeup);
  const meter = N(new Tone.Analyser('waveform', 1024)); unMakeup.connect(meter);
  // bocinas pequeñas: debajo de 70 Hz no se oye y solo las hace tronar; 160–320 Hz es el "lodo"
  const mud = N(new Tone.Filter({ frequency:320, type:'peaking', Q:1, gain:-3 })).connect(limiter);
  const shelf = N(new Tone.Filter({ frequency:160, type:'lowshelf', gain:-4 })).connect(mud);
  const lowCut = N(new Tone.Filter({ frequency:70, type:'highpass', rolloff:-24 })).connect(shelf);
  const auto = N(new Tone.Gain(1)).connect(lowCut);
  const bus = N(new Tone.Gain(.4)).connect(auto);
  const reverb = N(new Tone.Convolver(reverbIR())).connect(bus);
  const revIn = N(new Tone.Filter(260,'highpass')).connect(reverb);   // sin graves en la reverb
  return { bus, revIn, auto, meter, out, dispose:()=> nodes.forEach(n=>{ try{ n.dispose(); }catch(e){} }) };
}

/* ============================================================
   VOCES NATIVAS (ligeras)
   Antes cada instrumento era un PolySynth de Tone.js: cada voz son decenas de nodos
   que siguen corriendo aunque no suene nada, y al llenarse TIRA la nota nueva
   (los "Max polyphony exceeded" = notas que no salían → música trabada).
   Medido: un instrumento + el órgano tardaban 9.9 s de CPU por cada 12 s de audio.
   Ahora cada nota crea 1–2 osciladores nativos, suena y se libera; al llenarse se
   apaga en 25 ms la nota más vieja (nunca se pierde la nueva). Los pads y el órgano
   son N voces sostenidas que se deslizan de acorde en acorde (costo fijo).
   ============================================================ */
const mtof = m => 440 * Math.pow(2, (m - 69)/12);
const bassMidi = ch => { let m = ch.m[0]; if(m >= 45) m -= 12; return m; };
const nowA = ()=> Tone.immediate();
const sec = v => Tone.Time(v).toSeconds();

function _cache(){ const c = Tone.getContext(); return c._ej || (c._ej = { waves:new Map(), noise:null }); }
function pwave(partials){                       // onda con armónicos (órgano, flauta…), una por contexto
  const C = _cache(), key = partials.join(',');
  let w = C.waves.get(key);
  if(!w){
    const n = partials.length + 1, re = new Float32Array(n), im = new Float32Array(n);
    partials.forEach((a,i)=> im[i+1] = a);
    w = Tone.getContext().createPeriodicWave(re, im);
    C.waves.set(key, w);
  }
  return w;
}
function noiseBuffer(){
  const C = _cache();
  if(C.noise) return C.noise;
  const sr = Tone.getContext().sampleRate, n = sr*2, b = Tone.getContext().createBuffer(1, n, sr), d = b.getChannelData(0);
  for(let i=0;i<n;i++) d[i] = Math.random()*2 - 1;
  return C.noise = b;
}
function gainNode(v=0){ const g = Tone.getContext().createGain(); g.gain.value = v; return g; }
function rawBus(dest, db=0){ const g = gainNode(Tone.dbToGain(db)); Tone.connect(g, dest); return g; }
function mkOsc(wave, freq, t){
  const o = Tone.getContext().createOscillator();
  if(typeof wave === 'string') o.type = wave; else o.setPeriodicWave(wave);
  o.frequency.setValueAtTime(freq, t);
  return o;
}
function holdAt(p, t){ try{ p.cancelAndHoldAtTime(t); }catch(e){ try{ p.cancelScheduledValues(t); }catch(_){ } } }
/* ADSR sobre una ganancia; devuelve el momento en que ya se puede detener la fuente */
function adsr(g, t, dur, vel, a, d, s, r){
  const p = g.gain, ta = t + Math.max(a, .003), tr = Math.max(t + dur, ta);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(vel, ta);
  if(s < 1) p.setTargetAtTime(vel*s, ta, Math.max(.004, d/3));
  p.setTargetAtTime(0, tr, Math.max(.004, r/4));
  return tr + r*1.6 + .02;
}

/* Instrumento de notas sueltas con polifonía máxima (roba la más vieja, no tira la nueva) */
function Inst(dest, db, max){
  const bus = rawBus(dest, db), act = [];
  const prune = now => { for(let i=act.length-1;i>=0;i--) if(act[i].end <= now) act.splice(i,1); };
  const kill = (v, t, fade)=>{
    holdAt(v.g.gain, t); v.g.gain.setTargetAtTime(0, t, fade/3);
    for(const o of v.src){ try{ o.stop(t + fade*2.5); }catch(e){} }
    v.end = t + fade*2.5;
  };
  return {
    bus,
    add(src, g, end, t){
      prune(nowA());
      while(act.length >= max) kill(act.shift(), Math.max(nowA(), t - .005), .025);
      act.push({ src, g, end });
      src[0].onended = ()=>{ try{ g.disconnect(); }catch(e){} };
    },
    releaseAll(t = nowA(), fade = .3){ prune(t); act.forEach(v=>kill(v, t, fade)); act.length = 0; },
    get count(){ prune(nowA()); return act.length; },
    dispose(){ this.releaseAll(nowA(), .05); setTimeout(()=>{ try{ bus.disconnect(); }catch(e){} }, 500); }
  };
}
/* nota de oscilador (con filtro pasa-bajos opcional, con su propia envolvente) */
function nOsc(inst, wave, freq, t, dur, vel, a, d, s, r, opt){
  const o = mkOsc(wave, freq, t), g = gainNode(0);
  let last = o;
  if(opt && opt.lp){
    const f = Tone.getContext().createBiquadFilter(); f.type = 'lowpass'; f.Q.value = opt.q || .7;
    if(opt.lpPeak){ f.frequency.setValueAtTime(opt.lpPeak, t); f.frequency.setTargetAtTime(opt.lp, t, (opt.lpDecay || .2)/3); }
    else f.frequency.value = opt.lp;
    o.connect(f); last = f;
  }
  last.connect(g); g.connect(inst.bus);
  const end = adsr(g, t, dur, vel, a, d, s, r);
  o.start(t); o.stop(end);
  inst.add([o], g, end, t);
}
/* nota FM (piano eléctrico, campanas): portadora + moduladora con índice que decae */
function nFM(inst, freq, t, dur, vel, ratio, index, idxDecay, a, d, s, r){
  const car = mkOsc('sine', freq, t), mod = mkOsc('sine', freq*ratio, t);
  const mg = gainNode(0);
  mg.gain.setValueAtTime(freq*index, t); mg.gain.setTargetAtTime(0, t + .002, idxDecay/3);
  mod.connect(mg); mg.connect(car.frequency);
  const g = gainNode(0); car.connect(g); g.connect(inst.bus);
  const end = adsr(g, t, dur, vel, a, d, s, r);
  car.start(t); mod.start(t); car.stop(end); mod.stop(end);
  inst.add([car, mod], g, end, t);
}
/* tambor: senoide con caída de tono */
function nDrum(inst, freq, t, vel, pitchDecay, octaves, decay){
  const o = mkOsc('sine', freq*Math.pow(2, octaves), t), g = gainNode(0);
  o.frequency.exponentialRampToValueAtTime(freq, t + pitchDecay);
  o.connect(g); g.connect(inst.bus);
  g.gain.setValueAtTime(vel, t); g.gain.setTargetAtTime(0, t + .001, decay/4);
  const end = t + decay*1.8 + .02;
  o.start(t); o.stop(end);
  inst.add([o], g, end, t);
}
/* golpe de ruido (reloj, tek) */
function nNoise(inst, t, vel, decay){
  const src = Tone.getContext().createBufferSource(); src.buffer = noiseBuffer();
  const g = gainNode(0); src.connect(g); g.connect(inst.bus);
  g.gain.setValueAtTime(vel, t); g.gain.setTargetAtTime(0, t + .0005, decay/4);
  const end = t + decay*1.8 + .02;
  src.start(t, Math.random()*1.5); src.stop(end);
  inst.add([src], g, end, t);
}
/* Pad sostenido: no se re-ataca en cada acorde; cada voz se desliza a la nota del acorde
   nuevo (emparejadas por altura = movimiento mínimo). detune = filas desafinadas (celeste). */
function Pad(dest, db, wave, o){
  const bus = rawBus(dest, db), rows = o.detune || [0];
  let vs = null;
  return {
    bus,
    chord(midis, t, vel=.5){
      const fr = midis.map(mtof).sort((x,y)=>x-y);
      if(!vs){
        vs = fr.map(f=>{
          const g = gainNode(0); g.connect(bus);
          const oscs = rows.map(dt=>{ const x = mkOsc(wave, f, t); x.detune.value = dt; x.connect(g); x.start(t); return x; });
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel/rows.length, t + o.a);
          return { g, oscs, f };
        });
        return;
      }
      vs.sort((x,y)=>x.f-y.f);
      vs.forEach((v,i)=>{ const f = fr[Math.min(i, fr.length-1)]; v.f = f; v.oscs.forEach(x=>x.frequency.setTargetAtTime(f, t, o.glide || .08)); });
    },
    release(t = nowA()){
      if(!vs) return;
      const wait = (Math.max(0, t - nowA()) + o.r*1.6 + .5)*1000;
      for(const v of vs){
        holdAt(v.g.gain, t); v.g.gain.setTargetAtTime(0, t, o.r/4);
        v.oscs.forEach(x=>{ try{ x.stop(t + o.r*1.6 + .05); }catch(e){} });
        const g = v.g; setTimeout(()=>{ try{ g.disconnect(); }catch(e){} }, wait);
      }
      vs = null;
    },
    get on(){ return !!vs; },
    dispose(){ this.release(); setTimeout(()=>{ try{ bus.disconnect(); }catch(e){} }, 4000); }
  };
}

/* ---------- Textura "Interstellar" ----------
   Órgano de tubos (2 filas desafinadas, sin chorus) + pedal + ostinato de flauta + reloj.
   Aparece y crece (crescendo) cuanto más rápido y más tiempo mueves las manos. */
function buildTexture(M){
  const nodes = [], N = x => (nodes.push(x), x);
  const out = N(new Tone.Gain(0)).connect(M.bus);
  const wet = N(new Tone.Gain(.9)).connect(M.revIn); out.connect(wet);      // mucha reverb: nave de iglesia
  // registros de órgano: 16' 8' 5⅓' 4' 2⅔' 2'
  const organ = Pad(out, -24, pwave([.5,1,.32,.5,0,.24,0,.15]), { a:.9, r:2.4, glide:.15, detune:[-4, 4] });
  const pedal = Pad(out, -23, pwave([1,.7,.25,.3]), { a:1.4, r:3, glide:.3 });
  const W_FL = pwave([1,.15,.3,.05,.08]);
  const flute = Inst(out, -23, 4);
  // reloj: seco y cercano, fuera de la reverb grande
  const tickG = N(new Tone.Gain(0)).connect(M.bus);
  const tickF = N(new Tone.Filter({ frequency:3200, type:'bandpass', Q:6 })).connect(tickG);
  const tick = Inst(tickF, -6, 2), tock = Inst(tickG, -22, 2);
  const PAT = [0,2,1,2,3,2,1,2];   // arpegio sobre las notas del acorde actual

  /* ---- Tema de órgano para "momentos" ----
     Frase ORIGINAL (no es la melodía de la película): grados de la escala de cada imagen. */
  const MOTIF = [[0,2],[4,2],[7,2],[9,4],[7,2],[11,2],[9,4],[7,2],[4,2],[5,2],[4,6]];
  const W_LEAD = pwave([1,.6,.42,.26,.16,.1,.06]);   // principal 8' + mixtura
  const leadG = N(new Tone.Gain(0)).connect(M.bus);
  const leadWet = N(new Tone.Gain(.8)).connect(M.revIn); leadG.connect(leadWet);
  const lead = Inst(leadG, -15, 3);
  let motifUntil = 0, lastMotif = -999, fullBars = 0, playSec = 0, held = null;
  function motif(t, T){
    const beat = sec('4n');
    let x = t;
    leadG.gain.rampTo(.9, .8, t);
    for(const [d, b] of MOTIF){
      nOsc(lead, W_LEAD, mtof(degMidi(T, d)), x, b*beat*.95, .7, .25, .3, .85, 1.6);
      x += b*beat;
    }
    leadG.gain.rampTo(0, 2.5, x + .3);
    motifUntil = x + 1;
  }
  const release = t => { organ.release(t); pedal.release(t); held = null; };
  return {
    update(tex){
      out.gain.rampTo(tex*.9, .25);
      tickG.gain.rampTo(tex > .12 ? .25 + tex*.75 : 0, .2);
    },
    /* El tema suena solo en momentos: textura al máximo 3 compases seguidos,
       o tras ~50 s tocando. Nunca más de una vez cada 35 s. */
    step(s, t, tex, ch, T){
      if(s === 0 && T){
        const now = nowA(), bar = sec('1m');
        fullBars = tex > .8 ? fullBars + 1 : 0;
        playSec = state.hovering ? playSec + bar : Math.max(0, playSec - bar);   // bajar las manos un momento no lo reinicia
        if(now > motifUntil + 4 && now - lastMotif > 35 && (fullBars >= 3 || (playSec > 50 && tex > .25))){
          motif(t, T); lastMotif = now; playSec = 0; fullBars = 0;
        }
      }
      if(tex < .1){ if(held) release(t); return; }
      if(s === 0 && held !== ch){
        organ.chord(ch.m, t, .45 + tex*.4);
        pedal.chord([bassMidi(ch)], t, .7);
        held = ch;
      }
      if(s % 4 === 0){
        nNoise(tick, t, s === 0 ? 1 : .55, .018);
        nDrum(tock, mtof(84), t, s === 0 ? .6 : .3, .008, 2, .05);
      }
      if(tex > .45 && s % 2 === 0){
        const m = ch.m[PAT[(s/2)%8] % ch.m.length] + 12;
        nOsc(flute, W_FL, mtof(m), t, sec('8n'), .2 + tex*.35, .025, .25, .6, .5);
      }
    },
    hush(){ if(held) release(nowA()); flute.releaseAll(); leadG.gain.rampTo(0, .8); },
    get motifOn(){ return nowA() < motifUntil; },
    get voices(){ return flute.count + lead.count + tick.count + tock.count + (organ.on ? 8 : 0) + (pedal.on ? 1 : 0); },
    dispose(){
      organ.dispose(); pedal.dispose(); [flute, tick, tock, lead].forEach(i=>i.dispose());
      setTimeout(()=> nodes.forEach(n=>{ try{ n.dispose(); }catch(e){} }), 100);
    }
  };
}

async function buildAudio(){
  const M = await buildMaster();

  /* Coro y orquesta. Antes se descargaban y decodificaban 34 archivos a la vez, justo
     mientras ya sonaba la música → trabones. Ahora: 3–4 muestras por instrumento
     (el sampler transpone el resto) y se cargan EN CADENA, una librería tras otra. */
  const choirG = new Tone.Gain(.5).connect(M.bus);
  const choirSend = new Tone.Gain(.3).connect(M.revIn); choirG.connect(choirSend);
  const orchG = new Tone.Gain(.5).connect(M.bus);
  const orchSend = new Tone.Gain(.3).connect(M.revIn); orchG.connect(orchSend);
  const O = { ok:{} };
  const BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';
  const LIBS = [   // [clave, carpeta, volumen dB, ataque, release, notas]
    ['choir','choir_aahs',       -14, .7, 2.5, ['C3','C4','C5']],
    ['str',  'string_ensemble_1',-12, .5, 1.8, ['C3','C4','C5']],
    ['cel',  'cello',            -10, .05,1.2, ['C2','C3','C4']],
    ['syn',  'pad_3_polysynth',  -14, .15,1.5, ['C3','C4','C5']],
    ['hrn',  'french_horn',      -11, .08,1.2, ['C3','C4']],
    ['tim',  'timpani',           -8, 0,  1.5, ['C2','C3']]
  ];
  let choir = null;
  const loadNext = k=>{
    if(k >= LIBS.length) return;
    const [key, folder, vol, att, rel, notes] = LIBS[k];
    const urls = {}; notes.forEach(n=> urls[n] = n + '.mp3');
    const next = ()=> setTimeout(()=>loadNext(k+1), 250);   // respiro entre librerías
    const sm = new Tone.Sampler({
      urls, baseUrl: BASE + folder + '-mp3/', attack:att, release:rel,
      onload:()=>{
        if(key === 'choir'){ state.choirReady = true; }
        else O.ok[key] = true;
        status(); next();
      },
      onerror:()=>{ if(key === 'choir') document.getElementById('choir-state').textContent = 'coro: sin conexión'; next(); }
    }).connect(key === 'choir' ? choirG : orchG);
    sm.volume.value = vol;
    if(key === 'choir'){ choir = sm; if(audio) audio.choir = sm; } else O[key] = sm;
  };
  document.getElementById('choir-state').textContent = 'coro: cargando…';
  setTimeout(()=>loadNext(0), 600);   // primero que arranque el audio; luego las muestras

  audio = { M, choir, choirG, choirSend, orch:O, orchG, orchSend, tx:buildTexture(M), tex:0, rebuilding:false, lastRebuild:0 };
  ensureVoice(TILES[carousel.index]);

  Tone.getContext().transport.scheduleRepeat(onStep, '16n');
  Tone.getContext().transport.start();
  startWatchdog();
}

/* Si algo se rompe (NaN o silencio inesperado), se reconstruye la cadena sin recargar las muestras.
   Ahora es barato (la reverb ya no se recalcula) y tiene freno: como mucho una vez cada
   8 s y 4 veces cada 2 min, para no entrar en un ciclo de reinicios que empeore la carga. */
const REBUILDS = [];
async function rebuildAudio(reason){
  const now = performance.now();
  while(REBUILDS.length && now - REBUILDS[0] > 120000) REBUILDS.shift();
  if(!audio || audio.rebuilding || now - audio.lastRebuild < 8000 || REBUILDS.length >= 4) return;
  REBUILDS.push(now);
  audio.rebuilding = true; audio.lastRebuild = now;
  console.warn('Earth Jukebox: reiniciando audio ('+reason+')');
  try{
    TILES.forEach(T=>{ if(T.voice){ T.voice.dispose(); T.voice = null; } });
    safe(()=>audio.tx.dispose());
    [audio.choir, audio.orch.str, audio.orch.cel, audio.orch.hrn, audio.orch.tim, audio.orch.syn]
      .forEach(sm=>{ if(sm) safe(()=>sm.releaseAll()); });
    [audio.choirG, audio.choirSend, audio.orchG, audio.orchSend].forEach(g=>g.disconnect());
    const old = audio.M;
    audio.M = await buildMaster();
    old.dispose();
    audio.choirG.connect(audio.M.bus); audio.choirG.connect(audio.choirSend); audio.choirSend.connect(audio.M.revIn);
    audio.orchG.connect(audio.M.bus);  audio.orchG.connect(audio.orchSend);   audio.orchSend.connect(audio.M.revIn);
    audio.tx = buildTexture(audio.M); audio.tex = 0; SV.ends = []; noteLog.length = 0;
  }catch(e){ console.warn('rebuild:', e); }
  audio.rebuilding = false;
  const T = state.tile;
  if(T && T.hover){ ensureVoice(T); if(T.voice){ T.voice.wake(); T.voice.out.gain.rampTo(1,.3); } }
}

/* Vigilante: auto-nivel, detección de NaN / silencio y reanudación del contexto */
function startWatchdog(){
  let silent = 0;
  setInterval(()=>{
    if(!audio || audio.rebuilding) return;
    const st = Tone.getContext().state;
    if(st !== 'running'){ Tone.getContext().resume().catch(()=>{}); return; }
    const d = audio.M.meter.getValue();
    let pk = 0, bad = false;
    for(let i=0;i<d.length;i++){
      const v = d[i];
      if(!Number.isFinite(v)){ bad = true; break; }
      const a = v < 0 ? -v : v; if(a > pk) pk = a;
    }
    if(bad){ rebuildAudio('NaN en la mezcla'); return; }
    // auto-nivel: si la mezcla se acerca al techo, baja el bus; luego se recupera despacio
    const g = audio.M.auto.gain, cur = g.value;
    let target = cur;
    // el limitador topa en ~0.35: si llega ahí seguido, bajar la mezcla para que casi no trabaje
    if(pk > .42) target = cur*.85; else if(pk > .33) target = cur*.95; else if(pk < .18) target = cur*1.02;
    target = clamp(target, .25, 1);
    if(Math.abs(target-cur) > .004) g.rampTo(target, .12);
    // silencio sospechoso: tocas notas durante 3 s y no sale nada
    const playing = state.hovering && performance.now() - lastNoteAt < 500;
    silent = (playing && pk === 0) ? silent+1 : 0;
    if(silent > 30){ silent = 0; rebuildAudio('silencio inesperado'); }
  }, 100);
}
function pokeContext(){ if(audio && Tone.getContext().state !== 'running') Tone.getContext().resume().catch(()=>{}); }

function ensureVoice(T){ if(audio && !audio.rebuilding && !T.voice) T.voice = buildVoice(T, audio); }

function buildVoice(T, A){
  const nodes = [], N = x => (nodes.push(x), x);
  const insts = [], pads = [];
  const I = (...a)=>{ const x = Inst(...a); insts.push(x); return x; };
  const P = (...a)=>{ const x = Pad(...a); pads.push(x); return x; };
  const M = A.M;
  const out = N(new Tone.Gain(0)).connect(M.bus);
  const send = N(new Tone.Gain(T.rev*.6)).connect(M.revIn); out.connect(send);
  const pan = N(new Tone.Panner(0)).connect(out);
  const V = { out, wake:()=>{}, sleep:()=>{} };
  let n = 0, lastChord = -9, lastSing = -9;
  const sing = (m,dur,t,v)=>{ if(state.choirReady && t-lastSing>.6 && sPlay(A.choir, midiToNote(m), dur, t, v*.6, 2.5, false)) lastSing = t; };
  const sangChord = (ch,shift,dur,t,v)=>{ if(state.choirReady){ sReleaseAll(A.choir, t, 2.5); sPlay(A.choir, ch.m.slice(2).map(x=>midiToNote(x+shift)), dur, t, v*.6, 2.5, true); } };

  if(T.voiceType === 'earth'){
    // piano eléctrico FM + pad triangular + bajo + arpegio
    const delay = N(new Tone.FeedbackDelay({ delayTime:'8n', feedback:.25, wet:.18 })).connect(pan);
    const lead = I(delay, -14, 6), arp = I(delay, -23, 3), bass = I(out, -12, 2);
    const padF = N(new Tone.Filter(1400,'lowpass')).connect(out);
    const pad = P(padF, -28, 'triangle', { a:1.2, r:1.4, glide:.12 });
    V.note = (m,vel,t)=>{ nFM(lead, mtof(m), t, sec('8n'), vel, 2.01, 4, .4, .004, .6, .03, .7); if(++n%4===0) sing(m,'2n',t,.5); };
    V.chord = (ch,t,bar)=>{ pad.chord(ch.m, t, .5); sangChord(ch,12,bar*1.1,t,.5); nOsc(bass, 'sine', mtof(bassMidi(ch)), t, sec('2n'), .7, .03, .5, .5, 1); };
    V.tick = (s,t,sn,ch)=>{ if(sn>.08 && s%2===0) nOsc(arp, 'sine', mtof(ch.m[(s/2)%ch.m.length]+12), t, sec('16n'), .15+sn*.15, .005, .25, 0, .4); };
    V.update = (f,sn,xn)=>{ pan.pan.rampTo((xn-.5)*1.4,.15); padF.frequency.rampTo(600+f.warm*1800,.25); };

  } else if(T.voiceType === 'aurora'){
    // campanas de cristal FM + pad senoidal + sub
    const delay = N(new Tone.FeedbackDelay({ delayTime:'4n.', maxDelay:2, feedback:.4, wet:.3 })).connect(pan);
    const lead = I(delay, -22, 6);
    const pad = P(out, -26, 'sine', { a:3, r:1.6, glide:.25 });
    const sub = P(out, -19, 'sine', { a:1.5, r:2, glide:.3 });
    const bell = (m,vel,t)=> nFM(lead, mtof(m), t, sec('16n'), vel, 5.07, 8, 1, .01, 1.8, 0, 1.2);
    V.note = (m,vel,t)=>{ bell(m+12, vel, t); if(++n%3===0) sing(m,'2n',t,.6); };
    V.chord = (ch,t,bar)=>{ pad.chord(ch.m, t, .5); sangChord(ch,12,bar*1.2,t,.75); sub.chord([bassMidi(ch)], t, .6); };
    V.tick = (s,t,sn,ch)=>{ if(sn>.1 && s%4===2) bell(ch.m[Math.floor(Math.random()*ch.m.length)]+24, .1+sn*.12, t); };
    V.update = (f,sn,xn,yn)=>{ pan.pan.rampTo((xn-.5)*1.8,.15); delay.wet.rampTo(.2+(1-yn)*.25,.25); };

  } else if(T.voiceType === 'nile'){
    // cuerda pulsada (filtro que se cierra) + tambor + tek + bajo + pad de sierra
    const W_PL = pwave([1,.55,.4,.3,.2,.14,.1,.07]);
    const pluck = I(pan, -11, 6), drum = I(out, -12, 2), bass = I(out, -12, 2);
    const tekF = N(new Tone.Filter(5200,'highpass')).connect(out);
    const tek = I(tekF, -24, 2);
    const padF = N(new Tone.Filter(900,'lowpass')).connect(out);
    const pad = P(padF, -33, 'sawtooth', { a:.8, r:1.1, glide:.1 });
    const pat = ['D','T','-','T','D','-','T','-'];
    V.note = (m,vel,t)=> nOsc(pluck, W_PL, mtof(m), t, sec('8n'), clamp(.45+vel*.9,.1,1), .002, 1.1, 0, .4,
                              { lp:220, lpPeak:220*Math.pow(2,4.2), lpDecay:.22, q:1.5 });
    V.chord = (ch,t,bar)=>{ pad.chord(ch.m, t, .5); sangChord(ch,12,bar*1.1,t,.4); nOsc(bass, 'triangle', mtof(bassMidi(ch)), t, sec('8n'), .8, .01, .3, .2, .4); };
    V.tick = (s,t,sn,ch)=>{
      if(sn <= .06) return;
      if(s%2===0){
        const c = pat[(s/2)%8];
        if(c==='D') nDrum(drum, mtof(bassMidi(ch)), t, .5+sn*.25, .03, 3, .35);
        else if(c==='T' && sn>.3) nNoise(tek, t, .5, .06);
      }
      if(s===8 && sn>.15) nOsc(bass, 'triangle', mtof(bassMidi(ch)), t, sec('8n'), .6, .01, .3, .2, .4);
    };
    V.update = (f,sn,xn)=>{ pan.pan.rampTo((xn-.5)*1.2,.15); };

  } else {
    // sierra con vibrato + pad de dos sierras desafinadas + sub + viento
    const vib = N(new Tone.Vibrato(5,.15)).connect(pan);
    const leadF = N(new Tone.Filter(900,'lowpass')).connect(vib); leadF.Q.value = 2;
    const lead = I(leadF, -21, 5);
    const padF = N(new Tone.Filter(700,'lowpass')).connect(out);
    const pad = P(padF, -30, 'sawtooth', { a:2.5, r:1.6, glide:.2, detune:[-12, 12] });
    const sub = P(out, -14, 'sine', { a:.8, r:2, glide:.3 });
    const nF = N(new Tone.Filter(400,'bandpass')); nF.Q.value = 1.2;
    const nG = N(new Tone.Gain(0)).connect(out); nF.connect(nG);
    let wind = null;
    /* el viento (ruido en bucle) solo corre mientras tocas esta imagen */
    V.wake  = ()=>{ if(wind) return; wind = Tone.getContext().createBufferSource(); wind.buffer = noiseBuffer(); wind.loop = true; Tone.connect(wind, nF); wind.start(); };
    V.sleep = ()=>{ if(!wind) return; try{ wind.stop(); wind.disconnect(); }catch(e){} wind = null; };
    V.note = (m,vel,t)=>{ nOsc(lead, 'sawtooth', mtof(m-12), t, sec('8n'), vel, .12, .5, .4, 1); if(++n%4===0) sing(m-12,'1m',t,.6); };
    V.chord = (ch,t,bar)=>{ pad.chord(ch.m, t, .5); sangChord(ch,0,bar*1.1,t,.6); sub.chord([bassMidi(ch)], t, .8); };
    V.tick = ()=>{};
    V.update = (f,sn,xn,yn)=>{
      leadF.frequency.rampTo(300 + f.lum*1800 + sn*900, .15);
      nF.frequency.rampTo(250 + xn*1800, .15);
      nG.gain.rampTo(.02 + sn*.07, .2);
      pan.pan.rampTo((xn-.5)*1.2,.15);
    };
  }

  /* Capa orquestal (muestras): como mucho una cada 300 ms, con presupuesto de voces */
  const O = A.orch, mx = MIX[T.voiceType]; let sn0 = 0, lastLayer = -9, kk = 0;
  const rN = V.note, rC = V.chord, rU = V.update;
  V.note = (m,vel,t)=>{
    rN(m,vel,t); kk++;
    if(t - lastLayer < .3) return;
    lastLayer = t;
    const k = vel/.45;
    if(O.ok.syn && mx.syn && kk%2===0) sPlay(O.syn, midiToNote(m), '4n', t, .4*mx.syn*k, 1.5, false);
    if(O.ok.hrn && mx.hrn && sn0>.4 && kk%3===0) sPlay(O.hrn, midiToNote(m-12), '4n', t, .55*mx.hrn*Math.min(1,sn0+.3)*k, 1.2, false);
  };
  V.chord = (ch,t,bar)=>{
    rC(ch,t,bar);
    const b = bassMidi(ch);
    if(O.ok.str && mx.str){ sReleaseAll(O.str, t, 1.8); sPlay(O.str, ch.m.map(x=>midiToNote(x+12)), bar*1.1, t, .5*mx.str, 1.8, true); }
    if(O.ok.cel && mx.cel) sPlay(O.cel, midiToNote(b+12), bar, t, .55*mx.cel, 1.2, true);
    if(O.ok.tim && mx.tim && sn0>.2) sPlay(O.tim, midiToNote(b<36?b+12:b), '2n', t, .6*mx.tim, 1.5, false);
  };
  V.update = (f,sn,xn,yn)=>{
    sn = clamp(fin(sn),0,1); xn = clamp(fin(xn,.5),0,1); yn = clamp(fin(yn,.5),0,1);
    sn0 = sn; rU(f,sn,xn,yn); A.orchG.gain.rampTo(.4+sn*.45,.35);
  };

  /* Anti-apilamiento: nunca dos acordes casi a la vez (entrada + clic + cambio de color) */
  const rawChord = V.chord;
  V.chord = (ch,t,bar)=>{ if(t - lastChord < 1) return; lastChord = t; rawChord(ch,t,bar); };
  V.hush = ()=>{
    const t = nowA();
    pads.forEach(p=>p.release(t)); insts.forEach(i=>i.releaseAll(t));
    if(!state.hovering) ['str','cel','hrn','tim','syn'].forEach(k=>{ if(O[k]) safe(()=>O[k].releaseAll()); });
    V.sleep();
  };
  V.voices = ()=> insts.reduce((a,i)=>a+i.count, 0) + pads.reduce((a,p)=>a+(p.on?4:0), 0);
  /* Al cambiar de imagen se destruye el instrumento anterior: la CPU no se acumula */
  V.dispose = ()=>{
    V.sleep();
    pads.forEach(p=>p.dispose()); insts.forEach(i=>i.dispose());
    setTimeout(()=> nodes.forEach(x=>{ try{ x.dispose(); }catch(e){} }), 600);
  };
  return V;
}

/* Reloj: sostiene la armonía, el ritmo y la textura que tu movimiento activa */
function onStep(time){
  const s = state.step % 16;
  state.step++;
  if(!audio || audio.rebuilding) return;
  const T = state.tile;
  if(T) audio.tx.step(s, time, audio.tex, T.chords[T.chordIdx], T);
  if(!T || !state.hovering || !T.voice) return;
  const sn = clamp(T.speed/1400,0,1);
  const ch = T.chords[T.chordIdx];
  safe(()=>{
    if(s === 0) T.voice.chord(ch, time, Tone.Time('1m').toSeconds());
    T.voice.tick(s, time, sn, ch);
  });
}
