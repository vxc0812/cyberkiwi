import assert from 'node:assert/strict';
import { CYBERSEC_DEFAULT_BLOCKS, migrateCybersecBlocks } from '../src/data/cybersecBlocks';

const categories = new Set(CYBERSEC_DEFAULT_BLOCKS.map((block) => block.categoryFilter));
for (const category of ['cloud', 'iot', 'appsec', 'devsecops', 'privacy']) {
  assert.ok(categories.has(category), `default dashboard includes ${category}`);
}

const migrated = migrateCybersecBlocks([
  {
    id: 'breaking-vulns',
    title: 'Vulnerabilities',
    categoryFilter: 'vulnerabilities',
    layout: 'list',
    itemCount: 5,
    autoRefreshSec: 300,
  },
  {
    id: 'cloud-iot',
    title: 'Cloud & IoT',
    categoryFilter: 'cloud',
    layout: 'grid',
    itemCount: 6,
    autoRefreshSec: 1800,
  },
]);

assert.ok(migrated.some((block) => block.id === 'cloud-security' && block.categoryFilter === 'cloud'));
assert.ok(migrated.some((block) => block.id === 'iot-security' && block.categoryFilter === 'iot'));
assert.ok(migrated.some((block) => block.id === 'appsec' && block.categoryFilter === 'appsec'));
assert.ok(migrated.some((block) => block.id === 'devsecops' && block.categoryFilter === 'devsecops'));
assert.ok(migrated.some((block) => block.id === 'privacy' && block.categoryFilter === 'privacy'));

console.log('✅ [PASS] cybersec dashboard categories and saved-block migration');
