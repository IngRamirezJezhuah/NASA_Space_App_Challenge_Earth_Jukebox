import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const tex = new THREE.TextureLoader().load('AerosolOpticalDepth_2048x1024_30fps.0000.png');
tex.colorSpace = THREE.SRGBColorSpace;
tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

const globe = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 64),
    new THREE.MeshBasicMaterial({ map: tex })
);
scene.add(globe);

// Controles tipo model-viewer: arrastrar para rotar, rueda/pellizco para zoom
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 1.5;
controls.maxDistance = 6;
controls.rotateSpeed = 0.6;

addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
});
