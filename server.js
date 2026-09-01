require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const { state, save, id, inviteCode } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------- helpers ----------

function publicUser(u) {
  return { id: u.id, username: u.username };
}

function findUser(username) {
  return state.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

function findUserById(userId) {
  return state.users.find((u) => u.id === userId);
}

function circlesForUser(userId) {
  return state.circles.filter((c) => c.memberIds.includes(userId));
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function circleSummary(circle) {
  return {
    id: circle.id,
    name: circle.name,
    code: circle.code,
    ownerId: circle.ownerId,
    members: circle.memberIds.map((mid) => {
      const u = findUserById(mid);
      const loc = liveLocations.get(mid);
      return {
        id: mid,
        username: u ? u.username : 'unknown',
        sharing: sharingPaused.has(mid) ? false : true,
        location: loc || null,
      };
    }),
  };
}

// In-memory live state (not persisted to disk — it's ephemeral by nature)
const liveLocations = new Map(); // userId -> {lat,lng,accuracy,heading,speed,updatedAt,circleId}
const sharingPaused = new Set(); // userIds who've paused sharing
const socketsByUser = new Map(); // userId -> Set(socket)

// ---------- auth routes ----------

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and a password of 6+ characters are required.' });
  }
  if (findUser(username.trim())) return res.status(409).json({ error: 'That username is taken.' });

  const user = {
    id: id(),
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: Date.now(),
  };
  state.users.push(user);
  save();

  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = findUser((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------- circle routes ----------

app.get('/api/circles', requireAuth, (req, res) => {
  res.json({ circles: circlesForUser(req.user.id).map(circleSummary) });
});

app.post('/api/circles', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Circle name is required.' });
  const circle = {
    id: id(),
    name: name.trim(),
    code: inviteCode(),
    ownerId: req.user.id,
    memberIds: [req.user.id],
    createdAt: Date.now(),
  };
  state.circles.push(circle);
  save();
  res.json({ circle: circleSummary(circle) });
});

app.post('/api/circles/join', requireAuth, (req, res) => {
  const { code } = req.body || {};
  const circle = state.circles.find((c) => c.code === (code || '').toUpperCase().trim());
  if (!circle) return res.status(404).json({ error: 'No circle with that invite code.' });
  if (!circle.memberIds.includes(req.user.id)) {
    circle.memberIds.push(req.user.id);
    save();
  }
  // If this user already has live socket connections open, pull them into the
  // new circle's room now — otherwise they won't get live updates until reconnect.
  for (const s of socketsByUser.get(req.user.id) || []) s.join(`circle:${circle.id}`);
  io.to(`circle:${circle.id}`).emit('circle:member-joined', {
    circleId: circle.id,
    user: publicUser(req.user),
  });
  res.json({ circle: circleSummary(circle) });
});

app.post('/api/circles/:circleId/leave', requireAuth, (req, res) => {
  const circle = state.circles.find((c) => c.id === req.params.circleId);
  if (!circle) return res.status(404).json({ error: 'Circle not found.' });
  circle.memberIds = circle.memberIds.filter((mid) => mid !== req.user.id);
  save();
  for (const s of socketsByUser.get(req.user.id) || []) s.leave(`circle:${circle.id}`);
  io.to(`circle:${circle.id}`).emit('circle:member-left', {
    circleId: circle.id,
    userId: req.user.id,
  });
  res.json({ ok: true });
});

function assertMember(req, res, circle) {
  if (!circle) {
    res.status(404).json({ error: 'Circle not found.' });
    return false;
  }
  if (!circle.memberIds.includes(req.user.id)) {
    res.status(403).json({ error: 'You are not a member of this circle.' });
    return false;
  }
  return true;
}

// ---------- drops (photos) ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 8) || '.jpg';
      cb(null, `${id()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Only image files are allowed.'));
    cb(null, true);
  },
});

app.get('/api/circles/:circleId/drops', requireAuth, (req, res) => {
  const circle = state.circles.find((c) => c.id === req.params.circleId);
  if (!assertMember(req, res, circle)) return;
  const drops = state.drops
    // A targeted drop is only visible to its author and its target — not the whole circle.
    .filter((d) => d.circleId === circle.id && (!d.targetUserId || d.targetUserId === req.user.id || d.authorId === req.user.id))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((d) => ({ ...d, authorName: findUserById(d.authorId)?.username || 'unknown' }));
  res.json({ drops });
});

app.post('/api/circles/:circleId/drops', requireAuth, upload.single('image'), (req, res) => {
  const circle = state.circles.find((c) => c.id === req.params.circleId);
  if (!assertMember(req, res, circle)) return;
  if (!req.file) return res.status(400).json({ error: 'An image file is required.' });

  const { caption, lat, lng } = req.body || {};
  let { targetUserId } = req.body || {};
  // Only allow targeting an actual fellow member of this circle.
  if (targetUserId && !circle.memberIds.includes(targetUserId)) targetUserId = null;

  const drop = {
    id: id(),
    circleId: circle.id,
    authorId: req.user.id,
    imageUrl: `/uploads/${req.file.filename}`,
    caption: (caption || '').slice(0, 300),
    lat: lat !== undefined && lat !== '' ? Number(lat) : null,
    lng: lng !== undefined && lng !== '' ? Number(lng) : null,
    targetUserId: targetUserId || null,
    createdAt: Date.now(),
  };
  state.drops.push(drop);
  save();

  const payload = { ...drop, authorName: req.user.username };
  if (drop.targetUserId) {
    // Private drop: only the author's and target's own sockets get it, never the whole room.
    for (const s of socketsByUser.get(drop.authorId) || []) s.emit('drop:new', payload);
    for (const s of socketsByUser.get(drop.targetUserId) || []) s.emit('drop:new', payload);
  } else {
    io.to(`circle:${circle.id}`).emit('drop:new', payload);
  }
  res.json({ drop: payload });
});

app.patch('/api/circles/:circleId/drops/:dropId', requireAuth, (req, res) => {
  const circle = state.circles.find((c) => c.id === req.params.circleId);
  if (!assertMember(req, res, circle)) return;
  const drop = state.drops.find((d) => d.id === req.params.dropId && d.circleId === circle.id);
  if (!drop) return res.status(404).json({ error: 'Drop not found.' });
  if (drop.authorId !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit your own photo drops.' });
  }

  const { caption } = req.body || {};
  drop.caption = (caption || '').slice(0, 300);
  drop.editedAt = Date.now();
  save();

  const payload = { ...drop, authorName: req.user.username };
  if (drop.targetUserId) {
    for (const s of socketsByUser.get(drop.authorId) || []) s.emit('drop:updated', payload);
    for (const s of socketsByUser.get(drop.targetUserId) || []) s.emit('drop:updated', payload);
  } else {
    io.to(`circle:${circle.id}`).emit('drop:updated', payload);
  }
  res.json({ drop: payload });
});

app.delete('/api/circles/:circleId/drops/:dropId', requireAuth, (req, res) => {
  const circle = state.circles.find((c) => c.id === req.params.circleId);
  if (!assertMember(req, res, circle)) return;
  const drop = state.drops.find((d) => d.id === req.params.dropId && d.circleId === circle.id);
  if (!drop) return res.status(404).json({ error: 'Drop not found.' });
  if (drop.authorId !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own photo drops.' });
  }

  state.drops = state.drops.filter((d) => d.id !== drop.id);
  save();

  // Best-effort cleanup of the stored image file — never let this block the response.
  const filename = (drop.imageUrl || '').split('/uploads/')[1];
  if (filename) fs.unlink(path.join(UPLOADS_DIR, filename), () => {});

  const payload = { dropId: drop.id, circleId: circle.id };
  if (drop.targetUserId) {
    for (const s of socketsByUser.get(drop.authorId) || []) s.emit('drop:deleted', payload);
    for (const s of socketsByUser.get(drop.targetUserId) || []) s.emit('drop:deleted', payload);
  } else {
    io.to(`circle:${circle.id}`).emit('drop:deleted', payload);
  }
  res.json({ ok: true });
});

// Turn multer/upload errors (bad file type, too large, etc.) into JSON
// instead of letting Express fall back to an HTML error page.
app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  res.status(400).json({ error: err.message || 'Something went wrong.' });
});

// ---------- socket.io realtime: live location + pings ----------

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) return next(new Error('Invalid token'));
    socket.user = user;
    next();
  } catch (e) {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;

  if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
  socketsByUser.get(user.id).add(socket);

  for (const circle of circlesForUser(user.id)) {
    socket.join(`circle:${circle.id}`);
  }

  socket.on('location:update', (data) => {
    if (sharingPaused.has(user.id)) return;
    if (!data || typeof data.lat !== 'number' || typeof data.lng !== 'number') return;

    // The physical location is the same regardless of which circle sees it —
    // store it once per user, then broadcast it (tagged per-circle) to each
    // circle this user belongs to.
    const baseLoc = {
      userId: user.id,
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy ?? null,
      heading: data.heading ?? null,
      speed: data.speed ?? null,
      updatedAt: Date.now(),
    };
    liveLocations.set(user.id, baseLoc);

    for (const circle of circlesForUser(user.id)) {
      socket.to(`circle:${circle.id}`).emit('location:update', { ...baseLoc, circleId: circle.id });
    }
  });

  socket.on('sharing:toggle', ({ enabled }) => {
    if (enabled) sharingPaused.delete(user.id);
    else sharingPaused.add(user.id);
    for (const circle of circlesForUser(user.id)) {
      io.to(`circle:${circle.id}`).emit('sharing:status', {
        userId: user.id,
        sharing: !!enabled,
      });
    }
  });

  socket.on('ping:send', ({ targetUserId, circleId, message }) => {
    const circle = state.circles.find((c) => c.id === circleId);
    if (!circle) return;
    if (!circle.memberIds.includes(user.id) || !circle.memberIds.includes(targetUserId)) return;

    const targetSockets = socketsByUser.get(targetUserId);
    if (targetSockets) {
      for (const s of targetSockets) {
        s.emit('ping:receive', {
          fromUserId: user.id,
          fromUsername: user.username,
          circleId,
          message: (message || '').slice(0, 200),
          at: Date.now(),
        });
      }
    }
  });

  socket.on('disconnect', () => {
    const set = socketsByUser.get(user.id);
    if (set) {
      set.delete(socket);
      if (set.size === 0) socketsByUser.delete(user.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`GeoPing running on http://localhost:${PORT}`);
});
