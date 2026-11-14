
import clr
import sys

sdk_path = r"C:\Program Files\Microsoft SDKs\Kinect\v1.8\Assemblies"

sys.path.append(sdk_path)

clr.AddReference("Microsoft.Kinect")

from Microsoft.Kinect import KinectSensor

print("SDK Kinect cargado correctamente")

sensors = KinectSensor.KinectSensors

print("Sensores encontrados:", sensors.Count)

for sensor in sensors:
    print("Estado:", sensor.Status)
