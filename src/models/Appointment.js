const pool = require('../db/pool');

const Appointment = {
  async create({ clientId, caseId, userId, date, time, durationMin = 60, type = 'consulta', notes }) {
    const { rows } = await pool.query(
      `INSERT INTO appointments (client_id, case_id, user_id, date, time, duration_min, type, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [clientId, caseId || null, userId || null, date, time, durationMin, type, notes || null]
    );
    return rows[0];
  },

  async findByClient(clientId) {
    const { rows } = await pool.query(
      "SELECT * FROM appointments WHERE client_id = $1 AND date >= CURRENT_DATE ORDER BY date, time",
      [clientId]
    );
    return rows;
  },

  async findByDate(date) {
    const { rows } = await pool.query(
      'SELECT * FROM appointments WHERE date = $1 ORDER BY time',
      [date]
    );
    return rows;
  },

  async findAvailableSlots(date) {
    const booked = await this.findByDate(date);
    const bookedTimes = new Set(booked.map(a => a.time.substring(0, 5)));
    const allSlots = [
      '09:00', '10:00', '11:00', '12:00',
      '14:00', '15:00', '16:00', '17:00',
    ];
    return allSlots.filter(s => !bookedTimes.has(s));
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async updateStatus(id, status) {
    const { rows } = await pool.query(
      'UPDATE appointments SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, id]
    );
    return rows[0] || null;
  },
};

module.exports = Appointment;
