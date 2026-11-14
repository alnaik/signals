// Never apply on LinkedIn (README, standing rules): a role from a LinkedIn alert is applied for
// on the company's own board. No imports, so the Apply panel can use it too.

/** A linkedin.com page (uk.linkedin.com too, never linkedin.com.evil.example) or an lnkd.in short link. */
export function isLinkedIn(url: string): boolean {
  try {
    return /(^|\.)(linkedin\.com|lnkd\.in)$/i.test(new URL(url).hostname.replace(/\.+$/, ""));
  } catch {
    return false;
  }
}
