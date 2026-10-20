/** A block name identifies a data contract, not a transport role or authority. */
export function blockHeader(type, explanation) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(type)) throw Error('Invalid context block type');
  if (explanation !== undefined && (typeof explanation !== 'string' || !explanation.trim() || /[\r\n\[\]]/.test(explanation))) throw Error('Invalid context block explanation');
  return `[${type}${explanation === undefined ? '' : ': ' + explanation}]`;
}
export function renderBlock(type, body, explanation) {
  return blockHeader(type, explanation) + '\n' + body;
}
export function renderDataBlock(type, data, explanation) {
  return renderBlock(type, JSON.stringify(data), explanation);
}
export function findBlockHeader(text, type) {
  blockHeader(type);
  const match = new RegExp('(?:^|\\n)(\\[' + type + '(?:: [^\\]\\r\\n]+)?\\]\\n)').exec(text);
  return match ? {index: match.index + (match[0].startsWith('\n') ? 1 : 0), header: match[1]} : undefined;
}
