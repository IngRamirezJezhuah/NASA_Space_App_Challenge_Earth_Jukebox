#!/usr/bin/env python3
"""BODY TRACKER - mueve la página de VISORA/Aerosols con las manos usando el Kinect.

  1. Lee la cámara del Kinect (libfreenect) y detecta hasta 4 cuerpos (MediaPipe Pose).
  2. Usa la profundidad del Kinect + las coordenadas para mantener a cada persona con su ID.
  3. Sirve la página y manda cuerpos/manos/gestos por SSE (baja latencia).

Gestos (se ve como un espejo; controla el cuerpo más cercano con las manos levantadas):
  - ARRASTRAR (R) / (L): levanta UNA mano (muñeca sobre el codo) y muévela -> gira el globo.
  - ZOOM: con las DOS manos visibles, sepáralas = acercar, júntalas = alejar.
          Un APLAUSO acerca un paso y activa el zoom aunque las manos estén bajas.
  - ENCUADRE (foto): con los pulgares e índices de ambas manos formando un rectángulo
          se muestra el cuadro de la zona; mantenlo 1 s y se captura.

Uso:  ./body_tracker.sh [--window] [--no-browser] [--port 8765]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import socket
import threading
import time
import webbrowser
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

# =====================================================================
#  CONFIGURACIÓN MANUAL  (edita aquí)
# =====================================================================
PAGINA_DIR = os.path.expanduser("~/Documentos/Programacion/NASA/VISORA/Aerosols")  # carpeta a servir
PAGINA = "Visora_2.html"        # archivo que se abre
PUERTO = 8765
MAX_CUERPOS = 4                 # límite de cuerpos
PREVIEW_SIZE = (320, 240)       # vista previa (más pequeño = menos latencia)
JPEG_QUALITY = 70

MIN_VIS = 0.5                   # visibilidad mínima de muñeca para aceptar la mano
LEVANTADA_ON = 0.03             # muñeca sobre el codo (fracción de imagen) para activar
LEVANTADA_OFF = -0.02           # por debajo se suelta (histéresis)
HOLD_MANO = 0.35                # s que se mantiene la mano cuando deja de verse (tolerancia)
TTL_CUERPO = 1.0                # s que se recuerda un cuerpo que no se ve
GRACIA_CONTROL = 1.0            # s que el cuerpo que controla conserva el control sin manos
FILTRO_MIN_CUTOFF = 1.5         # One Euro: menor = menos temblor
FILTRO_BETA = 4.0               # mayor = menos retraso al moverse rápido

# Asociación de cuerpos entre frames (px de imagen + penalización por profundidad)
MATCH_MAX = 220.0
MATCH_PX_POR_M = 150.0          # cada metro de diferencia de profundidad suma esto
DEPTH_CADA = 4                  # leer profundidad cada N frames (es lenta)

# Aplauso
APLAUSO_CERCA = 0.45            # distancia entre muñecas (anchos de hombro) para contar
APLAUSO_LEJOS = 1.0             # tenían que haber estado al menos así de separadas
APLAUSO_VENTANA = 0.4           # s
APLAUSO_ENFRIAR = 0.9           # s entre aplausos
ZOOM_ARMADO_S = 5.0             # s que sigue activo el zoom tras un aplauso (se renueva al usarlo)

# Gesto de foto (dedos formando un rectángulo)
ENCUADRE_TOL = 1.1              # distancia máxima entre puntas, en tamaños de mano
# =====================================================================

BASE = os.path.dirname(os.path.abspath(__file__))
POSE_MODEL = os.path.join(BASE, "models", "pose_landmarker_full.task")
HAND_MODEL = os.path.join(BASE, "models", "hand_landmarker.task")
W, H = 640, 480
# Landmarks de MediaPipe Pose (izquierda/derecha = de la persona)
LS, RS, LE, RE, LW, RW, LP, RP, LI, RI, LH, RH = 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24
BONES = [(LS, RS), (LS, LE), (LE, LW), (RS, RE), (RE, RW), (LS, LH), (RS, RH), (LH, RH)]
COLORS = [(0, 200, 0), (255, 160, 0), (0, 160, 255), (220, 0, 220)]   # BGR por cuerpo


class OneEuro:
    def __init__(self, min_cutoff, beta, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = self.dx = None

    def __call__(self, x, dt):
        x = np.asarray(x, dtype=float)
        if self.x is None:
            self.x, self.dx = x.copy(), np.zeros_like(x)
            return self.x.copy()
        a_d = 1.0 / (1.0 + 1.0 / (2 * math.pi * self.d_cutoff * dt))
        self.dx += a_d * ((x - self.x) / dt - self.dx)
        cutoff = self.min_cutoff + self.beta * float(np.linalg.norm(self.dx))
        a = 1.0 / (1.0 + 1.0 / (2 * math.pi * cutoff * dt))
        self.x += a * (x - self.x)
        return self.x.copy()


class Hub:
    """Último dato publicado; los clientes esperan al siguiente y se saltan los viejos."""

    def __init__(self):
        self.cond = threading.Condition()
        self.seq = 0
        self.payload = b""
        self.jpeg = b""
        self.preview = None
        self.running = True

    def publish(self, payload, jpeg, preview):
        with self.cond:
            self.seq += 1
            self.payload, self.jpeg, self.preview = payload, jpeg, preview
            self.cond.notify_all()

    def stop(self):
        with self.cond:
            self.running = False
            self.cond.notify_all()


hub = Hub()


class Track:
    """Un cuerpo seguido entre frames."""

    def __init__(self, tid, cx, cy, z, now):
        self.id, self.cx, self.cy, self.z, self.seen = tid, cx, cy, z, now
        self.f_xy = {"L": None, "R": None}
        self.f_s = {"L": None, "R": None}
        self.raised = {"L": False, "R": False}
        self.last = {"L": None, "R": None}      # (valores, t) de la última mano buena
        self.dhist = deque(maxlen=16)           # (t, distancia entre muñecas)
        self.clap_seq = 0
        self.last_clap = 0.0
        self.armed_until = 0.0
        self.prev_d = None
        self.frame = None                       # rect suavizado [x0,y0,x1,y1]
        self.hits = deque(maxlen=6)             # tiempos de detección del encuadre
        self.out = {}
        self.visible = False

    def reset_hands(self):
        for k in ("L", "R"):
            self.f_xy[k] = self.f_s[k] = self.last[k] = None
            self.raised[k] = False
        self.dhist.clear()
        self.prev_d = None


class Capture(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        import freenect
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        for m in (POSE_MODEL, HAND_MODEL):
            if not os.path.exists(m):
                raise SystemExit(f"Falta el modelo: {m}")
        self.fn, self.mp = freenect, mp
        if freenect.sync_get_video() is None:
            raise SystemExit("No se pudo abrir el Kinect. Prueba: ./run_linux.sh --check "
                             "(¿12 V conectados? ¿kinect_check.py cerrado?)")
        self.pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=POSE_MODEL),
            running_mode=vision.RunningMode.VIDEO, num_poses=MAX_CUERPOS,
            min_pose_detection_confidence=0.5, min_tracking_confidence=0.5))
        self.hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=HAND_MODEL),
            running_mode=vision.RunningMode.IMAGE, num_hands=2,
            min_hand_detection_confidence=0.4, min_hand_presence_confidence=0.4))
        self.tracks: dict[int, Track] = {}
        self.next_id = 1
        self.primary = None
        self.primary_t = 0.0
        self.depth = None
        self.n = 0
        self.last_ms = -1
        self.t0 = self.t_prev = time.perf_counter()
        self.fps = 0.0

    # ------------------------------------------------------------ bucle
    def run(self):
        fn = self.fn
        try:
            while hub.running:
                got = fn.sync_get_video(0, fn.VIDEO_RGB)
                if got is None:
                    time.sleep(0.01)
                    continue
                if self.n % DEPTH_CADA == 0:
                    d = fn.sync_get_depth(0, fn.DEPTH_REGISTERED)
                    if d is not None:
                        self.depth = d[0]
                self.step(got[0])
                self.n += 1
        finally:
            try:
                fn.sync_stop()
            except Exception:
                pass

    def step(self, rgb):
        now = time.perf_counter()
        dt = min(0.2, max(1 / 120, now - self.t_prev))
        self.t_prev = now
        self.fps += 0.1 * (1 / dt - self.fps)
        t = now - self.t0

        ms = max(int(t * 1000), self.last_ms + 1)     # MediaPipe exige tiempos crecientes
        self.last_ms = ms
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        poses = self.pose.detect_for_video(image, ms).pose_landmarks or []

        for tr in self.tracks.values():
            tr.visible = False
        matched = self.associate(poses, t)
        for tr, lm in matched:
            tr.visible = True
            tr.seen = t
            self.compute(tr, lm, rgb, dt, t)
        for tid in [k for k, tr in self.tracks.items() if t - tr.seen > TTL_CUERPO]:
            if self.primary == tid:
                self.primary = None
            del self.tracks[tid]
        self.pick_primary(t)

        pw, ph = PREVIEW_SIZE
        view = cv2.flip(cv2.resize(rgb[:, :, ::-1], (pw, ph)), 1)
        for tr, lm in matched:
            self.draw(view, tr, lm)
        if not matched:
            cv2.putText(view, "BUSCANDO CUERPO...", (8, 20), cv2.FONT_HERSHEY_SIMPLEX,
                        0.5, (0, 0, 255), 1, cv2.LINE_AA)
        cv2.putText(view, f"{self.fps:.0f} fps  cuerpos {len(matched)}/{MAX_CUERPOS}",
                    (8, ph - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

        ok, buf = cv2.imencode(".jpg", view, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        payload = json.dumps(self.payload(t), separators=(",", ":")).encode()
        hub.publish(payload, buf.tobytes() if ok else b"", view)

    # ------------------------------------------------------ cuerpos / IDs
    def body_z(self, lm):
        """Distancia (m) del cuerpo con la profundidad del Kinect (hombros y cadera)."""
        if self.depth is None:
            return None
        vals = []
        for pts in ((LS, RS), (LH, RH)):
            x = sum(lm[i].x for i in pts) / 2 * W
            y = sum(lm[i].y for i in pts) / 2 * H
            if 0 <= x < W and 0 <= y < H:
                x, y = int(x), int(y)
                patch = self.depth[max(0, y - 4):y + 5, max(0, x - 4):x + 5]
                patch = patch[patch > 0]
                if patch.size:
                    vals.append(float(np.median(patch)) / 1000.0)
        return float(np.median(vals)) if vals else None

    def associate(self, poses, t):
        dets = []
        for lm in poses:
            cx = 1.0 - (lm[LS].x + lm[RS].x) / 2          # en espejo
            cy = (lm[LS].y + lm[RS].y) / 2
            dets.append((cx, cy, self.body_z(lm), lm))
        pairs = []
        for di, (cx, cy, z, _) in enumerate(dets):
            for tid, tr in self.tracks.items():
                cost = math.hypot((cx - tr.cx) * W, (cy - tr.cy) * H)
                if z is not None and tr.z is not None:
                    cost += abs(z - tr.z) * MATCH_PX_POR_M
                if cost < MATCH_MAX:
                    pairs.append((cost, di, tid))
        pairs.sort()
        used_d, used_t, out = set(), set(), []
        for _, di, tid in pairs:
            if di in used_d or tid in used_t:
                continue
            used_d.add(di)
            used_t.add(tid)
            cx, cy, z, lm = dets[di]
            tr = self.tracks[tid]
            tr.cx += 0.5 * (cx - tr.cx)
            tr.cy += 0.5 * (cy - tr.cy)
            if z is not None:
                tr.z = z if tr.z is None else tr.z + 0.4 * (z - tr.z)
            out.append((tr, lm))
        for di, (cx, cy, z, lm) in enumerate(dets):
            if di in used_d or len(self.tracks) >= MAX_CUERPOS:
                continue
            tr = Track(self.next_id, cx, cy, z, t)
            self.tracks[tr.id] = tr
            self.next_id += 1
            out.append((tr, lm))
        return out

    # ------------------------------------------------------- manos/gestos
    def compute(self, tr, lm, rgb, dt, t):
        def pt(i):
            l = lm[i]
            return 1.0 - l.x, l.y, (l.visibility if l.visibility is not None else 1.0)

        lsx, lsy, _ = pt(LS)
        rsx, rsy, _ = pt(RS)
        scx, scy = (lsx + rsx) / 2, (lsy + rsy) / 2
        sw = max(math.hypot((lsx - rsx) * W, (lsy - rsy) * H), 20.0)   # ancho de hombros en px
        out, wr = {}, {}
        # En espejo, la mano derecha de la persona queda a la derecha de la pantalla
        for key, wi, ei, extra in (("R", RW, RE, (RP, RI)), ("L", LW, LE, (LP, LI))):
            wx, wy, wv = pt(wi)
            _, ey, ev = pt(ei)
            pts = [pt(wi)] + [pt(i) for i in extra]
            hx = sum(p[0] for p in pts) / len(pts)
            hy = sum(p[1] for p in pts) / len(pts)
            visible = wv >= MIN_VIS and ev >= MIN_VIS - 0.1 and 0 <= wx <= 1 and 0 <= wy <= 1
            held = False
            if visible:
                lift = ey - wy                       # >0 = muñeca sobre el codo
                tr.raised[key] = lift > (LEVANTADA_OFF if tr.raised[key] else LEVANTADA_ON)
                if tr.f_xy[key] is None:
                    tr.f_xy[key] = OneEuro(FILTRO_MIN_CUTOFF, FILTRO_BETA)
                    tr.f_s[key] = OneEuro(FILTRO_MIN_CUTOFF, FILTRO_BETA)
                v = tr.f_xy[key](((hx - scx) * W / sw, -(hy - scy) * H / sw), dt)
                s = tr.f_s[key]((hx, hy), dt)
                vals = (float(v[0]), float(v[1]), float(s[0]), float(s[1]))
                tr.last[key] = (vals, t)
                present = True
                wr[key] = (wx * W, wy * H)
            elif tr.last[key] is not None and t - tr.last[key][1] < HOLD_MANO:
                vals, present, held = tr.last[key][0], True, True      # tolerancia a pérdidas
            else:
                tr.f_xy[key] = tr.f_s[key] = tr.last[key] = None
                tr.raised[key] = False
                vals, present = (0.0, 0.0, 0.5, 0.5), False
            out[key] = {"x": round(vals[0], 4), "y": round(vals[1], 4),
                        "sx": round(vals[2], 4), "sy": round(vals[3], 4),
                        "vis": present, "on": bool(present and tr.raised[key]), "held": held}
        tr.out = out

        # ---- aplauso / zoom armado
        if "L" in wr and "R" in wr:
            d = math.hypot(wr["L"][0] - wr["R"][0], wr["L"][1] - wr["R"][1]) / sw
            recent = [x for tt, x in tr.dhist if t - tt < APLAUSO_VENTANA]
            if (d < APLAUSO_CERCA and recent and max(recent) > APLAUSO_LEJOS
                    and t - tr.last_clap > APLAUSO_ENFRIAR):
                tr.clap_seq += 1
                tr.last_clap = t
                tr.armed_until = t + ZOOM_ARMADO_S
            elif tr.armed_until > t and tr.prev_d is not None and abs(d - tr.prev_d) > 0.05:
                tr.armed_until = max(tr.armed_until, t + 2.0)          # se renueva al usarlo
            tr.dhist.append((t, d))
            tr.prev_d = d
            if self.n % 2 == tr.id % 2 and 0.3 < d < 4.0:
                self.detect_frame(tr, lm, rgb, t)
        else:
            tr.dhist.clear()
            tr.prev_d = None

    def detect_frame(self, tr, lm, rgb, t):
        """Gesto de foto: las puntas de pulgar e índice de las dos manos forman un rectángulo."""
        ax, ay, bx, by = lm[LW].x * W, lm[LW].y * H, lm[RW].x * W, lm[RW].y * H
        side = int(min(480, max(1.5 * math.hypot(ax - bx, ay - by), 220)))
        x0 = int(min(max((ax + bx) / 2 - side / 2, 0), W - side))
        y0 = int(min(max((ay + by) / 2 - side / 2, 0), H - side))
        crop = np.ascontiguousarray(rgb[y0:y0 + side, x0:x0 + side])
        res = self.hands.detect(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=crop))
        if len(res.hand_landmarks) < 2:
            return

        def conv(h):
            p = lambda i: np.array([W - (x0 + h[i].x * side), y0 + h[i].y * side])   # px, espejo
            size = float(np.linalg.norm(p(0) - p(9)))
            return {"T": p(4), "I": p(8), "web": (p(2) + p(5)) / 2, "s": max(size, 8.0)}

        A, B = conv(res.hand_landmarks[0]), conv(res.hand_landmarks[1])
        tol = ENCUADRE_TOL * (A["s"] + B["s"]) / 2
        ok = (np.linalg.norm(A["T"] - B["I"]) < tol and np.linalg.norm(A["I"] - B["T"]) < tol
              and np.linalg.norm(A["T"] - A["I"]) > 0.8 * A["s"]
              and np.linalg.norm(B["T"] - B["I"]) > 0.8 * B["s"])
        if not ok:
            return
        pts = np.array([A["T"], A["I"], A["web"], B["T"], B["I"], B["web"]])
        (xa, ya), (xb, yb) = pts.min(axis=0), pts.max(axis=0)
        if (xb - xa) < 1.2 * A["s"] or (yb - ya) < 1.2 * A["s"]:
            return
        rect = np.array([xa / W, ya / H, xb / W, yb / H])
        tr.frame = rect if tr.frame is None else tr.frame + 0.5 * (rect - tr.frame)
        tr.hits.append(t)

    @staticmethod
    def frame_active(tr, t):
        return tr.frame is not None and tr.hits and t - tr.hits[-1] < 0.35 \
            and sum(1 for x in tr.hits if t - x < 0.6) >= 2

    def pick_primary(self, t):
        cand = [tr for tr in self.tracks.values() if tr.visible and (
            any(h["on"] for h in tr.out.values()) or tr.armed_until > t
            or self.frame_active(tr, t))]
        if any(tr.id == self.primary for tr in cand):
            self.primary_t = t
            return
        if cand:
            best = min(cand, key=lambda tr: (tr.z if tr.z is not None else 9.9, abs(tr.cx - 0.5)))
            self.primary, self.primary_t = best.id, t
        elif self.primary is not None and t - self.primary_t > GRACIA_CONTROL:
            self.primary = None

    # ------------------------------------------------------ salida
    def payload(self, t):
        bodies = []
        for tr in sorted(self.tracks.values(), key=lambda b: b.id):
            if not tr.visible:
                continue
            fr = self.frame_active(tr, t)
            bodies.append({
                "id": tr.id, "z": None if tr.z is None else round(tr.z, 2),
                "hands": tr.out, "armed": tr.armed_until > t, "clap": tr.clap_seq,
                "frame": [round(float(v), 4) for v in tr.frame] if fr else None})
        return {"t": round(t, 4), "fps": round(self.fps, 1), "primary": self.primary,
                "bodies": bodies}

    def draw(self, view, tr, lm):
        pw, ph = PREVIEW_SIZE
        col = COLORS[(tr.id - 1) % len(COLORS)]

        def px(i):
            return int((1.0 - lm[i].x) * pw), int(lm[i].y * ph)

        for a, b in BONES:
            if lm[a].visibility > 0.3 and lm[b].visibility > 0.3:
                cv2.line(view, px(a), px(b), col, 2, cv2.LINE_AA)
        for key, wi, extra in (("R", RW, (RP, RI)), ("L", LW, (LP, LI))):
            pts = [px(i) for i in (wi,) + extra]
            c = (int(np.mean([p[0] for p in pts])), int(np.mean([p[1] for p in pts])))
            h = tr.out.get(key, {})
            on = h.get("on", False)
            cv2.circle(view, c, 10 if on else 5, (0, 255, 255) if on else (140, 140, 140),
                       -1 if on else 1, cv2.LINE_AA)
        sx, sy = px(LS)
        head = f"C{tr.id}" + ("*" if tr.id == self.primary else "") + \
               (f" {tr.z:.1f}m" if tr.z is not None else "")
        cv2.putText(view, head, (max(2, sx - 20), max(12, sy - 14)), cv2.FONT_HERSHEY_SIMPLEX,
                    0.45, col, 1, cv2.LINE_AA)
        if self.frame_active(tr, self.t_prev - self.t0):
            x0, y0, x1, y1 = tr.frame
            cv2.rectangle(view, (int(x0 * pw), int(y0 * ph)), (int(x1 * pw), int(y1 * ph)),
                          (0, 255, 255), 2, cv2.LINE_AA)
        if tr.id == self.primary:
            n = sum(1 for h in tr.out.values() if h["on"])
            armed = tr.armed_until > self.t_prev - self.t0
            label = "ENCUADRE" if self.frame_active(tr, self.t_prev - self.t0) else \
                "ZOOM" if (n == 2 or (armed and all(h["vis"] for h in tr.out.values()))) else \
                "ARRASTRAR" if n == 1 else "Levanta una mano"
            cv2.putText(view, label, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1,
                        cv2.LINE_AA)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=PAGINA_DIR, **kw)

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/events":
            return self.stream_events()
        if path == "/preview.mjpg":
            return self.stream_preview()
        return super().do_GET()

    def _nodelay(self):
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def _wait(self, last):
        with hub.cond:
            hub.cond.wait_for(lambda: hub.seq != last or not hub.running, timeout=10)
            return hub.seq, hub.payload, hub.jpeg, hub.running

    def stream_events(self):
        self._nodelay()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last = -1
        try:
            while True:
                seq, payload, _, running = self._wait(last)
                if not running:
                    break
                if seq == last:
                    self.wfile.write(b": ping\n\n")
                else:
                    last = seq
                    self.wfile.write(b"data: " + payload + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def stream_preview(self):
        self._nodelay()
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        last = -1
        try:
            while True:
                seq, _, jpeg, running = self._wait(last)
                if not running:
                    break
                if seq == last or not jpeg:
                    continue
                last = seq
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                 + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="BODY TRACKER - controla VISORA con las manos")
    ap.add_argument("--port", type=int, default=PUERTO)
    ap.add_argument("--pagina", default=PAGINA, help="archivo .html dentro de PAGINA_DIR")
    ap.add_argument("--no-browser", action="store_true", help="no abrir el navegador")
    ap.add_argument("--window", action="store_true", help="vista previa también en ventana OpenCV")
    args = ap.parse_args()

    if not os.path.isfile(os.path.join(PAGINA_DIR, args.pagina)):
        raise SystemExit(f"No existe {args.pagina} en {PAGINA_DIR} (edita PAGINA_DIR/PAGINA)")

    cap = Capture()
    server = Server(("127.0.0.1", args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    cap.start()

    url = f"http://localhost:{args.port}/{args.pagina}?kinect"
    print(f"[body_tracker] {url}   (Ctrl+C para salir)")
    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()

    try:
        seen = -1
        while True:
            if args.window:
                with hub.cond:
                    hub.cond.wait_for(lambda: hub.seq != seen, timeout=1)
                    seen, frame = hub.seq, hub.preview
                if frame is not None:
                    cv2.imshow("BODY TRACKER (Q salir)", cv2.resize(frame, (640, 480)))
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
            else:
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        hub.stop()
        server.shutdown()
        cap.join(timeout=2)
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
