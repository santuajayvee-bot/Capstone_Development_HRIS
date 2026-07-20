# LGSV HR AES-256 Implementation and Key Management Evidence

## Panel Question 23

**How exactly is AES-256 implemented and managed? Is AES-256 field-level encryption, volume encryption, RDS encryption, or a combination of these?**

## Direct Answer

LGSV HR directly implements **application-level, field-level authenticated encryption using AES-256-GCM** for sensitive off-chain information. The Node.js application encrypts selected values before writing them to MySQL and decrypts them only after authentication, RBAC, and ownership checks have passed.

The same AES-256-GCM utility is also used to encrypt protected uploaded files before they are written to the server-side secure file vault. Backup artifacts have a separate AES-256-GCM envelope-encryption implementation.

AWS RDS storage encryption and EC2/EBS volume encryption are separate infrastructure controls managed by AWS. They do not replace field-level encryption and are not created by the Node.js AES utility. Their production status must be demonstrated independently through the AWS console or AWS API evidence.

Therefore, the defensible current classification is:

| Encryption layer | LGSV HR implementation/status |
|---|---|
| Application field-level encryption | Implemented and production key verified |
| Encrypted application file vault | Implemented |
| Encrypted backup artifacts | Implemented by the backup subsystem when file-based backups are used |
| RDS storage encryption | Separate AWS control; production status requires AWS console/API evidence |
| EC2/EBS volume encryption | Separate AWS control; production status requires AWS console/API evidence |
| Application-to-RDS TLS | Supported by the code, but not enabled in the production configuration snapshot described below |

Do not describe the system as using RDS or volume encryption unless the corresponding AWS configuration page shows that encryption is enabled.

## Field-Level Encryption Design

The primary implementation is in `server/crypto.js` and uses Node.js's built-in `crypto` module:

```text
Algorithm:       AES-256-GCM
Key length:      32 bytes / 256 bits
IV:              fresh random 16-byte value for every encryption
Authentication:  16-byte GCM authentication tag
Storage format:  iv:authenticationTag:ciphertext
Encoding:        hexadecimal
```

For every protected field:

1. The application obtains the 256-bit key from the server runtime environment.
2. It generates a new random IV using `crypto.randomBytes(16)`.
3. It creates an `aes-256-gcm` cipher using `crypto.createCipheriv`.
4. It encrypts the plaintext and obtains the GCM authentication tag.
5. It stores the IV, authentication tag, and ciphertext together in the database column.
6. During an authorized read, the application separates the three components, applies the authentication tag, and decrypts the value.
7. If either the ciphertext or authentication tag has been modified, GCM authentication fails and the value is not successfully decrypted.

Identical plaintext values do not normally produce identical stored ciphertext because each encryption uses a fresh random IV.

## Protected Data Categories

Field-level AES-256-GCM is used for sensitive off-chain values such as:

- employee names and contact details where encrypted storage is enabled;
- addresses and other 201-file PII;
- government and payroll identifiers;
- bank/payroll details and encrypted payslip amounts;
- biometric reference identifiers and biometric device secrets;
- MFA TOTP secrets;
- leave reasons, remarks, and protected attachment metadata;
- onboarding applicant data;
- performance-management narratives and ratings where applicable;
- backup/restore reasons, locations, metadata, and result messages; and
- other explicitly named `*_encrypted` fields.

For fields that must be searched or matched without revealing their plaintext, the application may store a separate SHA-256 lookup hash alongside the encrypted value. The hash is not used as encryption and cannot be decrypted.

## Encrypted File Storage

Protected uploaded documents are stored outside the public web directory. Before a file is written, the application:

1. converts the file bytes to a base64 representation;
2. encrypts that representation with AES-256-GCM;
3. writes only the encrypted payload to a randomly named `.enc` file; and
4. restricts the file mode and validates that the path remains inside the secure vault.

The application decrypts the file only after the relevant authorization and download checks succeed.

## Key Management

The production field-encryption key is loaded from the backend environment variable:

```text
AES_ENCRYPTION_KEY=<64 hexadecimal characters>
```

Sixty-four hexadecimal characters represent 32 random bytes or 256 bits. The key is not stored in MySQL, returned by an API, exposed to browser JavaScript, or committed to the repository.

The implementation uses this key priority:

1. `AES_ENCRYPTION_KEY`, a 64-character hexadecimal key;
2. `AES_256_SECRET_KEY`, a base64-encoded 32-byte key; or
3. a key derived from `JWT_SECRET` through PBKDF2 as a legacy/development fallback.

The dedicated `AES_ENCRYPTION_KEY` is configured and valid in the production environment. The JWT-derived fallback should not be presented as the production key-management method.

For stronger operational key management, the production key should be injected into the process through AWS Systems Manager Parameter Store or AWS Secrets Manager and made available only to the EC2 application role and authorized deployment administrators. It should never be printed in logs or included in screenshots.

The current ciphertext format does not include a key-version identifier, and the application does not provide fully automatic key rotation. A key change therefore requires a controlled migration that decrypts existing values with the old key and re-encrypts them with the new key. Replacing the key without that migration can make existing encrypted records unreadable.

## Difference Between Encryption Layers

### 1. Field-Level AES-256-GCM

This is implemented by LGSV HR itself. It protects selected sensitive values even if someone obtains a raw database table dump, because the stored values are ciphertext and the key is kept outside the database.

### 2. RDS Storage Encryption

This is an AWS-managed infrastructure control. When enabled, AWS encrypts the underlying RDS storage, automated backups, read replicas, and snapshots using an AWS KMS key. It protects physical storage and snapshot media, but an authorized database session can still read database values. Field-level encryption therefore remains useful even when RDS encryption is enabled.

### 3. EC2/EBS Volume Encryption

This is another AWS-managed infrastructure control. It protects the EC2 block volume and files at the storage-device layer. It does not automatically encrypt individual MySQL fields and does not replace application-level encryption.

### 4. TLS In Transit

TLS protects data while it travels between systems. It is different from AES encryption at rest. The database configuration supports TLS with certificate verification, but TLS must be explicitly enabled through `DB_SSL=true` and the correct RDS CA configuration.

## Production Verification Snapshot

The following non-secret production checks were performed on July 20, 2026:

| Check | Result |
|---|---|
| Runtime mode | `production` |
| Dedicated `AES_ENCRYPTION_KEY` configured | Yes |
| Dedicated key format | Valid 64-character hexadecimal value / 256 bits |
| Key stored in MySQL | No evidence of database key storage; application loads it from the environment |
| Encrypted field data present | Yes; production tables contain encrypted email and employee PII records |
| `DB_SSL` | `false` |
| Active MySQL TLS cipher | None reported |
| RDS storage encryption | Not verified because the EC2 runtime did not have permission to query AWS RDS metadata |
| EC2/EBS volume encryption | Not verified in this evidence check |

The production snapshot proves the application-level AES-256-GCM key and encrypted field storage. It does not yet prove RDS or EBS encryption. It also shows that database TLS must be enabled before claiming encrypted application-to-RDS transport.

## Evidence Required From AWS

Capture these screenshots without exposing account numbers, endpoints, or keys:

1. **RDS > Databases > LGSV HR database > Configuration** showing `Encryption: Enabled` and the KMS key type or alias.
2. **EC2 > Volumes > application volume** showing `Encrypted: Yes` and its KMS key type or alias.
3. The application's security/configuration status showing that `DB_SSL=true` after TLS is enabled, without displaying credentials.
4. A MySQL session check showing a negotiated TLS cipher.

If the RDS and EBS screenshots confirm encryption, the manuscript may describe the deployment as a combination of application-level field encryption and AWS infrastructure encryption at rest.

## Short Defense Answer

> AES-256 in LGSV HR is primarily application-level field encryption using AES-256-GCM. Sensitive values are encrypted by the Node.js backend before being stored in MySQL. Every encryption uses a fresh random IV and a GCM authentication tag, so unauthorized modification causes decryption authentication to fail. The 256-bit key is stored outside the database in the protected server environment and is never sent to the browser. Protected uploaded files and file-based backup artifacts also use AES-256-GCM. RDS and EBS encryption are separate AWS infrastructure controls and must be verified independently in the AWS console. Based on the current production evidence, field-level AES-256-GCM is confirmed, while RDS and EBS encryption still require AWS configuration evidence.
