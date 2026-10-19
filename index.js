const express = require('express');
require('dotenv').config();
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { promisify } = require('util');
const { collectDefaultMetrics, Registry, Counter, Histogram } = require('@prometheus-io/client');
const scrypt = promisify(crypto.scrypt);

const app = express();
const sessions = new Map();
const uploadDirectory = path.join(__dirname, 'uploads');
const imageExtensions = new Map([
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/webp', ['.webp']]
]);
fs.mkdirSync(uploadDirectory, { recursive: true });

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (req, file, callback) => callback(null, `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const allowedExtensions = imageExtensions.get(file.mimetype);
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions || !allowedExtensions.includes(extension)) {
      return callback(new Error('Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP.'));
    }
    callback(null, true);
  }
});

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [metricsRegistry]
});

const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry]
});

app.use((req, res, next) => {
  const startTime = Date.now();
  res.on('finish', () => {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const route = req.route?.path || req.path || 'unknown';
    httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
    httpRequestDurationSeconds.observe({ method: req.method, route, status: String(res.statusCode) }, durationSeconds);
  });
  next();
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const dbPool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10
});

const db = {
  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    dbPool.execute(sql, params).then(([rows]) => callback(null, rows)).catch(callback);
  },
  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    dbPool.execute(sql, params).then(([rows]) => callback(null, rows[0])).catch(callback);
  },
  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    dbPool.execute(sql, params)
      .then(([result]) => callback.call({ lastID: result.insertId, changes: result.affectedRows }, null))
      .catch(error => callback.call(null, error));
  }
};

function authenticate(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const user = token && sessions.get(token);
  if (!user) return res.status(401).json({ error: 'Vui lòng đăng nhập!' });
  req.user = user;
  req.token = token;
  next();
}

function optionalAuth(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  req.user = token ? sessions.get(token) || null : null;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ quản trị viên mới được thực hiện thao tác này!' });
  next();
}

app.post('/api/uploads', authenticate, (req, res) => {
  imageUpload.single('image')(req, res, error => {
    if (error) {
      const status = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: error.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn ảnh bìa.' });
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function passwordMatches(password, storedPassword) {
  if (!storedPassword.startsWith('scrypt$')) return storedPassword === password;
  const [, salt, storedKey] = storedPassword.split('$');
  if (!salt || !storedKey) return false;
  const candidateKey = await scrypt(password, salt, 64);
  const expectedKey = Buffer.from(storedKey, 'hex');
  return expectedKey.length === candidateKey.length && crypto.timingSafeEqual(candidateKey, expectedKey);
}

async function initializeDatabase() {
  await dbPool.execute(`CREATE TABLE IF NOT EXISTS categories (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(191) NOT NULL UNIQUE
  )`);
  await dbPool.execute(`CREATE TABLE IF NOT EXISTS users (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(191) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'user'
  )`);
  await dbPool.execute(`CREATE TABLE IF NOT EXISTS posts (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    category_id INT NULL,
    author VARCHAR(191) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'published',
    cover_image VARCHAR(2048) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbPool.execute(`CREATE TABLE IF NOT EXISTS comments (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    post_id INT NOT NULL,
    username VARCHAR(191) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  for (const name of ['Công nghệ', 'Đời sống', 'Học tập']) {
    await dbPool.execute('INSERT IGNORE INTO categories (name) VALUES (?)', [name]);
  }

  const [admins] = await dbPool.execute('SELECT id FROM users WHERE username = ?', ['admin']);
  if (admins.length === 0) {
    if (!process.env.ADMIN_PASSWORD) throw new Error('Thiếu ADMIN_PASSWORD trong file .env');
    const password = await hashPassword(process.env.ADMIN_PASSWORD);
    await dbPool.execute('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', password, 'admin']);
  }
}

// --- API CATEGORIES ---
app.get('/api/categories', (req, res) => {
  db.all(`SELECT * FROM categories`, [], (err, rows) => res.json(rows));
});

app.post('/api/categories', authenticate, requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Tên danh mục không được để trống!" });
  db.run(`INSERT INTO categories (name) VALUES (?)`, [name], function(err) {
    if (err) return res.status(400).json({ error: "Danh mục đã tồn tại!" });
    res.status(201).json({ id: this.lastID, name });
  });
});

app.delete('/api/categories/:id', authenticate, requireAdmin, (req, res) => {
  db.run(`DELETE FROM categories WHERE id = ?`, req.params.id, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Đã xóa danh mục!" });
  });
});

// --- API POSTS ---
app.get('/api/posts', optionalAuth, (req, res) => {
  const { search, category } = req.query;
  let query = `
    SELECT posts.*, categories.name as category_name 
    FROM posts 
    LEFT JOIN categories ON posts.category_id = categories.id 
    WHERE (posts.status = 'published' OR posts.author = ? OR ? = 1)
  `;
  let params = [req.user?.username || '', req.user?.role === 'admin' ? 1 : 0];

  if (search) {
    query += ` AND (posts.title LIKE ? OR posts.content LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    query += ` AND posts.category_id = ?`;
    params.push(category);
  }

  query += ` ORDER BY posts.created_at DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/posts', authenticate, (req, res) => {
  const { title, content, category_id, status = 'published', cover_image = '' } = req.body;
  if (!title || !content) return res.status(400).json({ error: "Thiếu tiêu đề hoặc nội dung!" });
  if (!['draft', 'published'].includes(status)) return res.status(400).json({ error: 'Trạng thái bài viết không hợp lệ!' });
  db.run(`INSERT INTO posts (title, content, category_id, author, status, cover_image) VALUES (?, ?, ?, ?, ?, ?)`, [title, content, category_id, req.user.username, status, cover_image], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID });
  });
});

app.put('/api/posts/:id', authenticate, (req, res) => {
  const { title, content, category_id, status = 'published', cover_image = '' } = req.body;
  if (!title || !content) return res.status(400).json({ error: "Thiếu tiêu đề hoặc nội dung!" });
  if (!['draft', 'published'].includes(status)) return res.status(400).json({ error: 'Trạng thái bài viết không hợp lệ!' });
  db.run(`UPDATE posts SET title = ?, content = ?, category_id = ?, status = ?, cover_image = ? WHERE id = ? AND (? = 1 OR author = ?)`, [title, content, category_id, status, cover_image, req.params.id, req.user.role === 'admin' ? 1 : 0, req.user.username], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (!this.changes) return res.status(404).json({ error: 'Không tìm thấy bài viết!' });
    res.json({ message: "Cập nhật thành công!" });
  });
});

app.delete('/api/posts/:id', authenticate, (req, res) => {
  db.run(`DELETE FROM posts WHERE id = ? AND (? = 1 OR author = ?)`, [req.params.id, req.user.role === 'admin' ? 1 : 0, req.user.username], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (!this.changes) return res.status(404).json({ error: 'Không tìm thấy bài viết!' });
    db.run(`DELETE FROM comments WHERE post_id = ?`, req.params.id);
    res.json({ message: "Đã xóa!" });
  });
});

// --- API COMMENTS ---
app.get('/api/posts/:postId/comments', optionalAuth, (req, res) => {
  db.all(`SELECT comments.* FROM comments JOIN posts ON posts.id = comments.post_id WHERE comments.post_id = ? AND (posts.status = 'published' OR posts.author = ? OR ? = 1) ORDER BY comments.created_at DESC`, [req.params.postId, req.user?.username || '', req.user?.role === 'admin' ? 1 : 0], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/posts/:postId/comments', authenticate, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Nội dung bình luận không được để trống!' });
  db.get(`SELECT id FROM posts WHERE id = ? AND (status = 'published' OR author = ? OR ? = 1)`, [req.params.postId, req.user.username, req.user.role === 'admin' ? 1 : 0], (postErr, post) => {
    if (postErr) return res.status(500).json({ error: postErr.message });
    if (!post) return res.status(404).json({ error: 'Không tìm thấy bài viết!' });
    db.run(`INSERT INTO comments (post_id, username, content) VALUES (?, ?, ?)`, [req.params.postId, req.user.username, content], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: this.lastID });
    });
  });
});

// --- API AUTH ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Vui lòng nhập tài khoản và mật khẩu!' });
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      if (!row || !await passwordMatches(password, row.password)) {
        return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu!' });
      }
      const finishLogin = () => {
        const user = { username: row.username, role: row.role };
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, user);
        res.json({ message: 'Đăng nhập thành công!', user, token });
      };
      if (!row.password.startsWith('scrypt$')) {
        const securedPassword = await hashPassword(password);
        return db.run(`UPDATE users SET password = ? WHERE id = ?`, [securedPassword, row.id], updateErr => {
          if (updateErr) return res.status(500).json({ error: updateErr.message });
          finishLogin();
        });
      }
      finishLogin();
    } catch (passwordErr) {
      res.status(500).json({ error: 'Không thể xác thực tài khoản lúc này!' });
    }
  });
});

app.get('/api/me', authenticate, (req, res) => res.json({ user: req.user }));

app.post('/api/logout', authenticate, (req, res) => {
  sessions.delete(req.token);
  res.json({ message: 'Đã đăng xuất!' });
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Thiếu thông tin!" });
  hashPassword(password).then(hashedPassword => {
    db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, 'user')`, [username, hashedPassword], function(err) {
      if (err) return res.status(400).json({ error: "Tên tài khoản đã tồn tại!" });
      res.status(201).json({ message: "Đăng ký thành công!" });
    });
  }).catch(() => res.status(500).json({ error: 'Không thể tạo tài khoản lúc này!' }));
});

const port = Number(process.env.PORT || 3000);
initializeDatabase().then(() => {
  app.listen(port, '0.0.0.0', () => console.log(`Hệ thống Blog đang chạy tại http://localhost:${port}`));
}).catch(error => {
  console.error('Lỗi khởi tạo MySQL:', error.message);
  process.exit(1);
});