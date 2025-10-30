/**
 * Extracts content wrapped in specified tags from a string
 * @param content The content string to process
 * @param tag The tag name without angle brackets (e.g., 'think' for '<think></think>')
 * @returns Array of content strings found inside the tags
 */
export function extractContentTags(
  content: string | null | undefined,
  tag: string
): string[] {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const results: string[] = [];
  let startIndex = 0;

  while (true) {
    const openIndex = content.indexOf(openTag, startIndex);
    if (openIndex === -1) break;

    const contentStart = openIndex + openTag.length;
    const closeIndex = content.indexOf(closeTag, contentStart);
    if (closeIndex === -1) break;

    const tagContent = content.substring(contentStart, closeIndex);
    if (tagContent.trim()) {
      results.push(tagContent.trim());
    }

    startIndex = closeIndex + closeTag.length;
  }

  return results;
}
