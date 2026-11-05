/**
 * 最小 ZIP 读取器（只服务 `.docx` 文本提取）。
 *
 * 支持 store（0）与 deflate（8）两种方法；不支持 ZIP64、加密与多卷。上限不是
 * 装饰：上传文件是不可信输入，压缩炸弹必须先被单条目的解压上限挡住，再谈解析。
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const MAX_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export interface ZipEntryData {
  readonly name: string;
  readonly bytes: Buffer;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/** 读出指定条目；不存在的条目返回 `undefined`，结构损坏则抛错。 */
export function readZipEntry(bytes: Buffer, wanted: string): ZipEntryData | undefined {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件");

  const count = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error("ZIP 条目过多");
  if (centralOffset >= bytes.length) throw new Error("ZIP 目录越界");

  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("ZIP 中央目录损坏");
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) throw new Error("ZIP 文件名越界");
    const name = bytes.subarray(nameStart, nameEnd).toString("utf8");

    total += uncompressedSize;
    if (uncompressedSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
      throw new Error("ZIP 解压后体积超出上限");
    }

    if (name === wanted) {
      if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
        throw new Error("ZIP 本地文件头损坏");
      }
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) throw new Error("ZIP 条目数据越界");
      const raw = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return { name, bytes: Buffer.from(raw) };
      if (method === 8) {
        try {
          return {
            name,
            bytes: inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }),
          };
        } catch {
          throw new Error("ZIP 条目解压失败");
        }
      }
      throw new Error(`不支持的 ZIP 压缩方法：${String(method)}`);
    }

    offset = nameEnd + extraLength + commentLength;
  }
  return undefined;
}
