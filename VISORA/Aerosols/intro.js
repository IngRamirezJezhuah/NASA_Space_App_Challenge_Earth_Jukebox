// Pantalla de bienvenida minimalista y monocroma.
// Una línea fina se expande, el texto limpio aparece sin efectos, y 
// la pantalla se divide suavemente en dos paneles negros mate.
// Clic o cualquier tecla la saltan.
const T_LINEA = 400;      // ms en que empieza a salir la línea central
const T_TEXTO = 1000;     // ms en que aparece el texto
const T_ABRIR = 3200;     // ms en que empieza la apertura
const T_DIVIDIR = 1200;   // ms que dura la apertura

const css = document.createElement('style');
css.textContent = `
#vi{position:fixed;inset:0;z-index:100;overflow:hidden;font-family:system-ui,-apple-system,sans-serif;cursor:pointer;color:#fff;background:#000}
#vi .h{position:absolute;left:0;right:0;height:50%;background:#030303;
    transition:transform ${T_DIVIDIR}ms cubic-bezier(.77,0,.18,1)}
#vi .t{top:0;border-bottom:1px solid #1a1a1a}
#vi .b{bottom:0;border-top:1px solid #1a1a1a}
#vi.open .t{transform:translateY(-101%)}
#vi.open .b{transform:translateY(101%)}

#vi .line{position:absolute;left:50%;top:50%;width:min(400px,60vw);height:1px;margin:0 0 0 calc(min(400px,60vw) / -2);
    background:#fff;transform:scaleX(0);transform-origin:center;
    transition:transform 800ms cubic-bezier(.2,.9,.2,1),opacity .5s}
#vi.line .line{transform:scaleX(1)}
#vi.open .line{opacity:0}

#vi .content{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
    opacity:0;transition:opacity .8s ease}
#vi.show .content{opacity:1}
#vi.open .content{opacity:0;transition:opacity .3s}

#vi h1{margin:0 0 8px 0;font-size:clamp(24px,4vw,42px);font-weight:300;letter-spacing:.4em;padding-left:.4em}
#vi .sub{color:#777;letter-spacing:.3em;font-size:11px;text-transform:uppercase}

#vi .info{position:absolute;bottom:18%;display:flex;flex-direction:column;align-items:center;gap:16px;width:min(240px,50vw)}
#vi .log{color:#555;font-size:10px;line-height:1.8;min-height:5.4em;text-align:center;letter-spacing:.1em;white-space:pre}
#vi .bar{width:100%;height:1px;background:#222;overflow:hidden}
#vi .bar i{display:block;height:100%;width:0;background:#fff;transition:width ${T_ABRIR - T_TEXTO}ms linear}
#vi.show .bar i{width:100%}
#vi .skip{position:absolute;bottom:24px;width:100%;text-align:center;color:#444;font-size:10px;letter-spacing:.2em}
`;
document.head.appendChild(css);

const root = document.createElement('div');
root.id = 'vi';
root.innerHTML = `
  <div class="h t"></div><div class="h b"></div>
  <div class="line"></div>
  <div class="content">
    <h1>VISORA</h1>
    <div class="sub">Aerosol Optical Depth</div>
  </div>
  <div class="content info" style="top:auto">
    <div class="log"></div>
    <div class="bar"><i></i></div>
  </div>
  <div class="content skip" style="top:auto">CLICK TO START</div>`;
document.body.append(root);

const LINES = ['INICIANDO SISTEMA', 'CARGANDO MAPA DE AEROSOLES', 'ENLACE KINECT EN ESPERA', 'LISTO'];
const log = root.querySelector('.log');
let done = false;
const timers = [];
const at = (ms, fn) => timers.push(setTimeout(fn, ms));

at(T_LINEA, () => root.classList.add('line'));
at(T_TEXTO, () => root.classList.add('show'));
LINES.forEach((t, i) => at(T_TEXTO + 200 + i * 400, () => { log.textContent += (i ? '\n' : '') + t; }));

function open() {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    removeEventListener('keydown', open);
    root.classList.add('open');
    
    setTimeout(() => {
        root.remove();
        css.remove();
        dispatchEvent(new Event('visora:intro-done'));
    }, T_DIVIDIR + 100);
}
at(T_ABRIR, open);
root.addEventListener('click', open);
addEventListener('keydown', open);