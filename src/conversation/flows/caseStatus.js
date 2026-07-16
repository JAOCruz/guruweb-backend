const Case = require('../../models/Case');
const { transitionTo, updateData } = require('../stateManager');
const { MSG, LIST, STATUS_LABELS, CERTIFICATION_NEXT_STEP } = require('../messages');
const { withList } = require('../../whatsapp/interactive');

async function handle(session, text) {
  const step = session.step;

  switch (step) {
    case 'ask_or_list': {
      // If the client has cases, list them; otherwise ask for case number
      if (!session.client_id) {
        await transitionTo(session, 'case_status', 'ask_number');
        return MSG.STATUS_ASK_NUMBER;
      }

      try {
        const cases = await Case.findAll({ clientId: session.client_id });
        if (cases.length === 0) {
          await transitionTo(session, 'main_menu', 'show', {});
          return withList(MSG.STATUS_NO_CASES + '\n\n' + MSG.MAIN_MENU, LIST.MAIN_MENU);
        }

        await updateData(session, { clientCases: cases.map(c => c.case_number) });
        await transitionTo(session, 'case_status', 'select_case', {
          ...session.data,
          clientCases: cases.map(c => c.case_number),
        });
        return withList(MSG.STATUS_LIST(cases), LIST.CASE_LIST(cases));
      } catch (err) {
        console.error('[CaseStatus] Error fetching cases:', err);
        return MSG.ERROR_GENERAL;
      }
    }

    case 'select_case':
    case 'ask_number': {
      const input = text.trim().toUpperCase();

      // Check if user typed a number to select from list
      const clientCases = session.data?.clientCases || [];
      const idx = parseInt(input, 10);
      let caseNumber;

      if (!isNaN(idx) && idx >= 1 && idx <= clientCases.length) {
        caseNumber = clientCases[idx - 1];
      } else {
        caseNumber = input;
      }

      try {
        const found = await findCaseByNumber(caseNumber);
        if (!found) {
          return MSG.STATUS_NOT_FOUND;
        }

        await transitionTo(session, 'case_status', 'post_view', session.data);
        return withList(buildStatusMessage(found), LIST.POST_CASE_VIEW);
      } catch (err) {
        console.error('[CaseStatus] Error looking up case:', err);
        return MSG.ERROR_GENERAL;
      }
    }

    case 'post_view': {
      const choice = text.trim();
      if (choice === '1') {
        await transitionTo(session, 'case_status', 'ask_or_list', {});
        return await handle(
          { ...session, step: 'ask_or_list', data: {} },
          text
        );
      }
      if (choice === '2') {
        await transitionTo(session, 'main_menu', 'show', {});
        return withList(MSG.MAIN_MENU, LIST.MAIN_MENU);
      }
      return MSG.INVALID_OPTION;
    }

    default:
      await transitionTo(session, 'case_status', 'ask_or_list');
      return await handle({ ...session, step: 'ask_or_list' }, text);
  }
}

function buildStatusMessage(c) {
  const isCertification = c.case_type === 'certificacion';
  const statusLabel = STATUS_LABELS[c.status] || c.status;

  if (isCertification) {
    const lines = [
      `📋 *Estado de su trámite de certificación*`,
      ``,
      `📁 Expediente: ${c.case_number}`,
      `📌 Asunto: ${c.title}`,
      `🏛️ Institución: ${c.institution || 'Por confirmar'}`,
      `📊 Estado: ${statusLabel}`,
    ];

    if (c.expected_completion_date) {
      const d = new Date(c.expected_completion_date);
      lines.push(`📅 Fecha estimada: ${d.toLocaleDateString('es-DO', { year: 'numeric', month: 'long', day: 'numeric' })}`);
    }

    const nextStep = CERTIFICATION_NEXT_STEP[c.status] || 'Un asesor le mantendrá informado/a sobre cualquier avance.';
    lines.push(
      ``,
      `📝 *Próximo paso:*`,
      nextStep,
      ``,
      `_Nota: los tiempos de respuesta dependen de la institución. Le informaremos apenas tengamos una actualización oficial._`,
      ``,
      `¿Desea realizar alguna otra consulta?`,
      `1️⃣ Consultar otro expediente`,
      `2️⃣ Regresar al menú principal`
    );

    return lines.join('\n');
  }

  return MSG.STATUS_FOUND(c);
}

async function findCaseByNumber(caseNumber) {
  const pool = require('../../db/pool');
  const { rows } = await pool.query(
    'SELECT * FROM cases WHERE UPPER(case_number) = $1',
    [caseNumber.toUpperCase()]
  );
  return rows[0] || null;
}

module.exports = { handle };
