export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const DEFAULT_CORNER = 'bottom-right';

export function nearestCorner(bounds, workArea) {
  const vertical = bounds.y + bounds.height / 2 < workArea.y + workArea.height / 2 ? 'top' : 'bottom';
  const horizontal = bounds.x + bounds.width / 2 < workArea.x + workArea.width / 2 ? 'left' : 'right';
  return `${vertical}-${horizontal}`;
}

export function cornerBounds(corner, workArea, { width, height }, margin) {
  const [vertical, horizontal] = corner.split('-');
  return {
    x: horizontal === 'left' ? workArea.x + margin : workArea.x + workArea.width - width - margin,
    y: vertical === 'top' ? workArea.y + margin : workArea.y + workArea.height - height - margin,
    width,
    height,
  };
}
