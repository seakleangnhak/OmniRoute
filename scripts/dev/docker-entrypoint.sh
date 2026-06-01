#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
RUN_USER="${OMNIROUTE_RUN_USER:-node}"
RUN_GROUP="${OMNIROUTE_RUN_GROUP:-node}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"

  if [ "${OMNIROUTE_SKIP_DATA_CHOWN:-0}" != "1" ]; then
    chown -R "$RUN_USER:$RUN_GROUP" "$DATA_DIR" || {
      echo "[docker-entrypoint] Failed to chown DATA_DIR=$DATA_DIR to $RUN_USER:$RUN_GROUP" >&2
      echo "[docker-entrypoint] Fix the mounted volume permissions or set OMNIROUTE_SKIP_DATA_CHOWN=1 if ownership is already correct." >&2
      exit 1
    }
  fi

  if ! gosu "$RUN_USER" sh -c 'dir="${DATA_DIR:-/app/data}"; mkdir -p "$dir"; probe="$dir/.omniroute-write-test-$$"; : > "$probe" && rm -f "$probe"'; then
    echo "[docker-entrypoint] DATA_DIR is not writable by $RUN_USER: $DATA_DIR" >&2
    echo "[docker-entrypoint] Make the Docker volume writable by UID/GID 1000, or mount a writable DATA_DIR." >&2
    exit 1
  fi

  exec gosu "$RUN_USER" "$@"
fi

exec "$@"
