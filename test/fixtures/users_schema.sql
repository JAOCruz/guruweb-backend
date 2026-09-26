CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100),
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  role VARCHAR(20) NOT NULL DEFAULT 'digitador',
  data_column VARCHAR(50),
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
