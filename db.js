// Tiny dependency-free JSON "database". Fine for a small private-group app.
// Not built for heavy concurrent write load — good enough for friends & family.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data', 'store.json');

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    return { users: [], circles: [], drops: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read data file, starting fresh:', e.message);
    return { users: [], circles: [], drops: [] };
  }
}

let state = load();
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  }, 150);
}

function id() {
  return crypto.randomBytes(9).toString('base64url');
}

function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

module.exports = { state, save, id, inviteCode };
