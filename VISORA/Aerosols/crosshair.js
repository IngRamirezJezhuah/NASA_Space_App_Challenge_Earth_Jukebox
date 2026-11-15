// Crosshair en el centro de la pantalla: apunta al punto del planeta que queda en el centro y lee
// el color del mapa en ese punto (para conectarlo después con el generador de música).
//
// Salida para otros módulos:
//   window.visora.crosshair = { lat, lon, u, v, r, g, b, hex, t }
//   evento 'visora:crosshair' en window con ese mismo objeto en event.detail
import * as THREE from 'three';

const CYAN = '#00eaff', ORANGE = '#ff8a1e';
const RATE_MS = 50;      // frecuencia de lectura (20 Hz)
const SAMPLE_PX = 5;     // el color es el promedio de un cuadro de SAMPLE_PX × SAMPLE_PX del mapa

export function createCrosshair({ camera, globe, getMap }) {
    const css = document.createElement('style');
    css.textContent = `
    #vx{position:fixed;left:50%;top:50%;width:128px;height:128px;margin:-64px 0 0 -64px;z-index:8;
        pointer-events:none;filter:drop-shadow(0 0 2px #000) drop-shadow(0 0 6px ${CYAN})}
    #vx .spin{transform-origin:64px 64px;animation:vxspin 10s linear infinite}
    @keyframes vxspin{to{transform:rotate(360deg)}}
    #vx-info{position:fixed;left:calc(50% + 78px);top:calc(50% - 6px);z-index:8;pointer-events:none;
        font:11px 'Courier New',monospace;color:${CYAN};text-shadow:0 0 4px #000,0 0 8px ${CYAN}88;
        background:#020816aa;border:1px solid ${CYAN}66;padding:4px 8px;display:flex;gap:8px;align-items:center;
        clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px))}
    #vx-info i{display:block;width:16px;height:16px;border:1px solid #fff;box-shadow:0 0 6px #000}
    #vx-info b{color:#fff;font-weight:normal}
    #vx-info span{color:${ORANGE}}`;
    document.head.appendChild(css);

    const root = document.createElement('div');
    root.id = 'vx';
    root.innerHTML = `
      <svg viewBox="0 0 128 128" width="128" height="128" fill="none" stroke-linecap="round">
        <circle cx="64" cy="64" r="30" stroke="${CYAN}" stroke-width="2"/>
        <g class="spin"><circle cx="64" cy="64" r="44" stroke="${ORANGE}" stroke-width="2" stroke-dasharray="10 8"/></g>
        <path d="M64 6V34M64 94V122M6 64H34M94 64H122" stroke="${CYAN}" stroke-width="2.5"/>
        <path d="M54 64H60M68 64H74M64 54V60M64 68V74" stroke="#fff" stroke-width="1.5"/>
        <circle id="vx-dot" cx="64" cy="64" r="4.5" fill="#fff" stroke="#fff" stroke-width="1.5"/>
      </svg>`;
    const info = document.createElement('div');
    info.id = 'vx-info';
    info.innerHTML = '<i></i><div><b class="hex">—</b> <span class="rgb"></span><br><span class="pos"></span></div>';
    document.body.append(root, info);
    const dot = root.querySelector('#vx-dot'), sw = info.querySelector('i');
    const hexEl = info.querySelector('.hex'), rgbEl = info.querySelector('.rgb'), posEl = info.querySelector('.pos');

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2(0, 0);
    const px = document.createElement('canvas');
    px.width = px.height = 1;
    const ctx = px.getContext('2d', { willReadFrequently: true });
    const state = (window.visora = window.visora || {});
    let last = 0;

    function sampleColor(u, v) {
        const map = getMap();
        const img = map && map.image;
        if (!img || !img.width) return null;
        const W = img.width, H = img.height, h = SAMPLE_PX >> 1;
        const sx = Math.min(Math.max(Math.floor(u * W) - h, 0), W - SAMPLE_PX);
        const sy = Math.min(Math.max(Math.floor((1 - v) * H) - h, 0), H - SAMPLE_PX);
        try {
            ctx.drawImage(img, sx, sy, SAMPLE_PX, SAMPLE_PX, 0, 0, 1, 1);   // promedia el cuadro
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return [d[0], d[1], d[2]];
        } catch {
            return null;       // imagen de otro origen: abre la página desde body_tracker.sh
        }
    }

    return function update(now) {
        if (now - last < RATE_MS) return;
        last = now;
        globe.updateWorldMatrix(true, false);
        ray.setFromCamera(ndc, camera);
        const hit = ray.intersectObject(globe, false)[0];
        if (!hit || !hit.uv) {
            info.style.opacity = '0';
            state.crosshair = null;
            return;
        }
        info.style.opacity = '1';
        const { x: u, y: v } = hit.uv;
        const lat = (v - 0.5) * 180;
        let lon = (u - 0.5) * 360;
        if (lon > 180) lon -= 360;
        if (lon < -180) lon += 360;
        const c = sampleColor(u, v);
        const detail = { lat, lon, u, v, t: now };
        if (c) {
            const [r, g, b] = c;
            const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
            Object.assign(detail, { r, g, b, hex });
            dot.setAttribute('fill', hex);
            sw.style.background = hex;
            hexEl.textContent = hex.toUpperCase();
            rgbEl.textContent = `rgb(${r},${g},${b})`;
        } else {
            hexEl.textContent = 'sin color';
            rgbEl.textContent = '';
        }
        posEl.textContent = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'O'}`;
        state.crosshair = detail;
        dispatchEvent(new CustomEvent('visora:crosshair', { detail }));
    };
}
