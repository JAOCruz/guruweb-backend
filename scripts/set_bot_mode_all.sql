UPDATE wa_bot_state SET value = value || '{"botMode": "all"}' WHERE key = 'bot_settings';
