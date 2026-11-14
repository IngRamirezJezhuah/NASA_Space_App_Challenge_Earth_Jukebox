"""
kinect_check.py — Diagnóstico del Kinect v1 en Linux (sin MediaPipe).
Abre una ventana con RGB + profundidad y un panel de estado.
Si la ventana muestra imagen, el Kinect está conectado y con corriente.  Q para salir.
"""
import subprocess
import sys
import time

import cv2
import numpy as np


def usb_state():
    out = subprocess.run(["lsusb"], capture_output=True, text=True).stdout
    ids = {"02c2": "Motor", "02ae": "Camara", "02ad": "Audio"}
    found = {n: (f"045e:{i}" in out) for i, n in ids.items()}
    try:
        gspca = "gspca_kinect" in open("/proc/modules").read()
    except OSError:
        gspca = False
    return found, gspca


def panel(lines, w=1280, h=140):
    img = np.zeros((h, w, 3), np.uint8)
    for i, (txt, ok) in enumerate(lines):
        col = (0, 200, 0) if ok else (0, 0, 255)
        cv2.putText(img, txt, (15, 28 + i * 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 1, cv2.LINE_AA)
    return img


def main():
    found, gspca = usb_state()
    lines = [
        (f"USB Motor:  {'OK' if found['Motor'] else 'NO DETECTADO'}", found["Motor"]),
        (f"USB Camara: {'OK (hay corriente de 12 V)' if found['Camara'] else 'NO DETECTADO -> sin fuente de 12 V o cable'}", found["Camara"]),
        (f"USB Audio:  {'OK' if found['Audio'] else 'NO DETECTADO'}", found["Audio"]),
        (f"Driver gspca_kinect: {'CARGADO -> sudo modprobe -r gspca_kinect' if gspca else 'descargado (bien)'}", not gspca),
    ]
    try:
        import freenect
    except ImportError as e:
        lines.append((f"No se pudo importar freenect: {e}", False))
        freenect = None

    t0, fps, last = time.perf_counter(), 0.0, time.perf_counter()
    err_shown = False
    while True:
        rgb = depth_img = None
        if freenect and not gspca:
            v = freenect.sync_get_video(0, freenect.VIDEO_RGB)
            d = freenect.sync_get_depth(0, freenect.DEPTH_MM)
            if v is not None and d is not None:
                rgb = np.ascontiguousarray(v[0][:, :, ::-1])
                dm = d[0].astype(np.float32)
                g = np.clip(dm / 4000 * 255, 0, 255).astype(np.uint8)
                g[dm == 0] = 0
                depth_img = cv2.applyColorMap(255 - g, cv2.COLORMAP_JET)
                depth_img[dm == 0] = 0
        if rgb is None:
            rgb = np.zeros((480, 640, 3), np.uint8)
            depth_img = np.zeros((480, 640, 3), np.uint8)
            msg = "SIN IMAGEN: Kinect no accesible" if (freenect and not gspca) else "Resuelve los puntos en rojo"
            cv2.putText(rgb, msg, (30, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2, cv2.LINE_AA)
            status = ("DESCONECTADO / SIN CORRIENTE", (0, 0, 255))
            time.sleep(0.1)
        else:
            now = time.perf_counter()
            fps += 0.1 * (1 / max(1e-3, now - last) - fps)
            last = now
            status = (f"CONECTADO Y CON CORRIENTE  ({fps:.0f} fps)", (0, 200, 0))
        cv2.putText(rgb, status[0], (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, status[1], 2, cv2.LINE_AA)
        cv2.imshow("Kinect v1 - diagnostico (Q salir)", np.vstack([np.hstack([rgb, depth_img]), panel(lines)]))
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
    try:
        freenect.sync_stop()
    except Exception:
        pass
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
