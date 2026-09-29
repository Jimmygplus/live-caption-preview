// Small, dependency-free QR encoder for short same-origin join URLs.
// It emits a Version 5 / error-correction L symbol (up to 106 UTF-8 bytes).

const VERSION = 5;
const SIZE = 17 + VERSION * 4;
const DATA_CODEWORDS = 108;
const ECC_CODEWORDS = 26;

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
  if (bytes.length > 106) throw new Error('扫码链接太长，请配置更短的 PUBLIC_URL。');

  const bits = [];
  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacity = DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad += 1) {
    data.push(pad % 2 ? 0x11 : 0xec);
  }

  return [...data, ...remainder(data, divisor(ECC_CODEWORDS))];
}

function formatBits(mask) {
  const data = (0b01 << 3) | mask; // L error correction
  let value = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >>> i) & 1) value ^= 0x537 << (i - 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

function buildMatrix(codewords, mask = 0) {
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

  for (const y of [6, 30]) {
    for (const x of [6, 30]) {
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

export function qrSvg(text) {
  const matrix = buildMatrix(encodePayload(text));
  const quiet = 4;
  const viewSize = SIZE + quiet * 2;
  const path = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (matrix[y][x]) path.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path.join('')}" fill="#000"/></svg>`;
}

export function qrDataUrl(text) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(text))}`;
}
