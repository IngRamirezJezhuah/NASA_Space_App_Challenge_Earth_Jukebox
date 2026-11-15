"""
auralis_visuals.py — Visuales reactivos para proyector (AURALIS LAB).

Pensado para sala oscura: fondo negro, todo sale del sensor de PROFUNDIDAD
(infrarrojo), que funciona sin luz. La cámara RGB no se usa.

    py auralis_visuals.py                      # abre DOS ventanas: visuales + control
    py auralis_visuals.py --fullscreen         # visuales en pantalla completa desde el inicio
    py auralis_visuals.py --solo               # solo visuales, sin ventana de control
    py auralis_visuals.py --image aerosoles.png   # explorar el mapa de aerosoles GEOS
    py auralis_visuals.py --image aerosoles.png --hotspots   # + puntos de interés
    py auralis_visuals.py --replay sesion.jsonl            # sin Kinect
    py auralis_visuals.py --no-web             # sin puente para Earth Jukebox

Earth Jukebox (navegador): mientras este programa corre, abre earth-jukebox/index.html
con doble clic. La página se conecta sola: recibe las manos y la vista del sensor.

Teclas:  Q salir · F pantalla completa (visuales) · M cambiar estilo del cuerpo
         V visuales de Python on/off mientras Earth Jukebox está conectado

Uso desde otro programa:
    vis = Visuals()
    frame = vis.render(tracker)      # imagen BGR lista para mostrar/proyectar
"""
from __future__ import annotations

import json
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

from auralis_kinect import (BONES, DEPTH_C, DEPTH_F, J, Recorder,
                            ReplaySource, Tracker, draw_debug, open_kinect)

# Colores BGR: (mano izquierda, mano derecha) por jugador
HAND_COLORS = [((255, 120, 40), (60, 220, 255)),     # P0: azul / ámbar
               ((200, 60, 255), (120, 255, 120))]    # P1: magenta / verde
AURA_COLOR = np.array([255, 170, 60], np.float32)    # halo alrededor del cuerpo
STYLES = ["explora", "imagen", "relieve", "neon"]

# Tipos de aerosol de GEOS, leídos por el COLOR del mapa bajo cada mano.
# id: (nombre, color BGR de las partículas)
AEROSOLS = {
    0: ("Aire limpio", (150, 150, 150)),
    1: ("Sal marina", (255, 200, 120)),
    2: ("Polvo", (230, 110, 255)),
    3: ("Humo", (40, 120, 255)),
    4: ("Sulfatos", (90, 255, 90)),
}

# Puntos de interés del 19-ago-2025 (lat, lon aproximados). Solo con --hotspots y
# solo si la imagen es el mapa mundial completo, sin bordes.
HOTSPOTS = [
    ("Huracan Erin", 27.0, -72.0),
    ("Polvo del Sahara", 18.0, -35.0),
    ("Quemas en el sur de Africa", -10.0, 22.0),
    ("Incendios en Espana", 42.0, -6.0),
    ("Volcan Kilauea", 19.4, -155.3),
    ("Volcan Etna", 37.7, 15.0),
]


def classify_aerosol(bgr):
    """Color medio (B,G,R) → (id de aerosol, intensidad 0..1)."""
    px = np.uint8([[np.clip(bgr, 0, 255)]])
    h, s, v = (int(x) for x in cv2.cvtColor(px, cv2.COLOR_BGR2HSV)[0, 0])
    if v < 45 or s < 28:
        return 0, 0.0
    if h < 23 or h >= 170:
        kind = 3            # rojo / naranja → humo
    elif 35 <= h < 85:
        kind = 4            # verde → sulfatos
    elif 85 <= h < 128:
        kind = 1            # azul → sal marina
    elif 128 <= h < 170:
        kind = 2            # magenta / rosa → polvo
    else:
        return 0, 0.0
    return kind, min(1.0, v / 230.0)


class Visuals:
    """Lienzo 16:9. La vista del sensor (4:3) queda centrada, a toda la altura."""

    def __init__(self, size=(854, 480), max_particles=9000, image=None, hotspots=False):
        self.w, self.h = size
        self.s = self.h / 240.0                       # escala sensor → lienzo
        self.sw = int(round(320 * self.s))            # ancho que ocupa el sensor
        self.ox = (self.w - self.sw) // 2
        self.trail = np.zeros((self.h, self.w, 3), np.uint8)   # capa con persistencia
        self.n = max_particles
        self.p_pos = np.zeros((self.n, 2), np.float32)
        self.p_vel = np.zeros((self.n, 2), np.float32)
        self.p_life = np.zeros(self.n, np.float32)
        self.p_col = np.zeros((self.n, 3), np.float32)
        self.p_kind = np.zeros(self.n, np.int8)
        self._next = 0
        self._hands = {}           # (slot, lado) → memoria de cada mano
        self.hand_info = {}        # (slot, lado) → {"aerosol", "intensity"}  ← para el SONIDO
        self.ripples = []          # [x, y, t0, color]
        self.style = "explora" if image is not None else "relieve"
        self.image = None
        self.hotspots = hotspots
        if image is not None:
            self.set_image(image)
        self._t = time.perf_counter()
        self._rng = np.random.default_rng()
        # Estrellas de fondo para los modos sin imagen
        self._stars = np.column_stack([self._rng.integers(0, self.w, 260),
                                       self._rng.integers(0, self.h, 260)])
        self._star_phase = self._rng.uniform(0, 6.28, 260)

    def set_image(self, img):
        """Mapa a explorar (GEOS aerosoles, temperatura, lluvia...)."""
        self.image = cv2.resize(img, (self.w, self.h), interpolation=cv2.INTER_AREA)
        self._image_blur = cv2.GaussianBlur(self.image, (0, 0), 4)   # para leer el color

    def styles(self):
        return [s for s in STYLES if self.image is not None or s in ("relieve", "neon")]

    # ---------- utilidades ----------
    def _px(self, p):
        z = max(float(p[2]), 0.1)
        return ((DEPTH_C[0] + p[0] * DEPTH_F / z) * self.s + self.ox,
                (DEPTH_C[1] - p[1] * DEPTH_F / z) * self.s)

    def _to_canvas(self, small, interp=cv2.INTER_LINEAR):
        """Imagen del sensor (240x320, 1 canal) → lienzo completo, centrada."""
        full = np.zeros((self.h, self.w), small.dtype)
        full[:, self.ox:self.ox + self.sw] = cv2.resize(small, (self.sw, self.h),
                                                        interpolation=interp)
        return full

    def _mask_from_skeleton(self, bodies):
        """Sin flujo de profundidad (o en replay): silueta aproximada con los huesos."""
        m = np.zeros((self.h, self.w), np.uint8)
        for b in bodies:
            thick = int(max(8, 70 / max(b.distance, 0.8)))
            pts = [tuple(int(v) for v in self._px(p)) for p in b.joints]
            for a, c in BONES:
                if b.state[J[a]] and b.state[J[c]]:
                    cv2.line(m, pts[J[a]], pts[J[c]], 255, thick)
            cv2.circle(m, pts[J["Head"]], thick, 255, -1)
            torso = np.array([pts[J[k]] for k in ("ShoulderLeft", "ShoulderRight",
                                                  "HipRight", "HipLeft")], np.int32)
            cv2.fillConvexPoly(m, torso, 255)
        return m

    def _emit(self, xy, vel, color, count, kind=0, spread=3.0, kick=1.6):
        idx = (self._next + np.arange(count)) % self.n
        self._next = (self._next + count) % self.n
        self.p_pos[idx] = np.asarray(xy, np.float32) + self._rng.normal(0, spread, (count, 2))
        self.p_vel[idx] = np.asarray(vel, np.float32) * 0.35 + self._rng.normal(0, kick, (count, 2))
        self.p_life[idx] = self._rng.uniform(0.5, 1.0, count)
        self.p_col[idx] = np.asarray(color, np.float32) * self._rng.uniform(0.6, 1.0, (count, 1))
        self.p_kind[idx] = kind
        return idx

    def _read_map(self, xy):
        x = int(np.clip(xy[0], 0, self.w - 1))
        y = int(np.clip(xy[1], 0, self.h - 1))
        return classify_aerosol(self._image_blur[y, x])

    # ---------- render ----------
    def render(self, tracker):
        now = time.perf_counter()
        dt = min(0.1, now - self._t)
        self._t = now
        k30 = dt * 30.0
        bodies = tracker.bodies
        explore = self.style == "explora" and self.image is not None

        # 1. Silueta suavizada
        raw_mask = tracker.mask
        if raw_mask is not None:
            mask = self._to_canvas((raw_mask > 0).astype(np.uint8) * 255)
            mask = cv2.threshold(cv2.GaussianBlur(mask, (9, 9), 0), 127, 255,
                                 cv2.THRESH_BINARY)[1]
        else:
            mask = self._mask_from_skeleton(bodies)
        energy = max([b.energy for b in bodies], default=0.0)

        # 2. Manos: posición, lectura del mapa, cinta y partículas
        live = set()
        aura_cols = []
        for b in bodies:
            cols = HAND_COLORS[b.slot % 2]
            for key, hand, base_col in (("left", b.left, cols[0]), ("right", b.right, cols[1])):
                if not hand.tracked:
                    continue
                hid = (b.slot, key)
                live.add(hid)
                xy = np.array(self._px(hand.pos), np.float32)
                st = self._hands.setdefault(hid, {"prev": xy, "ribbon": deque(maxlen=22),
                                                  "kind": 0, "cand": 0, "n": 0, "amount": 0.0})
                kind, col, amount = 0, base_col, 1.0
                if explore:
                    found, level = self._read_map(xy)
                    st["n"] = st["n"] + 1 if found == st["cand"] else 0   # anti-parpadeo
                    st["cand"] = found
                    if st["n"] >= 3:
                        st["kind"] = found
                    st["amount"] += 0.25 * (level - st["amount"])
                    kind, amount = st["kind"], st["amount"]
                    col = AEROSOLS[kind][1]
                    self.hand_info[hid] = {"aerosol": AEROSOLS[kind][0], "intensity": amount}
                st.update(xy=xy, col=col, push=hand.push, show_kind=kind, show_amount=amount)
                st["ribbon"].append(xy.copy())
                aura_cols.append(col)
                count = int((3 + min(hand.speed, 3.0) * 30) * (0.25 + amount if explore else 1.0))
                self._emit(xy, xy - st["prev"], col, count, kind)
                st["prev"] = xy
        for hid in [h for h in self._hands if h not in live]:
            del self._hands[hid]
            self.hand_info.pop(hid, None)

        # 3. Fondo y cuerpo
        if explore:
            out = self._explore_base(mask)
        else:
            out = np.zeros((self.h, self.w, 3), np.uint8)
            tw = (40 + 50 * (1 + np.sin(now * 1.5 + self._star_phase))).astype(np.uint8)
            out[self._stars[:, 1], self._stars[:, 0]] = tw[:, None]
            out[mask > 0] = 0
            if self.style == "imagen" and self.image is not None:
                out = cv2.bitwise_and(self.image, self.image, mask=mask)
            elif self.style == "relieve":
                out = cv2.add(out, self._relief(tracker, raw_mask, mask))

        # 4. Halo: toma el color de lo que tocan las manos
        aura_col = np.mean(aura_cols, axis=0).astype(np.float32) if (explore and aura_cols) \
            else AURA_COLOR
        small = cv2.resize(mask, (self.w // 4, self.h // 4), interpolation=cv2.INTER_AREA)
        glow = cv2.resize(cv2.GaussianBlur(small, (0, 0), 4.5), (self.w, self.h),
                          interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
        glow[mask > 0] *= 0.25
        aura = (glow[:, :, None] * aura_col * (0.45 + 0.9 * energy)).clip(0, 255).astype(np.uint8)
        out = cv2.add(out, aura)

        # 5. Capa persistente: contorno + partículas dejan estela
        self.trail = cv2.subtract(cv2.convertScaleAbs(self.trail, alpha=0.90), (3, 3, 3, 0))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        contours = [c for c in contours if cv2.contourArea(c) > 1500]
        edge = tuple(int(v) for v in (0.5 * aura_col + 0.5 * np.array([255, 240, 220])))
        cv2.drawContours(self.trail, contours, -1, edge, 1 + int(energy * 3), cv2.LINE_AA)

        for st in self._hands.values():
            c = (int(st["xy"][0]), int(st["xy"][1]))
            cv2.circle(self.trail, c, int(6 + 26 * st["push"]), st["col"], 2, cv2.LINE_AA)
        for b in bodies:
            # Línea de energía entre las manos (brilla al juntarlas)
            if b.left.tracked and b.right.tracked:
                a = tuple(int(v) for v in self._px(b.left.pos))
                c = tuple(int(v) for v in self._px(b.right.pos))
                g = int(60 + 195 * (1.0 - b.hands_apart))
                cv2.line(self.trail, a, c, (g, g, g), 1, cv2.LINE_AA)

        # 6. Ondas y estallidos al ocurrir un gesto
        for name, slot in tracker.events:
            b = next((x for x in bodies if x.slot == slot), None)
            if b is None:
                continue
            if name == "clap":
                mid = self._px((b.left.pos + b.right.pos) / 2)
                st = self._hands.get((slot, "right")) or self._hands.get((slot, "left"))
                col = st["col"] if st else (255, 255, 255)
                self.ripples.append([*mid, now, (255, 255, 255)])
                self._emit(mid, (0, 0), col, 500, st["show_kind"] if st else 0, kick=9.0)
            elif name in ("push_left", "push_right"):
                key = name.split("_")[1]
                st = self._hands.get((slot, key))
                if st:
                    self.ripples.append([*st["xy"], now, st["col"]])
                    self._emit(st["xy"], (0, 0), st["col"], 180, st["show_kind"], kick=5.0)
            elif name in ("enter", "hands_up"):
                self.ripples.append([*self._px(b.joint("Spine")), now, (255, 200, 120)])

        self._update_particles(dt, k30, now)

        out = cv2.add(out, self.trail)
        bloom = cv2.GaussianBlur(cv2.resize(self.trail, (self.w // 4, self.h // 4),
                                            interpolation=cv2.INTER_AREA), (0, 0), 1.5)
        out = cv2.add(out, cv2.resize(bloom, (self.w, self.h), interpolation=cv2.INTER_LINEAR))

        # 7. Cintas de luz que siguen a las manos
        for st in self._hands.values():
            pts = list(st["ribbon"])
            for i in range(1, len(pts)):
                f = i / len(pts)
                cv2.line(out, (int(pts[i - 1][0]), int(pts[i - 1][1])),
                         (int(pts[i][0]), int(pts[i][1])),
                         tuple(int(v * f) for v in st["col"]), 1 + int(5 * f), cv2.LINE_AA)
            cv2.circle(out, (int(st["xy"][0]), int(st["xy"][1])), 4, (255, 255, 255), -1,
                       cv2.LINE_AA)

        keep = []
        for x, y, t0, col in self.ripples:
            age = now - t0
            if age < 1.2:
                f = 1.0 - age / 1.2
                cv2.circle(out, (int(x), int(y)), int(20 + 320 * age),
                           tuple(int(v * f) for v in col), 1 + int(2 * f), cv2.LINE_AA)
                keep.append([x, y, t0, col])
        self.ripples = keep

        if explore:
            self._explore_overlay(out, now)
        if not bodies:   # estado de espera: invita a acercarse
            pulse = 0.5 + 0.5 * np.sin(now * 2.0)
            cv2.circle(out, (self.w // 2, self.h // 2), int(40 + 14 * pulse),
                       tuple(int(v * (0.3 + 0.5 * pulse)) for v in (255, 170, 60)), 2, cv2.LINE_AA)
        return out

    def _update_particles(self, dt, k30, now):
        alive = np.flatnonzero(self.p_life > 0)
        if alive.size == 0:
            return
        pos, vel, kind = self.p_pos[alive], self.p_vel[alive], self.p_kind[alive]
        # Campo de flujo: corrientes suaves que cambian con el tiempo (como viento)
        ang = (np.sin(pos[:, 0] * 0.013 + now * 0.6) + np.cos(pos[:, 1] * 0.017 - now * 0.4)) * 2.0
        flow = np.column_stack([np.cos(ang), np.sin(ang)]).astype(np.float32)
        vel *= 0.95 ** k30
        vel += flow * (0.10 * k30)
        m = kind == 0
        vel[m, 1] -= 0.20 * k30                 # neutras: flotan
        m = kind == 1                           # sal marina: giran en espiral
        if m.any():
            c, s = np.cos(0.16 * k30), np.sin(0.16 * k30)
            vx, vy = vel[m, 0].copy(), vel[m, 1].copy()
            vel[m, 0], vel[m, 1] = c * vx - s * vy, s * vx + c * vy
        vel[kind == 2, 0] -= 0.28 * k30         # polvo: arrastrado hacia el oeste
        vel[kind == 3, 1] -= 0.30 * k30         # humo: asciende
        m = kind == 4                           # sulfatos: siguen el viento en hilos
        vel[m] += flow[m] * (0.35 * k30)
        pos += vel * k30
        self.p_pos[alive], self.p_vel[alive] = pos, vel
        self.p_life[alive] -= dt * 0.6
        x, y = pos[:, 0].astype(np.int32), pos[:, 1].astype(np.int32)
        ok = (x >= 0) & (x < self.w - 1) & (y >= 0) & (y < self.h - 1)
        x, y = x[ok], y[ok]
        col = (self.p_col[alive][ok] * np.clip(self.p_life[alive][ok], 0, 1)[:, None]
               ).astype(np.uint8)
        for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            self.trail[y + dy, x + dx] = np.maximum(self.trail[y + dy, x + dx], col)

    def _explore_base(self, mask):
        """Mapa tenue de fondo; se ilumina dentro del cuerpo y alrededor de las manos."""
        q = 4
        light = cv2.resize(mask, (self.w // q, self.h // q), interpolation=cv2.INTER_AREA)
        light = (light * 0.55).astype(np.uint8)
        for st in self._hands.values():
            c = (int(st["xy"][0] / q), int(st["xy"][1] / q))
            cv2.circle(light, c, int((55 + 75 * st["push"]) / q), 255, -1)
        light = cv2.GaussianBlur(light, (0, 0), 5)
        light = cv2.resize(light, (self.w, self.h), interpolation=cv2.INTER_LINEAR)
        gain = cv2.add(cv2.convertScaleAbs(light, alpha=0.82), 46)      # 18 % .. 100 %
        return cv2.multiply(self.image, cv2.merge([gain, gain, gain]), scale=1 / 255.0)

    def _explore_overlay(self, out, now):
        font = cv2.FONT_HERSHEY_SIMPLEX
        active = set()
        for st in self._hands.values():
            kind = st["show_kind"]
            if kind:
                active.add(kind)
            x, y = int(st["xy"][0]) + 18, int(st["xy"][1]) - 14
            name, col = AEROSOLS[kind]
            cv2.putText(out, name, (x, y), font, 0.5, col, 1, cv2.LINE_AA)
            cv2.rectangle(out, (x, y + 5), (x + 60, y + 9), (70, 70, 70), -1)
            cv2.rectangle(out, (x, y + 5), (x + int(60 * st["show_amount"]), y + 9), col, -1)
        # Leyenda: se enciende el tipo que alguna mano está tocando
        for i, kind in enumerate((1, 2, 3, 4)):
            name, col = AEROSOLS[kind]
            on = kind in active
            y = self.h - 78 + i * 18
            shade = col if on else tuple(int(v * 0.4) for v in col)
            cv2.circle(out, (18, y - 4), 6 if on else 4, shade, -1, cv2.LINE_AA)
            cv2.putText(out, name, (32, y), font, 0.45, shade, 1, cv2.LINE_AA)
        if self.hotspots:
            for label, lat, lon in HOTSPOTS:
                hx, hy = int((lon + 180) / 360 * self.w), int((90 - lat) / 180 * self.h)
                near = any(np.hypot(st["xy"][0] - hx, st["xy"][1] - hy) < 60
                           for st in self._hands.values())
                r = int(5 + 3 * np.sin(now * 3 + hx))
                cv2.circle(out, (hx, hy), r + (4 if near else 0), (255, 255, 255),
                           2 if near else 1, cv2.LINE_AA)
                if near:
                    cv2.putText(out, label, (hx + 14, hy + 5), font, 0.55, (255, 255, 255), 1,
                                cv2.LINE_AA)

    def _relief(self, tracker, raw_mask, mask):
        """El cuerpo como paisaje: color por profundidad + curvas de nivel."""
        depth = tracker.depth
        if depth is None or raw_mask is None:
            ramp = np.linspace(200, 60, self.h, dtype=np.uint8)[:, None].repeat(self.w, 1)
            col = cv2.applyColorMap(ramp, cv2.COLORMAP_OCEAN)
            return cv2.bitwise_and(col, col, mask=mask) // 2
        body = (raw_mask > 0) & (depth > 0)
        if body.sum() < 80:
            return np.zeros((self.h, self.w, 3), np.uint8)
        lo, hi = np.percentile(depth[body], [2, 98])
        near = np.clip((hi - depth.astype(np.float32)) / max(hi - lo, 60.0), 0, 1)
        near = cv2.GaussianBlur(self._to_canvas(near), (7, 7), 0)
        col = cv2.applyColorMap((40 + near * 215).astype(np.uint8), cv2.COLORMAP_INFERNO)
        lines = ((near * 10.0) % 1.0) < 0.10                       # curvas de nivel
        col = (col * 0.55).astype(np.uint8)
        col[lines] = cv2.add(col[lines], np.full_like(col[lines], 90))
        return cv2.bitwise_and(col, col, mask=mask)


# ---------------------------------------------------------------------------
# Puente para Earth Jukebox (navegador)
#   /events        manos de cada cuerpo, ~30 veces por segundo (Server-Sent Events)
#   /preview.mjpg  vista del sensor de profundidad con el esqueleto (para comprobar
#                  que toma las manos). Solo se genera si alguien la está viendo.
#   /compare.json, /compare/<carpeta>/<archivo>  pares de imágenes de recursos/compare (SONORA)
#   /sonidos.json, /sonidos/<archivo>             loops de naturaleza de recursos/sonidos (SONORA)
#   /space/<archivo>  imágenes de recursos/space (así la página, abierta con doble
#                  clic, puede leer sus píxeles; el navegador bloquea leerlas directo)
# Coordenadas de las manos normalizadas 0..1 en la imagen del sensor (320x240),
# las mismas que usa la vista previa, así los puntos caen sobre el esqueleto.
# ---------------------------------------------------------------------------
WEB_PORT = 8765
SPACE_DIR = Path(__file__).resolve().parent.parent / "recursos" / "space"
COMPARE_DIR = Path(__file__).resolve().parent.parent / "recursos" / "compare"   # pares para SONORA
SOUNDS_DIR = Path(__file__).resolve().parent.parent / "recursos" / "sonidos"    # loops extra para SONORA
AUDIO_TYPES = {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4"}
IMG_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def _sensor_uv(p):
    """Punto 3D (m) → (u, v) normalizado 0..1 en la imagen del sensor."""
    z = max(float(p[2]), 0.1)
    return ((DEPTH_C[0] + p[0] * DEPTH_F / z) / 320.0,
            (DEPTH_C[1] - p[1] * DEPTH_F / z) / 240.0)


class WebBridge:
    def __init__(self, port=WEB_PORT):
        self.cond = threading.Condition()
        self.msg, self.seq = b'{"primary":null,"bodies":[]}', 0
        self.jpg, self.jseq, self.viewers = None, 0, 0
        self.clients = 0          # páginas de Earth Jukebox conectadas a /events
        self.claps = {}
        self._last_jpg = 0.0
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _head(self, ctype):
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Access-Control-Allow-Origin", "*")   # página abierta con doble clic
                self.end_headers()

            def _serve_json(self, obj):
                data = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)

            def _serve_file(self, folder, name, types):
                from urllib.parse import unquote
                f = folder / Path(unquote(name)).name             # solo el nombre: nada fuera de la carpeta
                ctype = types.get(f.suffix.lower())
                if not ctype or not f.is_file():
                    self.send_error(404)
                    return
                data = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "max-age=3600")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                path = self.path.split("?")[0]
                try:
                    if path == "/events":
                        self._head("text/event-stream")
                        bridge._serve_events(self.wfile)
                    elif path == "/preview.mjpg":
                        self._head("multipart/x-mixed-replace; boundary=frame")
                        bridge._serve_mjpg(self.wfile)
                    elif path.startswith("/space/"):
                        self._serve_file(SPACE_DIR, path[len("/space/"):], IMG_TYPES)
                    elif path == "/compare.json":
                        self._serve_json(bridge.compare_list())
                    elif path.startswith("/compare/"):
                        sub = path[len("/compare/"):].split("/")
                        if len(sub) == 2:
                            self._serve_file(COMPARE_DIR / Path(sub[0]).name, sub[1], IMG_TYPES)
                        else:
                            self.send_error(404)
                    elif path == "/sonidos.json":
                        files = sorted(f.name for f in SOUNDS_DIR.glob("*") if f.suffix.lower() in AUDIO_TYPES) \
                            if SOUNDS_DIR.is_dir() else []
                        self._serve_json(files)
                    elif path.startswith("/sonidos/"):
                        self._serve_file(SOUNDS_DIR, path[len("/sonidos/"):], AUDIO_TYPES)
                    else:
                        self.send_error(404)
                except OSError:      # el navegador cerró la conexión
                    pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()

    @staticmethod
    def compare_list():
        """Carpetas de recursos/compare con 2 imágenes: [{folder, files:[izquierda, derecha]}].
        Se ordenan por nombre (la fecha va en el nombre): la primera = izquierda (más vegetación)."""
        out = []
        if COMPARE_DIR.is_dir():
            for d in sorted(p for p in COMPARE_DIR.iterdir() if p.is_dir()):
                imgs = sorted(f.name for f in d.iterdir() if f.suffix.lower() in IMG_TYPES)
                if len(imgs) >= 2:
                    out.append({"folder": d.name, "files": imgs[:2]})
        return out

    # ---- hilos del servidor ----
    def _serve_events(self, out):
        with self.cond:
            self.clients += 1
        try:
            seen = -1
            while True:
                with self.cond:
                    self.cond.wait_for(lambda: self.seq != seen, timeout=1.0)
                    fresh, seen, msg = self.seq != seen, self.seq, self.msg
                out.write(b"data: " + msg + b"\n\n" if fresh else b": ping\n\n")
                out.flush()
        finally:
            with self.cond:
                self.clients -= 1

    def _serve_mjpg(self, out):
        with self.cond:
            self.viewers += 1
        try:
            seen = -1
            while True:
                with self.cond:
                    self.cond.wait_for(lambda: self.jseq != seen and self.jpg is not None, timeout=1.0)
                    if self.jseq == seen or self.jpg is None:
                        continue
                    seen, jpg = self.jseq, self.jpg
                out.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                          + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                out.flush()
        finally:
            with self.cond:
                self.viewers -= 1

    # ---- hilo principal: llamar en cada vuelta del bucle ----
    def publish(self, tracker, bodies):
        for name, slot in tracker.events:
            if name == "clap":
                self.claps[slot] = self.claps.get(slot, 0) + 1
        out = []
        for b in bodies:
            spine = b.joint("Spine")
            spine_y = float(spine[1])
            sw = max(0.15, abs(float(b.joint("ShoulderRight")[0]) - float(b.joint("ShoulderLeft")[0])))
            hands = {}
            for key, hand in (("L", b.left), ("R", b.right)):
                if not hand.tracked:
                    continue
                u, v = _sensor_uv(hand.pos)
                # x, y en "anchos de hombro" respecto al torso (y hacia abajo): lo usa Visora (kinect_bridge.js)
                hx = (float(hand.pos[0]) - float(spine[0])) / sw
                hy = -(float(hand.pos[1]) - float(spine[1])) / sw
                hands[key] = {"sx": round(u, 4), "sy": round(v, 4), "x": round(hx, 4), "y": round(hy, 4), "vis": True,
                              "on": bool(float(hand.pos[1]) > spine_y),   # levantada = encima del torso
                              "held": False}
            cx, cy = _sensor_uv(b.joint("Spine"))       # torso: lo usa SONORA como barredor
            out.append({"id": b.slot + 1, "z": round(float(b.distance), 1),
                        "cx": round(cx, 4), "cy": round(cy, 4),
                        "clap": self.claps.get(b.slot, 0), "hands": hands})
        nearest = min(bodies, key=lambda x: x.distance, default=None)
        msg = json.dumps({"primary": nearest.slot + 1 if nearest else None,
                          "bodies": out}).encode()
        jpg = None
        now = time.perf_counter()
        if self.viewers and tracker.new_frame and now - self._last_jpg > 1 / 15:
            self._last_jpg = now
            jpg = self._preview(tracker, bodies)
        with self.cond:
            if msg != self.msg:
                self.msg, self.seq = msg, self.seq + 1
            if jpg is not None:
                self.jpg, self.jseq = jpg, self.jseq + 1
            self.cond.notify_all()

    def _preview(self, tracker, bodies):
        """Profundidad en gris + silueta + esqueleto, en el mismo encuadre que las manos."""
        depth = tracker.depth
        img = np.zeros((240, 320, 3), np.uint8)
        if depth is not None and depth.shape[:2] == (240, 320):
            d = depth.astype(np.float32)
            valid = d > 0
            if valid.sum() > 50:
                lo, hi = np.percentile(d[valid], [2, 98])
                near = np.clip((hi - d) / max(hi - lo, 1.0), 0, 1)
                g = np.where(valid, 30 + near * 170, 0).astype(np.uint8)
                img = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
        mask = tracker.mask
        if mask is not None and mask.shape[:2] == (240, 320):
            m = mask > 0
            img[m] = (img[m] * 0.6 + np.array([90, 50, 10])).clip(0, 255).astype(np.uint8)
        img = cv2.resize(img, (640, 480), interpolation=cv2.INTER_NEAREST)
        for b in bodies:
            pts = [tuple(int(v * s) for v, s in zip(_sensor_uv(p), (640, 480))) for p in b.joints]
            for a, c in BONES:
                if b.state[J[a]] and b.state[J[c]]:
                    cv2.line(img, pts[J[a]], pts[J[c]], (200, 200, 200), 2, cv2.LINE_AA)
            cv2.putText(img, f"P{b.slot + 1}  {b.distance:.1f} m", pts[J["Head"]],
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return buf.tobytes() if ok else None


def letterbox(frame, win):
    """Añade barras negras para que la imagen no se deforme al estirar la ventana."""
    try:
        _, _, ww, wh = cv2.getWindowImageRect(win)
    except cv2.error:
        return frame
    h, w = frame.shape[:2]
    if ww <= 0 or wh <= 0:
        return frame
    target = ww / wh
    if target > w / h:      # ventana más ancha: barras a los lados
        pad = int((h * target - w) / 2)
        return cv2.copyMakeBorder(frame, 0, 0, pad, pad, cv2.BORDER_CONSTANT)
    pad = int((w / target - h) / 2)
    return cv2.copyMakeBorder(frame, pad, pad, 0, 0, cv2.BORDER_CONSTANT)


def main():
    import argparse

    ap = argparse.ArgumentParser(description="AURALIS LAB - visuales")
    ap.add_argument("--replay", help="grabación .jsonl (sin Kinect)")
    ap.add_argument("--record", help="grabar sesión a .jsonl")
    ap.add_argument("--image", help="mapa a explorar (p. ej. GEOS aerosoles)")
    ap.add_argument("--hotspots", action="store_true",
                    help="marcar Erin, Sahara, Etna... (requiere el mapa mundial completo)")
    ap.add_argument("--fullscreen", action="store_true", help="visuales en pantalla completa")
    ap.add_argument("--window", action="store_true",
                    help="(ya es el modo por defecto; se acepta por compatibilidad)")
    ap.add_argument("--solo", action="store_true",
                    help="solo visuales: no abrir la ventana de control (cámara + esqueleto)")
    ap.add_argument("--tilt", type=int, help="inclinación del motor, -27..27")
    ap.add_argument("--no-web", action="store_true",
                    help="no mandar manos ni vista del sensor a Earth Jukebox (navegador)")
    ap.add_argument("--web-port", type=int, default=WEB_PORT, help="puerto del puente web")
    ap.add_argument("--no-depth", action="store_true",
                    help="no abrir el flujo de profundidad (silueta aproximada con el esqueleto)")
    args = ap.parse_args()

    if args.replay:
        source = ReplaySource(args.replay)
    else:
        source = open_kinect(color=not args.solo, silhouette=not args.no_depth, tilt=args.tilt)
    tracker = Tracker(source, recorder=Recorder(args.record) if args.record else None)

    image = None
    if args.image:
        image = cv2.imread(args.image)
        if image is None:
            raise SystemExit("No se pudo abrir la imagen: " + args.image)
    vis = Visuals(image=image, hotspots=args.hotspots)

    web = None
    if not args.no_web:
        try:
            web = WebBridge(args.web_port)
            print(f"Earth Jukebox: puente listo en el puerto {args.web_port}. "
                  "Abre earth-jukebox/index.html con doble clic.")
            n = len([f for f in SPACE_DIR.glob("*") if f.suffix.lower() in IMG_TYPES]) if SPACE_DIR.is_dir() else 0
            print(f"Earth Jukebox: {n} imágenes en {SPACE_DIR}")
        except OSError as e:
            print("Earth Jukebox: no se pudo abrir el puerto", args.web_port, "-", e)

    win = "AURALIS LAB"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    full = args.fullscreen
    ctrl = None if args.solo else "AURALIS LAB - Control"
    if ctrl:
        cv2.namedWindow(ctrl, cv2.WINDOW_AUTOSIZE)
        cv2.moveWindow(ctrl, 0, 0)
        cv2.moveWindow(win, 660, 0)
    cv2.resizeWindow(win, 854, 480)
    log, fps, last = [], 30.0, time.perf_counter()
    # Mientras la página está conectada, los visuales de Python (9000 partículas, desenfoques,
    # bloom en cada cuadro) se pausan: le roban CPU al navegador y el audio se trababa.
    # V los vuelve a encender.
    force_vis, paused, idle_frame, last_idle = False, False, None, 0.0
    if full:
        cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
    try:
        while True:
            bodies = tracker.update()
            if web:
                web.publish(tracker, bodies)
            pause = bool(web and web.clients and not force_vis)
            if pause != paused:
                paused = pause
                print("Earth Jukebox conectado: visuales de Python en pausa para dejar CPU al audio "
                      "(V para verlos)." if pause else "Visuales de Python activos.")
            if paused:
                now = time.perf_counter()
                if now - last_idle > 0.5:          # cuadro ligero, 2 veces por segundo
                    last_idle = now
                    if idle_frame is None:
                        idle_frame = np.zeros((480, 854, 3), np.uint8)
                        cv2.putText(idle_frame, "Earth Jukebox conectado", (230, 220),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.9, (200, 200, 200), 2, cv2.LINE_AA)
                        cv2.putText(idle_frame, "visuales en pausa para el audio - V para verlos", (165, 260),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (140, 140, 140), 1, cv2.LINE_AA)
                    cv2.imshow(win, letterbox(idle_frame, win))
            else:
                cv2.imshow(win, letterbox(vis.render(tracker), win))
            if ctrl and tracker.new_frame:
                now = time.perf_counter()
                fps += 0.1 * (1.0 / max(1e-3, now - last) - fps)
                last = now
                log.extend(f"P{slot} {name}" for name, slot in tracker.events)
                del log[:-5]
                cam = tracker.color
                cam = np.zeros((480, 640, 3), np.uint8) if cam is None else cam
                cv2.imshow(ctrl, draw_debug(cam, bodies, log, fps))
            key = cv2.waitKey(15) & 0xFF
            if key == ord("q"):
                break
            if key == ord("f"):
                full = not full
                cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN,
                                      cv2.WINDOW_FULLSCREEN if full else cv2.WINDOW_NORMAL)
            if key == ord("v"):
                force_vis = not force_vis
            if key == ord("m"):
                options = vis.styles()
                vis.style = options[(options.index(vis.style) + 1) % len(options)]
                print("Estilo:", vis.style)
    finally:
        if web:
            web.close()
        tracker.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
