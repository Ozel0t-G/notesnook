/**
 * Remote announcements must not reintroduce upstream branding or commercial
 * purchase calls. Fail closed for malformed payloads.
 */
export function isVeyranAnnouncementAllowed(announcement: unknown): boolean {
  if (!announcement || typeof announcement !== "object") return false;
  try {
    return !/notesnook|streetwriters|upgrade|\bpro\b|pricing|subscribe|subscription|\btrial\b/i.test(
      JSON.stringify(announcement)
    );
  } catch {
    return false;
  }
}
