// The cycle never reads a request's cookies. If some path ever does, fail loudly instead of returning an empty session.
export async function cookies(): Promise<never> {
  throw new Error("cookies() is not available in the background function");
}
