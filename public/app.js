(() => {
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- state ----------
  let token = localStorage.getItem('geoping_token') || null;
  let me = JSON.parse(localStorage.getItem('geoping_me') || 'null');
  let socket = null;
  let currentCircle = null;
  let map = null;
  let markers = new Map(); // userId -> L.Marker
  let dropMarkers = new Map(); // dropId -> L.Marker
  let watchId = null;
  let lastSentAt = 0;
  let lastSentPos = null;
  let modalDrop = null; // the drop currently shown in the image modal, if any

  // ---------- fetch helper ----------
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  function showScreen(id) {
    $all('.screen').forEach((s) => s.classList.add('hidden'));
    $(id).classList.remove('hidden');
  }

  function toast(message, iconKey) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (iconKey && ICONS[iconKey] ? `<span class="icon">${ICONS[iconKey]}</span>` : '') + `<span>${escapeHtml(message)}</span>`;
    $('#toast-container').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function notify(title, body) {
    toast(`${title}: ${body}`);
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/icons/icon-192.png' });
    }
    playPingSound();
  }

  function playPingSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.start(); o.stop(ctx.currentTime + 0.4);
    } catch (e) { /* audio not available, ignore */ }
  }

  // A brief expanding-ring pulse — a nod to the app's name — used in place of
  // anything more novelty (confetti, etc.) for a cleaner, more grown-up feel.
  function successRipple(variant) {
    const layer = $('#ripple-layer');
    if (!layer) return;
    [0, 140].forEach((delay) => {
      setTimeout(() => {
        const ring = document.createElement('span');
        ring.className = 'ripple-ring' + (variant === 'accent' ? ' accent' : '');
        layer.appendChild(ring);
        setTimeout(() => ring.remove(), 950);
      }, delay);
    });
  }

  const ICONS = {
    bell: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 8a5 5 0 0 0-10 0c0 5-2 6-2 6h14s-2-1-2-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 16.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    camera: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h1.2l.9-1.4A1.5 1.5 0 0 1 7.87 4h4.26a1.5 1.5 0 0 1 1.27.7l.9 1.3h1.2A1.5 1.5 0 0 1 17 7.5v6A1.5 1.5 0 0 1 15.5 15h-11A1.5 1.5 0 0 1 3 13.5v-6z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="10.2" r="2.4" stroke="currentColor" stroke-width="1.4"/></svg>',
    compass: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.5"/><path d="m12.5 7.5-1.8 4.3-4.2 1.7 1.8-4.3 4.2-1.7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    image: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="14" height="12" rx="1.6" stroke="currentColor" stroke-width="1.5"/><circle cx="7.2" cy="8" r="1.1" stroke="currentColor" stroke-width="1.3"/><path d="m4 14 4-4 3 3 2.5-2.5L17 14" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    pin: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 18s6-5.686 6-10a6 6 0 1 0-12 0c0 4.314 6 10 6 10z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="8" r="2" stroke="currentColor" stroke-width="1.6"/></svg>',
  };

  // ---------- reverse geocoding (free OpenStreetMap Nominatim, no API key) ----------
  // Cached per rounded coordinate, and queued so requests never fire faster than
  // ~1/second, in line with Nominatim's usage policy. Falls back to raw
  // coordinates if a lookup fails — never blocks the UI.
  const geocodeCache = new Map();
  let geocodeQueueTail = Promise.resolve();

  function reverseGeocode(lat, lng) {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (geocodeCache.has(key)) return geocodeCache.get(key);

    const result = geocodeQueueTail.then(async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`
        );
        if (!res.ok) return null;
        const data = await res.json();
        const a = data.address || {};
        return (
          a.neighbourhood || a.suburb || a.city_district || a.city || a.town ||
          a.village || a.county || (data.display_name ? data.display_name.split(',')[0] : null)
        );
      } catch (e) {
        return null;
      } finally {
        await new Promise((r) => setTimeout(r, 1100));
      }
    });
    geocodeQueueTail = result.catch(() => {});
    geocodeCache.set(key, result);
    return result;
  }

  // ---------- auth ----------

  $all('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $all('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $('#login-form').classList.toggle('hidden', tab !== 'login');
      $('#register-form').classList.toggle('hidden', tab !== 'register');
    });
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $('#login-error').textContent = '';
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
      });
      onAuthed(data);
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $('#register-error').textContent = '';
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
      });
      onAuthed(data);
    } catch (err) {
      $('#register-error').textContent = err.message;
    }
  });

  function onAuthed(data) {
    token = data.token;
    me = data.user;
    localStorage.setItem('geoping_token', token);
    localStorage.setItem('geoping_me', JSON.stringify(me));
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    connectSocket();
    loadCircles();
  }

  $('#logout-btn').addEventListener('click', () => {
    localStorage.removeItem('geoping_token');
    localStorage.removeItem('geoping_me');
    token = null; me = null;
    if (socket) socket.disconnect();
    stopWatchingPosition();
    location.reload();
  });

  // ---------- socket ----------

  function connectSocket() {
    socket = io({ auth: { token } });

    socket.on('ping:receive', ({ fromUsername, message }) => {
      notify(`Alert from ${fromUsername}`, message || 'sent you an alert.');
    });

    socket.on('location:update', (loc) => {
      if (currentCircle && loc.circleId === currentCircle.id) {
        upsertMemberMarker(loc.userId, loc);
        updateMemberLastSeen(loc.userId, loc.updatedAt);
      }
    });

    socket.on('sharing:status', ({ userId, sharing }) => {
      if (!currentCircle) return;
      const chip = document.getElementById(`chip-${userId}`);
      if (chip) chip.classList.toggle('offline', !sharing);
    });

    socket.on('drop:new', (drop) => {
      if (currentCircle && drop.circleId === currentCircle.id) {
        if (!drop.targetUserId || drop.targetUserId === me.id || drop.authorId === me.id) {
          currentDrops.unshift(drop);
          renderFeed(currentDrops);
          addDropMarker(drop);
          if (drop.authorId !== me.id) toast(`${drop.authorName} added a photo`, 'image');
        }
      }
    });

    socket.on('drop:updated', (drop) => {
      if (currentCircle && drop.circleId === currentCircle.id) {
        const idx = currentDrops.findIndex((d) => d.id === drop.id);
        if (idx !== -1) {
          currentDrops[idx] = drop;
          renderFeed(currentDrops);
        }
        if (modalDrop && modalDrop.id === drop.id) {
          modalDrop = drop;
          $('#image-modal-caption').textContent = drop.caption || '';
        }
      }
    });

    socket.on('drop:deleted', ({ dropId, circleId }) => {
      if (currentCircle && circleId === currentCircle.id) {
        currentDrops = currentDrops.filter((d) => d.id !== dropId);
        renderFeed(currentDrops);
        if (dropMarkers.has(dropId)) {
          map.removeLayer(dropMarkers.get(dropId));
          dropMarkers.delete(dropId);
        }
        if (modalDrop && modalDrop.id === dropId) {
          $('#image-modal').classList.add('hidden');
          toast('That photo drop was deleted');
        }
      }
    });

    socket.on('circle:member-joined', () => { if (currentCircle) openCircle(currentCircle.id); });
    socket.on('circle:member-left', () => { if (currentCircle) openCircle(currentCircle.id); });
  }

  // ---------- circles list ----------

  async function loadCircles() {
    showScreen('#circles-screen');
    const { circles } = await api('/api/circles');
    const list = $('#circles-list');
    list.innerHTML = '';
    if (circles.length === 0) {
      list.innerHTML = `<div class="empty-state"><span class="icon">${ICONS.compass}</span>No circles yet. Create one below, or ask a friend for their invite code.</div>`;
    }
    circles.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'circle-card';
      const initial = (c.name || '?').trim().charAt(0).toUpperCase() || '?';
      div.innerHTML = `
        <div class="card-left">
          <span class="circle-badge" style="background:${colorForUser(c.id)}">${initial}</span>
          <div>
            <div class="card-title">${escapeHtml(c.name)}</div>
            <div class="meta">${c.members.length} member${c.members.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <span class="arrow">&rarr;</span>`;
      div.addEventListener('click', () => openCircle(c.id));
      list.appendChild(div);
    });
  }

  $('#create-circle-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#circles-error').textContent = '';
    const fd = new FormData(e.target);
    try {
      const { circle } = await api('/api/circles', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
      e.target.reset();
      successRipple();
      toast(`${circle.name} is ready`);
      await loadCircles();
      openCircle(circle.id);
    } catch (err) { $('#circles-error').textContent = err.message; }
  });

  $('#join-circle-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#circles-error').textContent = '';
    const fd = new FormData(e.target);
    try {
      const { circle } = await api('/api/circles/join', { method: 'POST', body: JSON.stringify({ code: fd.get('code') }) });
      e.target.reset();
      successRipple();
      toast(`You joined ${circle.name}`);
      await loadCircles();
      openCircle(circle.id);
    } catch (err) { $('#circles-error').textContent = err.message; }
  });

  $('#back-btn').addEventListener('click', () => {
    stopWatchingPosition();
    currentCircle = null;
    loadCircles();
  });

  // ---------- circle / map ----------

  async function openCircle(circleId) {
    const { circles } = await api('/api/circles');
    const circle = circles.find((c) => c.id === circleId);
    if (!circle) return;
    currentCircle = circle;
    $('#circle-name').textContent = circle.name;
    showScreen('#circle-screen');

    initMap();
    renderMembers(circle.members);
    circle.members.forEach((m) => { if (m.location) upsertMemberMarker(m.id, m.location); });

    await loadDrops(circle.id);
    startWatchingPosition();
    updateDropTargetOptions(circle.members);
  }

  function initMap() {
    if (map) { map.remove(); map = null; markers.clear(); dropMarkers.clear(); }
    map = L.map('map', { zoomControl: true }).setView([20, 0], 3);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
  }

  $('#recenter-btn').addEventListener('click', () => {
    if (!map) return;
    if (lastSentPos) {
      map.setView([lastSentPos.lat, lastSentPos.lng], Math.max(map.getZoom(), 15), { animate: true });
      return;
    }
    if (markers.size > 0) {
      const bounds = L.latLngBounds(Array.from(markers.values()).map((m) => m.getLatLng()));
      map.fitBounds(bounds, { padding: [40, 40] });
      return;
    }
    toast('Still finding your location…');
  });

  function colorForUser(userId) {
    let hash = 0;
    for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${hash}, 62%, 42%)`;
  }

  function upsertMemberMarker(userId, loc) {
    const member = currentCircle.members.find((m) => m.id === userId);
    const label = member ? member.username : (userId === me.id ? me.username : 'Someone');
    const isMe = userId === me.id;
    const color = isMe ? '#00b6a0' : colorForUser(userId);
    const initial = (label || '?').trim().charAt(0).toUpperCase() || '?';

    const html = isMe
      ? `<div class="me-pulse-wrap"><div class="me-pulse-ring"></div><div class="avatar-marker" style="background:${color}">${initial}</div></div>`
      : `<div class="avatar-marker" style="background:${color}">${initial}</div>`;

    const icon = L.divIcon({
      className: '',
      html,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    if (markers.has(userId)) {
      markers.get(userId).setLatLng([loc.lat, loc.lng]);
    } else {
      const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(map);
      marker.bindPopup(`<strong>${escapeHtml(label)}${isMe ? ' (you)' : ''}</strong>`);
      markers.set(userId, marker);
    }
    if (isMe && !map._hasCentered) {
      map.setView([loc.lat, loc.lng], 15);
      map._hasCentered = true;
    }
  }

  function renderMembers(members) {
    const list = $('#members-list');
    list.innerHTML = '';
    members.forEach((m) => {
      const chip = document.createElement('div');
      chip.className = 'member-chip' + (m.sharing ? '' : ' offline');
      chip.id = `chip-${m.id}`;
      const isMe = m.id === me.id;
      const initial = (m.username || '?').trim().charAt(0).toUpperCase() || '?';
      const color = isMe ? '#00b6a0' : colorForUser(m.id);
      chip.innerHTML = `
        <span class="avatar-dot" style="background:${color}">${initial}</span>
        <span class="name">${escapeHtml(m.username)}${isMe ? ' (you)' : ''}</span>
        ${isMe ? '' : `<button class="ping-btn" data-user="${m.id}" title="Send an alert"><span class="icon">${ICONS.bell}</span></button>`}
      `;
      list.appendChild(chip);
    });

    $all('.ping-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        socket.emit('ping:send', {
          targetUserId: btn.dataset.user,
          circleId: currentCircle.id,
          message: `${me.username} sent you an alert`,
        });
        toast('Alert sent', 'bell');
      });
    });
  }

  function updateMemberLastSeen(userId, updatedAt) {
    const chip = document.getElementById(`chip-${userId}`);
    if (!chip) return;
    const el = chip.querySelector('.last-seen');
    if (el) el.textContent = 'now';
  }

  function updateDropTargetOptions(members) {
    const select = document.querySelector('select[name="targetUserId"]');
    select.innerHTML = '<option value="">Everyone in this circle</option>';
    members.filter((m) => m.id !== me.id).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `Just ${m.username}`;
      select.appendChild(opt);
    });
  }

  // ---------- geolocation ----------

  function startWatchingPosition() {
    if (!('geolocation' in navigator)) {
      toast('This browser does not support location sharing.');
      return;
    }
    stopWatchingPosition();
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000,
    });
  }

  function stopWatchingPosition() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy, heading, speed } = pos.coords;
    lastSentPos = { lat: latitude, lng: longitude };

    if (currentCircle) upsertMemberMarker(me.id, { lat: latitude, lng: longitude });

    const now = Date.now();
    if (now - lastSentAt < 3000) return; // throttle to ~1 update/3s
    lastSentAt = now;

    if (socket && socket.connected) {
      socket.emit('location:update', { lat: latitude, lng: longitude, accuracy, heading, speed });
    }
  }

  function onPositionError(err) {
    toast(`Location error: ${err.message}. Make sure location access is allowed for this site.`);
  }

  $('#sharing-checkbox').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    if (socket) socket.emit('sharing:toggle', { enabled });
    if (enabled) startWatchingPosition(); else stopWatchingPosition();
  });

  // ---------- drops (photos): grouped by date, then clustered by location ----------

  let currentDrops = [];
  const LOCATION_CLUSTER_DEG = 0.01; // roughly 1km — drops closer than this share a location group

  async function loadDrops(circleId) {
    const { drops } = await api(`/api/circles/${circleId}/drops`);
    currentDrops = drops;
    dropMarkers.forEach((m) => map.removeLayer(m));
    dropMarkers.clear();
    renderFeed(currentDrops);
    currentDrops.forEach((d) => addDropMarker(d));
  }

  function formatDateHeading(ts) {
    const d = new Date(ts);
    const now = new Date();
    const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  }

  // Groups drops (assumed newest-first) into { heading, clusters: [{lat,lng,items}] }
  // — one date section per calendar day, and within each day, drops taken near
  // the same spot are bundled under one location line instead of repeating it.
  function groupDrops(drops) {
    const dateGroups = [];
    let dateKey = null;
    let group = null;

    drops.forEach((drop) => {
      const key = new Date(drop.createdAt).toDateString();
      if (key !== dateKey) {
        dateKey = key;
        group = { heading: formatDateHeading(drop.createdAt), clusters: [] };
        dateGroups.push(group);
      }
      let cluster = null;
      if (drop.lat != null && drop.lng != null) {
        cluster = group.clusters.find(
          (c) => c.lat != null && Math.hypot(c.lat - drop.lat, c.lng - drop.lng) < LOCATION_CLUSTER_DEG
        );
        if (!cluster) {
          cluster = { lat: drop.lat, lng: drop.lng, items: [] };
          group.clusters.push(cluster);
        }
      } else {
        cluster = group.clusters.find((c) => c.lat == null);
        if (!cluster) {
          cluster = { lat: null, lng: null, items: [] };
          group.clusters.push(cluster);
        }
      }
      cluster.items.push(drop);
    });

    return dateGroups;
  }

  function renderFeed(drops) {
    const feedList = $('#feed-list');
    feedList.innerHTML = '';

    if (drops.length === 0) {
      feedList.innerHTML = `<div class="empty-state"><span class="icon">${ICONS.image}</span>No drops yet. Be the first to leave one.</div>`;
      return;
    }

    groupDrops(drops).forEach((group) => {
      const section = document.createElement('div');
      section.className = 'feed-date-group';

      const heading = document.createElement('div');
      heading.className = 'feed-date-heading';
      heading.textContent = group.heading;
      section.appendChild(heading);

      group.clusters.forEach((cluster) => {
        const clusterEl = document.createElement('div');
        clusterEl.className = 'feed-cluster';

        const locRow = document.createElement('div');
        locRow.className = 'feed-location';
        locRow.innerHTML = `<span class="icon">${ICONS.pin}</span><span class="loc-text">${cluster.lat != null ? 'Locating…' : 'No location tagged'}</span>`;
        clusterEl.appendChild(locRow);

        if (cluster.lat != null) {
          reverseGeocode(cluster.lat, cluster.lng).then((name) => {
            const label = name || `${cluster.lat.toFixed(3)}, ${cluster.lng.toFixed(3)}`;
            const textEl = locRow.querySelector('.loc-text');
            if (textEl) textEl.textContent = label;
          });
        }

        const grid = document.createElement('div');
        grid.className = 'feed-grid';
        cluster.items.forEach((drop) => {
          const tile = document.createElement('div');
          tile.className = 'feed-tile';
          tile.innerHTML = `<img src="${drop.imageUrl}" alt="Photo drop" />` + (drop.targetUserId ? '<span class="tile-badge">Private</span>' : '');
          tile.addEventListener('click', () => openImageModal(drop));
          grid.appendChild(tile);
        });
        clusterEl.appendChild(grid);

        section.appendChild(clusterEl);
      });

      feedList.appendChild(section);
    });
  }

  function addDropMarker(drop) {
    if (drop.lat == null || drop.lng == null) return;
    const icon = L.divIcon({
      className: '',
      html: `<div class="drop-marker"><span class="icon">${ICONS.camera}</span></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 22],
    });
    const marker = L.marker([drop.lat, drop.lng], { icon }).addTo(map);
    marker.on('click', () => openImageModal(drop));
    dropMarkers.set(drop.id, marker);
  }

  function openImageModal(drop) {
    modalDrop = drop;
    exitCaptionEditMode();

    $('#image-modal-img').src = drop.imageUrl;
    $('#image-modal-author').innerHTML = escapeHtml(drop.authorName) + (drop.targetUserId ? ' <span class="private-tag">· Private</span>' : '');
    $('#image-modal-caption').textContent = drop.caption || '';
    $('#image-modal-time').textContent = new Date(drop.createdAt).toLocaleString();
    $('#image-modal-owner-actions').classList.toggle('hidden', drop.authorId !== me.id);

    const locEl = $('#image-modal-location');
    if (drop.lat != null && drop.lng != null) {
      locEl.textContent = 'Locating…';
      reverseGeocode(drop.lat, drop.lng).then((name) => {
        locEl.textContent = name || `${drop.lat.toFixed(3)}, ${drop.lng.toFixed(3)}`;
      });
    } else {
      locEl.textContent = 'No location tagged';
    }

    $('#image-modal').classList.remove('hidden');
  }
  $('#close-image-btn').addEventListener('click', () => $('#image-modal').classList.add('hidden'));

  // ---------- editing / deleting your own drops ----------

  function exitCaptionEditMode() {
    $('#image-modal-caption-input').classList.add('hidden');
    $('#image-modal-caption').classList.remove('hidden');
    $('#image-modal-edit-actions').classList.add('hidden');
    if (modalDrop) $('#image-modal-owner-actions').classList.toggle('hidden', modalDrop.authorId !== me.id);
    $('#close-image-btn').classList.remove('hidden');
  }

  $('#edit-image-btn').addEventListener('click', () => {
    if (!modalDrop) return;
    $('#image-modal-caption-input').value = modalDrop.caption || '';
    $('#image-modal-caption').classList.add('hidden');
    $('#image-modal-caption-input').classList.remove('hidden');
    $('#image-modal-owner-actions').classList.add('hidden');
    $('#close-image-btn').classList.add('hidden');
    $('#image-modal-edit-actions').classList.remove('hidden');
    $('#image-modal-caption-input').focus();
  });

  $('#cancel-edit-caption-btn').addEventListener('click', () => exitCaptionEditMode());

  $('#save-caption-btn').addEventListener('click', async () => {
    if (!modalDrop) return;
    const caption = $('#image-modal-caption-input').value.trim();
    try {
      const { drop } = await api(`/api/circles/${currentCircle.id}/drops/${modalDrop.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption }),
      });
      modalDrop = drop;
      const idx = currentDrops.findIndex((d) => d.id === drop.id);
      if (idx !== -1) currentDrops[idx] = drop;
      $('#image-modal-caption').textContent = drop.caption || '';
      exitCaptionEditMode();
      toast('Note updated');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#delete-image-btn').addEventListener('click', async () => {
    if (!modalDrop) return;
    if (!confirm("Delete this photo drop? This can't be undone.")) return;
    const dropId = modalDrop.id;
    try {
      await api(`/api/circles/${currentCircle.id}/drops/${dropId}`, { method: 'DELETE' });
      currentDrops = currentDrops.filter((d) => d.id !== dropId);
      renderFeed(currentDrops);
      if (dropMarkers.has(dropId)) {
        map.removeLayer(dropMarkers.get(dropId));
        dropMarkers.delete(dropId);
      }
      $('#image-modal').classList.add('hidden');
      toast('Deleted');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#drop-btn').addEventListener('click', () => {
    $('#drop-error').textContent = '';
    $('#drop-modal').classList.remove('hidden');
  });
  $('#cancel-drop-btn').addEventListener('click', () => $('#drop-modal').classList.add('hidden'));

  $('#drop-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#drop-error').textContent = '';
    const fd = new FormData(e.target);
    const attachLocation = fd.get('attachLocation') === 'on';
    if (attachLocation && lastSentPos) {
      fd.set('lat', lastSentPos.lat);
      fd.set('lng', lastSentPos.lng);
    }
    fd.delete('attachLocation');
    try {
      await api(`/api/circles/${currentCircle.id}/drops`, { method: 'POST', body: fd });
      $('#drop-modal').classList.add('hidden');
      e.target.reset();
      toast('Sent');
      successRipple('accent');
    } catch (err) {
      $('#drop-error').textContent = err.message;
    }
  });

  // ---------- invite modal ----------

  $('#invite-btn').addEventListener('click', () => {
    $('#invite-code-text').textContent = currentCircle.code;
    $('#invite-modal').classList.remove('hidden');
  });
  $('#close-invite-btn').addEventListener('click', () => $('#invite-modal').classList.add('hidden'));

  // ---------- feed collapse ----------

  $('#feed-toggle-tab').addEventListener('click', () => {
    const panel = $('#feed-panel');
    const collapsed = panel.classList.toggle('collapsed');
    $('#feed-toggle-tab').title = collapsed ? 'Show photo drops' : 'Hide photo drops';
  });

  // ---------- utils ----------

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  // ---------- boot ----------

  if (token && me) {
    connectSocket();
    loadCircles();
  } else {
    showScreen('#auth-screen');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
