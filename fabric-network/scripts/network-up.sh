#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${NETWORK_DIR}/docker-compose.fabric.yml"
TOOLS_IMAGE="${FABRIC_TOOLS_IMAGE:-hyperledger/fabric-tools:2.5}"
CHANNEL_NAME="${FABRIC_CHANNEL_NAME:-lgsvhr-payroll-channel}"
SYSTEM_CHANNEL_NAME="${FABRIC_SYSTEM_CHANNEL_NAME:-lgsvhr-system-channel}"

cd "${NETWORK_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Start Docker Desktop and try again." >&2
  exit 1
fi

if [ "${1:-}" = "--regenerate" ]; then
  echo "Regenerating Fabric crypto material and channel artifacts..."
  rm -rf "${NETWORK_DIR}/organizations" "${NETWORK_DIR}/channel-artifacts"
fi

mkdir -p "${NETWORK_DIR}/organizations" "${NETWORK_DIR}/channel-artifacts"

if [ ! -d "${NETWORK_DIR}/organizations/ordererOrganizations/lgsvhr.com" ]; then
  docker run --rm \
    -v "${NETWORK_DIR}:/network" \
    -w /network \
    "${TOOLS_IMAGE}" \
    cryptogen generate --config=crypto-config.yaml --output=organizations
fi

if [ ! -f "${NETWORK_DIR}/channel-artifacts/genesis.block" ]; then
  docker run --rm \
    -v "${NETWORK_DIR}:/network" \
    -w /network \
    -e FABRIC_CFG_PATH=/network \
    "${TOOLS_IMAGE}" \
    configtxgen -profile LGSVHRGenesis -channelID "${SYSTEM_CHANNEL_NAME}" -outputBlock channel-artifacts/genesis.block
fi

if [ ! -f "${NETWORK_DIR}/channel-artifacts/${CHANNEL_NAME}.tx" ]; then
  docker run --rm \
    -v "${NETWORK_DIR}:/network" \
    -w /network \
    -e FABRIC_CFG_PATH=/network \
    "${TOOLS_IMAGE}" \
    configtxgen -profile LGSVHRPayrollChannel -outputCreateChannelTx "channel-artifacts/${CHANNEL_NAME}.tx" -channelID "${CHANNEL_NAME}"
fi

if [ ! -f "${NETWORK_DIR}/channel-artifacts/HRMSPanchors.tx" ]; then
  docker run --rm \
    -v "${NETWORK_DIR}:/network" \
    -w /network \
    -e FABRIC_CFG_PATH=/network \
    "${TOOLS_IMAGE}" \
    configtxgen -profile LGSVHRPayrollChannel -outputAnchorPeersUpdate channel-artifacts/HRMSPanchors.tx -channelID "${CHANNEL_NAME}" -asOrg HRMSP
fi

if [ ! -f "${NETWORK_DIR}/channel-artifacts/PayrollMSPanchors.tx" ]; then
  docker run --rm \
    -v "${NETWORK_DIR}:/network" \
    -w /network \
    -e FABRIC_CFG_PATH=/network \
    "${TOOLS_IMAGE}" \
    configtxgen -profile LGSVHRPayrollChannel -outputAnchorPeersUpdate channel-artifacts/PayrollMSPanchors.tx -channelID "${CHANNEL_NAME}" -asOrg PayrollMSP
fi

docker compose -f "${COMPOSE_FILE}" up -d \
  orderer.lgsvhr.com \
  peer0.hr.lgsvhr.com \
  peer0.payroll.lgsvhr.com \
  cli

verify_main_node() {
  local service="$1"
  local max_attempts=20
  local attempt=1
  local container_id=""
  local state=""

  while [ "${attempt}" -le "${max_attempts}" ]; do
    container_id="$(docker compose -f "${COMPOSE_FILE}" ps -aq "${service}")"
    if [ -n "${container_id}" ]; then
      state="$(docker inspect --format '{{.State.Status}}' "${container_id}")"
      if [ "${state}" = "running" ]; then
        echo "Verified ${service} is running."
        return 0
      fi

      if [ "${state}" = "exited" ] || [ "${state}" = "dead" ]; then
        echo "ERROR: ${service} exited during LGSV HR Fabric startup." >&2
        docker compose -f "${COMPOSE_FILE}" logs --tail 100 "${service}" >&2 || true
        return 1
      fi
    fi

    sleep 2
    attempt=$((attempt + 1))
  done

  echo "ERROR: ${service} did not reach a running state within $((max_attempts * 2)) seconds." >&2
  docker compose -f "${COMPOSE_FILE}" ps "${service}" >&2 || true
  docker compose -f "${COMPOSE_FILE}" logs --tail 100 "${service}" >&2 || true
  return 1
}

verify_main_node orderer.lgsvhr.com
verify_main_node peer0.hr.lgsvhr.com
verify_main_node peer0.payroll.lgsvhr.com

echo "LGSV HR Fabric network is running."
echo "Main blockchain nodes verified: orderer.lgsvhr.com, peer0.hr.lgsvhr.com, peer0.payroll.lgsvhr.com"
echo "Next: ./scripts/create-channel.sh"
