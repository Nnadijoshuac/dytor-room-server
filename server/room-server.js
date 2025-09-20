// Room-based WebSocket server for Dytor
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// WebSocket server
const wss = new WebSocket.Server({ server, path: '/ws' });

// Room management
const rooms = new Map();
const users = new Map();

// Room configuration
const ROOM_CONFIG = {
  MAX_USERS_PER_ROOM: 50,
  ROOM_CODE_LENGTH: 6,
  ROOM_TIMEOUT: 24 * 60 * 60 * 1000, // 24 hours
  USER_TIMEOUT: 30 * 60 * 1000, // 30 minutes
};

// Generate room code
function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Create a new room
function createRoom(hostInfo, customRoomCode = null) {
  const roomCode = customRoomCode || generateRoomCode();
  const room = {
    code: roomCode,
    host: hostInfo,
    users: new Map(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    settings: {
      allowViewers: true,
      allowSpeakers: true,
      requireApproval: false,
      maxUsers: ROOM_CONFIG.MAX_USERS_PER_ROOM
    },
    state: {
      timer: null,
      message: null,
      isConnected: false
    }
  };
  
  rooms.set(roomCode, room);
  console.log(`🏠 Room created: ${roomCode}`);
  return room;
}

// Join a room
function joinRoom(roomCode, userInfo) {
  const room = rooms.get(roomCode);
  if (!room) {
    throw new Error('Room not found');
  }
  
  if (room.users.size >= room.settings.maxUsers) {
    throw new Error('Room is full');
  }
  
  // Add user to room
  room.users.set(userInfo.id, userInfo);
  room.lastActivity = Date.now();
  
  console.log(`👤 User ${userInfo.name} joined room ${roomCode}`);
  return room;
}

// Leave a room
function leaveRoom(roomCode, userId) {
  const room = rooms.get(roomCode);
  if (!room) {
    return;
  }
  
  room.users.delete(userId);
  room.lastActivity = Date.now();
  
  // If no users left, clean up room
  if (room.users.size === 0) {
    rooms.delete(roomCode);
    console.log(`🗑️ Room ${roomCode} cleaned up (no users)`);
  }
}

// Broadcast to all users in a room
function broadcastToRoom(roomCode, message, excludeUserId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  room.users.forEach((user, userId) => {
    if (userId !== excludeUserId && user.ws && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(JSON.stringify(message));
    }
  });
}

// API Routes

// Create a new room
app.post('/api/rooms', (req, res) => {
  try {
    const { hostName, hostType } = req.body;
    
    const room = createRoom({
      id: crypto.randomUUID(),
      name: hostName || 'Room Host',
      type: hostType || 'desktop',
      joinedAt: Date.now()
    });
    
    res.json({
      success: true,
      room: {
        code: room.code,
        settings: room.settings,
        createdAt: room.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create a new room (alternative endpoint for desktop app)
app.post('/api/rooms/create', (req, res) => {
  try {
    const { roomCode, hostType, hostInfo } = req.body;
    
    // Use provided room code or generate one
    const code = roomCode || generateRoomCode();
    
    // Check if room already exists
    if (rooms.has(code)) {
      return res.status(400).json({
        success: false,
        error: 'Room code already exists'
      });
    }
    
    const room = createRoom({
      id: crypto.randomUUID(),
      name: hostInfo?.name || 'Desktop App',
      type: hostType || 'desktop',
      joinedAt: Date.now()
    }, code); // Pass the room code
    
    res.json({
      success: true,
      room: {
        code: room.code,
        settings: room.settings,
        createdAt: room.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Join a room
app.post('/api/rooms/:roomCode/join', (req, res) => {
  try {
    const { roomCode } = req.params;
    const { userName, userRole } = req.body;
    
    const userInfo = {
      id: crypto.randomUUID(),
      name: userName || 'Anonymous User',
      role: userRole || 'viewer',
      joinedAt: Date.now()
    };
    
    const room = joinRoom(roomCode, userInfo);
    
    res.json({
      success: true,
      user: userInfo,
      room: {
        code: room.code,
        settings: room.settings,
        userCount: room.users.size
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Get room info
app.get('/api/rooms/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({
      success: false,
      error: 'Room not found'
    });
  }
  
  res.json({
    success: true,
    room: {
      code: room.code,
      settings: room.settings,
      userCount: room.users.size,
      isHostConnected: room.host && room.state.isConnected,
      createdAt: room.createdAt,
      lastActivity: room.lastActivity
    }
  });
});

// Get room users
app.get('/api/rooms/:roomCode/users', (req, res) => {
  const { roomCode } = req.params;
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({
      success: false,
      error: 'Room not found'
    });
  }
  
  const users = Array.from(room.users.values()).map(user => ({
    id: user.id,
    name: user.name,
    role: user.role,
    joinedAt: user.joinedAt,
    isOnline: user.ws && user.ws.readyState === WebSocket.OPEN
  }));
  
  res.json({
    success: true,
    users: users
  });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  let currentUser = null;
  let currentRoom = null;
  
  console.log('🔌 New WebSocket connection');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data);
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: 'Invalid message format'
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket connection closed');
    if (currentUser && currentRoom) {
      leaveRoom(currentRoom, currentUser.id);
      broadcastToRoom(currentRoom, {
        type: 'USER_LEFT',
        user: currentUser
      });
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
  
  // Handle WebSocket messages
  function handleWebSocketMessage(ws, data) {
    console.log('📨 Received:', data.type);
    
    switch (data.type) {
      case 'REGISTER_HOST':
        handleRegisterHost(ws, data);
        break;
        
      case 'JOIN_ROOM':
        handleJoinRoom(ws, data);
        break;
        
      case 'LEAVE_ROOM':
        handleLeaveRoom(ws, data);
        break;
        
      case 'REGISTER_USER':
        handleRegisterUser(ws, data);
        break;
        
      case 'ROOM_STATE_UPDATE':
        handleRoomStateUpdate(data);
        break;
        
      case 'USER_COMMAND':
        handleUserCommand(data);
        break;
        
      case 'CHAT_MESSAGE':
        handleChatMessage(data);
        break;
        
      default:
        console.log('Unknown message type:', data.type);
    }
  }
  
  // Handle desktop app joining room as host
  function handleJoinRoom(ws, data) {
    const { roomCode, clientType, clientInfo } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: 'Room not found'
      }));
      return;
    }
    
    if (clientType === 'host') {
      // Desktop app joining as host
      room.host.ws = ws;
      room.state.isConnected = true;
      room.lastActivity = Date.now();
      
      currentUser = room.host;
      currentRoom = roomCode;
      
      console.log(`🖥️ Desktop host connected to room ${roomCode}`);
      
      // Notify all users that host is connected
      broadcastToRoom(roomCode, {
        type: 'HOST_CONNECTED',
        host: room.host
      });
      
      // Send current room state to host
      ws.send(JSON.stringify({
        type: 'ROOM_JOINED',
        roomCode: roomCode,
        clients: Array.from(room.users.values()),
        room: {
          code: room.code,
          settings: room.settings,
          userCount: room.users.size
        }
      }));
    } else {
      // Web user joining room
      const userInfo = {
        id: crypto.randomUUID(),
        name: clientInfo.name || 'Anonymous User',
        role: clientInfo.role || 'viewer',
        joinedAt: Date.now(),
        ws: ws
      };
      
      room.users.set(userInfo.id, userInfo);
      room.lastActivity = Date.now();
      
      currentUser = userInfo;
      currentRoom = roomCode;
      
      console.log(`🌐 User ${userInfo.name} joined room ${roomCode}`);
      
      // Notify host about new user
      if (room.host.ws && room.host.ws.readyState === WebSocket.OPEN) {
        room.host.ws.send(JSON.stringify({
          type: 'ROOM_CLIENT_JOINED',
          client: userInfo
        }));
      }
      
      // Send room info to user
      ws.send(JSON.stringify({
        type: 'ROOM_JOINED',
        roomCode: roomCode,
        clients: Array.from(room.users.values()),
        room: {
          code: room.code,
          settings: room.settings,
          userCount: room.users.size
        }
      }));
    }
  }

  // Handle leaving room
  function handleLeaveRoom(ws, data) {
    const { roomCode } = data;
    const room = rooms.get(roomCode);
    
    if (!room) return;
    
    if (currentUser === room.host) {
      // Host is leaving
      room.host.ws = null;
      room.state.isConnected = false;
      console.log(`🖥️ Desktop host left room ${roomCode}`);
      
      // Notify all users that host disconnected
      broadcastToRoom(roomCode, {
        type: 'HOST_DISCONNECTED'
      });
    } else {
      // User is leaving
      const userId = currentUser?.id;
      if (userId && room.users.has(userId)) {
        room.users.delete(userId);
        console.log(`🌐 User ${currentUser.name} left room ${roomCode}`);
        
        // Notify host about user leaving
        if (room.host.ws && room.host.ws.readyState === WebSocket.OPEN) {
          room.host.ws.send(JSON.stringify({
            type: 'ROOM_CLIENT_LEFT',
            clientId: userId
          }));
        }
      }
    }
    
    currentUser = null;
    currentRoom = null;
  }

  // Register desktop app as room host (legacy)
  function handleRegisterHost(ws, data) {
    const { roomCode, hostInfo } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: 'Room not found'
      }));
      return;
    }
    
    // Update room host
    room.host.ws = ws;
    room.state.isConnected = true;
    room.lastActivity = Date.now();
    
    currentUser = room.host;
    currentRoom = roomCode;
    
    console.log(`🖥️ Desktop host registered for room ${roomCode}`);
    
    // Notify all users that host is connected
    broadcastToRoom(roomCode, {
      type: 'HOST_CONNECTED',
      host: room.host
    });
    
    // Send current room state to host
    ws.send(JSON.stringify({
      type: 'ROOM_INFO',
      room: {
        code: room.code,
        settings: room.settings,
        userCount: room.users.size
      }
    }));
  }
  
  // Register web user
  function handleRegisterUser(ws, data) {
    const { roomCode, userId, userInfo } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: 'Room not found'
      }));
      return;
    }
    
    const user = room.users.get(userId);
    if (!user) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: 'User not found in room'
      }));
      return;
    }
    
    // Update user WebSocket
    user.ws = ws;
    currentUser = user;
    currentRoom = roomCode;
    
    console.log(`👤 User ${user.name} registered for room ${roomCode}`);
    
    // Send current room state to user
    ws.send(JSON.stringify({
      type: 'ROOM_STATE',
      state: room.state,
      isHostConnected: room.state.isConnected
    }));
    
    // Notify other users
    broadcastToRoom(roomCode, {
      type: 'USER_JOINED',
      user: user
    }, userId);
  }
  
  // Handle room state updates from host
  function handleRoomStateUpdate(data) {
    if (!currentRoom || !currentUser || currentUser.type !== 'desktop') {
      return;
    }
    
    const room = rooms.get(currentRoom);
    if (!room) return;
    
    // Update room state
    room.state = { ...room.state, ...data.state };
    room.lastActivity = Date.now();
    
    // Broadcast to all users
    broadcastToRoom(currentRoom, {
      type: 'ROOM_STATE_UPDATE',
      state: room.state
    });
  }
  
  // Handle user commands
  function handleUserCommand(data) {
    if (!currentRoom || !currentUser) {
      return;
    }
    
    const room = rooms.get(currentRoom);
    if (!room || !room.host.ws) {
      return;
    }
    
    // Forward command to host
    room.host.ws.send(JSON.stringify({
      type: 'USER_COMMAND',
      user: currentUser,
      command: data.command,
      data: data.data
    }));
  }
  
  // Handle chat messages
  function handleChatMessage(data) {
    if (!currentRoom || !currentUser) {
      return;
    }
    
    const message = {
      id: crypto.randomUUID(),
      user: currentUser,
      message: data.message,
      timestamp: Date.now()
    };
    
    broadcastToRoom(currentRoom, {
      type: 'CHAT_MESSAGE',
      message: message
    });
  }
});

// Cleanup inactive rooms
setInterval(() => {
  const now = Date.now();
  for (const [roomCode, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_CONFIG.ROOM_TIMEOUT) {
      rooms.delete(roomCode);
      console.log(`🗑️ Cleaned up inactive room: ${roomCode}`);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// Start server
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`🚀 Dytor Room Server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`🌐 API endpoint: http://localhost:${PORT}/api`);
});

module.exports = { server, app };
