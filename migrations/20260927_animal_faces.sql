-- Avatars switched to animal faces: animals without a face emoji were removed.
-- Their users go back to the initial and can pick again. Idempotent.
UPDATE users SET avatar = NULL
WHERE avatar IN ('sheep', 'goat', 'duck', 'turtle', 'dolphin', 'penguin', 'parrot', 'bee', 'butterfly', 'elephant');
