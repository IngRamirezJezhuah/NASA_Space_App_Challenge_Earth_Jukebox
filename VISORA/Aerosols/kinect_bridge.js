// Puente Kinect -> página. Se activa con ?kinect (lo lanza kinect/body_tracker.sh).
// Recibe las manos por SSE (/events) y mueve la cámara del globo; muestra la vista previa.
import * as THREE from 'three';

// ---- Ajustes manuales ----
const ROT_GAIN = 2.2;      // radianes por ancho de hombros de movimiento de la mano
const ZOOM_GAIN = 0.7;     // sensibilidad del zoom con dos manos
const INVERT_X = false;    // true si el giro horizontal va al revés
const INVERT_Y = false;    // true si el giro vertical va al revés
const MIN_PHI = 0.15;      // límite de inclinación (polos)

export function initKinect({ camera, controls }) {
    const prev = { L: null, R: null };
    let prevDist = null;
    const sph = new THREE.Spherical();

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

    // Movimiento pendiente: se reparte en varios frames para que sea suave y ligero
    const pend = { theta: 0, phi: 0, zoom: 0 };

    function rotate(dx, dy) {
        if (Math.hypot(dx, dy) < DEADZONE) return;
        const scale = THREE.MathUtils.clamp((camera.position.length() - 1) / 2.2, 0.15, 2);
        const clamp = (v) => THREE.MathUtils.clamp(v, -MAX_STEP, MAX_STEP);
        pend.theta += clamp((INVERT_X ? 1 : -1) * dx * ROT_GAIN * scale);
        pend.phi += clamp((INVERT_Y ? -1 : 1) * dy * ROT_GAIN * scale);
    }

    function zoom(ratio) {
        const l = Math.log(ratio);
        if (Math.abs(l) > 0.003) pend.zoom += THREE.MathUtils.clamp(l, -0.2, 0.2);
    }

    function tick() {
        const k = SMOOTH;
        const dth = pend.theta * k, dph = pend.phi * k, dz = pend.zoom * k;
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

    function onHands(msg) {
        const L = msg.hands.L, R = msg.hands.R;
        const onL = !!(L && L.on), onR = !!(R && R.on);

        if (onL && onR) {
            const dist = Math.hypot(L.x - R.x, L.y - R.y);
            const mx = (L.x + R.x) / 2, my = (L.y + R.y) / 2;
            if (prevDist !== null && prev.mid) {
                zoom(Math.pow(prevDist / Math.max(dist, 0.05), ZOOM_GAIN));
                rotate(mx - prev.mid.x, my - prev.mid.y);
            }
            prevDist = dist;
            prev.mid = { x: mx, y: my };
            prev.L = prev.R = null;
            badge.textContent = 'Kinect: ZOOM';
        } else if (onL || onR) {
            const key = onL ? 'L' : 'R', h = onL ? L : R;
            if (prev[key]) rotate(h.x - prev[key].x, h.y - prev[key].y);
            prev[key] = { x: h.x, y: h.y };
            if (!onL) prev.L = null;
            if (!onR) prev.R = null;
            prevDist = null;
            prev.mid = null;
            badge.textContent = 'Kinect: ARRASTRAR (' + key + ')';
        } else {
            prev.L = prev.R = prev.mid = null;
            prevDist = null;
            badge.textContent = msg.body ? 'Kinect: levanta una mano' : 'Kinect: buscando cuerpo…';
        }
    }

    const es = new EventSource('/events');
    es.onmessage = (e) => onHands(JSON.parse(e.data));
    es.onerror = () => { badge.textContent = 'Kinect: sin conexión'; };
}
