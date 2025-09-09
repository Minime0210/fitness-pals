// index.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config(); // loads .env
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";


const app = express();
const port = 3000;

app.use(cors());            // allow mobile app calls (Expo)
app.use(express.json());    // parse JSON bodies

// =============================
// PostgreSQL: use a Pool (robust)
// =============================
const pool = new Pool({
  user: "admin",
  host: "127.0.0.1",
  database: "fitness_app",
  password: "admin",
  port: 5433, // <— IMPORTANT
});


// Wait until DB is ready (no Client reuse issues)
async function waitForDb(retries = 15, delayMs = 1000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("✅ Connected to Postgres!");
      return;
    } catch (e) {
      console.log(`⏳ DB not ready (attempt ${i}/${retries})`);
      if (i === retries) {
        console.error("❌ Database connection error:", e.message || e);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
waitForDb();

// =============================
// File Upload Setup (multer)
// =============================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Serve uploaded images
app.use("/uploads", express.static(uploadDir));

// =============================
// Users
// =============================

// Create users table
app.get("/create-users-table", async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE
      )
    `);
    res.send("✅ Users table created!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error creating users table");
  }
});

// Add user
app.post("/add-user", async (req, res) => {
  const { name, email } = req.body || {};
  try {
    await pool.query("INSERT INTO users (name, email) VALUES ($1, $2)", [name, email]);
    res.send("✅ User added!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error adding user");
  }
});

// List users
app.get("/users", async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error fetching users");
  }
});

// =============================
// Meals
// =============================

// Create meals table
app.get("/create-meals-table", async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meals (
        id SERIAL PRIMARY KEY,
        user_id INT,
        description TEXT,
        calories INT,
        photo TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    res.send("✅ Meals table created!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error creating meals table");
  }
});

// Add meal (with optional photo)
app.post("/meals", upload.single("photo"), async (req, res) => {
  const { userId, description, calories } = req.body || {};
  const photoPath = req.file ? req.file.filename : null;

  try {
    await pool.query(
      "INSERT INTO meals (user_id, description, calories, photo) VALUES ($1, $2, $3, $4)",
      [userId, description, calories, photoPath]
    );

    res.json({
      message: "✅ Meal added!",
      description,
      calories,
      photo: photoPath ? `/uploads/${photoPath}` : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error adding meal");
  }
});

// Get meals for a user
app.get("/meals/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM meals WHERE user_id = $1 ORDER BY created_at DESC",
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error fetching meals");
  }
});

// =============================
// Friends
// =============================

// Create friendships table
app.get("/create-friendships-table", async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS friendships (
        id SERIAL PRIMARY KEY,
        user_id INT,
        friend_id INT,
        status VARCHAR(20) DEFAULT 'accepted',
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    res.send("✅ Friendships table created!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error creating friendships table");
  }
});

// Add a friend (auto-accept)
app.post("/add-friend", async (req, res) => {
  const { userId, friendId } = req.body || {};
  try {
    await pool.query(
      "INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'accepted')",
      [userId, friendId]
    );
    res.send("✅ Friendship created!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error adding friend");
  }
});

// Get friends for a user (avoid duplicates; both directions)
app.get("/friends/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.name, u.email 
       FROM friendships f
       JOIN users u ON 
         (f.friend_id = u.id AND f.user_id = $1) 
         OR (f.user_id = u.id AND f.friend_id = $1)
       WHERE f.status = 'accepted'
       ORDER BY u.id ASC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error fetching friends");
  }
});

// =============================
// Feed (friends' meals)
// =============================
app.get("/feed/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.name AS friend_name, m.description, m.calories, m.photo, m.created_at
       FROM friendships f
       JOIN users u ON 
         (f.friend_id = u.id AND f.user_id = $1) 
         OR (f.user_id = u.id AND f.friend_id = $1)
       JOIN meals m ON u.id = m.user_id
       WHERE f.status = 'accepted'
       ORDER BY m.created_at DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error fetching feed");
  }
});

// =============================
// Start Server
// =============================
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
