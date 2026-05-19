import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { runLarkCli } from '../util/larkCli.js';

type SpeechResponse = {
  code?: number;
  msg?: string;
  data?: {
    recognition_text?: string;
  };
};

export async function recognizePcmFile(pcmPath: string): Promise<string> {
  const pcm = await fs.readFile(pcmPath);
  const speechB64 = pcm.toString('base64');
  // 飞书 API 实测要求 file_id 恰好 16 个字符（字母/数字/下划线）。
  // 8 字节 hex → 16 个字符。
  const fileId = randomBytes(8).toString('hex');

  const requestBody = {
    speech: { speech: speechB64 },
    config: { file_id: fileId, format: 'pcm', engine_type: '16k_auto' },
  };

  const { stdout, stderr, code } = await runLarkCli(
    [
      'api',
      'POST',
      '/open-apis/speech_to_text/v1/speech/file_recognize',
      '--as',
      'bot',
      '--data',
      '-',
      '--format',
      'json',
    ],
    JSON.stringify(requestBody)
  );

  if (code !== 0) {
    throw new Error(`lark-cli exit ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`);
  }

  let parsed: SpeechResponse | null = null;
  try {
    parsed = JSON.parse(stdout) as SpeechResponse;
  } catch {
    throw new Error(`lark-cli returned non-JSON: ${stdout.slice(0, 400)}`);
  }

  // lark-cli api wraps the real Lark response. Tolerate both shapes.
  const inner =
    parsed && typeof parsed === 'object' && 'data' in parsed
      ? parsed
      : ((parsed as unknown as { result?: SpeechResponse })?.result ?? parsed);

  const recognition = inner?.data?.recognition_text;
  if (typeof recognition !== 'string') {
    throw new Error(
      `飞书 ASR 没有返回 recognition_text. code=${inner?.code} msg=${inner?.msg ?? ''}`
    );
  }
  return recognition;
}

