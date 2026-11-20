import assert from 'node:assert/strict';
import { isPrivateAddress } from '../src/utils/networkAddress';
import { normalizeFetchTarget } from '../src/utils/fetchTarget';
import { validateOutboundUrl } from '../server/netSafety';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

const PRIVATE_V4 = ['0.0.0.0', '10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '192.0.2.5', '198.18.0.1', '224.0.0.1', '255.255.255.255'];
const PUBLIC_V4 = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1'];

const PRIVATE_V6 = [
  '::', '::1', '[::1]', 'fe80::1', 'fe80::1%eth0', 'fd00::1', 'fc00::1', 'ff02::1', 'fec0::1',
  '2001:db8::1', '100::1', '4000::1',
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1',
  '64:ff9b::a00:1', '64:ff9b::7f00:1', '64:ff9b:1::1',
  '2002:7f00:1::', '2002:a9fe:a9fe::', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
];
const PUBLIC_V6 = ['2606:4700:4700::1111', '2400:cb00::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::'];

check('address: private and reserved IPv4 addresses are refused', () => {
  for (const ip of PRIVATE_V4) assert.equal(isPrivateAddress(ip), true, ip);
});

check('address: public IPv4 addresses are allowed', () => {
  for (const ip of PUBLIC_V4) assert.equal(isPrivateAddress(ip), false, ip);
});

check('address: private, reserved and unassigned IPv6 addresses are refused', () => {
  for (const ip of PRIVATE_V6) assert.equal(isPrivateAddress(ip), true, ip);
});

check('address: public IPv6 addresses are allowed, including NAT64 and 6to4 with public IPv4 inside', () => {
  for (const ip of PUBLIC_V6) assert.equal(isPrivateAddress(ip), false, ip);
});

check('address: malformed input is refused rather than allowed', () => {
  for (const ip of ['', 'not-an-ip', '1.2.3', '999.1.1.1', 'gggg::1', '1::2::3', '12345::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

check('fetch target: public https and http hosts are allowed', () => {
  assert.equal(normalizeFetchTarget('https://example.test/feed.xml'), 'https://example.test/feed.xml');
  assert.equal(normalizeFetchTarget('http://[2606:4700:4700::1111]/'), 'http://[2606:4700:4700::1111]/');
});

check('fetch target: localhost names and internal suffixes are refused', () => {
  for (const url of ['http://localhost/', 'https://app.localhost/', 'https://router.local/', 'https://api.internal/']) {
    assert.equal(normalizeFetchTarget(url), null, url);
  }
});

check('fetch target: private addresses are refused in every written form', () => {
  // The URL parser normalizes integer, hex and octal IPv4 hosts, so the check sees the real address.
  for (const url of [
    'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://0x7f.0.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[64:ff9b::a00:1]/', 'http://[2002:7f00:1::]/',
    'http://[fd00::5]/',
  ]) {
    assert.equal(normalizeFetchTarget(url), null, url);
  }
});

check('fetch target: unsafe schemes and credentials are refused', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.test/']) {
    assert.equal(normalizeFetchTarget(url), null, url);
  }
});

check('server guard: the same address rules apply to URLs validated for server-side fetches', () => {
  assert.equal(validateOutboundUrl('http://[64:ff9b::a00:1]/').valid, false);
  assert.equal(validateOutboundUrl('http://[2002:7f00:1::]/').valid, false);
  assert.equal(validateOutboundUrl('http://[64:ff9b::808:808]/').valid, true);
});

if (failures > 0) {
  console.log(`\n${failures} network address check(s) failed.`);
  process.exitCode = 1;
}
