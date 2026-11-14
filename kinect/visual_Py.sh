#!/usr/bin/env bash
# Lanza los visuales de AURALIS (auralis_visuals.py).
# Uso:
#   ./visual_Py.sh                       -> visuales con Kinect
#   ./visual_Py.sh --fullscreen --solo   -> argumentos de auralis_visuals.py
#   ./visual_Py.sh --replay grab.jsonl   -> sin Kinect
#   ./visual_Py.sh --record grab.jsonl   -> graba la sesión
# Para verificar la conexión del Kinect usa: ./run_linux.sh --check

# =====================================================================
#  CONFIGURACIÓN MANUAL  (edita aquí)
# =====================================================================
SCRIPT_VISUAL="auralis_visuals.py"
FN="$HOME/Documentos/Programacion/tareas/libfreenect/build"
# =====================================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$DIR/../.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

export PYTHONPATH="$FN/wrappers/python/python3:$DIR${PYTHONPATH:+:$PYTHONPATH}"
export LD_LIBRARY_PATH="$FN/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GLOG_minloglevel=2 TF_CPP_MIN_LOG_LEVEL=2
export QT_QPA_PLATFORM=xcb
export QT_QPA_FONTDIR=/usr/share/fonts

if [ ! -f "$DIR/$SCRIPT_VISUAL" ]; then
  echo "No existe $SCRIPT_VISUAL en $DIR" >&2
  exit 1
fi

if pgrep -f "[k]inect_check.py" >/dev/null; then
  echo "AVISO: kinect_check.py sigue abierto y ocupa el Kinect. Ciérralo: pkill -f kinect_check.py" >&2
fi

cd "$DIR" || exit 1
exec "$PY" "$DIR/$SCRIPT_VISUAL" "$@"
