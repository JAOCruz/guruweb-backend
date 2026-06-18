-- Persistent simulator chats for testing and feedback loop
CREATE TABLE IF NOT EXISTS simulator_conversations (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(50) UNIQUE NOT NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(255) DEFAULT 'Chat de prueba',
  notes TEXT,
  status VARCHAR(20) DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS simulator_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES simulator_conversations(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'bot')),
  text TEXT,
  media_type VARCHAR(20),
  media_original_name VARCHAR(255),
  media_analysis TEXT,
  feedback TEXT,
  rating INT CHECK (rating BETWEEN -1 AND 1),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_simulator_messages_conversation_id ON simulator_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_simulator_conversations_session_id ON simulator_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_simulator_conversations_status ON simulator_conversations(status);
