#!/usr/bin/env bash
# Uso:
#   ./run_linux.sh                    -> abre SCRIPT_POR_DEFECTO
#   ./run_linux.sh otro.py [args]     -> ejecuta otro script de esta carpeta
#   ./run_linux.sh --check            -> diagnóstico (kinect_check.py)
#   ./run_linux.sh --list             -> lista scripts y compatibilidad
#   KINECT_SCRIPT=auralis_visuals.py ./run_linux.sh   -> cambia el defecto sin editar

# =====================================================================
#  CONFIGURACIÓN MANUAL  (edita aquí)
# =====================================================================
# Archivo .py que se abre cuando no se indica ninguno:
SCRIPT_POR_DEFECTO="auralis_kinect.py"

# Script usado por --check:
SCRIPT_CHECK="kinect_check.py"

# Scripts que se bloquean SIEMPRE en Linux (excepciones manuales),
# además de los detectados automáticamente. Separados por espacio.
EXCEPCIONES_SOLO_WINDOWS="kinect_stream.py kinect_skeleton.py test_sdk.py kinect_test.py"

# Rutas
FN="$HOME/Documentos/Programacion/tareas/libfreenect/build"
# =====================================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$DIR/../.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

# Librerías del Kinect (libfreenect)
export PYTHONPATH="$FN/wrappers/python/python3:$DIR${PYTHONPATH:+:$PYTHONPATH}"
export LD_LIBRARY_PATH="$FN/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GLOG_minloglevel=2 TF_CPP_MIN_LOG_LEVEL=2
# Evita los avisos de Qt/Wayland del cv2 del venv
export QT_QPA_PLATFORM=xcb
export QT_QPA_FONTDIR=/usr/share/fonts

# Es "solo Windows" si está en la lista manual o usa pythonnet (clr) a nivel
# de módulo (columna 0) o DirectShow. Un "import clr" indentado (dentro de una
# clase/función, como en auralis_kinect.py) NO cuenta: ese script tiene backend Linux.
solo_windows() {
  local nombre
  nombre="$(basename "$1")"
  for x in $EXCEPCIONES_SOLO_WINDOWS; do
    [ "$x" = "$nombre" ] && return 0
  done
  grep -q -E "^(import clr|from clr )|CAP_DSHOW" "$1"
}

case "$1" in
  --check)
    exec "$PY" "$DIR/$SCRIPT_CHECK"
    ;;
  --list)
    for f in "$DIR"/*.py; do
      if solo_windows "$f"; then
        printf " [Solo Windows] %s\n" "$(basename "$f")"
      else
        printf " [Linux OK]     %s\n" "$(basename "$f")"
      fi
    done
    exit 0
    ;;
esac

# ¿El primer argumento es un script .py?
if [[ "$1" == *.py ]]; then
  if [ -f "$DIR/$1" ]; then
    SCRIPT="$DIR/$1"
  elif [ -f "$1" ]; then
    SCRIPT="$(realpath "$1")"
  else
    echo "No existe el script: $1" >&2
    echo "Scripts disponibles: ./run_linux.sh --list" >&2
    exit 1
  fi
  shift
else
  SCRIPT="$DIR/${KINECT_SCRIPT:-$SCRIPT_POR_DEFECTO}"
  if [ ! -f "$SCRIPT" ]; then
    echo "No existe el script por defecto: $SCRIPT" >&2
    echo "Edita SCRIPT_POR_DEFECTO en run_linux.sh o usa --list" >&2
    exit 1
  fi
fi

if solo_windows "$SCRIPT"; then
  echo "AVISO: $(basename "$SCRIPT") usa el SDK de Microsoft (clr) o DirectShow" >&2
  echo "       y solo funciona en Windows. En Linux usa auralis_kinect.py," >&2
  echo "       auralis_visuals.py o --check. Ver ./run_linux.sh --list" >&2
  exit 2
fi

cd "$DIR" || exit 1
exec "$PY" "$SCRIPT" "$@"
