import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function run(command, args, options = {}) {
  const { timeout = 45_000, ...rest } = options;
  return execFileSync(command, args, {
    encoding: 'utf8', timeout, maxBuffer: 24 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...rest,
  });
}

export function jsonCommand(command, args, options) {
  return JSON.parse(run(command, args, options));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID();
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

export function attempt(fn) {
  try {
    return { status: 'ok', data: fn() };
  } catch (error) {
    // Child output may contain account data, paths or authentication details.
    const reason = error.code === 'ENOENT' ? 'tool not installed' :
      Number.isInteger(error.status) ? 'command exited ' + error.status :
        error.code === 'ETIMEDOUT' ? 'command timed out' : 'unexpected or invalid response';
    return { status: 'unavailable', reason };
  }
}
