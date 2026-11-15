import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import './intro.js';
import { createStars } from './stars.js';
import { createCrosshair } from './crosshair.js';

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 300);
camera.position.set(0, 0, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const FRAME_COUNT = 2206;
const PRELOAD = 26;          // cuántos cuadros se van cargando por delante
const FADE_RATIO = 0.75;     // parte del intervalo que dura la mezcla entre cuadros
const SPEEDS = [6, 10, 15, 24];   // cuadros por segundo que ofrece el botón de velocidad
let speedIdx = 2;

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
        t.generateMipmaps = false;                 // no hacen falta y encarecen cada subida
        t.minFilter = THREE.LinearFilter;
        cache.set(i, t);
    }
    return cache.get(i);
}

const isReady = (t) => !!t.image;

function preload(from) {
    const keep = new Set();
    for (let k = 0; k <= PRELOAD; k++) {
        const i = (from + k) % images.length;
        keep.add(i);
        getTexture(i);
    }
    for (const [i, t] of cache) {
        if (!keep.has(i)) { t.dispose(); cache.delete(i); }
    }
}
// cuántos cuadros seguidos ya están listos por delante: sirve para no tartamudear
function buffered(from) {
    let n = 0;
    for (let k = 1; k <= PRELOAD; k++) {
        const t = cache.get((from + k) % images.length);
        if (!t || !isReady(t)) break;
        n++;
    }
    return n;
}

const geometry = new THREE.SphereGeometry(1, 128, 64);
const baseMat = new THREE.MeshBasicMaterial({ map: getTexture(0) });
const topMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const globe = new THREE.Mesh(geometry, baseMat);
const overlay = new THREE.Mesh(geometry, topMat);
overlay.scale.setScalar(1.0005);
overlay.visible = false;
const pivot = new THREE.Group();   // el globo gira sobre este grupo (sin límite en los polos)
pivot.add(globe, overlay);
scene.add(pivot);
const updateStars = createStars(scene);   // fondo de estrellas con paralaje
const updateCrosshair = createCrosshair({ camera, globe, getMap: () => baseMat.map });   // mira central + gas

preload(0);
let index = 0;
let playing = true;
let fading = false;
let fadeStart = 0;
let waiting = false;

/* =============================================================================
   INTERFAZ
   Mínima y sobria: una barra de reproducción abajo, el fondo arriba a la
   izquierda, y nada más. Todo se desvanece cuando nadie toca nada.
   ============================================================================= */
const ICON_PAUSE = '<svg id="v-icon" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="2.6" height="8"/><rect x="6.4" y="1" width="2.6" height="8"/></svg>';
const ICON_PLAY = '<svg id="v-icon" viewBox="0 0 10 10" fill="currentColor"><path d="M1.6 1 9 5 1.6 9z"/></svg>';

const play = document.createElement('div');
play.id = 'v-play';
play.className = 'v-panel v-fade';
play.innerHTML = `
  <button class="v-btn" id="v-toggle" title="Reproducir o pausar" style="padding:9px 11px">${ICON_PAUSE}</button>
  <input type="range" id="v-scrub" min="0" max="${FRAME_COUNT - 1}" value="0">
  <div id="v-time"><b>1</b> / ${FRAME_COUNT}</div>
  <div class="sep"></div>
  <button class="v-btn" id="v-speed" title="Velocidad">${SPEEDS[speedIdx]} fps</button>`;
document.body.appendChild(play);

const top = document.createElement('div');
top.id = 'v-top';
top.className = 'v-fade';
top.innerHTML = `
  <select id="v-bg" title="Fondo detrás del planeta"></select>
  <button class="v-btn" id="v-bgfile">Imagen propia</button>
  <input type="file" id="v-file" accept="image/*">`;
document.body.appendChild(top);

const buf = document.createElement('div');
buf.id = 'v-buf';
buf.textContent = 'cargando';
document.body.appendChild(buf);

const $ = (id) => document.getElementById(id);
const toggleBtn = $('v-toggle'), scrub = $('v-scrub'), timeEl = $('v-time'), speedBtn = $('v-speed');

function setPlaying(v) {
    playing = v;
    toggleBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
}
toggleBtn.onclick = () => setPlaying(!playing);
speedBtn.onclick = () => { speedIdx = (speedIdx + 1) % SPEEDS.length; speedBtn.textContent = SPEEDS[speedIdx] + ' fps'; };
scrub.oninput = () => {
    index = +scrub.value;
    fading = false; overlay.visible = false;
    baseMat.map = getTexture(index);
    preload(index);
    updateTime();
};
function updateTime() {
    timeEl.innerHTML = `<b>${index + 1}</b> / ${FRAME_COUNT}`;
    if (document.activeElement !== scrub) scrub.value = index;
}

// Fondo de imagen (se muestra detrás del globo)
const bgOptions = [
    ['Sin fondo', ''],
    ['Untitled.jpeg', 'Untitled.jpeg'],
    ['Primer cuadro', images[0]]
];
const bgSelect = $('v-bg');
for (const [name, url] of bgOptions) bgSelect.add(new Option(name, url));
function setBackground(url) {
    document.body.style.background = url ? `#000 url("${url}") center / cover no-repeat` : '#000';
}
bgSelect.onchange = () => setBackground(bgSelect.value);
$('v-bgfile').onclick = () => $('v-file').click();
$('v-file').onchange = () => {
    const f = $('v-file').files[0];
    if (f) { setBackground(URL.createObjectURL(f)); bgSelect.selectedIndex = 0; }
};

// La interfaz se desvanece sola a los 4 s sin actividad
let idleT = 0;
function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => document.body.classList.add('idle'), 4000);
}
['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((e) => addEventListener(e, wake, { passive: true }));
wake();

addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    if (e.key === 'ArrowRight') { index = (index + 1) % FRAME_COUNT; baseMat.map = getTexture(index); preload(index); updateTime(); }
    if (e.key === 'ArrowLeft') { index = (index - 1 + FRAME_COUNT) % FRAME_COUNT; baseMat.map = getTexture(index); preload(index); updateTime(); }
});

/* =============================================================================
   CONTROLES
   Giro libre de 360° en todos los ejes, con una inercia más larga y suave para
   que el planeta se sienta pesado en vez de brusco.
   ============================================================================= */
const controls = new TrackballControls(camera, renderer.domElement);
controls.noPan = true;
controls.rotateSpeed = 1.05;
controls.zoomSpeed = 0.45;
controls.staticMoving = false;
controls.dynamicDampingFactor = 0.06;   // más bajo = se desliza más tiempo
controls.minDistance = 1.5;
controls.maxDistance = 6;

// Deriva lenta cuando nadie toca nada: el planeta nunca se queda totalmente quieto
let lastInput = performance.now();
const markInput = () => { lastInput = performance.now(); };
renderer.domElement.addEventListener('pointerdown', markInput);
renderer.domElement.addEventListener('wheel', markInput, { passive: true });
addEventListener('visora:kinect-input', markInput);

addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});

/* =============================================================================
   BUCLE
   Los cuadros avanzan a los fps elegidos, pero solo si el siguiente ya está
   descargado. Si no lo está, se espera en vez de tartamudear.
   ============================================================================= */
const driftAxis = new THREE.Vector3(0, 1, 0);
const driftQ = new THREE.Quaternion();
let lastT = 0;

function startFade(now) {
    const next = getTexture(index + 1);
    if (!isReady(next)) return false;
    topMat.map = next;
    topMat.opacity = 0;
    topMat.needsUpdate = true;
    overlay.visible = true;
    fading = true;
    fadeStart = now;
    return true;
}

function finishFade() {
    index = (index + 1) % images.length;
    baseMat.map = getTexture(index);
    overlay.visible = false;
    fading = false;
    preload(index);
    updateTime();
}

renderer.setAnimationLoop((now) => {
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0.016;
    lastT = now;
    const interval = 1000 / SPEEDS[speedIdx];

    if (playing || fading) {
        if (!fading) {
            // solo arranca la mezcla si hay colchón suficiente, así no se entrecorta
            const ready = buffered(index) >= 2 || isReady(getTexture(index + 1));
            const started = ready ? startFade(now) : false;
            if (!started) { waiting = true; preload(index); }
            else waiting = false;
        }
        if (fading) {
            const t = Math.min((now - fadeStart) / (interval * FADE_RATIO), 1);
            topMat.opacity = t * t * (3 - 2 * t);   // smoothstep
            if (t >= 1) finishFade();
        }
    } else waiting = false;
    buf.classList.toggle('on', waiting);

    // deriva suave tras 12 s sin tocar nada
    const idle = (now - lastInput) / 1000;
    if (idle > 12) {
        const amount = Math.min((idle - 12) / 6, 1) * 0.012 * dt;
        driftQ.setFromAxisAngle(driftAxis, amount);
        pivot.quaternion.multiply(driftQ).normalize();
    }

    controls.update();
    updateStars(now, camera, pivot);
    updateCrosshair(now);
    renderer.render(scene, camera);
});

// Control con Kinect: se activa abriendo la página con ?kinect (kinect/body_tracker.sh)
if (new URLSearchParams(location.search).has('kinect')) {
    import('./kinect_bridge.js').then((m) => m.initKinect({ scene, camera, controls, renderer, pivot }));
}