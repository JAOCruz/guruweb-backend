const bcrypt = require("bcryptjs");
const pool = require("../src/config/database");

async function createAdmin() {
  try {
    const username = "admin";
    const password = "admin123";
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING RETURNING *",
      [username, hashedPassword, "admin"]
    );

    if (result.rows.length > 0) {
      console.log("✅ Admin user created successfully!");
      console.log("Username:", username);
      console.log("Password:", password);
    } else {
      console.log("ℹ️ Admin user already exists");
    }

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating admin:", error);
    process.exit(1);
  }
}

createAdmin();
