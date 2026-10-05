// Small, dependency-free QR encoder for short same-origin join URLs.
// Keep Version 5-L for existing short links; Version 6-L holds preview links.
// Each entry describes a complete QR block layout, not just a byte limit.
const VERSIONS = [
  { version: 5, dataCodewords: 108, eccCodewords: 26, blocks: 1 },
  { version: 6, dataCodewords: 136, eccCodewords: 18, blocks: 2 },
];

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function remainder(data, generator) {
  const result = new Uint8Array(generator.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) {
      result[i] ^= gfMultiply(generator[i], factor);
    }
  }
  return result;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function encodePayload(text) {
  const bytes = new TextEncoder().encode(text);
  // Versions 5/6 use a 4-bit byte-mode header and an 8-bit byte count.
  const layout = VERSIONS.find(({ dataCodewords }) => bytes.length * 8 + 12 <= dataCodewords * 8);
  if (!layout) throw new Error('扫码链接太长，请配置更短的 PUBLIC_URL。');
  const { version, dataCodewords, eccCodewords, blocks } = layout;

  const bits = [];
  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacity = dataCodewords * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  for (let pad = 0; data.length < dataCodewords; pad += 1) {
    data.push(pad % 2 ? 0x11 : 0xec);
  }

  // Both supported layouts have equally sized data blocks. Compute each
  // block's Reed–Solomon remainder, then interleave data followed by ECC.
  const blockSize = dataCodewords / blocks;
  const generator = divisor(eccCodewords);
  const chunks = Array.from({ length: blocks }, (_, i) => data.slice(i * blockSize, (i + 1) * blockSize));
  const errors = chunks.map((chunk) => remainder(chunk, generator));
  const codewords = [];
  for (let i = 0; i < blockSize; i += 1) for (const chunk of chunks) codewords.push(chunk[i]);
  for (let i = 0; i < eccCodewords; i += 1) for (const error of errors) codewords.push(error[i]);
  return { codewords, version };
}

function formatBits(mask) {
  const data = (0b01 << 3) | mask; // L error correction
  let value = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >>> i) & 1) value ^= 0x537 << (i - 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

function buildMatrix(codewords, version, mask = 0) {
  const SIZE = 17 + version * 4;
  const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const functional = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));

  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    modules[y][x] = Boolean(dark);
    functional[y][x] = true;
  };

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const dark = distance !== 2 && distance !== 4;
        setFunction(cx + dx, cy + dy, dark);
      }
    }
  };
  finder(3, 3);
  finder(SIZE - 4, 3);
  finder(3, SIZE - 4);

  for (let i = 8; i < SIZE - 8; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  for (const y of [6, SIZE - 7]) {
    for (const x of [6, SIZE - 7]) {
      if (functional[y][x]) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  const fmt = formatBits(mask);
  const bit = (i) => ((fmt >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) setFunction(8, i, bit(i));
  setFunction(8, 7, bit(6));
  setFunction(8, 8, bit(7));
  setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) setFunction(SIZE - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFunction(8, SIZE - 15 + i, bit(i));
  setFunction(8, SIZE - 8, true);

  const dataBits = [];
  for (const codeword of codewords) appendBits(dataBits, codeword, 8);
  let index = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert += 1) {
      const y = upward ? SIZE - 1 - vert : vert;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (functional[y][x]) continue;
        let dark = dataBits[index] === 1;
        index += 1;
        if ((x + y) % 2 === 0) dark = !dark; // mask 0
        modules[y][x] = dark;
      }
    }
    upward = !upward;
  }
  return modules;
}

// Style A (#348 B, decision 31): data modules are round dots, the three
// finder patterns are rounded frames in the brand teal around a dark centre,
// and the alignment pattern stays one solid rounded shape, never dots, since
// readers locate the symbol by these. Dark on white in both themes, with a
// quiet zone of 4 modules. Only the drawing changes; the encoding does not.
const QUIET = 4;
const INK = '#1f2328';
const TEAL = '#097981';
// Each dot is a zero-length stroke with round caps: a circle of radius DOT,
// about a fifth of the size of drawing every circle as arcs.
const DOT = 0.5;

const n = (value) => Number(value.toFixed(3));
// A rounded square as a path, clockwise, from its top-left corner.
const rounded = (x, y, size, r) => {
  const side = n(size - 2 * r);
  return `M${n(x + r)},${n(y)}h${side}a${r},${r} 0 0 1 ${r},${r}v${side}a${r},${r} 0 0 1 -${r},${r}h-${side}a${r},${r} 0 0 1 -${r},-${r}v-${side}a${r},${r} 0 0 1 ${r},-${r}z`;
};
export function qrSvg(text) {
  const { codewords, version } = encodePayload(text);
  const SIZE = 17 + version * 4;
  const FINDERS = [[0, 0], [SIZE - 7, 0], [0, SIZE - 7]];
  const ALIGNMENT = [SIZE - 7, SIZE - 7];
  const insideFinder = (x, y) => FINDERS.some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
  const insideAlignment = (x, y) => Math.abs(x - ALIGNMENT[0]) <= 2 && Math.abs(y - ALIGNMENT[1]) <= 2;
  const matrix = buildMatrix(codewords, version);
  const viewSize = SIZE + QUIET * 2;
  const dots = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!matrix[y][x] || insideFinder(x, y) || insideAlignment(x, y)) continue;
      const cx = x + QUIET + 0.5;
      const cy = y + QUIET + 0.5;
      dots.push(`M${cx} ${cy}h0`);
    }
  }
  const shapes = [];
  for (const [fx, fy] of FINDERS) {
    const x = fx + QUIET;
    const y = fy + QUIET;
    shapes.push(`<path fill-rule="evenodd" fill="${TEAL}" d="${rounded(x, y, 7, 1.6)}${rounded(x + 1, y + 1, 5, 0.6)}"/>`);
    shapes.push(`<path fill="${INK}" d="${rounded(x + 2, y + 2, 3, 0.8)}"/>`);
  }
  const ax = ALIGNMENT[0] - 2 + QUIET;
  const ay = ALIGNMENT[1] - 2 + QUIET;
  shapes.push(`<path fill-rule="evenodd" fill="${INK}" d="${rounded(ax, ay, 5, 1.2)}${rounded(ax + 1, ay + 1, 3, 0.6)}"/>`);
  shapes.push(`<circle cx="${ax + 2.5}" cy="${ay + 2.5}" r="0.5" fill="${INK}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}"><rect width="100%" height="100%" fill="#fff"/><path d="${dots.join('')}" fill="none" stroke="${INK}" stroke-width="${DOT * 2}" stroke-linecap="round"/>${shapes.join('')}</svg>`;
}

export function qrDataUrl(text) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(text))}`;
}
