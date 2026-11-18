// Who a WhatsApp chat is with. Usually the phone number (digits only). Users with a WhatsApp username
// can hide their number: then Meta sends a business-scoped user id (BSUID) such as "US.1349…" or
// "US.ENT.1181…", which is kept as it is and used as the chat's "phone".
const BSUID = /^[A-Z]{2}\.[A-Za-z0-9.]{1,160}$/;

const stripJid = (s) => String(s || '').trim().replace(/@s\.whatsapp\.net$|@lid$/, '');

function isBsuid(s) {
  return BSUID.test(stripJid(s));
}

function toContactId(s) {
  const v = stripJid(s);
  return BSUID.test(v) ? v : v.replace(/\D/g, '');
}

// Graph API send body: a phone goes in "to", a BSUID in "recipient"
function recipientFields(s) {
  const id = toContactId(s);
  return isBsuid(id) ? { recipient: id } : { to: id };
}

module.exports = { isBsuid, toContactId, recipientFields };
