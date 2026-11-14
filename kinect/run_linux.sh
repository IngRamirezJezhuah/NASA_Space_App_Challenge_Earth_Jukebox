#!/usr/bin/env bash
# Uso: ./run_linux.sh [args]    |    ./run_linux.sh --check   (diagnóstico con ventana)
#  ./run_linux.sh
#  ./run_linux.sh
#
#Directorios de carpetas
DIR="$(cd "$(dirname "$0")" && pwd)"
FN=~/Documentos/Programacion/tareas/libfreenect/build
PY="$DIR/../.venv/bin/python"

# Ecport para las librerias del kinect
export PYTHONPATH="$FN/wrappers/python/python3:$DIR${PYTHONPATH:+:$PYTHONPATH}"
export LD_LIBRARY_PATH="$FN/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GLOG_minloglevel=2 TF_CPP_MIN_LOG_LEVEL=2


#if [ "$1" = "--check" ]; then
#  exec "$DIR/../.venv/bin/python" "$DIR/kinect_check.py"
#fi
#exec "$DIR/../.venv/bin/python" "$DIR/auralis_kinect.py" "$@"

# un Scriot es "solo windows" si usa pythonnet (clr) o DirectShow
solo_windows() {
  grep -q -E "^[[:space:]]*import clr|CAP_DSHOW" "$1"
}

  case "$1" in
    --check)
      exec "$PY" "$DIR/kinect_chech.py"
      ;;
    --list)
      for f in "$DIR"/*.py; do
        if solo_windows "$f"; then
          printf " [Solo Windows] %s\n" "$(basename "$f")"
        else
          printf " [Linux Ok] %s\n" "$(basename "$f")"
        fi
      done
      exit 0
      ;;
  esac

  # ¿El primer argumento es un script.p
  if [[ "$1" == *.py ]]; then
    if [ -f "$DIR/$1" ]; then
      SCRIPT="$(realpath "$1")"
    elif [ -f "$DIR/$1" ]; then
      SCRIPT="$DIR/$1"
    else
      echo "No Exise el script : $1" >&2
      echo "Scripts disponibles: ./run_linux.sh --list" >&2
      exit 1
    fi
    shift
    if solo_windows "$SCRIPT"; then
      echo "AVISO: $(basename "$SCRIPT") usa ek SDK de Microsoft clr o DirecShow," >&2
      echo " OSlo funciona en Windows . En linux usa auralist:kinect.py, auralist_visuals.py">&2
      echo "         o --check. Ver ./run_linux.sh --list">&2
      exit 2
    fi
  else
    SCRIPT="$DIR/airalis_kinect.py"
  fi

  #

