#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${NETWORK_DIR}/docker-compose.fabric.yml"

cd "${NETWORK_DIR}"

if [ "${1:-}" = "--volumes" ]; then
  docker compose -f "${COMPOSE_FILE}" down --volumes --remove-orphans
else
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans
fi

echo "LGSV HR Fabric network stopped."
