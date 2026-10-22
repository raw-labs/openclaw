export function appendPublicationMessage(base: string, lines: readonly string[]): string {
  const footer = [...new Set(lines)].join("\n");
  return footer ? `${base.trimEnd()}\n\n${footer}` : base.trimEnd();
}

/** Prepared commits use our terminal credit footer, never matching prose elsewhere in the message. */
export function hasPublicationMessageFooter(
  message: string,
  coauthorTrailers: readonly string[],
  publicationMarker: string,
): boolean {
  const lines = message.replace(/[\r\n]+$/u, "").split(/\r?\n/u);
  const separator = lines.lastIndexOf("");
  if (separator < 1 || lines.at(-1) !== publicationMarker) {
    return false;
  }
  const actual = lines.slice(separator + 1, -1);
  const expected = new Set(coauthorTrailers);
  return actual.length === expected.size && [...expected].every((line) => actual.includes(line));
}
