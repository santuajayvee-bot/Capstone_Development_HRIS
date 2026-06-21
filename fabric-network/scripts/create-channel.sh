#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${NETWORK_DIR}/docker-compose.fabric.yml"
CHANNEL_NAME="${FABRIC_CHANNEL_NAME:-lgsvhr-payroll-channel}"
ORDERER_CA="/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/ordererOrganizations/lgsvhr.com/orderers/orderer.lgsvhr.com/tls/ca.crt"
ORDERER_ADDRESS="orderer.lgsvhr.com:7050"

cd "${NETWORK_DIR}"

compose_exec() {
  docker compose -f "${COMPOSE_FILE}" exec -T cli bash -lc "$1"
}

hr_peer_env='export CORE_PEER_LOCALMSPID=HRMSP; export CORE_PEER_ADDRESS=peer0.hr.lgsvhr.com:7051; export CORE_PEER_MSPCONFIGPATH=/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/hr.lgsvhr.com/users/Admin@hr.lgsvhr.com/msp; export CORE_PEER_TLS_ROOTCERT_FILE=/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/hr.lgsvhr.com/peers/peer0.hr.lgsvhr.com/tls/ca.crt;'
payroll_peer_env='export CORE_PEER_LOCALMSPID=PayrollMSP; export CORE_PEER_ADDRESS=peer0.payroll.lgsvhr.com:7051; export CORE_PEER_MSPCONFIGPATH=/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/payroll.lgsvhr.com/users/Admin@payroll.lgsvhr.com/msp; export CORE_PEER_TLS_ROOTCERT_FILE=/opt/gopath/src/github.com/hyperledger/fabric/peer/organizations/peerOrganizations/payroll.lgsvhr.com/peers/peer0.payroll.lgsvhr.com/tls/ca.crt;'

if [ ! -f "${NETWORK_DIR}/channel-artifacts/${CHANNEL_NAME}.block" ]; then
  compose_exec "${payroll_peer_env} peer channel create -o ${ORDERER_ADDRESS} -c ${CHANNEL_NAME} -f channel-artifacts/${CHANNEL_NAME}.tx --outputBlock channel-artifacts/${CHANNEL_NAME}.block --tls --cafile ${ORDERER_CA}"
fi

compose_exec "${hr_peer_env} peer channel join -b channel-artifacts/${CHANNEL_NAME}.block || true"
compose_exec "${payroll_peer_env} peer channel join -b channel-artifacts/${CHANNEL_NAME}.block || true"

compose_exec "${hr_peer_env} peer channel update -o ${ORDERER_ADDRESS} -c ${CHANNEL_NAME} -f channel-artifacts/HRMSPanchors.tx --tls --cafile ${ORDERER_CA} || true"
compose_exec "${payroll_peer_env} peer channel update -o ${ORDERER_ADDRESS} -c ${CHANNEL_NAME} -f channel-artifacts/PayrollMSPanchors.tx --tls --cafile ${ORDERER_CA} || true"

echo "Channel ${CHANNEL_NAME} is ready for chaincode deployment."
