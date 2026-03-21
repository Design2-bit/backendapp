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
mongoose.set('bufferTimeoutMS', 60000);

const connectWithRetry = () => {
  mongoose
    .connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 60000,
      socketTimeoutMS: 60000,
    })
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => {
      console.error("❌ MongoDB error:", err);
      console.log("🔄 Retrying MongoDB connection in 5 seconds...");
      setTimeout(connectWithRetry, 5000);
    });
};
connectWithRetry();

// --- Test routes ---
app.get("/test", (req, res) => {
  res.json({ msg: "✅ Server is running!" });
});

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

const TOPICS = {
  TASKS:  { name: 'robot/tasks',  qos: 1 },
  STATUS: { name: 'robot/status', qos: 0 },
  ACTION: { name: 'robot/action', qos: 1 },
  ALERT:  { name: 'robot/alert',  qos: 1 }
};

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected");
  Object.values(TOPICS).forEach(topic => {
    mqttClient.subscribe(topic.name, { qos: topic.qos }, (err) => {
      if (!err) console.log(`📡 Subscribed to ${topic.name} (QoS: ${topic.qos})`);
      else      console.error(`❌ Subscription error for ${topic.name}:`, err);
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
    handleMqttMessage(topic, data);
  } catch (err) {
    console.log(`❌ JSON Parse Error:`, err);
    console.log(`📩 MQTT [${topic}] (text): ${msg}`);
  }
});

async function handleMqttMessage(topic, data) {
  try {
    switch (topic) {
      case TOPICS.STATUS.name: await handleStatusFromMCU(data);  break;
      case TOPICS.TASKS.name:  await handleTaskUpdateFromMCU(data); break;
      case TOPICS.ACTION.name: await handleActionResponseFromMCU(data); break;
      case TOPICS.ALERT.name:  await handleAlertFromMCU(data);   break;
    }
  } catch (error) {
    console.error('MQTT message handling error:', error);
  }
}

async function handleStatusFromMCU(data) {
  console.log(`🤖 Status from MCU:`, data);
  try {
    let batteryNumeric = data.batteryPercent;
    if (typeof data.batteryPercent === 'string') {
      batteryNumeric = parseInt(data.batteryPercent.replace('%', ''));
    }
    const status = new RobotStatus({
      batteryPercent: data.batteryPercent,
      runtime:        data.runtime,
      loadWeight:     data.loadWeight,
      temperature:    data.temperature,
      position:       data.position,
      isActive:       data.isActive,
      lastUpdated:    new Date()
    });
    await status.save();
    console.log(`✅ Robot status saved:`, status);
    io.emit('robotStatus', status);
    io.emit('mapUpdate', {
      robotPosition: data.position,
      batteryLevel:  data.batteryPercent,
      isActive:      data.isActive,
      timestamp:     new Date()
    });
    const statusCount = await RobotStatus.countDocuments();
    if (statusCount > 10) {
      const statusToDelete = statusCount - 10;
      const oldestStatus   = await RobotStatus.find().sort({ lastUpdated: 1 }).limit(statusToDelete);
      await RobotStatus.deleteMany({ _id: { $in: oldestStatus.map(s => s._id) } });
    }
    if (batteryNumeric < 20) {
      await createAlert('low_battery', `Battery low: ${data.batteryPercent}`, 'warning', data);
    }
  } catch (error) {
    console.error(`❌ Error saving robot status:`, error);
  }
}

async function handleTaskUpdateFromMCU(data) {
  console.log(`📋 Task data from MCU:`, data);
  if (data.taskId && data.taskName && data.maps) {
    data.maps.forEach(map => {
      map.imageUrl = MAP_IMAGES[map.mapId] || null;
    });
    const existingTask = await Task.findOne({ taskId: data.taskId });
    if (!existingTask) {
      const task = new Task({ taskId: data.taskId, taskName: data.taskName, maps: data.maps });
      await task.save();
      console.log(`🆕 New task created: ${data.taskId} with ${data.maps.length} maps`);
      io.emit('taskUpdate', task);
    } else {
      existingTask.maps     = data.maps;
      existingTask.taskName = data.taskName;
      await existingTask.save();
      console.log(`🔄 Task updated: ${data.taskId} with ${data.maps.length} maps`);
      io.emit('taskUpdate', existingTask);
    }
  }
  if (data.taskId && data.status) {
    const updateData = { status: data.status };
    if (data.status === 'in_progress')                              updateData.startedAt   = new Date();
    else if (data.status === 'completed' || data.status === 'failed') updateData.completedAt = new Date();
    await Task.findOneAndUpdate({ taskId: data.taskId }, updateData);
  }
}

async function handleActionResponseFromMCU(data) {
  console.log(`⚡ Action response from MCU:`, data);
}

async function handleAlertFromMCU(data) {
  console.log(`🚨 Alert from MCU:`, data);
  if (data.message === 'Navigation goal reached successfully') {
    console.log('🔇 Filtered out navigation success message');
    return;
  }
  if (data.type === 'mission_complete') {
    console.log(`✅ Mission completed - clearing map selection`);
  }
}

async function createAlert(type, message, severity = 'info', data = null) {
  const alert = new Alert({ type, message, severity, data });
  await alert.save();
  console.log(`🚨 Alert created: ${type} - ${message}`);
  const alertCount = await Alert.countDocuments();
  if (alertCount > 10) {
    const alertsToDelete = alertCount - 10;
    const oldestAlerts   = await Alert.find().sort({ createdAt: 1 }).limit(alertsToDelete);
    await Alert.deleteMany({ _id: { $in: oldestAlerts.map(a => a._id) } });
  }
}

// ============================================================
// TASK ROUTES
// ============================================================

app.get("/tasks", async (req, res) => {
  try {
    const tasks = await Task.find({}, 'taskId taskName status createdAt').sort({ createdAt: -1 });
    res.json({ tasks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/tasks/:taskId/details", async (req, res) => {
  try {
    const task = await Task.findOne({ taskId: req.params.taskId });
    if (!task) return res.status(404).json({ error: "Task not found" });
    console.log(`🔍 Task ${req.params.taskId} details:`, {
      taskId: task.taskId, taskName: task.taskName,
      mapsCount: task.maps.length, maps: task.maps
    });
    res.json({ task });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/debug/tasks", async (req, res) => {
  try {
    const tasks = await Task.find();
    res.json({
      count: tasks.length,
      tasks: tasks.map(t => ({ taskId: t.taskId, taskName: t.taskName, mapsCount: t.maps.length, maps: t.maps }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ROBOT ACTION ROUTES
// ============================================================

app.post("/robot/action", (req, res) => {
  const { action, value } = req.body;
  const actionMessage = { action, value, timestamp: new Date().toISOString() };
  mqttClient.publish(TOPICS.ACTION.name, JSON.stringify(actionMessage), { qos: TOPICS.ACTION.qos }, (err) => {
    if (err) return res.status(500).json({ error: "Failed to send action" });
    console.log(`📤 Action sent: ${action}`);
    res.json({ success: true, action, message: "Action sent to robot" });
  });
});

// ============================================================
// START MISSION — FIXED: pickCoords and dropCoords now included
// ============================================================
app.post("/robot/mission/start/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;

    // Destructure all three fields from request body
    const { selectedMapIndex, pickCoords, dropCoords } = req.body;

    console.log(`📥 Mission start request for task: ${taskId}`);
    console.log(`📥 selectedMapIndex: ${selectedMapIndex}`);
    console.log(`📥 pickCoords received:`, pickCoords);
    console.log(`📥 dropCoords received:`, dropCoords);

    const task = await Task.findOne({ taskId });
    if (!task) return res.status(404).json({ error: "Task not found" });

    if (selectedMapIndex === undefined || !task.maps[selectedMapIndex]) {
      return res.status(400).json({ error: "Invalid map selection" });
    }

    const selectedMap = task.maps[selectedMapIndex];

    // ---- FIXED: pickCoords and dropCoords included in MQTT payload ----
    const actionMessage = {
      action:   "start_mission",
      taskId,
      taskName: task.taskName,
      selectedMap: {
        mapId:   selectedMap.mapId,
        mapName: selectedMap.mapName,
        pick:    selectedMap.pick,
        drop:    selectedMap.drop
      },
      pickCoords: {
        x: Number(pickCoords?.x) || 0,
        y: Number(pickCoords?.y) || 0,
        z: Number(pickCoords?.z) || 0
      },
      dropCoords: {
        x: Number(dropCoords?.x) || 0,
        y: Number(dropCoords?.y) || 0,
        z: Number(dropCoords?.z) || 0
      },
      timestamp: new Date().toISOString()
    };

    console.log(`📤 Publishing to MQTT:`, JSON.stringify(actionMessage));

    mqttClient.publish(
      TOPICS.ACTION.name,
      JSON.stringify(actionMessage),
      { qos: TOPICS.ACTION.qos },
      (err) => {
        if (err) return res.status(500).json({ error: "Failed to start mission" });
        console.log(`✅ Mission started: ${taskId} | Pick(${actionMessage.pickCoords.x},${actionMessage.pickCoords.y},${actionMessage.pickCoords.z}) Drop(${actionMessage.dropCoords.x},${actionMessage.dropCoords.y},${actionMessage.dropCoords.z})`);
      }
    );

    res.json({ success: true, message: "Mission start command sent with coordinates" });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// DOCK COMMAND
// ============================================================
app.post("/robot/dock", (req, res) => {
  const actionMessage = {
    action:    "return_to_dock",
    command:   "dock_station",
    timestamp: new Date().toISOString()
  };
  mqttClient.publish(TOPICS.ACTION.name, JSON.stringify(actionMessage), { qos: TOPICS.ACTION.qos }, (err) => {
    if (err) return res.status(500).json({ error: "Failed to send dock command" });
    console.log(`🏠 Dock command sent to MCU`);
    res.json({ success: true, message: "Robot returning to dock station" });
  });
});

// ============================================================
// STATUS & ALERTS
// ============================================================
app.get("/robot/status", async (req, res) => {
  try {
    const status = await RobotStatus.findOne().sort({ lastUpdated: -1 });
    res.json({ status: status || "No status received" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/robot/map", async (req, res) => {
  try {
    const status = await RobotStatus.findOne().sort({ lastUpdated: -1 });
    const mapData = {
      robotPosition: status?.position || { x: 120, y: 65 },
      batteryLevel:  status?.batteryPercent || "0%",
      isActive:      status?.isActive || false,
      stations: [
        { id: "A1",         name: "Station A1",      x: 30, y: 10, status: "available" },
        { id: "A2",         name: "Station A2",      x: 30, y: 10, status: "available" },
        { id: "B1",         name: "Station B1",      x: 35, y: 25, status: "available" },
        { id: "B2",         name: "Station B2",      x: 35, y: 25, status: "available" },
        { id: "loading",    name: "Loading Bay",     x: 30, y: 10, status: "available" },
        { id: "storage",    name: "Storage Area",    x: 35, y: 25, status: "available" },
        { id: "reception",  name: "Reception",       x: 30, y: 10, status: "available" },
        { id: "conference", name: "Conference Room", x: 35, y: 25, status: "available" },
        { id: "dock",       name: "Dock",            x: 0,  y: 0,  status: "dock"      }
      ],
      mapBounds:   { minX: 0, maxX: 150, minY: 0, maxY: 100 },
      lastUpdated: status?.lastUpdated || new Date()
    };
    res.json(mapData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const alerts = await Alert.find().sort({ createdAt: -1 }).limit(50);
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/alerts/:id/resolve", async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(req.params.id, { resolved: true }, { new: true });
    res.json({ alert });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/mission/status", async (req, res) => {
  try {
    const completedAlert = await Alert.findOne({
      type:      'mission_complete',
      createdAt: { $gte: new Date(Date.now() - 600000) }
    }).sort({ createdAt: -1 });
    const recentAlerts = await Alert.find({}).sort({ createdAt: -1 }).limit(5);
    res.json({
      missionCompleted: !!completedAlert,
      lastCompletedAt:  completedAlert?.createdAt,
      recentAlerts:     recentAlerts.map(a => ({ type: a.type, message: a.message, time: a.createdAt }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/mqtt/test", (req, res) => {
  res.json({ mqttConnected: mqttClient.connected, topics: Object.values(TOPICS).map(t => t.name) });
});

app.post("/send", (req, res) => {
  const { topic, message } = req.body;
  if (!topic || !message) return res.status(400).json({ error: "Topic and message are required" });
  const topicConfig   = Object.values(TOPICS).find(t => t.name === topic);
  const qos           = topicConfig ? topicConfig.qos : 0;
  const messageString = typeof message === 'object' ? JSON.stringify(message) : message;
  mqttClient.publish(topic, messageString, { qos }, (err) => {
    if (err) return res.status(500).json({ error: "Failed to publish message" });
    console.log(`📤 Sent: ${topic} - ${messageString}`);
    res.json({ success: true, topic, message: messageString, qos });
  });
});

// ============================================================
// PI COMMUNICATION
// ============================================================
app.get("/robot/pending_commands", (req, res) => {
  if (pendingCommand) res.json({ has_command: true, command: pendingCommand, command_id: commandId });
  else                res.json({ has_command: false });
});

app.post("/robot/command_processed", (req, res) => {
  pendingCommand = null;
  console.log(`✅ Command processed by Pi`);
  res.json({ success: true });
});

app.post("/robot/status_update", (req, res) => {
  console.log(`📡 Status from Pi:`, req.body);
  io.emit('robotStatusFromPi', req.body);
  res.json({ success: true });
});

// ============================================================
// LIVE MAP (ROS2)
// ============================================================
let latestLiveMapData = null;

app.post("/robot/live_map", (req, res) => {
  try {
    const { mapImage, taskId, mapId, robotPosition, robotPixelPosition, mapMetadata } = req.body;
    latestLiveMapData = {
      mapImage, robotPosition: robotPosition || { x: 0, y: 0, z: 0 },
      robotPixelPosition: robotPixelPosition || { x: 200, y: 200 },
      mapMetadata: mapMetadata || null, taskId, mapId,
      timestamp: new Date(), receivedAt: new Date().toISOString()
    };
    io.emit('liveMapUpdate', {
      mapImage:           `data:image/png;base64,${mapImage}`,
      robotPosition, robotPixelPosition, mapMetadata, taskId, mapId,
      timestamp: new Date()
    });
    console.log(`📸 Live map received for task ${taskId} - Robot at (${robotPosition?.x}, ${robotPosition?.y})`);
    res.json({ success: true });
  } catch (error) {
    console.error('Live map processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/robot/live_map_data", (req, res) => {
  try {
    if (!latestLiveMapData) return res.status(404).json({ success: false, message: 'No live map data available' });
    const dataAge    = Date.now() - new Date(latestLiveMapData.receivedAt).getTime();
    const isDataFresh = dataAge < 10000;
    res.json({
      success: true,
      mapImage:           latestLiveMapData.mapImage,
      robotPosition:      latestLiveMapData.robotPosition,
      robotPixelPosition: latestLiveMapData.robotPixelPosition,
      mapMetadata:        latestLiveMapData.mapMetadata,
      taskId:             latestLiveMapData.taskId,
      mapId:              latestLiveMapData.mapId,
      timestamp:          latestLiveMapData.timestamp,
      dataAge, isDataFresh
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/robot/navigation_complete", (req, res) => {
  res.json({ success: true });
});

app.post("/robot/position", (req, res) => {
  try {
    const { robotPosition, robotPixelPosition } = req.body;
    if (robotPosition && robotPixelPosition) {
      io.emit('livePosition', { ...robotPosition, pixelX: robotPixelPosition.x, pixelY: robotPixelPosition.y });
      console.log(`🤖 Position forwarded: World(${robotPosition.x?.toFixed(3)}, ${robotPosition.y?.toFixed(3)}) → Pixel(${robotPixelPosition.x?.toFixed(1)}, ${robotPixelPosition.y?.toFixed(1)})`);
    } else if (robotPosition) {
      io.emit('livePosition', robotPosition);
      console.log(`🤖 Position forwarded: (${robotPosition.x?.toFixed(3)}, ${robotPosition.y?.toFixed(3)})`);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Position update error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/robot/ros_status", (req, res) => {
  try {
    const { slam_running, amcl_running, map_publisher_running } = req.body;
    io.emit('rosStatus', { slam_running, amcl_running, map_publisher_running });
    console.log(`🔧 ROS2 Status: SLAM=${slam_running}, AMCL=${amcl_running}, MapPub=${map_publisher_running}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// WebSocket for ROS2 bridge
// ============================================================
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', (ws) => {
  console.log('🔗 ROS2 bridge connected');
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      if (message.type === 'robot_position') {
        updateRobotPosition(message.x, message.y);
        io.emit('livePosition', { x: message.x, y: message.y, timestamp: message.timestamp });
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
  ws.on('close', () => console.log('🔌 ROS2 bridge disconnected'));
});

async function updateRobotPosition(x, y) {
  try {
    await RobotStatus.findOneAndUpdate(
      {},
      { position: { x, y }, lastUpdated: new Date() },
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