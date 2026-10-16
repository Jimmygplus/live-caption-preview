function roundToStep(value, min, step) {
  return min + Math.round((value - min) / step) * step;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function linkedFontSizes({ changed, value, ratio, min = 16, max = 96, step = 2 }) {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  if (changed === 'original') {
    const allowedMin = Math.max(min, min * safeRatio);
    const allowedMax = Math.min(max, max * safeRatio);
    const original = roundToStep(clamp(value, allowedMin, allowedMax), min, step);
    const translation = roundToStep(clamp(original / safeRatio, min, max), min, step);
    return { original, translation };
  }
  const allowedMin = Math.max(min, min / safeRatio);
  const allowedMax = Math.min(max, max / safeRatio);
  const translation = roundToStep(clamp(value, allowedMin, allowedMax), min, step);
  const original = roundToStep(clamp(translation * safeRatio, min, max), min, step);
  return { original, translation };
}
