#!/usr/bin/env bash
# Body tracker: controla la página de VISORA/Aerosols con las manos (Kinect).
# Uso:
#   ./body_tracker.sh                -> abre navegador + vista previa en la página
#   ./body_tracker.sh --window       -> además, vista previa en ventana
#   ./body_tracker.sh --no-browser   -> solo servidor (abre tú la URL)
# Para cambiar la carpeta/página: edita PAGINA_DIR y PAGINA en body_tracker.py

FN="$HOME/Documentos/Programacion/tareas/libfreenect/build"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$DIR/../.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

export PYTHONPATH="$FN/wrappers/python/python3:$DIR${PYTHONPATH:+:$PYTHONPATH}"
export LD_LIBRARY_PATH="$FN/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GLOG_minloglevel=2 TF_CPP_MIN_LOG_LEVEL=2
export QT_QPA_PLATFORM=xcb
export QT_QPA_FONTDIR=/usr/share/fonts

if pgrep -f "[k]inect_check.py|[a]uralis_visuals.py" >/dev/null; then
  echo "AVISO: otro programa usa el Kinect (kinect_check/auralis_visuals). Ciérralo primero." >&2
fi

cd "$DIR" || exit 1
exec "$PY" "$DIR/body_tracker.py" "$@"
