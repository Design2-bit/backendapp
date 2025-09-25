const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user");
const auth = require("../middleware/auth");

const router = express.Router();

// --- Sign Up ---
router.post("/signup", async (req, res) => {
  try {
    const { userId, username, password, confirmPassword } = req.body;

    if (!userId || !username || !password || !confirmPassword) {
      return res.status(400).json({ msg: "All fields are required" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ msg: "Passwords do not match" });
    }

    const existingUser = await User.findOne({ userId });
    if (existingUser) {
      return res.status(400).json({ msg: "User ID already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ userId, username, password: hashedPassword });

    await newUser.save();
    res.status(201).json({ msg: "✅ User registered successfully" });
  } catch (err) {
    res.status(500).json({ msg: "❌ Server error", error: err.message });
  }
});

// --- Sign In ---
router.post("/signin", async (req, res) => {
  try {
    const { userId, password } = req.body;

    if (!userId || !password) {
      return res.status(400).json({ msg: "User ID and password are required" });
    }

    const user = await User.findOne({ userId });
    if (!user) return res.status(400).json({ msg: "Invalid User ID or Password" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid User ID or Password" });

    const token = jwt.sign(
      { userId: user.userId },   // save userId inside token
        process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );


    // ✅ Send userId & username for frontend
    res.json({ msg: "✅ Login successful", token, userId: user.userId, username: user.username });
  } catch (err) {
    res.status(500).json({ msg: "❌ Server error", error: err.message });
  }
});

// --- Change Password ---
router.post("/change-password", auth, async (req, res) => {
  try {
    console.log('Change password request received');
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;
    console.log('User ID from token:', userId);

    if (!currentPassword || !newPassword) {
      console.log('Missing password fields');
      return res.status(400).json({ msg: "Current password and new password are required" });
    }

    if (newPassword.length < 6) {
      console.log('New password too short');
      return res.status(400).json({ msg: "New password must be at least 6 characters long" });
    }

    const user = await User.findOne({ userId });
    console.log('User found:', user ? 'Yes' : 'No');
    
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    console.log('Current password match:', isMatch);
    
    if (!isMatch) {
      return res.status(400).json({ msg: "Current password is incorrect" });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await User.findOneAndUpdate({ userId }, { password: hashedNewPassword });
    console.log('Password updated successfully');

    res.json({ msg: "✅ Password changed successfully" });
  } catch (err) {
    console.log('Change password error:', err);
    res.status(500).json({ msg: "❌ Server error", error: err.message });
  }
});

// --- Update Language ---
router.post("/update-language", auth, async (req, res) => {
  try {
    console.log('Update language request received');
    const { language } = req.body;
    const userId = req.user.userId;
    console.log('User ID from token:', userId);
    console.log('New language:', language);

    if (!language) {
      console.log('Missing language field');
      return res.status(400).json({ msg: "Language is required" });
    }

    const validLanguages = ['English', 'Tamil', 'Hindi', 'Telugu', 'Spanish', 'Chinese'];
    if (!validLanguages.includes(language)) {
      console.log('Invalid language:', language);
      return res.status(400).json({ msg: "Invalid language selected" });
    }

    const user = await User.findOne({ userId });
    console.log('User found:', user ? 'Yes' : 'No');
    
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    await User.findOneAndUpdate({ userId }, { language });
    console.log('Language updated successfully to:', language);

    res.json({ msg: "✅ Language updated successfully" });
  } catch (err) {
    console.log('Update language error:', err);
    res.status(500).json({ msg: "❌ Server error", error: err.message });
  }
});

module.exports = router;
