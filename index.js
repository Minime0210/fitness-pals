// index.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// =============================
// PostgreSQL Pool
// =============================
const pool = new Pool({
  user: "admin",
  host: "127.0.0.1",
  database: "fitness_app",
  password: "admin",
  port: 5433, // match your docker ps output
});

// Wait until DB is ready
async function waitForDb(retries = 15, delayMs = 1000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("✅ Connected to Postgres!");
      return;
    } catch {
      console.log(`⏳ DB not ready (attempt ${i}/${retries})`);
      if (i === retries) {
        console.error("❌ Database connection failed.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
waitForDb();

// =============================
// JWT helpers
// =============================
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

function authRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const parts = auth.split(" ");
  const token = parts.length === 2 && parts[0] === "Bearer" ? parts[1] : null;
  if (!token) return res.status(401).send("Missing token");
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).send("Invalid token");
  }
}

// =============================
// File Upload Setup
// =============================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });
app.use("/uploads", express.static(uploadDir));

// =============================
// Users & Auth
// =============================

// Create users table
app.get("/create-users-table", async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT
      )
    `);
    res.send("✅ Users table ready!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error creating users table");
  }
});

// Register
app.post("/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).send("Missing fields");
  try {
    const hash = await bcrypt.hash(String(password), 10);
    const result = await pool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id,name,email",
      [name, email, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    if (String(err.message).includes("duplicate key")) {
      return res.status(409).send("Email already in use");
    }
    res.status(500).send("❌ Error registering");
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).send("Missing fields");
  try {
    const result = await pool.query(
      "SELECT id,name,email,password_hash FROM users WHERE email=$1",
      [email]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).send("Invalid credentials");
    const ok = await bcrypt.compare(String(password), user.password_hash || "");
    if (!ok) return res.status(401).send("Invalid credentials");
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error logging in");
  }
});

// Current user
app.get("/me", authRequired, async (req, res) => {
  try {
    const r = await pool.query("SELECT id,name,email FROM users WHERE id=$1", [
      req.userId,
    ]);
    res.json(r.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error");
  }
});

// =============================
// Meals
// =============================
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
    res.send("✅ Meals table ready!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error creating meals table");
  }
});

// Add meal
app.post("/meals", authRequired, upload.single("photo"), async (req, res) => {
  const { description, calories } = req.body || {};
  const photoPath = req.file ? req.file.filename : null;
  try {
    await pool.query(
      "INSERT INTO meals (user_id, description, calories, photo) VALUES ($1, $2, $3, $4)",
      [req.userId, description, calories, photoPath]
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

// Get meals
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
// Friendships
// =============================
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
    res.send("✅ Friendships table ready!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error creating friendships table");
  }
});

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
// Feed
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
// Health Check
// =============================
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// =============================
// Start Server
// =============================
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
