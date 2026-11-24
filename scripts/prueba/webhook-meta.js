#!/usr/bin/env node
// Webhook del número de PRUEBA: Meta manda los mensajes de todos los números de la app a la URL de la app (producción,
// que ignora los números que no son el suyo). Con un "override" por número, solo los mensajes del número de prueba van
// al backend de prueba; el número de Leandro y su URL no se tocan.
//
//   railway run --service <backend de prueba> node scripts/prueba/webhook-meta.js ver
//   railway run --service <backend de prueba> node scripts/prueba/webhook-meta.js redirigir https://<backend-de-prueba>/webhook/whatsapp
//   railway run --service <backend de prueba> node scripts/prueba/webhook-meta.js quitar
//
// Usa WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN y WHATSAPP_API_VERSION del servicio de
// prueba (nunca se imprimen). Exige GURU_ENTORNO=prueba: así nunca se redirige el número de producción.
// Meta valida la URL (GET con hub.challenge) antes de aceptarla: el backend de prueba ya debe estar arriba.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/override
const env = process.env;
const die = (m) => { console.error(`✖ ${m}`); process.exit(1); };
if (env.GURU_ENTORNO !== 'prueba') die('Este servicio no tiene GURU_ENTORNO=prueba: no se toca ningún número.');
for (const k of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']) if (!env[k]) die(`Falta ${k} en el servicio de prueba`);
const BASE = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION || 'v21.0'}/${env.WHATSAPP_PHONE_NUMBER_ID}`;
const auth = { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` };
const clean = (s) => String(s).replace(/EAA[A-Za-z0-9]+/g, '***');

async function call(method, body) {
  const url = method === 'GET' ? `${BASE}?fields=display_phone_number,verified_name,webhook_configuration` : BASE;
  const r = await fetch(url, { method, headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(`Meta respondió ${r.status}: ${clean(JSON.stringify(j.error || j)).slice(0, 400)}`);
  return j;
}

async function ver() {
  const j = await call('GET');
  console.log(`Número: ${j.display_phone_number || '?'} (${j.verified_name || 'sin nombre'})`);
  const w = j.webhook_configuration || {};
  console.log(`  URL de este número:  ${w.phone_number || '(ninguna: usa la de la app)'}`);
  console.log(`  URL de la cuenta:    ${w.whatsapp_business_account || '(ninguna)'}`);
  console.log(`  URL de la app:       ${w.application || '?'}`);
}

(async () => {
  const [modo, url] = process.argv.slice(2);
  if (modo === 'ver') return ver();
  if (modo === 'redirigir') {
    if (!/^https:\/\/[^\s_:]+\/webhook\/whatsapp$/.test(url || '')) die('Pase la URL https://<backend-de-prueba>/webhook/whatsapp (sin puerto ni guiones bajos)');
    if (!env.WHATSAPP_VERIFY_TOKEN) die('Falta WHATSAPP_VERIFY_TOKEN en el servicio de prueba');
    await call('POST', { webhook_configuration: { override_callback_uri: url, verify_token: env.WHATSAPP_VERIFY_TOKEN } });
    console.log('✔ Redirigido. Así quedó:');
    return ver();
  }
  if (modo === 'quitar') {
    await call('POST', { webhook_configuration: { override_callback_uri: '' } });
    console.log('✔ Quitado: el número vuelve a usar la URL de la app.');
    return ver();
  }
  die('Uso: node scripts/prueba/webhook-meta.js ver | redirigir <url> | quitar');
})().catch((e) => die(clean(e.message)));
