/** Formats a date for display in pack history (typo fix: "recieved" → "received"). */
export function formatReceivedDate(d: Date): string {
  return `received ${d.toISOString().slice(0, 10)}`;
}
