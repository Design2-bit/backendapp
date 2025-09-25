const mongoose = require('mongoose');

const robotStatusSchema = new mongoose.Schema({
  batteryPercent: String, // "85%"
  runtime: String, // "4hrs 03min"
  loadWeight: String, // "15 kg"
  temperature: String, // "28°C"
  position: {
    x: Number,
    y: Number
  },
  isActive: { type: Boolean, default: false },
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('RobotStatus', robotStatusSchema);