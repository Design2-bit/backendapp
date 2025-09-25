const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, unique: true, required: true }, // unique ID
    username: { type: String, required: true },
    password: { type: String, required: true },
    language: { type: String, default: "English" },
  },
  { timestamps: true }
);

// ✅ Fix OverwriteModelError by reusing existing model if it exists
module.exports = mongoose.models.User || mongoose.model("User", userSchema);
