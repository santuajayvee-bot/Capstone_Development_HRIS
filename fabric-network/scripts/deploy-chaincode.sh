#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${NETWORK_DIR}/docker-compose.fabric.yml"
CHANNEL_NAME="${FABRIC_CHANNEL_NAME:-lgsvhr-payroll-channel}"
CHAINCODE_NAME="${FABRIC_CHAINCODE_NAME:-payroll-audit}"
CHAINCODE_VERSION="${CHAINCODE_VERSION:-1.0}"
CHAINCODE_SEQUENCE="${CHAINCODE_SEQUENCE:-1}"
CHAINCODE_LABEL="${CHAINCODE_NAME}_${CHAINCODE_VERSION}"
CHAINCODE_PACKAGE="${CHAINCODE_LABEL}.tar.gz"
CHAINCODE_PATH="/opt/gopath/src/github.com/chaincode/payroll-audit"
ORDERER_CA="/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/ordererOrganizations/lgsvhr.com/orderers/orderer.lgsvhr.com/tls/ca.crt"
ORDERER_ADDRESS="orderer.lgsvhr.com:7050"
HR_TLS_ROOT="/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/hr.lgsvhr.com/peers/peer0.hr.lgsvhr.com/tls/ca.crt"
PAYROLL_TLS_ROOT="/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/payroll.lgsvhr.com/peers/peer0.payroll.lgsvhr.com/tls/ca.crt"

cd "${NETWORK_DIR}"

compose_exec() {
  docker compose -f "${COMPOSE_FILE}" exec -T cli bash -lc "$1"
}

hr_peer_env='export CORE_PEER_LOCALMSPID=HRMSP; export CORE_PEER_ADDRESS=peer0.hr.lgsvhr.com:7051; export CORE_PEER_MSPCONFIGPATH=/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/hr.lgsvhr.com/users/Admin@hr.lgsvhr.com/msp; export CORE_PEER_TLS_ROOTCERT_FILE=/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/hr.lgsvhr.com/peers/peer0.hr.lgsvhr.com/tls/ca.crt;'
payroll_peer_env='export CORE_PEER_LOCALMSPID=PayrollMSP; export CORE_PEER_ADDRESS=peer0.payroll.lgsvhr.com:7051; export CORE_PEER_MSPCONFIGPATH=/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/payroll.lgsvhr.com/users/Admin@payroll.lgsvhr.com/msp; export CORE_PEER_TLS_ROOTCERT_FILE=/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/payroll.lgsvhr.com/peers/peer0.payroll.lgsvhr.com/tls/ca.crt;'

compose_exec "rm -f ${CHAINCODE_PACKAGE}; peer lifecycle chaincode package ${CHAINCODE_PACKAGE} --path ${CHAINCODE_PATH} --lang node --label ${CHAINCODE_LABEL}"
compose_exec "${hr_peer_env} peer lifecycle chaincode install ${CHAINCODE_PACKAGE} >/dev/null 2>&1 || true"
compose_exec "${payroll_peer_env} peer lifecycle chaincode install ${CHAINCODE_PACKAGE} >/dev/null 2>&1 || true"

PACKAGE_ID="$(docker compose -f "${COMPOSE_FILE}" exec -T cli bash -lc "peer lifecycle chaincode calculatepackageid ${CHAINCODE_PACKAGE}")"

if ! compose_exec "${hr_peer_env} peer lifecycle chaincode queryapproved --channelID ${CHANNEL_NAME} --name ${CHAINCODE_NAME} --sequence ${CHAINCODE_SEQUENCE} >/dev/null 2>&1"; then
  compose_exec "${hr_peer_env} peer lifecycle chaincode approveformyorg -o ${ORDERER_ADDRESS} --channelID ${CHANNEL_NAME} --name ${CHAINCODE_NAME} --version ${CHAINCODE_VERSION} --package-id ${PACKAGE_ID} --sequence ${CHAINCODE_SEQUENCE} --tls --cafile ${ORDERER_CA}"
fi

if ! compose_exec "${payroll_peer_env} peer lifecycle chaincode queryapproved --channelID ${CHANNEL_NAME} --name ${CHAINCODE_NAME} --sequence ${CHAINCODE_SEQUENCE} >/dev/null 2>&1"; then
  compose_exec "${payroll_peer_env} peer lifecycle chaincode approveformyorg -o ${ORDERER_ADDRESS} --channelID ${CHANNEL_NAME} --name ${CHAINCODE_NAME} --version ${CHAINCODE_VERSION} --package-id ${PACKAGE_ID} --sequence ${CHAINCODE_SEQUENCE} --tls --cafile ${ORDERER_CA}"
fi

compose_exec "${payroll_peer_env} peer lifecycle chaincode checkcommitreadiness --channelID ${CHANNEL_NAME} --name ${CHAINCODE_NAME} --version ${CHAINCODE_VERSION} --sequence ${CHAINCODE_SEQUENCE} --tls --cafile ${ORDERER_CA} --output json"

CURRENT_COMMITTED_SEQUENCE="$(
  compose_exec "${payroll_peer_env} peer lifecycle chaincode querycommitted --channelID ${CHANNEL_NAME} --name ${CHAINCODE_NAME}" 2>/dev/null \
    | sed -n 's/.*Sequence: \([0-9]\+\).*/\1/p' \
    | head -n 1 || true
)"

if [ "${CURRENT_COMMITTED_SEQUENCE}" != "${CHAINCODE_SEQUENCE}" ]; then
  compose_exec "${payroll_peer_env} peer lifecycle chaincode commit -o ${ORDERER_ADDRESS} --channelID ${CHANNEL_NAME} --name ${CHAINCODE_NAME} --version ${CHAINCODE_VERSION} --sequence ${CHAINCODE_SEQUENCE} --tls --cafile ${ORDERER_CA} --peerAddresses peer0.hr.lgsvhr.com:7051 --tlsRootCertFiles ${HR_TLS_ROOT} --peerAddresses peer0.payroll.lgsvhr.com:7051 --tlsRootCertFiles ${PAYROLL_TLS_ROOT}"
else
  echo "Chaincode ${CHAINCODE_NAME} sequence ${CHAINCODE_SEQUENCE} is already committed on ${CHANNEL_NAME}; skipping commit."
fi

compose_exec "${payroll_peer_env} peer lifecycle chaincode querycommitted --channelID ${CHANNEL_NAME} --name ${CHAINCODE_NAME}"

echo "Chaincode ${CHAINCODE_NAME} committed on ${CHANNEL_NAME}."
