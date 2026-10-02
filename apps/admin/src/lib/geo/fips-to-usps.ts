/**
 * FIPS state code to USPS abbreviation. The US geometry keys its states by
 * FIPS while the request property the counts are recorded under is the ISO
 * 3166-2 letters (which for the US are the USPS abbreviations), so a shaded
 * state map needs this table between them.
 *
 * The fifty states plus the District of Columbia — the exact set the vendored
 * `states-albers-10m` geometry draws. Territories carry FIPS codes too and are
 * deliberately absent: the geometry has no polygon for one, so a row here
 * would promise a fill nothing can paint.
 */
export const FIPS_TO_USPS: Readonly<Record<string, string>> = {
  '01': 'AL', // Alabama
  '02': 'AK', // Alaska
  '04': 'AZ', // Arizona
  '05': 'AR', // Arkansas
  '06': 'CA', // California
  '08': 'CO', // Colorado
  '09': 'CT', // Connecticut
  '10': 'DE', // Delaware
  '11': 'DC', // District of Columbia
  '12': 'FL', // Florida
  '13': 'GA', // Georgia
  '15': 'HI', // Hawaii
  '16': 'ID', // Idaho
  '17': 'IL', // Illinois
  '18': 'IN', // Indiana
  '19': 'IA', // Iowa
  '20': 'KS', // Kansas
  '21': 'KY', // Kentucky
  '22': 'LA', // Louisiana
  '23': 'ME', // Maine
  '24': 'MD', // Maryland
  '25': 'MA', // Massachusetts
  '26': 'MI', // Michigan
  '27': 'MN', // Minnesota
  '28': 'MS', // Mississippi
  '29': 'MO', // Missouri
  '30': 'MT', // Montana
  '31': 'NE', // Nebraska
  '32': 'NV', // Nevada
  '33': 'NH', // New Hampshire
  '34': 'NJ', // New Jersey
  '35': 'NM', // New Mexico
  '36': 'NY', // New York
  '37': 'NC', // North Carolina
  '38': 'ND', // North Dakota
  '39': 'OH', // Ohio
  '40': 'OK', // Oklahoma
  '41': 'OR', // Oregon
  '42': 'PA', // Pennsylvania
  '44': 'RI', // Rhode Island
  '45': 'SC', // South Carolina
  '46': 'SD', // South Dakota
  '47': 'TN', // Tennessee
  '48': 'TX', // Texas
  '49': 'UT', // Utah
  '50': 'VT', // Vermont
  '51': 'VA', // Virginia
  '53': 'WA', // Washington
  '54': 'WV', // West Virginia
  '55': 'WI', // Wisconsin
  '56': 'WY', // Wyoming
};

/** The USPS abbreviation the state geometry with this id is shaded for. */
export function uspsForGeometryId(id: string): string | null {
  return FIPS_TO_USPS[id] ?? null;
}
