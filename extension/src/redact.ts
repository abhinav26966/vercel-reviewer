/**
 * Extension-side redaction (doc 03 A2, doc 07 §4.6): password inputs and
 * secret-pattern fields are redacted INSIDE the extension, before anything
 * leaves the browser. The trace never contains the plaintext.
 */
export const REDACTED_PASSWORD = "«redacted:password»";
export const REDACTED_SECRET = "«redacted:secret»";

const SECRET_FIELD_PATTERN = /card|cvc|cvv|ssn|secret|token|password|passwd|pin/i;

export function redactInputValue(el: Element, value: string): string {
  if (el.tagName.toLowerCase() !== "input" && el.tagName.toLowerCase() !== "textarea") return value;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (type === "password") return REDACTED_PASSWORD;
  const hints = [
    el.getAttribute("name") ?? "",
    el.getAttribute("id") ?? "",
    el.getAttribute("autocomplete") ?? "",
    el.getAttribute("data-testid") ?? "",
  ].join(" ");
  if (SECRET_FIELD_PATTERN.test(hints)) return REDACTED_SECRET;
  return value;
}
