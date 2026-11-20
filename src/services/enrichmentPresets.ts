/**
 * Dashboard blocks built on enrichment data. They use the same filters as the read API, so the server does the
 * matching and the client only builds the query.
 */
import type { EnrichmentFilters } from '../types';

export interface EnrichmentPreset {
  title: string;
  categoryFilter: string;
  filterKeyword?: string;
  layout: 'hero' | 'grid' | 'compact' | 'list' | 'media-wall' | 'ticker';
  itemCount: number;
  accentColor: string;
  enrichment: EnrichmentFilters;
}

export const ENRICHMENT_PRESETS: EnrichmentPreset[] = [
  {
    title: 'KEV-listed CVEs, critical (severity from article text)',
    categoryFilter: 'all',
    layout: 'hero',
    itemCount: 6,
    accentColor: 'from-red-600 to-orange-500',
    enrichment: { kev: true, severity: 'critical' },
  },
  {
    title: 'High exploit probability (EPSS 0.5+)',
    categoryFilter: 'all',
    layout: 'grid',
    itemCount: 6,
    accentColor: 'from-purple-600 to-fuchsia-500',
    enrichment: { minEpss: 0.5 },
  },
  {
    title: 'Recent exploits in the wild',
    categoryFilter: 'exploits',
    layout: 'list',
    itemCount: 8,
    accentColor: 'from-rose-600 to-red-500',
    enrichment: { kev: true },
  },
  {
    title: 'Initial access techniques (T1190)',
    categoryFilter: 'all',
    layout: 'compact',
    itemCount: 6,
    accentColor: 'from-cyan-600 to-blue-500',
    enrichment: { technique: 'T1190' },
  },
  {
    title: 'Microsoft advisories',
    categoryFilter: 'vendor-advisories',
    layout: 'grid',
    itemCount: 6,
    accentColor: 'from-blue-600 to-sky-500',
    enrichment: { vendor: 'microsoft' },
  },
];
