import assert from 'node:assert/strict';
import { isPrivateAddress } from '../server/netSafety';

const blocked = [
  '192.0.2.1', '198.51.100.7', '203.0.113.9',
  '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10',
  '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '198.18.0.1',
  '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1',
  '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
  '[::1]', 'not-an-ip',
];
const allowed = ['192.0.78.13', '192.0.66.233', '192.0.1.1', '198.50.0.1', '203.0.114.1', '8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'];

for (const ip of blocked) {
  it_(`blocks ${ip}`, () => assert.equal(isPrivateAddress(ip), true));
}
for (const ip of allowed) {
  it_(`allows ${ip}`, () => assert.equal(isPrivateAddress(ip), false));
}

function it_(name: string, fn: () => void) {
  try { fn(); console.log(`✅ [PASS] ${name}`); }
  catch (e) { console.log(`❌ [FAIL] ${name}`); process.exitCode = 1; throw e; }
}
