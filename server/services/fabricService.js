const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

class FabricUnavailableError extends Error {
  constructor(message, code = 'FABRIC_UNAVAILABLE') {
    super(message);
    this.name = 'FabricUnavailableError';
    this.code = code;
    this.fabricUnavailable = true;
  }
}

function isFabricEnabled() {
  return String(process.env.FABRIC_ENABLED || 'false').toLowerCase() === 'true';
}

async function loadFabricSdk() {
  try {
    const grpcModule = await import('@grpc/grpc-js');
    const gatewayModule = await import('@hyperledger/fabric-gateway');
    const grpc = grpcModule.default || grpcModule;
    const gateway = gatewayModule.default || gatewayModule;
    const { connect, hash, signers } = gateway;
    return { grpc, connect, hash, signers };
  } catch (error) {
    throw new FabricUnavailableError(
      'Hyperledger Fabric Gateway dependencies are not installed. Install @hyperledger/fabric-gateway and @grpc/grpc-js before using blockchain APIs.',
      'FABRIC_DEPENDENCIES_MISSING'
    );
  }
}

function resolveConfigPath(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function fabricConfig() {
  return {
    enabled: isFabricEnabled(),
    channelName: process.env.FABRIC_CHANNEL_NAME || 'lgsvhr-payroll-channel',
    chaincodeName: process.env.FABRIC_CHAINCODE_NAME || 'payroll-audit',
    mspId: process.env.FABRIC_MSP_ID || 'PayrollMSP',
    peerEndpoint: process.env.FABRIC_PEER_ENDPOINT || 'localhost:7051',
    peerHostAlias: process.env.FABRIC_PEER_HOST_ALIAS || 'peer0.payroll.lgsvhr.com',
    tlsCertPath: resolveConfigPath(process.env.FABRIC_TLS_CERT_PATH),
    certPath: resolveConfigPath(process.env.FABRIC_CERT_PATH),
    keyDirectoryPath: resolveConfigPath(process.env.FABRIC_KEY_DIRECTORY_PATH),
  };
}

function getFabricConfigStatus() {
  const config = fabricConfig();
  return {
    enabled: config.enabled,
    channelName: config.channelName,
    chaincodeName: config.chaincodeName,
    mspId: config.mspId,
    peerEndpoint: config.peerEndpoint,
    peerHostAlias: config.peerHostAlias,
    tlsCertConfigured: Boolean(config.tlsCertPath),
    certConfigured: Boolean(config.certPath),
    keyDirectoryConfigured: Boolean(config.keyDirectoryPath),
    ready: Boolean(config.enabled && config.tlsCertPath && config.certPath && config.keyDirectoryPath),
  };
}

function assertFabricReady(config) {
  if (!config.enabled) {
    throw new FabricUnavailableError(
      'Blockchain network is not currently connected. Local audit records are available, but Fabric verification is disabled.',
      'FABRIC_DISABLED'
    );
  }

  const missing = [];
  if (!config.tlsCertPath) missing.push('FABRIC_TLS_CERT_PATH');
  if (!config.certPath) missing.push('FABRIC_CERT_PATH');
  if (!config.keyDirectoryPath) missing.push('FABRIC_KEY_DIRECTORY_PATH');

  if (missing.length) {
    throw new FabricUnavailableError(
      `Fabric identity configuration is incomplete. Set ${missing.join(', ')}.`,
      'FABRIC_CONFIG_MISSING'
    );
  }
}

async function readFileOrUnavailable(filePath, label) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    throw new FabricUnavailableError(
      `Fabric ${label} file could not be read at ${filePath}.`,
      'FABRIC_CREDENTIAL_FILE_MISSING'
    );
  }
}

async function readFirstPrivateKey(keyDirectoryPath) {
  let files;
  try {
    files = await fs.readdir(keyDirectoryPath);
  } catch (error) {
    throw new FabricUnavailableError(
      `Fabric private key directory could not be read at ${keyDirectoryPath}.`,
      'FABRIC_KEY_DIRECTORY_MISSING'
    );
  }

  const keyFile = files
    .filter(file => file.endsWith('_sk') || file.endsWith('.pem') || file.endsWith('.key'))
    .sort()[0] || files.sort()[0];

  if (!keyFile) {
    throw new FabricUnavailableError(`No private key file found in ${keyDirectoryPath}.`, 'FABRIC_KEY_MISSING');
  }

  return readFileOrUnavailable(path.join(keyDirectoryPath, keyFile), 'private key');
}

async function connectToFabricNetwork() {
  const config = fabricConfig();
  assertFabricReady(config);

  const { grpc, connect, hash, signers } = await loadFabricSdk();
  const tlsRootCert = await readFileOrUnavailable(config.tlsCertPath, 'TLS certificate');
  const credentials = await readFileOrUnavailable(config.certPath, 'identity certificate');
  const privateKeyPem = await readFirstPrivateKey(config.keyDirectoryPath);
  const privateKey = crypto.createPrivateKey(privateKeyPem);

  const client = new grpc.Client(config.peerEndpoint, grpc.credentials.createSsl(tlsRootCert), {
    'grpc.ssl_target_name_override': config.peerHostAlias,
  });

  const gateway = connect({
    client,
    identity: { mspId: config.mspId, credentials },
    signer: signers.newPrivateKeySigner(privateKey),
    hash: hash.sha256,
  });

  const network = gateway.getNetwork(config.channelName);
  const contract = network.getContract(config.chaincodeName);

  return {
    contract,
    gateway,
    client,
    close: () => {
      gateway.close();
      client.close();
    },
  };
}

function parseResult(buffer) {
  if (!buffer || !buffer.length) return null;
  const text = Buffer.from(buffer).toString('utf8');
  return text ? JSON.parse(text) : null;
}

async function withContract(work) {
  const connection = await connectToFabricNetwork();
  try {
    return await work(connection.contract);
  } catch (error) {
    if (error.fabricUnavailable) throw error;
    const wrapped = new FabricUnavailableError(error.message || 'Fabric Gateway request failed.', 'FABRIC_GATEWAY_ERROR');
    wrapped.cause = error;
    throw wrapped;
  } finally {
    connection.close();
  }
}

async function submitPayrollRecord(ledgerRecord) {
  return withContract(async contract => {
    const result = await contract.submitTransaction('CreatePayrollRecord', JSON.stringify(ledgerRecord));
    return parseResult(result);
  });
}

async function createPayrollAdjustmentRecord(ledgerRecord) {
  return withContract(async contract => {
    const result = await contract.submitTransaction('CreatePayrollAdjustmentRecord', JSON.stringify(ledgerRecord));
    return parseResult(result);
  });
}

async function queryPayrollRecord(payrollId) {
  return withContract(async contract => {
    const result = await contract.evaluateTransaction('ReadPayrollRecord', String(payrollId));
    return parseResult(result);
  });
}

async function verifyPayrollHash(payrollId, payrollHash) {
  return withContract(async contract => {
    const result = await contract.evaluateTransaction('VerifyPayrollHash', String(payrollId), payrollHash);
    return parseResult(result);
  });
}

async function getPayrollHistory(payrollId) {
  return withContract(async contract => {
    const result = await contract.evaluateTransaction('GetPayrollHistory', String(payrollId));
    return parseResult(result) || [];
  });
}

async function submitDTRRecord(ledgerRecord) {
  return withContract(async contract => {
    const result = await contract.submitTransaction('CreateDTRRecord', JSON.stringify(ledgerRecord));
    return parseResult(result);
  });
}

async function createDTRAdjustmentRecord(ledgerRecord) {
  return withContract(async contract => {
    const result = await contract.submitTransaction('CreateDTRAdjustmentRecord', JSON.stringify(ledgerRecord));
    return parseResult(result);
  });
}

async function queryDTRRecord(dtrId) {
  return withContract(async contract => {
    const result = await contract.evaluateTransaction('ReadDTRRecord', String(dtrId));
    return parseResult(result);
  });
}

async function verifyDTRHash(dtrId, dtrHash) {
  return withContract(async contract => {
    const result = await contract.evaluateTransaction('VerifyDTRHash', String(dtrId), dtrHash);
    return parseResult(result);
  });
}

async function getDTRHistory(dtrId) {
  return withContract(async contract => {
    const result = await contract.evaluateTransaction('GetDTRHistory', String(dtrId));
    return parseResult(result) || [];
  });
}

module.exports = {
  FabricUnavailableError,
  connectToFabricNetwork,
  createPayrollAdjustmentRecord,
  fabricConfig,
  getFabricConfigStatus,
  getDTRHistory,
  getPayrollHistory,
  isFabricEnabled,
  queryDTRRecord,
  queryPayrollRecord,
  submitDTRAdjustmentRecord: createDTRAdjustmentRecord,
  submitDTRRecord,
  submitPayrollAdjustmentRecord: createPayrollAdjustmentRecord,
  submitPayrollRecord,
  verifyDTRHash,
  verifyPayrollHash,
};
