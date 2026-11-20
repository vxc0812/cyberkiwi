import { RssFeed } from '../types';

export const CYBERSEC_DEFAULT_FEEDS: RssFeed[] = [
  // === VULNERABILITY DATABASES & ADVISORIES ===
  { id: 'nvd', title: 'NVD - National Vulnerability Database', url: 'https://services.nvd.nist.gov/rest/json/cves/2.0', category: 'vulnerabilities', icon: '🔴', active: true, status: 'ok' },
  { id: 'cve_trends', title: 'CVE Trends', url: 'https://cvetrends.com/rss', category: 'vulnerabilities', icon: '📊', active: true, status: 'ok' },
  { id: 'mitre_cve', title: 'MITRE CVE List', url: 'https://cve.mitre.org/cve/rss.xml', category: 'vulnerabilities', icon: '🎯', active: true, status: 'ok' },
  
  // === VENDOR SECURITY ADVISORIES ===
  { id: 'msrc', title: 'Microsoft Security Response Center', url: 'https://msrc.microsoft.com/blog/feed/', category: 'vendor-advisories', icon: '🪟', active: true, status: 'ok' },
  { id: 'apple_security', title: 'Apple Security Announcements', url: 'https://support.apple.com/en-us/HT201222/rss', category: 'vendor-advisories', icon: '🍎', active: true, status: 'ok' },
  { id: 'google_security', title: 'Google Security Blog', url: 'https://security.googleblog.com/feeds/posts/default', category: 'vendor-advisories', icon: '🔍', active: true, status: 'ok' },
  { id: 'android_security', title: 'Android Security Bulletins', url: 'https://source.android.com/security/bulletin/rss.xml', category: 'vendor-advisories', icon: '🤖', active: true, status: 'ok' },
  { id: 'cisco_security', title: 'Cisco Security Advisories', url: 'https://tools.cisco.com/security/center/erdd.xml', category: 'vendor-advisories', icon: '🌐', active: true, status: 'ok' },
  { id: 'redhat_security', title: 'Red Hat Security', url: 'https://access.redhat.com/blogs/766093/feed', category: 'vendor-advisories', icon: '🎩', active: true, status: 'ok' },
  { id: 'ubuntu_security', title: 'Ubuntu Security Notices', url: 'https://ubuntu.com/security/notices/rss.xml', category: 'vendor-advisories', icon: '🟠', active: true, status: 'ok' },
  
  // === THREAT INTELLIGENCE & INCIDENT RESPONSE ===
  { id: 'mandiant', title: 'Mandiant (Google Cloud) Threat Intel', url: 'https://www.mandiant.com/resources/blog/rss', category: 'threat-intel', icon: '🕵️', active: true, status: 'ok' },
  { id: 'crowdstrike', title: 'CrowdStrike Blog', url: 'https://www.crowdstrike.com/blog/feed/', category: 'threat-intel', icon: '🦅', active: true, status: 'ok' },
  { id: 'sentinelone', title: 'SentinelOne Research', url: 'https://www.sentinelone.com/labs/feed/', category: 'threat-intel', icon: '🛡️', active: true, status: 'ok' },
  { id: 'paloalto_unit42', title: 'Palo Alto Unit 42', url: 'https://unit42.paloaltonetworks.com/feed/', category: 'threat-intel', icon: '🔬', active: true, status: 'ok' },
  { id: 'secureworks', title: 'Secureworks CTU', url: 'https://www.secureworks.com/research/feed', category: 'threat-intel', icon: '🎯', active: true, status: 'ok' },
  { id: 'ibm_xforce', title: 'IBM X-Force', url: 'https://securityintelligence.com/feed/', category: 'threat-intel', icon: '💙', active: true, status: 'ok' },
  { id: 'talos', title: 'Cisco Talos Intelligence', url: 'https://blog.talosintelligence.com/rss.xml', category: 'threat-intel', icon: '🛡️', active: true, status: 'ok' },
  { id: 'fortiguard', title: 'FortiGuard Labs', url: 'https://www.fortiguard.com/rss/feed', category: 'threat-intel', icon: '🏰', active: true, status: 'ok' },
  
  // === EXPLOIT DEVELOPMENT & RESEARCH ===
  { id: 'exploit_db', title: 'Exploit-DB', url: 'https://www.exploit-db.com/rss.xml', category: 'exploits', icon: '💣', active: true, status: 'ok' },
  { id: 'packetstorm', title: 'Packet Storm Security', url: 'https://packetstormsecurity.com/files/rss/', category: 'exploits', icon: '📦', active: true, status: 'ok' },
  { id: 'zerodayinitiative', title: 'Zero Day Initiative', url: 'https://www.zerodayinitiative.com/rss/published/', category: 'exploits', icon: '🎯', active: true, status: 'ok' },
  { id: 'project_zero', title: 'Google Project Zero', url: 'https://googleprojectzero.blogspot.com/feeds/posts/default', category: 'exploits', icon: '🔬', active: true, status: 'ok' },
  { id: 'rapid7', title: 'Rapid7 Blog', url: 'https://blog.rapid7.com/rss/', category: 'exploits', icon: '🚀', active: true, status: 'ok' },
  { id: 'metasploit', title: 'Metasploit Framework', url: 'https://github.com/rapid7/metasploit-framework/commits/master.atom', category: 'exploits', icon: '⚔️', active: true, status: 'ok' },
  
  // === MALWARE ANALYSIS & REVERSE ENGINEERING ===
  { id: 'malwarebytes', title: 'Malwarebytes Labs', url: 'https://blog.malwarebytes.com/feed/', category: 'malware', icon: '🦠', active: true, status: 'ok' },
  { id: 'virustotal', title: 'VirusTotal Blog', url: 'https://blog.virustotal.com/feeds/posts/default', category: 'malware', icon: '🔬', active: true, status: 'ok' },
  { id: 'any_run', title: 'ANY.RUN Blog', url: 'https://any.run/blog/feed/', category: 'malware', icon: '🏃', active: true, status: 'ok' },
  { id: 'hybrid_analysis', title: 'Hybrid Analysis', url: 'https://www.hybrid-analysis.com/feed', category: 'malware', icon: '🧬', active: true, status: 'ok' },
  
  // === SECURITY NEWS AGGREGATORS ===
  { id: 'thehackernews', title: 'The Hacker News', url: 'https://thehackernews.com/feeds/posts/default', category: 'news', icon: '📰', active: true, status: 'ok' },
  { id: 'bleepingcomputer', title: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/', category: 'news', icon: '💻', active: true, status: 'ok' },
  { id: 'darkreading', title: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml', category: 'news', icon: '🌑', active: true, status: 'ok' },
  { id: 'securityweek', title: 'SecurityWeek', url: 'https://www.securityweek.com/feed/', category: 'news', icon: '📅', active: true, status: 'ok' },
  { id: 'infosecurity', title: 'Infosecurity Magazine', url: 'https://www.infosecurity-magazine.com/rss/news/', category: 'news', icon: '🔒', active: true, status: 'ok' },
  { id: 'scmagazine', title: 'SC Magazine', url: 'https://www.scmagazine.com/feed/', category: 'news', icon: '📋', active: true, status: 'ok' },
  { id: 'helpnetsecurity', title: 'Help Net Security', url: 'https://www.helpnetsecurity.com/feed/', category: 'news', icon: '🆘', active: true, status: 'ok' },
  { id: 'krebsonsecurity', title: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/', category: 'news', icon: '🎯', active: true, status: 'ok' },
  { id: 'schneier', title: 'Schneier on Security', url: 'https://www.schneier.com/feed/atom/', category: 'news', icon: '🧠', active: true, status: 'ok' },
  { id: 'grahamcluley', title: 'Graham Cluley', url: 'https://grahamcluley.com/feed/', category: 'news', icon: '🎙️', active: true, status: 'ok' },
  
  // === SPECIALIZED TOPICS ===
  { id: 'iotsec', title: 'IoT Security', url: 'https://iotsecuritynews.com/feed/', category: 'iot', icon: '📱', active: true, status: 'ok' },
  { id: 'appsec', title: 'Application Security', url: 'https://www.appsecnews.com/feed/', category: 'appsec', icon: '🛠️', active: true, status: 'ok' },
  { id: 'devsecops', title: 'DevSecOps', url: 'https://devsecops.org/feed/', category: 'devsecops', icon: '⚙️', active: true, status: 'ok' },
  { id: 'privacy', title: 'Privacy News', url: 'https://www.privacyguides.org/feed.xml', category: 'privacy', icon: '🕵️‍♀️', active: true, status: 'ok' },
  { id: 'crypto', title: 'Cryptography Engineering', url: 'https://blog.cryptographyengineering.com/feed/', category: 'crypto', icon: '🔐', active: true, status: 'ok' },
  
  // === CERT/CSIRT FEEDS ===
  { id: 'us_cert', title: 'CISA Alerts', url: 'https://www.cisa.gov/uscert/ncas/alerts.xml', category: 'cert', icon: '🇺🇸', active: true, status: 'ok' },
  { id: 'cisa_ics', title: 'CISA ICS Advisories', url: 'https://www.cisa.gov/uscert/ics/advisories/advisories.xml', category: 'cert', icon: '🏭', active: true, status: 'ok' },
  { id: 'enisa', title: 'ENISA Threat Landscape', url: 'https://www.enisa.europa.eu/rss.xml', category: 'cert', icon: '🇪🇺', active: true, status: 'ok' },
  { id: 'cert_eu', title: 'CERT-EU', url: 'https://cert.europa.eu/rss.xml', category: 'cert', icon: '🇪🇺', active: true, status: 'ok' },
  
  // === BUG BOUNTY & VULN DISCLOSURE ===
  { id: 'hackerone', title: 'HackerOne Blog', url: 'https://www.hackerone.com/blog/rss', category: 'bugbounty', icon: '🎁', active: true, status: 'ok' },
  { id: 'bugcrowd', title: 'Bugcrowd Blog', url: 'https://www.bugcrowd.com/blog/feed/', category: 'bugbounty', icon: '🐛', active: true, status: 'ok' },
  { id: 'intigriti', title: 'Intigriti Blog', url: 'https://blog.intigriti.com/feed/', category: 'bugbounty', icon: '💎', active: true, status: 'ok' },
  { id: 'yeswehack', title: 'YesWeHack Blog', url: 'https://blog.yeswehack.com/feed/', category: 'bugbounty', icon: '✅', active: true, status: 'ok' },
  
  // === PODCASTS / VIDEO (via RSS) ===
  { id: 'darknet_diaries', title: 'Darknet Diaries', url: 'https://podcast.darknetdiaries.com/', category: 'podcasts', icon: '🎧', active: true, status: 'ok' },
  { id: 'risky_biz', title: 'Risky Business', url: 'https://risky.biz/feeds/risky-business/', category: 'podcasts', icon: '🎙️', active: true, status: 'ok' },
  { id: 'security_now', title: 'Security Now!', url: 'https://feeds.twit.tv/sn.xml', category: 'podcasts', icon: '📻', active: true, status: 'ok' },
  { id: 'cyberwire_daily', title: 'CyberWire Daily', url: 'https://thecyberwire.com/podcasts/daily-podcast/rss.xml', category: 'podcasts', icon: '🎧', active: true, status: 'ok' },
];

export const LEGACY_PODCAST_FEED_IDS = new Map([
  ['https://darknetdiaries.com/feed/', 'darknet_diaries'],
  ['https://risky.biz/rss/', 'risky_biz'],
  ['https://feeds.twit.tv/sn_audio.xml', 'security_now'],
  ['https://malicious.life/feed/', 'cyberwire_daily'],
]);
