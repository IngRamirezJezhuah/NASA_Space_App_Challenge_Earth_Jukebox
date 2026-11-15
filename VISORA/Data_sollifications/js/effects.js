/* ============================================================
   EARTH JUKEBOX · effects.js
   Efectos visuales procedurales estilo TouchDesigner (WebGL, sin mosaico).

   Cadena de render (dos pasadas, como una red de TOPs):
   1) FEEDBACK  (media resolución, ping-pong)
      estela anterior × decaimiento, advectada por ruido curl y por el
      arrastre de cada mano  +  emisión nueva: bordes Sobel y curvas de
      nivel de la imagen, encendidas solo donde están las manos.
   2) COMPOSICIÓN
      imagen desplazada por fbm + arrastre de la mano + ondas de cada nota,
      aberración cromática según velocidad, monocromo fuera de las manos y
      color completo dentro, retícula de puntos alrededor de cada mano,
      barrido de escaneo, líneas, grano y viñeta  +  la estela del paso 1.

   Encima, un HUD vectorial en 2D: anillos por mano, enlace entre manos,
   osciloscopio del audio, contorno melódico, minimapa del Kinect.

   API: EFX.init(glCanvas, hudCanvas) · EFX.setImage(T) · EFX.ripple(x,y,s)
        EFX.render(now, data)
   ============================================================ */

const EFX = (()=>{
  /* Paleta dinámica: se saca de cada imagen (main.js → EFX.setPalette) y cambia
     suavemente al pasar de una imagen a otra. acc = mano derecha / acentos,
     acc2 = mano izquierda / curvas de nivel, tint = matiz del monocromo. */
  const pal = { acc:[.92,1,.23], acc2:[.49,.98,1], tint:[.4,.6,.7] };
  const palT = { acc:pal.acc.slice(), acc2:pal.acc2.slice(), tint:pal.tint.slice() };
  let C_R = rgbCss(pal.acc), C_L = rgbCss(pal.acc2), lastCss = 0;
  const NAME = { L:'IZQ', R:'DER', M:'CURSOR' };
  const MAX_H = 4, MAX_RIP = 6;

  let gl = null, glc = null, hud = null, hc = null;
  let progFb = null, progOut = null, quadBuf = null, imgTex = null;
  let fbs = [], fbIdx = 0, fbW = 2, fbH = 2, cw = 2, ch = 2, dpr = 1;
  let imgPx = [1/1800, 1/1200], hasImage = false, fallbackImg = null;
  let level = 0, on = 0, lastNow = 0, t0 = performance.now();
  let quality = 1, perfT = 0, perfN = 0, perfSum = 0;   // calidad automática (resolución interna)
  const ripples = [];
  const uH = new Float32Array(MAX_H*4), uP = new Float32Array(MAX_H*4), uR = new Float32Array(MAX_RIP*4);

  /* ---------------- shaders ---------------- */
  const VS = `attribute vec2 p; varying vec2 vUv;
    void main(){ vUv = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;

  const COMMON = `
    precision highp float;
    varying vec2 vUv;
    uniform float uTime, uAspect;
    uniform vec4 uHand[${MAX_H}];   // xy posición (uv) · zw velocidad (uv/s)
    uniform vec4 uHandP[${MAX_H}];  // x activa · y velocidad 0-1 · z pulso · w radio
    float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
      return mix(mix(hash(i), hash(i+vec2(1.,0.)), u.x), mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), u.x), u.y);
    }
    float fbm(vec2 p){ float v = 0., a = .5; for(int i=0;i<4;i++){ v += a*noise(p); p *= 2.03; a *= .5; } return v; }
    vec2 curl(vec2 p){
      float e = .02;
      float a = fbm(p+vec2(0.,e)), b = fbm(p-vec2(0.,e)), c = fbm(p+vec2(e,0.)), d = fbm(p-vec2(e,0.));
      return vec2(a-b, -(c-d)) / (2.*e);
    }
    float luma(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
    // campo de influencia de las manos (gaussianas)
    float field(vec2 uv, out vec2 drag, out float spd, out float pul){
      float f = 0.; drag = vec2(0.); spd = 0.; pul = 0.;
      for(int i=0;i<${MAX_H};i++){
        vec2 d = uv - uHand[i].xy; d.x *= uAspect;
        float r = max(uHandP[i].w, .001);
        float g = exp(-dot(d,d)/(r*r)) * uHandP[i].x;
        f += g; drag += uHand[i].zw*g; spd += uHandP[i].y*g; pul += uHandP[i].z*g;
      }
      return f;
    }`;

  const FB_FS = COMMON + `
    uniform sampler2D uImg, uPrev;
    uniform vec2 uImgPx;
    uniform float uDecay, uTex, uLevel;
    uniform vec3 uAcc, uAcc2;
    float L(vec2 uv){ return luma(texture2D(uImg, uv).rgb); }
    void main(){
      vec2 uv = vUv, drag; float spd, pul;
      float f = field(uv, drag, spd, pul), m = clamp(f, 0., 1.);
      // advección: ruido curl (siempre) + arrastre de la mano
      vec2 flow = curl(uv*2.5 + uTime*.04) * (.0005 + .0018*uTex);
      flow += drag * .012;
      vec3 prev = texture2D(uPrev, uv - flow).rgb * uDecay;
      // bordes (Sobel)
      vec2 o = uImgPx*1.6;
      float tl=L(uv+vec2(-o.x,o.y)), t=L(uv+vec2(0.,o.y)), tr=L(uv+o);
      float l =L(uv-vec2(o.x,0.)),                     r=L(uv+vec2(o.x,0.));
      float bl=L(uv-o), b=L(uv-vec2(0.,o.y)), br=L(uv+vec2(o.x,-o.y));
      float gx = -tl-2.*l-bl+tr+2.*r+br, gy = tl+2.*t+tr-bl-2.*b-br;
      float edge = smoothstep(.07, .42, length(vec2(gx,gy)));
      // curvas de nivel (isolíneas) de la luz, corriendo con el tiempo
      vec3 img = texture2D(uImg, uv).rgb;
      float iso = fract(luma(img)*11. - uTime*.12);
      float isoL = 1. - smoothstep(0., .06, min(iso, 1.-iso));
      vec3 emit = uAcc*edge*(.55 + pul*1.3) + uAcc2*isoL*.5 + img*.16*(1.+spd);
      emit *= m * (.7 + uLevel*1.4);
      gl_FragColor = vec4(max(prev, emit), 1.);
    }`;

  const OUT_FS = COMMON + `
    uniform sampler2D uImg, uFb;
    uniform vec2 uRes;
    uniform float uOn, uTex, uLevel, uCell, uHas;
    uniform vec3 uAcc, uTint;
    uniform vec4 uRip[${MAX_RIP}];   // xy posición · z edad (s) · w fuerza
    void main(){
      vec2 uv = vUv, drag; float spd, pul;
      float f = field(uv, drag, spd, pul), m = clamp(f, 0., 1.);
      // desplazamiento procedural
      vec2 n = vec2(fbm(uv*5. + uTime*.2), fbm(uv*5. - uTime*.2 + 7.3)) - .5;
      vec2 disp = n * (.0018 + .02*m*(.3+spd) + .006*uTex);
      disp -= drag * .018 * m;
      for(int i=0;i<${MAX_RIP};i++){
        vec2 d = uv - uRip[i].xy; d.x *= uAspect;
        float r = length(d), age = uRip[i].z;
        float w = exp(-pow((r - age*.32)*26., 2.)) * uRip[i].w * exp(-age*2.4);
        disp += d/(r+1e-4) * w * .012;
      }
      // aberración cromática según velocidad
      float ca = .0012 + .0065*spd*m + .003*uTex;
      vec2 c = uv + disp;
      vec3 col = vec3(texture2D(uImg, c+vec2(ca,0.)).r, texture2D(uImg, c).g, texture2D(uImg, c-vec2(ca,0.)).b);
      col = mix(vec3(.04,.045,.05), col, uHas);
      float Lm = luma(col);
      // imagen SIEMPRE a todo color; donde está la mano se aviva un poco más
      float lit = clamp(m*1.35, 0., 1.);
      vec3 base = mix(col*(.93 + .07*uOn), col*(1.06 + .18*pul), lit);
      // retícula de puntos sutil en el anillo de cada mano (con los colores de la propia imagen)
      vec2 cell = fract(uv*uRes/uCell) - .5;
      float dotR = .14 + .38*Lm;
      float dots = 1. - smoothstep(dotR-.07, dotR+.02, length(cell));
      float ring = smoothstep(.04, .22, f) * (1. - smoothstep(.32, .75, f));
      base = mix(base, base*(.35 + dots*1.1), ring*.35);
      // barrido de escaneo muy suave
      float scan = exp(-pow((uv.y - fract(uTime*.06))*70., 2.));
      base += uAcc * scan * .04 * (1. - m);
      // estela de retroalimentación
      vec3 o = base + texture2D(uFb, uv).rgb * (.85 + uLevel*.8);
      // líneas, grano, viñeta
      o *= .98 + .02*sin(uv.y*uRes.y*1.5708);
      o += (hash(uv*uRes + fract(uTime)*91.) - .5) * .02;
      vec2 q = uv - .5; o *= 1. - dot(q,q)*.45;
      gl_FragColor = vec4(o, 1.);
    }`;

  /* ---------------- utilidades GL ---------------- */
  function compile(type, src){
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fs){
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for(let i=0;i<n;i++){ const a = gl.getActiveUniform(p,i); u[a.name.replace(/\[0\]$/,'')] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  function makeTex(w, h){
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if(w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }
  function makeFb(w, h){
    const tex = makeTex(w, h), fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }
  function clearFbs(){
    for(const f of fbs){ gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb); gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function setupGL(){
    progFb = program(FB_FS);
    progOut = program(OUT_FS);
    quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    imgTex = makeTex(1, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10,12,14,255]));
    fbs = []; resize(true);
  }

  /* ---------------- tamaño ---------------- */
  function resize(force){
    const r = (glc || hud).getBoundingClientRect();
    const d = Math.min(window.devicePixelRatio || 1, 1.75) * quality;
    const w = Math.max(2, Math.round(r.width*d)), h = Math.max(2, Math.round(r.height*d));
    if(!force && w === cw && h === ch) return;
    cw = w; ch = h; dpr = d;
    hud.width = cw; hud.height = ch;
    if(gl){
      glc.width = cw; glc.height = ch;
      fbW = Math.max(2, Math.round(cw*.5)); fbH = Math.max(2, Math.round(ch*.5));
      for(const f of fbs){ gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
      fbs = [makeFb(fbW, fbH), makeFb(fbW, fbH)];
    }
  }

  /* ---------------- API ---------------- */
  function init(glCanvas, hudCanvas){
    glc = glCanvas; hud = hudCanvas; hc = hud.getContext('2d');
    try{
      gl = glc.getContext('webgl', { antialias:false, alpha:false, premultipliedAlpha:false, preserveDrawingBuffer:false });
      if(!gl) throw new Error('sin WebGL');
      setupGL();
      glc.addEventListener('webglcontextlost', e=>{ e.preventDefault(); hasImage = false; });
      glc.addEventListener('webglcontextrestored', ()=>{ try{ setupGL(); if(api.current) setImage(api.current); }catch(e){ console.warn(e); } });
    }catch(e){
      console.warn('Earth Jukebox: WebGL no disponible, usando modo 2D', e);
      gl = null; glc.style.display = 'none'; resize(true);
    }
    if('ResizeObserver' in window) new ResizeObserver(()=>resize()).observe(hud);
    else addEventListener('resize', ()=>resize());
    return !!gl;
  }

  function setImage(T){
    api.current = T;
    fallbackImg = T.base;
    if(!gl){ hasImage = true; return true; }
    try{
      gl.bindTexture(gl.TEXTURE_2D, imgTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, T.base);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      imgPx = [1/T.base.width, 1/T.base.height];
      hasImage = true; clearFbs();
      return true;
    }catch(e){ hasImage = false; return false; }   // imagen sin CORS: WebGL no la acepta
  }

  function setPalette(p){
    if(!p) return;
    for(const k of ['acc','acc2','tint']) if(p[k]) palT[k] = p[k].slice();
  }
  function updatePalette(now){
    let moved = 0;
    for(const k of ['acc','acc2','tint']) for(let i=0;i<3;i++){
      const dv = palT[k][i] - pal[k][i];
      if(Math.abs(dv) > .002){ pal[k][i] += dv*.07; moved = 1; } else pal[k][i] = palT[k][i];
    }
    C_R = rgbCss(pal.acc); C_L = rgbCss(pal.acc2);
    // la interfaz HTML (botones, textos de acento) también toma el color de la imagen
    if((moved || !lastCss) && now - lastCss > 120){
      lastCss = now;
      const st = document.documentElement.style;
      st.setProperty('--acc', C_R); st.setProperty('--acc2', C_L);
    }
  }

  function ripple(x, y, s=1){
    ripples.push({ x, y, t0:performance.now(), s });
    if(ripples.length > MAX_RIP) ripples.shift();
  }

  function render(now, d){
    resize();
    const dt = lastNow ? Math.min(now - lastNow, 100) : 16; lastNow = now;
    const time = (now - t0)/1000;
    adaptQuality(now, dt);
    on += ((d.active ? 1 : 0) - on) * .08;
    updatePalette(now);

    // nivel del audio (para que la luz respire con la música)
    let wave = null;
    if(audio && audio.M && !audio.rebuilding){
      wave = audio.M.meter.getValue();
      let s = 0, n = 0; for(let i=0;i<wave.length;i+=8){ const v = wave[i]; if(Number.isFinite(v)){ s += v*v; n++; } }
      level += (Math.min(1, Math.sqrt(s/Math.max(1,n))*3) - level) * .2;
    } else level *= .95;

    // manos → uniforms
    uH.fill(0); uP.fill(0);
    let j = 0;
    for(const h of d.hands){
      if(j >= MAX_H) break;
      if(h.alpha < .02) continue;
      const sp = clamp(h.speed/1400, 0, 1);
      uH[j*4] = h.px/W; uH[j*4+1] = 1 - h.py/H;
      uH[j*4+2] = clamp(fin(h.vx)/W, -2, 2); uH[j*4+3] = clamp(-fin(h.vy)/H, -2, 2);
      uP[j*4] = h.alpha * (h.on ? 1 : .3);
      uP[j*4+1] = sp; uP[j*4+2] = clamp(h.pulse, 0, 1.5);
      uP[j*4+3] = (h.on ? .12 : .07) + sp*.06 + clamp(h.pulse,0,1)*.03;
      j++;
    }
    uR.fill(0);
    for(let i=ripples.length-1; i>=0; i--) if(now - ripples[i].t0 > 2200) ripples.splice(i,1);
    ripples.forEach((r,i)=>{ uR[i*4] = r.x/W; uR[i*4+1] = 1 - r.y/H; uR[i*4+2] = (now - r.t0)/1000; uR[i*4+3] = r.s; });

    if(gl && !gl.isContextLost()) drawGL(time, dt, d);
    drawHUD(now, d, wave);
  }

  /* si la máquina no llega a ~45 fps se baja la resolución interna (hasta 45 %); si sobra, se sube */
  function adaptQuality(now, dt){
    if(!gl) return;
    perfSum += dt; perfN++;
    if(now - perfT < 2000) return;
    const avg = perfSum / Math.max(1, perfN);
    perfT = now; perfSum = 0; perfN = 0;
    let q = quality;
    if(avg > 22) q = Math.max(.45, quality - .15);
    else if(avg < 17.5 && quality < 1) q = Math.min(1, quality + .1);
    if(q !== quality){ quality = q; resize(true); }
  }

  function bindQuad(){
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }
  function common(P, time){
    gl.uniform1f(P.u.uTime, time);
    gl.uniform1f(P.u.uAspect, W/H);
    gl.uniform4fv(P.u.uHand, uH);
    gl.uniform4fv(P.u.uHandP, uP);
  }
  function drawGL(time, dt, d){
    const acc = pal.acc, acc2 = pal.acc2;
    bindQuad();
    // 1) feedback
    const src = fbs[fbIdx], dst = fbs[1-fbIdx];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, fbW, fbH);
    gl.useProgram(progFb.p);
    common(progFb, time);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, imgTex); gl.uniform1i(progFb.u.uImg, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(progFb.u.uPrev, 1);
    gl.uniform2fv(progFb.u.uImgPx, imgPx);
    gl.uniform1f(progFb.u.uDecay, Math.pow(.955, dt/16.7));
    gl.uniform1f(progFb.u.uTex, d.tex);
    gl.uniform1f(progFb.u.uLevel, level);
    gl.uniform3fv(progFb.u.uAcc, acc);
    gl.uniform3fv(progFb.u.uAcc2, acc2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    fbIdx = 1 - fbIdx;
    // 2) composición
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.useProgram(progOut.p);
    common(progOut, time);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, imgTex); gl.uniform1i(progOut.u.uImg, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dst.tex); gl.uniform1i(progOut.u.uFb, 1);
    gl.uniform2f(progOut.u.uRes, cw, ch);
    gl.uniform1f(progOut.u.uOn, on);
    gl.uniform1f(progOut.u.uTex, d.tex);
    gl.uniform1f(progOut.u.uLevel, level);
    gl.uniform1f(progOut.u.uCell, 7*dpr);
    gl.uniform1f(progOut.u.uHas, hasImage ? 1 : 0);
    gl.uniform3fv(progOut.u.uAcc, acc);
    gl.uniform3fv(progOut.u.uTint, pal.tint);
    gl.uniform4fv(progOut.u.uRip, uR);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* ---------------- HUD vectorial ---------------- */
  const MONO = '"JetBrains Mono", monospace';
  function drawHUD(now, d, wave){
    const c = hc;
    c.setTransform(1,0,0,1,0,0);
    c.clearRect(0, 0, cw, ch);
    c.setTransform(cw/W, 0, 0, ch/H, 0, 0);   // dibujar en coordenadas lógicas 900×600

    if(!gl && fallbackImg){   // modo 2D: imagen tenue de fondo
      c.globalAlpha = .55 + .35*on; c.drawImage(fallbackImg, 0, 0, W, H); c.globalAlpha = 1;
    }
    const T = d.T;
    // solo la imagen y las manos: sin reglas, curvas ni textos encima
    const onHands = d.hands.filter(h=>h.alpha > .03 && h.on);
    if(onHands.length >= 2) drawLink(c, onHands[0], onHands[1], T);
    for(const h of d.hands) drawHand(c, h, now);
    if(d.started && !onHands.length) drawPrompt(c, now, d.kinect);
  }

  function drawFrameMarks(c, now){
    c.save();
    c.strokeStyle = 'rgba(236,236,230,.35)'; c.fillStyle = 'rgba(236,236,230,.35)'; c.lineWidth = 1;
    const L = 16;
    for(const [x,y,sx,sy] of [[6,6,1,1],[W-6,6,-1,1],[6,H-6,1,-1],[W-6,H-6,-1,-1]]){
      c.beginPath(); c.moveTo(x+sx*L, y); c.lineTo(x, y); c.lineTo(x, y+sy*L); c.stroke();
    }
    c.font = `500 8px ${MONO}`;
    for(let x=30; x<W-20; x+=30){
      const big = x % 150 === 0;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, big ? 7 : 3); c.stroke();
      if(big) c.fillText(String(x), x+3, 14);
    }
    for(let y=30; y<H-20; y+=30){
      const big = y % 150 === 0;
      c.beginPath(); c.moveTo(0, y); c.lineTo(big ? 7 : 3, y); c.stroke();
      if(big) c.fillText(String(y), 9, y+3);
    }
    c.restore();
  }

  function drawHand(c, h, now){
    if(h.alpha < .03) return;
    const col = h.key === 'L' ? C_L : C_R;
    const x = h.px, y = h.py;
    c.save();
    c.globalAlpha = h.alpha; c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.4;
    c.font = `600 11px ${MONO}`;
    if(!h.on){   // mano visible pero no levantada
      c.globalAlpha = h.alpha * .55;
      c.setLineDash([3,4]); c.beginPath(); c.arc(x, y, 12, 0, 7); c.stroke(); c.setLineDash([]);
      c.beginPath(); c.arc(x, y, 1.8, 0, 7); c.fill();
      if(h.src === 'kinect') c.fillText('LEVANTA LA MANO', clamp(x+18, 4, W-120), y+4);
      c.restore(); return;
    }
    const p = clamp(h.pulse, 0, 1.5), sp = clamp(h.speed/1400, 0, 1);
    const R = 30 + p*12;
    // anillo segmentado que gira más rápido cuanto más rápido te mueves
    const rot = now*.0012*(1 + sp*3);
    for(let i=0;i<12;i++){ const a0 = rot + i*Math.PI/6; c.beginPath(); c.arc(x, y, R, a0, a0 + Math.PI/10); c.stroke(); }
    // arco de velocidad
    c.lineWidth = 3; c.beginPath(); c.arc(x, y, R+7, -Math.PI/2, -Math.PI/2 + sp*Math.PI*1.5); c.stroke();
    c.lineWidth = 1.4;
    // núcleo
    c.beginPath(); c.arc(x, y, 5 + p*4, 0, 7); c.stroke();
    c.beginPath(); c.arc(x, y, 1.8, 0, 7); c.fill();
    // cruz con hueco
    c.beginPath();
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ c.moveTo(x+dx*(R+12), y+dy*(R+12)); c.lineTo(x+dx*(R+26), y+dy*(R+26)); }
    c.stroke();
    // etiqueta mínima: solo la nota
    const right = x < W - 120;
    c.textAlign = right ? 'left' : 'right';
    c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.55)';
    const lx = right ? x + R + 14 : x - R - 14, ly = clamp(y - R*.6, 16, H - 10);
    c.strokeText(h.noteName, lx, ly); c.fillText(h.noteName, lx, ly);
    c.restore();
  }

  function drawLink(c, a, b, T){
    c.save();
    c.strokeStyle = 'rgba(236,236,230,.6)'; c.fillStyle = '#ecece6'; c.lineWidth = 1;
    c.setLineDash([2,6]);
    c.beginPath(); c.moveTo(a.px, a.py); c.lineTo(b.px, b.py); c.stroke();
    c.setLineDash([]);
    const mx = (a.px+b.px)/2, my = (a.py+b.py)/2, dist = Math.hypot(a.px-b.px, a.py-b.py);
    c.beginPath(); c.arc(mx, my, 3, 0, 7); c.stroke();
    c.font = `600 11px ${MONO}`; c.textAlign = 'center';
    c.fillText(`${T ? T.chordName : ''}  Δ ${Math.round(dist)}`, mx, my - 10);
    c.restore();
  }

  function drawScope(c, wave){
    if(!wave) return;
    c.save();
    c.strokeStyle = rgbCss(pal.acc, .35); c.lineWidth = 1;
    const x0 = 16, x1 = W - 16, y0 = H - 54, amp = 20;
    c.beginPath();
    const n = wave.length, step = 2;
    for(let i=0;i<n;i+=step){
      const v = fin(wave[i]); const x = x0 + (x1-x0)*i/(n-1), y = y0 - clamp(v*2.2, -1, 1)*amp;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
    c.strokeStyle = 'rgba(236,236,230,.15)';
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y0); c.stroke();
    c.restore();
  }

  function drawContour(c, T){
    c.save(); c.fillStyle = C_R; c.strokeStyle = C_R; c.lineWidth = 1;
    c.globalAlpha = .4 + .6*on;
    const x0 = W/2 - 16*10;
    for(let i=0;i<16;i++){
      const x = x0 + i*20 + 10, mm = T.hist[T.hist.length-16+i];
      c.beginPath();
      if(mm === undefined){ c.arc(x, 26, 1.6, 0, 7); c.stroke(); }
      else { const t = clamp((mm-T.poolLo)/Math.max(1,T.poolHi-T.poolLo), 0, 1); c.arc(x, 46 - t*32, i===15 ? 5.5 : 3.4, 0, 7); c.fill(); }
    }
    c.restore();
  }

  function drawFooter(c, T, tex){
    c.save();
    c.fillStyle = C_R; c.font = `600 11px ${MONO}`;
    c.fillText(`${T.modeName}  ·  ${T.bpm} BPM  ·  ${T.chordName}${audio && audio.tx && audio.tx.motifOn ? '  ·  ♪ TEMA' : ''}`, 16, H - 16);
    // medidor de textura (órgano + reloj)
    c.textAlign = 'right'; c.fillText('TEXTURA', W - 16 - 10*9 - 8, H - 16);
    for(let i=0;i<10;i++){
      c.globalAlpha = i < Math.round(tex*10) ? 1 : .2;
      c.fillRect(W - 16 - (10-i)*9, H - 25, 6, 10);
    }
    c.restore();
  }

  function drawMinimap(c, k){
    const w = 120, h = 90, x = 22, y = 24, m = k.margin;
    c.save();
    c.fillStyle = 'rgba(5,7,8,.7)'; c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(236,236,230,.4)'; c.lineWidth = 1; c.strokeRect(x+.5, y+.5, w, h);
    c.setLineDash([4,3]); c.strokeStyle = C_R;
    c.strokeRect(x + m*w, y + m*h, w*(1-2*m), h*(1-2*m));
    c.setLineDash([]);
    for(const key of ['L','R']){
      const r = k.raw[key]; if(!r) continue;
      c.fillStyle = r.out ? '#ff4040' : key === 'L' ? C_L : C_R;
      c.globalAlpha = r.on ? 1 : .45;
      c.beginPath(); c.arc(x + r.sx*w, y + r.sy*h, r.on ? 4 : 3, 0, 7); c.fill();
    }
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(236,236,230,.8)'; c.font = `500 8px ${MONO}`;
    c.fillText('KINECT · ' + k.status.toUpperCase(), x + 5, y + h + 11);
    c.restore();
  }

  function drawPrompt(c, now, k){
    let txt = 'MUEVE EL CURSOR SOBRE LA IMAGEN';
    if(k && k.mode === 'kinect'){
      if(k.status !== 'on') txt = 'ESPERANDO AL KINECT…';
      else txt = k.bodies ? 'LEVANTA UNA MANO PARA TOCAR' : 'ACÉRCATE AL SENSOR';
    }
    c.save();
    c.globalAlpha = .45 + .35*Math.sin(now*.003);
    c.fillStyle = '#ecece6'; c.font = `500 14px ${MONO}`; c.textAlign = 'center';
    c.fillText(txt, W/2, H/2);
    c.strokeStyle = 'rgba(236,236,230,.4)';
    const r = 26 + 6*Math.sin(now*.003);
    c.beginPath(); c.arc(W/2, H/2 - 52, r, 0, 7); c.stroke();
    c.restore();
  }

  const api = { init, setImage, setPalette, ripple, render, current:null,
    get colors(){ return { acc:C_R, acc2:C_L, accRgb:pal.acc, acc2Rgb:pal.acc2 }; }, get gl(){ return !!gl; }, get quality(){ return quality; } };
  return api;
})();
