const assert = require('assert');
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  uploadExtensionError,
  validateStoredUpload,
} = require('../server/security-controls');

function tempFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgsv-upload-test-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return { dir, filePath };
}

assert.strictEqual(uploadExtensionError('resume.pdf'), null);
assert.strictEqual(uploadExtensionError('photo.jpg'), null);
assert.strictEqual(uploadExtensionError('contract.docx'), null);
assert.strictEqual(uploadExtensionError('shell.php.jpg'), 'Executable or double-extension files are not allowed.');
assert.strictEqual(uploadExtensionError('payload.exe'), 'File type is not allowed.');
assert.strictEqual(uploadExtensionError('page.html'), 'File type is not allowed.');

{
  const { dir, filePath } = tempFile('fake.pdf', Buffer.from('<script>alert(1)</script>'));
  const result = validateStoredUpload({
    originalname: 'fake.pdf',
    mimetype: 'application/pdf',
    path: filePath,
  });
  assert.strictEqual(result.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, filePath } = tempFile('real.pdf', Buffer.from('%PDF-1.7\n%test'));
  const result = validateStoredUpload({
    originalname: 'real.pdf',
    mimetype: 'application/pdf',
    path: filePath,
  });
  assert.strictEqual(result.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('Upload security tests: PASS');

require('../config/db').end();
