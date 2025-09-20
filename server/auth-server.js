// Authentication and User Management Server for Dytor
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// In-memory user storage (in production, use a database)
const users = new Map();
const userSessions = new Map();

// JWT secret (in production, use environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'dytor-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';

// Room ownership tracking
const roomOwners = new Map(); // roomCode -> userId

// Helper functions
function generateUserId() {
  return 'user_' + crypto.randomUUID();
}

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function generateToken(user) {
  return jwt.sign(
    { 
      userId: user.id, 
      email: user.email,
      name: user.name 
    }, 
    JWT_SECRET, 
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Middleware to authenticate requests
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({ success: false, error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
}

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Auth server is running' });
});

// User Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validation
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Name, email, and password are required'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    // Check if user already exists
    if (users.has(email)) {
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Create user
    const userId = generateUserId();
    const user = {
      id: userId,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashPassword(password),
      createdAt: new Date().toISOString(),
      rooms: [], // Array of room codes owned by this user
      lastLogin: null
    };

    users.set(email, user);

    // Generate token
    const token = generateToken(user);

    // Return user data (without password)
    const { password: _, ...userData } = user;
    userData.lastLogin = new Date().toISOString();

    res.json({
      success: true,
      user: userData,
      token: token
    });

    console.log(`👤 User registered: ${user.name} (${user.email})`);
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed'
    });
  }
});

// User Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Find user
    const user = users.get(email.toLowerCase().trim());
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Verify password
    if (!verifyPassword(password, user.password)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Update last login
    user.lastLogin = new Date().toISOString();

    // Generate token
    const token = generateToken(user);

    // Return user data (without password)
    const { password: _, ...userData } = user;

    res.json({
      success: true,
      user: userData,
      token: token
    });

    console.log(`🔑 User logged in: ${user.name} (${user.email})`);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// Verify Token
app.post('/api/auth/verify', authenticateToken, (req, res) => {
  const user = users.get(req.user.email);
  if (!user) {
    return res.status(404).json({
      success: false,
      error: 'User not found'
    });
  }

  const { password: _, ...userData } = user;
  res.json({
    success: true,
    user: userData
  });
});

// Create Room (Authenticated)
app.post('/api/rooms/create', authenticateToken, async (req, res) => {
  try {
    const { roomName, roomSettings } = req.body;
    const userId = req.user.userId;

    // Get user
    const user = users.get(req.user.email);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Generate room code
    let roomCode;
    let attempts = 0;
    do {
      roomCode = generateRoomCode();
      attempts++;
    } while (roomOwners.has(roomCode) && attempts < 10);

    if (attempts >= 10) {
      return res.status(500).json({
        success: false,
        error: 'Failed to generate unique room code'
      });
    }

    // Create room
    const room = {
      code: roomCode,
      name: roomName || `${user.name}'s Room`,
      owner: {
        id: userId,
        name: user.name,
        email: user.email
      },
      settings: {
        allowViewers: true,
        allowSpeakers: true,
        requireApproval: false,
        maxUsers: 50,
        ...roomSettings
      },
      createdAt: new Date().toISOString(),
      isActive: false,
      userCount: 0,
      shareUrl: `${process.env.WEB_URL || 'https://dytor.netlify.app'}/room/${roomCode}`
    };

    // Track room ownership
    roomOwners.set(roomCode, userId);
    user.rooms.push(roomCode);

    console.log(`🏠 Room created: ${roomCode} by ${user.name}`);

    res.json({
      success: true,
      room: room
    });
  } catch (error) {
    console.error('Room creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create room'
    });
  }
});

// Get User's Rooms
app.get('/api/rooms/my', authenticateToken, async (req, res) => {
  try {
    const user = users.get(req.user.email);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get room details (in production, query database)
    const userRooms = user.rooms.map(roomCode => ({
      code: roomCode,
      // Add room details from room server if needed
    }));

    res.json({
      success: true,
      rooms: userRooms
    });
  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get rooms'
    });
  }
});

// Get Room Info (Public)
app.get('/api/rooms/:roomCode', async (req, res) => {
  try {
    const { roomCode } = req.params;
    const ownerId = roomOwners.get(roomCode);

    if (!ownerId) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    // Find room owner
    let owner = null;
    for (const [email, user] of users.entries()) {
      if (user.id === ownerId) {
        owner = { name: user.name, email: user.email };
        break;
      }
    }

    res.json({
      success: true,
      room: {
        code: roomCode,
        owner: owner,
        shareUrl: `${process.env.WEB_URL || 'https://dytor.netlify.app'}/room/${roomCode}`
      }
    });
  } catch (error) {
    console.error('Get room info error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get room info'
    });
  }
});

// Update User Profile
app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;
    const user = users.get(req.user.email);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    if (name && name.trim()) {
      user.name = name.trim();
    }

    const { password: _, ...userData } = user;

    res.json({
      success: true,
      user: userData
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    });
  }
});

// Change Password
app.put('/api/user/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = users.get(req.user.email);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Verify current password
    if (!verifyPassword(currentPassword, user.password)) {
      return res.status(401).json({
        success: false,
        error: 'Current password is incorrect'
      });
    }

    // Validate new password
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'New password must be at least 6 characters'
      });
    }

    // Update password
    user.password = hashPassword(newPassword);

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
});

// Logout (client-side token removal, but we can track it)
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  // In a more sophisticated system, you'd add the token to a blacklist
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`🔐 Dytor Auth Server running on port ${PORT}`);
  console.log(`🌐 API endpoint: http://localhost:${PORT}/api`);
  console.log(`📡 Ready for authentication requests`);
});

module.exports = { app, users, roomOwners };
