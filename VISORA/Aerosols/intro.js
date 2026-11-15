// Pantalla de bienvenida cyberpunk: una línea central que se divide del centro hacia el exterior
// y revela el globo. Clic o cualquier tecla la saltan.
const T_LINEA = 900;     // ms que tarda en crecer la línea
const T_TEXTO = 2900;    // ms (desde el inicio) en que empieza a dividirse
const T_DIVIDIR = 1200;  // ms que dura la apertura

const css = document.createElement('style');
css.textContent = `
#vi{position:fixed;inset:0;z-index:100;overflow:hidden;font-family:'Courier New',monospace;cursor:pointer}
#vi .h{position:absolute;top:0;bottom:0;width:50%;background:
    linear-gradient(rgba(0,255,255,.07) 1px,transparent 1px) 0 0/48px 48px,
    linear-gradient(90deg,rgba(0,255,255,.07) 1px,transparent 1px) 0 0/48px 48px,
    repeating-linear-gradient(0deg,rgba(0,0,0,.25) 0 2px,transparent 2px 4px),
    radial-gradient(ellipse at 100% 50%,#1a0233 0,#02030a 70%);
    transition:transform ${T_DIVIDIR}ms cubic-bezier(.77,0,.18,1)}
#vi .l{left:0;transform:translateX(0);box-shadow:inset -2px 0 0 #0ff,inset -14px 0 30px -10px #0ff8}
#vi .r{right:0;transform:translateX(0);box-shadow:inset 2px 0 0 #0ff,inset 14px 0 30px -10px #0ff8;
    background-position:0 0,0 0,0 0,0 0}
#vi .r{background:
    linear-gradient(rgba(0,255,255,.07) 1px,transparent 1px) 0 0/48px 48px,
    linear-gradient(90deg,rgba(0,255,255,.07) 1px,transparent 1px) 0 0/48px 48px,
    repeating-linear-gradient(0deg,rgba(0,0,0,.25) 0 2px,transparent 2px 4px),
    radial-gradient(ellipse at 0% 50%,#1a0233 0,#02030a 70%)}
#vi.open .l{transform:translateX(-101%)}
#vi.open .r{transform:translateX(101%)}
#vi .line{position:absolute;left:calc(50% - 1px);top:0;bottom:0;width:2px;background:#0ff;
    box-shadow:0 0 12px #0ff,0 0 32px #0ff,0 0 60px #f0f;transform:scaleY(0);transform-origin:center;
    transition:transform ${T_LINEA}ms cubic-bezier(.2,.9,.2,1),opacity .2s}
#vi.go .line{transform:scaleY(1)}
#vi.open .line{opacity:0}
#vi .txt{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:14px;opacity:0;transition:opacity .5s;pointer-events:none}
#vi.txt .txt,#vi.show .txt{opacity:1}
#vi.open .txt{opacity:0;transition:opacity .3s}
#vi h1{margin:0;font-size:clamp(40px,9vw,120px);letter-spacing:.35em;padding-left:.35em;color:#fff;
    text-shadow:0 0 10px #0ff,0 0 30px #0ff,3px 0 #f0f,-3px 0 #0ff;animation:vglitch 2.4s infinite steps(1)}
#vi .sub{color:#0ff;letter-spacing:.5em;font-size:clamp(10px,1.4vw,16px);text-shadow:0 0 8px #0ff}
#vi .log{color:#f0f;font-size:13px;line-height:1.6;min-height:5em;text-align:left;text-shadow:0 0 6px #f0f}
#vi .bar{width:min(320px,60vw);height:4px;background:#0ff2;margin-top:6px;overflow:hidden}
#vi .bar i{display:block;height:100%;width:0;background:#0ff;box-shadow:0 0 10px #0ff;
    transition:width ${T_TEXTO - T_LINEA - 300}ms linear}
#vi.show .bar i{width:100%}
#vi .skip{position:absolute;bottom:18px;width:100%;text-align:center;color:#0ff8;font-size:11px;letter-spacing:.3em}
@keyframes vglitch{0%,90%,100%{transform:none;clip-path:none}
    92%{transform:translateX(-6px);clip-path:inset(20% 0 55% 0)}
    94%{transform:translateX(6px);clip-path:inset(60% 0 10% 0)}
    96%{transform:translateX(-3px);clip-path:inset(35% 0 35% 0)}}
`;
document.head.appendChild(css);

const root = document.createElement('div');
root.id = 'vi';
root.innerHTML = `
  <div class="h l"></div><div class="h r"></div><div class="line"></div>
  <div class="txt">
    <h1>VISORA</h1>
    <div class="sub">AEROSOL OPTICAL DEPTH // NASA</div>
    <div class="log"></div>
    <div class="bar"><i></i></div>
  </div>
  <div class="skip">[ CLIC PARA ENTRAR ]</div>`;
document.body.appendChild(root);

const LINES = ['> INICIANDO SISTEMA', '> CARGANDO MAPA DE AEROSOLES', '> ENLACE KINECT EN ESPERA', '> LISTO'];
const log = root.querySelector('.log');
let done = false;
const timers = [];
const at = (ms, fn) => timers.push(setTimeout(fn, ms));

at(60, () => root.classList.add('go'));
at(T_LINEA, () => root.classList.add('show'));
LINES.forEach((t, i) => at(T_LINEA + 250 + i * 380, () => { log.textContent += (i ? '\n' : '') + t; }));
log.style.whiteSpace = 'pre';

function open() {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    root.classList.add('open');
    setTimeout(() => { root.remove(); css.remove(); dispatchEvent(new Event('visora:intro-done')); }, T_DIVIDIR + 100);
    removeEventListener('keydown', open);
}
at(T_TEXTO, open);
root.addEventListener('click', open);
addEventListener('keydown', open);
