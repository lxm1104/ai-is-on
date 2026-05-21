/**
 * MVP13 §S7：admin routes for calibration + ranker run cleanup.
 *
 * Mount under /api。
 *
 *   GET  /api/admin/suggestion-calibration?windowDays=14
 *   DELETE /api/admin/ranker-runs?olderThanDays=N
 */
import { Router } from 'express';
import { buildCalibrationReport } from '../spaces/suggestionCalibration.js';
import { deleteRankerRunsOlderThan } from '../db.js';

export const adminSuggestionRouter = Router();

adminSuggestionRouter.get(
  '/admin/suggestion-calibration',
  (req, res) => {
    const raw = req.query.windowDays;
    let windowDays = 14;
    if (typeof raw === 'string') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n <= 365) windowDays = Math.floor(n);
    }
    const report = buildCalibrationReport(windowDays);
    res.json(report);
  }
);

adminSuggestionRouter.delete('/admin/ranker-runs', (req, res) => {
  const raw = req.query.olderThanDays;
  let olderThanDays = 30;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 3650) olderThanDays = Math.floor(n);
  }
  const deleted = deleteRankerRunsOlderThan(olderThanDays);
  res.json({ ok: true, deleted, olderThanDays });
});
