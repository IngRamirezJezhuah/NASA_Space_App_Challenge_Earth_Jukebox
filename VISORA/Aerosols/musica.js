/* =============================================================================
   VISORA · música según el aerosol que señala el cursor
   =============================================================================
   Se carga como script normal desde Visora_2.html:

       <script src="musica.js?v=5"></script>

   No es módulo: así Chrome no lo puede cachear de la forma rara en que cachea los
   módulos, y no depende de coso.js ni de crosshair.js para arrancar.

   Por qué esta versión no se queda muda:
     · NO hay botón que haya que acordarse de pulsar. Arranca sola; el primer clic,
       tecla, rueda o toque en cualquier parte desbloquea el audio (los navegadores
       no dejan sonar nada antes de eso). El botón de abajo solo SILENCIA.
     · NO escucha eventos: consulta window.visora.crosshair 10 veces por segundo.
       Si un evento se pierde, da igual.
     · Si crosshair.js es la versión vieja y no dice el gas, lo deduce del color.
     · Si no hay dato de ninguna clase, igual suena el fondo de aire limpio.
       Si no oyes NADA, el problema es la salida de audio, no la detección.
     · Si el navegador suspende el audio (cambias de pestaña, cambias de bocina),
       lo reanuda solo.

   Gestos (opcional): se conecta al puente de kinect/auralis_visuals.py.
     · altura de las manos → registro y brillo de la melodía
     · separación entre manos → amplitud del acorde y reverb
     · velocidad → densidad de notas
     · aplauso → golpe de acento y cambio de acorde

   El letrero de abajo a la derecha dice siempre qué está pasando.
   Teclas: S silenciar · G mostrar el detalle
   ============================================================================= */
(function () {
'use strict';

var BRIDGE = 'http://127.0.0.1:8765';
var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
var lerp = function (a, b, t) { return a + (b - a) * t; };
var db = function (v) { return Math.pow(10, v / 20); };
var mtof = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
var fin = function (v, d) { return isFinite(v) ? v : (d || 0); };

/* ---------------------------------------------------------------- los gases */
/* Colores de la leyenda GEOS. ref = saturación × brillo del color puro: sirve
   para que Dust y Sea Salt, que son pálidos, compitan de igual a igual. */
var GASES = [
  { id: 0, name: 'Aire limpio',  hue: null,  ref: 1,    hex: '#9aa0a6' },
  { id: 1, name: 'Black Carbon', hue: 10.6,  ref: 0.55, hex: '#d25e45' },
  { id: 2, name: 'Dust',         hue: 275.5, ref: 0.26, hex: '#c19adc' },
  { id: 3, name: 'Sea Salt',     hue: 178.4, ref: 0.15, hex: '#85aaa9' },
  { id: 4, name: 'Sulfate',      hue: 108.9, ref: 0.65, hex: '#53dc34' }
];

/* Clasifica un color suelto. Solo se usa como respaldo, cuando crosshair.js es
   la versión vieja y no dice el gas. */
function gasFromRgb(r, g, b) {
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  var val = mx / 255, sat = mx === 0 ? 0 : c / mx;
  if (val < 0.10 || sat < 0.06) return { gas: 0, intensity: 0 };
  var h;
  if (mx === r) h = ((g - b) / c % 6 + 6) % 6;
  else if (mx === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  var best = null, bd = 1e9;
  for (var i = 1; i < GASES.length; i++) {
    var d = Math.abs(h - GASES[i].hue);
    if (d > 180) d = 360 - d;
    if (d < bd) { bd = d; best = GASES[i]; }
  }
  if (bd > 48) return { gas: 0, intensity: 0 };
  return { gas: best.id, intensity: clamp(sat * val / best.ref, 0, 1) };
}

/* ------------------------------------------------------------------- audio */
var ctx = null, M = null, V = null, started = false, muted = false;
var gas = 0, want = 0, intensity = 0, pan = 0, lat = 0;
var step = 0, nextTime = 0, bpm = 72;
var layers = {};

function gain(v) { var g = ctx.createGain(); g.gain.value = v || 0; return g; }
function filt(type, f, q) {
  var x = ctx.createBiquadFilter();
  x.type = type; x.frequency.value = f;
  if (q !== undefined) x.Q.value = q;
  return x;
}
var waveCache = {};
function pwave(parts) {
  var k = parts.join(',');
  if (!waveCache[k]) {
    var re = new Float32Array(parts.length + 1), im = new Float32Array(parts.length + 1);
    for (var i = 0; i < parts.length; i++) im[i + 1] = parts[i];
    waveCache[k] = ctx.createPeriodicWave(re, im);
  }
  return waveCache[k];
}
var noiseBuf = null;
function noise() {
  if (noiseBuf) return noiseBuf;
  var n = Math.floor(ctx.sampleRate * 3);
  noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
  var d = noiseBuf.getChannelData(0), last = 0;
  for (var i = 0; i < n; i++) { var w = Math.random() * 2 - 1; last = 0.97 * last + 0.03 * w; d[i] = w * 0.5 + last * 2.2; }
  return noiseBuf;
}
function osc(wave, f, t) {
  var o = ctx.createOscillator();
  if (typeof wave === 'string') o.type = wave; else o.setPeriodicWave(wave);
  o.frequency.setValueAtTime(fin(f, 220), t);
  return o;
}
function hold(p, t) { try { p.cancelAndHoldAtTime(t); } catch (e) { try { p.cancelScheduledValues(t); } catch (e2) { /* nada */ } } }
function adsr(g, t, dur, vel, a, d, s, r) {
  var p = g.gain, ta = t + Math.max(a, 0.003), tr = Math.max(t + dur, ta);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(clamp(fin(vel, 0.3), 0, 1), ta);
  if (s < 1) p.setTargetAtTime(vel * s, ta, Math.max(0.004, d / 3));
  p.setTargetAtTime(0, tr, Math.max(0.004, r / 4));
  return tr + r * 1.6 + 0.02;
}

/* Instrumento de notas sueltas. Al llenarse la polifonía apaga la más vieja;
   nunca descarta la nota nueva (eso es lo que hacía que la música se trabara). */
function Inst(dest, vol, max) {
  var out = gain(db(vol)); out.connect(dest);
  var act = [];
  function prune(n) { for (var i = act.length - 1; i >= 0; i--) if (act[i].end <= n) act.splice(i, 1); }
  return {
    out: out,
    add: function (src, g, end) {
      var n = ctx.currentTime;
      prune(n);
      while (act.length >= max) {
        var v = act.shift();
        hold(v.g.gain, n); v.g.gain.setTargetAtTime(0, n, 0.012);
        for (var i = 0; i < v.src.length; i++) { try { v.src[i].stop(n + 0.07); } catch (e) { /* ya */ } }
      }
      act.push({ src: src, g: g, end: end });
      src[0].onended = function () { try { g.disconnect(); } catch (e) { /* ya */ } };
    },
    silence: function (t) {
      t = t || ctx.currentTime;
      for (var i = 0; i < act.length; i++) {
        var v = act[i];
        hold(v.g.gain, t); v.g.gain.setTargetAtTime(0, t, 0.08);
        for (var j = 0; j < v.src.length; j++) { try { v.src[j].stop(t + 0.4); } catch (e) { /* ya */ } }
      }
      act.length = 0;
    }
  };
}
/* Voces sostenidas que se deslizan de acorde en acorde: coste fijo, sin re-ataques */
function Pad(dest, vol, wave, o) {
  var out = gain(db(vol)); out.connect(dest);
  var rows = o.detune || [0], vs = null;
  return {
    out: out,
    chord: function (midis, t, vel) {
      vel = vel === undefined ? 0.5 : vel;
      var fr = midis.map(mtof).sort(function (a, b) { return a - b; });
      if (!vs) {
        vs = fr.map(function (f) {
          var g = gain(0); g.connect(out);
          var oscs = rows.map(function (dt) { var x = osc(wave, f, t); x.detune.value = dt; x.connect(g); x.start(t); return x; });
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(vel / rows.length, t + o.a);
          return { g: g, oscs: oscs, f: f };
        });
        return;
      }
      vs.sort(function (a, b) { return a.f - b.f; });
      for (var i = 0; i < vs.length; i++) {
        var f = fr[Math.min(i, fr.length - 1)];
        vs[i].f = f;
        for (var j = 0; j < vs[i].oscs.length; j++) vs[i].oscs[j].frequency.setTargetAtTime(f, t, o.glide || 0.2);
      }
    },
    level: function (v, t) { if (vs) for (var i = 0; i < vs.length; i++) vs[i].g.gain.setTargetAtTime(v / rows.length, t, 0.4); },
    release: function (t) {
      if (!vs) return;
      t = t || ctx.currentTime;
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        hold(v.g.gain, t); v.g.gain.setTargetAtTime(0, t, o.r / 4);
        for (var j = 0; j < v.oscs.length; j++) { try { v.oscs[j].stop(t + o.r * 1.6 + 0.05); } catch (e) { /* ya */ } }
      }
      vs = null;
    },
    get on() { return !!vs; }
  };
}
function nOsc(I, wave, f, t, dur, vel, a, d, s, r, lp) {
  var o = osc(wave, f, t), g = gain(0), tail = o;
  if (lp) {
    var fl = filt('lowpass', lp.peak || lp.f, lp.q || 0.8);
    if (lp.peak) fl.frequency.setTargetAtTime(lp.f, t, (lp.decay || 0.2) / 3);
    o.connect(fl); tail = fl;
  }
  tail.connect(g); g.connect(I.out);
  var end = adsr(g, t, dur, vel, a, d, s, r);
  o.start(t); o.stop(end); I.add([o], g, end);
}
function nFM(I, f, t, dur, vel, ratio, index, idxDecay, a, d, s, r) {
  var c = osc('sine', f, t), m = osc('sine', f * ratio, t), mg = gain(0);
  mg.gain.setValueAtTime(f * index, t);
  mg.gain.setTargetAtTime(0, t + 0.002, idxDecay / 3);
  m.connect(mg); mg.connect(c.frequency);
  var g = gain(0); c.connect(g); g.connect(I.out);
  var end = adsr(g, t, dur, vel, a, d, s, r);
  c.start(t); m.start(t); c.stop(end); m.stop(end); I.add([c, m], g, end);
}
function nDrum(I, f, t, vel, pitchDecay, octaves, decay) {
  var o = osc('sine', f * Math.pow(2, octaves), t), g = gain(0);
  o.frequency.exponentialRampToValueAtTime(Math.max(fin(f, 40), 20), t + pitchDecay);
  o.connect(g); g.connect(I.out);
  g.gain.setValueAtTime(clamp(vel, 0, 1), t); g.gain.setTargetAtTime(0, t + 0.001, decay / 4);
  var end = t + decay * 1.8 + 0.02;
  o.start(t); o.stop(end); I.add([o], g, end);
}
function nNoise(I, t, vel, decay, hp, bp) {
  var src = ctx.createBufferSource(); src.buffer = noise();
  var g = gain(0), tail = src;
  if (hp) { var f = filt('highpass', hp); src.connect(f); tail = f; }
  if (bp) { var f2 = filt('bandpass', bp, 4); tail.connect(f2); tail = f2; }
  tail.connect(g); g.connect(I.out);
  g.gain.setValueAtTime(clamp(vel, 0, 1), t); g.gain.setTargetAtTime(0, t + 0.0005, decay / 4);
  var end = t + decay * 1.8 + 0.02;
  src.start(t, Math.random() * 1.5); src.stop(end); I.add([src], g, end);
}

/* --------------------------------------------------------- cadena maestra */
/* Un solo limitador, con su ganancia automática compensada: el compresor del
   navegador sube el volumen por su cuenta y eso es justo lo que satura. */
var LIM_T = -9, LIM_R = 20, MAKEUP = 0.6 * -LIM_T * (1 - 1 / LIM_R);
function buildMaster() {
  var out = gain(db(4)); out.connect(ctx.destination);
  var shape = new Float32Array(4096);
  for (var i = 0; i < 4096; i++) {
    var x = (i / 2047.5) - 1, a = Math.abs(x);
    shape[i] = a <= 0.7 ? x : (x < 0 ? -1 : 1) * (0.7 + 0.25 * Math.tanh((a - 0.7) / 0.25));
  }
  var safety = ctx.createWaveShaper(); safety.curve = shape; safety.connect(out);
  var un = gain(db(-MAKEUP)); un.connect(safety);
  var lim = ctx.createDynamicsCompressor();
  lim.threshold.value = LIM_T; lim.ratio.value = LIM_R;
  lim.attack.value = 0.003; lim.release.value = 0.2; lim.knee.value = 0;
  lim.connect(un);
  var meter = ctx.createAnalyser(); meter.fftSize = 1024; un.connect(meter);
  var shelf = filt('lowshelf', 160); shelf.gain.value = -3; shelf.connect(lim);
  var hp = filt('highpass', 62); hp.connect(shelf);
  var panner = ctx.createStereoPanner(); panner.connect(hp);
  var mix = gain(0.5); mix.connect(panner);
  // reverb con respuesta al impulso generada una sola vez
  var n = Math.floor(ctx.sampleRate * 3);
  var ir = ctx.createBuffer(2, n, ctx.sampleRate);
  for (var c = 0; c < 2; c++) {
    var d = ir.getChannelData(c);
    for (var k = 0; k < n; k++) d[k] = (Math.random() * 2 - 1) * Math.pow(1 - k / n, 3.2);
  }
  var rev = ctx.createConvolver(); rev.buffer = ir;
  var revAmt = gain(1); rev.connect(revAmt); revAmt.connect(mix);
  var revIn = filt('highpass', 250); revIn.connect(rev);
  return { mix: mix, revIn: revIn, revAmt: revAmt, panner: panner, out: out, meter: meter };
}

/* ------------------------------------------------------------- los ambientes */
function buildVoices() {
  // capa con eco propio: da cuerpo sin costar casi nada
  function L(wet, trim, delayTime, fb) {
    var trimG = gain(db(trim || 0)); trimG.connect(M.mix);
    var send = gain(wet); trimG.connect(send); send.connect(M.revIn);
    if (delayTime) {
      var dl = ctx.createDelay(1.5); dl.delayTime.value = delayTime;
      var fbg = gain(fb || 0.3); dl.connect(fbg); fbg.connect(dl);
      var dw = gain(0.35); dl.connect(dw); dw.connect(trimG);
      var g2 = gain(0); g2.connect(trimG); g2.connect(dl);
      return g2;
    }
    var g = gain(0); g.connect(trimG);
    return g;
  }
  var V = {};

  /* --- 1 · Black Carbon: humo denso. Grave, sucio, latido lento. --- */
  (function () {
    var out = L(0.3, 2, 0.42, 0.34); layers[1] = out;
    var growlF = filt('lowpass', 420, 4); growlF.connect(out);
    var drone = Pad(out, -19, pwave([1, 0.6, 0.35, 0.22, 0.14, 0.08]), { a: 4, r: 4, glide: 0.8 });
    var pad = Pad(growlF, -21, 'sawtooth', { a: 3, r: 3, glide: 0.5, detune: [-11, 11] });
    var lead = Inst(out, -17, 4), drum = Inst(out, -8, 2), ash = Inst(out, -24, 3);
    var SC = [0, 1, 3, 5, 7, 8, 10];
    var CH = [[36, 43, 48, 51], [34, 41, 46, 50], [36, 43, 48, 55], [33, 40, 45, 48]];
    V[1] = {
      bpm: 54, scale: SC, root: 48, chords: CH, bright: growlF, base: 260, span: 900,
      step: function (s, t, k, G) {
        var c = CH[Math.floor(step / 16) % 4];
        if (s === 0) { drone.chord([c[0] - 12], t, 0.9); pad.chord(c, t, 0.5 + k * 0.2); }
        if (s === 0 || s === 10) nDrum(drum, mtof(31), t, 0.5 + k * 0.3, 0.07, 2.2, 0.55);
        if (s === 8 && k > 0.4) nDrum(drum, mtof(38), t, 0.3 + k * 0.2, 0.04, 1.8, 0.3);
        if (k > 0.25 && s % 4 === 2 && Math.random() < 0.25 + k * 0.5 * G.dens) {
          var m = 48 + SC[Math.floor(Math.random() * 5)] + G.oct;
          nOsc(lead, 'sawtooth', mtof(m), t, 1.2, 0.26 + k * 0.22, 0.35, 0.8, 0.45, 1.5,
               { f: 240 + G.bright * 900, q: 4 });
        }
        if (k > 0.35 && s % 8 === 5) nNoise(ash, t, 0.22 * k, 1.1, 400);   // ceniza
      },
      stop: function (t) { drone.release(t); pad.release(t); [lead, drum, ash].forEach(function (i) { i.silence(t); }); }
    };
  })();

  /* --- 2 · Dust: árido. Cuerda pulsada, tambor de mano y sonaja. --- */
  (function () {
    var out = L(0.18, -4, 0.28, 0.22); layers[2] = out;
    var W = pwave([1, 0.55, 0.4, 0.3, 0.2, 0.14, 0.1, 0.07]);
    var pluckF = filt('lowpass', 2600, 1.2); pluckF.connect(out);
    var pluck = Inst(pluckF, -12, 7), hi = Inst(out, -19, 4);
    var drum = Inst(out, -11, 2), tek = Inst(out, -20, 3), shk = Inst(out, -26, 3);
    var padF = filt('lowpass', 900); padF.connect(out);
    var pad = Pad(padF, -28, 'sawtooth', { a: 1, r: 1.4, glide: 0.2, detune: [-6, 6] });
    var SC = [0, 1, 4, 5, 7, 8, 10];
    var CH = [[38, 45, 50, 54], [36, 43, 48, 53], [38, 45, 50, 57], [37, 44, 49, 53]];
    var PAT = ['D', 'T', '-', 'T', 'D', '-', 'T', '-'];
    var i = 0;
    V[2] = {
      bpm: 92, scale: SC, root: 62, chords: CH, bright: pluckF, base: 900, span: 4200,
      step: function (s, t, k, G) {
        var c = CH[Math.floor(step / 16) % 4];
        if (s === 0) pad.chord(c, t, 0.5);
        if (s % 2 === 0) {
          var p = PAT[(s / 2) % 8];
          if (p === 'D') nDrum(drum, mtof(c[0] - 12), t, 0.42 + k * 0.3, 0.03, 3, 0.35);
          else if (p === 'T' && k > 0.3) nNoise(tek, t, 0.38 * k, 0.05, 5200);
        }
        if (k > 0.3 && s % 2 === 1) nNoise(shk, t, 0.1 + k * 0.12, 0.03, 7000);   // sonaja
        if (k > 0.12 && Math.random() < 0.28 + k * 0.5 * G.dens) {
          var deg = SC[(i++ * 3 + (Math.random() < 0.5 ? 0 : 1)) % SC.length];
          var m = 62 + deg + G.oct + (Math.random() < 0.3 ? 12 : 0);
          nOsc(pluck, W, mtof(m), t, 0.5, 0.33 + k * 0.38, 0.002, 1.1, 0, 0.4,
               { f: 230, peak: 230 * Math.pow(2, 4.2), decay: 0.22, q: 1.5 });
          if (k > 0.55 && Math.random() < 0.3) nOsc(hi, 'triangle', mtof(m + 12), t + 0.06, 0.3, 0.2, 0.02, 0.4, 0.1, 0.4);
        }
      },
      stop: function (t) { pad.release(t); [pluck, hi, drum, tek, shk].forEach(function (x) { x.silence(t); }); }
    };
  })();

  /* --- 3 · Sea Salt: marino. Campanas de cristal, agua y oleaje. --- */
  (function () {
    var out = L(0.75, 0, 0.66, 0.42); layers[3] = out;
    var bell = Inst(out, -18, 6), drop = Inst(out, -22, 4);
    var pad = Pad(out, -23, 'sine', { a: 3.5, r: 3, glide: 0.4, detune: [-4, 4] });
    var sub = Pad(out, -19, 'sine', { a: 2, r: 3, glide: 0.5 });
    var wG = gain(0); wG.connect(out);
    var wF = filt('bandpass', 1200, 0.6); wF.connect(wG);
    var wP = filt('peaking', 2800, 3); wP.gain.value = 7; wP.connect(wF);
    var water = null;
    var SC = [0, 2, 4, 7, 9, 11];
    var CH = [[45, 52, 57, 64], [43, 50, 55, 62], [47, 54, 59, 66], [45, 52, 59, 64]];
    V[3] = {
      bpm: 66, scale: SC, root: 69, chords: CH, bright: wF, base: 700, span: 2600,
      start: function () { if (!water) { water = ctx.createBufferSource(); water.buffer = noise(); water.loop = true; water.connect(wP); water.start(); } },
      step: function (s, t, k, G) {
        var c = CH[Math.floor(step / 16) % 4];
        if (s === 0) { pad.chord(c, t, 0.5); sub.chord([c[0] - 12], t, 0.55); }
        wG.gain.setTargetAtTime(0.04 + k * 0.12, t, 0.5);
        if (k > 0.1 && s % 2 === 0 && Math.random() < 0.22 + k * 0.5 * G.dens) {
          var m = 69 + SC[Math.floor(Math.random() * SC.length)] + G.oct + (Math.random() < 0.3 ? 12 : 0);
          nFM(bell, mtof(m), t, 0.25, 0.18 + k * 0.22, 3.5, 4, 1.3, 0.005, 2.6, 0, 2);
        }
        if (k > 0.4 && Math.random() < 0.08) {                      // gotas
          nOsc(drop, 'sine', 900 + Math.random() * 1800, t, 0.05, 0.22, 0.002, 0.07, 0, 0.1);
        }
      },
      stop: function (t) {
        pad.release(t); sub.release(t); bell.silence(t); drop.silence(t);
        wG.gain.setTargetAtTime(0, t, 0.3);
        if (water) { try { water.stop(t + 1.5); } catch (e) { /* ya */ } water = null; }
      }
    };
  })();

  /* --- 4 · Sulfate: químico, brillante. Arpegio pulsante y campanas metálicas. --- */
  (function () {
    var out = L(0.4, 6, 0.21, 0.3); layers[4] = out;
    var arpF = filt('lowpass', 2200, 3); arpF.connect(out);
    var arp = Inst(arpF, -17, 7), bell = Inst(out, -20, 4), stab = Inst(out, -22, 3);
    var pad = Pad(out, -25, 'triangle', { a: 2, r: 2, glide: 0.25, detune: [-7, 7] });
    var SC = [0, 2, 4, 6, 7, 9, 11];
    var CH = [[48, 55, 60, 64], [50, 57, 62, 66], [45, 52, 59, 64], [47, 54, 59, 66]];
    var i = 0;
    V[4] = {
      bpm: 112, scale: SC, root: 72, chords: CH, bright: arpF, base: 800, span: 3600,
      step: function (s, t, k, G) {
        var c = CH[Math.floor(step / 16) % 4];
        if (s === 0) pad.chord(c, t, 0.5);
        if (k > 0.08 && s % 2 === 0) {
          var m = c[(i++) % c.length] + 12 + G.oct + (Math.random() < 0.22 ? 12 : 0);
          nOsc(arp, 'triangle', mtof(m), t, 0.14, 0.28 + k * 0.3, 0.004, 0.22, 0, 0.3);
        }
        if (k > 0.4 && s % 8 === 4) {
          var mm = 72 + SC[Math.floor(Math.random() * SC.length)] + G.oct;
          nFM(bell, mtof(mm), t, 0.2, 0.16 + k * 0.2, 7.01, 5, 0.9, 0.004, 1.8, 0, 1.4);
        }
        if (k > 0.6 && s === 0) nOsc(stab, 'sawtooth', mtof(c[0] + 12), t, 0.2, 0.22, 0.006, 0.3, 0.1, 0.4, { f: 1200 + G.bright * 2500, q: 2 });
      },
      stop: function (t) { pad.release(t); [arp, bell, stab].forEach(function (x) { x.silence(t); }); }
    };
  })();

  /* --- 0 · Aire limpio: fondo sereno. Siempre audible: si no se oye esto,
         el problema es la salida de audio, no la detección. --- */
  (function () {
    var out = L(0.55, 4, 0.9, 0.3); layers[0] = out;
    var wind = gain(0); wind.connect(out);
    var wF = filt('bandpass', 520, 0.7); wF.connect(wind);
    var pad = Pad(out, -22, 'sine', { a: 5, r: 5, glide: 1, detune: [-3, 3] });
    var chime = Inst(out, -24, 3);
    var src = null, ph = 0;
    var CH = [[48, 55, 60], [50, 57, 62], [45, 52, 59], [47, 54, 59]];
    V[0] = {
      bpm: 60, scale: [0, 2, 4, 7, 9], root: 72, chords: CH, bright: wF, base: 380, span: 900,
      start: function () { if (!src) { src = ctx.createBufferSource(); src.buffer = noise(); src.loop = true; src.connect(wF); src.start(); } },
      step: function (s, t, k, G) {
        if (s === 0) { pad.chord(CH[(ph++) % 4], t, 0.45); }
        wind.gain.setTargetAtTime(0.09, t, 1.2);
        wF.frequency.setTargetAtTime(380 + 260 * Math.sin(t * 0.22) + G.bright * 500, t, 0.8);
        if (s % 8 === 0 && Math.random() < 0.45) {
          var m = 72 + [0, 2, 4, 7, 9][Math.floor(Math.random() * 5)] + G.oct;
          nFM(chime, mtof(m), t, 0.2, 0.14, 2.0, 2.5, 1.5, 0.01, 2.5, 0, 2);
        }
      },
      stop: function (t) { pad.release(t); chime.silence(t); wind.gain.setTargetAtTime(0, t, 0.5); if (src) { try { src.stop(t + 1.5); } catch (e) { /* ya */ } src = null; } }
    };
  })();

  return V;
}

/* ------------------------------------------------------------------ gestos */
/* Las manos del Kinect modulan la melodía del gas que esté sonando. */
var G = { on: false, hands: 0, height: 0.5, spread: 0, speed: 0, claps: 0, status: 'sin Kinect' };
var Gs = { oct: 0, bright: 0.35, dens: 1 };   // lo que realmente llega a la música
var prevH = null, lastGest = 0, accent = 0;

function connectGestures() {
  if (typeof EventSource === 'undefined') return;
  var es;
  try { es = new EventSource(BRIDGE + '/events'); } catch (e) { return; }
  var claps = {};
  es.onopen = function () { G.status = 'conectado'; };
  es.onerror = function () { G.on = false; G.status = 'sin Kinect'; };
  es.onmessage = function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    var bodies = m.bodies || [];
    var b = null;
    for (var i = 0; i < bodies.length; i++) if (bodies[i].id === m.primary) b = bodies[i];
    if (!b && bodies.length) b = bodies[0];
    if (!b) { G.on = false; G.hands = 0; G.status = 'sin cuerpo'; return; }
    for (var j = 0; j < bodies.length; j++) {
      var x = bodies[j];
      if (claps[x.id] !== undefined && x.clap > claps[x.id] && x.id === b.id) { accent = 1; G.claps++; }
      claps[x.id] = x.clap;
    }
    var hs = [], hands = b.hands || {};
    for (var k in hands) if (hands[k] && hands[k].vis) hs.push(hands[k]);
    G.hands = hs.length;
    G.on = hs.length > 0;
    G.status = hs.length ? hs.length + ' mano(s)' : 'sin manos';
    if (!hs.length) { prevH = null; return; }
    // altura: sy va de 0 arriba a 1 abajo
    var sy = 0, sx = 0;
    for (var q = 0; q < hs.length; q++) { sy += fin(hs[q].sy, 0.5); sx += fin(hs[q].sx, 0.5); }
    sy /= hs.length; sx /= hs.length;
    G.height = clamp(1 - sy, 0, 1);
    G.spread = hs.length > 1 ? clamp(Math.abs(fin(hs[0].sx, 0.5) - fin(hs[1].sx, 0.5)) * 2, 0, 1) : 0;
    var now = performance.now();
    if (prevH && now - lastGest < 500) {
      var d = Math.hypot(sx - prevH.x, sy - prevH.y) / Math.max(0.016, (now - lastGest) / 1000);
      G.speed = lerp(G.speed, clamp(d * 1.6, 0, 1), 0.3);
    }
    prevH = { x: sx, y: sy }; lastGest = now;
  };
}

/* --------------------------------------------------------- reloj y mezcla */
function tick() {
  if (!ctx) return;
  if (ctx.state === 'suspended' && started) ctx.resume().catch(function () { /* espera gesto */ });
  if (ctx.state !== 'running') return;
  var v = V[gas] || V[0];
  var now = ctx.currentTime;

  // gestos → melodía (suavizado, y neutro si no hay Kinect)
  var tOct = G.on ? (G.height > 0.66 ? 12 : G.height < 0.33 ? -12 : 0) : 0;
  Gs.oct = Math.abs(tOct - Gs.oct) > 6 ? tOct : Gs.oct;
  Gs.bright = lerp(Gs.bright, G.on ? clamp(0.15 + G.height * 0.85, 0, 1) : 0.35, 0.06);
  Gs.dens = lerp(Gs.dens, G.on ? clamp(0.55 + G.speed * 1.1, 0.4, 1.8) : 1, 0.06);
  if (G.on) G.speed *= 0.94;

  // volumen objetivo: el aire limpio siempre se oye
  var target = muted ? 0 : (gas === 0 ? 0.5 : Math.max(0.15, clamp(intensity, 0, 1)));
  want = lerp(want, target, 0.06);
  bpm = lerp(bpm, v.bpm * (G.on ? 1 + (G.speed - 0.3) * 0.12 : 1), 0.04);

  // brillo del instrumento actual
  if (v.bright) v.bright.frequency.setTargetAtTime(v.base + Gs.bright * v.span, now, 0.25);
  // separación de manos → cuánta reverb
  M.revAmt.gain.setTargetAtTime(G.on ? 0.6 + G.spread * 0.9 : 1, now, 0.4);
  M.panner.pan.setTargetAtTime(clamp(pan, -0.7, 0.7), now, 0.4);

  // agenda las notas un poco por delante
  var spb = 60 / Math.max(30, bpm) / 4;
  var ahead = now + 0.15;
  if (nextTime < now) nextTime = now + 0.05;
  var guard = 0;
  while (nextTime < ahead && guard++ < 16) {
    var k = clamp(want, 0, 1);
    if (accent > 0.02) { k = Math.min(1, k + accent * 0.5); accent *= 0.6; }
    try { v.step(step % 16, nextTime, k, Gs); } catch (e) { warn(e); }
    step++; nextTime += spb;
  }
  // solo suena la capa del gas actual
  for (var id in layers) {
    var on = (+id) === gas;
    layers[id].gain.setTargetAtTime(on ? clamp(want, 0, 1) : 0, now, on ? 0.3 : 0.6);
  }
}
var warned = 0;
function warn(e) { if (performance.now() - warned > 3000) { warned = performance.now(); console.warn('musica.js:', e && e.message); } }

/* ------------------------------------------------------------------ fuente */
/* Consulta el cursor 10 veces por segundo. No depende de eventos. */
function poll() {
  var c = window.visora && window.visora.crosshair;
  if (!c) { intensity = lerp(intensity, 0, 0.2); setGas(0); state.src = 'sin cursor'; return; }
  var g, k;
  if (typeof c.gas === 'number') { g = c.gas; k = fin(c.intensity, 0); state.src = 'crosshair'; }
  else if (typeof c.r === 'number') { var z = gasFromRgb(c.r, c.g, c.b); g = z.gas; k = z.intensity; state.src = 'color'; }
  else { g = 0; k = 0; state.src = 'sin color'; }
  setGas(g);
  intensity = lerp(intensity, k, 0.25);
  pan = clamp(fin(c.lon, 0) / 180, -1, 1);
  lat = fin(c.lat, 0);
}
function setGas(g) {
  if (g === gas) return;
  if (V) {
    var old = V[gas];
    if (old && old.stop) { try { old.stop(ctx.currentTime + 0.05); } catch (e) { warn(e); } }
    var nu = V[g];
    if (nu && nu.start) { try { nu.start(); } catch (e2) { warn(e2); } }
  }
  gas = g; step = 0;
}

/* -------------------------------------------------------------- arranque */
var state = { src: '—' };
function boot() {
  if (ctx) return;
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'playback' });
  } catch (e) { badge.textContent = '♪ sin Web Audio'; return; }
  M = buildMaster();
  V = buildVoices();
  if (V[0].start) V[0].start();
  started = true;
  nextTime = ctx.currentTime + 0.1;
  setInterval(tick, 25);
  setInterval(poll, 100);
  connectGestures();
}
/* El primer gesto del usuario desbloquea el audio. Cualquier gesto sirve. */
function unlock() {
  boot();
  if (ctx && ctx.state !== 'running') ctx.resume().catch(function () { /* nada */ });
}
['pointerdown', 'mousedown', 'touchstart', 'keydown', 'wheel'].forEach(function (ev) {
  window.addEventListener(ev, unlock, { capture: true, passive: true });
});

/* --------------------------------------------------------------- letrero */
var css = document.createElement('style');
css.textContent =
  '#vmus{position:fixed;right:14px;bottom:12px;z-index:30;font:11px/1.5 "Courier New",monospace;' +
  'letter-spacing:.1em;color:#fff;background:#000a;border:1px solid #ffffff38;padding:6px 11px;' +
  'cursor:pointer;user-select:none;opacity:.8}' +
  '#vmus:hover{opacity:1;border-color:#fff}' +
  '#vmus b{font-weight:400;color:#fff}' +
  '#vmus.off{color:#ff8080;border-color:#ff808060}' +
  '#vmus-d{position:fixed;right:14px;bottom:46px;z-index:30;display:none;background:#000c;color:#fff;' +
  'border:1px solid #ffffff28;padding:8px 11px;font:11px/1.7 "Courier New",monospace;white-space:pre}' +
  'body.vmusd #vmus-d{display:block}';
document.head.appendChild(css);
var badge = document.createElement('div');
badge.id = 'vmus';
badge.textContent = '♪ …';
var det = document.createElement('div');
det.id = 'vmus-d';
document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(badge); document.body.appendChild(det); });
if (document.body) { document.body.appendChild(badge); document.body.appendChild(det); }

badge.addEventListener('click', function (e) { e.stopPropagation(); muted = !muted; });
window.addEventListener('keydown', function (e) {
  if (e.key === 's' || e.key === 'S') muted = !muted;
  if (e.key === 'g' || e.key === 'G') document.body.classList.toggle('vmusd');
});

var buf = null, peak = 0;
setInterval(function () {
  var g = GASES[gas] || GASES[0];
  var txt;
  if (!ctx) txt = '♪ toca la pantalla';
  else if (ctx.state !== 'running') txt = '♪ toca la pantalla';
  else if (muted) txt = '♪ silenciado';
  else txt = '♪ ' + g.name + ' ' + Math.round(clamp(want, 0, 1) * 100) + '%' + (G.on ? ' · ' + G.hands + '✋' : '');
  badge.textContent = txt;
  badge.className = (!ctx || ctx.state !== 'running' || muted) ? 'off' : '';

  if (document.body.classList.contains('vmusd')) {
    if (ctx && M && !buf) buf = new Float32Array(M.meter.fftSize);
    var lvl = 0;
    if (ctx && M && buf) { M.meter.getFloatTimeDomainData(buf); for (var i = 0; i < buf.length; i++) { var a = Math.abs(buf[i]); if (a > lvl) lvl = a; } }
    peak = Math.max(lvl, peak * 0.85);
    det.textContent =
      'audio     ' + (ctx ? ctx.state : 'sin iniciar') + (muted ? ' (silenciado)' : '') + '\n' +
      'salida    ' + (peak > 0.004 ? 'SI, sonando  pico ' + peak.toFixed(3) : 'nada') + '\n' +
      'gas       ' + g.name + '  nivel ' + clamp(want, 0, 1).toFixed(2) + '\n' +
      'datos de  ' + state.src + '\n' +
      'gestos    ' + G.status + (G.on ? '  altura ' + G.height.toFixed(2) + '  sep ' + G.spread.toFixed(2) + '  vel ' + G.speed.toFixed(2) : '');
  }
}, 250);

/* Intento de arranque sin gesto: funciona si Chrome se abrió con
   --autoplay-policy=no-user-gesture-required. Si no, espera el primer gesto. */
setTimeout(unlock, 600);

window.visora = window.visora || {};
window.visora.music = {
  get running() { return !!ctx && ctx.state === 'running'; },
  get gas() { return gas; },
  get level() { return want; },
  get gestures() { return G; },
  mute: function (v) { muted = v === undefined ? !muted : !!v; }
};
})();