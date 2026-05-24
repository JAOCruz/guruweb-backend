const Appointment = require('../../models/Appointment');
const { transitionTo, updateData } = require('../stateManager');
const { MSG, LIST, APPOINTMENT_TYPES } = require('../messages');
const { withList } = require('../../whatsapp/interactive');
const { parseDate, isWeekend, formatDateISO, formatDateES, isMenuChoice } = require('../nlp');

async function handle(session, text) {
  const step = session.step;

  switch (step) {
    case 'ask_type': {
      const choice = text.trim();
      const type = APPOINTMENT_TYPES[choice];
      if (!type) {
        return 'Por favor, seleccione una opción del 1 al 4.';
      }
      await updateData(session, { appointmentType: type, appointmentTypeCode: choice });
      await transitionTo(session, 'appointment', 'ask_date', { ...session.data, appointmentType: type, appointmentTypeCode: choice });
      return MSG.APPOINTMENT_ASK_DATE;
    }

    case 'ask_date': {
      const date = parseDate(text);
      if (!date) {
        return MSG.APPOINTMENT_INVALID_DATE;
      }
      if (isWeekend(date)) {
        return MSG.APPOINTMENT_NO_WEEKEND;
      }

      const isoDate = formatDateISO(date);
      const prettyDate = formatDateES(date);
      const slots = await Appointment.findAvailableSlots(isoDate);

      if (slots.length === 0) {
        return MSG.APPOINTMENT_NO_SLOTS;
      }

      await updateData(session, { date: isoDate, prettyDate, availableSlots: slots });
      await transitionTo(session, 'appointment', 'ask_time', {
        ...session.data, date: isoDate, prettyDate, availableSlots: slots,
      });
      return withList(MSG.APPOINTMENT_SHOW_SLOTS(prettyDate, slots), LIST.APPOINTMENT_SLOTS(prettyDate, slots));
    }

    case 'ask_time': {
      const slots = session.data.availableSlots || [];
      const choice = isMenuChoice(text, slots.length);
      if (choice === null || choice < 1) {
        return `Por favor, seleccione un número del 1 al ${slots.length}.`;
      }

      const selectedTime = slots[choice - 1];
      const duration = session.data.appointmentTypeCode === '1' ? 60 : 45;

      const confirmData = {
        type: session.data.appointmentType,
        date: session.data.prettyDate,
        time: selectedTime,
        duration,
      };

      await updateData(session, { selectedTime, duration });
      await transitionTo(session, 'appointment', 'confirm', {
        ...session.data, selectedTime, duration,
      });
      return withList(MSG.APPOINTMENT_CONFIRM(confirmData), LIST.APPOINTMENT_CONFIRM(confirmData));
    }

    case 'confirm': {
      const choice = text.trim();
      if (choice === '1') {
        return await completeAppointment(session);
      }
      if (choice === '2') {
        await transitionTo(session, 'appointment', 'ask_date', session.data);
        return MSG.APPOINTMENT_ASK_DATE;
      }
      return MSG.INVALID_OPTION;
    }

    default:
      await transitionTo(session, 'appointment', 'ask_type');
      return withList(MSG.APPOINTMENT_INTRO, LIST.APPOINTMENT_TYPE);
  }
}

async function completeAppointment(session) {
  const data = session.data;

  try {
    await Appointment.create({
      clientId: session.client_id,
      caseId: null,
      userId: null,
      date: data.date,
      time: data.selectedTime,
      durationMin: data.duration,
      type: data.appointmentType,
    });

    const confirmData = {
      date: data.prettyDate,
      time: data.selectedTime,
    };

    await transitionTo(session, 'main_menu', 'show', {});
    return withList(MSG.APPOINTMENT_SUCCESS(confirmData) + '\n\n' + MSG.MAIN_MENU, LIST.MAIN_MENU);
  } catch (err) {
    console.error('[Appointment] Error creating appointment:', err);
    return MSG.ERROR_GENERAL;
  }
}

module.exports = { handle };
