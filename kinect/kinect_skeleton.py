
import clr
import sys
import cv2
import numpy as np

from System import Array, Byte

# ================= SDK =================

sdk_path = r"C:\Program Files\Microsoft SDKs\Kinect\v1.8\Assemblies"
sys.path.append(sdk_path)

clr.AddReference("Microsoft.Kinect")

from Microsoft.Kinect import (
    KinectSensor,
    ColorImageFormat,
    Skeleton,
    SkeletonTrackingState,
    JointTrackingState,
    JointType
)

# ================= SENSOR =================

sensor = None

for s in KinectSensor.KinectSensors:
    if str(s.Status) == "Connected":
        sensor = s
        break

if sensor is None:
    print("No se encontró Kinect.")
    sys.exit()

# Activar RGB y esqueleto
sensor.ColorStream.Enable(
    ColorImageFormat.RgbResolution640x480Fps30
)

sensor.SkeletonStream.Enable()

sensor.Start()

print("Kinect iniciado.")
print("Buscando personas... Presiona Q para salir.")

# Articulaciones principales
joints_to_draw = [
    JointType.Head,
    JointType.ShoulderCenter,
    JointType.ShoulderLeft,
    JointType.ShoulderRight,
    JointType.ElbowLeft,
    JointType.ElbowRight,
    JointType.WristLeft,
    JointType.WristRight,
    JointType.HandLeft,
    JointType.HandRight,
    JointType.Spine,
    JointType.HipCenter,
    JointType.HipLeft,
    JointType.HipRight,
    JointType.KneeLeft,
    JointType.KneeRight,
    JointType.FootLeft,
    JointType.FootRight
]

try:
    while True:

        color_frame = sensor.ColorStream.OpenNextFrame(0)
        skeleton_frame = sensor.SkeletonStream.OpenNextFrame(0)

        if color_frame is None or skeleton_frame is None:
            if color_frame is not None:
                color_frame.Dispose()
            if skeleton_frame is not None:
                skeleton_frame.Dispose()
            cv2.waitKey(1)
            continue

        try:
            # ================= RGB =================

            pixels = Array[Byte](color_frame.PixelDataLength)
            color_frame.CopyPixelDataTo(pixels)

            image = np.frombuffer(
                bytes(pixels), dtype=np.uint8
            ).reshape((480, 640, 4))

            frame = cv2.cvtColor(
                image, cv2.COLOR_BGRA2BGR
            )

            # ================= SKELETON =================

            skeletons = Array[Skeleton](
                skeleton_frame.SkeletonArrayLength
            )

            skeleton_frame.CopySkeletonDataTo(skeletons)

            person_found = False

            for person in skeletons:

                if person.TrackingState != SkeletonTrackingState.Tracked:
                    continue

                person_found = True

                # Dibujar articulaciones
                for joint_type in joints_to_draw:

                    joint = person.Joints[joint_type]

                    if joint.TrackingState == JointTrackingState.NotTracked:
                        continue

                    point = sensor.CoordinateMapper.MapSkeletonPointToColorPoint(
                        joint.Position,
                        ColorImageFormat.RgbResolution640x480Fps30
                    )

                    x = int(point.X)
                    y = int(point.Y)

                    if 0 <= x < 640 and 0 <= y < 480:

                        cv2.circle(
                            frame,
                            (x, y),
                            5,
                            (0, 255, 0),
                            -1
                        )

                        if joint_type in [
                            JointType.HandLeft,
                            JointType.HandRight
                        ]:
                            cv2.putText(
                                frame,
                                str(joint_type),
                                (x + 10, y),
                                cv2.FONT_HERSHEY_SIMPLEX,
                                0.5,
                                (0, 255, 255),
                                1
                            )

                # Coordenadas de la mano derecha
                hand = person.Joints[JointType.HandRight]

                if hand.TrackingState != JointTrackingState.NotTracked:

                    p = hand.Position

                    cv2.putText(
                        frame,
                        f"Hand Right: X={p.X:.2f} Y={p.Y:.2f} Z={p.Z:.2f} m",
                        (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.55,
                        (0, 255, 0),
                        2
                    )

            if person_found:
                cv2.putText(
                    frame,
                    "PERSON DETECTED",
                    (10, 60),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (0, 255, 0),
                    2
                )
            else:
                cv2.putText(
                    frame,
                    "SEARCHING...",
                    (10, 60),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (0, 0, 255),
                    2
                )

            cv2.imshow("AURALIS LAB - Skeleton Tracking", frame)

        finally:
            color_frame.Dispose()
            skeleton_frame.Dispose()

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

finally:
    sensor.Stop()
    cv2.destroyAllWindows()
    print("Kinect detenido.")
