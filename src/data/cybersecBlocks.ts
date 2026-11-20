import { DynamicBlock } from '../types';

export const CYBERSEC_DEFAULT_BLOCKS: DynamicBlock[] = [
  {
    id: 'breaking-vulns',
    title: '🔴 Critical Vulnerabilities (Last 24h)',
    categoryFilter: 'vulnerabilities',
    filterKeyword: 'critical|CVSS 9|CVSS 10|zero-day|0-day|RCE|remote code execution',
    layout: 'hero',
    itemCount: 5,
    autoRefreshSec: 300,
    isPinned: true,
    accentColor: 'red',
  },
  {
    id: 'vendor-patches',
    title: '🪟 Vendor Security Advisories',
    categoryFilter: 'vendor-advisories',
    layout: 'grid',
    itemCount: 8,
    autoRefreshSec: 600,
    isPinned: true,
    accentColor: 'blue',
  },
  {
    id: 'threat-intel',
    title: '🕵️ Threat Intelligence & APT Reports',
    categoryFilter: 'threat-intel',
    layout: 'compact',
    itemCount: 10,
    autoRefreshSec: 900,
    accentColor: 'purple',
  },
  {
    id: 'exploit-dev',
    title: '💣 Exploit Development & PoCs',
    categoryFilter: 'exploits',
    layout: 'list',
    itemCount: 8,
    autoRefreshSec: 1800,
    accentColor: 'orange',
  },
  {
    id: 'malware-analysis',
    title: '🦠 Malware Analysis & Campaigns',
    categoryFilter: 'malware',
    layout: 'media-wall',
    itemCount: 8,
    autoRefreshSec: 1800,
    accentColor: 'emerald',
  },
  {
    id: 'sec-news',
    title: '📰 Security News Headlines',
    categoryFilter: 'news',
    layout: 'ticker',
    itemCount: 15,
    autoRefreshSec: 300,
    accentColor: 'cyan',
  },
  {
    id: 'cloud-security',
    title: '☁️ Cloud Security',
    categoryFilter: 'cloud',
    layout: 'grid',
    itemCount: 6,
    autoRefreshSec: 1800,
    accentColor: 'amber',
  },
  {
    id: 'iot-security',
    title: '📡 IoT Security',
    categoryFilter: 'iot',
    feedIds: ['iotsec'],
    layout: 'grid',
    itemCount: 6,
    autoRefreshSec: 1800,
    accentColor: 'amber',
  },
  {
    id: 'appsec',
    title: '🛡️ Application Security',
    categoryFilter: 'appsec',
    layout: 'list',
    itemCount: 8,
    autoRefreshSec: 1800,
    accentColor: 'blue',
  },
  {
    id: 'devsecops',
    title: '⚙️ DevSecOps',
    categoryFilter: 'devsecops',
    layout: 'list',
    itemCount: 8,
    autoRefreshSec: 1800,
    accentColor: 'purple',
  },
  {
    id: 'privacy',
    title: '🔒 Privacy & Data Protection',
    categoryFilter: 'privacy',
    layout: 'list',
    itemCount: 8,
    autoRefreshSec: 1800,
    accentColor: 'emerald',
  },
  {
    id: 'cert-alerts',
    title: '🇺🇸 CERT/CSIRT Official Alerts',
    categoryFilter: 'cert',
    layout: 'compact',
    itemCount: 10,
    autoRefreshSec: 600,
    isPinned: true,
    accentColor: 'red',
  },
  {
    id: 'bug-bounty',
    title: '🎁 Bug Bounty & VDP Updates',
    categoryFilter: 'bugbounty',
    layout: 'list',
    itemCount: 6,
    autoRefreshSec: 3600,
    accentColor: 'pink',
  },
  {
    id: 'podcasts',
    title: '🎧 Security Podcasts',
    categoryFilter: 'podcasts',
    layout: 'hero',
    itemCount: 4,
    autoRefreshSec: 86400,
    accentColor: 'violet',
  },
];

/**
 * Updates saved pre-beta dashboards without discarding user-created blocks.
 * The original catalog combined Cloud and IoT into one Cloud-filtered block,
 * which made the IoT tab query the wrong category. New coverage blocks are
 * appended only to saved CyberKiwi defaults, not arbitrary custom dashboards.
 */
export function migrateCybersecBlocks(blocks: DynamicBlock[]): DynamicBlock[] {
  if (!blocks.some((block) => block.id === 'breaking-vulns')) return blocks;

  const migrated = blocks.flatMap((block) => {
    if (block.id !== 'cloud-iot') return [block];
    return [
      {
        ...block,
        id: 'cloud-security',
        title: '☁️ Cloud Security',
        categoryFilter: 'cloud',
        feedIds: undefined,
      },
      {
        ...block,
        id: 'iot-security',
        title: '📡 IoT Security',
        categoryFilter: 'iot',
        feedIds: ['iotsec'],
      },
    ];
  });
  const existingCategories = new Set(migrated.map((block) => block.categoryFilter));
  const missingCoverage = CYBERSEC_DEFAULT_BLOCKS.filter((block) =>
    ['appsec', 'devsecops', 'privacy'].includes(block.categoryFilter ?? '') &&
    !existingCategories.has(block.categoryFilter)
  );

  return [...migrated, ...missingCoverage];
}
