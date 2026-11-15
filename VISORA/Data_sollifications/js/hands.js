/* ============================================================
   EARTH JUKEBOX · hands.js
   Las manos de la persona frente al Kinect son los cursores.

   Fuente: kinect/auralis_visuals.py. Mientras corre, abre un puente local
   (puerto 8765) y esta página se conecta sola, aunque la abras con doble clic.
   Si el programa arranca después, la página se conecta en cuanto aparece.
   Cada mensaje trae:
     { primary, bodies:[ { id, z, clap, armed, frame,
                           hands:{ L:{sx,sy,x,y,vis,on,held,out}, R:{…} } } ] }
   · sx, sy  posición normalizada 0–1 en la imagen del Kinect
   · vis     mano detectada        · on   mano levantada (= "tocando")
   · held    el tracker perdió la mano y sostiene la última posición
   · clap    contador de aplausos

   Reglas (igual que el puente del globo):
   · una sola persona controla (se fija hasta perderla 700 ms)
   · el margen de la región segura se comparte con los ajustes del globo
     (localStorage 'visora.params' → margin); esa región se estira a todo el lienzo
   · una mano en el borde de la región deja de tocar

   Parámetros de URL:
     ?mouse            fuerza modo mouse (sin Kinect)
     ?kinect           fuerza intentar Kinect (también desde file://)
     ?events=URL       otra dirección del flujo (por defecto el de auralis_visuals.py)
     ?mirror           invierte izquierda/derecha
     ?margin=0.1       margen de la región segura
     ?play=vis         toca con cualquier mano visible (no solo levantada)

   El mouse siempre funciona también (cursor 'M'), útil para pruebas.
   ============================================================ */

const HANDS = (()=>{
  const params = new URLSearchParams(location.search);
  const shared = (()=>{ try{ return JSON.parse(localStorage.getItem('visora.params') || '{}'); }catch(e){ return {}; } })();
  const cfg = {
    margin: clamp(fin(parseFloat(params.get('margin')), fin(shared.margin, .08)), 0, .3),
    mirror: params.has('mirror'),
    url: params.get('events') || AURALIS_URL + '/events',
    kinect: !params.has('mouse'),
    playVisible: params.get('play') === 'vis',
    lockLost: 700,     // ms sin ver al cuerpo fijado antes de pasar a otra persona
    stale: 1000        // ms sin mensajes = manos ocultas
  };

  const list = new Map();          // id → mano
  const info = { mode: cfg.kinect ? 'kinect' : 'mouse', status: cfg.kinect ? 'conectando' : 'off',
                 bodies:0, bodyId:null, z:null, raw:{ L:null, R:null }, margin:cfg.margin };
  let lockedId = null, lockedSeen = 0, lastMsg = 0, errors = 0, es = null;
  const claps = new Map();
  const api = { cfg, list, info, onClap:null, onPress:null, onConnect:null };

  function upsert(id, key, src){
    let h = list.get(id);
    if(!h){
      h = { id, key, src,
            tx:W/2, ty:H/2, px:W/2, py:H/2, lastPx:W/2, lastPy:H/2, vx:0, vy:0,
            vis:false, on:false, held:false, out:false, wasVis:false,
            alpha:0, speed:0, dist:0, acc:0, lastNote:0, pulse:0, noteName:'—',
            f:{ lum:.5, lumBig:.5, hx:1, hy:0, hue:0, sat:0, contrast:.2, warm:.5, y:.5 } };
      list.set(id, h);
    }
    return h;
  }

  /* región segura del Kinect → lienzo completo */
  function mapKinect(sx, sy){
    const m = cfg.margin, span = Math.max(.2, 1 - 2*m);
    let u = (sx - m) / span, v = (sy - m) / span;
    if(cfg.mirror) u = 1 - u;
    return [clamp(u,0,1)*(W-1), clamp(v,0,1)*(H-1)];
  }

  function onMessage(msg){
    const now = performance.now();
    const fresh = info.status !== 'on' && info.status !== 'sin datos';
    lastMsg = now; errors = 0; info.status = 'on'; info.mode = 'kinect';
    if(fresh && api.onConnect) setTimeout(api.onConnect, 0);   // recién conectado a auralis_visuals.py
    const bodies = Array.isArray(msg.bodies) ? msg.bodies : [];

    // una sola persona controla
    if(lockedId !== null && bodies.some(b=>b.id === lockedId)) lockedSeen = now;
    else if(lockedId === null || now - lockedSeen > cfg.lockLost){
      lockedId = msg.primary ?? (bodies[0] ? bodies[0].id : null);
      lockedSeen = now;
    }
    const b = bodies.find(x=>x.id === lockedId);

    // aplausos: solo cuenta el de la persona que controla
    for(const x of bodies){
      if(claps.has(x.id) && x.clap > claps.get(x.id) && x.id === lockedId && api.onClap) api.onClap();
      claps.set(x.id, x.clap);
    }

    info.bodies = bodies.length; info.bodyId = b ? b.id : null; info.z = b && b.z ? b.z : null;
    const edge = cfg.margin * .5;    // fuera de la región: la mano deja de tocar
    for(const k of ['L','R']){
      const h = upsert('k'+k, k, 'kinect');
      const d = b && b.hands && b.hands[k];
      if(d && (d.vis || d.out) && Number.isFinite(d.sx) && Number.isFinite(d.sy)){
        [h.tx, h.ty] = mapKinect(d.sx, d.sy);
        h.out = !!d.out || d.sx < edge || d.sx > 1-edge || d.sy < edge || d.sy > 1-edge;
        h.vis = !!d.vis && !h.out;
        h.on = h.vis && (cfg.playVisible || !!d.on);
        h.held = !!d.held;
        info.raw[k] = { sx:d.sx, sy:d.sy, on:h.on, out:h.out, held:h.held };
      } else {
        h.vis = h.on = false; h.out = false;
        info.raw[k] = null;
      }
    }
  }

  function connect(){
    if(!cfg.kinect || typeof EventSource === 'undefined'){ info.mode = 'mouse'; info.status = 'off'; return; }
    try{ es = new EventSource(cfg.url); }catch(e){ info.mode = 'mouse'; info.status = 'off'; return; }
    es.onmessage = e=>{ try{ onMessage(JSON.parse(e.data)); }catch(err){} };
    es.onerror = ()=>{
      errors++;
      info.status = lastMsg ? 'reconectando' : 'esperando a auralis_visuals.py';
      // mientras no responda se usa el mouse, pero se sigue intentando (EventSource reintenta solo)
      if(!lastMsg && errors >= 2) info.mode = 'mouse';
    };
  }

  /* llamado cada frame: oculta manos si el Kinect dejó de mandar datos */
  api.tick = now=>{
    if(info.mode === 'kinect' && lastMsg && now - lastMsg > cfg.stale){
      for(const h of list.values()) if(h.src === 'kinect'){ h.vis = h.on = false; }
      info.raw.L = info.raw.R = null;
      if(info.status === 'on') info.status = 'sin datos';
    }
  };

  /* ---------- mouse / touch de respaldo ---------- */
  api.attachMouse = el=>{
    const pos = e=>{
      const r = el.getBoundingClientRect();
      if(!r.width || !r.height) return null;
      return [clamp(fin((e.clientX-r.left)*W/r.width, W/2), 0, W-1),
              clamp(fin((e.clientY-r.top)*H/r.height, H/2), 0, H-1)];
    };
    const m = upsert('mouse', 'M', 'mouse');
    const set = e=>{ const p = pos(e); if(!p) return; [m.tx, m.ty] = p; m.vis = m.on = true; };
    el.addEventListener('pointerenter', set);
    el.addEventListener('pointermove', set);
    el.addEventListener('pointerdown', e=>{ set(e); if(api.onPress) api.onPress(m); });
    el.addEventListener('pointerleave', ()=>{ m.vis = m.on = false; });
    el.addEventListener('pointercancel', ()=>{ m.vis = m.on = false; });
  };

  connect();
  return api;
})();
