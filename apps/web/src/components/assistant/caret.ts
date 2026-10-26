/** The styles that decide where text wraps in a textarea, copied onto the mirror */
const COPIED = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'tabSize',
] as const;

/**
 * Where a character offset of a textarea sits, relative to the textarea's box. A textarea gives no
 * geometry for its text, so a hidden mirror with the same wrapping is laid out up to the offset and
 * a marker's position read from it: the usual way, and the only one without an editor library.
 */
export function caretPoint(textarea: HTMLTextAreaElement, offset: number): { top: number; left: number; height: number } {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement('div');
  for (const key of COPIED) mirror.style[key] = style[key];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.textContent = textarea.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(offset, offset + 1) || '.';
  mirror.append(marker);
  document.body.append(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
  const point = { top: marker.offsetTop - textarea.scrollTop, left: marker.offsetLeft - textarea.scrollLeft, height: lineHeight };
  mirror.remove();
  return point;
}
