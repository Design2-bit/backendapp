const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
  const token = req.header("Authorization")?.replace("Bearer ", ""); // get token from header
  console.log('Auth middleware - token received:', token);

  if (!token) {
    console.log('No token provided');
    return res.status(401).json({ msg: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET); // check token
    console.log('Token decoded:', decoded);
    req.user = decoded; // save decoded info (userId) in request
    next(); // move to next step
  } catch (err) {
    console.log('Token verification failed:', err.message);
    res.status(401).json({ msg: "Token is not valid" });
  }
};
