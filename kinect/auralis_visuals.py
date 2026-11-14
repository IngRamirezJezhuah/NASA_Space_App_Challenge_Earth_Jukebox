"""
auralis_visuals.py — Visuales reactivos para proyector (AURALIS LAB).

Pensado para sala oscura: fondo negro, todo sale del sensor de PROFUNDIDAD
(infrarrojo), que funciona sin luz. La cámara RGB no se usa.

    py auralis_visuals.py                      # abre DOS ventanas: visuales + control
    py auralis_visuals.py --fullscreen         # visuales en pantalla completa desde el inicio
    py auralis_visuals.py --solo               # solo visuales, sin ventana de control
    py auralis_visuals.py --image mapa.png     # el cuerpo revela una imagen (p. ej. NASA)
    py auralis_visuals.py --replay sesion.jsonl            # sin Kinect

Teclas:  Q salir · F pantalla completa (visuales) · M cambiar estilo del cuerpo

Uso desde otro programa:
    vis = Visuals()
    frame = vis.render(tracker)      # imagen BGR lista para mostrar/proyectar
"""
from __future__ import annotations

import time

import cv2
import numpy as np

from auralis_kinect import (BONES, DEPTH_C, DEPTH_F, J, KinectSource, Recorder,
                            ReplaySource, Tracker, draw_debug)

# Colores BGR: (mano izquierda, mano derecha) por jugador
HAND_COLORS = [((255, 120, 40), (60, 220, 255)),     # P0: azul / ámbar
               ((200, 60, 255), (120, 255, 120))]    # P1: magenta / verde
AURA_COLOR = np.array([255, 170, 60], np.float32)    # halo alrededor del cuerpo
STYLES = ["relieve", "neon", "imagen"]


class Visuals:
    def __init__(self, size=(640, 480), max_particles=6000, image=None):
        self.w, self.h = size
        self.sx, self.sy = self.w / 320.0, self.h / 240.0
        self.trail = np.zeros((self.h, self.w, 3), np.uint8)   # capa con persistencia
        self.n = max_particles
        self.p_pos = np.zeros((self.n, 2), np.float32)
        self.p_vel = np.zeros((self.n, 2), np.float32)
        self.p_life = np.zeros(self.n, np.float32)
        self.p_col = np.zeros((self.n, 3), np.float32)
        self._next = 0
        self._prev_hand = {}
        self.ripples = []          # [x, y, t0, color]
        self.style = "imagen" if image is not None else "relieve"
        self.image = None
        if image is not None:
            self.set_image(image)
        self._t = time.perf_counter()
        self._rng = np.random.default_rng()

    def set_image(self, img):
        """Imagen que se revela dentro de la silueta (mapa de temperatura, lluvia...)."""
        self.image = cv2.resize(img, (self.w, self.h), interpolation=cv2.INTER_AREA)

    # ---------- utilidades ----------
    def _px(self, p):
        z = max(float(p[2]), 0.1)
        return ((DEPTH_C[0] + p[0] * DEPTH_F / z) * self.sx,
                (DEPTH_C[1] - p[1] * DEPTH_F / z) * self.sy)

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

    def _emit(self, xy, vel, color, count):
        idx = (self._next + np.arange(count)) % self.n
        self._next = (self._next + count) % self.n
        self.p_pos[idx] = np.asarray(xy, np.float32) + self._rng.normal(0, 3, (count, 2))
        self.p_vel[idx] = np.asarray(vel, np.float32) * 0.35 + self._rng.normal(0, 1.6, (count, 2))
        self.p_life[idx] = self._rng.uniform(0.5, 1.0, count)
        self.p_col[idx] = color

    # ---------- render ----------
    def render(self, tracker):
        now = time.perf_counter()
        dt = min(0.1, now - self._t)
        self._t = now
        bodies = tracker.bodies

        # 1. Silueta suavizada
        raw_mask = tracker.mask
        if raw_mask is not None:
            mask = cv2.resize((raw_mask > 0).astype(np.uint8) * 255, (self.w, self.h),
                              interpolation=cv2.INTER_LINEAR)
            mask = cv2.threshold(cv2.GaussianBlur(mask, (9, 9), 0), 127, 255,
                                 cv2.THRESH_BINARY)[1]
        else:
            mask = self._mask_from_skeleton(bodies)
        energy = max([b.energy for b in bodies], default=0.0)

        # 2. Relleno del cuerpo
        out = np.zeros((self.h, self.w, 3), np.uint8)
        if self.style == "imagen" and self.image is not None:
            out = cv2.bitwise_and(self.image, self.image, mask=mask)
        elif self.style == "relieve":
            out = self._relief(tracker, raw_mask, mask)

        # 3. Halo: la silueta difuminada, más intenso cuanto más se mueve la persona
        small = cv2.resize(mask, (self.w // 4, self.h // 4), interpolation=cv2.INTER_AREA)
        glow = cv2.resize(cv2.GaussianBlur(small, (0, 0), 4.5), (self.w, self.h),
                          interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
        glow[mask > 0] *= 0.25
        aura = (glow[:, :, None] * AURA_COLOR * (0.45 + 0.9 * energy)).clip(0, 255).astype(np.uint8)
        out = cv2.add(out, aura)

        # 4. Capa persistente: contorno + partículas dejan estela
        # (la resta evita que queden "fantasmas" tenues que nunca terminan de apagarse)
        self.trail = cv2.subtract(cv2.convertScaleAbs(self.trail, alpha=0.90), (3, 3, 3, 0))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        contours = [c for c in contours if cv2.contourArea(c) > 1500]
        cv2.drawContours(self.trail, contours, -1, (255, 230, 170), 1 + int(energy * 3),
                         cv2.LINE_AA)

        for b in bodies:
            cols = HAND_COLORS[b.slot % 2]
            for key, hand, col in (("left", b.left, cols[0]), ("right", b.right, cols[1])):
                if not hand.tracked:
                    self._prev_hand.pop((b.slot, key), None)
                    continue
                xy = np.array(self._px(hand.pos), np.float32)
                prev = self._prev_hand.get((b.slot, key), xy)
                self._prev_hand[(b.slot, key)] = xy
                self._emit(xy, xy - prev, col, int(3 + min(hand.speed, 3.0) * 30))
                # Orbe en la mano: crece al extender el brazo
                r = int(6 + 26 * hand.push)
                c = (int(xy[0]), int(xy[1]))
                cv2.circle(self.trail, c, r, col, 2, cv2.LINE_AA)
                cv2.circle(out, c, 4, (255, 255, 255), -1, cv2.LINE_AA)

            # Línea de energía entre las manos (tensa al separar, brilla al juntar)
            if b.left.tracked and b.right.tracked:
                a = tuple(int(v) for v in self._px(b.left.pos))
                c = tuple(int(v) for v in self._px(b.right.pos))
                k = 1.0 - b.hands_apart
                cv2.line(self.trail, a, c, tuple(int(60 + 195 * k) for _ in range(3)), 1,
                         cv2.LINE_AA)

        # 5. Ondas al ocurrir un gesto
        for name, slot in tracker.events:
            b = next((x for x in bodies if x.slot == slot), None)
            if b is None:
                continue
            cols = HAND_COLORS[slot % 2]
            if name == "clap":
                mid = (b.left.pos + b.right.pos) / 2
                self.ripples.append([*self._px(mid), now, (255, 255, 255)])
                self._emit(self._px(mid), (0, 0), np.array((255, 255, 255)), 400)
                self.p_vel[(self._next - 400 + np.arange(400)) % self.n] *= 6
            elif name in ("push_left", "push_right"):
                hand, col = (b.left, cols[0]) if name == "push_left" else (b.right, cols[1])
                self.ripples.append([*self._px(hand.pos), now, col])
            elif name in ("enter", "hands_up"):
                self.ripples.append([*self._px(b.joint("Spine")), now, (255, 200, 120)])

        # 6. Partículas
        alive = self.p_life > 0
        if alive.any():
            self.p_vel[alive] *= 0.95
            self.p_vel[alive, 1] -= 6.0 * dt            # flotan hacia arriba
            self.p_pos[alive] += self.p_vel[alive]
            self.p_life[alive] -= dt * 0.7
            x = self.p_pos[alive, 0].astype(np.int32)
            y = self.p_pos[alive, 1].astype(np.int32)
            ok = (x >= 0) & (x < self.w - 1) & (y >= 0) & (y < self.h - 1)
            x, y = x[ok], y[ok]
            col = (self.p_col[alive][ok] * np.clip(self.p_life[alive][ok], 0, 1)[:, None]
                   ).astype(np.uint8)
            for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
                self.trail[y + dy, x + dx] = np.maximum(self.trail[y + dy, x + dx], col)

        out = cv2.add(out, self.trail)
        bloom = cv2.GaussianBlur(cv2.resize(self.trail, (self.w // 4, self.h // 4),
                                            interpolation=cv2.INTER_AREA), (0, 0), 1.5)
        out = cv2.add(out, cv2.resize(bloom, (self.w, self.h),
                                      interpolation=cv2.INTER_LINEAR))   # resplandor (bloom)

        keep = []
        for x, y, t0, col in self.ripples:
            age = now - t0
            if age < 1.2:
                k = 1.0 - age / 1.2
                cv2.circle(out, (int(x), int(y)), int(20 + 320 * age),
                           tuple(int(v * k) for v in col), 1 + int(2 * k), cv2.LINE_AA)
                keep.append([x, y, t0, col])
        self.ripples = keep

        if not bodies:   # estado de espera: invita a acercarse
            pulse = 0.5 + 0.5 * np.sin(now * 2.0)
            cv2.circle(out, (self.w // 2, self.h // 2), int(40 + 14 * pulse),
                       tuple(int(v * (0.3 + 0.5 * pulse)) for v in (255, 170, 60)), 2, cv2.LINE_AA)
        return out

    def _relief(self, tracker, raw_mask, mask):
        """El cuerpo como paisaje: color por profundidad + curvas de nivel."""
        depth = tracker.depth
        if depth is None or raw_mask is None:
            # Sin profundidad: degradado vertical simple dentro de la silueta
            ramp = np.linspace(200, 60, self.h, dtype=np.uint8)[:, None].repeat(self.w, 1)
            col = cv2.applyColorMap(ramp, cv2.COLORMAP_OCEAN)
            return cv2.bitwise_and(col, col, mask=mask) // 2
        body = (raw_mask > 0) & (depth > 0)
        if body.sum() < 80:
            return np.zeros((self.h, self.w, 3), np.uint8)
        vals = depth[body]
        lo, hi = np.percentile(vals, [2, 98])
        near = np.clip((hi - depth.astype(np.float32)) / max(hi - lo, 60.0), 0, 1)
        near = cv2.resize(near, (self.w, self.h), interpolation=cv2.INTER_LINEAR)
        near = cv2.GaussianBlur(near, (7, 7), 0)
        col = cv2.applyColorMap((40 + near * 215).astype(np.uint8), cv2.COLORMAP_INFERNO)
        lines = ((near * 10.0) % 1.0) < 0.10                       # curvas de nivel
        col = (col * 0.55).astype(np.uint8)
        col[lines] = cv2.add(col[lines], np.full_like(col[lines], 90))
        return cv2.bitwise_and(col, col, mask=mask)


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
    ap.add_argument("--image", help="imagen que se revela dentro de la silueta")
    ap.add_argument("--fullscreen", action="store_true", help="visuales en pantalla completa")
    ap.add_argument("--solo", action="store_true",
                    help="solo visuales: no abrir la ventana de control (cámara + esqueleto)")
    ap.add_argument("--tilt", type=int, help="inclinación del motor, -27..27")
    ap.add_argument("--no-depth", action="store_true",
                    help="no abrir el flujo de profundidad (silueta aproximada con el esqueleto)")
    args = ap.parse_args()

    if args.replay:
        source = ReplaySource(args.replay)
    else:
        source = KinectSource(color=not args.solo, silhouette=not args.no_depth, tilt=args.tilt)
    tracker = Tracker(source, recorder=Recorder(args.record) if args.record else None)

    image = None
    if args.image:
        image = cv2.imread(args.image)
        if image is None:
            raise SystemExit("No se pudo abrir la imagen: " + args.image)
    vis = Visuals(image=image)

    win = "AURALIS LAB"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    full = args.fullscreen
    ctrl = None if args.solo else "AURALIS LAB - Control"
    if ctrl:
        cv2.namedWindow(ctrl, cv2.WINDOW_AUTOSIZE)
        cv2.moveWindow(ctrl, 0, 0)
        cv2.moveWindow(win, 660, 0)
    log, fps, last = [], 30.0, time.perf_counter()
    if full:
        cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
    try:
        while True:
            bodies = tracker.update()
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
            if key == ord("m"):
                options = [s for s in STYLES if s != "imagen" or vis.image is not None]
                vis.style = options[(options.index(vis.style) + 1) % len(options)]
                print("Estilo:", vis.style)
    finally:
        tracker.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
