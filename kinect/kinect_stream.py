
import clr
import sys
import cv2
import numpy as np

from System import Array, Byte, UInt16

# Ruta del SDK Kinect 1.8
sdk_path = r"C:\Program Files\Microsoft SDKs\Kinect\v1.8\Assemblies"
sys.path.append(sdk_path)

clr.AddReference("Microsoft.Kinect")

from Microsoft.Kinect import (
    KinectSensor,
    ColorImageFormat,
    DepthImageFormat
)

# Buscar Kinect conectado
sensors = KinectSensor.KinectSensors

if sensors.Count == 0:
    print("No se encontró ningún Kinect.")
    sys.exit()

sensor = None

for s in sensors:
    if str(s.Status) == "Connected":
        sensor = s
        break

if sensor is None:
    print("El Kinect no está conectado.")
    sys.exit()

print("Kinect conectado correctamente.")

# Activar RGB
sensor.ColorStream.Enable(
    ColorImageFormat.RgbResolution640x480Fps30
)

# Activar profundidad
sensor.DepthStream.Enable(
    DepthImageFormat.Resolution640x480Fps30
)

# Iniciar sensor
sensor.Start()

print("Cámara RGB y profundidad activadas.")
print("Presiona Q para salir.")

try:
    while True:

        # ================= RGB =================

        color_frame = sensor.ColorStream.OpenNextFrame(0)

        if color_frame is not None:
            try:
                width = color_frame.Width
                height = color_frame.Height

                pixels = Array[Byte](color_frame.PixelDataLength)

                color_frame.CopyPixelDataTo(pixels)

                image = np.frombuffer(
                    bytes(pixels),
                    dtype=np.uint8
                )

                image = image.reshape((height, width, 4))

                rgb = cv2.cvtColor(
                    image,
                    cv2.COLOR_BGRA2BGR
                )

                cv2.imshow("Kinect RGB", rgb)

            finally:
                color_frame.Dispose()

        # ================= DEPTH =================

        depth_frame = sensor.DepthStream.OpenNextFrame(0)

        if depth_frame is not None:
            try:
                width = depth_frame.Width
                height = depth_frame.Height

                depth_data = Array[UInt16](
                    depth_frame.PixelDataLength
                )

                depth_frame.CopyPixelDataTo(depth_data)

                depth = np.frombuffer(
                    bytes(depth_data),
                    dtype=np.uint16
                ).copy()

                depth = depth.reshape((height, width))

                # Eliminar bits del índice del jugador
                distance = depth >> 3

                # Visualización en escala de grises
                depth_image = np.clip(
                    distance / 4500 * 255,
                    0,
                    255
                ).astype(np.uint8)

                cv2.imshow("Kinect Depth", depth_image)

            finally:
                depth_frame.Dispose()

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

finally:
    sensor.Stop()
    cv2.destroyAllWindows()
    print("Kinect desconectado correctamente.")
