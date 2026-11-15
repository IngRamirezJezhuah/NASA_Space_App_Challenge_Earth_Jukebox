// Fondo espacial con estrellas en capas y paralaje (three.js).
// Las capas giran lento por sí solas y además siguen una fracción distinta del giro del globo
// y de la cámara, así las cercanas se mueven más que las lejanas.
import * as THREE from 'three';

export const starSettings = { speed: 1 };   // 0 = quietas (lo cambia el panel de ajustes)

function dotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,.85)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
}

// n estrellas, radio, tamaño (px), giro propio (rad/s), cuánto sigue al globo, cuánto sigue a la cámara
const LAYERS = [
    { n: 2200, r: [60, 90], size: 1.4, spin: 0.006, follow: 0.03, cam: 0.9 },
    { n: 1000, r: [35, 60], size: 2.2, spin: 0.012, follow: 0.07, cam: 0.6 },
    { n: 350,  r: [18, 35], size: 3.4, spin: 0.020, follow: 0.14, cam: 0.3 },
];
const TINTS = [[1, 1, 1], [0.7, 0.9, 1], [1, 0.8, 0.95], [0.7, 1, 1], [1, 0.95, 0.75]];

export function createStars(scene) {
    const tex = dotTexture();
    const layers = LAYERS.map((cfg) => {
        const pos = new Float32Array(cfg.n * 3), col = new Float32Array(cfg.n * 3);
        for (let i = 0; i < cfg.n; i++) {
            const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
            const rr = cfg.r[0] + Math.random() * (cfg.r[1] - cfg.r[0]), s = Math.sqrt(1 - u * u);
            pos.set([rr * s * Math.cos(th), rr * u, rr * s * Math.sin(th)], i * 3);
            const t = TINTS[(Math.random() * TINTS.length) | 0], b = 0.35 + Math.random() * 0.65;
            col.set([t[0] * b, t[1] * b, t[2] * b], i * 3);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({
            map: tex, size: cfg.size, sizeAttenuation: false, vertexColors: true, transparent: true,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        pts.frustumCulled = false;
        pts.renderOrder = -1;
        scene.add(pts);
        return { cfg, pts, angle: Math.random() * 6 };
    });

    const qId = new THREE.Quaternion(), qFollow = new THREE.Quaternion(), qSpin = new THREE.Quaternion();
    const eul = new THREE.Euler();
    let lastT = 0;

    return function update(now, camera, pivot) {
        const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
        lastT = now;
        for (const L of layers) {
            L.angle += dt * L.cfg.spin * starSettings.speed;
            eul.set(L.angle * 0.4, L.angle, 0);
            qSpin.setFromEuler(eul);
            qFollow.copy(qId).slerp(pivot ? pivot.quaternion : qId, L.cfg.follow);
            L.pts.quaternion.copy(qFollow).multiply(qSpin);
            L.pts.position.copy(camera.position).multiplyScalar(L.cfg.cam);
        }
    };
}
