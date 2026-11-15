// Puente Kinect -> página. Se activa con ?kinect (lo lanza kinect/body_tracker.sh).
// Recibe cuerpos/manos/gestos por SSE (/events) y mueve la cámara del globo en tiempo real.
//   ARRASTRAR (R/L): una mano levantada gira el globo.
//   ZOOM: dos manos visibles; separar = acercar, juntar = alejar. Un aplauso acerca un paso.
//   ENCUADRE: pulgares e índices formando un rectángulo muestran el cuadro; 1 s = captura.
import * as THREE from 'three';
import { starSettings } from './stars.js';

// Datos del Kinect: los manda kinect/auralis_visuals.py (puerto 8765)
const AURALIS = 'http://127.0.0.1:8765';

// ---- Ajustes (los sliders del panel los cambian y se guardan en localStorage) ----
const DEFAULTS = {
    rot: 0.7,        // radianes por ancho de hombros de movimiento de la mano
    zoom: 0.6,       // sensibilidad del zoom con dos manos
    clap: 0.30,      // log del zoom por aplauso (0.30 ≈ acerca 26 %)
    step: 0.012,     // dos manos: movimiento por mensaje menor a step/2 cuenta como 0
    dead: 0.006,     // movimientos menores (en anchos de hombro) se ignoran
    smooth: 0.28,    // fracción del movimiento pendiente aplicada por frame
    inertia: 1.5,    // s que tarda el empujón en frenarse (0 = sin inercia)
    hand: 0.6,       // filtro de las manos (1 = sin filtro)
    margin: 0.08,    // límite de región: margen (fracción de la imagen del Kinect) donde la mano ya no cuenta
    map: 1.4,        // cuánto se amplía el movimiento de las manos en pantalla
    hold: 1.0,       // s con el cuadro quieto para capturar la zona
    stars: 1.0,      // velocidad de las estrellas de fondo
    invx: false,     // invierte el giro horizontal
    invy: false,     // invierte el giro vertical
    preview: false,  // vista previa de la cámara (oculta por defecto)
};
const P = { ...DEFAULTS };
try { Object.assign(P, JSON.parse(localStorage.getItem('visora.params') || '{}')); } catch { /* ignorar */ }
const saveParams = () => localStorage.setItem('visora.params', JSON.stringify(P));

const MAX_STEP = 0.25;     // rad máximos de giro por mensaje
const LOCK_LOST_MS = 700;  // ms sin ver al cuerpo fijado antes de cambiar a otra persona
const COLORS = ['#ffffff', '#bbbbbb', '#888888', '#555555'];   // colores en escala de grises

export function initKinect({ scene, camera, controls, renderer, pivot }) {
    const pend = { theta: 0, phi: 0, zoom: 0 };
    const vel = { theta: 0, phi: 0 };
    const last = { theta: 0, phi: 0 };
    let mode = 'none', prev = null, prevDist = null, prevHands = null, primaryId = null;
    const claps = new Map();
    let hold = null;     // {t0, rect}
    const regionOut = { L: false, R: false };   // la mano salió de la región segura del Kinect
    let lockedId = null, lockedSeen = 0;   // una sola persona controla; el resto es ruido

    // ---------- UI ----------
    const css = document.createElement('style');
    css.textContent = `
        .vk-hud{position:fixed;left:24px;top:20px;z-index:10;font-family:system-ui,-apple-system,sans-serif;font-size:10px;
            color:#888;letter-spacing:0.1em;text-transform:uppercase;user-select:none;mix-blend-mode:difference;}
        .vk-prev{position:fixed;left:24px;top:54px;width:256px;height:192px;border:1px solid #444;z-index:8;
            display:none;background:#000;overflow:hidden;}
        .vk-prev img{display:block;width:100%;height:100%;object-fit:cover;filter:grayscale(100%)}
        .vk-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:21;cursor:pointer;
            background:transparent;color:#aaa;border:1px solid #444;border-right:0;padding:14px 8px;
            font-family:system-ui,-apple-system,sans-serif;font-size:10px;writing-mode:vertical-rl;letter-spacing:0.15em;
            user-select:none;transition:all 0.2s ease;}
        .vk-tab:hover{color:#fff;border-color:#fff;}
        .vk-panel{position:fixed;right:0;top:50%;transform:translate(100%,-50%);z-index:20;width:320px;
            max-height:86vh;overflow:auto;background:#050505;border:1px solid #444;border-right:0;
            padding:24px;color:#aaa;font-family:system-ui,-apple-system,sans-serif;font-size:11px;
            transition:transform .35s cubic-bezier(.2,.8,.2,1)}
        .vk-panel.open{transform:translate(0,-50%)}
        .vk-panel h3{margin:0 0 20px;font-size:12px;font-weight:400;letter-spacing:0.15em;color:#fff;text-transform:uppercase;}
        .vk-row{margin:16px 0}
        .vk-row label{display:flex;justify-content:space-between;color:#aaa;margin-bottom:6px;letter-spacing:0.05em;text-transform:uppercase;}
        .vk-row b{color:#fff;font-weight:normal}
        .vk-row input[type=range]{width:100%;accent-color:#fff;background:#222;height:2px;appearance:none;outline:none;}
        .vk-row input[type=range]::-webkit-slider-thumb{appearance:none;width:12px;height:12px;background:#fff;border-radius:50%;cursor:pointer;}
        .vk-chk{display:flex;align-items:center;gap:10px;margin:12px 0;color:#aaa;cursor:pointer;letter-spacing:0.05em;text-transform:uppercase;}
        .vk-chk input{accent-color:#000;border:1px solid #666;width:14px;height:14px;}
        .vk-btn{margin-top:24px;width:100%;padding:10px;background:transparent;color:#aaa;border:1px solid #444;
            font-family:inherit;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;cursor:pointer;transition:all 0.2s ease;}
        .vk-btn:hover{color:#fff;border-color:#fff;}
    `;
    document.head.appendChild(css);

    const box = document.createElement('div');
    box.className = 'vk-prev';
    const img = document.createElement('img');
    box.appendChild(img);
    document.body.appendChild(box);
    const badge = document.createElement('div');
    badge.className = 'vk-hud';
    badge.textContent = 'KINECT: CONNECTING...';
    document.body.appendChild(badge);

    function showPreview(on) {
        P.preview = on;
        box.style.display = on ? 'block' : 'none';
        img.src = on ? AURALIS + '/preview.mjpg' : '';      // oculta = no se descarga el vídeo
    }
    showPreview(P.preview);

    // ---------- panel de sensibilidad (retráctil) ----------
    const SLIDERS = [
        ['rot', 'Rotación', 0.1, 2.5, 0.05],
        ['zoom', 'Zoom (dos manos)', 0.1, 2, 0.05],
        ['clap', 'Zoom por aplauso', 0, 0.8, 0.05],
        ['smooth', 'Suavizado del giro', 0.05, 0.8, 0.01],
        ['inertia', 'Inercia / empuje (s)', 0, 4, 0.1],
        ['hand', 'Filtro de manos', 0.1, 1, 0.05],
        ['dead', 'Zona muerta', 0, 0.05, 0.001],
        ['step', 'Umbral dos manos', 0.002, 0.06, 0.002],
        ['margin', 'Límite (margen)', 0, 0.3, 0.01],
        ['map', 'Escala de cursores', 1, 2.2, 0.05],
        ['hold', 'Tiempo captura (s)', 0.3, 3, 0.1],
        ['stars', 'Vel. estrellas', 0, 4, 0.1],
    ];
    const tab = document.createElement('div');
    tab.className = 'vk-tab';
    tab.textContent = 'SETTINGS';
    const panel = document.createElement('div');
    panel.className = 'vk-panel';
    panel.innerHTML = '<h3>SENSITIVITY</h3>';
    const inputs = {};
    function addSlider([key, name, min, max, st]) {
        const row = document.createElement('div');
        row.className = 'vk-row';
        const lab = document.createElement('label');
        const val = document.createElement('b');
        lab.append(name, val);
        const inp = document.createElement('input');
        Object.assign(inp, { type: 'range', min, max, step: st, value: P[key] });
        const upd = () => { val.textContent = (+P[key]).toFixed(st < 0.01 ? 3 : 2); };
        inp.oninput = () => { P[key] = +inp.value; upd(); saveParams(); if (key === 'stars') starSettings.speed = P.stars; };
        upd();
        inputs[key] = { inp, upd };
        row.append(lab, inp);
        panel.appendChild(row);
    }
    SLIDERS.forEach(addSlider);
    function addCheck(key, name, onChange) {
        const l = document.createElement('label');
        l.className = 'vk-chk';
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = !!P[key];
        c.onchange = () => { P[key] = c.checked; saveParams(); onChange?.(c.checked); };
        l.append(c, name);
        panel.appendChild(l);
        inputs[key] = { inp: c };
    }
    addCheck('preview', 'Vista previa de cámara', showPreview);
    addCheck('invx', 'Invertir giro horizontal');
    addCheck('invy', 'Invertir giro vertical');
    const reset = document.createElement('button');
    reset.className = 'vk-btn';
    reset.textContent = 'RESET DEFAULT';
    reset.onclick = () => {
        Object.assign(P, DEFAULTS);
        saveParams();
        for (const [k, o] of Object.entries(inputs)) {
            if (o.inp.type === 'checkbox') o.inp.checked = !!P[k]; else { o.inp.value = P[k]; o.upd(); }
        }
        showPreview(P.preview);
        starSettings.speed = P.stars;
    };
    panel.appendChild(reset);
    tab.onclick = () => { panel.classList.toggle('open'); tab.style.right = panel.classList.contains('open') ? '320px' : '0'; };
    tab.style.transition = 'right .35s cubic-bezier(.2,.8,.2,1)';
    document.body.append(panel, tab);
    starSettings.speed = P.stars;

    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9';
    document.body.appendChild(cv);
    const g = cv.getContext('2d');
    function fit() { cv.width = innerWidth; cv.height = innerHeight; }
    fit();
    addEventListener('resize', fit);

    const shots = document.createElement('div');
    shots.style.cssText = 'position:fixed;right:24px;top:24px;display:flex;flex-direction:column;gap:12px;z-index:10';
    document.body.appendChild(shots);

    const toScreen = (nx, ny) => [((nx - 0.5) * P.map + 0.5) * innerWidth,
                                  ((ny - 0.5) * P.map + 0.5) * innerHeight];

    // Posición de la mano para GIRAR. auralis_visuals.py manda x/y (anchos de hombro
    // respecto al torso). Si una versión vieja no los manda, se usan sx/sy (posición en
    // la imagen del sensor) escaladas: el ancho del sensor son ~3 anchos de hombro.
    const handXY = (h) => Number.isFinite(h.x) && Number.isFinite(h.y)
        ? { x: h.x, y: h.y }
        : { x: h.sx * 3, y: h.sy * 3 };

    // ---------- movimiento ----------
    const clampStep = (v) => THREE.MathUtils.clamp(v, -MAX_STEP, MAX_STEP);

    const omega = { theta: 0, phi: 0 };   // velocidad angular de la mano (rad/s)
    let lastMoveT = 0, lastLiveT = 0, lastTick = performance.now();

    function rotate(dx, dy) {
        // Un solo valor inválido dejaba pend.theta en NaN y el globo no volvía a girar NUNCA.
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        if (Math.hypot(dx, dy) < P.dead) return;
        const scale = THREE.MathUtils.clamp((camera.position.length() - 1) / 2.2, 0.15, 2);
        last.theta = clampStep((P.invx ? 1 : -1) * dx * P.rot * scale);
        last.phi = clampStep((P.invy ? -1 : 1) * dy * P.rot * scale);
        pend.theta += last.theta;
        pend.phi += last.phi;
        const now = performance.now();
        const dt = THREE.MathUtils.clamp((now - lastMoveT) / 1000, 0.008, 0.1);
        const a = now - lastMoveT < 200 ? 0.5 : 1;
        omega.theta += a * (last.theta / dt - omega.theta);
        omega.phi += a * (last.phi / dt - omega.phi);
        lastMoveT = now;
        vel.theta = vel.phi = 0;
    }

    // Al soltar, el globo conserva la velocidad que llevaba la mano y se frena poco a poco
    function fling() {
        const moving = lastLiveT - lastMoveT < 150 && performance.now() - lastLiveT < 600;
        if (moving && P.inertia > 0) { vel.theta = omega.theta; vel.phi = omega.phi; }
        else vel.theta = vel.phi = 0;
    }

    function zoomBy(logv) {
        if (Math.abs(logv) > 0.003) pend.zoom += THREE.MathUtils.clamp(logv, -0.2, 0.2);
    }

    function tick() {
        const nowT = performance.now();
        const dt = Math.min(0.05, (nowT - lastTick) / 1000);
        lastTick = nowT;
        if (mode !== 'drag' && (vel.theta || vel.phi)) {
            pend.theta += vel.theta * dt;
            pend.phi += vel.phi * dt;
            const f = Math.exp(-dt / Math.max(P.inertia, 0.05));
            vel.theta *= f;
            vel.phi *= f;
            if (Math.abs(vel.theta) + Math.abs(vel.phi) < 0.005) vel.theta = vel.phi = 0;
        }
        const dth = pend.theta * P.smooth, dph = pend.phi * P.smooth, dz = pend.zoom * P.smooth;
        pend.theta -= dth; pend.phi -= dph; pend.zoom -= dz;
        if (Math.abs(dth) + Math.abs(dph) > 1e-5) {
            // giro del globo respecto a la cámara: sin polos, 360° libres
            const up = camera.up.clone().normalize();
            const right = new THREE.Vector3().crossVectors(camera.position.clone().negate(), up).normalize();
            const q = new THREE.Quaternion()
                .setFromAxisAngle(up, -dth)
                .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dph));
            pivot.quaternion.premultiply(q).normalize();
        }
        if (Math.abs(dz) > 1e-5) {
            const r = THREE.MathUtils.clamp(camera.position.length() * Math.exp(dz), controls.minDistance, controls.maxDistance);
            camera.position.setLength(r);
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    function setMode(m) {
        if (m === mode) return;
        if (mode === 'drag' || mode === 'two') fling();
        mode = m;
        prev = null;
        prevDist = null;
        prevHands = null;
    }

    // ---------- captura de zona ----------
    function capture(rect) {
        const [x0, y0] = toScreen(rect[0], rect[1]);
        const [x1, y1] = toScreen(rect[2], rect[3]);
        const c = renderer.domElement, r = c.width / innerWidth;
        const x = Math.max(0, Math.min(x0, x1)), y = Math.max(0, Math.min(y0, y1));
        const w = Math.min(innerWidth - x, Math.abs(x1 - x0)), h = Math.min(innerHeight - y, Math.abs(y1 - y0));
        if (w < 20 || h < 20) return;
        renderer.render(scene, camera);          // mismo ciclo: el buffer aún es válido
        const out = document.createElement('canvas');
        out.width = Math.round(w * r); out.height = Math.round(h * r);
        out.getContext('2d').drawImage(c, x * r, y * r, w * r, h * r, 0, 0, out.width, out.height);
        const a = document.createElement('a');
        a.href = out.toDataURL('image/png');
        a.download = `zona_${Date.now()}.png`;
        a.title = 'Clic para descargar';
        a.style.cssText = 'display:block;border:1px solid #444;overflow:hidden;background:#000;transition:border-color 0.2s ease;';
        a.onmouseover = () => a.style.borderColor = '#fff';
        a.onmouseout = () => a.style.borderColor = '#444';
        const im = document.createElement('img');
        im.src = a.href;
        im.style.cssText = 'display:block;max-width:220px;max-height:160px;filter:grayscale(100%)';
        a.appendChild(im);
        shots.prepend(a);
        while (shots.children.length > 3) shots.lastChild.remove();
        const flash = document.createElement('div');
        flash.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:.6;pointer-events:none;' +
            'transition:opacity .4s;z-index:11';
        document.body.appendChild(flash);
        requestAnimationFrame(() => { flash.style.opacity = '0'; setTimeout(() => flash.remove(), 450); });
    }

    // ---------- dibujo de manos / cuadro ----------
    // Minimapa del campo visible del Kinect: borde = lo que ve, recuadro punteado = región segura
    // Se reserva siempre este espacio (arriba a la izquierda); con la vista previa activa, va debajo
    const MAP_RECT = { x: 24, y: 54, w: 256, h: 192 };
    function drawMinimap(msg) {
        const { x, y, w, h } = MAP_RECT, m = P.margin;
        g.save();
        g.fillStyle = P.preview ? 'transparent' : 'rgba(0,0,0,0.8)';
        g.fillRect(x, y, w, h);
        g.strokeStyle = '#444'; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, w - 1, h - 1);
        g.setLineDash([4, 4]); g.strokeStyle = '#666'; g.lineWidth = 1;
        g.strokeRect(x + m * w, y + m * h, w * (1 - 2 * m), h * (1 - 2 * m));
        g.setLineDash([]);
        for (const b of msg.bodies) {
            for (const k of ['L', 'R']) {
                const hd = b.hands[k];
                if (!hd || !(hd.vis || hd.out)) continue;
                g.fillStyle = hd.out ? '#444' : COLORS[(b.id - 1) % COLORS.length];
                g.beginPath(); g.arc(x + hd.sx * w, y + hd.sy * h, 4, 0, Math.PI * 2); g.fill();
            }
        }
        g.fillStyle = '#666'; g.font = '10px system-ui,-apple-system,sans-serif';
        g.fillText('ZONE', x + 6, y + 14);
        if (!msg.bodies.length) g.fillText('NO BODY DETECTED', x + 6, y + h - 8);
        g.restore();
    }

    function drawBodies(msg) {
        g.clearRect(0, 0, cv.width, cv.height);
        drawMinimap(msg);
        for (const b of msg.bodies) {
            const col = COLORS[(b.id - 1) % COLORS.length];
            const isPrimary = b.id === msg.primary;
            const pts = {};
            for (const k of ['L', 'R']) {
                const h = b.hands[k];
                if (!h || !(h.vis || h.out)) continue;
                if (h.out) {        // fuera de la región: cruz fina
                    const [ox, oy] = toScreen(Math.min(Math.max(h.sx, 0.02), 0.98), Math.min(Math.max(h.sy, 0.02), 0.98));
                    g.globalAlpha = 0.5; g.strokeStyle = '#888'; g.lineWidth = 1;
                    g.beginPath(); g.arc(ox, oy, 10, 0, Math.PI * 2); g.moveTo(ox - 6, oy - 6); g.lineTo(ox + 6, oy + 6);
                    g.moveTo(ox + 6, oy - 6); g.lineTo(ox - 6, oy + 6); g.stroke(); g.globalAlpha = 1;
                    continue;
                }
                pts[k] = toScreen(h.sx, h.sy);
                const [x, y] = pts[k];
                g.globalAlpha = h.held ? 0.3 : 1;
                g.beginPath();
                g.arc(x, y, h.on ? 12 : 6, 0, Math.PI * 2);
                g.lineWidth = isPrimary ? 2 : 1;
                g.strokeStyle = col;
                g.stroke();
                if (h.on) { g.fillStyle = 'rgba(255,255,255,0.2)'; g.fill(); }
                g.fillStyle = '#aaa';
                g.font = '10px system-ui,-apple-system,sans-serif';
                g.fillText(`C${b.id}·${k}`, x + 16, y + 4);
            }
            g.globalAlpha = 1;
            if (pts.L && pts.R) {       // correlación entre las dos manos del mismo cuerpo
                g.beginPath();
                g.moveTo(...pts.L); g.lineTo(...pts.R);
                g.strokeStyle = isPrimary ? '#888' : '#444';
                g.lineWidth = 1;
                g.setLineDash([4, 4]);
                g.stroke();
                g.setLineDash([]);
                if (isPrimary) {
                    g.fillStyle = '#aaa';
                    g.fillText(b.armed ? 'ZOOM ✋✋' : 'TWO HANDS', (pts.L[0] + pts.R[0]) / 2, (pts.L[1] + pts.R[1]) / 2 - 8);
                }
            }
            if (b.frame) drawFrame(b.frame, col, isPrimary);
        }
    }

    function drawFrame(rect, col, isPrimary) {
        const [x0, y0] = toScreen(rect[0], rect[1]);
        const [x1, y1] = toScreen(rect[2], rect[3]);
        const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
        g.strokeStyle = '#666';
        g.lineWidth = 1;
        g.setLineDash([4, 4]);
        g.strokeRect(x, y, w, h);
        g.setLineDash([]);
        const L = Math.min(20, w / 4, h / 4);
        g.lineWidth = 2;
        g.strokeStyle = '#fff';
        for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
            g.beginPath();
            g.moveTo(cx + sx * L, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + sy * L);
            g.stroke();
        }
        g.fillStyle = '#aaa';
        g.font = '10px system-ui,-apple-system,sans-serif';
        g.fillText('FRAME', x + 4, y - 6);
        if (isPrimary && hold) {
            const p = Math.min((performance.now() - hold.t0) / (P.hold * 1000), 1);
            g.beginPath();
            g.arc(x + w / 2, y + h / 2, 16, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
            g.lineWidth = 2;
            g.strokeStyle = '#fff';
            g.stroke();
        }
    }

    // ---------- lógica de gestos (cuerpo que controla) ----------
    function onMessage(msg) {
        // Fijar a una sola persona: se mantiene hasta que se pierde LOCK_LOST_MS
        const now = performance.now();
        if (lockedId !== null && msg.bodies.some((x) => x.id === lockedId)) lockedSeen = now;
        else if (lockedId === null || now - lockedSeen > LOCK_LOST_MS) {
            lockedId = msg.primary ?? null;
            lockedSeen = now;
        }
        const ctrlId = msg.bodies.some((x) => x.id === lockedId) ? lockedId : null;
        msg.bodies = msg.bodies.filter((x) => x.id === ctrlId);   // límite: 1 persona
        msg.primary = ctrlId;                     // dibujo y lógica solo usan el cuerpo fijado
        const b = msg.bodies.find((x) => x.id === ctrlId);
        // Límite de región: una mano en el borde del campo visible (o fuera) se trata como soltada.
        // Así el movimiento termina, se conserva el empujón (inercia) y no se queda "pegado" en ARRASTRAR.
        for (const k of ['L', 'R']) {
            const h = b && b.hands[k];
            if (!h || !h.vis) { regionOut[k] = false; continue; }
            const lo = P.margin + (regionOut[k] ? 0.02 : 0), hi = 1 - lo;     // histéresis al volver
            regionOut[k] = h.sx < lo || h.sx > hi || h.sy < lo || h.sy > hi;
            if (regionOut[k]) { h.out = true; h.vis = false; h.on = false; }
        }
        // Aplausos: un contador por cuerpo; solo dispara el del cuerpo que controla
        for (const x of msg.bodies) {
            if (claps.has(x.id) && x.clap > claps.get(x.id) && x.id === ctrlId) zoomBy(-P.clap);
            claps.set(x.id, x.clap);
        }
        if (ctrlId !== primaryId) { primaryId = ctrlId; setMode('none'); hold = null; }

        let text = '';
        if (!b) {
            setMode('none');
            hold = null;
            text = msg.bodies.length ? 'RAISE A HAND' : 'SEARCHING...';
        } else if (b.frame) {
            setMode('frame');
            const key = b.frame.map((v) => v.toFixed(2)).join();
            const still = hold && hold.rect.every((v, i) => Math.abs(v - b.frame[i]) < 0.04);
            if (!still) hold = { t0: performance.now(), rect: b.frame.slice(), done: false };
            else if (!hold.done && performance.now() - hold.t0 > P.hold * 1000) {
                hold.done = true;
                capture(b.frame);
            }
            text = 'FRAME' + (hold && hold.done ? ' · CAPTURED' : '');
        } else {
            hold = null;
            const L = b.hands.L, R = b.hands.R;
            const both = L && R && L.vis && R.vis;
            if (both && ((L.on && R.on) || b.armed)) {
                setMode('two');
                if (!L.held && !R.held) lastLiveT = performance.now();
                // Movimiento de cada mano desde el frame anterior (L = izquierda, R = derecha)
                const lp = (p, c) => p + (c - p) * P.hand;
                const lxy = handXY(L), rxy = handXY(R);
                const cur = prevHands ? {
                    L: { x: lp(prevHands.L.x, lxy.x), y: lp(prevHands.L.y, lxy.y) },
                    R: { x: lp(prevHands.R.x, rxy.x), y: lp(prevHands.R.y, rxy.y) },
                } : { L: lxy, R: rxy };
                if (prevHands) {
                    const dx1 = cur.L.x - prevHands.L.x, dy1 = cur.L.y - prevHands.L.y;   // mano izquierda
                    const dx2 = cur.R.x - prevHands.R.x, dy2 = cur.R.y - prevHands.R.y;   // mano derecha
                    const q1 = Math.round(dx1 / P.step), q2 = Math.round(dx2 / P.step);
                    if (q1 !== 0 && q2 !== 0) {
                        if (Math.sign(q1) === Math.sign(q2)) {
                            rotate((dx1 + dx2) / 2, (dy1 + dy2) / 2);          // mismo signo: mover
                            text = 'DRAG';
                        } else {
                            const dist = Math.hypot(cur.L.x - cur.R.x, cur.L.y - cur.R.y);     // signo opuesto: zoom
                            const dprev = Math.hypot(prevHands.L.x - prevHands.R.x, prevHands.L.y - prevHands.R.y);
                            zoomBy(P.zoom * Math.log(dprev / Math.max(dist, 0.05)));
                            text = 'ZOOM';
                        }
                    }                                                          // alguna en 0: nada
                }
                prevHands = cur;
                text = text || 'TWO HANDS';
            } else if ((L && L.on) || (R && R.on)) {
                const key = L && L.on ? 'L' : 'R', h = b.hands[key], xy = handXY(h);
                if (mode !== 'drag' || prev?.key !== key) { setMode('drag'); prev = null; }
                if (prev) rotate(xy.x - prev.x, xy.y - prev.y);
                if (!h.held) lastLiveT = performance.now();
                prev = { key, x: xy.x, y: xy.y };
                text = `DRAG (${key})`;
            } else {
                setMode('none');
                text = 'RAISE A HAND';
            }
            text += ` · C${b.id}${b.z ? ' ' + b.z + 'm' : ''}`;
        }
        badge.textContent = `KINECT: ${text} · BODIES ${msg.bodies.length}`;
        drawBodies(msg);
    }

    const es = new EventSource(AURALIS + '/events');
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    es.onerror = () => { badge.textContent = 'KINECT: NO CONNECTION'; };
}