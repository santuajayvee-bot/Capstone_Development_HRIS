const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

async function loadFabricSdk() {
  try {
    const grpcModule = await import('@grpc/grpc-js');
    const gatewayModule = await import('@hyperledger/fabric-gateway');
    const grpc = grpcModule.default || grpcModule;
    const gateway = gatewayModule.default || gatewayModule;
    const { connect, hash, signers } = gateway;
    return { grpc, connect, hash, signers };
  } catch (error) {
    const wrapped = new Error(
      'Hyperledger Fabric Gateway dependencies are not installed. Install @hyperledger/fabric-gateway and @grpc/grpc-js before using blockchain APIs.'
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function fabricConfig() {
  return {
    channelName: process.env.FABRIC_CHANNEL_NAME || 'hrchannel',
    chaincodeName: process.env.FABRIC_CHAINCODE_NAME || 'payroll-audit',
    mspId: process.env.FABRIC_MSP_ID || 'Org1MSP',
    peerEndpoint: process.env.FABRIC_PEER_ENDPOINT || 'localhost:7051',
    peerHostAlias: process.env.FABRIC_PEER_HOST_ALIAS || 'peer0.org1.example.com',
    tlsCertPath: process.env.FABRIC_TLS_CERT_PATH,
    certPath: process.env.FABRIC_CERT_PATH,
    keyDirectoryPath: process.env.FABRIC_KEY_DIRECTORY_PATH,
  };
}

async function readFirstPrivateKey(keyDirectoryPath) {
  const files = await fs.readdir(keyDirectoryPath);
  const keyFile = files.find(file => file.endsWith('_sk') || file.endsWith('.pem')) || files[0];
  if (!keyFile) throw new Error(`No private key file found in ${keyDirectoryPath}`);
  return fs.readFile(path.join(keyDirectoryPath, keyFile));
}

async function connectToFabricNetwork() {
  const { grpc, connect, hash, signers } = await loadFabricSdk();
  const config = fabricConfig();

  if (!config.tlsCertPath || !config.certPath || !config.keyDirectoryPath) {
    throw new Error('Fabric identity configuration is incomplete. Set FABRIC_TLS_CERT_PATH, FABRIC_CERT_PATH, and FABRIC_KEY_DIRECTORY_PATH.');
  }

  const tlsRootCert = await fs.readFile(config.tlsCertPath);
  const client = new grpc.Client(config.peerEndpoint, grpc.credentials.createSsl(tlsRootCert), {
    'grpc.ssl_target_name_override': config.peerHostAlias,
  });

  const credentials = await fs.readFile(config.certPath);
  const privateKeyPem = await readFirstPrivateKey(config.keyDirectoryPath);
  const privateKey = crypto.createPrivateKey(privateKeyPem);

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

async function submitPayrollAdjustmentRecord(ledgerRecord) {
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

module.exports = {
  connectToFabricNetwork,
  getPayrollHistory,
  queryPayrollRecord,
  submitPayrollAdjustmentRecord,
  submitPayrollRecord,
  verifyPayrollHash,
};
