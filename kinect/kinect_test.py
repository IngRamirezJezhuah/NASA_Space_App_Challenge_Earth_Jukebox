import cv2

def main():
    print("Buscando el sensor Kinect con DirectShow...")
    
    cap = None
    indice_activo = -1

    # Probamos del índice 1 al 3 usando DirectShow (DSHOW) en lugar de MSMF
    for i in range(1, 4):
        print(f"Intentando conectar con el índice {i} (DSHOW)...")
        temp_cap = cv2.VideoCapture(i, cv2.CAP_DSHOW)
        if temp_cap.isOpened():
            ret, frame = temp_cap.read()
            if ret and frame is not None:
                indice_activo = i
                cap = temp_cap
                print(f"¡Kinect conectado con éxito en el índice {indice_activo}!")
                break
            else:
                temp_cap.release()

    if cap is None or not cap.isOpened():
        print("No se pudo conectar con el Kinect. Comprueba que esté conectado al puerto USB y con su fuente de alimentación.")
        return

    print(f"Transmitiendo desde el índice {indice_activo}. Presiona 'q' en la ventana de vídeo para salir.")

    while True:
        ret, frame = cap.read()
        
        if not ret:
            print("Error al recibir fotogramas del sensor.")
            break

        # Mostrar el streaming en tiempo real
        cv2.imshow("Kinect v1 RGB Stream", frame)

        # Salir al presionar la tecla 'q'
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()