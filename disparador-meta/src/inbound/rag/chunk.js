export function chunkText(text, { chunkSize = 1000, overlap = 200 } = {}) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    if (end < normalized.length) {
      const slice = normalized.slice(start, end);
      const breakAt = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('\n'),
        slice.lastIndexOf('. '),
        slice.lastIndexOf(' '),
      );
      if (breakAt > chunkSize * 0.5) {
        end = start + breakAt + 1;
      }
    }

    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push(piece);

    if (end >= normalized.length) break;
    start = Math.max(0, end - overlap);
    if (start >= normalized.length) break;
  }

  return chunks;
}
