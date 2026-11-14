import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const FRAME_COUNT = 2206;
const CHANGE_INTERVAL = 150; // ms que dura la transición entre imágenes
const RENDER_FPS = 60;
const PRELOAD = 8;

const images = Array.from({ length: FRAME_COUNT }, (_, i) =>
    `AURAS/AerosolOpticalDepth_2048x1024_30fps.${String(i).padStart(4, '0')}.png`
);

const loader = new THREE.TextureLoader();
const cache = new Map();

function getTexture(i) {
    i = (i + images.length) % images.length;
    if (!cache.has(i)) {
        const t = loader.load(images[i]);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        cache.set(i, t);
    }
    return cache.get(i);
}

const isReady = (t) => !!t.image;

function preload(from) {
    const keep = new Set([from]);
    for (let k = 0; k <= PRELOAD; k++) {
        const i = (from + k) % images.length;
        keep.add(i);
        getTexture(i);
    }
    for (const [i, t] of cache) {
        if (!keep.has(i)) { t.dispose(); cache.delete(i); }
    }
}

const geometry = new THREE.SphereGeometry(1, 128, 64);
const baseMat = new THREE.MeshBasicMaterial({ map: getTexture(0) });
const topMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const globe = new THREE.Mesh(geometry, baseMat);
const overlay = new THREE.Mesh(geometry, topMat);
overlay.scale.setScalar(1.0005);
overlay.visible = false;
scene.add(globe, overlay);

preload(0);
let index = 0;
let playing = true;
let fading = false;
let fadeStart = 0;

function startFade(now) {
    const next = getTexture(index + 1);
    if (!isReady(next)) return; // espera a que cargue para no dar saltos
    topMat.map = next;
    topMat.opacity = 0;
    topMat.needsUpdate = true;
    overlay.visible = true;
    fading = true;
    fadeStart = now;
}

function finishFade() {
    index = (index + 1) % images.length;
    baseMat.map = getTexture(index);
    overlay.visible = false;
    fading = false;
    preload(index);
    label.textContent = `${index + 1} / ${images.length}`;
}

// UI
const ui = document.createElement('div');
ui.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;color:#fff;font:14px sans-serif;';
const btnStyle = 'padding:8px 16px;border:0;border-radius:6px;cursor:pointer;font-size:14px;';
const btnPlay = document.createElement('button');
btnPlay.textContent = '▶ Reproducir';
const btnPause = document.createElement('button');
btnPause.textContent = '⏸ Pausa';
btnPlay.style.cssText = btnPause.style.cssText = btnStyle;
const label = document.createElement('span');
label.textContent = `1 / ${images.length}`;
ui.append(btnPause, btnPlay, label);
document.body.appendChild(ui);

btnPause.onclick = () => { playing = false; };
btnPlay.onclick = () => { playing = true; };

// Controles tipo model-viewer: arrastrar para rotar, rueda/pellizco para zoom
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 1.5;
controls.maxDistance = 6;
controls.rotateSpeed = 0.25;
controls.zoomSpeed = 0.5;

addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});

let lastRender = 0;
renderer.setAnimationLoop((now) => {
    if (now - lastRender < 1000 / RENDER_FPS - 1) return;
    lastRender = now;
    if (playing || fading) {
        if (!fading) startFade(now);
        if (fading) {
            const t = Math.min((now - fadeStart) / CHANGE_INTERVAL, 1);
            topMat.opacity = t * t * (3 - 2 * t); // smoothstep
            if (t >= 1) finishFade();
        }
    }
    controls.update();
    renderer.render(scene, camera);
});

// Control con Kinect: se activa abriendo la página con ?kinect (kinect/body_tracker.sh)
if (new URLSearchParams(location.search).has('kinect')) {
    import('./kinect_bridge.js').then((m) => m.initKinect({ camera, controls }));
}
