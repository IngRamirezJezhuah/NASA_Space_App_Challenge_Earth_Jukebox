"""
kinect_linux.py — Fuente Kinect v1 para Linux (libfreenect + MediaPipe PoseLandmarker).
Misma interfaz que KinectSource (Windows/SDK 1.8): color, mask, depth, read(), close().

Limitaciones frente al SDK: hasta 2 personas con id por orden de detección,
sin control del motor con la API sync.
"""
from __future__ import annotations

import os
import time

import numpy as np

NOT_TRACKED, INFERRED, TRACKED = 0, 1, 2
COLOR_F = 531.15
COLOR_CX, COLOR_CY = 320.0, 240.0

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "models", "pose_landmarker_full.task")

# Orden idéntico a JOINT_NAMES de auralis_kinect.py
JOINT_ORDER = [
    "HipCenter", "Spine", "ShoulderCenter", "Head",
    "ShoulderLeft", "ElbowLeft", "WristLeft", "HandLeft",
    "ShoulderRight", "ElbowRight", "WristRight", "HandRight",
    "HipLeft", "KneeLeft", "AnkleLeft", "FootLeft",
    "HipRight", "KneeRight", "AnkleRight", "FootRight",
]

# Landmarks de MediaPipe Pose (izquierda/derecha = de la persona)
MP = {"nose": 0, "ls": 11, "rs": 12, "le": 13, "re": 14, "lw": 15, "rw": 16,
      "lp": 17, "rp": 18, "li": 19, "ri": 20, "lh": 23, "rh": 24,
      "lk": 25, "rk": 26, "la": 27, "ra": 28, "lf": 31, "rf": 32}


J_ANCHOR = 2   # ShoulderCenter: la cadera suele estar fuera del cuadro o inventada
HAND_JOINTS = {i for i, n in enumerate(JOINT_ORDER)
               if n in ("HandLeft", "HandRight", "WristLeft", "WristRight")}


class LinuxKinectSource:
    def __init__(self, color=True, silhouette=False, seated=False, tilt=None, **_):
        import freenect
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        if not os.path.exists(MODEL_PATH):
            raise RuntimeError(f"Falta el modelo de pose: {MODEL_PATH}")

        self._fn = freenect
        self._mp = mp
        self._color_on = color
        self._mask_on = silhouette
        self.color = None   # BGR (480,640,3)
        self.mask = None    # (240,320) uint8, 1 = persona
        self.depth = None   # (240,320) int16, mm

        if self._fn.sync_get_video() is None:
            raise RuntimeError(
                "No se pudo abrir el Kinect. Revisa: fuente de 12 V conectada, "
                "'lsmod | grep gspca_kinect' vacío (sudo modprobe -r gspca_kinect) "
                "y reglas udev. Diagnóstico: ./run_linux.sh --check")

        opts = vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=MODEL_PATH),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=2,
            output_segmentation_masks=silhouette,
            min_pose_detection_confidence=0.5,
            min_tracking_confidence=0.5)
        self._pose = vision.PoseLandmarker.create_from_options(opts)
        self._t0 = time.perf_counter()
        self._last_ms = -1
        self._tracks = {}      # id estable -> {"pos": (20,3) suavizado, "miss": frames sin verse}
        self._next_id = 1

        if tilt is not None:
            self.set_tilt(tilt)

    def set_tilt(self, degrees):
        print("[kinect_linux] tilt no soportado con la API sync; se ignora.")

    @staticmethod
    def _depth_m(depth_mm, u, v):
        h, w = depth_mm.shape
        x, y = int(round(u)), int(round(v))
        if not (0 <= x < w and 0 <= y < h):
            return 0.0
        patch = depth_mm[max(0, y - 2):y + 3, max(0, x - 2):x + 3]
        valid = patch[patch > 0]
        return float(np.median(valid)) / 1000.0 if valid.size else 0.0

    def read(self):
        fn = self._fn
        rgb, _ = fn.sync_get_video(0, fn.VIDEO_RGB)               # (480,640,3) RGB
        depth_mm, _ = fn.sync_get_depth(0, fn.DEPTH_REGISTERED)   # (480,640) uint16 mm, alineado
        t = time.perf_counter() - self._t0

        if self._color_on:
            self.color = np.ascontiguousarray(rgb[:, :, ::-1])
        if self._mask_on:
            self.depth = depth_mm[::2, ::2].astype(np.int16)

        ms = max(int(t * 1000), self._last_ms + 1)   # MediaPipe exige timestamps crecientes
        self._last_ms = ms
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB,
                               data=np.ascontiguousarray(rgb))
        res = self._pose.detect_for_video(image, ms)

        if self._mask_on:
            self.mask = None
            for m in (res.segmentation_masks or []):
                seg = (np.squeeze(m.numpy_view())[::2, ::2] > 0.5).astype(np.uint8)
                self.mask = seg if self.mask is None else (self.mask | seg)

        bodies = []
        for lm in res.pose_landmarks:
            body = self._body(lm, depth_mm, 0)
            if body is not None:
                bodies.append(body)
        self._assign_ids(bodies)
        return {"t": t, "bodies": bodies}

    # Ajustes anti-temblor (más bajo = más suave, más retraso)
    ALPHA = 0.45        # cuerpo
    ALPHA_HAND = 0.30   # manos/muñecas
    DEADBAND = 0.012    # m: movimientos menores se ignoran
    MAX_JUMP = 0.50     # m por frame: saltos mayores con poca visibilidad se rechazan
    MAX_MISS = 15       # frames que se recuerda una persona perdida

    def _assign_ids(self, bodies):
        """IDs estables por cercanía de cadera (MediaPipe numera por orden de detección,
        así que al cruzarse dos personas intercambiaban id) + suavizado por articulación."""
        hip = J_ANCHOR
        free = dict(self._tracks)
        for b in sorted(bodies, key=lambda b: b["pos"][hip, 2]):
            best, bd = None, 0.7
            for tid, tr in free.items():
                d = np.linalg.norm(tr["pos"][hip] - b["pos"][hip])
                if d < bd:
                    best, bd = tid, d
            if best is None:
                best = self._next_id
                self._next_id += 1
                self._tracks[best] = {"pos": b["pos"].copy(), "miss": 0}
            else:
                free.pop(best)
            tr = self._tracks[best]
            tr["miss"] = 0
            b["id"] = best
            prev, new = tr["pos"], b["pos"]
            out = prev.copy()
            for i in range(20):
                d = np.linalg.norm(new[i] - prev[i])
                if b["state"][i] == NOT_TRACKED or \
                        (d > self.MAX_JUMP and b["state"][i] != TRACKED):
                    continue                      # conserva la posición anterior
                if d < self.DEADBAND:
                    continue
                a = self.ALPHA_HAND if i in HAND_JOINTS else self.ALPHA
                if b["state"][i] == INFERRED:
                    a *= 0.5
                out[i] = prev[i] + a * (new[i] - prev[i])
            tr["pos"] = out
            b["pos"] = out.copy()
        for tid in list(self._tracks):
            if tid in free:
                self._tracks[tid]["miss"] += 1
                if self._tracks[tid]["miss"] > self.MAX_MISS:
                    del self._tracks[tid]

    def _body(self, lm, depth_mm, body_id):
        h, w = depth_mm.shape

        def p(key):
            l = lm[MP[key]]
            return np.array([l.x * w, l.y * h]), (l.visibility if l.visibility is not None else 1.0)

        def avg(*keys):
            pts = [p(k) for k in keys]
            return np.mean([q[0] for q in pts], axis=0), min(q[1] for q in pts)

        sh_c = avg("ls", "rs")
        hip_c = avg("lh", "rh")
        spine = ((sh_c[0] + hip_c[0]) / 2, min(sh_c[1], hip_c[1]))
        px = {
            "HipCenter": hip_c, "Spine": spine, "ShoulderCenter": sh_c, "Head": p("nose"),
            "ShoulderLeft": p("ls"), "ElbowLeft": p("le"), "WristLeft": p("lw"),
            "HandLeft": avg("lw", "lp", "li"),
            "ShoulderRight": p("rs"), "ElbowRight": p("re"), "WristRight": p("rw"),
            "HandRight": avg("rw", "rp", "ri"),
            "HipLeft": p("lh"), "KneeLeft": p("lk"), "AnkleLeft": p("la"), "FootLeft": p("lf"),
            "HipRight": p("rh"), "KneeRight": p("rk"), "AnkleRight": p("ra"), "FootRight": p("rf"),
        }

        zs = {n: self._depth_m(depth_mm, *px[n][0]) for n in JOINT_ORDER}
        valid = [z for z in zs.values() if z > 0]
        if not valid:
            return None
        z_body = float(np.median(valid))

        pos = np.empty((20, 3))
        state = np.empty(20, dtype=np.int8)
        for i, name in enumerate(JOINT_ORDER):
            (u, v), vis = px[name]
            z = zs[name]
            known = z > 0
            if not known:
                z = z_body
            # Espacio del SDK: X+ = derecha de la persona (izquierda de la imagen), Y+ arriba, Z+ = frente
            pos[i] = (-(u - COLOR_CX) * z / COLOR_F, -(v - COLOR_CY) * z / COLOR_F, z)
            inside = 0 <= u < w and 0 <= v < h
            if not inside:
                state[i] = NOT_TRACKED       # MediaPipe inventa puntos fuera del cuadro
            elif vis >= 0.6 and known:
                state[i] = TRACKED
            elif vis >= 0.3:
                state[i] = INFERRED
            else:
                state[i] = NOT_TRACKED

        us = [px[n][0][0] for n in JOINT_ORDER]
        vs = [px[n][0][1] for n in JOINT_ORDER]
        clip = []
        if min(us) < 0: clip.append("left")
        if max(us) > w: clip.append("right")
        if min(vs) < 0: clip.append("top")
        if max(vs) > h: clip.append("bottom")
        return {"id": body_id, "pos": pos, "state": state, "clip": clip}

    def close(self):
        try:
            self._pose.close()
        finally:
            try:
                self._fn.sync_stop()
            except Exception:
                pass
