/* ============================================================
   EARTH JUKEBOX · preview.js
   Ventana con lo que ve el Kinect (sensor de profundidad + esqueleto, enviado
   por kinect/auralis_visuals.py) y encima las manos que está tomando:
     · círculo relleno  = mano levantada → está TOCANDO (es cursor)
     · aro              = mano visible pero abajo (no toca)
     · aro punteado     = el tracker la perdió y sostiene la última posición
     · X roja           = fuera de la región segura (no toca)
     · rectángulo punteado = región segura (se estira a todo el lienzo)
   Tecla C o botón × para ocultar/mostrar; se arrastra desde su barra (ambos se recuerdan).
   Oculta = no descarga vídeo.
   ?cam=URL para otra dirección del vídeo.
   ============================================================ */

(()=>{
  const params = new URLSearchParams(location.search);
  if(!HANDS.cfg.kinect) return;     // con ?mouse no se muestra
  // misma máquina que /events (si ?events= apunta a otro host, se usa ese host)
  const camUrl = params.get('cam') || HANDS.cfg.url.replace(/\/events(\?.*)?$/, '/preview.mjpg');
  const RED = '#ff4040';   // los otros colores vienen de la paleta de la imagen (EFX.colors)

  const box = document.createElement('div');
  box.id = 'cam';
  box.innerHTML = `
    <div class="cam-head"><span>KINECT · LO QUE VE</span><button type="button" title="Ocultar (C)">×</button></div>
    <div class="cam-view"><img alt="Vista del Kinect"><canvas></canvas><div class="cam-msg"></div></div>
    <div class="cam-foot">—</div>`;
  const tab = document.createElement('button');
  tab.id = 'cam-tab'; tab.type = 'button'; tab.textContent = 'CÁMARA KINECT'; tab.title = 'Mostrar (C)';
  document.body.append(box, tab);

  const img = box.querySelector('img'), cv = box.querySelector('canvas'), g = cv.getContext('2d');
  const msg = box.querySelector('.cam-msg'), foot = box.querySelector('.cam-foot');
  let shown = false, camOk = false;

  img.onload = ()=>{ camOk = true; msg.textContent = ''; };
  // si auralis_visuals.py aún no corre (o se cerró), se reintenta cada 2 s
  img.onerror = ()=>{
    camOk = false;
    if(!shown) return;
    msg.textContent = 'esperando a auralis_visuals.py…  (córrelo en la carpeta kinect)';
    clearTimeout(img._retry);
    img._retry = setTimeout(()=>{ if(shown) img.src = camUrl + '?t=' + Date.now(); }, 2000);
  };

  function show(on){
    shown = on;
    box.style.display = on ? 'block' : 'none';
    tab.style.display = on ? 'none' : 'block';
    clearTimeout(img._retry);
    img.src = on ? camUrl + (camUrl.includes('?') ? '&' : '?') + 't=' + Date.now() : '';
    msg.textContent = on ? 'conectando con auralis_visuals.py…' : '';
    try{ localStorage.setItem('ej-cam', on ? '1' : '0'); }catch(e){}
  }
  box.querySelector('.cam-head button').onclick = ()=> show(false);
  tab.onclick = ()=> show(true);
  document.addEventListener('keydown', e=>{ if(e.key === 'c' || e.key === 'C') show(!shown); });
  // arrastrar la ventana desde su barra (la posición se recuerda)
  const head = box.querySelector('.cam-head');
  try{ const p = JSON.parse(localStorage.getItem('ej-cam-pos') || 'null'); if(p){ box.style.left = p.x+'px'; box.style.top = p.y+'px'; } }catch(e){}
  head.addEventListener('pointerdown', e=>{
    if(e.target.tagName === 'BUTTON') return;
    const r = box.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = ev=>{
      const x = clamp(ev.clientX - ox, 0, innerWidth - r.width), y = clamp(ev.clientY - oy, 0, innerHeight - 40);
      box.style.left = x+'px'; box.style.top = y+'px';
    };
    const up = ()=>{
      head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up);
      try{ localStorage.setItem('ej-cam-pos', JSON.stringify({ x:parseInt(box.style.left), y:parseInt(box.style.top) })); }catch(e){}
    };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
  });

  let saved = null; try{ saved = localStorage.getItem('ej-cam'); }catch(e){}
  show(saved !== '0');   // visible por defecto

  function draw(){
    requestAnimationFrame(draw);
    if(!shown) return;
    const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(r.width*d), h = Math.round(r.height*d);
    if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
    g.setTransform(d,0,0,d,0,0);
    const W2 = r.width, H2 = r.height, k = HANDS.info, m = k.margin;
    g.clearRect(0, 0, W2, H2);
    if(!camOk){ g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(0,0,W2,H2); }

    // región segura
    const C_R = EFX.colors.acc, C_L = EFX.colors.acc2;
    g.setLineDash([5,4]); g.strokeStyle = rgbCss(EFX.colors.accRgb, .8); g.lineWidth = 1;
    g.strokeRect(m*W2 + .5, m*H2 + .5, W2*(1-2*m), H2*(1-2*m));
    g.setLineDash([]);

    // manos de la persona que controla (coordenadas tal como las manda el tracker)
    let playing = 0;
    g.font = '600 10px "JetBrains Mono", monospace';
    for(const key of ['L','R']){
      const hd = k.raw[key]; if(!hd) continue;
      const x = hd.sx*W2, y = hd.sy*H2, col = key === 'L' ? C_L : C_R;
      const name = key === 'L' ? 'IZQ' : 'DER';
      let label;
      if(hd.out){
        g.strokeStyle = RED; g.lineWidth = 2.5;
        g.beginPath(); g.moveTo(x-7,y-7); g.lineTo(x+7,y+7); g.moveTo(x+7,y-7); g.lineTo(x-7,y+7); g.stroke();
        g.fillStyle = RED; label = name + ' · FUERA';
      } else {
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2;
        if(hd.held) g.setLineDash([3,3]);
        g.beginPath(); g.arc(x, y, hd.on ? 10 : 8, 0, 7);
        if(hd.on){ g.globalAlpha = .55; g.fill(); g.globalAlpha = 1; }
        g.stroke(); g.setLineDash([]);
        if(hd.on){ g.beginPath(); g.arc(x, y, 16, 0, 7); g.lineWidth = 1; g.stroke(); playing++; }
        label = name + (hd.held ? ' · PERDIDA' : hd.on ? ' · TOCANDO' : ' · ABAJO');
      }
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)';
      const lx = Math.min(x + 14, W2 - 92), ly = Math.max(12, y - 12);
      g.strokeText(label, lx, ly); g.fillText(label, lx, ly);
    }

    // estado
    let text;
    if(k.mode !== 'kinect') text = 'SIN KINECT · corre auralis_visuals.py · mientras tanto: mouse';
    else if(k.status !== 'on') text = 'KINECT: ' + k.status.toUpperCase();
    else if(!k.bodies) text = 'NO VE A NADIE';
    else if(k.bodyId === null) text = `${k.bodies} PERSONA(S) · NINGUNA FIJADA`;
    else text = `CONTROLA PERSONA ${k.bodyId}${k.z ? ' · ' + k.z + ' M' : ''} · ${k.bodies} EN CUADRO · MANOS TOCANDO: ${playing}`;
    foot.textContent = text;
    foot.classList.toggle('ok', playing > 0);
  }
  requestAnimationFrame(draw);
})();
