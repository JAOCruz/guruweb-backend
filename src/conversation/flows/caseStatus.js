const Case = require('../../models/Case');
const { transitionTo, updateData } = require('../stateManager');
const { MSG, LIST } = require('../messages');
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
        const cases = await Case.findAll(null, { clientId: session.client_id });
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
        return withList(MSG.STATUS_FOUND(found), LIST.POST_CASE_VIEW);
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

async function findCaseByNumber(caseNumber) {
  const pool = require('../../db/pool');
  const { rows } = await pool.query(
    'SELECT * FROM cases WHERE UPPER(case_number) = $1',
    [caseNumber.toUpperCase()]
  );
  return rows[0] || null;
}

module.exports = { handle };
