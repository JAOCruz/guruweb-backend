const Case = require('../models/Case');
const Notification = require('../models/Notification');
const pool = require('../db/pool');

/**
 * Process case reminders that are due.
 * Intended to be called from a cron job or worker.
 *
 * @param {Date} [now=new Date()]
 * @returns {Promise<{processed: number, errors: string[]}>}
 */
async function processDueReminders(now = new Date()) {
  const errors = [];
  let processed = 0;

  try {
    const reminders = await Case.getPendingReminders(now);

    for (const reminder of reminders) {
      try {
        const { case_id: caseId, case_number: caseNumber, title, institution, user_id: assignedUserId, client_id: clientId } = reminder;

        // Build message
        const baseMessage = `⏰ Recordatorio de vencimiento de plazo\n\n` +
          `📁 Caso: ${caseNumber}\n` +
          `📌 Asunto: ${title || 'Sin título'}\n` +
          `🏛️ Institución: ${institution || 'No especificada'}\n` +
          `🔔 Tipo: ${reminder.reminder_type}`;

        const notifiedUserIds = new Set();

        // Notify assigned user
        if (assignedUserId) {
          await Notification.create({
            userId: assignedUserId,
            type: 'case_deadline',
            title: 'Vencimiento de plazo de caso',
            message: baseMessage,
            link: `/cases/${caseId}`,
            metadata: { case_id: caseId, reminder_id: reminder.id, client_id: clientId },
          });
          notifiedUserIds.add(assignedUserId);
        }

        // Notify admins
        const { rows: admins } = await pool.query("SELECT id FROM users WHERE role = 'admin'");
        for (const admin of admins) {
          if (notifiedUserIds.has(admin.id)) continue;
          await Notification.create({
            userId: admin.id,
            type: 'case_deadline',
            title: 'Vencimiento de plazo de caso',
            message: baseMessage,
            link: `/cases/${caseId}`,
            metadata: { case_id: caseId, reminder_id: reminder.id, client_id: clientId },
          });
          notifiedUserIds.add(admin.id);
        }

        // Mark reminder as sent
        await Case.markReminderSent(reminder.id, now);
        processed++;
      } catch (reminderErr) {
        console.error(`[CaseReminderService] Failed to process reminder ${reminder.id}:`, reminderErr.message);
        errors.push(`reminder ${reminder.id}: ${reminderErr.message}`);
      }
    }
  } catch (err) {
    console.error('[CaseReminderService] processDueReminders error:', err.message);
    errors.push(err.message);
  }

  console.log(`[CaseReminderService] Processed ${processed} due reminder(s)${errors.length ? `, ${errors.length} error(s)` : ''}`);
  return { processed, errors };
}

module.exports = { processDueReminders };
