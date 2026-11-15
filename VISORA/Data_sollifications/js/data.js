/* ============================================================
   EARTH JUKEBOX · data.js
   Datos de las imágenes, teoría musical, utilidades y estado compartido.
   (Scripts clásicos: lo declarado aquí es visible en audio.js, effects.js,
   hands.js y main.js, que se cargan después en este orden.)
   ============================================================ */

/* Coordenadas lógicas del lienzo: la música y las manos trabajan en 900×600
   aunque el lienzo real se dibuje a la resolución de la pantalla. */
const W = 900, H = 600;

/* Contexto de audio con más margen (buffer más grande): menos trabones cuando la
   computadora está ocupada con el video y el Kinect. ?latency=interactive|balanced|playback */
(()=>{
  const q = new URLSearchParams(location.search).get('latency');
  // 'playback' = buffer grande: el audio aguanta picos de CPU (Kinect, Python, video) sin crujir.
  // Las notas de las manos no esperan el lookahead (main.js usa Tone.immediate), así que responden rápido.
  const hint = ['interactive','balanced','playback'].includes(q) ? q : 'playback';
  // true = cerrar el contexto que Tone crea al cargar. OJO: en Tone 14, Tone.context, Tone.Transport y
  // Tone.Destination quedan "congelados" apuntando a ese contexto viejo; por eso el código usa siempre
  // Tone.getContext() (antes había DOS contextos y el reloj iba en uno y los instrumentos en otro).
  try{ Tone.setContext(new Tone.Context({ latencyHint:hint, lookAhead:.2 }), true); }catch(e){ console.warn('contexto de audio:', e); }
})();

/* Puente de kinect/auralis_visuals.py: manos, vista del sensor y las imágenes de recursos/space */
const AURALIS_URL = 'http://127.0.0.1:8765';
/* Carpeta de imágenes vista desde earth-jukebox/ (respaldo si el programa no corre) */
const SPACE_DIR = '../recursos/space/';
const space = file => [AURALIS_URL + '/space/' + file, SPACE_DIR + file];

/* ---------- Imágenes y música ----------
   Las 6 imágenes de recursos/space. Cada una tiene su instrumento, modo y tempo.
   El color de acento (HUD, efectos, interfaz) se saca de la propia imagen al cargarla.
   Puedes cambiar title/mood a lo que muestre cada imagen. */
const TILES = [
  {
    key:'space1', voiceType:'earth', title:'Espacio 01', mood:'Do mayor · 84 bpm', bpm:84,
    srcs: space('stock1.png'),
    fallback:['#0b2a4a','#2f7d5b'], rev:.35, choirLvl:.6,
    rootPc:0, scale:[0,2,4,5,7,9,11], modeName:'IONIAN · PIANO ELÉCTRICO',
    chords:[
      {n:'Cmaj7', t:['C3','E3','G3','B3']},
      {n:'Am7',   t:['A2','C3','E3','G3']},
      {n:'Fmaj7', t:['F2','A2','C3','E3']},
      {n:'G6',    t:['G2','B2','D3','E3']}
    ]
  },
  {
    key:'space2', voiceType:'aurora', title:'Espacio 02', mood:'La menor · 72 bpm', bpm:72,
    srcs: space('stock2.png'),
    fallback:['#02110d','#2fbf8a'], rev:.9, choirLvl:1.0,
    rootPc:9, scale:[0,2,3,5,7,8,10], modeName:'AEOLIAN · CAMPANAS DE CRISTAL',
    chords:[
      {n:'Am9',   t:['A2','E3','G3','B3']},
      {n:'Fmaj7', t:['F2','C3','E3','A3']},
      {n:'Cmaj7', t:['C3','E3','G3','B3']},
      {n:'G',     t:['G2','D3','G3','B3']}
    ]
  },
  {
    key:'space3', voiceType:'nile', title:'Espacio 03', mood:'Re dórico · 92 bpm', bpm:92,
    srcs: space('stock3.jpg'),
    fallback:['#1d3b1e','#8aa345'], rev:.15, choirLvl:.25,
    rootPc:2, scale:[0,2,3,5,7,9,10], modeName:'DORIAN · CUERDAS Y TAMBOR',
    chords:[
      {n:'Dm7', t:['D3','F3','A3','C4']},
      {n:'G6',  t:['G2','B2','D3','E3']},
      {n:'Dm7', t:['D3','F3','A3','C4']},
      {n:'Am7', t:['A2','C3','E3','G3']}
    ]
  },
  {
    key:'space4', voiceType:'storm', title:'Espacio 04', mood:'Fa lidio · 66 bpm', bpm:66,
    srcs: space('stock4.png'),
    fallback:['#0a1830','#cfd8e3'], rev:.6, choirLvl:.7,
    rootPc:5, scale:[0,2,4,6,7,9,11], modeName:'LYDIAN · VIENTO Y SIERRA',
    chords:[
      {n:'Fmaj7', t:['F2','C3','E3','A3']},
      {n:'G',     t:['G2','D3','G3','B3']},
      {n:'Dm7',   t:['D2','A2','C3','F3']},
      {n:'Em7',   t:['E2','B2','D3','G3']}
    ]
  },
  {
    key:'space5', voiceType:'earth', title:'Espacio 05', mood:'Sol mixolidio · 96 bpm', bpm:96,
    srcs: space('stock5.jpg'),
    fallback:['#06203a','#4b8f6a'], rev:.3, choirLvl:.5,
    rootPc:7, scale:[0,2,4,5,7,9,10], modeName:'MIXOLYDIAN · PIANO ELÉCTRICO',
    chords:[
      {n:'G',     t:['G2','D3','G3','B3']},
      {n:'F',     t:['F2','C3','F3','A3']},
      {n:'Cadd9', t:['C3','E3','G3','D4']},
      {n:'Dm7',   t:['D3','F3','A3','C4']}
    ]
  },
  {
    key:'space6', voiceType:'aurora', title:'Espacio 06', mood:'Si menor · 60 bpm', bpm:60,
    srcs: space('stock6.png'),
    fallback:['#0b1c2c','#dbe9f4'], rev:.95, choirLvl:1.0,
    rootPc:11, scale:[0,2,3,5,7,8,10], modeName:'AEOLIAN · CAMPANAS DE HIELO',
    chords:[
      {n:'Bm7',   t:['B2','F#3','A3','D4']},
      {n:'Gmaj7', t:['G2','D3','F#3','B3']},
      {n:'Dmaj7', t:['D3','A3','C#4','F#4']},
      {n:'A',     t:['A2','E3','A3','C#4']}
    ]
  }
];

/* ---------- Utilidades ---------- */
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const lerp  = (a,b,t)=>a+(b-a)*t;
const fin   = (v,d=0)=> Number.isFinite(v) ? v : d;   // nunca dejar pasar NaN/Infinity al audio
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const midiToNote = m => Tone.Frequency(m,'midi').toNote();
function rgbToHsv(r,g,b){
  r/=255;g/=255;b/=255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn;
  let h=0;
  if(d>0){
    if(mx===r) h=((g-b)/d)%6; else if(mx===g) h=(b-r)/d+2; else h=(r-g)/d+4;
    h/=6; if(h<0) h+=1;
  }
  return { h, s: mx===0?0:d/mx, v:mx };
}
function hsvToRgb01(h,s,v){
  const i = Math.floor(h*6), f = h*6 - i, p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
  return [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][((i%6)+6)%6];
}
const rgbCss = (c, a=1)=> `rgba(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)},${a})`;
function hexToRgb01(hex){
  const n = parseInt(hex.replace('#',''),16);
  return [(n>>16&255)/255, (n>>8&255)/255, (n&255)/255];
}
const bassNote = ch => { let m = ch.m[0]; if(m>=45) m-=12; return midiToNote(m); };

/* ---------- Temas (contorno tomado de tu melodía en Do menor) ----------
   Números = grados de la escala de cada imagen (0 = tónica en octava 4, 7 = tónica una octava arriba).
   Así el mismo tema suena menor, dórico, lidio… según el modo de la imagen. */
const THEMES = [
  [7,8,9,11, 9,8,7,4, 5,7,8,10, 9,8,7,6, 7,8,9,11, 14,11,9,8, 10,9,8,5, 7],        // A: heroico (tu frase)
  [4,7,9,11, 10,9,8,7, 4,7,8,9, 11,12,11,9, 8,7,6,7, 4,5,6,7, 9,11,14,11,9,8,7],   // B: ascenso épico
  [7,9,8,7,6,4, 5,7,6,4,3,4, 7,9,11,10,9,8,7,8, 7]                                  // C: lírico
];
const degMidi = (T,d)=>{ const o=Math.floor(d/7), k=((d%7)+7)%7; let m=60+T.rootPc+T.scale[k]; if(T.rootPc>6) m-=12; return m+12*o; };

/* Cuánto aporta cada librería orquestal en cada tipo de imagen */
const MIX = {
  earth :{str:.7,cel:.5,hrn:.5,tim:.5,syn:.4},
  aurora:{str:.6,cel:.2,hrn:0, tim:0, syn:.8},
  nile  :{str:.4,cel:.8,hrn:.3,tim:.9,syn:.2},
  storm :{str:.9,cel:.7,hrn:.8,tim:1, syn:.5}
};

/* ---------- Estado compartido ---------- */
const state = { muted:false, tile:null, hovering:false, step:0, choirReady:false, started:false };
let audio = null;
