import * as fs from 'fs';
import * as path from 'path';

export function ensureDir(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error(`Failed to create directory ${dir}:`, error);
    throw new Error(`Cannot create required directory: ${dir}`);
  }
}

export function writeJsonAtomic(file: string, obj: any) {
  try {
    ensureDir(path.dirname(file));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    console.error(`Failed to persist data to ${file}:`, error);
    throw new Error(`Cannot write to file: ${file}`);
  }
}

export function toHexBlock(n: number): string {
  return '0x' + n.toString(16);
}