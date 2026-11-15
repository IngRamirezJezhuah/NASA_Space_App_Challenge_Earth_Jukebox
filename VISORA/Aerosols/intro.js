// Pantalla de bienvenida estilo Tron: un círculo de neón, de él emerge una línea horizontal y, al abrir,
// el panel se parte arriba/abajo con efecto CRT (encendido de tubo) sobre el globo.
// Clic o cualquier tecla la saltan.
const T_CIRCULO = 700;    // ms que tarda en dibujarse el círculo
const T_LINEA = 1400;     // ms (desde el inicio) en que empieza a salir la línea
const T_TEXTO = 2000;     // ms en que aparece el título
const T_ABRIR = 3600;     // ms en que empieza la apertura
const T_DIVIDIR = 1100;   // ms que dura la apertura
const T_CRT = 1500;       // ms del efecto CRT

const CYAN = '#00eaff', CORE = '#d8fdff', ORANGE = '#ff8a1e';

const css = document.createElement('style');
css.textContent = `
#vi{position:fixed;inset:0;z-index:100;overflow:hidden;font-family:'Courier New',monospace;cursor:pointer}
#vi .h{position:absolute;left:0;right:0;height:50%;background:
    linear-gradient(rgba(0,234,255,.09) 1px,transparent 1px) 0 0/46px 46px,
    linear-gradient(90deg,rgba(0,234,255,.09) 1px,transparent 1px) 0 0/46px 46px,
    radial-gradient(ellipse at 50% 100%,#052233 0,#01060d 72%);
    transition:transform ${T_DIVIDIR}ms cubic-bezier(.77,0,.18,1)}
#vi .t{top:0;box-shadow:inset 0 -2px 0 ${CYAN},inset 0 -26px 40px -22px ${CYAN}}
#vi .b{bottom:0;transform:none;box-shadow:inset 0 2px 0 ${CYAN},inset 0 26px 40px -22px ${CYAN};
    background:
    linear-gradient(rgba(0,234,255,.09) 1px,transparent 1px) 0 0/46px 46px,
    linear-gradient(90deg,rgba(0,234,255,.09) 1px,transparent 1px) 0 0/46px 46px,
    radial-gradient(ellipse at 50% 0%,#052233 0,#01060d 72%)}
#vi.open .t{transform:translateY(-101%)}
#vi.open .b{transform:translateY(101%)}

#vi .ring{position:absolute;left:50%;top:50%;width:104px;height:104px;margin:-52px 0 0 -52px;border-radius:50%;
    border:3px solid ${CYAN};box-shadow:0 0 14px ${CYAN},0 0 40px ${CYAN}99,inset 0 0 16px ${CYAN}99;
    opacity:0;transform:scale(.2) rotate(-90deg);
    transition:opacity ${T_CIRCULO}ms,transform ${T_CIRCULO}ms cubic-bezier(.2,.9,.2,1)}
#vi .ring::before{content:'';position:absolute;inset:12px;border-radius:50%;border:2px dashed ${ORANGE};
    box-shadow:0 0 10px ${ORANGE}aa;animation:vspin 6s linear infinite}
#vi .ring::after{content:'';position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;
    border-radius:50%;background:${CORE};box-shadow:0 0 12px ${CORE},0 0 30px ${CYAN}}
#vi.go .ring{opacity:1;transform:none}
#vi.open .ring{opacity:0;transform:scale(3);transition:opacity .5s,transform .5s ease-in}
@keyframes vspin{to{transform:rotate(360deg)}}

#vi .line{position:absolute;left:50%;top:50%;width:min(62vw,760px);height:3px;margin:-1.5px 0 0 calc(min(62vw,760px) / -2);
    background:linear-gradient(90deg,transparent,${CYAN} 12%,${CORE} 50%,${CYAN} 88%,transparent);
    box-shadow:0 0 10px ${CYAN},0 0 28px ${CYAN},0 0 60px ${CYAN}88;
    transform:scaleX(0);transform-origin:center;transition:transform 800ms cubic-bezier(.2,.9,.2,1),opacity .25s}
#vi.line .line{transform:scaleX(1)}
#vi.open .line{opacity:0}

#vi .ttl{position:absolute;left:0;right:0;top:50%;margin-top:-34vh;text-align:center;opacity:0;transition:opacity .5s}
#vi .info{position:absolute;left:0;right:0;top:50%;margin-top:11vh;display:flex;flex-direction:column;
    align-items:center;gap:10px;opacity:0;transition:opacity .5s}
#vi.show .ttl,#vi.show .info{opacity:1}
#vi.open .ttl,#vi.open .info{opacity:0;transition:opacity .25s}
#vi h1{margin:0;font-size:clamp(38px,8.5vw,112px);letter-spacing:.35em;padding-left:.35em;color:${CORE};
    text-shadow:0 0 8px ${CYAN},0 0 26px ${CYAN},3px 0 ${ORANGE}88,-3px 0 ${CYAN}88;animation:vglitch 2.6s infinite steps(1)}
#vi .sub{color:${CYAN};letter-spacing:.5em;font-size:clamp(10px,1.3vw,15px);text-shadow:0 0 8px ${CYAN};margin-top:6px}
#vi .log{color:${ORANGE};font-size:13px;line-height:1.6;min-height:6.4em;text-align:left;white-space:pre;
    text-shadow:0 0 6px ${ORANGE}99}
#vi .bar{width:min(320px,60vw);height:4px;background:${CYAN}25;overflow:hidden}
#vi .bar i{display:block;height:100%;width:0;background:${CYAN};box-shadow:0 0 10px ${CYAN};
    transition:width ${T_ABRIR - T_TEXTO}ms linear}
#vi.show .bar i{width:100%}
#vi .skip{position:absolute;bottom:18px;width:100%;text-align:center;color:${CYAN}88;font-size:11px;letter-spacing:.3em}
@keyframes vglitch{0%,90%,100%{transform:none;clip-path:none}
    92%{transform:translateX(-6px);clip-path:inset(20% 0 55% 0)}
    94%{transform:translateX(6px);clip-path:inset(60% 0 10% 0)}
    96%{transform:translateX(-3px);clip-path:inset(35% 0 35% 0)}}

/* CRT: solo durante la apertura */
#vi-crt{position:fixed;inset:0;z-index:99;pointer-events:none;opacity:0;
    background:
      repeating-linear-gradient(0deg,rgba(0,0,0,.38) 0 1px,transparent 1px 3px),
      radial-gradient(ellipse at center,transparent 45%,rgba(0,0,0,.65) 100%);
    mix-blend-mode:multiply}
#vi-crt.on{animation:vcrtfx ${T_CRT}ms ease-out forwards}
@keyframes vcrtfx{0%{opacity:1}55%{opacity:1}100%{opacity:0}}
canvas.vcrt-on{animation:vcrton ${T_CRT}ms cubic-bezier(.2,.8,.2,1) both}
@keyframes vcrton{
    0%{transform:scale(1,.004);filter:brightness(9) saturate(0) blur(1px)}
    25%{transform:scale(.55,.004);filter:brightness(9) saturate(0)}
    45%{transform:scale(1,.004);filter:brightness(7) saturate(0)}
    70%{transform:scale(1,1.04);filter:brightness(2.2) saturate(1.4) hue-rotate(-8deg)}
    82%{transform:scale(1,.985);filter:brightness(1.4) hue-rotate(6deg)}
    100%{transform:none;filter:none}}
`;
document.head.appendChild(css);

const root = document.createElement('div');
root.id = 'vi';
root.innerHTML = `
  <div class="h t"></div><div class="h b"></div>
  <div class="line"></div><div class="ring"></div>
  <div class="ttl"><h1>VISORA</h1><div class="sub">AEROSOL OPTICAL DEPTH // NASA</div></div>
  <div class="info"><div class="log"></div><div class="bar"><i></i></div></div>
  <div class="skip">[ CLIC PARA ENTRAR ]</div>`;
const crt = document.createElement('div');
crt.id = 'vi-crt';
document.body.append(root, crt);

const LINES = ['> INICIANDO SISTEMA', '> CARGANDO MAPA DE AEROSOLES', '> ENLACE KINECT EN ESPERA', '> LISTO'];
const log = root.querySelector('.log');
let done = false;
const timers = [];
const at = (ms, fn) => timers.push(setTimeout(fn, ms));

at(60, () => root.classList.add('go'));
at(T_LINEA, () => root.classList.add('line'));
at(T_TEXTO, () => root.classList.add('show'));
LINES.forEach((t, i) => at(T_TEXTO + 250 + i * 330, () => { log.textContent += (i ? '\n' : '') + t; }));

function open() {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    removeEventListener('keydown', open);
    root.classList.add('open');
    // Efecto CRT solo aquí: el globo se "enciende" como un tubo y las scanlines se desvanecen
    const cv = document.querySelector('body > canvas');
    if (cv) cv.classList.add('vcrt-on');
    crt.classList.add('on');
    setTimeout(() => root.remove(), T_DIVIDIR + 100);
    setTimeout(() => {
        cv?.classList.remove('vcrt-on');
        crt.remove();
        css.remove();
        dispatchEvent(new Event('visora:intro-done'));
    }, T_CRT + 100);
}
at(T_ABRIR, open);
root.addEventListener('click', open);
addEventListener('keydown', open);
