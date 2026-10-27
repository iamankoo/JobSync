/**
 * Country (ISO alpha-2) from a location the source literally stated ("Remote (US)", "London, UK", "NYC").
 * Only unambiguous names are mapped; anything else stays unknown (the company is then not qualified).
 */
const PLACES: [RegExp, string][] = [
  [/\b(united states|u\.s\.a\.?|usa)\b/i, "US"],
  // Upper-case only, so "join us" never reads as the United States.
  [/(?<![A-Za-z])(US|U\.S\.)(?![A-Za-z])/, "US"],
  [/\b(san francisco|sf bay|bay area|new york|nyc|seattle|boston|austin|los angeles|chicago|denver|atlanta|miami|palo alto|mountain view|san jose|san diego|portland|washington,? dc|philadelphia|pittsburgh|salt lake|phoenix|dallas|houston|raleigh|minneapolis|nashville|brooklyn|menlo park|berkeley|oakland|redwood city|santa monica|cambridge,? ma)\b/i, "US"],
  [/,\s*(CA|NY|WA|MA|TX|CO|IL|GA|FL|OR|NC|PA|UT|AZ|MN|TN|VA|NJ|MD|DC|OH|MI)\b/, "US"],
  [/\b(united kingdom|england|scotland|london|manchester|edinburgh|bristol|oxford)\b/i, "GB"],
  [/(?<![A-Za-z])UK(?![A-Za-z])/, "GB"],
  [/(?<![A-Za-z])UAE(?![A-Za-z])/, "AE"],
  [/\b(singapore)\b/i, "SG"],
  [/\b(canada|toronto|vancouver|montreal|montréal|ottawa|calgary|waterloo)\b/i, "CA"],
  [/\b(germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|düsseldorf)\b/i, "DE"],
  [/\b(united arab emirates|dubai|abu dhabi)\b/i, "AE"],
  [/\b(australia|sydney|melbourne|brisbane|perth|adelaide)\b/i, "AU"],
  [/\b(france|paris|lyon)\b/i, "FR"],
  [/\b(italy|milan|milano|rome|roma|turin|torino)\b/i, "IT"],
  [/\b(poland|warsaw|warszawa|krakow|kraków|wroclaw|wrocław|gdansk|gdańsk)\b/i, "PL"],
  [/\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai)\b/i, "IN"],
  [/\b(netherlands|amsterdam|spain|madrid|barcelona|portugal|lisbon|sweden|stockholm|switzerland|zurich|ireland|dublin|israel|tel aviv|brazil|mexico|japan|tokyo)\b/i, "OTHER"],
];

/** First country clearly named in `location`; "OTHER" for a recognised non-target country; undefined if none. */
export function countryFromLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  let best: { at: number; code: string } | null = null;
  for (const [re, code] of PLACES) {
    const m = re.exec(location);
    if (m && (best === null || m.index < best.at)) best = { at: m.index, code };
  }
  return best?.code;
}

export const isRemote = (text: string | undefined) => Boolean(text && /\bremote\b/i.test(text));
