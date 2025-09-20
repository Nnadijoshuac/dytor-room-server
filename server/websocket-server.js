// server/websocket-server.js
const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const http = require('http');
const os = require('os');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server, path: '/ws' });

// Store connected clients
const clients = new Map();
let controllerClient = null;
let remoteClients = new Set();
let displayClients = new Set();

// Authentication tokens (in production, use proper session management)
const authTokens = new Map();
const REMOTE_AUTH_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Get local IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      if (interface.family === 'IPv4' && !interface.internal) {
        return interface.address;
      }
    }
  }
  return '127.0.0.1';
}

const localIP = getLocalIP();

// Serve static files for remote interface
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Generate authentication token
function generateAuthToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + REMOTE_AUTH_TIMEOUT;
  authTokens.set(token, { expires, used: false });
  
  // Clean up expired tokens
  setTimeout(() => {
    authTokens.delete(token);
  }, REMOTE_AUTH_TIMEOUT);
  
  return token;
}

// Validate authentication token
function validateAuthToken(token) {
  const authData = authTokens.get(token);
  if (!authData) return false;
  
  if (Date.now() > authData.expires) {
    authTokens.delete(token);
    return false;
  }
  
  if (authData.used) return false;
  
  // Mark token as used
  authData.used = true;
  return true;
}

// Generate QR code for remote access
async function generateQRCode() {
  const token = generateAuthToken();
  const remoteUrl = `http://${localIP}:3001/remote?token=${token}`;
  
  try {
    const qrCodeDataURL = await QRCode.toDataURL(remoteUrl, {
      width: 200,
      margin: 2,
      color: {
        dark: '#3b82f6',
        light: '#ffffff'
      }
    });
    
    return {
      qrCode: qrCodeDataURL,
      url: remoteUrl,
      token
    };
  } catch (error) {
    console.error('Error generating QR code:', error);
    return null;
  }
}

// API endpoint to get QR code and remote URL
app.get('/api/remote-info', async (req, res) => {
  try {
    const qrData = await generateQRCode();
    if (qrData) {
      res.json({
        success: true,
        qrCode: qrData.qrCode,
        url: qrData.url,
        expires: REMOTE_AUTH_TIMEOUT
      });
    } else {
      res.status(500).json({ success: false, message: 'Failed to generate QR code' });
    }
  } catch (error) {
    console.error('Error generating remote info:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Remote control interface route with authentication
app.get('/remote', (req, res) => {
  const token = req.query.token;
  
  if (!token || !validateAuthToken(token)) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>dytorpro Remote - Authentication Required</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a; color: white; margin: 0; padding: 20px;
            display: flex; align-items: center; justify-content: center; min-height: 100vh;
          }
          .auth-container { 
            background: #1e293b; border: 2px solid #ef4444; border-radius: 16px; 
            padding: 40px; text-align: center; max-width: 400px;
          }
          .auth-container h1 { color: #ef4444; margin-bottom: 16px; }
          .auth-container p { color: #94a3b8; margin-bottom: 24px; }
          .auth-container a { 
            background: #3b82f6; color: white; padding: 12px 24px; 
            text-decoration: none; border-radius: 8px; font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="auth-container">
          <h1>🔒 Authentication Required</h1>
          <p>This remote access link has expired or is invalid.</p>
          <p>Please get a new QR code from the main controller.</p>
          <a href="javascript:history.back()">Go Back</a>
        </div>
      </body>
      </html>
    `);
  }
  
  res.sendFile(path.join(__dirname, 'remote.html'));
});

// API endpoint for remote commands
app.post('/api/command', (req, res) => {
  const { action, data } = req.body;
  
  if (controllerClient && controllerClient.readyState === WebSocket.OPEN) {
    controllerClient.send(JSON.stringify({
      type: 'REMOTE_CONTROL',
      action,
      data
    }));
    res.json({ success: true });
  } else {
    res.status(503).json({ success: false, message: 'Controller not connected' });
  }
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const clientId = Date.now() + Math.random();
  clients.set(ws, { 
    id: clientId, 
    type: 'unknown',
    permissions: [],
    name: 'Unknown Client'
  });

  console.log(`New WebSocket connection: ${clientId}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const client = clients.get(ws);

      switch (data.type) {
        case 'REGISTER_CONTROLLER':
          client.type = 'controller';
          controllerClient = ws;
          console.log('Controller registered');
          
          // Notify all remote clients about controller status
          broadcastToRemotes({
            type: 'CONTROLLER_STATUS',
            connected: true
          });
          break;

        case 'REGISTER_REMOTE':
          client.type = 'remote';
          client.name = data.name || `Remote Client ${clientId}`;
          client.role = data.role || null;
          client.requestedPermissions = data.permissions || [];
          client.speakerName = data.speakerName || null;
          remoteClients.add(ws);
          console.log(`Remote client registered: ${client.name} (Role: ${client.role})`);
          
          // Send current status to the new remote
          ws.send(JSON.stringify({
            type: 'CONTROLLER_STATUS',
            connected: controllerClient !== null,
            permissions: client.requestedPermissions,
            role: client.role
          }));
          
          // Notify controller about new remote client
          if (controllerClient && controllerClient.readyState === WebSocket.OPEN) {
            controllerClient.send(JSON.stringify({
              type: 'REMOTE_CONNECTED',
              data: {
                clientId: clientId,
                name: client.name,
                role: client.role,
                speakerName: client.speakerName,
                permissions: client.requestedPermissions
              }
            }));
          }
          
          // Update controller about remote count
          updateRemoteCount();
          break;

        case 'REGISTER_DISPLAY':
          client.type = 'display';
          client.name = `Display Client ${clientId}`;
          client.url = data.data?.url || 'Unknown';
          displayClients.add(ws);
          console.log(`Display client registered: ${client.name} from ${client.url}`);
          
          // Send current timer and message state to the new display
          if (controllerClient && controllerClient.readyState === WebSocket.OPEN) {
            // Request current state from controller
            controllerClient.send(JSON.stringify({
              type: 'REQUEST_CURRENT_STATE',
              targetClientId: clientId
            }));
          }
          
          // Notify controller about new display client
          if (controllerClient && controllerClient.readyState === WebSocket.OPEN) {
            controllerClient.send(JSON.stringify({
              type: 'DISPLAY_CONNECTED',
              data: {
                clientId: clientId,
                name: client.name,
                url: client.url
              }
            }));
          }
          break;

        case 'TIMER_UPDATE':
          // Forward timer updates to all remote clients and displays
          broadcastToRemotes({
            type: 'TIMER_UPDATE',
            data: data.data
          });
          broadcastToDisplays({
            type: 'TIMER_UPDATE',
            data: data.data
          });
          break;

        case 'MESSAGE_UPDATE':
          // Forward message updates to all remote clients and displays
          broadcastToRemotes({
            type: 'MESSAGE_UPDATE',
            data: data.data
          });
          broadcastToDisplays({
            type: 'MESSAGE_UPDATE',
            data: data.data
          });
          break;

        case 'REMOTE_CONTROL':
          // Validate permissions before forwarding commands
          if (hasPermission(client, data.action)) {
            // Forward remote control commands to controller
            if (controllerClient && controllerClient.readyState === WebSocket.OPEN) {
              controllerClient.send(JSON.stringify(data));
            }
          } else {
            // Send permission denied message back to remote
            ws.send(JSON.stringify({
              type: 'PERMISSION_DENIED',
              action: data.action,
              message: `Permission denied for action: ${data.action}`
            }));
          }
          break;

        case 'GRANT_PERMISSIONS':
          // Controller granting permissions to a remote client
          if (client.type === 'controller') {
            const targetClientId = data.clientId;
            const permissions = data.permissions;
            
            // Find the target client
            for (const [wsClient, clientData] of clients.entries()) {
              if (clientData.id === targetClientId && clientData.type === 'remote') {
                clientData.permissions = permissions;
                console.log(`Granted permissions to ${clientData.name}:`, permissions);
                
                // Notify the remote client about their new permissions
                wsClient.send(JSON.stringify({
                  type: 'PERMISSIONS_GRANTED',
                  permissions: permissions
                }));
                break;
              }
            }
          }
          break;

        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    console.log(`Client disconnected: ${client?.id} (${client?.type})`);

    if (client?.type === 'controller') {
      controllerClient = null;
      console.log('Controller disconnected');
      
      // Notify all remote clients
      broadcastToRemotes({
        type: 'CONTROLLER_STATUS',
        connected: false
      });
    } else if (client?.type === 'remote') {
      remoteClients.delete(ws);
      console.log(`Remote client disconnected. Total remotes: ${remoteClients.size}`);
      updateRemoteCount();
    } else if (client?.type === 'display') {
      displayClients.delete(ws);
      console.log(`Display client disconnected. Total displays: ${displayClients.size}`);
      
      // Notify controller about display disconnection
      if (controllerClient && controllerClient.readyState === WebSocket.OPEN) {
        controllerClient.send(JSON.stringify({
          type: 'DISPLAY_DISCONNECTED',
          data: {
            clientId: client.id,
            name: client.name,
            url: client.url
          }
        }));
      }
    }

    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Role-based permission validation
function hasRolePermission(role, action) {
  const rolePermissions = {
    'admin': [
      'START_RESUME', 'PAUSE', 'STOP', 'ADD_TIME', 'SUBTRACT_TIME', 'RESET',
      'SCHEDULE_VIEW', 'SCHEDULE_EDIT', 'SCHEDULE_REORDER', 'SCHEDULE_ADD', 'SCHEDULE_REMOVE',
      'MESSAGE_SEND', 'MESSAGE_PRESET', 'MESSAGE_PRIVATE', 'MESSAGE_FLASH',
      'DISPLAY_FADE', 'DISPLAY_SETTINGS'
    ],
    'queue_manager': [
      'START_RESUME', 'PAUSE', 'ADD_TIME', 'SUBTRACT_TIME',
      'SCHEDULE_VIEW', 'MESSAGE_PRESET', 'MESSAGE_SEND'
    ],
    'speaker': [
      'PERSONAL_TIMER', 'PERSONAL_MESSAGES', 'SCHEDULE_VIEW'
    ],
    'viewer': []
  };
  
  return rolePermissions[role]?.includes(action) || false;
}

// Permission validation function (updated for roles)
function hasPermission(client, action) {
  // If client has a role, use role-based permissions
  if (client.role) {
    return hasRolePermission(client.role, action);
  }
  
  // Fallback to old permission system
  if (!client.permissions || client.permissions.length === 0) {
    return false;
  }
  
  const permissionMap = {
    'START_RESUME': ['TIME_CONTROL', 'FULL_CONTROL'],
    'PAUSE': ['TIME_CONTROL', 'FULL_CONTROL'],
    'ADD_TIME': ['TIME_CONTROL', 'FULL_CONTROL'],
    'SEND_MESSAGE': ['MESSAGE_ONLY', 'TIME_CONTROL', 'FULL_CONTROL'],
    'SHOW_MESSAGE': ['MESSAGE_ONLY', 'TIME_CONTROL', 'FULL_CONTROL'],
    'FLASH_MESSAGE': ['MESSAGE_ONLY', 'TIME_CONTROL', 'FULL_CONTROL'],
    'FADE_TO_BLACK': ['FULL_CONTROL'],
    'SCHEDULE_CONTROL': ['FULL_CONTROL'],
    'SETTINGS_CONTROL': ['FULL_CONTROL']
  };
  
  const requiredPermissions = permissionMap[action] || [];
  return requiredPermissions.some(permission => client.permissions.includes(permission));
}

// Broadcast message to all remote clients
function broadcastToRemotes(message) {
  remoteClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    } else {
      remoteClients.delete(client);
    }
  });
}

// Broadcast message to all display clients
function broadcastToDisplays(message) {
  displayClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    } else {
      displayClients.delete(client);
    }
  });
}

// Update controller about remote client count
function updateRemoteCount() {
  if (controllerClient && controllerClient.readyState === WebSocket.OPEN) {
    controllerClient.send(JSON.stringify({
      type: 'REMOTE_COUNT',
      count: remoteClients.size
    }));
  }
}

// Start server
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`🚀 dytorpro Remote Server running on:`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Network:  http://${localIP}:${PORT}`);
  console.log(`   Remote:   http://${localIP}:${PORT}/remote`);
  console.log('');
  console.log('✨ Ready for remote connections!');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { server, app };