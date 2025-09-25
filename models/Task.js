const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  taskId: { type: String, required: true, unique: true },
  taskName: { type: String, required: true },
  maps: {
    type: [{
      mapId: { type: String, required: true },
      mapName: { type: String, required: true },
      pick: { type: String, required: true },
      drop: { type: String, required: true }
    }],
    validate: {
      validator: function(maps) {
        return maps.length >= 1 && maps.length <= 3;
      },
      message: 'Each task must have between 1 and 3 maps'
    }
  },
  status: { 
    type: String, 
    enum: ['pending', 'in_progress', 'completed', 'failed'], 
    default: 'pending' 
  },
  createdAt: { type: Date, default: Date.now },
  startedAt: Date,
  completedAt: Date
});

module.exports = mongoose.model('Task', taskSchema);