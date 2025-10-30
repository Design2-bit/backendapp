const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  type: { 
    type: String, 
    enum: ['low_battery', 'path_obstacle', 'mission_complete', 'system_error', 'heartbeat', 'mission_started', 'dock_command', 'dock_complete', 'task_created', 'task_updated', 'connection_status'], 
    required: true 
  },
  message: { type: String, required: true },
  severity: { 
    type: String, 
    enum: ['info', 'warning', 'critical'], 
    default: 'info' 
  },
  data: mongoose.Schema.Types.Mixed,
  resolved: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Alert', alertSchema);