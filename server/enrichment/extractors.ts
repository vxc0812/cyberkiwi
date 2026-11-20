/**
 * Pure extractors for article enrichment: CVE identifiers, ATT&CK techniques and named entities.
 *
 * These are rule-based and run without network access, so they cannot fail because an outside service is
 * down. The catalog feeds (KEV, EPSS) are handled separately in catalog.ts.
 *
 * The rules are deliberately narrow. A missed tag is better than a wrong one: a wrong tag would put an
 * article in a filter where it does not belong.
 */

export interface TechniqueRule {
  id: string;
  name: string;
  tactic: string;
  pattern: RegExp;
}

export const TECHNIQUE_RULES: readonly TechniqueRule[] = [
  {
    id: 'T1190',
    name: 'Exploit Public-Facing Application',
    tactic: 'Initial Access',
    pattern: /\b(?:public[- ]facing|internet[- ]facing|edge device|vpn gateway)\b[^.]{0,60}\bexploit\w*|\bexploit\w*\b[^.]{0,60}\b(?:public[- ]facing|internet[- ]facing|edge device|vpn gateway)\b/i,
  },
  { id: 'T1566', name: 'Phishing', tactic: 'Initial Access', pattern: /\b(?:spear[- ])?phishing\b/i },
  { id: 'T1189', name: 'Drive-by Compromise', tactic: 'Initial Access', pattern: /\bdrive[- ]by\b|\bwatering[- ]hole\b/i },
  { id: 'T1195', name: 'Supply Chain Compromise', tactic: 'Initial Access', pattern: /\bsupply[- ]chain (?:attack|compromise)s?\b/i },
  { id: 'T1078', name: 'Valid Accounts', tactic: 'Defense Evasion', pattern: /\b(?:stolen|compromised|leaked) (?:credentials|passwords|login)\b/i },
  { id: 'T1110', name: 'Brute Force', tactic: 'Credential Access', pattern: /\bbrute[- ]force\w*|\bcredential stuffing\b/i },
  { id: 'T1486', name: 'Data Encrypted for Impact', tactic: 'Impact', pattern: /\bransomware\b/i },
  { id: 'T1498', name: 'Network Denial of Service', tactic: 'Impact', pattern: /\bddos\b|\bdenial[- ]of[- ]service\b/i },
];

/** CVE identifiers, normalized to upper case, in first-seen order without duplicates. */
export function extractCveIds(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bCVE-(\d{4})-(\d{4,7})\b/gi)) {
    const year = Number(match[1]);
    if (year < 1999 || year > 2099) continue;
    found.add(`CVE-${match[1]}-${match[2]}`);
  }
  return [...found];
}

export function extractTechniques(text: string): TechniqueRule[] {
  return TECHNIQUE_RULES.filter((rule) => rule.pattern.test(text));
}

export interface EntityRule {
  type: 'VENDOR' | 'PRODUCT' | 'MALWARE_FAMILY' | 'THREAT_ACTOR';
  slug: string;
  name: string;
  pattern: RegExp;
}

/** Small, curated dictionary. Extend it deliberately, with a test for each addition. */
export const ENTITY_RULES: readonly EntityRule[] = [
  { type: 'VENDOR', slug: 'microsoft', name: 'Microsoft', pattern: /\bmicrosoft\b/i },
  { type: 'VENDOR', slug: 'cisco', name: 'Cisco', pattern: /\bcisco\b/i },
  { type: 'VENDOR', slug: 'fortinet', name: 'Fortinet', pattern: /\bfortinet\b|\bfortigate\b/i },
  { type: 'VENDOR', slug: 'ivanti', name: 'Ivanti', pattern: /\bivanti\b/i },
  { type: 'VENDOR', slug: 'citrix', name: 'Citrix', pattern: /\bcitrix\b/i },
  { type: 'VENDOR', slug: 'palo-alto-networks', name: 'Palo Alto Networks', pattern: /\bpalo alto networks\b/i },
  { type: 'VENDOR', slug: 'vmware', name: 'VMware', pattern: /\bvmware\b/i },
  { type: 'VENDOR', slug: 'atlassian', name: 'Atlassian', pattern: /\batlassian\b/i },
  { type: 'PRODUCT', slug: 'exchange-server', name: 'Exchange Server', pattern: /\bexchange server\b/i },
  { type: 'PRODUCT', slug: 'confluence', name: 'Confluence', pattern: /\bconfluence\b/i },
  { type: 'PRODUCT', slug: 'log4j', name: 'Log4j', pattern: /\blog4j\b/i },
  { type: 'MALWARE_FAMILY', slug: 'lockbit', name: 'LockBit', pattern: /\blockbit\b/i },
  { type: 'MALWARE_FAMILY', slug: 'emotet', name: 'Emotet', pattern: /\bemotet\b/i },
  { type: 'MALWARE_FAMILY', slug: 'qakbot', name: 'QakBot', pattern: /\bqakbot\b|\bqbot\b/i },
  { type: 'MALWARE_FAMILY', slug: 'cobalt-strike', name: 'Cobalt Strike', pattern: /\bcobalt strike\b/i },
  { type: 'MALWARE_FAMILY', slug: 'akira', name: 'Akira', pattern: /\bakira ransomware\b/i },
  { type: 'THREAT_ACTOR', slug: 'apt28', name: 'APT28', pattern: /\bapt ?28\b|\bfancy bear\b/i },
  { type: 'THREAT_ACTOR', slug: 'apt29', name: 'APT29', pattern: /\bapt ?29\b|\bcozy bear\b/i },
  { type: 'THREAT_ACTOR', slug: 'apt41', name: 'APT41', pattern: /\bapt ?41\b/i },
  { type: 'THREAT_ACTOR', slug: 'lazarus-group', name: 'Lazarus Group', pattern: /\blazarus group\b/i },
  { type: 'THREAT_ACTOR', slug: 'volt-typhoon', name: 'Volt Typhoon', pattern: /\bvolt typhoon\b/i },
  { type: 'THREAT_ACTOR', slug: 'scattered-spider', name: 'Scattered Spider', pattern: /\bscattered spider\b/i },
];

export function extractEntities(text: string): EntityRule[] {
  return ENTITY_RULES.filter((rule) => rule.pattern.test(text));
}
