// 零依赖 PNG 工具库：编码(RGBA) / 解码(8bit gray/rgb/rgba, 非隔行, filter 0-4) / 双线性缩放 / 品牌图标绘制
import { deflateSync, inflateSync } from 'node:zlib'

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// 用手工原始扫描行构造 PNG（测试/调试用）
export function makePng(width, height, colorType, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(buf) {
  if (!Buffer.from(buf.subarray(0, 8)).equals(PNG_SIGNATURE)) throw new Error('不是 PNG 文件')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii')
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}（仅支持 8bit）`)
  if (interlace !== 0) throw new Error('不支持隔行(Adam7) PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持颜色类型 ${colorType}（仅支持 0/2/4/6）`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new Error('IDAT 数据不完整')
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < line.length; i++) {
      const left = i >= channels ? line[i - channels] : 0
      const up = prev[i]
      const ul = i >= channels ? prev[i - channels] : 0
      switch (filter) {
        case 0:
          break
        case 1:
          line[i] = (line[i] + left) & 0xff
          break
        case 2:
          line[i] = (line[i] + up) & 0xff
          break
        case 3:
          line[i] = (line[i] + ((left + up) >> 1)) & 0xff
          break
        case 4:
          line[i] = (line[i] + paeth(left, up, ul)) & 0xff
          break
        default:
          throw new Error(`未知 PNG 过滤器 ${filter}`)
      }
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const s = x * channels
      if (colorType === 6) {
        out[o] = line[s]
        out[o + 1] = line[s + 1]
        out[o + 2] = line[s + 2]
        out[o + 3] = line[s + 3]
      } else if (colorType === 2) {
        out[o] = line[s]
        out[o + 1] = line[s + 1]
        out[o + 2] = line[s + 2]
        out[o + 3] = 255
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = line[s]
        out[o + 3] = 255
      } else {
        out[o] = out[o + 1] = out[o + 2] = line[s]
        out[o + 3] = line[s + 1]
      }
    }
    prev = line
  }
  return { width, height, rgba: out }
}

export function resizeBilinear(src, tw, th) {
  const out = Buffer.alloc(tw * th * 4)
  for (let y = 0; y < th; y++) {
    const gy = th === 1 ? 0 : (y * (src.height - 1)) / (th - 1)
    const y0 = Math.floor(gy)
    const y1 = Math.min(y0 + 1, src.height - 1)
    const fy = gy - y0
    for (let x = 0; x < tw; x++) {
      const gx = tw === 1 ? 0 : (x * (src.width - 1)) / (tw - 1)
      const x0 = Math.floor(gx)
      const x1 = Math.min(x0 + 1, src.width - 1)
      const fx = gx - x0
      for (let c = 0; c < 4; c++) {
        const p00 = src.rgba[(y0 * src.width + x0) * 4 + c]
        const p01 = src.rgba[(y0 * src.width + x1) * 4 + c]
        const p10 = src.rgba[(y1 * src.width + x0) * 4 + c]
        const p11 = src.rgba[(y1 * src.width + x1) * 4 + c]
        const v =
          p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy
        out[(y * tw + x) * 4 + c] = Math.round(v)
      }
    }
  }
  return { width: tw, height: th, rgba: out }
}

// 备用品牌图标：蓝色圆角方块 + 白色指针箭头（2x2 超采样）
function inRoundedRect(x, y, r) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function inArrow(x, y) {
  if (x >= 0.26 && x <= 0.44 && y >= 0.4 && y <= 0.6) return true
  if (x >= 0.44 && x <= 0.76) {
    const t = (0.76 - x) / 0.32
    if (Math.abs(y - 0.5) <= 0.2 * t) return true
  }
  return false
}

const BG = [49, 130, 206]

export function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const ss = 2
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cov = 0
      let white = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size
          const y = (py + (sy + 0.5) / ss) / size
          if (inRoundedRect(x, y, 0.22)) {
            cov++
            if (inArrow(x, y)) white++
          }
        }
      }
      const i = (py * size + px) * 4
      if (cov === 0) {
        rgba[i + 3] = 0
        continue
      }
      const w = white / cov
      rgba[i] = Math.round(BG[0] * (1 - w) + 255 * w)
      rgba[i + 1] = Math.round(BG[1] * (1 - w) + 255 * w)
      rgba[i + 2] = Math.round(BG[2] * (1 - w) + 255 * w)
      rgba[i + 3] = Math.round((255 * cov) / (ss * ss))
    }
  }
  return encodePng(size, size, rgba)
}
