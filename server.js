require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const mqtt = require("mqtt");
const cors = require("cors");
const http = require('http');
const socketIo = require('socket.io');
const WebSocket = require('ws');

const authRoutes = require("./routes/auth");
const profileRoutes = require("./routes/profile");

// Models
const Task = require('./models/Task');
const RobotStatus = require('./models/RobotStatus');
const Alert = require('./models/Alert');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Serve static map images
app.use('/maps', express.static('uploads/maps'));

// Map ID to image URL mapping
const MAP_IMAGES = {
  "M001": "https://backendapp-zduc.onrender.com/maps/my_map.png",
  "M002": "https://backendapp-zduc.onrender.com/maps/my_map1.png", 
  "M003": "https://backendapp-zduc.onrender.com/maps/my_map4.png"
};

// --- MongoDB connection ---
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// --- Test route ---
app.get("/test", (req, res) => {
  res.json({ msg: "✅ Server is running!" });
});

// --- Test language route ---
app.get("/auth/test-language", (req, res) => {
  res.json({ msg: "✅ Language route is accessible!" });
});

// --- Debug middleware ---
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// --- Pi Communication Variables ---
let pendingCommand = null;
let commandId = 0;

// --- Routes ---
app.use("/auth", authRoutes);
app.use("/api/profile", profileRoutes);

// --- MQTT setup ---
const mqttClient = mqtt.connect(process.env.MQTT_BROKER, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
});

// MQTT Topics with QoS
const TOPICS = {
  TASKS: { name: 'robot/tasks', qos: 1 },
  STATUS: { name: 'robot/status', qos: 0 },
  ACTION: { name: 'robot/action', qos: 1 },
  ALERT: { name: 'robot/alert', qos: 1 }
};

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected");
  
  // Subscribe to all topics with appropriate QoS
  Object.values(TOPICS).forEach(topic => {
    mqttClient.subscribe(topic.name, { qos: topic.qos }, (err) => {
      if (!err) {
        console.log(`📡 Subscribed to ${topic.name} (QoS: ${topic.qos})`);
      } else {
        console.error(`❌ Subscription error for ${topic.name}:`, err);
      }
    });
  });
});

mqttClient.on("message", (topic, message) => {
  const msg = message.toString();
  console.log(`📩 MQTT [${topic}]: ${msg}`);
  console.log(`🔍 Message received at:`, new Date().toISOString());
  
  try {
    const data = JSON.parse(msg);
    console.log(`🔍 Parsed data:`, data);
    console.log(`🔍 Topic match check: ${topic} === ${TOPICS.TASKS.name} = ${topic === TOPICS.TASKS.name}`);
    console.log(`🔍 Available topics:`, Object.values(TOPICS).map(t => t.name));
    handleMqttMessage(topic, data);
  } catch (err) {
    console.log(`❌ JSON Parse Error:`, err);
    console.log(`📩 MQTT [${topic}] (text): ${msg}`);
  }
});

// Handle different MQTT message types (FROM MICROCONTROLLER)
async function handleMqttMessage(topic, data) {
  try {
    switch(topic) {
      case TOPICS.STATUS.name:
        await handleStatusFromMCU(data);
        break;
      case TOPICS.TASKS.name:
        await handleTaskUpdateFromMCU(data);
        break;
      case TOPICS.ACTION.name:
        await handleActionResponseFromMCU(data);
        break;
      case TOPICS.ALERT.name:
        await handleAlertFromMCU(data);
        break;
    }
  } catch (error) {
    console.error('MQTT message handling error:', error);
  }
}

// Handle status updates FROM microcontroller
async function handleStatusFromMCU(data) {
  console.log(`🤖 Status from MCU:`, data);
  
  try {
    // Extract numeric value from battery percentage for alerts
    let batteryNumeric = data.batteryPercent;
    if (typeof data.batteryPercent === 'string') {
      batteryNumeric = parseInt(data.batteryPercent.replace('%', ''));
    }
    
    console.log(`💾 Saving to database...`);
    // Create new status record instead of updating existing one
    const status = new RobotStatus({
      batteryPercent: data.batteryPercent,
      runtime: data.runtime,
      loadWeight: data.loadWeight,
      temperature: data.temperature,
      position: data.position,
      isActive: data.isActive,
      lastUpdated: new Date()
    });
    await status.save();
    
    console.log(`✅ Robot status saved:`, status);
    
    // 🔴 EMIT LIVE DATA TO ALL CONNECTED CLIENTS
    io.emit('robotStatus', status);
    
    // 🔴 EMIT LIVE MAP DATA
    const mapUpdate = {
      robotPosition: data.position,
      batteryLevel: data.batteryPercent,
      isActive: data.isActive,
      timestamp: new Date()
    };
    io.emit('mapUpdate', mapUpdate);
    
    // Keep only last 10 status records
    const statusCount = await RobotStatus.countDocuments();
    if (statusCount > 10) {
      const statusToDelete = statusCount - 10;
      const oldestStatus = await RobotStatus.find().sort({ lastUpdated: 1 }).limit(statusToDelete);
      const idsToDelete = oldestStatus.map(status => status._id);
      await RobotStatus.deleteMany({ _id: { $in: idsToDelete } });
      console.log(`🗑️ Deleted ${statusToDelete} old status records, keeping latest 20`);
    }
    
    // Check for low battery alert using numeric value
    if (batteryNumeric < 20) {
      await createAlert('low_battery', `Battery low: ${data.batteryPercent}`, 'warning', data);
    }
  } catch (error) {
    console.error(`❌ Error saving robot status:`, error);
  }
}

// Handle task data FROM microcontroller
async function handleTaskUpdateFromMCU(data) {
  console.log(`📋 Task data from MCU:`, data);
  console.log(`📋 Maps received:`, data.maps);
  console.log(`📋 Number of maps:`, data.maps ? data.maps.length : 0);
  
  // If MCU sends new task data, store it
  if (data.taskId && data.taskName && data.maps) {
    // Add imageUrl to maps
    data.maps.forEach(map => {
      map.imageUrl = MAP_IMAGES[map.mapId] || null;
    });
    
    const existingTask = await Task.findOne({ taskId: data.taskId });
    
    if (!existingTask) {
      // Create new task from MCU data
      const task = new Task({
        taskId: data.taskId,
        taskName: data.taskName,
        maps: data.maps
      });
      await task.save();
      console.log(`🆕 New task created: ${data.taskId} with ${data.maps.length} maps`);
      // 🔴 EMIT LIVE TASK DATA
      io.emit('taskUpdate', task);
    } else {
      // Update existing task with new maps
      existingTask.maps = data.maps;
      existingTask.taskName = data.taskName;
      await existingTask.save();
      console.log(`🔄 Task updated: ${data.taskId} with ${data.maps.length} maps`);
      // 🔴 EMIT LIVE TASK DATA
      io.emit('taskUpdate', existingTask);
    }
  }
  
  // Handle status updates
  if (data.taskId && data.status) {
    const updateData = { status: data.status };
    
    if (data.status === 'in_progress') {
      updateData.startedAt = new Date();
    } else if (data.status === 'completed' || data.status === 'failed') {
      updateData.completedAt = new Date();
      
      if (data.status === 'completed') {
        await createAlert('mission_complete', `Task ${data.taskId} completed successfully`, 'info', data);
      }
    }
    
    await Task.findOneAndUpdate(
      { taskId: data.taskId },
      updateData
    );
  }
}

// Handle action responses FROM microcontroller
async function handleActionResponseFromMCU(data) {
  console.log(`⚡ Action response from MCU:`, data);
  // Store action responses if needed
}

// Handle alerts FROM microcontroller
async function handleAlertFromMCU(data) {
  console.log(`🚨 Alert from MCU:`, data);
  await createAlert(data.type, data.message, data.severity, data.data);
  
  // If mission completed, notify to clear map selection
  if (data.type === 'mission_complete') {
    console.log(`✅ Mission completed - clearing map selection`);
    // You can add additional logic here if needed
  }
}

// Helper function to create alerts
async function createAlert(type, message, severity = 'info', data = null) {
  const alert = new Alert({
    type,
    message,
    severity,
    data
  });
  await alert.save();
  console.log(`🚨 Alert created: ${type} - ${message}`);
  
  // 🔴 EMIT LIVE ALERT TO ALL CLIENTS
  io.emit('newAlert', alert);
  
  // Keep only latest 10 alerts in database
  const alertCount = await Alert.countDocuments();
  if (alertCount > 10) {
    const alertsToDelete = alertCount - 10;
    const oldestAlerts = await Alert.find().sort({ createdAt: 1 }).limit(alertsToDelete);
    const idsToDelete = oldestAlerts.map(alert => alert._id);
    await Alert.deleteMany({ _id: { $in: idsToDelete } });
    console.log(`🗑️ Deleted ${alertsToDelete} old alerts, keeping latest 50`);
  }
}

// --- MQTT API Routes ---

// Get all tasks (for task page)
app.get("/tasks", async (req, res) => {
  try {
    const tasks = await Task.find({}, 'taskId taskName status createdAt').sort({ createdAt: -1 });
    res.json({ tasks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get task details with maps (when user clicks view button)
app.get("/tasks/:taskId/details", async (req, res) => {
  try {
    const task = await Task.findOne({ taskId: req.params.taskId });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    console.log(`🔍 Task ${req.params.taskId} details:`, {
      taskId: task.taskId,
      taskName: task.taskName,
      mapsCount: task.maps.length,
      maps: task.maps
    });
    res.json({ task });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check all tasks
app.get("/debug/tasks", async (req, res) => {
  try {
    const tasks = await Task.find();
    res.json({ 
      count: tasks.length,
      tasks: tasks.map(t => ({
        taskId: t.taskId,
        taskName: t.taskName,
        mapsCount: t.maps.length,
        maps: t.maps
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// Send action command to robot (keep for MQTT compatibility)
app.post("/robot/action", (req, res) => {
  const { action, value } = req.body;
  
  const actionMessage = {
    action,
    value,
    timestamp: new Date().toISOString()
  };

  mqttClient.publish(TOPICS.ACTION.name, JSON.stringify(actionMessage), { qos: TOPICS.ACTION.qos }, (err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to send action" });
    }
    console.log(`📤 Action sent: ${action}`);
    res.json({ success: true, action, message: "Action sent to robot" });
  });
});



// Get robot status from database
app.get("/robot/status", async (req, res) => {
  try {
    const status = await RobotStatus.findOne().sort({ lastUpdated: -1 });
    res.json({ status: status || "No status received" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get live map data for mobile app
app.get("/robot/map", async (req, res) => {
  try {
    const status = await RobotStatus.findOne().sort({ lastUpdated: -1 });
    const mapData = {
      robotPosition: status?.position || { x: 0, y: 0 },
      batteryLevel: status?.batteryPercent || "0%",
      isActive: status?.isActive || false,
      stations: [
        { id: "A1", name: "Station A1", x: 2.0, y: 1.0, status: "available" },
        { id: "A2", name: "Station A2", x: 3.0, y: 2.0, status: "available" },
        { id: "B1", name: "Station B1", x: 5.0, y: 3.0, status: "available" },
        { id: "B2", name: "Station B2", x: 6.0, y: 4.0, status: "available" },
        { id: "dock", name: "Dock", x: 0.0, y: 0.0, status: "dock" }
      ],
      mapBounds: { minX: -1, maxX: 7, minY: -1, maxY: 5 },
      lastUpdated: status?.lastUpdated || new Date()
    };
    res.json(mapData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// Get all alerts
app.get("/alerts", async (req, res) => {
  try {
    const alerts = await Alert.find().sort({ createdAt: -1 }).limit(50);
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark alert as resolved
app.patch("/alerts/:id/resolve", async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(
      req.params.id,
      { resolved: true },
      { new: true }
    );
    res.json({ alert });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check if mission is completed (for clearing map)
app.get("/mission/status", async (req, res) => {
  try {
    // Check for mission_complete alerts in last 10 minutes
    const completedAlert = await Alert.findOne({ 
      type: 'mission_complete',
      createdAt: { $gte: new Date(Date.now() - 600000) } // Within last 10 minutes
    }).sort({ createdAt: -1 });
    
    // Also check all recent alerts for debugging
    const recentAlerts = await Alert.find({}).sort({ createdAt: -1 }).limit(5);
    
    console.log(`🔍 Checking mission status - Found alert:`, !!completedAlert);
    console.log(`🔍 Recent alerts:`, recentAlerts.map(a => ({ type: a.type, message: a.message, time: a.createdAt })));
    
    if (completedAlert) {
      console.log(`🔍 Alert details:`, completedAlert.message, completedAlert.createdAt);
    }
    
    res.json({ 
      missionCompleted: !!completedAlert,
      lastCompletedAt: completedAlert?.createdAt,
      recentAlerts: recentAlerts.map(a => ({ type: a.type, message: a.message, time: a.createdAt }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test MQTT connection
app.get("/mqtt/test", (req, res) => {
  res.json({
    mqttConnected: mqttClient.connected,
    topics: Object.values(TOPICS).map(t => t.name)
  });
});

// Generic send route (for testing)
app.post("/send", (req, res) => {
  const { topic, message } = req.body;

  if (!topic || !message) {
    return res.status(400).json({ error: "Topic and message are required" });
  }

  // Determine QoS based on topic
  const topicConfig = Object.values(TOPICS).find(t => t.name === topic);
  const qos = topicConfig ? topicConfig.qos : 0;

  // Convert message to string if it's an object
  const messageString = typeof message === 'object' ? JSON.stringify(message) : message;
  
  mqttClient.publish(topic, messageString, { qos }, (err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to publish message" });
    }
    console.log(`📤 Sent: ${topic} - ${messageString}`);
    res.json({ success: true, topic, message: messageString, qos });
  });
});

// --- Pi Communication Endpoints ---

// Pi checks for commands
app.get("/robot/pending_commands", (req, res) => {
  if (pendingCommand) {
    res.json({ has_command: true, command: pendingCommand, command_id: commandId });
  } else {
    res.json({ has_command: false });
  }
});

// Pi confirms command processed
app.post("/robot/command_processed", (req, res) => {
  pendingCommand = null;
  console.log(`✅ Command processed by Pi`);
  res.json({ success: true });
});

// Pi sends robot status
app.post("/robot/status_update", (req, res) => {
  console.log(`📡 Status from Pi:`, req.body);
  io.emit('robotStatusFromPi', req.body);
  res.json({ success: true });
});

// Start mission with selected map (send action to robot)
app.post("/robot/mission/start/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    const { selectedMapIndex } = req.body;
    
    const task = await Task.findOne({ taskId });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    if (selectedMapIndex === undefined || !task.maps[selectedMapIndex]) {
      return res.status(400).json({ error: "Invalid map selection" });
    }
    
    const selectedMap = task.maps[selectedMapIndex];
    
    const actionMessage = {
      action: "start_mission",
      taskId,
      taskName: task.taskName,
      selectedMap: {
        mapId: selectedMap.mapId,
        mapName: selectedMap.mapName,
        pick: selectedMap.pick,
        drop: selectedMap.drop
      },
      timestamp: new Date().toISOString()
    };

    mqttClient.publish(TOPICS.ACTION.name, JSON.stringify(actionMessage), { qos: TOPICS.ACTION.qos }, (err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to start mission" });
      }
      console.log(`📤 Mission started: ${taskId} with map: ${selectedMap.mapName}`);
    });
    
    res.json({ success: true, message: "Mission start command sent with selected map" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Docking station command
app.post("/robot/dock", (req, res) => {
  const actionMessage = {
    action: "return_to_dock",
    command: "dock_station",
    timestamp: new Date().toISOString()
  };

  mqttClient.publish(TOPICS.ACTION.name, JSON.stringify(actionMessage), { qos: TOPICS.ACTION.qos }, (err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to send dock command" });
    }
    console.log(`🏠 Dock command sent to MCU`);
    res.json({ success: true, message: "Robot returning to dock station" });
  });
});

// Create WebSocket server for ROS2 bridge
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('🔗 ROS2 bridge connected');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      if (message.type === 'robot_position') {
        // Update robot position in database
        updateRobotPosition(message.x, message.y);
        
        // Broadcast to mobile clients
        io.emit('livePosition', {
          x: message.x,
          y: message.y,
          timestamp: message.timestamp
        });
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 ROS2 bridge disconnected');
  });
});

async function updateRobotPosition(x, y) {
  try {
    await RobotStatus.findOneAndUpdate(
      {},
      { 
        position: { x, y },
        lastUpdated: new Date()
      },
      { upsert: true }
    );
    console.log(`📍 Position updated: x=${x}, y=${y}`);
  } catch (error) {
    console.error('Error updating position:', error);
  }
}

// --- Start server ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 WebSocket server running on port 8080`);
});