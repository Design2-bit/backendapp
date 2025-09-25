const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  type: { 
    type: String, 
    enum: ['low_battery', 'path_obstacle', 'mission_complete', 'system_error'], 
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