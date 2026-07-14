/**
 * Build a wa.me reply link from an Ecuadorian landowner phone. Strips
 * non-digits and normalizes a local 0-prefixed 10-digit number to +593.
 * Returns null when there is nothing usable.
 */
export function buildWhatsappReplyLink(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10 && digits.startsWith("0")) {
    digits = `593${digits.slice(1)}`;
  }
  return `https://wa.me/${digits}`;
}
