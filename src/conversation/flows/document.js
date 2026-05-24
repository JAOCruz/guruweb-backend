const DocumentRequest = require('../../models/DocumentRequest');
const ClientMedia = require('../../models/ClientMedia');
const { transitionTo, updateData } = require('../stateManager');
const { MSG, LIST, DOCUMENT_TYPES } = require('../messages');
const { withList } = require('../../whatsapp/interactive');

async function handle(session, text, msg, savedMedia = null) {
  const step = session.step;

  switch (step) {
    case 'ask_type': {
      const choice = text.trim();
      const docType = DOCUMENT_TYPES[choice];
      if (!docType) {
        return 'Por favor, seleccione una opción del 1 al 7.';
      }
      await updateData(session, { docType, docTypeCode: choice });
      await transitionTo(session, 'document', 'ask_description', { ...session.data, docType, docTypeCode: choice });
      return MSG.DOCUMENT_ASK_DESCRIPTION;
    }

    case 'ask_description': {
      const description = text.trim();
      if (description.length < 3) {
        return 'Por favor, proporcione una descripción breve del documento.';
      }
      await updateData(session, { docDescription: description });
      await transitionTo(session, 'document', 'await_file', { ...session.data, docDescription: description });
      return MSG.DOCUMENT_ASK_FILE;
    }

    case 'await_file': {
      // Check if message contains media
      const mediaMessage = msg.message?.imageMessage
        || msg.message?.documentMessage
        || msg.message?.audioMessage
        || msg.message?.videoMessage;

      if (!mediaMessage) {
        // User sent text instead of file
        if (text.trim() === '0' || text.trim().toLowerCase() === 'cancelar') {
          await transitionTo(session, 'main_menu', 'show', {});
          return MSG.APPOINTMENT_CANCELLED + '\n\n' + MSG.MAIN_MENU;
        }
        return MSG.DOCUMENT_INVALID_FILE;
      }

      const waMediaId = mediaMessage.mediaKey ? msg.key.id : null;
      const fileName = mediaMessage.fileName || `documento_${Date.now()}`;
      const mimeType = mediaMessage.mimetype || 'application/octet-stream';

      try {
        const docReq = await DocumentRequest.create({
          clientId: session.client_id,
          caseId: null,
          docType: session.data.docType,
          description: session.data.docDescription,
          waMediaId,
          fileName,
          mimeType,
          filePath: savedMedia?.file_path || null,
          mediaId: savedMedia?.id || null,
        });

        // Link the auto-saved media to this document request
        if (savedMedia) {
          await ClientMedia.linkToDocRequest(savedMedia.id, docReq.id);
        }

        await transitionTo(session, 'document', 'post_upload', { ...session.data, lastDocId: docReq.id });
        return withList(MSG.DOCUMENT_RECEIVED(docReq.id), LIST.DOCUMENT_RECEIVED(docReq.id));
      } catch (err) {
        console.error('[Document] Error saving document request:', err);
        return MSG.ERROR_GENERAL;
      }
    }

    case 'post_upload': {
      const choice = text.trim();
      if (choice === '1') {
        await transitionTo(session, 'document', 'ask_type', {});
        return withList(MSG.DOCUMENT_INTRO, LIST.DOCUMENT_TYPE);
      }
      if (choice === '2') {
        await transitionTo(session, 'main_menu', 'show', {});
        return withList(MSG.MAIN_MENU, LIST.MAIN_MENU);
      }
      return MSG.INVALID_OPTION;
    }

    default:
      await transitionTo(session, 'document', 'ask_type');
      return withList(MSG.DOCUMENT_INTRO, LIST.DOCUMENT_TYPE);
  }
}

module.exports = { handle };
