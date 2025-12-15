const bcrypt = require("bcryptjs");
const pool = require("../src/config/database");

const users = [
  { username: "admin", password: "826498@Leo", role: "admin", dataColumn: null },
  {
    username: "hengi",
    password: "hg2024",
    role: "employee",
    dataColumn: "Hengi",
  },
  {
    username: "marleni",
    password: "ml2024",
    role: "employee",
    dataColumn: "Marleni",
  },
  {
    username: "israel",
    password: "is2024",
    role: "employee",
    dataColumn: "Israel",
  },
  {
    username: "thaicar",
    password: "tc2024",
    role: "employee",
    dataColumn: "Thaicar",
  },
];

async function createUsers() {
  try {
    console.log("Creating users...\n");

    for (const user of users) {
      const hashedPassword = await bcrypt.hash(user.password, 10);

      const result = await pool.query(
        "INSERT INTO users (username, password_hash, role, data_column) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id, username, role",
        [user.username, hashedPassword, user.role, user.dataColumn]
      );

      if (result.rows.length > 0) {
        console.log(
          `✅ User created: ${user.username} / ${user.password} (${user.role})`
        );
      } else {
        console.log(`ℹ️  User already exists: ${user.username}`);
      }
    }

    console.log("\n✅ All users processed successfully!");
    console.log("\nLogin credentials:");
    console.log("==================");
    users.forEach((u) => {
      console.log(
        `${u.username.padEnd(10)} / ${u.password.padEnd(10)} (${u.role})`
      );
    });

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating users:", error);
    process.exit(1);
  }
}

createUsers();
