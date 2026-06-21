# LGSV HR

LGSV HR is a secure Human Resource and Payroll System for Marulas Industrial Corporation. It uses Node.js, Express.js, MySQL, and Hyperledger Fabric. Fabric is used only as a permissioned audit ledger for finalized payroll hashes; employee PII and full payroll breakdowns remain in MySQL.

## Team Setup

New contributors should begin with the complete local setup manual:

- [Team Local Setup Guide](docs/team-local-setup.md)
- [Blockchain Reference](docs/blockchain-setup.md)

Do not commit `.env`, generated Fabric identities, channel artifacts, database dumps containing real data, or private keys.
