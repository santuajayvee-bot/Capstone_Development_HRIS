# LGSV HR

LGSV HR is a secure Human Resource and Payroll System for Marulas Industrial Corporation. It uses Node.js, Express.js, MySQL, and Hyperledger Fabric. Fabric is used only as a permissioned audit ledger for finalized payroll hashes; employee PII and full payroll breakdowns remain in MySQL.

## Team Setup

New contributors should begin with the complete local setup manual:

- [Team Local Setup Guide](docs/team-local-setup.md)
- [Blockchain Reference](docs/blockchain-setup.md)

Do not commit `.env`, generated Fabric identities, channel artifacts, database dumps containing real data, or private keys.

## AES-256-GCM Off-Chain Payload Encryption

LGSV HR supports optional AES-256-GCM application-layer encryption for sensitive off-chain API communication between trusted clients, partner systems, and the Node.js/Express backend. This supports the security objective: to safeguard employee, HR, and payroll data from unauthorized exposure by using AES-256 encryption for off-chain communication between client, partner, and system.

- Algorithm: `aes-256-gcm` from the built-in Node.js `crypto` module.
- Key storage: `AES_256_SECRET_KEY` in the backend `.env` or AWS runtime secret configuration only. It must be 32 random bytes encoded as base64.
- Payload format:

```json
{
  "encryptedPayload": {
    "iv": "base64-12-byte-random-iv",
    "encryptedData": "base64-ciphertext",
    "authTag": "base64-gcm-auth-tag"
  }
}
```

Sensitive API clients may send encrypted request bodies in this wrapper. They may request encrypted JSON responses with `X-LGSV-Encrypted-Response: true`. Covered sensitive areas include employee personal information, government requirement details, education/training data, attendance records, leave records, payroll and compensation records, user account administration, role management, and login payloads when submitted by trusted system clients.

Limits: normal browser UI requests are not forced into this shared-key scheme because the AES key must never be exposed to frontend JavaScript. HTTPS/TLS is still required; AES-256-GCM is additional application-layer protection, not a replacement for TLS.
