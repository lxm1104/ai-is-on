import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { transcodeToPcm16kMono } from './ffmpeg.js';
import { recognizePcmFile } from './larkSpeechToText.js';

export async function transcribeAudioBuffer(
  buf: Buffer,
  filenameHint: string
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-is-on-stt-'));
  const inputExt = (path.extname(filenameHint) || '.webm').toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(inputExt) ? inputExt : '.webm';
  const inputPath = path.join(tmpDir, `input-${randomBytes(4).toString('hex')}${safeExt}`);
  const pcmPath = path.join(tmpDir, 'output.pcm');
  try {
    await fs.writeFile(inputPath, buf);
    await transcodeToPcm16kMono(inputPath, pcmPath);
    const text = await recognizePcmFile(pcmPath);
    return text;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
