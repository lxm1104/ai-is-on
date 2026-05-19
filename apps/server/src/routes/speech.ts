import { Router } from 'express';
import multer from 'multer';
import { transcribeAudioBuffer } from '../speech/transcribe.js';
import { config } from '../config.js';

// Upper bound: 60s * 16k * 2 bytes ~= 1.92MB raw PCM. Browser webm/opus will be smaller.
// Keep 16MB to leave headroom for browsers that record at higher bitrates.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

export const speechRouter = Router();

speechRouter.post('/speech/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'audio file is required' });
    return;
  }
  try {
    const text = await transcribeAudioBuffer(req.file.buffer, req.file.originalname);
    res.json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[speech] transcribe failed:', msg);
    res.status(500).json({
      error: msg,
      hint: `飞书 ASR 失败。请确认应用已开通 speech_to_text:speech 权限，且单次录音 ≤ ${config.speechMaxSeconds}s。`,
    });
  }
});
