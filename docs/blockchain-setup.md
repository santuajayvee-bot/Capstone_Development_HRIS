# LGSV HR Permissioned Payroll Blockchain Setup

LGSV HR uses Hyperledger Fabric only as a permissioned audit layer for finalized payroll hashes. Sensitive employee files, bank data, payroll breakdowns, addresses, and other PII remain off-chain in MySQL.

The configured Fabric network has three main blockchain nodes:

- `orderer.lgsvhr.com`
- `peer0.hr.lgsvhr.com`
- `peer0.payroll.lgsvhr.com`

The `cli` container is only a support container for channel and chaincode commands.

## Prerequisites

- Docker Desktop with Docker Compose
- Node.js 18 or newer
- MySQL or MariaDB running with the LGSV HR database
- Bash shell for the Fabric scripts, such as Git Bash or WSL

## Install Dependencies

From the project root:

```bash
npm install
npm install @hyperledger/fabric-gateway @grpc/grpc-js
cd chaincode/payroll-audit
npm install
cd ../..
```

## Configure `.env`

Copy `.env.example` to `.env` if needed, then set:

```env
FABRIC_ENABLED=true
FABRIC_CHANNEL_NAME=lgsvhr-payroll-channel
FABRIC_CHAINCODE_NAME=payroll-audit
FABRIC_MSP_ID=PayrollMSP
FABRIC_PEER_ENDPOINT=localhost:7051
FABRIC_PEER_HOST_ALIAS=peer0.payroll.lgsvhr.com
FABRIC_TLS_CERT_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/peers/peer0.payroll.lgsvhr.com/tls/ca.crt
FABRIC_CERT_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/users/User1@payroll.lgsvhr.com/msp/signcerts/cert.pem
FABRIC_KEY_DIRECTORY_PATH=./fabric-network/organizations/peerOrganizations/payroll.lgsvhr.com/users/User1@payroll.lgsvhr.com/msp/keystore
BLOCKCHAIN_EMPLOYEE_REF_PEPPER=replace-with-a-long-random-pepper
```

For local development without Fabric running, keep `FABRIC_ENABLED=false`. The backend will store the payroll hash locally and mark the blockchain state as `PENDING_ANCHOR`.

## Apply the Database Migration

Using the standalone migration:

```bash
mysql -u root -p lgsv_hr_db < database/migrate-permissioned-blockchain-payroll.sql
```

Or with the project migration runner:

```bash
npm run migrate
```

The migration creates or updates:

- `PAYROLL_RECORD.Transaction_Hash`
- `PAYROLL_RECORD.Blockchain_Status`
- `PAYROLL_RECORD.Finalized_At`
- `PAYROLL_RECORD.Approved_By`
- `BLOCKCHAIN_AUDIT_LOG`
- `system_audit_log` compatibility columns used by critical audit events

## Start the Fabric Network

From the project root:

```bash
cd fabric-network
bash ./scripts/network-up.sh
bash ./scripts/create-channel.sh
bash ./scripts/deploy-chaincode.sh
cd ..
```

To confirm containers:

```bash
docker compose -f fabric-network/docker-compose.fabric.yml ps
docker ps --filter "name=orderer.lgsvhr.com"
docker ps --filter "name=peer0.hr.lgsvhr.com"
docker ps --filter "name=peer0.payroll.lgsvhr.com"
```

## Run the LGSV HR Server

```bash
npm start
```

The blockchain payroll routes are mounted at:

```txt
/api/blockchain/payroll
```

## API Test Commands

Login as Payroll Manager and System Administrator:

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"payroll.manager","password":"manager123"}'

curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"sys.admin","password":"sys123admin"}'
```

Set tokens from the JSON `token` value:

```bash
PAYROLL_MANAGER_TOKEN="paste-token-here"
SYSTEM_ADMIN_TOKEN="paste-token-here"
```

Create or inspect a finalized payroll row in MySQL:

```sql
SELECT Payroll_ID, Employee_ID, Approval_Status, Blockchain_Status, Transaction_Hash
FROM PAYROLL_RECORD
ORDER BY Payroll_ID DESC
LIMIT 5;
```

Finalize and record a payroll hash:

```bash
curl -s -X POST http://localhost:3000/api/blockchain/payroll/finalize/1 \
  -H "Authorization: Bearer ${PAYROLL_MANAGER_TOKEN}" \
  -H "Content-Type: application/json"
```

Verify payroll integrity:

```bash
curl -s http://localhost:3000/api/blockchain/payroll/verify/1 \
  -H "Authorization: Bearer ${SYSTEM_ADMIN_TOKEN}"
```

View audit trail:

```bash
curl -s http://localhost:3000/api/blockchain/payroll/audit/1 \
  -H "Authorization: Bearer ${SYSTEM_ADMIN_TOKEN}"
```

View finalized blockchain records:

```bash
curl -s http://localhost:3000/api/blockchain/payroll/finalized \
  -H "Authorization: Bearer ${PAYROLL_MANAGER_TOKEN}"
```

## Tamper Detection Test

After a finalized payroll has been recorded on Fabric, change a payroll integrity field directly in MySQL:

```sql
UPDATE PAYROLL_RECORD
SET Net_Pay = Net_Pay + 1.00
WHERE Payroll_ID = 1;
```

Then verify again:

```bash
curl -s http://localhost:3000/api/blockchain/payroll/verify/1 \
  -H "Authorization: Bearer ${SYSTEM_ADMIN_TOKEN}"
```

Expected result when Fabric is connected: the API returns a critical tampering warning because the recomputed off-chain hash no longer matches the ledger hash.

Expected result when Fabric is disabled or unavailable: the API returns `pending_anchor` and this message:

```txt
Blockchain network is not currently connected. Local audit records are available, but Fabric verification is disabled.
```

## Shut Down the Network

```bash
cd fabric-network
bash ./scripts/network-down.sh
```

To remove Docker volumes too:

```bash
bash ./scripts/network-down.sh --volumes
```

Keep generated certificates and channel artifacts unless you intentionally need to regenerate identities.
