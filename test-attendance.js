/* ============================================================
   test-attendance.js — Test the Attendance Module end-to-end
   Run: node test-attendance.js
   ============================================================ */

require('dotenv').config();
const pool = require('./config/db');
const jwt  = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

async function test() {
  console.log('\n🧪 ATTENDANCE MODULE — END-TO-END TEST\n');
  console.log('═'.repeat(50));

  // 1. Get the site secret (the QR code content)
  const [sites] = await pool.execute('SELECT * FROM geofence_config WHERE is_active = 1 LIMIT 1');
  if (sites.length === 0) { console.log('❌ No geofence config. Run migrate-attendance.js first.'); process.exit(1); }
  const site = sites[0];
  const qrToken = `LGSV_ATT:${site.id}:${site.site_secret}`;

  console.log('\n📍 GEOFENCE CONFIG:');
  console.log(`   Site: ${site.site_name}`);
  console.log(`   Location: ${site.latitude}, ${site.longitude}`);
  console.log(`   Radius: ${site.radius_meters}m`);
  console.log(`   QR Token: ${qrToken.substring(0, 30)}...`);

  // 2. Find an employee user to test with
  const [users] = await pool.execute(`
    SELECT u.id, u.username, u.employee_id, r.name AS role
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.employee_id IS NOT NULL LIMIT 1
  `);

  if (users.length === 0) { console.log('❌ No users with employee_id found.'); process.exit(1); }
  const testUser = users[0];

  console.log(`\n👤 TEST USER: ${testUser.username} (Employee ID: ${testUser.employee_id}, Role: ${testUser.role})`);

  // 3. Generate a JWT for this user
  const token = jwt.sign(
    { id: testUser.id, role: testUser.role, employeeId: testUser.employee_id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const baseUrl = `http://localhost:${process.env.PORT || 3000}`;

  // 4. Test CLOCK-IN
  console.log('\n═'.repeat(50));
  console.log('📥 TEST: CLOCK-IN');
  console.log('═'.repeat(50));

  // First, clean any existing record for today
  const today = new Date().toISOString().slice(0, 10);
  await pool.execute('DELETE FROM attendance_log WHERE employee_id = ? AND date = ?', [testUser.employee_id, today]);
  await pool.execute('DELETE FROM device_bindings WHERE employee_id = ? AND date = ?', [testUser.employee_id, today]);
  console.log('   (Cleaned existing test data for today)');

  const clockInRes = await fetch(`${baseUrl}/api/attendance/clock-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      qr_token: qrToken,
      latitude: parseFloat(site.latitude),   // Use exact site location to pass geofence
      longitude: parseFloat(site.longitude),
      device_fingerprint: 'TEST-DEVICE-001'
    })
  });
  const clockInData = await clockInRes.json();
  console.log(`   Status: ${clockInRes.status}`);
  console.log('   Response:', JSON.stringify(clockInData, null, 2));
  console.log(clockInRes.ok ? '   ✅ CLOCK-IN SUCCESS' : '   ❌ CLOCK-IN FAILED');

  // 5. Test DUPLICATE CLOCK-IN (should fail with One-Log Rule)
  console.log('\n📥 TEST: DUPLICATE CLOCK-IN (should fail)');
  const dupRes = await fetch(`${baseUrl}/api/attendance/clock-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      qr_token: qrToken,
      latitude: parseFloat(site.latitude),
      longitude: parseFloat(site.longitude),
      device_fingerprint: 'TEST-DEVICE-001'
    })
  });
  const dupData = await dupRes.json();
  console.log(`   Status: ${dupRes.status} → ${dupData.error}`);
  console.log(dupRes.status === 409 ? '   ✅ ONE-LOG RULE ENFORCED' : '   ❌ ONE-LOG RULE FAILED');

  // 6. Test WRONG DEVICE (should fail)
  console.log('\n📱 TEST: DIFFERENT DEVICE (should fail)');
  await pool.execute('DELETE FROM attendance_log WHERE employee_id = ? AND date = ?', [testUser.employee_id, today]);
  // Keep the device binding so it triggers mismatch
  const wrongDevRes = await fetch(`${baseUrl}/api/attendance/clock-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      qr_token: qrToken,
      latitude: parseFloat(site.latitude),
      longitude: parseFloat(site.longitude),
      device_fingerprint: 'HACKER-DEVICE-999'
    })
  });
  const wrongDevData = await wrongDevRes.json();
  console.log(`   Status: ${wrongDevRes.status} → ${wrongDevData.error}`);
  console.log(wrongDevRes.status === 403 ? '   ✅ DEVICE BINDING ENFORCED' : '   ❌ DEVICE BINDING FAILED');

  // Clean and re-do clock-in for clock-out test
  await pool.execute('DELETE FROM device_bindings WHERE employee_id = ? AND date = ?', [testUser.employee_id, today]);
  await pool.execute('DELETE FROM attendance_log WHERE employee_id = ? AND date = ?', [testUser.employee_id, today]);
  await fetch(`${baseUrl}/api/attendance/clock-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      qr_token: qrToken,
      latitude: parseFloat(site.latitude),
      longitude: parseFloat(site.longitude),
      device_fingerprint: 'TEST-DEVICE-001'
    })
  });

  // 7. Test GEOFENCE REJECTION
  console.log('\n📍 TEST: OUTSIDE GEOFENCE (should fail)');
  const farRes = await fetch(`${baseUrl}/api/attendance/clock-out`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      qr_token: qrToken,
      latitude: 0.0,     // Somewhere in the ocean
      longitude: 0.0,
      device_fingerprint: 'TEST-DEVICE-001'
    })
  });
  const farData = await farRes.json();
  console.log(`   Status: ${farRes.status} → ${farData.error}`);
  console.log(farRes.status === 403 ? '   ✅ GEOFENCE ENFORCED' : '   ❌ GEOFENCE FAILED');

  // 8. Test CLOCK-OUT (correct)
  console.log('\n📤 TEST: CLOCK-OUT');
  const clockOutRes = await fetch(`${baseUrl}/api/attendance/clock-out`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      qr_token: qrToken,
      latitude: parseFloat(site.latitude),
      longitude: parseFloat(site.longitude),
      device_fingerprint: 'TEST-DEVICE-001'
    })
  });
  const clockOutData = await clockOutRes.json();
  console.log(`   Status: ${clockOutRes.status}`);
  console.log('   Response:', JSON.stringify(clockOutData, null, 2));
  console.log(clockOutRes.ok ? '   ✅ CLOCK-OUT SUCCESS' : '   ❌ CLOCK-OUT FAILED');

  // 9. Verify the record in the database
  console.log('\n═'.repeat(50));
  console.log('📋 FINAL DATABASE RECORD:');
  console.log('═'.repeat(50));
  const [records] = await pool.execute(
    'SELECT * FROM attendance_log WHERE employee_id = ? AND date = ?',
    [testUser.employee_id, today]
  );
  if (records.length > 0) {
    const r = records[0];
    console.log(`   ID: ${r.attendance_id}`);
    console.log(`   Date: ${r.date}`);
    console.log(`   Time In: ${r.time_in}`);
    console.log(`   Time Out: ${r.time_out}`);
    console.log(`   Status: ${r.status}`);
    console.log(`   Device: ${r.device_fingerprint}`);
    console.log(`   GPS In: ${r.clock_in_lat}, ${r.clock_in_lng}`);
  }

  console.log('\n🎉 ALL TESTS COMPLETE!\n');
  process.exit(0);
}

test().catch(err => { console.error('❌ Test error:', err); process.exit(1); });
