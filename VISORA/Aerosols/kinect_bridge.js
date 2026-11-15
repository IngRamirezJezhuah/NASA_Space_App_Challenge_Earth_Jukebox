// Puente Kinect -> página. Se activa con ?kinect (lo lanza kinect/body_tracker.sh).
// Recibe cuerpos/manos/gestos por SSE (/events) y mueve la cámara del globo en tiempo real.
//   ARRASTRAR (R/L): una mano levantada gira el globo.
//   ZOOM: dos manos visibles; separar = acercar, juntar = alejar. Un aplauso acerca un paso.
//   ENCUADRE: pulgares e índices formando un rectángulo muestran el cuadro; 1 s = captura.
import * as THREE from 'three';

// ---- Ajustes manuales ----
const ROT_GAIN = 0.9;      // radianes por ancho de hombros de movimiento de la mano
const ZOOM_GAIN = 0.6;     // sensibilidad del zoom con dos manos
const CLAP_ZOOM = 0.30;    // log del zoom por aplauso (0.30 ≈ acerca 26 %)
const STEP_Q = 0.012;      // dos manos: movimiento por mensaje menor a STEP_Q/2 (anchos de hombro) cuenta como 0
const DEADZONE = 0.006;    // movimientos menores (en anchos de hombro) se ignoran
const SMOOTH = 0.18;       // fracción del movimiento pendiente aplicada por frame
const MAX_STEP = 0.25;     // rad máximos de giro por mensaje
const INERTIA = 0.90;      // inercia al soltar la mano (0 = sin inercia)
const INVERT_X = false;    // true si el giro horizontal va al revés
const INVERT_Y = false;    // true si el giro vertical va al revés
const MIN_PHI = 0.15;      // límite de inclinación (polos)
const MAP_GAIN = 1.4;      // cuánto se amplía el movimiento de las manos en pantalla
const CAPTURE_HOLD = 1.0;  // s con el cuadro quieto para capturar la zona
const LOCK_LOST_MS = 1500; // ms sin ver al cuerpo fijado antes de cambiar a otra persona
const HAND_SMOOTH = 0.5;   // filtro de las manos (1 = sin filtro) para evitar ruido
const COLORS = ['#00c800', '#ffa000', '#00a0ff', '#dc00dc'];   // un color por cuerpo

export function initKinect({ scene, camera, controls, renderer }) {
    const sph = new THREE.Spherical();
    const pend = { theta: 0, phi: 0, zoom: 0 };
    const vel = { theta: 0, phi: 0 };
    const last = { theta: 0, phi: 0 };
    let mode = 'none', prev = null, prevDist = null, prevHands = null, primaryId = null;
    const claps = new Map();
    let hold = null;     // {t0, rect}
    let lockedId = null, lockedSeen = 0;   // una sola persona controla; el resto es ruido

    // ---------- UI ----------
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:12px;bottom:12px;width:320px;border:1px solid #fff4;' +
        'border-radius:8px;overflow:hidden;background:#000a;font:12px sans-serif;color:#fff;z-index:10';
    const img = document.createElement('img');
    img.src = '/preview.mjpg';
    img.style.cssText = 'display:block;width:100%';
    const badge = document.createElement('div');
    badge.style.cssText = 'padding:4px 8px';
    badge.textContent = 'Kinect: conectando…';
    box.append(img, badge);
    document.body.appendChild(box);

    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9';
    document.body.appendChild(cv);
    const g = cv.getContext('2d');
    function fit() { cv.width = innerWidth; cv.height = innerHeight; }
    fit();
    addEventListener('resize', fit);

    const shots = document.createElement('div');
    shots.style.cssText = 'position:fixed;right:12px;top:12px;display:flex;flex-direction:column;gap:8px;z-index:10';
    document.body.appendChild(shots);

    const toScreen = (nx, ny) => [((nx - 0.5) * MAP_GAIN + 0.5) * innerWidth,
                                  ((ny - 0.5) * MAP_GAIN + 0.5) * innerHeight];

    // ---------- movimiento ----------
    const clampStep = (v) => THREE.MathUtils.clamp(v, -MAX_STEP, MAX_STEP);

    function rotate(dx, dy) {
        if (Math.hypot(dx, dy) < DEADZONE) return;
        const scale = THREE.MathUtils.clamp((camera.position.length() - 1) / 2.2, 0.15, 2);
        last.theta = clampStep((INVERT_X ? 1 : -1) * dx * ROT_GAIN * scale);
        last.phi = clampStep((INVERT_Y ? -1 : 1) * dy * ROT_GAIN * scale);
        pend.theta += last.theta;
        pend.phi += last.phi;
        vel.theta = vel.phi = 0;
    }

    function zoomBy(logv) {
        if (Math.abs(logv) > 0.003) pend.zoom += THREE.MathUtils.clamp(logv, -0.2, 0.2);
    }

    function tick() {
        if (mode !== 'drag') {        // inercia al soltar
            pend.theta += vel.theta;
            pend.phi += vel.phi;
            vel.theta *= INERTIA;
            vel.phi *= INERTIA;
            if (Math.abs(vel.theta) + Math.abs(vel.phi) < 1e-4) vel.theta = vel.phi = 0;
        }
        const dth = pend.theta * SMOOTH, dph = pend.phi * SMOOTH, dz = pend.zoom * SMOOTH;
        pend.theta -= dth; pend.phi -= dph; pend.zoom -= dz;
        if (Math.abs(dth) + Math.abs(dph) + Math.abs(dz) > 1e-5) {
            sph.setFromVector3(camera.position);
            sph.theta += dth;
            sph.phi = THREE.MathUtils.clamp(sph.phi + dph, MIN_PHI, Math.PI - MIN_PHI);
            sph.radius = THREE.MathUtils.clamp(sph.radius * Math.exp(dz), controls.minDistance, controls.maxDistance);
            camera.position.setFromSpherical(sph);
            camera.lookAt(0, 0, 0);
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    function setMode(m) {
        if (m === mode) return;
        if (mode === 'drag') { vel.theta = last.theta * 0.5; vel.phi = last.phi * 0.5; }
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
        a.style.cssText = 'display:block;border:2px solid #0ff;border-radius:6px;overflow:hidden;background:#000';
        const im = document.createElement('img');
        im.src = a.href;
        im.style.cssText = 'display:block;max-width:220px;max-height:160px';
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
    function drawBodies(msg) {
        g.clearRect(0, 0, cv.width, cv.height);
        for (const b of msg.bodies) {
            const col = COLORS[(b.id - 1) % COLORS.length];
            const isPrimary = b.id === msg.primary;
            const pts = {};
            for (const k of ['L', 'R']) {
                const h = b.hands[k];
                if (!h || !h.vis) continue;
                pts[k] = toScreen(h.sx, h.sy);
                const [x, y] = pts[k];
                g.globalAlpha = h.held ? 0.4 : 1;
                g.beginPath();
                g.arc(x, y, h.on ? 16 : 9, 0, Math.PI * 2);
                g.lineWidth = isPrimary ? 4 : 2;
                g.strokeStyle = col;
                g.stroke();
                if (h.on) { g.fillStyle = col + '88'; g.fill(); }
                g.fillStyle = '#fff';
                g.font = '12px sans-serif';
                g.fillText(`C${b.id}·${k}`, x + 20, y + 4);
            }
            g.globalAlpha = 1;
            if (pts.L && pts.R) {       // correlación entre las dos manos del mismo cuerpo
                g.beginPath();
                g.moveTo(...pts.L); g.lineTo(...pts.R);
                g.strokeStyle = col + (isPrimary ? 'cc' : '55');
                g.lineWidth = isPrimary ? 3 : 1;
                g.setLineDash([6, 6]);
                g.stroke();
                g.setLineDash([]);
                if (isPrimary) {
                    g.fillStyle = '#fff';
                    g.fillText(b.armed ? 'ZOOM ✋✋' : 'dos manos', (pts.L[0] + pts.R[0]) / 2, (pts.L[1] + pts.R[1]) / 2 - 8);
                }
            }
            if (b.frame) drawFrame(b.frame, col, isPrimary);
        }
    }

    function drawFrame(rect, col, isPrimary) {
        const [x0, y0] = toScreen(rect[0], rect[1]);
        const [x1, y1] = toScreen(rect[2], rect[3]);
        const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
        g.strokeStyle = '#0ff';
        g.lineWidth = 2;
        g.setLineDash([10, 6]);
        g.strokeRect(x, y, w, h);
        g.setLineDash([]);
        const L = Math.min(24, w / 3, h / 3);
        g.lineWidth = 4;
        for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
            g.beginPath();
            g.moveTo(cx + sx * L, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + sy * L);
            g.stroke();
        }
        g.fillStyle = '#0ff';
        g.font = '13px sans-serif';
        g.fillText('ZONA', x + 6, y - 6);
        if (isPrimary && hold) {
            const p = Math.min((performance.now() - hold.t0) / (CAPTURE_HOLD * 1000), 1);
            g.beginPath();
            g.arc(x + w / 2, y + h / 2, 22, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
            g.lineWidth = 5;
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
        msg.primary = ctrlId;                     // dibujo y lógica solo usan el cuerpo fijado
        const b = msg.bodies.find((x) => x.id === ctrlId);
        // Aplausos: un contador por cuerpo; solo dispara el del cuerpo que controla
        for (const x of msg.bodies) {
            if (claps.has(x.id) && x.clap > claps.get(x.id) && x.id === ctrlId) zoomBy(-CLAP_ZOOM);
            claps.set(x.id, x.clap);
        }
        if (ctrlId !== primaryId) { primaryId = ctrlId; setMode('none'); hold = null; }

        let text = '';
        if (!b) {
            setMode('none');
            hold = null;
            text = msg.bodies.length ? 'levanta una mano' : 'buscando cuerpo…';
        } else if (b.frame) {
            setMode('frame');
            const key = b.frame.map((v) => v.toFixed(2)).join();
            const still = hold && hold.rect.every((v, i) => Math.abs(v - b.frame[i]) < 0.04);
            if (!still) hold = { t0: performance.now(), rect: b.frame.slice(), done: false };
            else if (!hold.done && performance.now() - hold.t0 > CAPTURE_HOLD * 1000) {
                hold.done = true;
                capture(b.frame);
            }
            text = 'ENCUADRE' + (hold && hold.done ? ' · capturado' : '');
        } else {
            hold = null;
            const L = b.hands.L, R = b.hands.R;
            const both = L && R && L.vis && R.vis;
            if (both && ((L.on && R.on) || b.armed)) {
                setMode('two');
                // Movimiento de cada mano desde el frame anterior (L = izquierda, R = derecha)
                const lp = (p, c) => p + (c - p) * HAND_SMOOTH;
                const cur = prevHands ? {
                    L: { x: lp(prevHands.L.x, L.x), y: lp(prevHands.L.y, L.y) },
                    R: { x: lp(prevHands.R.x, R.x), y: lp(prevHands.R.y, R.y) },
                } : { L: { x: L.x, y: L.y }, R: { x: R.x, y: R.y } };
                if (prevHands) {
                    const dx1 = cur.L.x - prevHands.L.x, dy1 = cur.L.y - prevHands.L.y;   // mano izquierda
                    const dx2 = cur.R.x - prevHands.R.x, dy2 = cur.R.y - prevHands.R.y;   // mano derecha
                    const q1 = Math.round(dx1 / STEP_Q), q2 = Math.round(dx2 / STEP_Q);
                    if (q1 !== 0 && q2 !== 0) {
                        if (Math.sign(q1) === Math.sign(q2)) {
                            rotate((dx1 + dx2) / 2, (dy1 + dy2) / 2);          // mismo signo: mover
                            text = 'MOVER';
                        } else {
                            const dist = Math.hypot(cur.L.x - cur.R.x, cur.L.y - cur.R.y);     // signo opuesto: zoom
                            const dprev = Math.hypot(prevHands.L.x - prevHands.R.x, prevHands.L.y - prevHands.R.y);
                            zoomBy(ZOOM_GAIN * Math.log(dprev / Math.max(dist, 0.05)));
                            text = 'ZOOM';
                        }
                    }                                                          // alguna en 0: nada
                }
                prevHands = cur;
                text = text || 'dos manos';
            } else if ((L && L.on) || (R && R.on)) {
                const key = L && L.on ? 'L' : 'R', h = b.hands[key];
                if (mode !== 'drag' || prev?.key !== key) { setMode('drag'); prev = null; }
                if (prev) rotate(h.x - prev.x, h.y - prev.y);
                prev = { key, x: h.x, y: h.y };
                text = `ARRASTRAR (${key})`;
            } else {
                setMode('none');
                text = 'levanta una mano';
            }
            text += ` · C${b.id}${b.z ? ' ' + b.z + 'm' : ''}`;
        }
        badge.textContent = `Kinect: ${text} · cuerpos ${msg.bodies.length}`;
        drawBodies(msg);
    }

    const es = new EventSource('/events');
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    es.onerror = () => { badge.textContent = 'Kinect: sin conexión'; };
}
