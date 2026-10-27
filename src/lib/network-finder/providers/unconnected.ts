import "server-only";
import { ProviderError } from "../errors";
import type { CompanySourceId } from "../types";
import type { CompanySource, ContactProvider, JobSource } from "./types";

/**
 * Placeholders for the real adapters, which are NOT connected in this milestone. Each one refuses with
 * `not_configured` instead of returning anything, so nothing downstream can ever mistake "not connected"
 * for "no results" or receive invented data.
 *
 * The real adapters replace these one by one, each only after its access method is confirmed to be
 * permitted (an official API or a page whose terms and robots rules allow automated access).
 */

function refuse(provider: string): never {
  throw new ProviderError(provider, "not_configured", "this provider is not connected yet");
}

export function unconnectedCompanySource(id: CompanySourceId): CompanySource {
  return { id, discover: async () => refuse(id) };
}

/** YC startup directory (adapter pending: access method to be confirmed). */
export const ycSource: CompanySource = unconnectedCompanySource("yc");

/** Wellfound (adapter pending: it offers no public API, so a permitted access method must be agreed first). */
export const wellfoundSource: CompanySource = unconnectedCompanySource("wellfound");

/** Apollo people search + enrichment (adapter pending: credentials and plan/API access to be confirmed). */
export const apolloProvider: ContactProvider = {
  id: "apollo",
  searchPeople: async () => refuse("apollo"),
  enrichPerson: async () => refuse("apollo"),
};

/** Company career boards / supported job APIs (adapter pending). LinkedIn is deliberately not scraped. */
export const careersJobSource: JobSource = {
  id: "careers",
  findCompanyJobs: async () => refuse("careers"),
  searchJobs: async () => refuse("careers"),
};
