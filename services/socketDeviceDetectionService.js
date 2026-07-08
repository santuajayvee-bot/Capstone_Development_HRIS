const { UAParser } = require('ua-parser-js');

const SOCKET_DEVICE_TTL_MS = 10 * 60 * 1000;
const socketDeviceMetadata = new Map();

function cleanText(value, max = 160) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, max) || null;
}

function normalizeDeviceType(type) {
  const value = String(type || '').toLowerCase();
  if (value === 'mobile' || value === 'wearable') return 'Mobile';
  if (value === 'tablet') return 'Tablet';
  return 'Desktop';
}

function normalizeCpuArchitecture(cpu = {}) {
  const architecture = cleanText(cpu.architecture, 40);
  if (!architecture) return '';
  if (/amd64|x86_64/i.test(architecture)) return 'x86 64-bit';
  if (/ia32|x86/i.test(architecture)) return 'x86 32-bit';
  if (/arm64|aarch64/i.test(architecture)) return 'ARM 64-bit';
  return architecture;
}

function metadataFromUserAgent(ua = '') {
  const parser = new UAParser(ua);
  const result = parser.getResult();
  const browser = cleanText(result.browser?.name, 100) || 'Unknown Browser';
  const operatingSystem = cleanText(result.os?.name, 120) || 'Unknown OS';
  const deviceType = normalizeDeviceType(result.device?.type);
  const deviceVendor = cleanText(result.device?.vendor, 80);
  const deviceModel = cleanText(result.device?.model, 100);
  const cpuLabel = normalizeCpuArchitecture(result.cpu);
  const model = [deviceVendor, deviceModel].filter(Boolean).join(' ')
    || [operatingSystem, cpuLabel].filter(Boolean).join(' ')
    || null;

  return {
    browser,
    operatingSystem,
    deviceType,
    deviceVendor,
    deviceModel: cleanText(model, 160),
    userAgent: cleanText(ua, 500) || '',
    raw: result,
  };
}

function pruneSocketDeviceMetadata(now = Date.now()) {
  for (const [clientDeviceId, entry] of socketDeviceMetadata.entries()) {
    if (!entry?.updatedAt || now - entry.updatedAt > SOCKET_DEVICE_TTL_MS) {
      socketDeviceMetadata.delete(clientDeviceId);
    }
  }
}

function rememberSocketDeviceMetadata(clientDeviceId, metadata) {
  const key = cleanText(clientDeviceId, 120);
  if (!key) return null;
  const entry = {
    ...metadata,
    clientDeviceId: key,
    updatedAt: Date.now(),
  };
  socketDeviceMetadata.set(key, entry);
  return entry;
}

function getSocketDeviceMetadata(clientDeviceId) {
  pruneSocketDeviceMetadata();
  const key = cleanText(clientDeviceId, 120);
  if (!key) return null;
  return socketDeviceMetadata.get(key) || null;
}

function attachSocketDeviceDetection(server) {
  const { Server } = require('socket.io');
  const io = new Server(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    const userAgent = socket.handshake.headers['user-agent'] || '';
    const clientDeviceId = socket.handshake.auth?.clientDeviceId
      || socket.handshake.query?.clientDeviceId
      || '';
    const metadata = metadataFromUserAgent(userAgent);
    const stored = rememberSocketDeviceMetadata(clientDeviceId, metadata);

    if (process.env.LOG_SOCKET_DEVICE_UA === '1') {
      console.log(userAgent);
      console.log(metadata.raw);
    }

    socket.emit('device:metadata', stored || metadata);
  });

  return io;
}

module.exports = {
  attachSocketDeviceDetection,
  getSocketDeviceMetadata,
  metadataFromUserAgent,
};
