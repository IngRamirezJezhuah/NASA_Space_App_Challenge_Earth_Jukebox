"""
auralis_kinect.py — Capa de entrada Kinect v1 (Xbox 360, SDK 1.8) para AURALIS LAB.

Idea: el resto del sistema (visuales, sonido, datos NASA) NO toca el SDK.
Solo hace esto:

    from auralis_kinect import KinectSource, Tracker

    tracker = Tracker(KinectSource())
    while True:
        bodies = tracker.update()          # no bloquea; llamar en cada frame
        for b in bodies:
            b.right.u, b.right.v           # cursor 0..1 de la mano derecha
            b.right.push, b.right.speed    # extensión del brazo 0..1, m/s
            b.proximity, b.pan, b.energy   # cuerpo completo, normalizado
        for ev in tracker.events:          # ("clap", slot), ("push_right", slot)...
            ...

Demo / depuración:
    python auralis_kinect.py                         # Kinect en vivo
    python auralis_kinect.py --record sesion.jsonl   # grabar una sesión
    python auralis_kinect.py --replay sesion.jsonl   # reproducir SIN Kinect
    python auralis_kinect.py --osc 127.0.0.1:9000    # enviar por OSC
    python auralis_kinect.py --silhouette            # máscara de silueta

Dependencias: numpy. Con Kinect: pythonnet. Demo: opencv-python. OSC: python-osc.
"""
from __future__ import annotations

import ctypes
import json
import math
import sys
import time
from dataclasses import dataclass, field

import numpy as np

# Orden oficial de JointType en el SDK 1.8
JOINT_NAMES = [
    "HipCenter", "Spine", "ShoulderCenter", "Head",
    "ShoulderLeft", "ElbowLeft", "WristLeft", "HandLeft",
    "ShoulderRight", "ElbowRight", "WristRight", "HandRight",
    "HipLeft", "KneeLeft", "AnkleLeft", "FootLeft",
    "HipRight", "KneeRight", "AnkleRight", "FootRight",
]
J = {name: i for i, name in enumerate(JOINT_NAMES)}

BONES = [
    ("Head", "ShoulderCenter"), ("ShoulderCenter", "Spine"), ("Spine", "HipCenter"),
    ("ShoulderCenter", "ShoulderLeft"), ("ShoulderLeft", "ElbowLeft"),
    ("ElbowLeft", "WristLeft"), ("WristLeft", "HandLeft"),
    ("ShoulderCenter", "ShoulderRight"), ("ShoulderRight", "ElbowRight"),
    ("ElbowRight", "WristRight"), ("WristRight", "HandRight"),
    ("HipCenter", "HipLeft"), ("HipLeft", "KneeLeft"),
    ("KneeLeft", "AnkleLeft"), ("AnkleLeft", "FootLeft"),
    ("HipCenter", "HipRight"), ("HipRight", "KneeRight"),
    ("KneeRight", "AnkleRight"), ("AnkleRight", "FootRight"),
]

# Estado de cada articulación
NOT_TRACKED, INFERRED, TRACKED = 0, 1, 2

# Focales nominales del Kinect v1 (solo para dibujar; no requiere el sensor)
COLOR_F, COLOR_C = 531.15, (320.0, 240.0)      # 640x480
DEPTH_F, DEPTH_C = 285.63, (160.0, 120.0)      # 320x240


# =====================================================================
#  FUENTES DE DATOS  (todas devuelven el mismo "frame crudo")
#  {"t": segundos, "bodies": [{"id", "pos"(20,3), "state"(20,), "clip"[]}]}
# =====================================================================

class KinectSource:
    """Lee el Kinect v1 mediante el SDK 1.8 (pythonnet). No bloquea."""

    def __init__(self, color=True, silhouette=False, seated=False, tilt=None,
                 sdk_path=r"C:\Program Files\Microsoft SDKs\Kinect\v1.8\Assemblies"):
        import clr
        if sdk_path not in sys.path:
            sys.path.append(sdk_path)
        clr.AddReference("Microsoft.Kinect")
        import Microsoft.Kinect as K
        from System import Array, Byte, Int16
        from System.Runtime.InteropServices import GCHandle, GCHandleType

        self._K = K
        self._handles = []
        self.color = None      # último frame BGR (480,640,3) o None
        self.mask = None       # índice de jugador por píxel (240,320) uint8, 0 = fondo
        self.depth = None      # profundidad en mm por píxel (240,320) int16, 0 = sin dato

        self.sensor = None
        for s in K.KinectSensor.KinectSensors:
            if str(s.Status) == "Connected":
                self.sensor = s
                break
        if self.sensor is None:
            raise RuntimeError("No se encontró Kinect conectado.")

        def pinned(net_type, count, dtype):
            # Arreglo .NET fijado en memoria + vista numpy sobre la MISMA memoria:
            # CopyPixelDataTo escribe y numpy lo ve sin copias intermedias.
            arr = Array[net_type](count)
            handle = GCHandle.Alloc(arr, GCHandleType.Pinned)
            self._handles.append(handle)
            nbytes = count * np.dtype(dtype).itemsize
            raw = (ctypes.c_ubyte * nbytes).from_address(
                handle.AddrOfPinnedObject().ToInt64())
            return arr, np.frombuffer(raw, dtype=dtype)

        self._color_on = color
        if color:
            self.sensor.ColorStream.Enable(K.ColorImageFormat.RgbResolution640x480Fps30)
            self._color_net, view = pinned(Byte, 640 * 480 * 4, np.uint8)
            self._color_np = view.reshape(480, 640, 4)

        self._mask_on = silhouette
        if silhouette:
            self.sensor.DepthStream.Enable(K.DepthImageFormat.Resolution320x240Fps30)
            self._depth_net, view = pinned(Int16, 320 * 240, np.int16)
            self._depth_np = view.reshape(240, 320)

        self.sensor.SkeletonStream.Enable()
        if seated:  # solo torso/brazos: útil si el público está sentado o tras una mesa
            self.sensor.SkeletonStream.TrackingMode = K.SkeletonTrackingMode.Seated

        self._skels = Array[K.Skeleton](self.sensor.SkeletonStream.FrameSkeletonArrayLength)
        self._joint_types = [getattr(K.JointType, n) for n in JOINT_NAMES]
        self._edges = [(K.FrameEdges.Left, "left"), (K.FrameEdges.Right, "right"),
                       (K.FrameEdges.Top, "top"), (K.FrameEdges.Bottom, "bottom")]

        self.sensor.Start()
        if tilt is not None:
            self.set_tilt(tilt)

    def set_tilt(self, degrees):
        """Inclina el motor (-27..27). No llamar más de ~1 vez por segundo."""
        self.sensor.ElevationAngle = int(max(-27, min(27, degrees)))

    def _clipped(self, sk):
        try:
            return [name for flag, name in self._edges if sk.ClippedEdges.HasFlag(flag)]
        except Exception:
            return []

    def read(self):
        K = self._K
        # Color y profundidad se leen por separado: que falte uno NO descarta el esqueleto.
        if self._color_on:
            cf = self.sensor.ColorStream.OpenNextFrame(0)
            if cf is not None:
                try:
                    cf.CopyPixelDataTo(self._color_net)
                    self.color = self._color_np[:, :, :3].copy()
                finally:
                    cf.Dispose()
        if self._mask_on:
            df = self.sensor.DepthStream.OpenNextFrame(0)
            if df is not None:
                try:
                    df.CopyPixelDataTo(self._depth_net)
                    self.mask = (self._depth_np & 7).astype(np.uint8)
                    self.depth = self._depth_np >> 3
                finally:
                    df.Dispose()

        # Vaciar la cola y quedarse con el esqueleto más reciente (menor latencia)
        t = None
        while True:
            sf = self.sensor.SkeletonStream.OpenNextFrame(0)
            if sf is None:
                break
            try:
                sf.CopySkeletonDataTo(self._skels)
                t = sf.Timestamp / 1000.0
            finally:
                sf.Dispose()
        if t is None:
            return None

        bodies = []
        tracked_sk = K.SkeletonTrackingState.Tracked
        j_tracked, j_inferred = K.JointTrackingState.Tracked, K.JointTrackingState.Inferred
        for sk in self._skels:
            if sk is None or sk.TrackingState != tracked_sk:
                continue
            pos = np.empty((20, 3))
            state = np.empty(20, dtype=np.int8)
            joints = sk.Joints
            for i, jt in enumerate(self._joint_types):
                joint = joints[jt]
                p = joint.Position
                pos[i] = (p.X, p.Y, p.Z)
                ts = joint.TrackingState
                state[i] = TRACKED if ts == j_tracked else (INFERRED if ts == j_inferred else NOT_TRACKED)
            bodies.append({"id": int(sk.TrackingId), "pos": pos, "state": state,
                           "clip": self._clipped(sk)})
        return {"t": t, "bodies": bodies}

    def close(self):
        try:
            self.sensor.Stop()
        finally:
            for h in self._handles:
                h.Free()
            self._handles = []


class Recorder:
    """Guarda frames crudos en JSONL para reproducirlos después sin Kinect."""

    def __init__(self, path):
        self._f = open(path, "w", encoding="utf-8")

    def write(self, raw):
        self._f.write(json.dumps({
            "t": round(raw["t"], 4),
            "bodies": [{"id": b["id"],
                        "pos": np.round(b["pos"], 4).tolist(),
                        "state": [int(s) for s in b["state"]],
                        "clip": b["clip"]} for b in raw["bodies"]],
        }) + "\n")

    def close(self):
        self._f.close()


class ReplaySource:
    """Reproduce una grabación. Permite desarrollar visuales/sonido sin el sensor."""

    def __init__(self, path, loop=True, realtime=True):
        self.color = None
        self.mask = None
        self.depth = None
        self.frames = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    fr = json.loads(line)
                    for b in fr["bodies"]:
                        b["pos"] = np.array(b["pos"], dtype=float)
                        b["state"] = np.array(b["state"], dtype=np.int8)
                    self.frames.append(fr)
        if not self.frames:
            raise ValueError("Grabación vacía: " + path)
        self.loop, self.realtime = loop, realtime
        self._t0 = self.frames[0]["t"]
        self._dur = self.frames[-1]["t"] - self._t0 + 1 / 30
        self._i, self._laps = 0, 0
        self._start = time.perf_counter()

    def read(self):
        if self._i >= len(self.frames):
            if not self.loop:
                return None
            self._i, self._laps = 0, self._laps + 1
        fr = self.frames[self._i]
        t = fr["t"] - self._t0 + self._laps * self._dur   # el tiempo nunca retrocede
        if self.realtime and time.perf_counter() - self._start < t:
            return None
        self._i += 1
        return {"t": t, "bodies": fr["bodies"]}

    def close(self):
        pass


# =====================================================================
#  FILTRO
# =====================================================================

class OneEuro:
    """Filtro One Euro vectorizado: quieto = muy suave, rápido = poca latencia.
    min_cutoff ↓ = menos temblor en reposo.  beta ↑ = menos retraso al moverse."""

    def __init__(self, min_cutoff=1.2, beta=6.0, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = None
        self.dx = None

    def __call__(self, x, dt):
        x = np.asarray(x, dtype=float)
        if self.x is None:
            self.x, self.dx = x.copy(), np.zeros_like(x)
            return self.x.copy()
        a_d = 1.0 / (1.0 + 1.0 / (2 * math.pi * self.d_cutoff * dt))
        self.dx += a_d * ((x - self.x) / dt - self.dx)
        speed = np.linalg.norm(self.dx, axis=-1, keepdims=True)   # m/s por articulación
        cutoff = self.min_cutoff + self.beta * speed
        a = 1.0 / (1.0 + 1.0 / (2 * math.pi * cutoff * dt))
        self.x += a * (x - self.x)
        return self.x.copy()


# =====================================================================
#  SALIDA LIMPIA
# =====================================================================

@dataclass
class Hand:
    u: float = 0.5          # cursor horizontal 0..1 (0 = izquierda de la pantalla)
    v: float = 0.5          # cursor vertical 0..1 (0 = arriba)
    push: float = 0.0       # brazo extendido hacia el sensor, 0..1
    speed: float = 0.0      # m/s, suavizada
    raised: bool = False    # mano por encima de los hombros
    tracked: bool = False   # False = no confiar (oculta o fuera de cuadro)
    pos: np.ndarray = field(default_factory=lambda: np.zeros(3))  # metros, filtrada


@dataclass
class Body:
    slot: int                       # jugador 0 o 1, estable mientras siga en escena
    id: int                         # TrackingId del SDK
    joints: np.ndarray              # (20,3) metros, filtradas. X+ = derecha de la persona
    state: np.ndarray               # (20,) 0 no rastreada, 1 inferida, 2 rastreada
    left: Hand = field(default_factory=Hand)
    right: Hand = field(default_factory=Hand)
    distance: float = 0.0           # metros al sensor
    proximity: float = 0.0          # 0 lejos .. 1 cerca
    pan: float = 0.0                # -1 .. 1 posición lateral (ideal para estéreo)
    lean: float = 0.0               # -1 .. 1 inclinación del torso
    hands_apart: float = 0.0        # 0 juntas .. 1 brazos abiertos
    energy: float = 0.0             # 0 quieto .. 1 muy activo
    clipped: list = field(default_factory=list)   # bordes por donde se sale del cuadro
    age: float = 0.0                # segundos en escena

    def joint(self, name):
        return self.joints[J[name]]

    def to_dict(self):
        def hand(h):
            return {"u": round(h.u, 4), "v": round(h.v, 4), "push": round(h.push, 3),
                    "speed": round(h.speed, 3), "raised": h.raised, "tracked": h.tracked}
        return {"slot": self.slot, "left": hand(self.left), "right": hand(self.right),
                "distance": round(self.distance, 3), "proximity": round(self.proximity, 3),
                "pan": round(self.pan, 3), "lean": round(self.lean, 3),
                "hands_apart": round(self.hands_apart, 3), "energy": round(self.energy, 3),
                "clipped": self.clipped}


class _State:
    """Memoria interna por persona."""

    def __init__(self, slot, t, min_cutoff, beta):
        self.slot, self.t_enter, self.t_seen = slot, t, t
        self.filter = OneEuro(min_cutoff, beta)
        self.reach = 0.55                       # hombro→muñeca en metros, se autocalibra
        self.prev = None                        # articulaciones filtradas anteriores
        self.hand_good = {"left": -1e9, "right": -1e9}
        self.pushing = {"left": False, "right": False}
        self.swipe_t = {"left": -1e9, "right": -1e9}
        self.swipe_run = {"left": 0, "right": 0}   # frames seguidos moviéndose rápido
        self.clap_armed = False
        self.hands_up = False
        self.energy = 0.0
        self.body = None


def _clip01(x):
    return float(min(1.0, max(0.0, x)))


class Tracker:
    """Convierte frames crudos en cuerpos filtrados, normalizados y con eventos.

    zone     tamaño de la zona de interacción (1.0 = llegar al borde sin estirarse
             del todo; más grande = hay que estirarse más)
    z_range  (cerca, lejos) en metros para normalizar `proximity`
    mirror   True = la proyección actúa como espejo (lo normal frente a una pantalla)
    hold     segundos que se mantiene el último valor cuando una mano se pierde
    """

    def __init__(self, source, max_bodies=2, min_cutoff=1.2, beta=6.0, zone=1.0,
                 z_range=(1.0, 3.5), mirror=True, hold=0.4, exit_after=1.0, recorder=None):
        self.source = source
        self.max_bodies = max_bodies
        self.min_cutoff, self.beta = min_cutoff, beta
        self.zone, self.z_range, self.hold = zone, z_range, hold
        self.sign = 1.0 if mirror else -1.0
        self.exit_after = exit_after   # segundos sin verse antes de emitir "exit"
        self.recorder = recorder
        self.events = []        # [(nombre, slot)] generados en el último update()
        self.bodies = []
        self.new_frame = False  # True si el último update() trajo datos nuevos
        self._states = {}
        self._t = None

    # ---- acceso directo a lo que entrega la fuente ----
    @property
    def color(self):
        return self.source.color

    @property
    def mask(self):
        return self.source.mask

    @property
    def depth(self):
        return getattr(self.source, "depth", None)

    def update(self):
        self.events = []
        raw = self.source.read()
        self.new_frame = raw is not None
        if raw is None:
            return self.bodies
        if self.recorder is not None:
            self.recorder.write(raw)

        t = raw["t"]
        dt = 1 / 30 if self._t is None else min(0.2, max(1 / 120, t - self._t))
        self._t = t

        # Los más cercanos tienen prioridad para ocupar un lugar libre
        used = {s.slot for s in self._states.values()}
        seen = {b["id"] for b in raw["bodies"]}
        for rb in sorted(raw["bodies"], key=lambda b: b["pos"][J["HipCenter"], 2]):
            st = self._states.get(rb["id"])
            if st is None:
                # ¿Es la misma persona con un TrackingId nuevo? (el SDK lo cambia cuando
                # pierde y recupera el esqueleto). Si está donde estaba, conserva su lugar.
                hip = rb["pos"][J["HipCenter"]]
                for old_id, old in self._states.items():
                    if (old_id not in seen and old.body is not None and
                            np.linalg.norm(old.body.joints[J["HipCenter"]] - hip) < 0.5):
                        st = self._states.pop(old_id)
                        self._states[rb["id"]] = st
                        break
            if st is None:
                free = [s for s in range(self.max_bodies) if s not in used]
                if not free:
                    continue
                st = _State(free[0], t, self.min_cutoff, self.beta)
                self._states[rb["id"]] = st
                used.add(st.slot)
                self.events.append(("enter", st.slot))
            st.t_seen = t
            st.body = self._process(rb, st, t, dt)

        for tid in [k for k, s in self._states.items() if t - s.t_seen > self.exit_after]:
            self.events.append(("exit", self._states.pop(tid).slot))

        self.bodies = sorted((s.body for s in self._states.values() if s.body is not None),
                             key=lambda b: b.slot)
        return self.bodies

    def _process(self, rb, st, t, dt):
        state = rb["state"]
        joints = st.filter(rb["pos"], dt)
        vel = np.zeros_like(joints) if st.prev is None else (joints - st.prev) / dt
        st.prev = joints
        old = st.body

        sc, hip = joints[J["ShoulderCenter"]], joints[J["HipCenter"]]

        # Autocalibrar el largo del brazo: la zona se adapta a niños y adultos
        arms = []
        for side in ("Left", "Right"):
            idx = [J["Shoulder" + side], J["Elbow" + side], J["Wrist" + side]]
            if all(state[i] == TRACKED for i in idx):
                s, e, w = (joints[i] for i in idx)
                arms.append(np.linalg.norm(e - s) + np.linalg.norm(w - e))
        if arms:
            st.reach += 0.02 * (min(0.8, max(0.35, float(np.mean(arms)))) - st.reach)
        reach = st.reach
        span = reach * self.zone

        hands = {}
        for key, side in (("left", "Left"), ("right", "Right")):
            hi, wi, si = J["Hand" + side], J["Wrist" + side], J["Shoulder" + side]
            prev = getattr(old, key) if old is not None else Hand()
            good = state[hi] == TRACKED or state[wi] == TRACKED
            if good:
                st.hand_good[key] = t
                h = joints[hi]
                speed = prev.speed + 0.4 * (float(np.linalg.norm(vel[hi])) - prev.speed)
                hand = Hand(
                    u=_clip01(0.5 + self.sign * (h[0] - sc[0]) / (2 * span)),
                    v=_clip01(0.5 - (h[1] - (sc[1] - 0.15 * reach)) / (1.6 * span)),
                    push=_clip01((joints[si][2] - h[2]) / reach),
                    speed=speed,
                    raised=bool(h[1] > sc[1] + (0.0 if prev.raised else 0.06)),
                    tracked=True, pos=h.copy())
            else:
                # Mano inferida/oculta: congelar el último valor bueno en vez de saltar
                hand = Hand(prev.u, prev.v, prev.push, prev.speed * 0.8, prev.raised,
                            (t - st.hand_good[key]) < self.hold, prev.pos)
            hands[key] = hand

            # --- eventos por mano (con histéresis para que no se repitan) ---
            if hand.tracked:
                if not st.pushing[key] and hand.push > 0.8:
                    st.pushing[key] = True
                    self.events.append(("push_" + key, st.slot))
                elif st.pushing[key] and hand.push < 0.55:
                    st.pushing[key] = False
            # Swipe: rápido y SOSTENIDO en la misma dirección (un salto de 1 frame no cuenta)
            vx = vel[hi][0] * self.sign if good else 0.0
            run = st.swipe_run[key]
            if abs(vx) > 1.2 and (run == 0 or (run > 0) == (vx > 0)):
                run += 1 if vx > 0 else -1
            else:
                run = 0
            if abs(run) >= 4 and t - st.swipe_t[key] > 0.6:
                st.swipe_t[key] = t
                self.events.append(("swipe_right" if run > 0 else "swipe_left", st.slot))
                run = 0
            st.swipe_run[key] = run

        L, R = hands["left"], hands["right"]
        both = L.tracked and R.tracked
        gap = float(np.linalg.norm(L.pos - R.pos)) if both else None
        if gap is not None:
            if gap > 0.30:
                st.clap_armed = True
            elif gap < 0.12 and st.clap_armed:
                st.clap_armed = False
                self.events.append(("clap", st.slot))
        up = both and L.raised and R.raised
        if up and not st.hands_up:
            self.events.append(("hands_up", st.slot))
        st.hands_up = up

        st.energy += 0.15 * (_clip01((L.speed + R.speed) / 3.0) - st.energy)
        z0, z1 = self.z_range
        torso = max(0.2, sc[1] - hip[1])
        return Body(
            slot=st.slot, id=rb["id"], joints=joints, state=state, left=L, right=R,
            distance=float(hip[2]),
            proximity=_clip01(1.0 - (hip[2] - z0) / (z1 - z0)),
            pan=float(np.clip(self.sign * hip[0] / 1.2, -1, 1)),
            lean=float(np.clip(self.sign * (sc[0] - hip[0]) / torso / 0.5, -1, 1)),
            hands_apart=_clip01(gap / (2 * reach + 0.35)) if gap is not None
            else (old.hands_apart if old is not None else 0.0),
            energy=st.energy, clipped=rb["clip"], age=t - st.t_enter)

    def close(self):
        if self.recorder is not None:
            self.recorder.close()
        self.source.close()


# =====================================================================
#  OSC (TouchDesigner, Processing, Pure Data, SuperCollider, Max...)
# =====================================================================

class OscOut:
    """
    /auralis/count            n
    /auralis/p{0|1}/right     u v push speed raised tracked
    /auralis/p{0|1}/left      u v push speed raised tracked
    /auralis/p{0|1}/body      proximity pan lean hands_apart energy
    /auralis/event            nombre slot
    """

    def __init__(self, host="127.0.0.1", port=9000):
        from pythonosc.udp_client import SimpleUDPClient
        self._c = SimpleUDPClient(host, port)

    def send(self, bodies, events=()):
        self._c.send_message("/auralis/count", len(bodies))
        for b in bodies:
            base = f"/auralis/p{b.slot}"
            for key in ("left", "right"):
                h = getattr(b, key)
                self._c.send_message(f"{base}/{key}", [float(h.u), float(h.v), float(h.push),
                                                       float(h.speed), int(h.raised), int(h.tracked)])
            self._c.send_message(f"{base}/body", [float(b.proximity), float(b.pan), float(b.lean),
                                                  float(b.hands_apart), float(b.energy)])
        for name, slot in events:
            self._c.send_message("/auralis/event", [name, int(slot)])


# =====================================================================
#  DEMO / DEPURACIÓN
# =====================================================================

def project(p, f=COLOR_F, c=COLOR_C):
    """Punto 3D (m) → píxel de la imagen de color. Aproximado, solo para dibujar."""
    z = max(float(p[2]), 0.1)
    return int(c[0] + p[0] * f / z), int(c[1] - p[1] * f / z)


def draw_debug(frame, bodies, events_log, fps):
    import cv2
    colors = [(0, 255, 0), (255, 160, 0)]
    for b in bodies:
        col = colors[b.slot % 2]
        px = [project(p) for p in b.joints]
        for a, c in BONES:
            ia, ic = J[a], J[c]
            if b.state[ia] and b.state[ic]:
                solid = b.state[ia] == TRACKED and b.state[ic] == TRACKED
                cv2.line(frame, px[ia], px[ic], col if solid else (90, 90, 90), 2 if solid else 1)
        for i, p in enumerate(px):
            if b.state[i]:
                cv2.circle(frame, p, 4, col if b.state[i] == TRACKED else (0, 0, 255), -1)
        for key, h in (("L", b.left), ("R", b.right)):
            if h.tracked:
                cv2.circle(frame, project(h.pos), int(8 + 22 * h.push), (0, 255, 255), 2)
            # mini-panel del cursor normalizado
            ox, oy = 10 + b.slot * 150 + (0 if key == "L" else 70), 400
            cv2.rectangle(frame, (ox, oy), (ox + 60, oy + 60), (255, 255, 255), 1)
            cv2.circle(frame, (ox + int(60 * h.u), oy + int(60 * h.v)), 4,
                       (0, 255, 255) if h.tracked else (0, 0, 255), -1)
            cv2.putText(frame, key, (ox + 2, oy - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, col, 1)
        y0 = 20 + b.slot * 62
        lines = [
            f"P{b.slot} dist={b.distance:.2f}m prox={b.proximity:.2f} pan={b.pan:+.2f} lean={b.lean:+.2f}",
            f"   R u={b.right.u:.2f} v={b.right.v:.2f} push={b.right.push:.2f} v={b.right.speed:.1f}m/s",
            f"   L u={b.left.u:.2f} v={b.left.v:.2f} push={b.left.push:.2f} apart={b.hands_apart:.2f} "
            f"energy={b.energy:.2f}",
        ]
        if b.clipped:
            lines[0] += "  FUERA: " + ",".join(b.clipped)
        for k, text in enumerate(lines):
            cv2.putText(frame, text, (10, y0 + 18 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)
    if not bodies:
        cv2.putText(frame, "BUSCANDO...", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
    for k, text in enumerate(events_log[-5:]):
        cv2.putText(frame, text, (470, 400 + 16 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
    cv2.putText(frame, f"{fps:.0f} fps", (570, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    return frame


def main():
    import argparse
    import cv2

    ap = argparse.ArgumentParser(description="AURALIS LAB - entrada Kinect")
    ap.add_argument("--replay", help="reproducir grabación .jsonl (sin Kinect)")
    ap.add_argument("--record", help="grabar sesión a .jsonl")
    ap.add_argument("--osc", help="host:puerto para enviar OSC, p. ej. 127.0.0.1:9000")
    ap.add_argument("--silhouette", action="store_true", help="mostrar máscara de silueta")
    ap.add_argument("--no-color", action="store_true", help="no leer la cámara RGB (más rápido)")
    ap.add_argument("--seated", action="store_true", help="modo sentado (solo torso y brazos)")
    ap.add_argument("--tilt", type=int, help="inclinación del motor, -27..27")
    args = ap.parse_args()

    if args.replay:
        source = ReplaySource(args.replay)
    else:
        source = KinectSource(color=not args.no_color, silhouette=args.silhouette,
                              seated=args.seated, tilt=args.tilt)
    tracker = Tracker(source, recorder=Recorder(args.record) if args.record else None)
    osc = None
    if args.osc:
        host, port = args.osc.rsplit(":", 1)
        osc = OscOut(host, int(port))

    print("AURALIS LAB listo. Q para salir.")
    log, fps, last = [], 30.0, time.perf_counter()
    try:
        while True:
            bodies = tracker.update()
            if tracker.new_frame:
                now = time.perf_counter()
                fps += 0.1 * (1.0 / max(1e-3, now - last) - fps)
                last = now
                for name, slot in tracker.events:
                    log.append(f"P{slot} {name}")
                    print(log[-1])
                if osc:
                    osc.send(bodies, tracker.events)

                frame = tracker.color
                frame = np.zeros((480, 640, 3), np.uint8) if frame is None else frame
                cv2.imshow("AURALIS LAB - Skeleton", draw_debug(frame, bodies, log, fps))
                if tracker.mask is not None:
                    cv2.imshow("AURALIS LAB - Silueta",
                               cv2.resize((tracker.mask > 0).astype(np.uint8) * 255, (640, 480),
                                          interpolation=cv2.INTER_NEAREST))
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        tracker.close()
        cv2.destroyAllWindows()
        print("Kinect detenido.")


if __name__ == "__main__":
    main()
