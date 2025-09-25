const express = require("express");
const router = express.Router();
const User = require("../models/user");
const auth = require("../middleware/auth");

// --- Get Profile ---
router.get("/", auth, async (req, res) => {
  try {
    console.log('Profile request - user from token:', req.user);
    const user = await User.findOne({ userId: req.user.userId });
    console.log('Found user:', user);
    
    if (!user) return res.status(404).json({ msg: "User not found" });

    res.json({
      userId: user.userId,
      username: user.username,
    });
  } catch (err) {
    console.log('Profile error:', err);
    res.status(500).json({ msg: "Server error", error: err.message });
  }
});

// --- Update Profile ---
router.put("/", auth, async (req, res) => {
  try {
    const { username } = req.body;

    let user = await User.findOne({ userId: req.user.userId });
    if (!user) return res.status(404).json({ msg: "User not found" });

    if (username) user.username = username;

    await user.save();
    res.json({ msg: "Profile updated successfully" });
  } catch (err) {
    res.status(500).json({ msg: "Server error", error: err.message });
  }
});

module.exports = router;
