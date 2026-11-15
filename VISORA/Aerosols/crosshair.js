// Cursor central: apunta al punto del planeta que queda en el centro y clasifica el AEROSOL
// que hay ahí leyendo una ZONA del mapa (no un píxel suelto).
//
// Cómo decide el gas:
//   · lee un cuadro de ZONE×ZONE píxeles del mapa alrededor del centro (sin promediar)
//   · clasifica cada píxel por su tono contra los 4 colores de la leyenda GEOS
//   · cada píxel pesa por lo puro que es (saturación × brillo), y cada gas se normaliza
//     contra su propio color de leyenda: Dust y Sea Salt son pálidos y si no, nunca ganarían
//   · gana el gas con más peso, con histéresis: no cambia hasta verlo varios cuadros seguidos
//
// Salida para otros módulos:
//   window.visora.crosshair = { lat, lon, u, v, r, g, b, hex, gas, gasName, intensity, mix, t }
//   evento 'visora:crosshair' en window con ese mismo objeto en event.detail
import * as THREE from 'three';

const RATE_MS = 50;      // frecuencia de lectura (20 Hz)
const ZONE = 24;         // lado de la zona leída, en píxeles del mapa (24×24 = 576 muestras)
const HOLD_FRAMES = 4;   // cuadros seguidos para aceptar un cambio de gas
const HOLD_MS = 600;     // tiempo mínimo entre cambios

// Colores de la leyenda de GEOS. ref = saturación × brillo del color puro, para normalizar.
export const GASES = [
  { id: 0, name: 'Aire limpio', hex: '#9aa0a6', hue: null, ref: 1 },
  { id: 1, name: 'Black Carbon', hex: '#d25e45', hue: 10.6, ref: 0.55 },
  { id: 2, name: 'Dust', hex: '#c19adc', hue: 275.5, ref: 0.26 },
  { id: 3, name: 'Sea Salt', hex: '#85aaa9', hue: 178.4, ref: 0.15 },
  { id: 4, name: 'Sulfate', hex: '#53dc34', hue: 108.9, ref: 0.65 }
];
const TINTED = GASES.filter((g) => g.hue !== null);
const MAX_HUE_DIST = 48;   // más lejos de eso, el color no es de ningún gas

export function createCrosshair({ camera, globe, getMap }) {
    const css = document.createElement('style');
    css.textContent = `
    #vx{position:fixed;left:50%;top:50%;width:120px;height:120px;margin:-60px 0 0 -60px;z-index:8;
        pointer-events:none;opacity:.9}
    #vx-info{position:fixed;left:calc(50% + 74px);top:calc(50% - 26px);z-index:8;pointer-events:none;
        font:11px/1.6 'Courier New',monospace;color:#fff;letter-spacing:.08em;
        text-shadow:0 1px 3px #000,0 0 10px #0008;transition:opacity .3s}
    #vx-info .gas{font-size:13px;letter-spacing:.14em;text-transform:uppercase}
    #vx-info .pos{opacity:.55}
    #vx-bar{width:92px;height:2px;background:#ffffff30;margin:5px 0 4px}
    #vx-bar i{display:block;height:100%;width:0;background:#fff;transition:width .12s linear}
    #vx-dbg{position:fixed;left:12px;bottom:12px;z-index:12;display:none;background:#000a;color:#fff;
        font:11px/1.7 'Courier New',monospace;padding:8px 11px;border:1px solid #ffffff30;white-space:pre}
    body.vxdbg #vx-dbg{display:block}`;
    document.head.appendChild(css);

    // Cursor minimalista: aro fino, cuatro marcas y un punto. Todo blanco.
    const root = document.createElement('div');
    root.id = 'vx';
    root.innerHTML = `
      <svg viewBox="0 0 120 120" width="120" height="120" fill="none"
           stroke="#fff" stroke-width="1.25" stroke-linecap="round">
        <circle cx="60" cy="60" r="26" opacity=".85"/>
        <circle cx="60" cy="60" r="40" opacity=".25"/>
        <path d="M60 12V26M60 94V108M12 60H26M94 60H108" opacity=".85"/>
        <circle id="vx-dot" cx="60" cy="60" r="2.6" fill="#fff" stroke="none"/>
      </svg>`;
    const info = document.createElement('div');
    info.id = 'vx-info';
    info.innerHTML = '<div class="gas">—</div><div id="vx-bar"><i></i></div><div class="pos"></div>';
    const dbg = document.createElement('div');
    dbg.id = 'vx-dbg';
    document.body.append(root, info, dbg);
    addEventListener('keydown', (e) => { if (e.key === 'd' || e.key === 'D') document.body.classList.toggle('vxdbg'); });
    const dot = root.querySelector('#vx-dot');
    const gasEl = info.querySelector('.gas'), posEl = info.querySelector('.pos');
    const barEl = info.querySelector('#vx-bar i');

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2(0, 0);
    const px = document.createElement('canvas');
    px.width = px.height = ZONE;
    const ctx = px.getContext('2d', { willReadFrequently: true });
    const state = (window.visora = window.visora || {});
    let last = 0, cand = -1, candN = 0, gas = 0, lastSwitch = 0, smooth = 0, warned = false;

    // Lee la zona y devuelve { gas, intensity, mix, rgb } o null si no se puede leer
    function sampleZone(u, v) {
        const map = getMap();
        const img = map && map.image;
        if (!img || !img.width) return null;
        const W = img.width, H = img.height, h = ZONE >> 1;
        const sx = Math.min(Math.max(Math.round(u * W) - h, 0), W - ZONE);
        const sy = Math.min(Math.max(Math.round((1 - v) * H) - h, 0), H - ZONE);
        let d;
        try {
            ctx.clearRect(0, 0, ZONE, ZONE);
            ctx.drawImage(img, sx, sy, ZONE, ZONE, 0, 0, ZONE, ZONE);   // 1:1, sin promediar
            d = ctx.getImageData(0, 0, ZONE, ZONE).data;
        } catch {
            if (!warned) { warned = true; console.warn('Visora: el mapa es de otro origen, no se puede leer su color.'); }
            return null;       // imagen de otro origen
        }
        const w = [0, 0, 0, 0, 0];
        let n = 0, valid = 0, sr = 0, sg = 0, sb = 0, sn = 0;
        let hx = 0, hy = 0, hw = 0;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
            const val = mx / 255, sat = mx === 0 ? 0 : c / mx;
            n++;
            if (val < 0.10) continue;                 // negro: sin dato
            valid++;
            if (sat < 0.06) { w[0] += 0.35 * val; continue; }   // gris: aire limpio
            let hue;
            if (mx === r) hue = ((g - b) / c % 6 + 6) % 6;
            else if (mx === g) hue = (b - r) / c + 2;
            else hue = (r - g) / c + 4;
            hue *= 60;
            let best = null, bestD = 1e9;
            for (const t of TINTED) {
                let dd = Math.abs(hue - t.hue);
                if (dd > 180) dd = 360 - dd;
                if (dd < bestD) { bestD = dd; best = t; }
            }
            if (bestD > MAX_HUE_DIST) { w[0] += 0.2 * val; continue; }
            const weight = sat * val * (1 - bestD / (MAX_HUE_DIST * 1.6));
            w[best.id] += weight;
            const rad = hue * Math.PI / 180, pw = sat * val;
            hx += Math.cos(rad) * pw; hy += Math.sin(rad) * pw; hw += pw;
            sr += r; sg += g; sb += b; sn++;
        }
        // normaliza contra los píxeles con dato y contra el color de leyenda de cada gas
        const base = Math.max(valid, n * 0.15, 1);
        const score = w.map((x, i) => x / base / GASES[i].ref);
        let win = 0;
        for (let i = 1; i < score.length; i++) if (score[i] > score[win]) win = i;
        const rgb = sn ? [Math.round(sr / sn), Math.round(sg / sn), Math.round(sb / sn)] : null;
        const hue = hw ? ((Math.atan2(hy, hx) * 180 / Math.PI) + 360) % 360 : null;
        const info = { mix: score, rgb, hue, valid: valid / n, n };
        if (win === 0 || score[win] < 0.04) return { gas: 0, intensity: 0, ...info };
        return { gas: win, intensity: Math.min(1, score[win] / 0.5), ...info };
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
            dispatchEvent(new CustomEvent('visora:crosshair', { detail: null }));
            return;
        }
        info.style.opacity = '1';
        const { x: u, y: v } = hit.uv;
        const lat = (v - 0.5) * 180;
        let lon = (u - 0.5) * 360;
        if (lon > 180) lon -= 360;
        if (lon < -180) lon += 360;

        const z = sampleZone(u, v);
        // histéresis: el gas no cambia por un parpadeo
        if (z) {
            if (z.gas === gas) { candN = 0; }
            else if (z.gas === cand) { candN++; }
            else { cand = z.gas; candN = 1; }
            if (candN >= HOLD_FRAMES && now - lastSwitch > HOLD_MS) {
                gas = cand; candN = 0; lastSwitch = now;
            }
            const target = z.gas === gas ? z.intensity : 0;
            smooth += (target - smooth) * 0.25;
        } else {
            smooth *= 0.9;
        }

        const G = GASES[gas];
        const detail = { lat, lon, u, v, t: now, gas, gasName: G.name, intensity: smooth, mix: z ? z.mix : null };
        if (z && z.rgb) {
            const [r, g, b] = z.rgb;
            const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
            Object.assign(detail, { r, g, b, hex });
        }
        // el cursor sigue blanco; solo el punto central toma el color del gas
        dot.setAttribute('fill', gas && smooth > 0.05 ? G.hex : '#fff');
        gasEl.textContent = gas && smooth > 0.05 ? G.name : 'Aire limpio';
        barEl.style.width = Math.round(smooth * 100) + '%';
        posEl.textContent = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'O'}`;

        if (document.body.classList.contains('vxdbg')) {
            const m = z && z.mix ? z.mix.map((x) => x.toFixed(2)) : [];
            dbg.textContent =
                `gas       ${G.name}  intensidad ${smooth.toFixed(2)}\n` +
                `color     ${detail.hex || '—'}   tono ${z && z.hue !== null && z.hue !== undefined ? z.hue.toFixed(0) + '°' : '—'}\n` +
                `con dato  ${z ? Math.round(z.valid * 100) + '% de ' + z.n + ' px' : 'no se puede leer el mapa'}\n` +
                `puntajes  limpio ${m[0] || '-'}  carbon ${m[1] || '-'}  dust ${m[2] || '-'}  salt ${m[3] || '-'}  sulf ${m[4] || '-'}\n` +
                `musica    ${window.visora && window.visora.music ? (window.visora.music.running ? 'ON nivel ' + window.visora.music.level.toFixed(2) : 'APAGADA') : 'no cargo musica.js'}`;
        }
        state.crosshair = detail;
        dispatchEvent(new CustomEvent('visora:crosshair', { detail }));
    };
}