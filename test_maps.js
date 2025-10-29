// Test script to create tasks with map images
require("dotenv").config();
const mongoose = require("mongoose");
const Task = require('./models/Task');

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log("✅ MongoDB connected");
  createTestTasks();
}).catch((err) => {
  console.error("❌ MongoDB error:", err);
});

async function createTestTasks() {
  try {
    // Delete existing test tasks
    await Task.deleteMany({ taskId: { $in: ["T001", "T002", "T003"] } });
    
    // Create tasks with map images
    const tasks = [
      {
        taskId: "T001",
        taskName: "Warehouse Cleaning",
        maps: [
          {
            mapId: "M001",
            mapName: "Ground Floor",
            pick: "Station A",
            drop: "Station B",
            imageUrl: "https://backendapp-zduc.onrender.com/maps/my_map.png"
          },
          {
            mapId: "M002", 
            mapName: "Storage Area",
            pick: "Warehouse Entry",
            drop: "Storage Rack 5",
            imageUrl: "https://backendapp-zduc.onrender.com/maps/my_map1.png"
          }
        ]
      },
      {
        taskId: "T002",
        taskName: "Office Patrol", 
        maps: [
          {
            mapId: "M003",
            mapName: "Office Floor",
            pick: "Reception",
            drop: "Security Room",
            imageUrl: "https://backendapp-zduc.onrender.com/maps/my_map4.png"
          }
        ]
      }
    ];

    for (const taskData of tasks) {
      const task = new Task(taskData);
      await task.save();
      console.log(`✅ Created task: ${taskData.taskId} with ${taskData.maps.length} maps`);
    }

    console.log("🎉 Test tasks created successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating tasks:", error);
    process.exit(1);
  }
}